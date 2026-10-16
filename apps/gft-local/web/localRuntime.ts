import { RelationReasonLengthError } from '../../../src/service/relationReason';
import { DIRECT_INPUT_LIMIT } from '../limits.mjs';
import {
  buildRelationExplanationRequest,
  parseRelationExplanation,
} from '../../../src/service/relationExplanation';
import { createThinkingMapStore } from '../../../src/store/thinkingMap/createStore';
import type {
  MapComputeContext,
  MapHostSnapshot,
  MapOperationOutcome,
  MapOperationRequest,
  ThinkingMapHost,
  ThinkingMapRuntime,
} from '../../../src/store/thinkingMap/runtime';
import type { PersistedThinkingMap } from '../../../src/type/thinkingMap';
import type { CondensationEvent, SourceBatch } from '../../../src/type/sourceSnapshot';
import { deriveCaches } from '../../../src/service/ledger/bridge';
import { parseLedger } from '../../../src/service/ledger';
import { isEditedSourceLog, mergeSourceLogs } from '../../../src/service/sourceLog';
import { mergeLedgerPair } from '../../../src/service/ledger/merge';
import { sessionLine } from '../../../src/service/ledger/write';
import {
  buildGenerateRequest,
  parseGenerateResponse,
  buildRefinePrompt,
  parseRefineTags,
} from '../../../src/service/thinkingMapCore';
import { tidyCall } from '../../../src/service/tidyCore';
import { t } from '../../../src/i18n';
import { createReconnectMonitor, type ServiceConnectionSnapshot } from './reconnect';

interface LocalTopic {
  undo?: Array<{ id: string; ledger?: string; ledgerLength?: number }>;
  id: string;
  name: string;
  scope: string;
  revision: number;
  ledger: string;
  raw: string;
  panel?: PersistedThinkingMap;
  /** Revision of the latest commit that only appended a background writer's lines. */
  appendRevision?: number;
}
interface TopicSnapshot {
  topic: LocalTopic;
}
interface CachedMap {
  revision: number;
  serial: number;
  pending: boolean;
  map: PersistedThinkingMap;
  base?: { ledger: string; raw: string };
}
export type ChatProvider = 'codex' | 'claude';
export interface ChatSession {
  provider: ChatProvider;
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
}
export interface ChatConnection {
  id: string;
  topicId: string;
  source: ChatSession;
  history: 'now' | 'all';
  loadedRevision: number | null;
}
export type UpdateSource = { connectionId: string } | { manual: true } | null;
export interface ReceiptNode {
  id: string;
  title: string;
  content: string;
  mark: string;
  domain: string;
  superseded: boolean;
}
export interface UpdateReceipt {
  id: string;
  action: string;
  baseRevision: number;
  resultRevision: number;
  createdAt: string;
  source: { provider: string; sessionTitle: string; messageCount: number } | null;
  changes: {
    name?: { before: string; after: string } | null;
    nodes: Array<{
      id: string;
      kind: 'added' | 'modified' | 'removed';
      before: ReceiptNode | null;
      after: ReceiptNode | null;
    }>;
    edges: {
      modified?: Array<{ from: string; to: string; before: string; after: string }>;
      added: Array<{ from: string; to: string }>;
      removed: Array<{ from: string; to: string }>;
    };
    chapters: Array<{ domain: string; before: string | null; after: string | null }>;
    doc: { before: string; after: string } | null;
  };
  canRollback: boolean;
  rollbackBlockedReason: string | null;
  rolledBackAt?: string;
  rollbackRevision?: number;
}
export interface ReceiptSnapshot {
  topicId: string | null;
  currentRevision: number | null;
  receipt: UpdateReceipt | null;
  loading: boolean;
  rollingBack: boolean;
  error: string;
}
export interface ConnectionSnapshot {
  topicId: string | null;
  revision: number | null;
  connections: ChatConnection[];
  status: 'loading' | 'ready' | 'error';
  error: string;
  operation: {
    phase: 'choosing' | 'reading' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
    message: string;
    taskId?: string;
    hasMore?: boolean;
    undoGroup?: string;
  } | null;
}
interface LocalRuntimeOptions {
  onRequestUpdate(): Promise<string | null>;
  onRequestSource?(topicId: string, connections: ChatConnection[]): Promise<UpdateSource>;
  onError(message: string): void;
}
export class LocalApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export class LocalConnectionError extends Error {
  constructor() {
    super(t('本地服务连接中断，当前内容和未保存修改已保留。'));
  }
}
export async function localRequest<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
  keepalive = false,
): Promise<T> {
  // Bound reads so a stalled socket cannot block reconnect checks indefinitely.
  const controller = body === undefined ? new AbortController() : undefined;
  const abort = () => controller?.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  // Adapter discovery can include CLI authentication checks with their own timeouts.
  const timeout = controller
    ? setTimeout(
        abort,
        ['/api/runtime/executors', '/api/runtime/executor'].includes(url) ? 240000 : 10000,
      )
    : undefined;
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal || signal,
      keepalive,
    });
    const data = await response.json().catch(error => {
      if (controller?.signal.aborted || signal?.aborted) throw error;
      if (response.ok) throw new LocalConnectionError();
      return {};
    });
    if (!response.ok)
      throw new LocalApiError(
        data.error ? t(data.error) : t('请求失败（{status}）', { status: response.status }),
        response.status,
      );
    return data as T;
  } catch (error) {
    if (!signal?.aborted && (error instanceof TypeError || controller?.signal.aborted))
      throw new LocalConnectionError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
const messageOf = (error: unknown) => t(error instanceof Error ? error.message : String(error));
const abortError = () => new DOMException(t('任务已取消，当前内容保留。'), 'AbortError');
const keyOf = (id: string) => `gft-local:panel:${id}`;
const storage = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* The in-memory pending copy remains available. */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Optional browser mirror. */
    }
  },
};
type MapState = Pick<PersistedThinkingMap, 'nodes' | 'doc'>;
/** How an update changed the nodes and text, or '' when neither changed. */
function changeSummary(before: MapState, after: MapState) {
  const oldNodes = new Map(before.nodes.map(node => [node.id, node]));
  const newIds = new Set(after.nodes.map(node => node.id));
  const added = after.nodes.filter(node => !oldNodes.has(node.id)).length;
  const modified = after.nodes.filter(node => {
    const old = oldNodes.get(node.id);
    return (
      old &&
      (old.title !== node.title ||
        old.body !== node.body ||
        old.group !== node.group ||
        old.superseded !== node.superseded)
    );
  }).length;
  const removed = before.nodes.filter(node => !newIds.has(node.id)).length;
  return [
    added ? t('新增 {count} 个节点', { count: added }) : '',
    modified ? t('修改 {count} 个节点', { count: modified }) : '',
    removed ? t('移除 {count} 个节点', { count: removed }) : '',
    before.doc !== after.doc ? t('正文已更新') : '',
  ]
    .filter(Boolean)
    .join('，');
}
function pause(signal: AbortSignal, delay = 500) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const done = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, delay);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Host adapter only: all document/graph mutations are the platform's shared store. */
export function createLocalRuntime(options: LocalRuntimeOptions) {
  const listeners = new Set<() => void>(),
    cache = new Map<string, CachedMap>();
  const remoteVersions = new WeakMap<PersistedThinkingMap, number>();
  const saveQueues = new Map<string, Promise<PersistedThinkingMap | null>>();
  const failedSaves = new Set<string>();
  const sourceQueues = new Map<string, Promise<void>>();
  const activeTasks = new Map<string, () => Promise<void>>();
  const settledTasks = new Set<string>();
  const taskFollowers = new Map<string, Promise<TaskState>>();
  function rememberSettled(id: string) {
    settledTasks.add(id);
    if (settledTasks.size > 200) settledTasks.delete(settledTasks.values().next().value!);
  }
  const pendingCreates = new Map<string, { name: string; promise: Promise<LocalTopic> }>();
  const pendingNames = new Map<string, string>();
  const renameQueues = new Map<string, Promise<void>>();
  let creating: Promise<string | null> | undefined;
  const receiptListeners = new Set<() => void>();
  let receiptSnapshot: ReceiptSnapshot = {
    topicId: null,
    currentRevision: null,
    receipt: null,
    loading: false,
    rollingBack: false,
    error: '',
  };
  let receiptEpoch = 0;
  const publishReceipt = (change: Partial<ReceiptSnapshot>) => {
    receiptSnapshot = { ...receiptSnapshot, ...change };
    receiptListeners.forEach(listener => listener());
  };
  const connectionListeners = new Set<() => void>();
  const disconnecting = new Set<string>();
  let connectionSnapshot: ConnectionSnapshot = {
    topicId: null,
    revision: null,
    connections: [],
    status: 'ready',
    error: '',
    operation: null,
  };
  let connectionEpoch = 0;
  let updateSequence = 0;
  let chatUpdate: {
    topicId: string;
    undoGroup: string;
    controller: AbortController;
    sourceIndex: number;
    sourceCount: number;
  } | null = null;
  let serial = 0,
    disposed = false;
  let startupLoadError: string | null = null;
  const serviceListeners = new Set<() => void>();
  let serviceSnapshot: ServiceConnectionSnapshot & { pending: boolean; saveFailed: boolean } = {
    phase: 'connecting',
    checking: false,
    hasConnected: false,
    pending: false,
    saveFailed: false,
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
  const publishConnections = (change: Partial<ConnectionSnapshot>) => {
    connectionSnapshot = { ...connectionSnapshot, ...change };
    connectionListeners.forEach(listener => listener());
  };
  const readCache = (id: string) => {
    if (cache.has(id)) return cache.get(id)!;
    try {
      const saved = JSON.parse(storage.get(keyOf(id)) || 'null') as CachedMap | null;
      if (saved?.map && Number.isInteger(saved.revision)) {
        cache.set(id, saved);
        serial = Math.max(serial, saved.serial || 0);
        return saved;
      }
    } catch {
      /* A damaged browser mirror never replaces the file-backed record. */
    }
    return null;
  };
  const writeCache = (id: string, entry: CachedMap) => {
    cache.set(id, entry);
    storage.set(keyOf(id), JSON.stringify(entry));
    publishService();
    if (connectionSnapshot.topicId === id && connectionSnapshot.revision !== entry.revision)
      publishConnections({ revision: entry.revision });
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
  const undoHistories = new WeakMap<
    PersistedThinkingMap,
    Array<{ ledger: string; receipts: string[] }>
  >();
  const mapOf = (topic: LocalTopic): PersistedThinkingMap => {
    const unread = new Set(
      (topic.panel?.nodes || []).filter(node => node.unread).map(node => node.id),
    );
    const derived = deriveCaches(parseLedger(topic.ledger), topic.id, unread);
    const map: PersistedThinkingMap = {
      nodes: derived.nodes,
      edges: derived.edges,
      doc: derived.doc,
      ledger: topic.ledger,
      raw: topic.raw,
      watermarks: topic.panel?.watermarks || {},
    };
    remoteVersions.set(map, topic.revision);
    undoHistories.set(
      map,
      (topic.undo || []).map(step => ({
        ledger: step.ledger ?? topic.ledger.slice(0, step.ledgerLength),
        receipts: [step.id],
      })),
    );
    return map;
  };
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
  const cachePending = (id: string, map: PersistedThinkingMap) => {
    const old = readCache(id);
    const entry = {
      map,
      base:
        old?.base ??
        (old && !old.pending
          ? { ledger: old.map.ledger || '', raw: old.map.raw || '' }
          : undefined),
      revision: old?.revision ?? 1,
      serial: ++serial,
      pending: true,
    };
    writeCache(id, entry);
    return entry;
  };
  /**
   * Gives edits appended to `base` their own session. A merge orders lines by
   * session, so without it an edit continuing an older session would land before
   * a server result it was made after.
   */
  const ownSession = (base: string, ledger: string) => {
    const appended = ledger.slice(base.length).replace(/^\n+/, '');
    if (!appended || appended.startsWith('[场次 ')) return ledger;
    return `${base.replace(/\n+$/, '')}\n${sessionLine(Date.now(), '本地', '手动')}\n${appended}`;
  };
  /**
   * After a save conflict, moves the pending edits onto the server's version when
   * that is safe. Returns the rebased entry, or null when the edits need review.
   */
  const rebaseOnServer = async (id: string): Promise<CachedMap | null> => {
    const remote = (await request<TopicSnapshot>(`/api/topics/${encodeURIComponent(id)}/snapshot`))
      .topic;
    const latest = readCache(id)!;
    const base = latest.base;
    let merged;
    if (
      base &&
      remote.appendRevision === remote.revision &&
      remote.ledger.startsWith(base.ledger) &&
      (latest.map.ledger || '').startsWith(base.ledger)
    ) {
      // Both sides append operations to the accepted version. Keep the
      // server's lines first and the user's later operations last; remap new IDs.
      const ledger = ownSession(base.ledger, latest.map.ledger || '');
      merged = mergeLedgerPair(remote, { ...latest.map, ledger });
    } else if (remote.ledger === latest.map.ledger && isEditedSourceLog(latest.map.raw ?? '')) {
      merged = { ledger: remote.ledger, raw: mergeSourceLogs(latest.map.raw ?? '', remote.raw) };
    } else return null; // Destructive/ambiguous edits still require review.
    const rebasedMap = mapOf({ ...remote, ...merged });
    const entry = {
      ...latest,
      base: { ledger: remote.ledger, raw: remote.raw },
      revision: remote.revision,
      map: { ...rebasedMap, watermarks: { ...rebasedMap.watermarks, ...latest.map.watermarks } },
      pending: true,
    };
    writeCache(id, entry);
    return entry;
  };
  /** Runs `job` after this topic's earlier saves; later saves wait for it. */
  const inSaveQueue = (id: string, job: () => Promise<PersistedThinkingMap | null>) => {
    const queued = (saveQueues.get(id) || Promise.resolve(null)).catch(() => null).then(job);
    saveQueues.set(id, queued);
    void queued
      .finally(() => {
        if (saveQueues.get(id) === queued) saveQueues.delete(id);
      })
      .catch(() => {});
    return queued;
  };
  const save: ThinkingMapRuntime['persistence']['save'] = (id, map) => {
    cachePending(id, map);
    return inSaveQueue(id, async () => {
      await pendingCreates.get(id)?.promise;
      let entry = readCache(id);
      if (!entry?.pending) return null;
      let rebased = false;
      for (let attempt = 0; ; attempt++) {
        try {
          const saved = await request<{ revision: number }>(
            `/api/topics/${encodeURIComponent(id)}/state`,
            { baseRevision: entry.revision, map: entry.map },
          );
          const latest = readCache(id)!;
          failedSaves.delete(id);
          writeCache(id, {
            ...latest,
            base: { ledger: entry.map.ledger || '', raw: entry.map.raw || '' },
            revision: Math.max(latest.revision, saved.revision),
            pending: latest.serial !== entry.serial,
          });
          if (rebased && latest.serial === entry.serial) {
            remoteVersions.set(entry.map, saved.revision);
            return entry.map;
          }
          return null;
        } catch (error) {
          if (!(error instanceof LocalApiError) || error.status !== 409 || attempt >= 2)
            throw error;
          entry = await rebaseOnServer(id);
          if (!entry) throw error;
          rebased = true;
        }
      }
    }).catch(error => {
      failedSaves.add(id);
      publishService();
      throw error;
    });
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
      const connections = await request<ChatConnection[]>(
        `/api/connections?topicId=${encodeURIComponent(id)}`,
      );
      if (!disposed && snapshot.currentProjectId === id && epoch === connectionEpoch)
        publishConnections({
          topicId: id,
          revision: readCache(id)?.revision ?? null,
          connections: connections.filter(item => !disconnecting.has(item.id)),
          status: 'ready',
          error: '',
        });
      return connections;
    } catch (error) {
      if (!disposed && snapshot.currentProjectId === id && epoch === connectionEpoch)
        publishConnections({ status: 'error', error: messageOf(error) });
      throw error;
    }
  }
  async function refreshReceipt(id = snapshot.currentProjectId) {
    if (disposed) return null;
    if (!id) return null;
    const epoch = ++receiptEpoch;
    if (snapshot.currentProjectId === id) publishReceipt({ topicId: id, loading: true, error: '' });
    try {
      await pendingCreates.get(id)?.promise;
      const result = await request<{
        topicId: string;
        currentRevision: number;
        receipt: UpdateReceipt | null;
      }>(`/api/topics/${encodeURIComponent(id)}/update-receipt`);
      if (!disposed && snapshot.currentProjectId === id && epoch === receiptEpoch)
        publishReceipt({ ...result, loading: false, error: '' });
      return result;
    } catch (error) {
      if (!disposed && snapshot.currentProjectId === id && epoch === receiptEpoch)
        publishReceipt({ loading: false, error: messageOf(error) });
      return null; // Receipt failure must not change a successfully completed update into a failed update.
    }
  }
  function rollbackBlocked() {
    const id = snapshot.currentProjectId,
      state = store.getState();
    if (!id || state.boundProjectId !== id || state.isHydrating) return t('请等当前脉络读取完成。');
    if (
      state.docDraft !== null ||
      state.sourceDraftActive ||
      state.editingNodeId !== null ||
      state.editingNodeBodyId !== null ||
      state.editingEdgeId !== null
    )
      return t('请先完成或取消当前编辑，再退回更新。');
    if (readCache(id)?.pending || saveQueues.has(id) || failedSaves.has(id))
      return t('请等当前修改保存完成，再退回更新。');
    if (
      chatUpdate ||
      activeTasks.size ||
      state.isGenerating ||
      state.isTidying ||
      state.isRefining ||
      state.isCondensing
    )
      return t('请等当前操作完成后再退回更新。');
    return null;
  }
  async function rollbackUpdate() {
    if (receiptSnapshot.rollingBack) return;
    const id = snapshot.currentProjectId,
      receipt = receiptSnapshot.topicId === id ? receiptSnapshot.receipt : null;
    const blocked = rollbackBlocked();
    if (!id || !receipt) return;
    if (blocked || !receipt.canRollback) {
      publishReceipt({
        error: blocked || receipt.rollbackBlockedReason || t('当前内容已改变，不能整次退回。'),
      });
      return;
    }
    publishReceipt({ rollingBack: true, error: '' });
    try {
      // Use the displayed version. A stale tab must not silently agree to overwrite a newer revision.
      const baseRevision = readCache(id)?.revision;
      if (baseRevision === undefined) throw new Error(t('脉络尚未读取，请重新打开后处理。'));
      await request(`/api/topics/${encodeURIComponent(id)}/rollback-update`, {
        baseRevision,
        receiptId: receipt.id,
      });
      if (!disposed && snapshot.currentProjectId === id) {
        // syncFromRemote preserves any draft started while the request was in flight.
        await store.getState().syncFromRemote();
        await refreshReceipt(id);
        publishConnections({ operation: null });
      }
    } catch (error) {
      if (!disposed && snapshot.currentProjectId === id) {
        await refreshReceipt(id);
        publishReceipt({ error: messageOf(error) });
      }
    } finally {
      if (!disposed && receiptSnapshot.topicId === id) publishReceipt({ rollingBack: false });
    }
  }
  async function rollbackOperation(receiptId: string, baseRevision: number) {
    const blocked = rollbackBlocked(),
      id = snapshot.currentProjectId;
    if (blocked || !id || receiptSnapshot.rollingBack)
      throw new Error(blocked || t('请等当前操作完成后再退回更新。'));
    publishReceipt({ rollingBack: true, error: '' });
    try {
      await request(`/api/topics/${encodeURIComponent(id)}/rollback-operation`, {
        baseRevision,
        receiptId,
      });
      if (!disposed && snapshot.currentProjectId === id) {
        await store.getState().syncFromRemote();
        await refreshReceipt(id);
      }
    } finally {
      if (!disposed && receiptSnapshot.topicId === id) publishReceipt({ rollingBack: false });
    }
  }
  function cancelChatUpdate() {
    if (!chatUpdate) return;
    if (connectionSnapshot.topicId === chatUpdate.topicId)
      publishConnections({
        operation: {
          ...connectionSnapshot.operation,
          phase: 'cancelling',
          message: t('正在取消…'),
        },
      });
    chatUpdate.controller.abort(); // Also cancels the batch task being followed.
  }
  /** Asks for material to type in and runs it as a manual update. */
  async function updateFromTypedInput(id: string, signal?: AbortSignal) {
    const input = await options.onRequestUpdate();
    if (input?.trim() && snapshot.currentProjectId === id && !signal?.aborted)
      await generateManual(id, input);
  }
  /**
   * The connected sessions an update reads, asking the person to connect one when
   * there are none. Null when they cancel or choose to type material in instead.
   */
  async function connectionsToRead(id: string, signal: AbortSignal): Promise<string[] | null> {
    const stillCurrent = () => {
      if (signal.aborted || snapshot.currentProjectId !== id) throw abortError();
    };
    const connections = await refreshConnections(id);
    stillCurrent();
    if (connections.length) return connections.map(connection => connection.id);
    publishConnections({ operation: { phase: 'choosing', message: t('请选择要连接的会话。') } });
    const source = await options.onRequestSource!(id, connections);
    stillCurrent();
    if (source && !('manual' in source)) return [source.connectionId];
    publishConnections({ operation: null });
    if (source) await updateFromTypedInput(id, signal);
    return null;
  }
  async function updateFromChat(
    id: string,
    connectionId: string,
    operation: NonNullable<typeof chatUpdate>,
  ) {
    const signal = operation.controller.signal;
    const current = () =>
      !disposed && chatUpdate === operation && snapshot.currentProjectId === id && !signal.aborted;
    if (!current()) throw abortError();
    const sourceProgress = () =>
      t('会话 {current}/{total}', { current: operation.sourceIndex, total: operation.sourceCount });
    store.getState().flushDocEdits();
    store.getState().flushDoc();
    await flushPending(id);
    if (!current()) throw abortError();
    let until: unknown,
      batch = 0;
    for (;;) {
      if (!current()) throw abortError();
      if (batch > 0 && (store.getState().docDraft !== null || readCache(id)?.pending))
        throw new Error(t('已保留完成的批次。请先保存当前编辑，再继续更新。'));
      publishConnections({
        operation: { phase: 'reading', message: `${sourceProgress()} · ${t('正在读取新材料…')}` },
      });
      // Keep the short enqueue request alive until we have the task ID for cancellation.
      const response = await request<{
        task?: { id: string };
        unchanged?: boolean;
        message?: string;
        hasMore?: boolean;
        until?: unknown;
        messageCount?: number;
        stage?: 'distill' | 'publish';
      }>(`/api/topics/${encodeURIComponent(id)}/update-from-chat`, {
        connectionId,
        continuous: true,
        ...(until === undefined ? {} : { until }),
      });
      until = response.until ?? until;
      batch++;
      const progress = () => `${sourceProgress()} · ${t('第 {batch} 批', { batch })}`;
      const activity = response.stage === 'distill' ? '正在分批整理历史材料' : '正在更新图文';
      const taskId = response.task?.id;
      if (!taskId) {
        if (!current()) throw abortError();
        if (!response.unchanged)
          throw new Error(t(response.message || '读取会话后没有返回可追踪的任务。'));
        await refreshConnections(id);
        return { hasMore: response.hasMore, processed: batch > 1 };
      }
      const running = (status = 'running') =>
        current() &&
        publishConnections({
          operation: {
            phase: 'running',
            message: `${progress()} · ${t(activity)}${['pending', 'queued'].includes(status) ? t('（等待 Agent）') : '…'}`,
            taskId,
          },
        });
      running();
      await followTask(
        taskId,
        { signal },
        { onStatus: running, failure: '更新失败，原内容已保留。' },
      );
      if (!current()) throw abortError();
      // The task ID is its receipt: undoing this update rolls it back on the server.
      await store.getState().syncFromRemote({ undoGroup: operation.undoGroup, receiptId: taskId });
      if (!current()) throw abortError();
      await refreshConnections(id);
      await refreshReceipt(id);
      if (!response.hasMore || until === undefined)
        return { hasMore: response.hasMore, processed: true };
    }
  }
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
      cancelChatUpdate();
      chatUpdate = null;
      connectionEpoch++;
      state.resetLocal();
      cache.delete(current);
      storage.remove(keyOf(current));
      storage.remove('gft-local:selected');
      publish({ currentProjectId: null });
      publishConnections({
        topicId: null,
        revision: null,
        connections: [],
        status: 'ready',
        error: '',
        operation: null,
      });
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
  /** Manual material runs as a server update; the server keeps the text in the Log itself. */
  async function generateManual(id: string, input: string) {
    if (input.length > DIRECT_INPUT_LIMIT) {
      store.getState().flushDocEdits();
      store.getState().flushDoc();
      await flushPending(id);
      const { addMaterial } = await import('./Materials');
      publishConnections({ operation: { phase: 'reading', message: t('正在保存材料…') } });
      await addMaterial(new File([input], `pasted-${Date.now()}.txt`, { type: 'text/plain' }), id);
      if (!disposed && snapshot.currentProjectId === id)
        publishConnections({
          operation: {
            phase: 'completed',
            message: t('材料已保存，正在分批整理；可在导入进度中暂停或继续。'),
          },
        });
      return;
    }
    if (snapshot.currentProjectId === id) await store.getState().generate(input);
  }
  async function requestManualUpdate() {
    const id = snapshot.currentProjectId;
    if (!id) return;
    const state = store.getState();
    if (
      chatUpdate ||
      state.isGenerating ||
      state.isTidying ||
      state.isRefining ||
      state.isHydrating
    ) {
      options.onError(t('请等当前操作完成后再更新。'));
      return;
    }
    try {
      const input = await options.onRequestUpdate();
      if (input?.trim() && snapshot.currentProjectId === id && !disposed)
        await generateManual(id, input);
    } catch (error) {
      options.onError(messageOf(error));
    }
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
        serial: ++serial,
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
          cache.delete(id);
          storage.remove(keyOf(id));
          publish({ projects: snapshot.projects.filter(project => project.id !== id) });
          if (snapshot.currentProjectId === id) {
            store.getState().resetLocal();
            publish({ currentProjectId: null });
            publishConnections({
              topicId: null,
              revision: null,
              connections: [],
              status: 'ready',
              error: '',
              operation: null,
            });
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
      cancelChatUpdate();
      chatUpdate = null;
      connectionEpoch++;
      receiptEpoch++;
      publishReceipt({
        topicId: id,
        currentRevision: null,
        receipt: null,
        loading: true,
        rollingBack: false,
        error: '',
      });
      publishConnections({
        topicId: id,
        revision: readCache(id)?.revision ?? null,
        connections: [],
        status: options.onRequestSource ? 'loading' : 'ready',
        error: '',
        operation:
          storage.get(`gft-local:unfinished-update:${id}`) === 'true'
            ? {
                phase: 'completed',
                message: t('上次更新尚未全部完成，点更新继续读取剩余材料。'),
                hasMore: true,
              }
            : null,
      });
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
          cancelChatUpdate();
          chatUpdate = null;
          connectionEpoch++;
          store.getState().resetLocal();
          publishConnections({
            topicId: null,
            revision: null,
            connections: [],
            status: 'ready',
            error: '',
            operation: null,
          });
          publish({ currentProjectId: null });
          if (snapshot.projects[0]) await host.switchProject(snapshot.projects[0].id);
        }
      } catch (error) {
        options.onError(messageOf(error));
      }
    },
    ensureCanGenerate: () => true,
    fetchSourceBatches: sources,
    async requestUpdate() {
      const id = snapshot.currentProjectId;
      if (!id) {
        options.onError(t('请先创建或选择一个脉络。'));
        return;
      }
      if (chatUpdate) return;
      const state = store.getState();
      if (state.isGenerating || state.isTidying || state.isRefining || state.isHydrating) {
        options.onError(t('请等当前操作完成后再更新。'));
        return;
      }
      if (!options.onRequestSource) {
        try {
          await updateFromTypedInput(id);
        } catch (error) {
          options.onError(messageOf(error));
        }
        return;
      }
      const operation = {
        topicId: id,
        undoGroup: `chat-update-${++updateSequence}`,
        controller: new AbortController(),
        sourceIndex: 0,
        sourceCount: 0,
      };
      chatUpdate = operation;
      publishConnections({ operation: { phase: 'reading', message: t('正在读取连接…') } });
      try {
        const connectionIds = await connectionsToRead(id, operation.controller.signal);
        if (!connectionIds) return;
        storage.set(`gft-local:unfinished-update:${id}`, 'true');
        store.getState().flushDocEdits();
        store.getState().flushDoc();
        await flushPending(id);
        const before = store.getState();
        operation.sourceCount = connectionIds.length;
        let hasMore = false,
          processed = false;
        for (const connectionId of connectionIds) {
          operation.sourceIndex++;
          const result = await updateFromChat(id, connectionId, operation);
          hasMore ||= !!result.hasMore;
          processed ||= result.processed;
        }
        if (operation.controller.signal.aborted || snapshot.currentProjectId !== id || disposed)
          throw abortError();
        const after = store.getState();
        storage.set(`gft-local:unfinished-update:${id}`, String(hasMore));
        const changed = before.ledger !== after.ledger;
        const message =
          changeSummary(before, after) ||
          t(changed ? '图文已更新' : processed ? '本次图文没有变化' : '已连接会话没有新增材料。');
        publishConnections({
          operation: {
            phase: 'completed',
            message: hasMore ? `${message} · ${t('还有材料可继续更新')}` : message,
            hasMore,
            undoGroup: changed ? operation.undoGroup : undefined,
          },
        });
      } catch (error) {
        if (chatUpdate === operation && snapshot.currentProjectId === id && !disposed)
          publishConnections({
            operation: {
              phase:
                operation.controller.signal.aborted ||
                (error instanceof DOMException && error.name === 'AbortError')
                  ? 'cancelled'
                  : 'failed',
              message: messageOf(error),
              undoGroup: operation.undoGroup,
            },
          });
      } finally {
        if (chatUpdate === operation) chatUpdate = null;
      }
    },
  };
  type TaskState = { status: string; error?: string; report?: Record<string, number | boolean> };
  /**
   * Polls a queued task until it ends; aborting `context` cancels it on the server.
   * `onStatus` sees each unfinished status; `failure` is the message when the task gives none.
   */
  function followTask(
    taskId: string,
    context: Pick<MapComputeContext, 'signal'>,
    options: { onStatus?: (status: string) => void; failure?: string } = {},
  ): Promise<TaskState> {
    const current = taskFollowers.get(taskId);
    if (current) return current;
    const following = pollTask(taskId, context, options).finally(() =>
      taskFollowers.delete(taskId),
    );
    taskFollowers.set(taskId, following);
    return following;
  }
  async function pollTask(
    taskId: string,
    context: Pick<MapComputeContext, 'signal'>,
    {
      onStatus,
      failure = '本地模型执行失败。',
    }: { onStatus?: (status: string) => void; failure?: string } = {},
  ): Promise<TaskState> {
    let cancellation: Promise<void> | undefined;
    let failures = 0;
    const cancel = () => {
      if (disposed) return Promise.resolve();
      rememberSettled(taskId);
      return (cancellation ||= request(
        `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
        {},
        undefined,
        true,
      ).then(
        () => {},
        () => {},
      ));
    };
    activeTasks.set(taskId, cancel);
    context.signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        if (context.signal.aborted || disposed) throw abortError();
        let state: TaskState;
        try {
          state = await request<TaskState>(
            `/api/tasks/${encodeURIComponent(taskId)}/status`,
            undefined,
            context.signal,
          );
        } catch (error) {
          if (
            !context.signal.aborted &&
            !disposed &&
            (error instanceof LocalConnectionError ||
              (error instanceof LocalApiError && error.status >= 500))
          ) {
            await pause(context.signal, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
            continue;
          }
          throw error;
        }
        if (context.signal.aborted || disposed) throw abortError();
        failures = 0;
        if (['completed', 'failed', 'cancelled'].includes(state.status)) rememberSettled(taskId);
        if (state.status === 'completed') return state;
        if (state.status === 'failed') throw new Error(t(state.error || failure));
        if (state.status === 'cancelled') throw abortError();
        onStatus?.(state.status);
        await pause(context.signal);
      }
    } catch (error) {
      if (context.signal.aborted && !disposed) void cancel();
      throw error;
    } finally {
      context.signal.removeEventListener('abort', cancel);
      activeTasks.delete(taskId);
    }
  }

  /** Saves pending edits so a model task starts from what the person sees. */
  async function settleBeforeTask(id: string | null, context: MapComputeContext, redraw = false) {
    if (!id) throw new Error(t('请先选择脉络。'));
    if (context.signal.aborted || disposed) throw abortError();
    store.getState().flushDoc(); // Drain the shared debounce before pinning a model task to a revision.
    await flushPending(id);
    if (redraw) await sourceQueues.get(id);
    if (context.signal.aborted || disposed) throw abortError();
    return id;
  }

  async function compute(
    action: 'update' | 'redraw' | 'tidy' | 'refine' | 'theme' | 'relation',
    system: string,
    user: string,
    context: MapComputeContext,
  ) {
    const id = await settleBeforeTask(context.projectId, context, action === 'redraw');
    const revision = readCache(id)?.revision;
    if (revision === undefined) throw new Error(t('脉络尚未读取，请重新打开后处理。'));
    // Do not abort the short queue request before receiving its task ID; otherwise
    // a cancel could leave a task running without a handle to stop it.
    const task = await request<{ id: string }>(`/api/topics/${encodeURIComponent(id)}/compute`, {
      baseRevision: revision,
      request: { action, system, user, ...(context.revalidateResult ? { concurrent: true } : {}) },
    });
    await followTask(task.id, context);
    return (
      await request<{ output: string }>(`/api/tasks/${task.id}/result`, undefined, context.signal)
    ).output;
  }

  function operationTask(operation: MapOperationRequest) {
    switch (operation.kind) {
      case 'update':
        return { action: 'update', input: operation.input, origin: 'manual' };
      case 'redraw':
        return { action: 'redraw' };
      case 'tidy':
        return {
          action: 'tidy',
          params: { scopeIds: operation.scopeIds, unreadIds: operation.unreadIds },
        };
      case 'refine':
        return { action: 'refine', params: { nodeId: operation.nodeId } };
      case 'relation':
        return { action: 'relation', params: { from: operation.from, to: operation.to } };
    }
  }

  /** Runs a model operation as a server task; the server writes the result and its receipt. */
  async function runOperation(
    projectId: string,
    operation: MapOperationRequest,
    context: MapComputeContext,
  ): Promise<MapOperationOutcome> {
    if (context.taskId) {
      const state = await followTask(context.taskId, context);
      void refreshReceipt(projectId);
      return { taskId: context.taskId, ...(state.report ? { report: state.report } : {}) };
    }
    const id = await settleBeforeTask(projectId, context, operation.kind === 'redraw');
    const task = await request<{ id: string }>(
      `/api/topics/${encodeURIComponent(id)}/tasks`,
      operationTask(operation),
    );
    const state = await followTask(task.id, context);
    void refreshReceipt(id);
    return { taskId: task.id, ...(state.report ? { report: state.report } : {}) };
  }

  type OperationList = {
    currentRevision: number;
    operations: { id: string; rolledBackAt?: string }[];
  };
  /**
   * Rolls back server operations by receipt, newest first; an operation that
   * changed nothing has no receipt to roll back. It runs in the save queue: a save
   * made before it (an undone hand edit) lands first, and later saves are based on
   * the rolled-back revision.
   */
  function rollbackOperations(projectId: string, receiptIds: string[], targetLedger?: string) {
    const topic = encodeURIComponent(projectId);
    const rollback = async (receiptId: string) => {
      const list = await request<OperationList>(`/api/topics/${topic}/operations`);
      const receipt = list.operations.find(item => item.id === receiptId);
      if (!receipt || receipt.rolledBackAt) return;
      await request(`/api/topics/${topic}/rollback-operation`, {
        baseRevision: list.currentRevision,
        receiptId,
      });
    };
    return inSaveQueue(projectId, async () => {
      try {
        if (targetLedger !== undefined) {
          const current = (await request<TopicSnapshot>(`/api/topics/${topic}/snapshot`)).topic;
          const identity = (ledger: string) => {
            const view = deriveCaches(parseLedger(ledger), projectId, new Set());
            return JSON.stringify({
              doc: view.doc,
              nodes: view.nodes.map(({ id, title, body }) => ({ id, title, body })),
              edges: view.edges.map(({ from, to, reason }) => ({ from, to, reason })),
            });
          };
          const history = current.undo || [];
          const target = identity(targetLedger);
          const index = history.findIndex(
            step => identity(step.ledger ?? current.ledger.slice(0, step.ledgerLength)) === target,
          );
          if (index >= 0) receiptIds = history.slice(index).map(step => step.id);
          else if (identity(current.ledger) !== target) {
            // Several local edits can share one debounced save. Preserve the
            // existing finer-grained local undo when there is no receipt boundary.
            await request(`/api/topics/${topic}/state`, {
              baseRevision: current.revision,
              map: mapOf({ ...current, ledger: targetLedger }),
            });
          }
        }
        for (const receiptId of [...receiptIds].reverse()) await rollback(receiptId);
      } finally {
        const remote = (await request<TopicSnapshot>(`/api/topics/${topic}/snapshot`)).topic;
        const latest = readCache(projectId);
        if (latest)
          writeCache(projectId, {
            ...latest,
            base: { ledger: remote.ledger, raw: remote.raw },
            revision: remote.revision,
          });
        void refreshReceipt(projectId);
      }
      return null;
    }).then(() => {});
  }

  const runtime: ThinkingMapRuntime = {
    host,
    operations: {
      run: runOperation,
      rollback: rollbackOperations,
      rollbackTo: (id, ledger) => rollbackOperations(id, [], ledger),
      history: map => undoHistories.get(map) || [],
    },
    persistence: {
      // Empty raw is valid for file-backed topics. Do not manufacture a Log
      // from generated output or autosave a fake legacy migration on reload.
      migrateLegacySources: false,
      load,
      loadCached: id => readCache(id)?.map || null,
      save,
      cachePending,
      hasPending: id => readCache(id)?.pending === true,
      hasRemoteChanges: (id, map) => remoteVersions.get(map) !== readCache(id)?.revision,
      accept(id, remote, applied = remote) {
        const revision = remoteVersions.get(remote);
        if (revision === undefined) return;
        const old = readCache(id);
        writeCache(id, {
          map: applied,
          base: { ledger: remote.ledger || '', raw: remote.raw || '' },
          revision,
          pending: old?.pending || false,
          serial: ++serial,
        });
      },
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
    ai: {
      async explainRelation(from, to, reason, context) {
        const request = buildRelationExplanationRequest(from, to, reason);
        for (let attempt = 0; attempt < 2; attempt++) {
          const raw = await compute('relation', request.system, request.user, context);
          try {
            return parseRelationExplanation(raw, from.id, to.id);
          } catch (error) {
            if (!(error instanceof RelationReasonLengthError) || attempt === 1) throw error;
            request.system +=
              '\n\nThe previous caption exceeded the 32-character limit. Rewrite the bridge as one short caption (aim for 16-24 characters), preserve necessary conditions, and return only the requested edge.';
          }
        }
        throw new Error('Relationship caption was not produced.');
      },
      async generate(input, settings, _onPreview, context) {
        const request = buildGenerateRequest(input, settings);
        const raw = await compute(
          settings?.rewrite ? 'redraw' : 'update',
          request.system,
          request.user,
          context,
        );
        return parseGenerateResponse(raw, settings);
      },
      async tidy(input, _settings, context) {
        if (input.scopeIds?.length === 0) return [];
        const call = tidyCall(input);
        return call.parse(await compute('tidy', call.system, call.user, context));
      },
      async refine(target, neighbors, birth, chat, _settings, context) {
        return parseRefineTags(
          await compute(
            'refine',
            buildRefinePrompt(target, neighbors.up, neighbors.down, birth, chat),
            '请按规则润色目标节点。',
            context,
          ),
        );
      },
    },
  };
  const store = createThinkingMapStore(runtime);
  async function recoverTasks() {
    const id = snapshot.currentProjectId;
    if (!id || disposed) return;
    const tasks = await request<
      Array<{
        id: string;
        topicId: string;
        status: string;
        action: string;
        mode?: string;
        params?: { nodeId?: string; from?: string; to?: string; scopeIds?: string[] };
      }>
    >('/api/tasks');
    if (disposed || snapshot.currentProjectId !== id) return;
    for (const task of tasks) {
      if (
        task.topicId !== id ||
        activeTasks.has(task.id) ||
        settledTasks.has(task.id) ||
        !['pending', 'running'].includes(task.status) ||
        task.mode === 'compute'
      )
        continue;
      const p = task.params;
      const op: MapOperationRequest | null =
        task.action === 'refine' && p?.nodeId
          ? { kind: 'refine', nodeId: p.nodeId }
          : task.action === 'relation' && p?.from && p?.to
            ? { kind: 'relation', from: p.from, to: p.to }
            : task.action === 'tidy'
              ? { kind: 'tidy', scopeIds: p?.scopeIds }
              : task.action === 'redraw'
                ? { kind: 'redraw' }
                : task.action === 'update'
                  ? { kind: 'update', input: '' }
                  : null;
      if (op) void store.getState().attachServerTask(task.id, op);
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
    } else if (!chatUpdate) await store.getState().syncFromRemote();
    if (!disposed && reconnecting && existingProject) await recoverTasks();
    if (!disposed && options.onRequestSource) await refreshConnections();
    if (!disposed) await refreshReceipt();
  });
  function publishService() {
    const next = {
      ...monitor.getSnapshot(),
      pending:
        !!snapshot.currentProjectId && readCache(snapshot.currentProjectId)?.pending === true,
      saveFailed: !!snapshot.currentProjectId && failedSaves.has(snapshot.currentProjectId),
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
    cancelChatUpdate();
    connectionEpoch++;
    receiptEpoch++;
    store.getState().cancelGeneration();
    store.getState().cancelTidy();
    for (const cancel of activeTasks.values()) void cancel();
    store.getState().flushDocEdits();
    store.getState().flushDoc();
    store.getState().resetLocal(); // Includes an in-flight node refinement and invalidates late responses.
    listeners.clear();
    connectionListeners.clear();
    receiptListeners.clear();
    serviceListeners.clear();
    // Submitted writes keep their ordering. Hosts/tests that replace the runtime
    // can wait for these finite writes without waiting for background AI work.
    return Promise.allSettled([...saveQueues.values(), ...taskFollowers.values()]);
  };
  return {
    store,
    host,
    refreshProjects,
    dispose,
    requestManualUpdate,
    editScope,
    request,
    service: {
      getSnapshot: () => serviceSnapshot,
      subscribe(listener: () => void) {
        serviceListeners.add(listener);
        return () => {
          serviceListeners.delete(listener);
        };
      },
      retry: monitor.retry,
      async savePending() {
        const id = snapshot.currentProjectId;
        if (!id) return;
        // This is an explicit user retry, never part of the reconnect loop.
        store.getState().flushDocEdits();
        store.getState().flushDoc();
        await saveQueues.get(id)?.catch(() => null);
        const entry = readCache(id);
        if (entry?.pending && failedSaves.has(id)) {
          const remote = (
            await request<TopicSnapshot>(`/api/topics/${encodeURIComponent(id)}/snapshot`)
          ).topic;
          const unread = (map?: PersistedThinkingMap) =>
            (map?.nodes || [])
              .filter(node => node.unread)
              .map(node => node.id)
              .sort()
              .join('\n');
          // The write may have committed before its response was lost. Confirm it
          // through a read before offering another write to the same revision.
          if (
            readCache(id)?.serial === entry.serial &&
            remote.ledger === (entry.map.ledger || '') &&
            remote.raw === (entry.map.raw || '') &&
            JSON.stringify(remote.panel?.watermarks || {}) ===
              JSON.stringify(entry.map.watermarks || {}) &&
            unread(remote.panel) === unread(entry.map)
          ) {
            failedSaves.delete(id);
            writeCache(id, {
              ...entry,
              revision: remote.revision,
              pending: false,
              base: { ledger: remote.ledger, raw: remote.raw },
            });
            store.setState({ error: null });
            return;
          }
        }
        await flushPending(id);
        store.setState({ error: null });
      },
    },
    receipts: {
      getSnapshot: () => receiptSnapshot,
      subscribe(listener: () => void) {
        receiptListeners.add(listener);
        return () => {
          receiptListeners.delete(listener);
        };
      },
      refresh: refreshReceipt,
      rollback: rollbackUpdate,
      rollbackOperation,
      rollbackBlocked,
    },
    connections: {
      getSnapshot: () => connectionSnapshot,
      subscribe(listener: () => void) {
        connectionListeners.add(listener);
        return () => {
          connectionListeners.delete(listener);
        };
      },
      refresh: refreshConnections,
      cancel: cancelChatUpdate,
      dismiss() {
        if (!chatUpdate) publishConnections({ operation: null });
      },
      undo() {
        const operation = connectionSnapshot.operation;
        if (
          rollbackBlocked() ||
          !operation?.undoGroup ||
          !store.getState().canUndoGroup(operation.undoGroup)
        )
          return;
        store.getState().undo();
        publishConnections({ operation: { phase: 'completed', message: t('已撤销更新') } });
      },
      async connect(source: ChatSession, topicIds: string[], history: 'now' | 'all') {
        const result = await request<ChatConnection[]>('/api/connections/connect', {
          source,
          topicIds,
          history,
        });
        await refreshConnections();
        return result;
      },
      async disconnect(connectionId: string) {
        disconnecting.add(connectionId);
        publishConnections({
          connections: connectionSnapshot.connections.filter(item => item.id !== connectionId),
        });
        try {
          await request('/api/connections/disconnect', { connectionId });
        } finally {
          disconnecting.delete(connectionId);
          await refreshConnections();
        }
      },
      async disconnectAll(topicId: string) {
        const connections = await refreshConnections(topicId);
        await Promise.all(
          connections.map(connection =>
            request('/api/connections/disconnect', { connectionId: connection.id }),
          ),
        );
        await refreshConnections(topicId);
      },
    },
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
