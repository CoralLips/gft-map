import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as store from '../store.mjs';
import {createConnections} from '../connections.mjs';
import {pendingNotices,acknowledgeNotices} from '../notifications.mjs';
import {startServer} from '../server.mjs';
import {runChangeHook} from '../change-hook.mjs';
import {installChangeHook} from '../install-hooks.mjs';

const home=await mkdtemp(path.join(tmpdir(),'gft-map-notices-'));
process.env.GFT_LOCAL_HOME=home;
after(async()=>{const rel=path.relative(tmpdir(),home);assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));await rm(home,{recursive:true,force:true});});
const api=createConnections({readers:{getChatSession:async source=>({...source,title:'测试会话'}),getChatHead:async()=>({offset:0})}});
const identity=(id,provider='codex')=>({provider,sessionId:id});
const connect=async (who,id)=>api.connectSource({source:{provider:who.provider,id:who.sessionId},topicIds:[id],history:'now'});
const ack=async(who,notices)=>acknowledgeNotices({...who,receipts:notices.map(n=>n.receipt)});
const notices=async who=>(await pendingNotices(who)).notices;
const update=async(id,text)=>{const view=await store.getView(id);return store.saveDoc(id,view.revision,view.doc+'\n\n## 新增正文\n\n'+text);};

test('通知仅有本场索引；按需读取与通知回执相互独立；无变化不重复',async()=>{
  const a=await store.createTopic('通知甲','产品范围'), b=await store.createTopic('不应泄漏','另一范围'), who=identity('notice-one');
  await update(a.id,'正文秘密不应注入');
  await connect(who,a.id);await connect(identity('other'),b.id);
  assert.deepEqual(await notices(identity('missing')),[]);
  assert.equal(await store.getSourceConnections('codex','missing'),null);
  const initial=await notices(who);
  assert.equal(initial.length,1);assert.equal(initial[0].name,'通知甲');
  assert.doesNotMatch(JSON.stringify(initial),/正文秘密|不应泄漏|ledger|raw|document/);
  await ack(who,initial);assert.deepEqual(await notices(who),[]);
  assert.equal((await api.listConnections(who))[0].loadedRevision,null);
  await api.readConnectedContext({...who,topicId:a.id});
  assert.deepEqual(await notices(who),[]);
  await update(a.id,'人的新修正');await update(a.id,'再一次修正');
  const changed=await notices(who);assert.equal(changed.length,1);assert.equal(changed[0].revision,(await store.getView(a.id)).revision);
  await ack(who,changed);assert.deepEqual(await notices(who),[]);
});

test('新版本不会被旧通知回执吞掉；断开重连、跨平台和多主题独立',async()=>{
  const a=await store.createTopic('边界','范围'),b=await store.createTopic('第二主题','范围'),who=identity('same-id');
  await connect(who,a.id); const stale=await notices(who);
  await store.renameTopic(a.id,a.revision,'新名称');await ack(who,stale);
  assert.equal((await notices(who))[0].name,'新名称');
  await connect(who,b.id);assert.equal((await notices(who)).length,2);
  const claude=identity('same-id','claude');assert.deepEqual(await notices(claude),[]);
  await connect(claude,a.id);await ack(who,await notices(who));assert.equal((await notices(claude)).length,1);
  await api.disconnectSource({...who,topicIds:[a.id]});assert.deepEqual(await notices(who),[]);
  await connect(who,a.id);assert.equal((await notices(who)).length,1);
});

test('只有来源或水位变化、布局保存、无效输出不发通知；连续历史提炼合并到发布',async()=>{
  const a=await store.createTopic('发布测试','范围'),who=identity('publish');await connect(who,a.id);await ack(who,await notices(who));
  const task=await store.createTask(a.id,'update','来源秘密');await store.completeTask(task.id,'<noop/>');
  assert.deepEqual(await notices(who),[]);
  let topic=await store.getTopic(a.id);
  const file=path.join(home,'topics',a.id+'.json');
  await writeFile(file,JSON.stringify({...topic,sourceImports:{pending:{summary:'提炼中间态'}},revision:topic.revision+1}));
  assert.deepEqual(await notices(who),[]);
  await update(a.id,'暂停历史导入时人的修正');
  const manual=await notices(who);assert.equal(manual.length,1);await ack(who,manual);
  topic=await store.getTopic(a.id);await writeFile(file,JSON.stringify({...topic,sourceImports:{},revision:topic.revision+1}));
  assert.deepEqual(await notices(who),[]);
  await update(a.id,'最后发布的图文');
  const published=await notices(who);assert.equal(published.length,1);await ack(who,published);
  const bundle=await store.getSnapshot(a.id);
  await store.saveState(a.id,bundle.topic.revision,{ledger:bundle.topic.ledger,raw:bundle.topic.raw,doc:'',watermarks:{x:'123'},nodes:[],edges:[]});
  assert.deepEqual(await notices(who),[]);
  const failed=await store.createTask(a.id,'update','不会产生有效输出');await assert.rejects(store.completeTask(failed.id,'bad'));
  assert.deepEqual(await notices(who),[]);
});

test('图关系、主题、整理/重画后的内容变化和归档按发布内容判断',async()=>{
  const a=await store.createTopic('操作','范围'),who=identity('actions');await connect(who,a.id);
  const first=await store.createTask(a.id,'update','操作');
  await store.completeTask(first.id,'<doc>\n## 决策\n### ◆ 判断甲\n依据甲。\n### ◆ 判断乙\n依据乙。\n</doc>');
  await ack(who,await notices(who));
  let view=await store.getView(a.id);
  await store.saveGraph(a.id,view.revision,{kind:'connect',from:view.graph.nodes[0].id,to:view.graph.nodes[1].id});
  assert.equal((await notices(who)).length,1);await ack(who,await notices(who));
  view=await store.getView(a.id);await store.saveDoc(a.id,view.revision,view.doc.replace('范围','新的范围'));
  assert.equal((await notices(who))[0].scope,'新的范围');await ack(who,await notices(who));
  const redraw=await store.createTask(a.id,'redraw');await store.completeTask(redraw.id,'<doc>\n## 决策\n### ◆ 新的合并判断\n依据甲乙。\n</doc>');
  assert.equal((await notices(who)).length,1);await ack(who,await notices(who));
  view=await store.getView(a.id);await store.archiveTopic(a.id,view.revision);assert.deepEqual(await notices(who),[]);
});

test('真实 HTTP 与 Hook 子进程：两种宿主输出上下文一次，不调用模型、不发送当前聊天',async()=>{
  const a=await store.createTopic('变更通知','简短范围'),who=identity('hook-real');await update(a.id,'不注入正文');await connect(who,a.id);
  let calls=0;const server=await startServer({port:0,sourceReaders:{},execute:async()=>{calls++;throw new Error('不得调用模型');}});
  const url=`http://127.0.0.1:${server.address().port}`;
  const childHook=provider=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../change-hook.mjs',import.meta.url)),'--provider',provider],{env:{...process.env,GFT_LOCAL_URL:url},windowsHide:true});
    let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
    child.stdin.end(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:who.sessionId,prompt:'用户当前秘密不要发送'}));
  });
  try {
    let result=await childHook('codex');assert.equal(result.code,0);assert.equal(result.err,'');
    const content=JSON.parse(result.out).hookSpecificOutput;
    assert.equal(content.hookEventName,'UserPromptSubmit');assert.match(content.additionalContext,/变更通知|gft_local_read/);assert.doesNotMatch(content.additionalContext,/不注入正文|用户当前秘密/);
    assert.equal((await childHook('codex')).out,'');
    await connect(identity(who.sessionId,'claude'),a.id);assert.match((await childHook('claude')).out,/additionalContext/);
    assert.equal(calls,0);assert.equal((await api.listConnections(who))[0].loadedRevision,null);
  } finally {await server.shutdown();}
});

test('Hook 写入失败不确认、下一次重试；关闭服务与不相关事件安静退出',async()=>{
  const a=await store.createTopic('重试','范围'),who=identity('retry');await connect(who,a.id);
  const server=await startServer({port:0,sourceReaders:{}});const url=`http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(runChangeHook({hook_event_name:'UserPromptSubmit',session_id:who.sessionId},{provider:'codex',url,write:async()=>{throw new Error('stdout closed');}}));
    assert.equal((await notices(who)).length,1);
    let wrote=false;await runChangeHook({hook_event_name:'SessionStart',session_id:who.sessionId},{provider:'codex',url,write:async()=>{wrote=true;}});assert.equal(wrote,false);
    await runChangeHook({hook_event_name:'UserPromptSubmit',session_id:who.sessionId},{provider:'codex',url:'https://example.com',write:async()=>{wrote=true;}});assert.equal(wrote,false);
  } finally {await server.shutdown();}
  const child=spawn(process.execPath,[fileURLToPath(new URL('../change-hook.mjs',import.meta.url)),'--provider','codex'],{env:{...process.env,GFT_LOCAL_URL:url},windowsHide:true});
  let out='';child.stdout.on('data',c=>out+=c);child.stdin.end(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:who.sessionId}));
  const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0);assert.equal(out,'');
});

test('项目 Hook 安装幂等，保存其他配置，不修改信任设置',async()=>{
  const project=path.join(home,'workspace');await mkdir(path.join(project,'.claude'),{recursive:true});
  const before={permissions:{allow:['Read']},hooks:{Stop:[{hooks:[{type:'command',command:'echo existing'}]}]}};
  await writeFile(path.join(project,'.claude/settings.local.json'),JSON.stringify(before));
  for(const provider of ['codex','claude']) {
    const installed=await installChangeHook({provider,project});assert.equal(installed.changed,true);
    assert.equal((await installChangeHook({provider,project})).changed,false);
    const saved=JSON.parse(await readFile(installed.path,'utf8'));assert.equal(saved.hooks.UserPromptSubmit.length,1);
    assert.doesNotMatch(JSON.stringify(saved),/trust|bypass/);
    if(provider==='claude') {assert.deepEqual(saved.permissions,before.permissions);assert.deepEqual(saved.hooks.Stop,before.hooks.Stop);}
  }
});
