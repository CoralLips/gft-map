import { DIRECT_INPUT_LIMIT } from '../../limits.mjs';
import { t } from '../../../../src/i18n';
import { MAP_VIEW_DETACHED } from '../../../../src/store/thinkingMap/runtime';
import type {
  OperationProgress,
  ThinkingMapStore,
} from '../../../../src/store/thinkingMap/runtime';
import type { PersistedThinkingMap } from '../../../../src/type/thinkingMap';
import { abortError, messageOf, storage, type Request } from './api';
import type { MapCache } from './mapCache';
import type { Tasks, TaskRecord } from './tasks';
import type { ChatConnection, ChatSession, ConnectionSnapshot, LocalRuntimeOptions } from './types';

export type Updates = ReturnType<typeof createUpdates>;
type ChatUpdate = {
  topicId: string;
  undoGroup: string;
  controller: AbortController;
  sourceIndex: number;
  sourceCount: number;
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
/** A chat update that ended early: cancelled by the person, or failed. */
const updateEnded = (operation: ChatUpdate, error: unknown) => ({
  phase:
    operation.controller.signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError')
      ? ('cancelled' as const)
      : ('failed' as const),
  message: messageOf(error),
  undoGroup: operation.undoGroup,
});
const unfinishedKey = (id: string) => `gft-local:unfinished-update:${id}`;

/**
 * Updating the open map: from its connected chat sessions, batch by batch, or from
 * material the person types in; and the chat connections themselves.
 */
export function createUpdates({
  request,
  store,
  maps,
  options,
  tasks,
  isDisposed,
  currentProjectId,
  waitForCreate,
  refreshReceipt,
  rollbackBlocked,
}: {
  request: Request;
  store(): ThinkingMapStore;
  maps: MapCache;
  options: LocalRuntimeOptions;
  tasks(): Tasks;
  isDisposed(): boolean;
  currentProjectId(): string | null;
  waitForCreate(id: string): Promise<unknown> | undefined;
  refreshReceipt(id: string): Promise<unknown>;
  rollbackBlocked(): string | null;
}) {
  const listeners = new Set<() => void>();
  const disconnecting = new Set<string>();
  let snapshot: ConnectionSnapshot = {
    topicId: null,
    revision: null,
    connections: [],
    status: 'ready',
    error: '',
    operation: null,
  };
  // Bumped on every topic change so a late connection list cannot show the wrong map.
  let epoch = 0;
  let sequence = 0;
  let chatUpdate: ChatUpdate | null = null;
  const publish = (change: Partial<ConnectionSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    listeners.forEach(listener => listener());
  };
  const newUpdate = (topicId: string): ChatUpdate => ({
    topicId,
    undoGroup: `chat-update-${++sequence}`,
    controller: new AbortController(),
    sourceIndex: 0,
    sourceCount: 0,
  });

  async function refreshConnections(id = currentProjectId()) {
    if (!id) return [];
    const requested = ++epoch;
    try {
      await waitForCreate(id);
      const connections = await request<ChatConnection[]>(
        `/api/connections?topicId=${encodeURIComponent(id)}`,
      );
      if (!isDisposed() && currentProjectId() === id && requested === epoch)
        publish({
          topicId: id,
          revision: maps.read(id)?.revision ?? null,
          connections: connections.filter(item => !disconnecting.has(item.id)),
          status: 'ready',
          error: '',
        });
      return connections;
    } catch (error) {
      if (!isDisposed() && currentProjectId() === id && requested === epoch)
        publish({ status: 'error', error: messageOf(error) });
      throw error;
    }
  }
  /** Stops following the running chat update; detaching keeps it running on the service. */
  function cancelChatUpdate(detach = false) {
    if (!chatUpdate) return;
    if (snapshot.topicId === chatUpdate.topicId)
      publish({
        operation: {
          ...snapshot.operation,
          phase: 'cancelling',
          message: t('正在取消…'),
        },
      });
    chatUpdate.controller.abort(detach ? MAP_VIEW_DETACHED : undefined);
  }
  /** Manual material runs as a server update; the server keeps the text in the Log itself. */
  async function generateManual(id: string, input: string) {
    if (input.length > DIRECT_INPUT_LIMIT) {
      store().getState().flushDocEdits();
      store().getState().flushDoc();
      await maps.flushPending(id);
      const { addMaterial } = await import('../Materials');
      publish({ operation: { phase: 'reading', message: t('正在保存材料…') } });
      await addMaterial(new File([input], `pasted-${Date.now()}.txt`, { type: 'text/plain' }), id);
      if (!isDisposed() && currentProjectId() === id)
        publish({
          operation: {
            phase: 'completed',
            message: t('材料已保存，正在分批整理；可在导入进度中暂停或继续。'),
          },
        });
      return;
    }
    if (currentProjectId() === id) await store().getState().generate(input);
  }
  /** Asks for material to type in and runs it as a manual update. */
  async function updateFromTypedInput(id: string, signal?: AbortSignal) {
    const input = await options.onRequestUpdate();
    if (input?.trim() && currentProjectId() === id && !signal?.aborted)
      await generateManual(id, input);
  }
  async function requestManualUpdate() {
    const id = currentProjectId();
    if (!id) return;
    const state = store().getState();
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
      if (input?.trim() && currentProjectId() === id && !isDisposed())
        await generateManual(id, input);
    } catch (error) {
      options.onError(messageOf(error));
    }
  }
  /**
   * The connected sessions an update reads, asking the person to connect one when
   * there are none. Null when they cancel or choose to type material in instead.
   */
  async function connectionsToRead(id: string, signal: AbortSignal): Promise<string[] | null> {
    const stillCurrent = () => {
      if (signal.aborted || currentProjectId() !== id) throw abortError();
    };
    const connections = await refreshConnections(id);
    stillCurrent();
    if (connections.length) return connections.map(connection => connection.id);
    publish({ operation: { phase: 'choosing', message: t('请选择要连接的会话。') } });
    const source = await options.onRequestSource!(id, connections);
    stillCurrent();
    if (source && !('manual' in source)) return [source.connectionId];
    publish({ operation: null });
    if (source) await updateFromTypedInput(id, signal);
    return null;
  }
  async function updateFromChat(id: string, connectionId: string, operation: ChatUpdate) {
    const signal = operation.controller.signal;
    const current = () =>
      !isDisposed() && chatUpdate === operation && currentProjectId() === id && !signal.aborted;
    if (!current()) throw abortError();
    const sourceTitle = snapshot.connections.find(item => item.id === connectionId)?.source.title;
    const sourceProgress = () =>
      [
        sourceTitle,
        t('会话 {current}/{total}', {
          current: operation.sourceIndex,
          total: operation.sourceCount,
        }),
      ]
        .filter(Boolean)
        .join(' · ');
    store().getState().flushDocEdits();
    store().getState().flushDoc();
    await maps.flushPending(id);
    if (!current()) throw abortError();
    let until: unknown,
      batch = 0;
    for (;;) {
      if (!current()) throw abortError();
      if (batch > 0 && (store().getState().docDraft !== null || maps.read(id)?.pending))
        throw new Error(t('已保留完成的批次。请先保存当前编辑，再继续更新。'));
      publish({
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
        publish({
          operation: {
            phase: 'running',
            message: `${progress()} · ${t(activity)}${['pending', 'queued'].includes(status) ? t('（等待 Agent）') : '…'}`,
            taskId,
          },
        });
      running();
      await followUpdate(taskId, signal, running);
      if (!current()) throw abortError();
      // The task ID is its receipt: undoing this update rolls it back on the server.
      await store()
        .getState()
        .syncFromRemote({ undoGroup: operation.undoGroup, receiptId: taskId });
      if (!current()) throw abortError();
      await refreshConnections(id);
      await refreshReceipt(id);
      if (!response.hasMore || until === undefined)
        return { hasMore: response.hasMore, processed: true };
    }
  }
  /** Follows an update task, showing on the map the edits it has written so far. */
  async function followUpdate(
    taskId: string,
    signal: AbortSignal,
    onStatus: (status?: string) => unknown,
  ) {
    const show = (actions: OperationProgress[] | null) => store().getState().showProgress(actions);
    show(null);
    try {
      return await tasks().followTask(
        taskId,
        { signal },
        { onStatus, onProgress: show, failure: '更新失败，原内容已保留。' },
      );
    } finally {
      show(null);
    }
  }
  /** Reads every connected session's new messages, batch by batch, into the open map. */
  async function requestUpdate() {
    const id = currentProjectId();
    if (!id) {
      options.onError(t('请先创建或选择一个脉络。'));
      return;
    }
    if (chatUpdate) return;
    const state = store().getState();
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
    const operation = newUpdate(id);
    chatUpdate = operation;
    publish({ operation: { phase: 'reading', message: t('正在读取连接…') } });
    try {
      const connectionIds = await connectionsToRead(id, operation.controller.signal);
      if (!connectionIds) return;
      storage.set(unfinishedKey(id), 'true');
      store().getState().flushDocEdits();
      store().getState().flushDoc();
      await maps.flushPending(id);
      const before = store().getState();
      operation.sourceCount = connectionIds.length;
      let hasMore = false,
        processed = false;
      for (const connectionId of connectionIds) {
        operation.sourceIndex++;
        const result = await updateFromChat(id, connectionId, operation);
        hasMore ||= !!result.hasMore;
        processed ||= result.processed;
      }
      if (operation.controller.signal.aborted || currentProjectId() !== id || isDisposed())
        throw abortError();
      const after = store().getState();
      storage.set(unfinishedKey(id), String(hasMore));
      const changed = before.ledger !== after.ledger;
      const message =
        changeSummary(before, after) ||
        t(changed ? '图文已更新' : processed ? '本次图文没有变化' : '已连接会话没有新增材料。');
      publish({
        operation: {
          phase: 'completed',
          message: hasMore ? `${message} · ${t('还有材料可继续更新')}` : message,
          hasMore,
          undoGroup: changed ? operation.undoGroup : undefined,
        },
      });
    } catch (error) {
      if (chatUpdate === operation && currentProjectId() === id && !isDisposed())
        publish({ operation: updateEnded(operation, error) });
    } finally {
      if (chatUpdate === operation) chatUpdate = null;
    }
  }
  /**
   * Follows a chat update batch that was still running when the page opened. The
   * batches and sessions the previous page had not submitted are not sent again.
   */
  async function recoverChatUpdate(
    task: TaskRecord & { source: NonNullable<TaskRecord['source']> },
  ) {
    if (chatUpdate) return;
    const id = task.topicId;
    const operation = newUpdate(id);
    chatUpdate = operation;
    const current = () =>
      !isDisposed() &&
      chatUpdate === operation &&
      currentProjectId() === id &&
      !operation.controller.signal.aborted;
    const running = (status = 'running') => {
      if (!current()) return;
      publish({
        operation: {
          phase: 'running',
          taskId: task.id,
          message:
            [
              task.source.title,
              t(task.source.stage === 'distill' ? '正在分批整理历史材料' : '正在更新图文'),
            ]
              .filter(Boolean)
              .join(' · ') + (['pending', 'queued'].includes(status) ? t('（等待 Agent）') : '…'),
        },
      });
    };
    storage.set(unfinishedKey(id), 'true');
    running();
    try {
      await followUpdate(task.id, operation.controller.signal, running);
      if (!current()) return;
      await store()
        .getState()
        .syncFromRemote({ undoGroup: operation.undoGroup, receiptId: task.id });
      if (!current()) return;
      await refreshConnections(id);
      await refreshReceipt(id);
      if (!current()) return;
      publish({
        operation: {
          phase: 'completed',
          taskId: task.id,
          undoGroup: operation.undoGroup,
          hasMore: true,
          message: t('本批已完成，点更新检查剩余会话和材料。'),
        },
      });
    } catch (error) {
      if (!isDisposed() && chatUpdate === operation && currentProjectId() === id)
        publish({ operation: updateEnded(operation, error) });
    } finally {
      if (chatUpdate === operation) chatUpdate = null;
    }
  }
  /** Stops showing the current map's chat update; detaching leaves it running. */
  function leave(detach = false) {
    cancelChatUpdate(detach);
    chatUpdate = null;
    epoch++;
  }
  const empty: ConnectionSnapshot = {
    topicId: null,
    revision: null,
    connections: [],
    status: 'ready',
    error: '',
    operation: null,
  };

  return {
    refreshConnections,
    requestUpdate,
    requestManualUpdate,
    recoverChatUpdate,
    leave,
    isRunning: () => chatUpdate !== null,
    snapshot: () => snapshot,
    publish,
    /** Shows `id`'s connections as loading, with a reminder if its last update was cut short. */
    showTopic(id: string) {
      publish({
        topicId: id,
        revision: maps.read(id)?.revision ?? null,
        connections: [],
        status: options.onRequestSource ? 'loading' : 'ready',
        error: '',
        operation:
          storage.get(unfinishedKey(id)) === 'true'
            ? {
                phase: 'completed',
                message: t('上次更新尚未全部完成，点更新继续读取剩余材料。'),
                hasMore: true,
              }
            : null,
      });
    },
    showNone: () => publish(empty),
    /** Keeps the shown revision in step with the saved map. */
    revisionSaved(id: string, revision: number) {
      if (snapshot.topicId === id && snapshot.revision !== revision) publish({ revision });
    },
    dispose() {
      leave(true);
      listeners.clear();
    },
    api: {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      refresh: refreshConnections,
      cancel: () => cancelChatUpdate(),
      dismiss() {
        if (!chatUpdate) publish({ operation: null });
      },
      undo() {
        const operation = snapshot.operation;
        if (
          rollbackBlocked() ||
          !operation?.undoGroup ||
          !store().getState().canUndoGroup(operation.undoGroup)
        )
          return;
        store().getState().undo();
        publish({ operation: { phase: 'completed', message: t('已撤销更新') } });
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
        publish({
          connections: snapshot.connections.filter(item => item.id !== connectionId),
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
  };
}
