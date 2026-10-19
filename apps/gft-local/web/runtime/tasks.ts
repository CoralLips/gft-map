import { t } from '../../../../src/i18n';
import { deriveCaches } from '../../../../src/service/ledger/bridge';
import { parseLedger } from '../../../../src/service/ledger';
import {
  MAP_VIEW_DETACHED,
  MAP_OPERATION_SUPERSEDED,
} from '../../../../src/store/thinkingMap/runtime';
import type {
  MapComputeContext,
  MapOperationOutcome,
  MapOperationRequest,
  OperationProgress,
  ThinkingMapStore,
} from '../../../../src/store/thinkingMap/runtime';
import {
  LocalApiError,
  LocalConnectionError,
  localRequest,
  abortError,
  pause,
  type Request,
} from './api';
import type { MapCache } from './mapCache';
import type { ConnectionSnapshot, TopicSnapshot } from './types';

export type TaskState = {
  status: string;
  error?: string;
  report?: Record<string, number | boolean>;
  /** The round a running tidy is on. */
  round?: number;
  /** Edits the running call has written so far. */
  progress?: OperationProgress[];
};
/** A task as the service's task list reports it. */
export interface TaskRecord {
  id: string;
  topicId: string;
  status: string;
  action: string;
  source?: { title?: string; stage?: string; hasMore?: boolean };
  mode?: string;
  params?: { nodeId?: string; from?: string; to?: string; scopeIds?: string[] };
}
export type Tasks = ReturnType<typeof createTasks>;
type OperationList = {
  currentRevision: number;
  operations: { id: string; rolledBackAt?: string }[];
};
const settledStates = ['completed', 'failed', 'cancelled'];

/**
 * Model work the page follows on the service: server operations, their receipts
 * and rollback, and stopping a task.
 */
export function createTasks({
  request,
  store,
  maps,
  isDisposed,
  currentProjectId,
  onError,
  sourcesSaved,
  refreshReceipt,
  connections,
  onStopsChange,
}: {
  request: Request;
  store(): ThinkingMapStore;
  maps: MapCache;
  isDisposed(): boolean;
  currentProjectId(): string | null;
  onError(message: string): void;
  /** Resolves once this topic's queued source writes are saved. */
  sourcesSaved(id: string): Promise<void> | undefined;
  refreshReceipt(id: string): Promise<unknown>;
  /** The chat update notice, which a stop may need to settle. */
  connections: {
    snapshot(): ConnectionSnapshot;
    publish(change: Partial<ConnectionSnapshot>): void;
  };
  onStopsChange(): void;
}) {
  const activeTasks = new Map<string, () => Promise<void>>();
  // Stops in flight or not yet confirmed by the service; the person can retry them.
  const stops = new Map<string, { topicId: string; announceCompletion: boolean }>();
  const stopRequests = new Map<string, Promise<TaskState | null>>();
  let stopState = { stoppingTaskIds: [] as string[], stopError: '' };
  const settledTasks = new Set<string>();
  const taskFollowers = new Map<string, Promise<TaskState>>();
  function rememberSettled(id: string) {
    settledTasks.add(id);
    if (settledTasks.size > 200) settledTasks.delete(settledTasks.values().next().value!);
  }

  function publishStops(stopError = stops.size ? stopState.stopError : '') {
    stopState = { stoppingTaskIds: [...stops.keys()], stopError };
    if (!isDisposed()) onStopsChange();
  }
  /**
   * Asks the service to stop a task, retrying briefly. Returns its final state, a
   * `missing` state when the service has no such task, or null when the stop is
   * still unconfirmed.
   */
  async function confirmStop(taskId: string): Promise<TaskState | null> {
    const path = `/api/tasks/${encodeURIComponent(taskId)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (isDisposed()) return null;
      if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
      try {
        let state: TaskState;
        try {
          state = await localRequest<TaskState>(`${path}/cancel`, {}, undefined, true);
        } catch (error) {
          // The reply may have been lost, or completion may have won the race.
          if (!(error instanceof LocalApiError && error.status === 409)) throw error;
          state = await localRequest<TaskState>(`${path}/status`);
        }
        if (settledStates.includes(state.status)) return state;
      } catch (error) {
        if (error instanceof LocalApiError && error.status === 404) return { status: 'missing' };
      }
    }
    return null;
  }
  /** Tells the person what a stop actually did; only a confirmed end clears it. */
  function reportStop(taskId: string, state: TaskState | null) {
    const stop = stops.get(taskId);
    if (!stop || isDisposed()) return;
    if (!state) {
      publishStops(t('停止尚未确认，后台可能仍在运行；点重试再确认一次。'));
      return;
    }
    stops.delete(taskId);
    rememberSettled(taskId);
    publishStops();
    const message =
      state.status === 'missing'
        ? '未找到要停止的任务，请在任务列表核对。'
        : state.status === 'completed'
          ? '停止前任务已完成，请查看结果；需要时可撤回。'
          : state.status === 'failed'
            ? '任务已失败，未继续执行。'
            : '任务已取消，当前内容保留。';
    const notice = connections.snapshot();
    if (notice.topicId === stop.topicId && notice.operation?.phase === 'cancelling')
      connections.publish({
        operation: {
          ...notice.operation,
          phase:
            state.status === 'cancelled'
              ? 'cancelled'
              : state.status === 'completed'
                ? 'completed'
                : 'failed',
          message: t(message),
        },
      });
    if (state.status !== 'cancelled' && (stop.announceCompletion || state.status === 'missing'))
      onError(t(message));
  }
  function cancelTask(
    taskId: string,
    topicId: string,
    announceCompletion = true,
  ): Promise<TaskState | null> {
    if (isDisposed()) return Promise.resolve(null);
    const previous = stopRequests.get(taskId);
    if (previous) return previous;
    stops.set(taskId, { topicId, announceCompletion });
    publishStops();
    const stopping = confirmStop(taskId)
      .then(state => {
        reportStop(taskId, state);
        return state;
      })
      .finally(() => stopRequests.delete(taskId));
    stopRequests.set(taskId, stopping);
    return stopping;
  }
  /**
   * Polls a queued task; explicit abort stops it, view-detach abort only stops polling.
   * `onStatus` sees each unfinished status; `failure` is the message when the task gives none.
   */
  function followTask(
    taskId: string,
    context: Pick<MapComputeContext, 'signal'>,
    options: {
      onStatus?: (status: string) => void;
      onRound?: (round: number) => void;
      onProgress?: (actions: OperationProgress[]) => void;
      failure?: string;
    } = {},
  ): Promise<TaskState> {
    if (context.signal.aborted && context.signal.reason === MAP_VIEW_DETACHED)
      return Promise.reject(abortError());
    const current = taskFollowers.get(taskId);
    if (current) return current;
    const following = pollTask(taskId, context, options).finally(() => {
      if (taskFollowers.get(taskId) === following) taskFollowers.delete(taskId);
    });
    taskFollowers.set(taskId, following);
    return following;
  }
  async function pollTask(
    taskId: string,
    context: Pick<MapComputeContext, 'signal'>,
    {
      onStatus,
      onRound,
      onProgress,
      failure = '本地模型执行失败。',
    }: {
      onStatus?: (status: string) => void;
      onRound?: (round: number) => void;
      onProgress?: (actions: OperationProgress[]) => void;
      failure?: string;
    } = {},
  ): Promise<TaskState> {
    let cancellation: Promise<TaskState | null> | undefined;
    let failures = 0;
    const cancel = () => {
      if (isDisposed() || context.signal.reason === MAP_VIEW_DETACHED) return Promise.resolve();
      cancellation ||= cancelTask(
        taskId,
        currentProjectId() || '',
        context.signal.reason !== MAP_OPERATION_SUPERSEDED,
      );
      return cancellation.then(() => {});
    };
    activeTasks.set(taskId, cancel);
    const onAbort = () => {
      if (context.signal.reason === MAP_VIEW_DETACHED) {
        // A rapid A→B→A may attach a new observer before this one unwinds.
        taskFollowers.delete(taskId);
        if (activeTasks.get(taskId) === cancel) activeTasks.delete(taskId);
      } else void cancel();
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (context.signal.aborted || isDisposed()) throw abortError();
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
            !isDisposed() &&
            (error instanceof LocalConnectionError ||
              (error instanceof LocalApiError && error.status >= 500))
          ) {
            await pause(context.signal, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
            continue;
          }
          throw error;
        }
        if (context.signal.aborted || isDisposed()) throw abortError();
        failures = 0;
        if (settledStates.includes(state.status)) rememberSettled(taskId);
        if (state.status === 'completed') return state;
        if (state.status === 'failed') throw new Error(t(state.error || failure));
        if (state.status === 'cancelled') throw abortError();
        onStatus?.(state.status);
        if (state.round) onRound?.(state.round);
        if (state.progress?.length) onProgress?.(state.progress);
        await pause(context.signal);
      }
    } catch (error) {
      if (context.signal.aborted && !isDisposed() && context.signal.reason !== MAP_VIEW_DETACHED) {
        await cancel();
        const state = await cancellation;
        throw new DOMException(
          t(
            state?.status === 'completed'
              ? '停止前任务已完成，请查看结果；需要时可撤回。'
              : stops.has(taskId)
                ? '停止尚未确认，后台可能仍在运行；点重试再确认一次。'
                : '任务已取消，当前内容保留。',
          ),
          'AbortError',
        );
      }
      throw error;
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      if (activeTasks.get(taskId) === cancel) activeTasks.delete(taskId);
    }
  }

  /** Saves pending edits so a model task starts from what the person sees. */
  async function settleBeforeTask(id: string | null, context: MapComputeContext, redraw = false) {
    if (!id) throw new Error(t('请先选择脉络。'));
    if (context.signal.aborted || isDisposed()) throw abortError();
    store().getState().flushDoc(); // Drain the shared debounce before pinning a model task to a revision.
    await maps.flushPending(id);
    if (redraw) await sourcesSaved(id);
    if (context.signal.aborted || isDisposed()) throw abortError();
    return id;
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
      const state = await followTask(context.taskId, context, {
        onRound: context.onRound,
        onProgress: context.onProgress,
      });
      void refreshReceipt(projectId);
      return { taskId: context.taskId, ...(state.report ? { report: state.report } : {}) };
    }
    const id = await settleBeforeTask(projectId, context, operation.kind === 'redraw');
    const task = await request<{ id: string }>(
      `/api/topics/${encodeURIComponent(id)}/tasks`,
      operationTask(operation),
    );
    const state = await followTask(task.id, context, {
      onRound: context.onRound,
      onProgress: context.onProgress,
    });
    void refreshReceipt(id);
    return { taskId: task.id, ...(state.report ? { report: state.report } : {}) };
  }

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
    return maps
      .inSaveQueue(projectId, async () => {
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
              step =>
                identity(step.ledger ?? current.ledger.slice(0, step.ledgerLength)) === target,
            );
            if (index >= 0) receiptIds = history.slice(index).map(step => step.id);
            else if (identity(current.ledger) !== target) {
              // Several local edits can share one debounced save. Preserve the
              // existing finer-grained local undo when there is no receipt boundary.
              await request(`/api/topics/${topic}/state`, {
                baseRevision: current.revision,
                map: maps.mapOf({ ...current, ledger: targetLedger }),
              });
            }
          }
          for (const receiptId of [...receiptIds].reverse()) await rollback(receiptId);
        } finally {
          const remote = (await request<TopicSnapshot>(`/api/topics/${topic}/snapshot`)).topic;
          const latest = maps.read(projectId);
          if (latest)
            maps.write(projectId, {
              ...latest,
              base: { ledger: remote.ledger, raw: remote.raw },
              revision: remote.revision,
            });
          void refreshReceipt(projectId);
        }
        return null;
      })
      .then(() => {});
  }

  /** The page operation a still-running server task belongs to, if the page can show it. */
  function operationOf(task: TaskRecord): MapOperationRequest | null {
    const p = task.params;
    return task.action === 'refine' && p?.nodeId
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
  }

  return {
    cancelTask,
    followTask,
    settleBeforeTask,
    runOperation,
    rollbackOperations,
    /** A running task this page is not following yet and has not just settled or stopped. */
    canReattach: (task: TaskRecord) =>
      !activeTasks.has(task.id) &&
      !stops.has(task.id) &&
      !settledTasks.has(task.id) &&
      ['pending', 'running'].includes(task.status) &&
      task.mode !== 'compute', // a leftover pre-0.3.13 page computation, which the service refuses
    /** Shows a running server operation again, with its progress and stop control. */
    reattach(task: TaskRecord) {
      const operation = operationOf(task);
      if (operation) void store().getState().attachServerTask(task.id, operation);
    },
    stopState: () => stopState,
    /** Asks again for stops the service has not confirmed. */
    retryStops: () =>
      Promise.all(
        [...stops].map(([taskId, stop]) =>
          cancelTask(taskId, stop.topicId, stop.announceCompletion),
        ),
      ),
    isRunning: () => activeTasks.size > 0,
    /** Stops following every task; on page exit this only detaches. */
    detachAll() {
      for (const cancel of activeTasks.values()) void cancel();
    },
    following: () => [...taskFollowers.values()],
  };
}
