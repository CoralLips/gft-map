import { t } from '../../../../src/i18n';
import type { ThinkingMapStore } from '../../../../src/store/thinkingMap/runtime';
import { messageOf, type Request } from './api';
import type { MapCache } from './mapCache';
import type { ReceiptSnapshot, UpdateReceipt } from './types';

export type Receipts = ReturnType<typeof createReceipts>;

/** The latest update's receipt for the open map, and rolling it back. */
export function createReceipts({
  request,
  store,
  maps,
  currentProjectId,
  isDisposed,
  waitForCreate,
  otherWorkRunning,
  clearUpdateNotice,
}: {
  request: Request;
  store(): ThinkingMapStore;
  maps: MapCache;
  currentProjectId(): string | null;
  isDisposed(): boolean;
  waitForCreate(id: string): Promise<unknown> | undefined;
  /** A chat update or another followed task is still running. */
  otherWorkRunning(): boolean;
  /** Removes the finished-update notice once its update was rolled back. */
  clearUpdateNotice(): void;
}) {
  const listeners = new Set<() => void>();
  let snapshot: ReceiptSnapshot = {
    topicId: null,
    currentRevision: null,
    receipt: null,
    loading: false,
    rollingBack: false,
    error: '',
  };
  // Bumped on every read and topic switch so a late reply cannot show the wrong map.
  let epoch = 0;
  const publish = (change: Partial<ReceiptSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    listeners.forEach(listener => listener());
  };
  const stillOn = (id: string) => !isDisposed() && currentProjectId() === id;

  async function refresh(id = currentProjectId()) {
    if (isDisposed() || !id) return null;
    const requested = ++epoch;
    if (currentProjectId() === id) publish({ topicId: id, loading: true, error: '' });
    try {
      await waitForCreate(id);
      const result = await request<{
        topicId: string;
        currentRevision: number;
        receipt: UpdateReceipt | null;
      }>(`/api/topics/${encodeURIComponent(id)}/update-receipt`);
      if (stillOn(id) && requested === epoch) publish({ ...result, loading: false, error: '' });
      return result;
    } catch (error) {
      if (stillOn(id) && requested === epoch) publish({ loading: false, error: messageOf(error) });
      return null; // Receipt failure must not change a successfully completed update into a failed update.
    }
  }
  function rollbackBlocked() {
    const id = currentProjectId(),
      state = store().getState();
    if (!id || state.boundProjectId !== id || state.isHydrating) return t('请等当前脉络读取完成。');
    if (
      state.docDraft !== null ||
      state.sourceDraftActive ||
      state.editingNodeId !== null ||
      state.editingNodeBodyId !== null ||
      state.editingEdgeId !== null
    )
      return t('请先完成或取消当前编辑，再退回更新。');
    if (maps.isSaving(id)) return t('请等当前修改保存完成，再退回更新。');
    if (
      otherWorkRunning() ||
      state.isGenerating ||
      state.isTidying ||
      state.isRefining ||
      state.isCondensing
    )
      return t('请等当前操作完成后再退回更新。');
    return null;
  }
  async function rollback() {
    if (snapshot.rollingBack) return;
    const id = currentProjectId(),
      receipt = snapshot.topicId === id ? snapshot.receipt : null;
    const blocked = rollbackBlocked();
    if (!id || !receipt) return;
    if (blocked || !receipt.canRollback) {
      publish({
        error: blocked || receipt.rollbackBlockedReason || t('当前内容已改变，不能整次退回。'),
      });
      return;
    }
    publish({ rollingBack: true, error: '' });
    try {
      // Use the displayed version. A stale tab must not silently agree to overwrite a newer revision.
      const baseRevision = maps.read(id)?.revision;
      if (baseRevision === undefined) throw new Error(t('脉络尚未读取，请重新打开后处理。'));
      await request(`/api/topics/${encodeURIComponent(id)}/rollback-update`, {
        baseRevision,
        receiptId: receipt.id,
      });
      if (stillOn(id)) {
        // syncFromRemote preserves any draft started while the request was in flight.
        await store().getState().syncFromRemote();
        await refresh(id);
        clearUpdateNotice();
      }
    } catch (error) {
      if (stillOn(id)) {
        await refresh(id);
        publish({ error: messageOf(error) });
      }
    } finally {
      if (!isDisposed() && snapshot.topicId === id) publish({ rollingBack: false });
    }
  }
  async function rollbackOperation(receiptId: string, baseRevision: number) {
    const blocked = rollbackBlocked(),
      id = currentProjectId();
    if (blocked || !id || snapshot.rollingBack)
      throw new Error(blocked || t('请等当前操作完成后再退回更新。'));
    publish({ rollingBack: true, error: '' });
    try {
      await request(`/api/topics/${encodeURIComponent(id)}/rollback-operation`, {
        baseRevision,
        receiptId,
      });
      if (stillOn(id)) {
        await store().getState().syncFromRemote();
        await refresh(id);
      }
    } finally {
      if (!isDisposed() && snapshot.topicId === id) publish({ rollingBack: false });
    }
  }

  return {
    refresh,
    rollbackBlocked,
    /** Shows `id` as loading; replies for the previous map are ignored. */
    switchTo(id: string) {
      epoch++;
      publish({
        topicId: id,
        currentRevision: null,
        receipt: null,
        loading: true,
        rollingBack: false,
        error: '',
      });
    },
    dispose() {
      epoch++;
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
      refresh,
      rollback,
      rollbackOperation,
      rollbackBlocked,
    },
  };
}
