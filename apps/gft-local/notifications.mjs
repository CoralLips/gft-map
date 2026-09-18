import { createHash } from 'node:crypto';
import * as store from './store.mjs';

const short = (text,limit) => String(text || '').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,limit);
function fingerprint(view) {
  // Layout, read badges, source-only imports and revision counters are not new understanding.
  const content = {name:view.name,scope:view.scope,doc:view.doc,
    nodes:view.graph.nodes.map(({id,title,mark,domain})=>({id,title,mark,domain})),
    edges:view.graph.edges.map(({from,to,type,label})=>({from,to,type,label}))};
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Peek then acknowledge after the hook has written context. Reading is a separate receipt. */
export async function pendingNotices({provider,sessionId} = {}) {
  const group = await store.getSourceConnections(provider,sessionId);
  if (!group) return {notices:[]};
  const notices = [];
  for (const binding of group.connections) {
    if (binding.disconnectedAt) continue;
    let view;
    try { view = await store.getNoticeView(binding.topicId); }
    catch (error) { if (error.status === 404) continue; throw error; }
    if (!view) continue;
    // Import checkpoints never change the published Doc/Map. A human edit during
    // a paused import must still notify; do not suppress the whole topic.
    const hash = fingerprint(view);
    if (binding.notice?.fingerprint === hash) continue;
    notices.push({topicId:view.id,name:short(view.name,80),scope:short(view.scope,240),revision:view.revision,
      receipt:{connectionId:binding.id,generation:binding.generation,fingerprint:hash,revision:view.revision}});
    if (notices.length === 8) break;
  }
  return {notices};
}

export async function acknowledgeNotices({provider,sessionId,receipts} = {}) {
  if (!Array.isArray(receipts) || receipts.length > 8 || receipts.some(r=> !r || typeof r.connectionId !== 'string'
    || typeof r.generation !== 'string' || !/^[a-f0-9]{64}$/.test(r.fingerprint) || !Number.isSafeInteger(r.revision) || r.revision < 1)) throw store.fail('通知回执无效');
  return store.withSourceConnections(provider,sessionId,async group => {
    let acknowledged = 0;
    for (const receipt of receipts) {
      const binding = group.connections.find(b=>!b.disconnectedAt && b.id === receipt.connectionId && b.generation === receipt.generation);
      if (!binding || (binding.notice?.revision ?? 0) > receipt.revision) continue;
      const view = await store.getNoticeView(binding.topicId).catch(error=>{if (error.status !== 404) throw error; return null;});
      // A racing edit remains pending; a stale hook never acknowledges unseen content.
      if (!view || fingerprint(view) !== receipt.fingerprint) continue;
      binding.notice = {...receipt,at:new Date().toISOString()};
      acknowledged++;
    }
    return {acknowledged};
  });
}
