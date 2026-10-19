import { deriveCaches } from '../../../../src/service/ledger/bridge';
import { parseLedger } from '../../../../src/service/ledger';
import { isEditedSourceLog, mergeSourceLogs } from '../../../../src/service/sourceLog';
import { mergeLedgerPair } from '../../../../src/service/ledger/merge';
import { sessionLine } from '../../../../src/service/ledger/write';
import type { PersistedThinkingMap } from '../../../../src/type/thinkingMap';
import { LocalApiError, keyOf, storage, type Request } from './api';
import type { CachedMap, LocalTopic, TopicSnapshot } from './types';

export type MapCache = ReturnType<typeof createMapCache>;
type UndoStep = { ledger: string; receipts: string[] };

/**
 * The page's copy of each map: the version last accepted from the service,
 * edits not saved yet, and the queue that saves them in order.
 */
export function createMapCache({
  request,
  waitForCreate,
  onChange,
}: {
  request: Request;
  /** A topic that is still being created must exist before it is saved. */
  waitForCreate(id: string): Promise<unknown> | undefined;
  /** Called after a cached entry or a save failure changes. */
  onChange(id: string, entry?: CachedMap): void;
}) {
  const cache = new Map<string, CachedMap>();
  const remoteVersions = new WeakMap<PersistedThinkingMap, number>();
  const undoHistories = new WeakMap<PersistedThinkingMap, UndoStep[]>();
  const saveQueues = new Map<string, Promise<PersistedThinkingMap | null>>();
  const failedSaves = new Set<string>();
  let serial = 0;

  const read = (id: string) => {
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
  const write = (id: string, entry: CachedMap) => {
    cache.set(id, entry);
    storage.set(keyOf(id), JSON.stringify(entry));
    onChange(id, entry);
  };
  const forget = (id: string) => {
    cache.delete(id);
    storage.remove(keyOf(id));
  };
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
  const cachePending = (id: string, map: PersistedThinkingMap) => {
    const old = read(id);
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
    write(id, entry);
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
    const latest = read(id)!;
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
    write(id, entry);
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
  const save = (id: string, map: PersistedThinkingMap) => {
    cachePending(id, map);
    return inSaveQueue(id, async () => {
      await waitForCreate(id);
      let entry = read(id);
      if (!entry?.pending) return null;
      let rebased = false;
      for (let attempt = 0; ; attempt++) {
        try {
          const saved = await request<{ revision: number }>(
            `/api/topics/${encodeURIComponent(id)}/state`,
            { baseRevision: entry.revision, map: entry.map },
          );
          const latest = read(id)!;
          failedSaves.delete(id);
          write(id, {
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
      onChange(id);
      throw error;
    });
  };
  const flushPending = async (id: string) => {
    await waitForCreate(id);
    const pending = read(id);
    if (pending?.pending) await save(id, pending.map);
    else await saveQueues.get(id);
  };
  /**
   * The person's retry after a failed save. The write may have committed before
   * its reply was lost, so confirm that through a read before writing again.
   */
  const retrySave = async (id: string) => {
    await saveQueues.get(id)?.catch(() => null);
    const entry = read(id);
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
      if (
        read(id)?.serial === entry.serial &&
        remote.ledger === (entry.map.ledger || '') &&
        remote.raw === (entry.map.raw || '') &&
        JSON.stringify(remote.panel?.watermarks || {}) ===
          JSON.stringify(entry.map.watermarks || {}) &&
        unread(remote.panel) === unread(entry.map)
      ) {
        failedSaves.delete(id);
        write(id, {
          ...entry,
          revision: remote.revision,
          pending: false,
          base: { ledger: remote.ledger, raw: remote.raw },
        });
        return;
      }
    }
    await flushPending(id);
  };

  return {
    read,
    write,
    forget,
    nextSerial: () => ++serial,
    mapOf,
    cachePending,
    save,
    flushPending,
    inSaveQueue,
    retrySave,
    hasPending: (id: string) => read(id)?.pending === true,
    saveFailed: (id: string) => failedSaves.has(id),
    /** An edit is waiting to save, saving, or failed to save. */
    isSaving: (id: string) => !!read(id)?.pending || saveQueues.has(id) || failedSaves.has(id),
    savesFor: (id: string) => saveQueues.get(id),
    allSaves: () => [...saveQueues.values()],
    history: (map: PersistedThinkingMap) => undoHistories.get(map) || [],
    hasRemoteChanges: (id: string, map: PersistedThinkingMap) =>
      remoteVersions.get(map) !== read(id)?.revision,
    accept(id: string, remote: PersistedThinkingMap, applied = remote) {
      const revision = remoteVersions.get(remote);
      if (revision === undefined) return;
      const old = read(id);
      write(id, {
        map: applied,
        base: { ledger: remote.ledger || '', raw: remote.raw || '' },
        revision,
        pending: old?.pending || false,
        serial: ++serial,
      });
    },
  };
}
