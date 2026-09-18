import { createThinkingMapStore } from '../../../src/store/thinkingMap/createStore';
import type { MapComputeContext, MapHostSnapshot, ThinkingMapHost, ThinkingMapRuntime } from '../../../src/store/thinkingMap/runtime';
import type { PersistedThinkingMap } from '../../../src/type/thinkingMap';
import type { CondensationEvent, SourceBatch } from '../../../src/type/sourceSnapshot';
import { deriveCaches } from '../../../src/service/ledger/bridge';
import { parseLedger } from '../../../src/service/ledger';
import { buildGenerateRequest, parseGenerateResponse, buildRefinePrompt, parseRefineTags } from '../../../src/service/thinkingMapCore';
import { buildTidyRequest, parseTidyOps } from '../../../src/service/tidyCore';

interface LocalTopic { id: string; name: string; scope: string; revision: number; ledger: string; raw: string; panel?: PersistedThinkingMap }
interface TopicSnapshot { topic: LocalTopic }
interface CachedMap { revision: number; serial: number; pending: boolean; map: PersistedThinkingMap }
export type ChatProvider = 'codex' | 'claude';
export interface ChatSession { provider: ChatProvider; id: string; title: string; cwd: string; updatedAt: string }
export interface ChatConnection { id: string; topicId: string; source: ChatSession; history: 'now' | 'all'; loadedRevision: number | null }
export type UpdateSource = { connectionId: string } | { manual: true } | null;
export interface ConnectionSnapshot {
  topicId: string | null;
  revision: number | null;
  connections: ChatConnection[];
  status: 'loading' | 'ready' | 'error';
  error: string;
  operation: { phase: 'choosing' | 'reading' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'; message: string; taskId?: string; hasMore?: boolean } | null;
}
interface LocalRuntimeOptions {
  onRequestUpdate(): Promise<string | null>;
  onRequestSource?(topicId: string, connections: ChatConnection[]): Promise<UpdateSource>;
  onError(message: string): void;
}
export class LocalApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function localRequest<T>(url: string, body?: unknown, signal?: AbortSignal, keepalive = false): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal, keepalive });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new LocalApiError(data.error || `请求失败（${response.status}）`, response.status);
  return data as T;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const abortError = () => new DOMException('任务已取消，当前内容保留。', 'AbortError');
const keyOf = (id: string) => `gft-local:panel:${id}`;
const storage = {
  get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* The in-memory pending copy remains available. */ } },
  remove(key: string) { try { localStorage.removeItem(key); } catch { /* Optional browser mirror. */ } },
};
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, 500);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Host adapter only: all document/graph mutations are the platform's shared store. */
export function createLocalRuntime(options: LocalRuntimeOptions) {
  const listeners = new Set<() => void>(), cache = new Map<string, CachedMap>();
  const remoteVersions = new WeakMap<PersistedThinkingMap, number>();
  const saveQueues = new Map<string, Promise<PersistedThinkingMap | null>>();
  const sourceQueues = new Map<string, Promise<void>>();
  const activeTasks = new Map<string, () => Promise<void>>();
  const pendingCreates = new Map<string, { name: string; promise: Promise<LocalTopic> }>();
  const pendingNames = new Map<string, string>();
  const renameQueues = new Map<string, Promise<void>>();
  let creating: Promise<string | null> | undefined;
  const connectionListeners = new Set<() => void>();
  const disconnecting = new Set<string>();
  let connectionSnapshot: ConnectionSnapshot = { topicId: null, revision: null, connections: [], status: 'ready', error: '', operation: null };
  let connectionEpoch = 0;
  let chatUpdate: { topicId: string; controller: AbortController; cancel?: () => Promise<void> } | null = null;
  let serial = 0, disposed = false, poll: ReturnType<typeof setInterval> | undefined;
  let snapshot: MapHostSnapshot = { projects: [], currentProjectId: null, currentSession: null, chatHistory: [], sourceLabel: '所选会话', showMemoryToggle: false,
    redrawDescription: '保留当前主题，基于 Log 已接收的来源重新生成图文。不读取原聊天，更新进度不变；旧记录只使用实际保存的材料。完成后可 Ctrl+Z 撤销。' };
  const publish = (change: Partial<MapHostSnapshot>) => { snapshot = { ...snapshot, ...change }; listeners.forEach(listener => listener()); };
  const publishConnections = (change: Partial<ConnectionSnapshot>) => { connectionSnapshot = { ...connectionSnapshot, ...change }; connectionListeners.forEach(listener => listener()); };
  const readCache = (id: string) => {
    if (cache.has(id)) return cache.get(id)!;
    try { const saved = JSON.parse(storage.get(keyOf(id)) || 'null') as CachedMap | null;
      if (saved?.map && Number.isInteger(saved.revision)) { cache.set(id, saved); serial = Math.max(serial, saved.serial || 0); return saved; }
    } catch { /* A damaged browser mirror never replaces the file-backed record. */ }
    return null;
  };
  const writeCache = (id: string, entry: CachedMap) => {
    cache.set(id, entry); storage.set(keyOf(id), JSON.stringify(entry));
    if (connectionSnapshot.topicId === id && connectionSnapshot.revision !== entry.revision) publishConnections({ revision: entry.revision });
  };
  const mapOf = (topic: LocalTopic): PersistedThinkingMap => {
    const unread = new Set((topic.panel?.nodes || []).filter(node => node.unread).map(node => node.id));
    const derived = deriveCaches(parseLedger(topic.ledger), topic.id, unread);
    const map: PersistedThinkingMap = { nodes: derived.nodes, edges: derived.edges, doc: derived.doc,
      ledger: topic.ledger, raw: topic.raw, watermarks: topic.panel?.watermarks || {} };
    remoteVersions.set(map, topic.revision); return map;
  };
  const load = async (id: string) => {
    await pendingCreates.get(id)?.promise;
    const bundle = await localRequest<TopicSnapshot>(`/api/topics/${encodeURIComponent(id)}/snapshot`);
    const name = pendingNames.get(id) || bundle.topic.name;
    if (!disposed && bundle.topic.revision >= (readCache(id)?.revision ?? 0)
      && snapshot.projects.some(project => project.id === id && project.name !== name)) {
      publish({projects:snapshot.projects.map(project => project.id === id ? {...project,name} : project)});
    }
    const hasSourceMaterial = !!bundle.topic.raw.trim();
    storage.set(`gft-local:has-sources:${id}`, String(hasSourceMaterial));
    if (snapshot.currentProjectId === id && snapshot.hasSourceMaterial !== hasSourceMaterial) publish({hasSourceMaterial});
    return mapOf(bundle.topic);
  };
  const cachePending = (id: string, map: PersistedThinkingMap) => {
    const old = readCache(id);
    const entry = { map, revision: old?.revision ?? 1, serial: ++serial, pending: true };
    writeCache(id, entry); return entry;
  };
  const save: ThinkingMapRuntime['persistence']['save'] = (id, map) => {
    cachePending(id, map);
    const queued = (saveQueues.get(id) || Promise.resolve(null)).catch(() => null).then(async () => {
      await pendingCreates.get(id)?.promise;
      const entry = readCache(id);
      if (!entry?.pending) return null;
      const saved = await localRequest<{ revision: number }>(`/api/topics/${encodeURIComponent(id)}/state`, { baseRevision: entry.revision, map: entry.map });
      const latest = readCache(id)!;
      writeCache(id, { ...latest, revision: Math.max(latest.revision,saved.revision), pending: latest.serial !== entry.serial });
      return null;
    });
    saveQueues.set(id, queued);
    void queued.finally(() => { if (saveQueues.get(id) === queued) saveQueues.delete(id); }).catch(() => {});
    return queued;
  };
  const flushPending = async (id: string) => {
    await pendingCreates.get(id)?.promise;
    const pending = readCache(id);
    if (pending?.pending) await save(id, pending.map);
    else await saveQueues.get(id);
  };
  async function refreshConnections(id = snapshot.currentProjectId) {
    if (!id) return [];
    const epoch = ++connectionEpoch;
    try {
      await pendingCreates.get(id)?.promise;
      const connections = await localRequest<ChatConnection[]>(`/api/connections?topicId=${encodeURIComponent(id)}`);
      if (!disposed && snapshot.currentProjectId === id && epoch === connectionEpoch) publishConnections({ topicId: id, revision: readCache(id)?.revision ?? null, connections: connections.filter(item => !disconnecting.has(item.id)), status: 'ready', error: '' });
      return connections;
    } catch (error) {
      if (!disposed && snapshot.currentProjectId === id && epoch === connectionEpoch) publishConnections({ status: 'error', error: messageOf(error) });
      throw error;
    }
  }
  function cancelChatUpdate() {
    if (!chatUpdate) return;
    if (connectionSnapshot.topicId === chatUpdate.topicId) publishConnections({ operation: { ...connectionSnapshot.operation, phase: 'cancelling', message: '正在取消…' } });
    chatUpdate.controller.abort();
    void chatUpdate.cancel?.();
  }
  async function updateFromChat(id: string, connectionId: string, operation: NonNullable<typeof chatUpdate>) {
    const signal = operation.controller.signal;
    const current = () => !disposed && chatUpdate === operation && snapshot.currentProjectId === id && !signal.aborted;
    if (!current()) throw abortError();
    publishConnections({ operation: { phase: 'reading', message: '正在读取所选会话的新材料…' } });
    store.getState().flushDocEdits(); store.getState().flushDoc();
    await flushPending(id);
    if (!current()) throw abortError();
    let until: unknown, batch = 0;
    for (;;) {
    if (!current()) throw abortError();
    if (batch > 0 && (store.getState().docDraft !== null || readCache(id)?.pending)) throw new Error('已保留完成的批次。请先保存当前编辑，再继续更新。');
    publishConnections({ operation: { phase: 'reading', message: `正在检查第 ${batch + 1} 批待读取材料…` } });
    // Keep the short enqueue request alive until we have the task ID for cancellation.
    const response = await localRequest<{ task?: { id: string }; unchanged?: boolean; message?: string; hasMore?: boolean; until?: unknown; messageCount?: number; stage?: 'distill' | 'publish' }>(`/api/topics/${encodeURIComponent(id)}/update-from-chat`, { connectionId, continuous: true, ...(until === undefined ? {} : { until }) });
    until = response.until ?? until;
    batch++;
    const progress = `第 ${batch} 批${response.messageCount ? ` · ${response.messageCount} 条消息` : ''}`;
    const activity = response.stage === 'distill' ? '历史较长，正在提炼；完成后统一生成图文' : response.stage === 'publish' ? '历史已提炼，正在汇总成一版图文' : 'Agent 正在按主题范围更新';
    const taskId = response.task?.id;
    if (!taskId) {
      if (!current()) throw abortError();
      if (!response.unchanged) throw new Error(response.message || '读取会话后没有返回可追踪的任务。');
      publishConnections({ operation: { phase: 'completed', message: response.message || '这段会话没有新增材料。', hasMore: response.hasMore } });
      await refreshConnections(id);
      return;
    }
    let cancellation: Promise<void> | undefined;
    const cancel = () => cancellation ||= localRequest(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {}, undefined, true).then(() => {}, () => {});
    operation.cancel = cancel; activeTasks.set(taskId, cancel);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (!current()) { await cancel(); throw abortError(); }
      publishConnections({ operation: { phase: 'running', message: `${progress} · ${activity}…`, taskId } });
      for (;;) {
        if (!current()) throw abortError();
        const task = await localRequest<{ status: string; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}/status`, undefined, signal);
        if (!current()) throw abortError();
        if (task.status === 'failed') throw new Error(task.error || '更新失败，原内容已保留。');
        if (task.status === 'cancelled') throw abortError();
        if (task.status === 'completed') {
          await store.getState().syncFromRemote();
          if (!current()) throw abortError();
          await refreshConnections(id);
          if (response.hasMore && until !== undefined) break;
          if (current()) publishConnections({ operation: { phase: 'completed', message: response.hasMore ? '本批已更新，还有材料可继续更新。' : `已完成 ${batch} 批更新，已追到本次开始时的会话末尾。`, taskId, hasMore: response.hasMore } });
          return;
        }
        publishConnections({ operation: { phase: 'running', message: `${progress} · ${activity}${task.status === 'pending' || task.status === 'queued' ? '（等待 Agent）' : '…'}`, taskId } });
        await pause(signal);
      }
    } catch (error) { await cancel(); throw error; }
    finally { signal.removeEventListener('abort', cancel); activeTasks.delete(taskId); }
    }
  }
  async function refreshProjects() {
    const projects = await localRequest<Array<{ id: string; name: string; status?: 'active' | 'archived' }>>('/api/topics');
    for (const [id, pending] of pendingCreates) if (!projects.some(project => project.id === id)) projects.unshift({ id, name: pending.name });
    if (!disposed) publish({ projects: projects.map(project => ({ ...project, name: pendingNames.get(project.id) || project.name, status: project.status || 'active' })) });
  }
  function editScope() {
    const state = store.getState();
    if (!snapshot.currentProjectId || state.isHydrating) return;
    state.flushDocEdits();
    if (!/^## 主题\s*$/m.test(store.getState().doc)) store.getState().setDocDraft(`## 主题\n\n${store.getState().doc}`);
    store.getState().jumpToDoc('主题');
  }
  async function generateManual(id: string, input: string) {
    const previousIds = new Set(store.getState().nodes.map(node => node.id));
    const result = await store.getState().generate(input);
    if (result === undefined || disposed || snapshot.currentProjectId !== id) return;
    store.getState().flushDoc();
    await flushPending(id);
    await writeSource(id,'sources',{event:{layer:'L0->L1',outputs:store.getState().nodes.filter(node => !previousIds.has(node.id)).map(node => node.id),
      inputs:[{id:crypto.randomUUID(),role:'user',name:null,content:input,ts:Date.now()}],
      sourceMeta:{sessionId:'manual',sessionTitle:'手工材料',count:1}}});
  }
  async function requestManualUpdate() {
    const id = snapshot.currentProjectId;
    if (!id) return;
    const state = store.getState();
    if (chatUpdate || state.isGenerating || state.isTidying || state.isRefining || state.isHydrating) { options.onError('请等当前操作完成后再更新。'); return; }
    try {
      const input = await options.onRequestUpdate();
      if (input?.trim() && snapshot.currentProjectId === id && !disposed) await generateManual(id,input);
    } catch (error) { options.onError(messageOf(error)); }
  }
  async function sources(id: string, alive?: Set<string>): Promise<SourceBatch[]> {
    await sourceQueues.get(id);
    const events = await localRequest<CondensationEvent[]>(`/api/topics/${encodeURIComponent(id)}/sources`);
    const seen = new Set<string>();
    return events.filter(event => event.layer === 'L0->L1' && Array.isArray(event.inputs))
      .map(event => ({ nodeIds: event.outputs, sessionTitle: event.sourceMeta?.sessionTitle || '', messages: Array.isArray(event.inputs) ? event.inputs : [] }))
      .filter(batch => {
        const key = batch.messages.map(message => message.id).join(',');
        if (!batch.messages.length || seen.has(key) || (alive && !batch.nodeIds.some(id => alive.has(id)))) return false;
        seen.add(key); return true;
      });
  }
  function writeSource(id: string, action: 'sources' | 'clear-sources', body: unknown) {
    const operation = (sourceQueues.get(id) || Promise.resolve()).then(async () => {
      try { await localRequest(`/api/topics/${encodeURIComponent(id)}/${action}`,body); }
      catch(error) { options.onError(`来源记录尚未保存：${messageOf(error)}`); }
    });
    sourceQueues.set(id,operation);
    void operation.finally(()=>{if(sourceQueues.get(id)===operation)sourceQueues.delete(id);});
    return operation;
  }
  const host: ThinkingMapHost = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    createProject(name) {
      if (creating) return creating;
      const id = crypto.randomUUID(), previousId = snapshot.currentProjectId;
      const title = name.trim() || '新脉络';
      const promise = localRequest<LocalTopic>('/api/topics', { id, name: title, scope: '' });
      pendingCreates.set(id, { name: title, promise });
      writeCache(id, { revision: 1, serial: ++serial, pending: false,
        map: mapOf({ id, name: title, scope: '', revision: 1, ledger: '走向 p1 [主题]', raw: '' }) });
      publish({ projects: [{ id, name: title, status: 'active' }, ...snapshot.projects] });
      const switched = host.switchProject(id);
      creating = (async () => {
        try {
          await promise; await switched;
          // A failed list refresh must not undo a topic that was already saved.
          await refreshProjects().catch(error => options.onError(messageOf(error)));
          return id;
        }
        catch (error) {
          pendingCreates.delete(id); cache.delete(id); storage.remove(keyOf(id));
          publish({ projects: snapshot.projects.filter(project => project.id !== id) });
          if (snapshot.currentProjectId === id) {
            store.getState().resetLocal(); publish({ currentProjectId: null });
            publishConnections({ topicId: null, revision: null, connections: [], status: 'ready', error: '', operation: null });
            storage.remove('gft-local:selected');
            if (previousId) await host.switchProject(previousId);
          }
          options.onError(messageOf(error)); return null;
        } finally { pendingCreates.delete(id); creating = undefined; }
      })();
      return creating;
    },
    async switchProject(id) {
      if (snapshot.currentProjectId === id) return;
      cancelChatUpdate();
      chatUpdate = null;
      connectionEpoch++;
      publishConnections({ topicId: id, revision: readCache(id)?.revision ?? null, connections: [], status: options.onRequestSource ? 'loading' : 'ready', error: '', operation: null });
      publish({ currentProjectId: id, projectNameFallback: snapshot.projects.find(project => project.id === id)?.name, hasSourceMaterial: storage.get(`gft-local:has-sources:${id}`) === 'true' });
      storage.set('gft-local:selected', id);
      if (options.onRequestSource) void refreshConnections(id).catch(() => {});
      await store.getState().hydrateForProject(id);
    },
    async renameProject(id, name) {
      name = name.trim();
      if (!name) return;
      pendingNames.set(id, name);
      publish({ projects: snapshot.projects.map(project => project.id === id ? { ...project, name } : project) });
      const queued = (renameQueues.get(id) || Promise.resolve()).then(async () => {
        try {
          await flushPending(id);
          const current = await localRequest<TopicSnapshot>(`/api/topics/${encodeURIComponent(id)}/snapshot`);
          const saved = await localRequest<{revision:number}>(`/api/topics/${encodeURIComponent(id)}/rename`, { baseRevision: current.topic.revision, name });
          const entry = readCache(id); if(entry) writeCache(id, {...entry,revision:saved.revision});
        } catch (error) { options.onError(messageOf(error)); }
        finally {
          if (pendingNames.get(id) === name) pendingNames.delete(id);
          await refreshProjects().catch(error => options.onError(messageOf(error)));
        }
      });
      renameQueues.set(id, queued);
      await queued;
      if (renameQueues.get(id) === queued) renameQueues.delete(id);
    },
    async deleteProject(id) {
      try {
      await flushPending(id);
      const current = await localRequest<TopicSnapshot>(`/api/topics/${encodeURIComponent(id)}/snapshot`);
      await localRequest(`/api/topics/${encodeURIComponent(id)}/archive`, { baseRevision: current.topic.revision });
      await refreshProjects();
      if (snapshot.currentProjectId === id) {
        cancelChatUpdate(); chatUpdate = null; connectionEpoch++;
        store.getState().resetLocal();
        publishConnections({ topicId: null, revision: null, connections: [], status: 'ready', error: '', operation: null });
        publish({ currentProjectId: null });
        if (snapshot.projects[0]) await host.switchProject(snapshot.projects[0].id);
      }
      } catch (error) { options.onError(messageOf(error)); }
    },
    ensureCanGenerate: () => true,
    fetchSourceBatches: sources,
    async requestUpdate() {
      const id = snapshot.currentProjectId;
      if (!id) { options.onError('请先创建或选择一个脉络。'); return; }
      if (chatUpdate) return;
      const state = store.getState();
      if (state.isGenerating || state.isTidying || state.isRefining || state.isHydrating) { options.onError('请等当前操作完成后再更新。'); return; }
        if (!options.onRequestSource) {
        try {
          const input = await options.onRequestUpdate();
          if (input?.trim() && snapshot.currentProjectId === id) await generateManual(id,input);
        } catch (error) { options.onError(messageOf(error)); }
        return;
      }
      const operation = { topicId: id, controller: new AbortController() };
      chatUpdate = operation;
      publishConnections({ operation: { phase: 'reading', message: '正在读取连接…' } });
      try {
        const connections = await refreshConnections(id);
        if (operation.controller.signal.aborted || snapshot.currentProjectId !== id) throw abortError();
        let source: UpdateSource = connections.length === 1 ? { connectionId: connections[0].id } : null;
        if (!source) {
          publishConnections({ operation: { phase: 'choosing', message: connections.length ? '请选择这次更新的会话。' : '请选择要连接的会话。' } });
          source = await options.onRequestSource(id, connections);
        }
        if (operation.controller.signal.aborted || snapshot.currentProjectId !== id) throw abortError();
        if (!source) { publishConnections({ operation: null }); return; }
        if ('manual' in source) {
          publishConnections({ operation: null });
          const input = await options.onRequestUpdate();
          if (input?.trim() && snapshot.currentProjectId === id && !operation.controller.signal.aborted) await generateManual(id,input);
        } else await updateFromChat(id, source.connectionId, operation);
      } catch (error) {
        if (chatUpdate === operation && snapshot.currentProjectId === id && !disposed) publishConnections({ operation: { phase: operation.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError') ? 'cancelled' : 'failed', message: messageOf(error) } });
      } finally { if (chatUpdate === operation) chatUpdate = null; }
    },
  };
  async function compute(action: 'update' | 'redraw' | 'tidy' | 'refine' | 'theme', system: string, user: string, context: MapComputeContext) {
    const id = context.projectId;
    if (!id) throw new Error('请先选择脉络。');
    if (context.signal.aborted || disposed) throw abortError();
    store.getState().flushDoc(); // Drain the shared debounce before pinning a model task to a revision.
    await flushPending(id);
    if (action === 'redraw') await sourceQueues.get(id);
    if (context.signal.aborted || disposed) throw abortError();
    const revision = readCache(id)?.revision;
    if (revision === undefined) throw new Error('脉络尚未读取，请重新打开后处理。');
    // Do not abort the short queue request before receiving its task ID; otherwise
    // a cancel could leave a task running without a handle to stop it.
    const task = await localRequest<{id:string}>(`/api/topics/${encodeURIComponent(id)}/compute`, {baseRevision:revision,request:{action,system,user}});
    let cancellation: Promise<void> | undefined;
    const cancel = () => cancellation ||= localRequest(`/api/tasks/${task.id}/cancel`, {}, undefined, true).then(() => {}, () => {});
    activeTasks.set(task.id, cancel);
    context.signal.addEventListener('abort', cancel, {once:true});
    if (context.signal.aborted || disposed) { cancel(); activeTasks.delete(task.id); throw abortError(); }
    try {
      for (;;) {
        if (context.signal.aborted || disposed) throw abortError();
        const state = await localRequest<{status:string;error?:string}>(`/api/tasks/${task.id}/status`, undefined, context.signal);
        if (state.status === 'completed') return (await localRequest<{output:string}>(`/api/tasks/${task.id}/result`, undefined, context.signal)).output;
        if (state.status === 'failed') throw new Error(state.error || '本地模型执行失败。');
        if (state.status === 'cancelled') throw abortError();
        await pause(context.signal);
      }
    } catch(error) { cancel(); throw error; }
    finally { context.signal.removeEventListener('abort', cancel); activeTasks.delete(task.id); }
  }
  const runtime: ThinkingMapRuntime = {
    host,
    persistence: {
      load, loadCached: id => readCache(id)?.map || null, save, cachePending,
      hasPending: id => readCache(id)?.pending === true,
      hasRemoteChanges: (id,map) => remoteVersions.get(map) !== readCache(id)?.revision,
      accept(id, remote, applied = remote) {
        const revision = remoteVersions.get(remote); if(revision === undefined) return;
        const old = readCache(id);
        writeCache(id, { map:applied, revision, pending:old?.pending || false, serial:++serial });
      },
      insertCondensation: (id,event) => writeSource(id,'sources',{event}),
      // An empty/filtered map is not permission to discard its saved source messages.
      // An empty or filtered map is not permission to discard saved original sources.
      clearCondensations: async () => {},
      async fetchSourceSnapshots(id,nodeIds) {
        const text = (await sources(id,new Set(nodeIds))).flatMap(batch=>batch.messages).map(message=>`${message.role==='user' ? message.name || '用户' : 'AI'}：${message.content}`).join('\n\n');
        return text.length > 8000 ? `${text.slice(0,8000)}…` : text;
      },
    },
    ai: {
      async generate(input,settings,_onPreview,context) {
        const request = buildGenerateRequest(input,settings);
        const raw = await compute(settings?.rewrite ? 'redraw' : 'update',request.system,request.user,context);
        return parseGenerateResponse(raw,settings);
      },
      async tidy(input,_settings,context) {
        if (input.scopeIds?.length === 0) return [];
        const request = buildTidyRequest(input);
        const raw = await compute('tidy',request.systemPrompt,request.text,context);
        const evidence = [input.sourceDoc ?? '', ...input.prose.map(prose=>prose.text)].join('\n\n');
        return parseTidyOps(raw,request.alias,input.judgments,new Set(input.prose.map(prose=>prose.domain)),evidence,input.scopeIds === undefined ? undefined : new Set(input.scopeIds), input.prose.map(p=>p.text).join('\n'));
      },
      async refine(target,neighbors,birth,chat,_settings,context) {
        return parseRefineTags(await compute('refine',buildRefinePrompt(target,neighbors.up,neighbors.down,birth,chat),'请按规则润色目标节点。',context));
      },
    },
  };
  const store = createThinkingMapStore(runtime);
  const dispose = () => {
    if (disposed) return;
    disposed = true; clearInterval(poll);
    cancelChatUpdate(); connectionEpoch++;
    store.getState().cancelGeneration(); store.getState().cancelTidy();
    for (const cancel of activeTasks.values()) void cancel();
    store.getState().flushDocEdits(); store.getState().flushDoc();
    store.getState().resetLocal(); // Includes an in-flight node refinement and invalidates late responses.
    listeners.clear();
    connectionListeners.clear();
  };
  return {
    store,host,refreshProjects,dispose,requestManualUpdate,editScope,
    connections: {
      getSnapshot: () => connectionSnapshot,
      subscribe(listener: () => void) { connectionListeners.add(listener); return () => { connectionListeners.delete(listener); }; },
      refresh: refreshConnections,
      cancel: cancelChatUpdate,
      dismiss() { if (!chatUpdate) publishConnections({ operation: null }); },
      async connect(source: ChatSession, topicIds: string[], history: 'now' | 'all') {
        const result = await localRequest<ChatConnection[]>('/api/connections/connect', { source, topicIds, history });
        await refreshConnections(); return result;
      },
      async disconnect(connectionId: string) {
        disconnecting.add(connectionId);
        publishConnections({ connections: connectionSnapshot.connections.filter(item => item.id !== connectionId) });
        try { await localRequest('/api/connections/disconnect', { connectionId }); }
        finally { disconnecting.delete(connectionId); await refreshConnections(); }
      },
      async disconnectAll(topicId: string) {
        const connections = await refreshConnections(topicId);
        await Promise.all(connections.map(connection => localRequest('/api/connections/disconnect', { connectionId: connection.id })));
        await refreshConnections(topicId);
      },
    },
    async importTopic(bundle: unknown) {
      const topic = await localRequest<LocalTopic>('/api/import',bundle);
      // Import is already durable. A later list refresh must not make retry create a duplicate.
      publish({ projects: [{ id: topic.id, name: topic.name, status: 'active' }, ...snapshot.projects] });
      if ((bundle as { format?: string })?.format === 'gft-document') store.getState().setRightView('doc');
      await Promise.resolve(host.switchProject(topic.id)).catch(error => options.onError(`脉络已导入，打开时遇到问题：${messageOf(error)}`));
      await refreshProjects().catch(error => options.onError(`脉络已导入，列表刷新失败：${messageOf(error)}`));
      return topic.id;
    },
    async start() {
      await refreshProjects();
      const selected = storage.get('gft-local:selected');
      const first = snapshot.projects.find(project=>project.id===selected) || snapshot.projects[0];
      if (first) await host.switchProject(first.id);
      poll = setInterval(() => {
        if (!disposed) void store.getState().syncFromRemote().catch(error=>options.onError(messageOf(error)));
        if (!disposed && options.onRequestSource) void refreshConnections().catch(() => {});
      },3000);
    },
  };
}
