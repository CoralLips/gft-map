import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as store from '../store.mjs';
import {createCloudSync} from '../sync.mjs';
import {createLedger,editSourceLog,renderSourceLog,bundleToMap} from '../dist/core.mjs';

async function fixture(run) {
  const home=await mkdtemp(path.join(tmpdir(),'gft-sync-')), previous=process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME=home;
  let user='a',online=true,epoch=0,version=0,hook=null;
  const cloud=new Map(),calls=[];
  const scope=()=>`https://gft.test|${user}`;
  const rows=()=>{if(!cloud.has(user))cloud.set(user,new Map());return cloud.get(user);};
  function remote(name='云端脉络',id=randomUUID()) {
    const item={id,name,version:String(++version),deleted:false,map:{ledger:createLedger('同一个主题'),raw:'',nodes:[],edges:[],doc:''}};
    rows().set(id,item);return item;
  }
  async function login(value) {
    epoch++;user=value;
    if(value)await writeFile(path.join(home,'account.json'),JSON.stringify({webUrl:'https://gft.test',account:{id:user}}));
    else await unlink(path.join(home,'account.json')).catch(()=>{});
  }
  const account={async session(){
    if(!user)return null;
    const captured=epoch,key=scope(),ownRows=rows();
    return {key,alive:()=>captured===epoch,async rpc(name,body,query){
      if(!online)throw new Error('离线');
      calls.push({name,body,query});
      if(hook)await hook(name,body);
      if(name==='gft_sync_index')return [...ownRows.values()].map(({id,version,deleted})=>({id,version,deleted}));
      if(name==='gft_sync_read')return structuredClone(ownRows.get(body.topic_id) || null);
      const old=ownRows.get(body.topic_id);
      if((old?.version ?? null)!==body.expected_version)return {conflict:true};
      if(body.remove){const item={id:body.topic_id,version:String(++version),deleted:true};ownRows.set(item.id,item);return item;}
      if(old?.deleted)return {conflict:true};
      const item={id:body.topic_id,name:body.payload.name,version:String(++version),deleted:false,map:structuredClone(body.payload)};
      ownRows.set(item.id,item);return item;
    }};
  }};
  const sync=createCloudSync({account});
  try {await login('a');await run({sync,login,remote,rows,calls,home,online:value=>online=value,hook:value=>hook=value,change(item,delta){Object.assign(item,delta,{version:String(++version)});}});}
  finally {
    await sync.close();if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;
    const relative=path.relative(path.resolve(tmpdir()),home);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(home,{recursive:true,force:true});
  }
}
async function writeLog(id,text) {
  const topic=await store.getTopic(id),map=bundleToMap(await store.exportTopic(id),id);
  return store.saveState(id,topic.revision,{...map,raw:editSourceLog(topic.raw,text)});
}

test('首次双向补齐，后续只读变更；本地主题与已编辑 Log 自动上云',()=>fixture(async({sync,remote,rows,calls})=>{
  const local=await store.createTopic('本地脉络','同一个主题');const cloud=remote();
  await sync.run();assert.equal(sync.snapshot().status,'synced');assert.equal(rows().size,2);assert.equal((await store.listTopics()).length,2);
  assert.equal((await store.getTopic(cloud.id)).name,'云端脉络');
  calls.length=0;await sync.run();assert.deepEqual(calls.map(call=>call.name),['gft_sync_index']);
  await writeLog(local.id,'人工修正后，只保留这一段。');await sync.run();
  assert.equal(renderSourceLog(rows().get(local.id).map.raw),'人工修正后，只保留这一段。');
  assert.ok(calls.filter(call=>call.name==='gft_sync_write').every(call=>!('watermarks' in call.body.payload)&&!('cloud' in call.body.payload)));
}));

test('云端修改下载，本地增量水位和绑定不变；不会恢复旧 Log',()=>fixture(async({sync,remote,change,home})=>{
  const item=remote();await sync.run();
  const topic=await store.getTopic(item.id);const cursors={local:{offset:123}};
  await writeFile(path.join(home,'topics',`${item.id}.json`),JSON.stringify({...topic,sourceCursors:cursors,panel:{watermarks:{chat:'m9'}}}));
  change(item,{name:'云端改名',map:{...item.map,raw:editSourceLog('', '新版 Log')}});
  await sync.run();const current=await store.getTopic(item.id);
  assert.equal(current.name,'云端改名');assert.equal(renderSourceLog(current.raw),'新版 Log');
  assert.deepEqual(current.sourceCursors,cursors);assert.deepEqual(current.panel.watermarks,{chat:'m9'});
  await sync.run();assert.equal((await store.getTopic(item.id)).revision,current.revision);
}));

test('登录后双向删除不复活；未登录删除只影响本地，重新登录从云端恢复',()=>fixture(async({sync,remote,rows,login,change})=>{
  const first=remote(),second=remote();await sync.run();
  await store.archiveTopic(first.id,(await store.getTopic(first.id)).revision);await sync.run();
  assert.equal(rows().get(first.id).deleted,true);await sync.run();assert.equal((await store.getTopic(first.id)).archived,true);
  change(second,{deleted:true});await sync.run();assert.equal((await store.getTopic(second.id)).archived,true);
  const third=remote();await sync.run();await login(null);
  await store.archiveTopic(third.id,(await store.getTopic(third.id)).revision);await sync.run();assert.equal(sync.snapshot().status,'local');
  await login('a');await sync.run();assert.equal((await store.getTopic(third.id)).archived,false);assert.equal(rows().get(third.id).deleted,false);
}));

test('离线继续修改和删除，恢复后自动同步',()=>fixture(async({sync,remote,online,rows})=>{
  const item=remote(),removed=remote();await sync.run();online(false);
  await writeLog(item.id,'离线修改');await store.archiveTopic(removed.id,(await store.getTopic(removed.id)).revision);
  await sync.run();assert.equal(sync.snapshot().status,'pending');assert.equal((await store.readSources(item.id)).text,'离线修改');
  online(true);await sync.run();assert.equal(sync.snapshot().status,'synced');assert.equal(renderSourceLog(rows().get(item.id).map.raw),'离线修改');assert.equal(rows().get(removed.id).deleted,true);
}));

test('同时编辑保留冲突副本，反复同步不重复创建',()=>fixture(async({sync,remote,change,rows})=>{
  const item=remote();await sync.run();await writeLog(item.id,'本地分支');change(item,{map:{...item.map,raw:editSourceLog('','云端分支')}});
  await sync.run();await sync.run();await sync.run();
  const topics=await store.listTopics();assert.equal(topics.length,2);assert.equal(rows().size,2);
  const copy=topics.find(topic=>topic.id!==item.id);assert.match(copy.name,/冲突副本/);
  assert.equal((await store.readSources(copy.id)).text,'本地分支');assert.equal((await store.readSources(item.id)).text,'云端分支');
}));

test('删除与修改相撞：原条目保持删除，修改保存在副本中',()=>fixture(async({sync,remote,change,rows})=>{
  const a=remote(),b=remote();await sync.run();
  await writeLog(a.id,'删除前还没上传的新内容');change(a,{deleted:true});
  await store.archiveTopic(b.id,(await store.getTopic(b.id)).revision);change(b,{map:{...b.map,raw:editSourceLog('','云端尚未读过的新内容')}});
  await sync.run();await sync.run();
  assert.equal(rows().get(b.id).deleted,true);assert.equal((await store.getTopic(a.id)).archived,true);
  const active=await store.listTopics();assert.equal(active.length,2);
  const text=await Promise.all(active.map(item=>store.readSources(item.id).then(result=>result.text)));
  assert.ok(text.includes('删除前还没上传的新内容'));assert.ok(text.includes('云端尚未读过的新内容'));
}));

test('换账号不上传另一账号内容；退出期间到达的响应不改本地',()=>fixture(async({sync,remote,login,rows,hook})=>{
  const item=remote();await sync.run();await login('b');await sync.run();assert.equal(rows().size,0);
  const other=remote('另一个账号');hook(async name=>{if(name==='gft_sync_read'){hook(null);await login(null);}});
  await sync.run();await assert.rejects(store.getTopic(other.id),{status:404});assert.equal((await store.getTopic(item.id)).name,item.name);
}));

test('上传过程中继续编辑：旧响应仅记下上传版本，不覆盖新修改或生成冲突副本',()=>fixture(async({sync,remote,hook,rows})=>{
  const item=remote();await sync.run();await writeLog(item.id,'第一笔');
  hook(async name=>{if(name==='gft_sync_write'){hook(null);await writeLog(item.id,'第二笔');}});
  await sync.run();assert.equal((await store.readSources(item.id)).text,'第二笔');await sync.run();
  assert.equal(renderSourceLog(rows().get(item.id).map.raw),'第二笔');assert.equal((await store.listTopics()).length,1);
}));

test('云端拒绝过期写入会重读，不能把拒绝记录成成功版本',()=>fixture(async({sync,remote,hook,change,rows})=>{
  const item=remote();await sync.run();await writeLog(item.id,'我的新内容');
  hook(async name=>{if(name==='gft_sync_write'){hook(null);change(item,{map:{...item.map,raw:editSourceLog('','刚到达的另一端内容')}});}});
  await sync.run();assert.equal(renderSourceLog(rows().get(item.id).map.raw),'刚到达的另一端内容');await sync.run();await sync.run();assert.equal(rows().size,2);
}));

test('浏览器编辑期间收到云端版本，保存时双方均落盘并继续同步',()=>fixture(async({sync,remote,change,rows})=>{
  const item=remote();await sync.run();
  const before=await store.getTopic(item.id),draft=bundleToMap(await store.exportTopic(item.id),item.id);
  draft.raw=editSourceLog(before.raw,'浏览器尚未保存的新文字');
  change(item,{map:{...item.map,raw:editSourceLog('','云端同时写的新文字')}});await sync.run();
  await store.saveState(item.id,before.revision,draft);
  assert.equal((await store.readSources(item.id)).text,'浏览器尚未保存的新文字');
  assert.equal((await store.listTopics()).length,2);await sync.run();
  assert.equal(rows().size,2);
  assert.deepEqual(new Set([...rows().values()].map(row=>renderSourceLog(row.map.raw))),new Set(['浏览器尚未保存的新文字','云端同时写的新文字']));
}));

test('尚未上传就删除的本地脉络不上传，也不永久等待同步',()=>fixture(async({sync,rows,hook})=>{
  const local=await store.createTopic('离线新建','主题');
  hook(async name=>{if(name==='gft_sync_write')throw new Error('暂时失败');});
  await sync.run();assert.equal(sync.snapshot().status,'pending');
  await store.archiveTopic(local.id,(await store.getTopic(local.id)).revision);hook(null);
  await sync.run();assert.equal(rows().size,0);assert.equal(sync.snapshot().status,'synced');
}));

test('单个脉络失败不阻塞其他脉络，下一轮重试失败项',()=>fixture(async({sync,rows,hook})=>{
  const broken=await store.createTopic('失败项','主题'),valid=await store.createTopic('正常项','主题');
  hook(async(name,body)=>{if(name==='gft_sync_write'&&body.topic_id===broken.id)throw new Error('暂时失败');});
  await sync.run();assert.equal(sync.snapshot().status,'pending');assert.ok(rows().has(valid.id));assert.ok(!rows().has(broken.id));
  hook(null);await sync.run();assert.equal(rows().size,2);assert.equal(sync.snapshot().status,'synced');
}));
