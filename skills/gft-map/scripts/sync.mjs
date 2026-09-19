import { createHash, randomUUID } from 'node:crypto';
import * as store from './store.mjs';
import { mapToBundle, bundleToMap, appendSourceLog, sourceRecordsFromEvents, isEditedSourceLog } from './dist/core.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentOf = value => ({ name:value.name, ledger:value.ledger, raw:value.raw });
const fingerprint = value => digest(contentOf(value));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const copyId = store.syncConflictId;
function remoteContent(remote) {
  if (remote.deleted) return null;
  const map={...remote.map,watermarks:{}};
  if (!isEditedSourceLog(map.raw)) map.raw=appendSourceLog(map.raw,sourceRecordsFromEvents(remote.sources || []));
  return mapToBundle(remote.name,map).topic;
}
function payload(topic, id) {
  const bundle=mapToBundle(topic.name,{...topic.panel,ledger:topic.ledger,raw:topic.raw,watermarks:{},nodes:topic.panel?.nodes || [],edges:topic.panel?.edges || []});
  const map=bundleToMap(bundle,id);
  return {...bundle.topic,doc:map.doc,nodes:map.nodes,edges:map.edges};
}

/** Durable local revisions + remote CAS. No model calls and no chat-file reads. */
export function createCloudSync({account, backend=store, intervalMs=10000} = {}) {
  let closed=false, running=null, timer=null;
  let state={status:'local',error:'',lastSyncedAt:null,conflicts:0};
  const snapshot=()=>({...state});
  async function reconcile(session) {
    const check=()=>{if(closed || !session.alive()) throw new Error('登录已变化，已停止同步');};
    const index=new Map();
    // Keyset pagination is stable across concurrent insertions/deletions; an
    // absent index entry is NEVER taken as permission to delete a local topic.
    let after='';
    for (;;) {
      check();
      const page=await session.rpc('gft_sync_index',{},`?order=id&limit=200${after ? `&id=gt.${after}` : ''}`);
      if(!Array.isArray(page))throw new Error('云端同步列表无效，本地内容已保留。');
      for(const item of page) {if(!uuid.test(item.id)||typeof item.version!=='string')throw new Error('云端同步版本无效');index.set(item.id,item);}
      if(page.length<200)break;
      const next=page.at(-1).id;if(next===after)throw new Error('云端同步列表未前进');after=next;
    }
    check();
    const topics=await backend.listSyncTopics();
    const bound=new Set();
    const errors=[];
    for(let topic of topics) {
      check();
      try {
      if(topic.cloud && topic.cloud.account!==session.key)continue;
      if(!topic.cloud) {
        if(topic.archived)continue;
        topic=await backend.commitCloudState(topic.id,topic.revision,{account:session.key,id:uuid.test(topic.id)?topic.id:randomUUID(),version:null,base:null});
      }
      const cloud=topic.cloud;
      bound.add(cloud.id);
      const meta=index.get(cloud.id);
      // An un-synced local deletion must not be uploaded later after login.
      const wantsDelete=topic.archived && topic.deletionAccount===session.key;
      if(!meta && topic.archived)continue;
      if(meta?.version===cloud.version && ((topic.archived && meta.deleted)
        || (!topic.archived && !meta.deleted && fingerprint(topic)===cloud.base)))continue;
      check();
      const remote=await session.rpc('gft_sync_read',{topic_id:cloud.id});
      check();
      if(!remote && cloud.version)throw new Error('云端未返回已同步脉络或删除记录，已保留本地内容。');
      const content=remote ? remoteContent(remote) : null;
      const remoteHash=content ? fingerprint(content) : null;
      const localHash=fingerprint(topic);
      const localChanged=!topic.archived && localHash!==cloud.base;
      const remoteChanged=!!remote && remote.version!==cloud.version;
      if(wantsDelete) {
        if(content && remoteChanged && remoteHash!==cloud.base) {
          await backend.keepSyncConflict(copyId(session.key,cloud.id,remote.version,'delete'),content,session.key);
          state.conflicts++;
        }
        check();
        const result=remote?.deleted ? remote : await session.rpc('gft_sync_write',{topic_id:cloud.id,expected_version:remote?.version ?? null,remove:true});
        check();
        if(result?.conflict)continue;
        if(result)await backend.commitCloudState(topic.id,topic.revision,{...cloud,version:result.version,base:localHash,deleted:true});
      } else if(remote?.deleted) {
        if(localChanged) {
          await backend.keepSyncConflict(copyId(session.key,cloud.id,localHash,'deleted-remote'),contentOf(topic),session.key);
          state.conflicts++;
        }
        await backend.commitCloudState(topic.id,topic.revision,{...cloud,version:remote.version,base:localHash,deleted:true},{...contentOf(topic),deleted:true});
      } else if(content && (topic.archived || (remoteChanged && localHash!==remoteHash))) {
        if(localChanged && remoteHash!==cloud.base) {
          await backend.keepSyncConflict(copyId(session.key,cloud.id,localHash,remote.version),contentOf(topic),session.key);
          state.conflicts++;
        } else if(localChanged) {
          // Remote metadata changed but its content is still our last baseline.
          const result=await session.rpc('gft_sync_write',{topic_id:cloud.id,expected_version:remote.version,payload:payload(topic,cloud.id)});
          check(); if(result?.conflict)continue;
          await backend.commitCloudState(topic.id,topic.revision,{...cloud,version:result.version,base:localHash,deleted:false});continue;
        }
        check();
        await backend.commitCloudState(topic.id,topic.revision,{...cloud,version:remote.version,base:remoteHash,deleted:false},content);
      } else if(!remote || localHash!==remoteHash) {
        const result=await session.rpc('gft_sync_write',{topic_id:cloud.id,expected_version:remote?.version ?? null,payload:payload(topic,cloud.id)});
        check(); if(result?.conflict)continue;
        await backend.commitCloudState(topic.id,topic.revision,{...cloud,version:result.version,base:localHash,deleted:false});
      } else {
        await backend.commitCloudState(topic.id,topic.revision,{...cloud,version:remote.version,base:remoteHash,deleted:false});
      }
      } catch(error) {check();errors.push(error);}
    }
    for(const meta of index.values()) {
      if(bound.has(meta.id)||meta.deleted)continue;
      check();
      try {
      const remote=await session.rpc('gft_sync_read',{topic_id:meta.id});check();
      if(!remote || remote.deleted)continue;
      const content=remoteContent(remote);
      // A same ID belonging to another login must not overwrite that account's local copy.
      const id=topics.some(topic=>topic.id===meta.id)?copyId(session.key,meta.id):meta.id;
      await backend.commitCloudState(id,null,{account:session.key,id:meta.id,version:remote.version,base:fingerprint(content),deleted:false},content);
      } catch(error) {check();errors.push(error);}
    }
    if(errors.length)throw errors[0];
    return (await backend.listSyncTopics()).some(topic=>topic.cloud?.account===session.key &&
      !(topic.archived && !topic.cloud.version && !index.has(topic.cloud.id)) &&
      (!topic.cloud.version || (!!topic.archived !== !!topic.cloud.deleted) || (!topic.archived && fingerprint(topic)!==topic.cloud.base)));
  }
  async function run() {
    if(closed || running)return running;
    running=(async()=>{
      try {
        const session=await account.session();
        if(!session) {state={...state,status:'local',error:''};return;}
        state={...state,status:'syncing',error:''};
        const pending=await backend.withCloudSync(()=>reconcile(session));
        if(!closed && session.alive())state={...state,status:pending?'pending':'synced',error:'',lastSyncedAt:pending?state.lastSyncedAt:new Date().toISOString()};
      } catch(error) {
        if(!closed)state={...state,status:'pending',error:error.status===409?'同步遇到新修改，将自动重试。':error.message};
      } finally {running=null;}
    })();
    return running;
  }
  return {snapshot,run,start(){if(!timer&&!closed){void run();timer=setInterval(()=>void run(),intervalMs);timer.unref();}},
    async close(){closed=true;clearInterval(timer);await running;}};
}
