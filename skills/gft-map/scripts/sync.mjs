import { createHash, randomUUID } from 'node:crypto';
import * as store from './store.mjs';
import {
  mapToBundle,
  bundleToMap,
  appendSourceLog,
  sourceRecordsFromEvents,
  isEditedSourceLog,
} from './dist/core.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentOf = value => ({ name: value.name, ledger: value.ledger, raw: value.raw });
const fingerprint = value => digest(contentOf(value));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const copyId = store.syncConflictId;
function remoteContent(remote) {
  if (remote.deleted) return null;
  const map = { ...remote.map, watermarks: {} };
  if (!isEditedSourceLog(map.raw))
    map.raw = appendSourceLog(map.raw, sourceRecordsFromEvents(remote.sources || []));
  return mapToBundle(remote.name, map).topic;
}
function payload(topic, id) {
  const bundle = mapToBundle(topic.name, {
    ...topic.panel,
    ledger: topic.ledger,
    raw: topic.raw,
    watermarks: {},
    nodes: topic.panel?.nodes || [],
    edges: topic.panel?.edges || [],
  });
  const map = bundleToMap(bundle, id);
  return { ...bundle.topic, doc: map.doc, nodes: map.nodes, edges: map.edges };
}

/** Durable local revisions + remote CAS. No model calls and no chat-file reads. */
export function createCloudSync({ account, backend = store, intervalMs = 10000 } = {}) {
  let closed = false,
    running = null,
    timer = null;
  let state = { status: 'local', error: '', lastSyncedAt: null, conflicts: 0 };
  const snapshot = () => ({ ...state });
  /** The cloud's topic list. Keyset pages stay stable under concurrent inserts and deletes. */
  async function readIndex(session, check) {
    const index = new Map();
    let after = '';
    for (;;) {
      check();
      const query = `?order=id&limit=200${after ? `&id=gt.${after}` : ''}`;
      const page = await session.rpc('gft_sync_index', {}, query);
      if (!Array.isArray(page)) throw new Error('云端同步列表无效，本地内容已保留。');
      for (const item of page) {
        if (!uuid.test(item.id) || typeof item.version !== 'string')
          throw new Error('云端同步版本无效');
        index.set(item.id, item);
      }
      if (page.length < 200) return index;
      const next = page.at(-1).id;
      if (next === after) throw new Error('云端同步列表未前进');
      after = next;
    }
  }

  async function keepConflict(session, id, content) {
    await backend.keepSyncConflict(id, content, session.key);
    state.conflicts++;
  }

  /** Uploads the local topic over the cloud version it was compared with. */
  async function push(session, check, topic, cloud, expectedVersion, localHash) {
    const result = await session.rpc('gft_sync_write', {
      topic_id: cloud.id,
      expected_version: expectedVersion,
      payload: payload(topic, cloud.id),
    });
    check();
    if (result?.conflict) return; // the cloud moved meanwhile; the next run compares again
    await backend.commitCloudState(topic.id, topic.revision, {
      ...cloud,
      version: result.version,
      base: localHash,
      deleted: false,
    });
  }

  /** A local deletion made under this login; a concurrent remote edit is kept as a copy. */
  async function uploadDeletion(session, check, topic, cloud, change) {
    const { remote, content, remoteHash, localHash } = change;
    if (content && change.remoteChanged && remoteHash !== cloud.base)
      await keepConflict(session, copyId(session.key, cloud.id, remote.version, 'delete'), content);
    check();
    const result = remote?.deleted
      ? remote
      : await session.rpc('gft_sync_write', {
          topic_id: cloud.id,
          expected_version: remote?.version ?? null,
          remove: true,
        });
    check();
    if (!result || result.conflict) return;
    await backend.commitCloudState(topic.id, topic.revision, {
      ...cloud,
      version: result.version,
      base: localHash,
      deleted: true,
    });
  }

  /** Deleted in the cloud: delete here too, keeping unsynced local edits as a copy. */
  async function acceptRemoteDeletion(session, topic, cloud, change) {
    const { remote, localHash } = change;
    if (change.localChanged)
      await keepConflict(
        session,
        copyId(session.key, cloud.id, localHash, 'deleted-remote'),
        contentOf(topic),
      );
    await backend.commitCloudState(
      topic.id,
      topic.revision,
      { ...cloud, version: remote.version, base: localHash, deleted: true },
      { ...contentOf(topic), deleted: true },
    );
  }

  /** The cloud has newer content: take it, keeping diverged local edits as a copy. */
  async function pullRemote(session, check, topic, cloud, change) {
    const { remote, content, remoteHash, localHash } = change;
    if (change.localChanged && remoteHash !== cloud.base) {
      await keepConflict(
        session,
        copyId(session.key, cloud.id, localHash, remote.version),
        contentOf(topic),
      );
    } else if (change.localChanged) {
      // Remote metadata changed but its content is still our last baseline.
      return push(session, check, topic, cloud, remote.version, localHash);
    }
    check();
    await backend.commitCloudState(
      topic.id,
      topic.revision,
      { ...cloud, version: remote.version, base: remoteHash, deleted: false },
      content,
    );
  }

  const inSync = (topic, cloud, meta) =>
    meta?.version === cloud.version &&
    ((topic.archived && meta.deleted) ||
      (!topic.archived && !meta.deleted && fingerprint(topic) === cloud.base));

  /** Compares one local topic with its cloud copy and moves whichever side is behind. */
  async function syncTopic(session, check, index, topic, bound) {
    if (topic.cloud && topic.cloud.account !== session.key) return;
    if (!topic.cloud) {
      if (topic.archived) return;
      topic = await backend.commitCloudState(topic.id, topic.revision, {
        account: session.key,
        id: uuid.test(topic.id) ? topic.id : randomUUID(),
        version: null,
        base: null,
      });
    }
    const cloud = topic.cloud;
    bound.add(cloud.id);
    const meta = index.get(cloud.id);
    if (!meta && topic.archived) return;
    if (inSync(topic, cloud, meta)) return;
    check();
    const remote = await session.rpc('gft_sync_read', { topic_id: cloud.id });
    check();
    if (!remote && cloud.version)
      throw new Error('云端未返回已同步脉络或删除记录，已保留本地内容。');
    const content = remote ? remoteContent(remote) : null;
    const change = {
      remote,
      content,
      remoteHash: content ? fingerprint(content) : null,
      localHash: fingerprint(topic),
    };
    change.localChanged = !topic.archived && change.localHash !== cloud.base;
    change.remoteChanged = !!remote && remote.version !== cloud.version;
    // An un-synced local deletion must not be uploaded later after login.
    if (topic.archived && topic.deletionAccount === session.key)
      return uploadDeletion(session, check, topic, cloud, change);
    if (remote?.deleted) return acceptRemoteDeletion(session, topic, cloud, change);
    const remoteNewer = change.remoteChanged && change.localHash !== change.remoteHash;
    if (content && (topic.archived || remoteNewer))
      return pullRemote(session, check, topic, cloud, change);
    if (!remote || change.localHash !== change.remoteHash)
      return push(session, check, topic, cloud, remote?.version ?? null, change.localHash);
    await backend.commitCloudState(topic.id, topic.revision, {
      ...cloud,
      version: remote.version,
      base: change.remoteHash,
      deleted: false,
    });
  }

  /** A cloud topic this device has never seen. */
  async function pullNewTopic(session, check, topics, meta) {
    const remote = await session.rpc('gft_sync_read', { topic_id: meta.id });
    check();
    if (!remote || remote.deleted) return;
    const content = remoteContent(remote);
    // A same ID belonging to another login must not overwrite that account's local copy.
    const id = topics.some(topic => topic.id === meta.id) ? copyId(session.key, meta.id) : meta.id;
    await backend.commitCloudState(
      id,
      null,
      {
        account: session.key,
        id: meta.id,
        version: remote.version,
        base: fingerprint(content),
        deleted: false,
      },
      content,
    );
  }

  /** Whether any topic of this login still differs from what the cloud last confirmed. */
  async function hasPendingChanges(session, index) {
    const differs = topic =>
      !topic.cloud.version ||
      !!topic.archived !== !!topic.cloud.deleted ||
      (!topic.archived && fingerprint(topic) !== topic.cloud.base);
    return (await backend.listSyncTopics()).some(
      topic =>
        topic.cloud?.account === session.key &&
        !(topic.archived && !topic.cloud.version && !index.has(topic.cloud.id)) &&
        differs(topic),
    );
  }

  /**
   * One sync pass. A topic missing from the cloud index is never taken as
   * permission to delete it locally. One topic's failure doesn't stop the others.
   */
  async function reconcile(session) {
    const check = () => {
      if (closed || !session.alive()) throw new Error('登录已变化，已停止同步');
    };
    const index = await readIndex(session, check);
    check();
    const topics = await backend.listSyncTopics();
    const bound = new Set();
    const errors = [];
    const attempt = async step => {
      try {
        await step();
      } catch (error) {
        check();
        errors.push(error);
      }
    };
    for (const topic of topics) {
      check();
      await attempt(() => syncTopic(session, check, index, topic, bound));
    }
    for (const meta of index.values()) {
      if (bound.has(meta.id) || meta.deleted) continue;
      check();
      await attempt(() => pullNewTopic(session, check, topics, meta));
    }
    if (errors.length) throw errors[0];
    return hasPendingChanges(session, index);
  }

  async function run() {
    if (closed || running) return running;
    running = (async () => {
      try {
        const session = await account.session();
        if (!session) {
          state = { ...state, status: 'local', error: '' };
          return;
        }
        state = { ...state, status: 'syncing', error: '' };
        const pending = await backend.withCloudSync(() => reconcile(session));
        if (!closed && session.alive())
          state = {
            ...state,
            status: pending ? 'pending' : 'synced',
            error: '',
            lastSyncedAt: pending ? state.lastSyncedAt : new Date().toISOString(),
          };
      } catch (error) {
        if (!closed)
          state = {
            ...state,
            status: 'pending',
            error: error.status === 409 ? '同步遇到新修改，将自动重试。' : error.message,
          };
      } finally {
        running = null;
      }
    })();
    return running;
  }
  return {
    snapshot,
    run,
    start() {
      if (!timer && !closed) {
        void run();
        timer = setInterval(() => void run(), intervalMs);
        timer.unref();
      }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
