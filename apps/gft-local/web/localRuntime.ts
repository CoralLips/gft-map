import { createThinkingMapStore } from '../../../src/store/thinkingMap/createStore';
import type {
  MapHostSnapshot,
  ThinkingMapHost,
  ThinkingMapRuntime,
} from '../../../src/store/thinkingMap/runtime';
import type { CondensationEvent, SourceBatch } from '../../../src/type/sourceSnapshot';
import { t } from '../../../src/i18n';
import { createReconnectMonitor, type ServiceConnectionSnapshot } from './reconnect';
import { createMapCache } from './runtime/mapCache';
import { createReceipts } from './runtime/receipts';
import { createTasks, type TaskRecord } from './runtime/tasks';
import { createUpdates } from './runtime/updates';
import {
  LocalApiError,
  LocalConnectionError,
  localRequest,
  messageOf,
  storage,
} from './runtime/api';
import type { LocalTopic, TopicSnapshot, LocalRuntimeOptions } from './runtime/types';

export { LocalApiError, LocalConnectionError, localRequest } from './runtime/api';
export type {
  ChatProvider,
  ChatSession,
  ChatConnection,
  UpdateSource,
  ReceiptNode,
  UpdateReceipt,
  ReceiptSnapshot,
  ConnectionSnapshot,
} from './runtime/types';

/** Host adapter only: all document/graph mutations are the platform's shared store. */
export function createLocalRuntime(options: LocalRuntimeOptions) {
  const listeners = new Set<() => void>();
  const sourceQueues = new Map<string, Promise<void>>();
  const pendingCreates = new Map<string, { name: string; promise: Promise<LocalTopic> }>();
  const pendingNames = new Map<string, string>();
  const renameQueues = new Map<string, Promise<void>>();
  let creating: Promise<string | null> | undefined;
  let disposed = false;
  let startupLoadError: string | null = null;
  const serviceListeners = new Set<() => void>();
  let serviceSnapshot: ServiceConnectionSnapshot & {
    pending: boolean;
    saveFailed: boolean;
    stoppingTaskIds: string[];
    stopError: string;
  } = {
    phase: 'connecting',
    checking: false,
    hasConnected: false,
    pending: false,
    saveFailed: false,
    stoppingTaskIds: [],
    stopError: '',
  };
  let snapshot: MapHostSnapshot = {
    projects: [],
    currentProjectId: null,
    currentSession: null,
    chatHistory: [],
    sourceLabel: '所选会话',
    showMemoryToggle: false,
    redrawDescription:
      '保留当前主题，基于 Log 已接收的来源重新生成图文。不读取原聊天，更新进度不变；旧记录只使用实际保存的材料。完成后可 Ctrl+Z 撤销。',
  };
  const publish = (change: Partial<MapHostSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    listeners.forEach(listener => listener());
    publishService();
  };
  async function request<T>(
    url: string,
    body?: unknown,
    signal?: AbortSignal,
    keepalive = false,
  ): Promise<T> {
    try {
      return await localRequest<T>(url, body, signal, keepalive);
    } catch (error) {
      // A rejected Agent switch keeps the original service and executor available.
      const rejectedExecutor =
        url === '/api/runtime/executor' && error instanceof LocalApiError && error.status === 503;
      if (
        error instanceof LocalConnectionError ||
        (error instanceof LocalApiError && error.status >= 500 && !rejectedExecutor)
      )
        monitor.disconnected();
      throw error;
    }
  }
  const maps = createMapCache({
    request,
    waitForCreate: id => pendingCreates.get(id)?.promise,
    onChange(id, entry) {
      publishService();
      if (entry) updates.revisionSaved(id, entry.revision);
    },
  });
  const readCache = maps.read,
    writeCache = maps.write,
    mapOf = maps.mapOf,
    flushPending = maps.flushPending;
  const load = async (id: string) => {
    await pendingCreates.get(id)?.promise;
    const bundle = await request<TopicSnapshot>(
      `/api/topics/${encodeURIComponent(id)}/snapshot`,
    ).catch(error => {
      if (!serviceSnapshot.hasConnected) startupLoadError = messageOf(error);
      throw error;
    });
    const name = pendingNames.get(id) || bundle.topic.name;
    if (
      !disposed &&
      bundle.topic.revision >= (readCache(id)?.revision ?? 0) &&
      snapshot.projects.some(project => project.id === id && project.name !== name)
    ) {
      publish({
        projects: snapshot.projects.map(project =>
          project.id === id ? { ...project, name } : project,
        ),
      });
    }
    const hasSourceMaterial = !!bundle.topic.raw.trim();
    storage.set(`gft-local:has-sources:${id}`, String(hasSourceMaterial));
    if (snapshot.currentProjectId === id && snapshot.hasSourceMaterial !== hasSourceMaterial)
      publish({ hasSourceMaterial });
    return mapOf(bundle.topic);
  };
  const receipts = createReceipts({
    request,
    store: () => store,
    maps,
    currentProjectId: () => snapshot.currentProjectId,
    isDisposed: () => disposed,
    waitForCreate: id => pendingCreates.get(id)?.promise,
    otherWorkRunning: () => updates.isRunning() || tasks.isRunning(),
    clearUpdateNotice: () => updates.publish({ operation: null }),
  });
  const refreshReceipt = receipts.refresh,
    rollbackBlocked = receipts.rollbackBlocked;
  const updates = createUpdates({
    request,
    store: () => store,
    maps,
    options,
    tasks: () => tasks,
    isDisposed: () => disposed,
    currentProjectId: () => snapshot.currentProjectId,
    waitForCreate: id => pendingCreates.get(id)?.promise,
    refreshReceipt,
    rollbackBlocked,
  });
  const { refreshConnections } = updates;
  async function refreshProjects() {
    const projects =
      await request<Array<{ id: string; name: string; status?: 'active' | 'archived' }>>(
        '/api/topics',
      );
    for (const [id, pending] of pendingCreates)
      if (!projects.some(project => project.id === id))
        projects.unshift({ id, name: pending.name });
    if (!disposed)
      publish({
        projects: projects.map(project => ({
          ...project,
          name: pendingNames.get(project.id) || project.name,
          status: project.status || 'active',
        })),
      });
    const current = snapshot.currentProjectId,
      state = store.getState();
    if (
      !disposed &&
      current &&
      !projects.some(project => project.id === current) &&
      state.docDraft === null &&
      !state.sourceDraftActive &&
      !state.editingNodeId &&
      !state.isHydrating &&
      !state.isGenerating &&
      !state.isTidying &&
      !state.isRefining &&
      !readCache(current)?.pending
    ) {
      updates.leave();
      state.resetLocal();
      maps.forget(current);
      storage.remove('gft-local:selected');
      publish({ currentProjectId: null });
      updates.showNone();
    }
  }
  function editScope() {
    const state = store.getState();
    if (!snapshot.currentProjectId || state.isHydrating) return;
    state.flushDocEdits();
    if (!/^## 主题\s*$/m.test(store.getState().doc))
      store.getState().setDocDraft(`## 主题\n\n${store.getState().doc}`);
    store.getState().jumpToDoc('主题');
  }
  async function sources(id: string, alive?: Set<string>): Promise<SourceBatch[]> {
    await sourceQueues.get(id);
    const events = await request<CondensationEvent[]>(
      `/api/topics/${encodeURIComponent(id)}/sources`,
    );
    const seen = new Set<string>();
    return events
      .filter(event => event.layer === 'L0->L1' && Array.isArray(event.inputs))
      .map(event => ({
        nodeIds: event.outputs,
        sessionTitle: event.sourceMeta?.sessionTitle || '',
        messages: Array.isArray(event.inputs) ? event.inputs : [],
      }))
      .filter(batch => {
        const key = batch.messages.map(message => message.id).join(',');
        if (
          !batch.messages.length ||
          seen.has(key) ||
          (alive && !batch.nodeIds.some(id => alive.has(id)))
        )
          return false;
        seen.add(key);
        return true;
      });
  }
  function writeSource(id: string, action: 'sources' | 'clear-sources', body: unknown) {
    const operation = (sourceQueues.get(id) || Promise.resolve()).then(async () => {
      try {
        await request(`/api/topics/${encodeURIComponent(id)}/${action}`, body);
      } catch (error) {
        options.onError(t('来源记录尚未保存：{error}', { error: messageOf(error) }));
      }
    });
    sourceQueues.set(id, operation);
    void operation.finally(() => {
      if (sourceQueues.get(id) === operation) sourceQueues.delete(id);
    });
    return operation;
  }
  const host: ThinkingMapHost = {
    async downloadBundle() {
      const id = snapshot.currentProjectId;
      if (!id) return;
      store.getState().flushDocEdits();
      store.getState().flushDoc();
      await flushPending(id);
      const files = await request<
        { state: string; received: number; size: number; sha256?: string }[]
      >(`/api/materials?topicId=${encodeURIComponent(id)}`);
      if (files.some(file => file.received !== file.size || !file.sha256))
        throw new Error(t('原文件尚未接收完整，请完成续传后下载'));
      if (files.some(file => ['running', 'queued'].includes(file.state)))
        throw new Error(t('请先暂停材料整理，再下载完整存档'));
      const anchor = document.createElement('a');
      anchor.href = `/api/topics/${encodeURIComponent(id)}/download`;
      anchor.download = '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    },
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    createProject(name) {
      if (creating) return creating;
      const id = crypto.randomUUID(),
        previousId = snapshot.currentProjectId;
      const title = name.trim() || '新脉络';
      const promise = request<LocalTopic>('/api/topics', { id, name: title, scope: '' });
      pendingCreates.set(id, { name: title, promise });
      writeCache(id, {
        revision: 1,
        serial: maps.nextSerial(),
        pending: false,
        map: mapOf({ id, name: title, scope: '', revision: 1, ledger: '走向 p1 [主题]', raw: '' }),
      });
      publish({ projects: [{ id, name: title, status: 'active' }, ...snapshot.projects] });
      const switched = host.switchProject(id);
      creating = (async () => {
        try {
          await promise;
          await switched;
          // A failed list refresh must not undo a topic that was already saved.
          await refreshProjects().catch(error => options.onError(messageOf(error)));
          return id;
        } catch (error) {
          pendingCreates.delete(id);
          maps.forget(id);
          publish({ projects: snapshot.projects.filter(project => project.id !== id) });
          if (snapshot.currentProjectId === id) {
            store.getState().resetLocal();
            publish({ currentProjectId: null });
            updates.showNone();
            storage.remove('gft-local:selected');
            if (previousId) await host.switchProject(previousId);
          }
          options.onError(messageOf(error));
          return null;
        } finally {
          pendingCreates.delete(id);
          creating = undefined;
        }
      })();
      return creating;
    },
    async switchProject(id) {
      if (snapshot.currentProjectId === id) return;
      updates.leave(true); // Switching only stops watching; the update keeps running.
      receipts.switchTo(id);
      updates.showTopic(id);
      publish({
        currentProjectId: id,
        projectNameFallback: snapshot.projects.find(project => project.id === id)?.name,
        hasSourceMaterial: storage.get(`gft-local:has-sources:${id}`) === 'true',
      });
      storage.set('gft-local:selected', id);
      if (options.onRequestSource) void refreshConnections(id).catch(() => {});
      await store.getState().hydrateForProject(id);
      await refreshReceipt(id);
      await recoverTasks();
    },
    async renameProject(id, name) {
      name = name.trim();
      if (!name) return;
      pendingNames.set(id, name);
      publish({
        projects: snapshot.projects.map(project =>
          project.id === id ? { ...project, name } : project,
        ),
      });
      const queued = (renameQueues.get(id) || Promise.resolve()).then(async () => {
        try {
          await flushPending(id);
          const current = await request<TopicSnapshot>(
            `/api/topics/${encodeURIComponent(id)}/snapshot`,
          );
          const saved = await request<{ revision: number }>(
            `/api/topics/${encodeURIComponent(id)}/rename`,
            { baseRevision: current.topic.revision, name },
          );
          const entry = readCache(id);
          if (entry) writeCache(id, { ...entry, revision: saved.revision });
        } catch (error) {
          options.onError(messageOf(error));
        } finally {
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
        const current = await request<TopicSnapshot>(
          `/api/topics/${encodeURIComponent(id)}/snapshot`,
        );
        await request(`/api/topics/${encodeURIComponent(id)}/archive`, {
          baseRevision: current.topic.revision,
        });
        await refreshProjects();
        if (snapshot.currentProjectId === id) {
          updates.leave();
          store.getState().resetLocal();
          updates.showNone();
          publish({ currentProjectId: null });
          if (snapshot.projects[0]) await host.switchProject(snapshot.projects[0].id);
        }
      } catch (error) {
        options.onError(messageOf(error));
      }
    },
    ensureCanGenerate: () => true,
    fetchSourceBatches: sources,
    requestUpdate: () => updates.requestUpdate(),
  };
  const tasks = createTasks({
    request,
    store: () => store,
    maps,
    isDisposed: () => disposed,
    currentProjectId: () => snapshot.currentProjectId,
    onError: options.onError,
    sourcesSaved: id => sourceQueues.get(id),
    refreshReceipt,
    connections: { snapshot: () => updates.snapshot(), publish: change => updates.publish(change) },
    onStopsChange: () => publishService(),
  });

  const runtime: ThinkingMapRuntime = {
    host,
    operations: {
      run: tasks.runOperation,
      rollback: tasks.rollbackOperations,
      rollbackTo: (id, ledger) => tasks.rollbackOperations(id, [], ledger),
      history: maps.history,
    },
    persistence: {
      // Empty raw is valid for file-backed topics. Do not manufacture a Log
      // from generated output or autosave a fake legacy migration on reload.
      migrateLegacySources: false,
      load,
      loadCached: id => readCache(id)?.map || null,
      save: maps.save,
      cachePending: maps.cachePending,
      hasPending: maps.hasPending,
      hasRemoteChanges: maps.hasRemoteChanges,
      accept: maps.accept,
      insertCondensation: (id, event) => writeSource(id, 'sources', { event }),
      // An empty/filtered map is not permission to discard its saved source messages.
      // An empty or filtered map is not permission to discard saved original sources.
      clearCondensations: async () => {},
      async fetchSourceSnapshots(id, nodeIds) {
        const fileSources = await request<{ text: string }>(
          `/api/material-evidence?${new URLSearchParams([['topicId', id], ...nodeIds.map(node => ['node', node])])}`,
        );
        const text =
          fileSources.text +
          (await sources(id, new Set(nodeIds)))
            .flatMap(batch => batch.messages)
            .map(
              message =>
                `${message.role === 'user' ? message.name || '用户' : 'AI'}：${message.content}`,
            )
            .join('\n\n');
        return text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
      },
    },
  };
  const store = createThinkingMapStore(runtime);
  /** Shows tasks that are still running for the open map, without submitting them again. */
  async function recoverTasks() {
    const id = snapshot.currentProjectId;
    if (!id || disposed) return;
    const list = await request<TaskRecord[]>('/api/tasks');
    if (disposed || snapshot.currentProjectId !== id) return;
    for (const task of list) {
      if (task.topicId !== id || !tasks.canReattach(task)) continue;
      if (task.source && ['update', 'compact'].includes(task.action))
        void updates.recoverChatUpdate({ ...task, source: task.source });
      else tasks.reattach(task);
    }
  }
  const monitor = createReconnectMonitor(async () => {
    const reconnecting = monitor.getSnapshot().phase !== 'connected';
    const existingProject = snapshot.currentProjectId;
    await refreshProjects();
    if (disposed) return;
    // A recovered connection must not rehydrate/remount the current editor.
    if (!snapshot.currentProjectId && !serviceSnapshot.hasConnected) {
      const selected = storage.get('gft-local:selected');
      const first =
        snapshot.projects.find(project => project.id === selected) || snapshot.projects[0];
      if (first) await host.switchProject(first.id);
    } else if (!updates.isRunning()) await store.getState().syncFromRemote();
    if (!disposed && reconnecting && existingProject) await recoverTasks();
    if (!disposed && options.onRequestSource) await refreshConnections();
    if (!disposed) await refreshReceipt();
  });
  function publishService() {
    const next = {
      ...monitor.getSnapshot(),
      pending:
        !!snapshot.currentProjectId && readCache(snapshot.currentProjectId)?.pending === true,
      saveFailed: !!snapshot.currentProjectId && maps.saveFailed(snapshot.currentProjectId),
      ...tasks.stopState(),
    };
    if (
      Object.keys(next).every(
        key => next[key as keyof typeof next] === serviceSnapshot[key as keyof typeof next],
      )
    )
      return;
    if (next.hasConnected && !serviceSnapshot.hasConnected && startupLoadError) {
      if (store.getState().error === startupLoadError) store.setState({ error: null });
      startupLoadError = null;
    }
    serviceSnapshot = next;
    serviceListeners.forEach(listener => listener());
  }
  monitor.subscribe(publishService);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    monitor.dispose();
    updates.dispose();
    receipts.dispose();
    store.getState().cancelGeneration();
    store.getState().cancelTidy();
    tasks.detachAll();
    store.getState().flushDocEdits();
    store.getState().flushDoc();
    store.getState().resetLocal(); // Includes an in-flight node refinement and invalidates late responses.
    listeners.clear();
    serviceListeners.clear();
    // Submitted writes keep their ordering. Hosts/tests that replace the runtime
    // can wait for these finite writes without waiting for background AI work.
    return Promise.allSettled([...maps.allSaves(), ...tasks.following()]);
  };
  return {
    store,
    host,
    refreshProjects,
    dispose,
    requestManualUpdate: updates.requestManualUpdate,
    editScope,
    request,
    cancelTask: tasks.cancelTask,
    service: {
      getSnapshot: () => serviceSnapshot,
      subscribe(listener: () => void) {
        serviceListeners.add(listener);
        return () => {
          serviceListeners.delete(listener);
        };
      },
      // Reconnects, then asks again for stops the service has not confirmed.
      retry: async () => {
        await monitor.retry();
        await tasks.retryStops();
      },
      async savePending() {
        const id = snapshot.currentProjectId;
        if (!id) return;
        // This is an explicit user retry, never part of the reconnect loop.
        store.getState().flushDocEdits();
        store.getState().flushDoc();
        await maps.retrySave(id);
        store.setState({ error: null });
      },
    },
    receipts: receipts.api,
    connections: updates.api,
    async importTopic(bundle: unknown) {
      const topic = await request<LocalTopic>('/api/import', bundle);
      // Import is already durable. A later list refresh must not make retry create a duplicate.
      publish({
        projects: [{ id: topic.id, name: topic.name, status: 'active' }, ...snapshot.projects],
      });
      if ((bundle as { format?: string })?.format === 'gft-document')
        store.getState().setRightView('doc');
      await Promise.resolve(host.switchProject(topic.id)).catch(error =>
        options.onError(t('脉络已导入，打开时遇到问题：{error}', { error: messageOf(error) })),
      );
      await refreshProjects().catch(error =>
        options.onError(t('脉络已导入，列表刷新失败：{error}', { error: messageOf(error) })),
      );
      return topic.id;
    },
    start: monitor.start,
  };
}
