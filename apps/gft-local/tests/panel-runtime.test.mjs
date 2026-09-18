import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer } from '../server.mjs';
import * as backend from '../store.mjs';

const entry = fileURLToPath(new URL('../web/localRuntime.ts',import.meta.url));
const nodePath = fileURLToPath(new URL('../node_modules',import.meta.url));
const cacheRoot = path.join(nodePath,'.cache');
const baseLedger = '[场次 2026-09-06T10:00:00Z · 合成回放]\n走向 p3 [主题]\n只处理合成验证材料。\n◆ j1 [验证] 原判断\n先保留原文。\n⏸ j2 [验证] 暂缓扩展\n最小闭环验证后再决定。\n← j2 j1';
const output = '<revise id="n1" title="整理后的合成判断"/>';
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function waitFor(read,accept,timeout=10000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end) {last=await read();if(accept(last))return last;await new Promise(resolve=>setTimeout(resolve,20));}
  throw new Error(`等待本地面板回归状态超时：${JSON.stringify(last)}`);
}
async function fixture(execute,run,options = {}) {
  const directory=await mkdtemp(path.join(tmpdir(),'gft-panel-runtime-'));
  await mkdir(cacheRoot,{recursive:true});
  const bundleDirectory=await mkdtemp(path.join(cacheRoot,'gft-panel-runtime-'));
  const previousHome=process.env.GFT_LOCAL_HOME,previousFetch=globalThis.fetch,previousStorage=globalThis.localStorage;
  process.env.GFT_LOCAL_HOME=directory;
  let server,local;
  try {
    const outfile=path.join(bundleDirectory,'panel-runtime.mjs');
    // Resolve dependencies from the app's own install when root node_modules is absent.
    await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'esm',nodePaths:[nodePath],logLevel:'silent'});
    const {createLocalRuntime}=await import(pathToFileURL(outfile).href);
    server=await startServer({port:0,agent:'codex',execute});
    const origin=`http://127.0.0.1:${server.address().port}`;
    const browserCache=new Map();
    globalThis.localStorage={getItem:key=>browserCache.get(key)??null,setItem:(key,value)=>browserCache.set(key,value),removeItem:key=>browserCache.delete(key)};
    globalThis.fetch=(url,options)=>previousFetch(new URL(String(url),origin),options);
    const a=await backend.createTopic('面板回放A','只处理合成验证材料。',{ledger:baseLedger,raw:baseLedger});
    const b=await backend.createTopic('面板回放B','只处理合成验证材料。',{ledger:baseLedger.replace('原判断','另一主题判断'),raw:baseLedger});
    browserCache.set('gft-local:selected',a.id);
    const errors=[];
    local=createLocalRuntime({onRequestUpdate:options.manual || (async()=>null),onError:message=>errors.push(message)});
    await local.start();
    await run({local,server,a,b,browserCache,errors,origin,fetch:previousFetch});
  } finally {
    local?.dispose();
    if(server)await server.shutdown();
    globalThis.fetch=previousFetch;
    if(previousStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=previousStorage;
    if(previousHome===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previousHome;
    const relative=path.relative(path.resolve(tmpdir()),path.resolve(directory));
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(directory).startsWith('gft-panel-runtime-'));
    await rm(directory,{recursive:true,force:true});
    const bundleRelative=path.relative(path.resolve(cacheRoot),path.resolve(bundleDirectory));
    assert.ok(bundleRelative&&!bundleRelative.startsWith('..')&&!path.isAbsolute(bundleRelative)&&path.basename(bundleDirectory).startsWith('gft-panel-runtime-'));
    await rm(bundleDirectory,{recursive:true,force:true});
  }
}

test('导入文稿直接打开Doc；保存后的列表刷新失败不当成导入失败',async()=>{
  let calls=0;
  await fixture(async()=>{calls++;return output;},async({local,origin,fetch,errors})=>{
    globalThis.fetch=(url,options)=>String(url)==='/api/topics'
      ? Promise.resolve(new Response(JSON.stringify({error:'列表暂时不可用'}),{status:503}))
      : fetch(new URL(String(url),origin),options);
    const id=await local.importTopic({format:'gft-document',version:1,name:'导入验收',text:'## 主线\n\n这是直接粘贴的材料。'});
    assert.equal(local.host.getSnapshot().currentProjectId,id);
    assert.equal(local.store.getState().rightView,'doc');
    assert.match(local.store.getState().doc,/直接粘贴的材料/);
    assert.ok(local.host.getSnapshot().projects.some(project=>project.id===id));
    assert.equal((await backend.listTopics()).length,3);
    assert.ok(errors.some(message=>message.includes('已导入')));
    assert.equal(calls,0);
  });
});

test('新建直接展示空脉络，创建响应在途不重复创建；取消材料输入不调用模型、也不强制切到Doc',async()=>{
  const held=deferred(),release=deferred();let calls=0;
  await fixture(async()=>{calls++;return output;},async({local,origin,fetch})=>{
    globalThis.fetch=async(url,options)=>{
      if(String(url)==='/api/topics'&&options?.method==='POST'){held.resolve();await release.promise;}
      return fetch(new URL(String(url),origin),options);
    };
    const pending=local.host.createProject('新脉络');
    const id=local.host.getSnapshot().currentProjectId;
    try {
      assert.ok(id);assert.equal(local.store.getState().boundProjectId,id);
      assert.equal(local.store.getState().nodes.length,0,'首帧不能显示旧图');
      assert.equal(local.host.getSnapshot().projects[0].name,'新脉络');
      assert.equal(local.host.createProject('新脉络'),pending);
      await held.promise;release.resolve();assert.equal(await pending,id);
      assert.equal((await backend.getTopic(id)).scope,'');
      await local.host.requestUpdate();
      assert.equal(local.store.getState().rightView,'map');
      assert.match(local.store.getState().doc,/## 主题/);
      assert.equal(calls,0);assert.deepEqual(await backend.listTasks(),[]);
      local.store.getState().setDocDraft('## 主题\n\n只记录社区图书角的试运营。');
      local.store.getState().flushDocEdits();local.store.getState().flushDoc();
      await waitFor(()=>backend.getView(id),topic=>topic.scope==='只记录社区图书角的试运营。');
    } finally {release.resolve();await pending;}
  });
});

test('新建失败恢复原主题；新建成功后列表刷新失败不撤销已经保存的脉络',async()=>{
  await fixture(async()=>output,async({local,a,origin,fetch,errors})=>{
    globalThis.fetch=(url,options)=>String(url)==='/api/topics'&&options?.method==='POST'
      ? Promise.resolve(new Response(JSON.stringify({error:'合成创建失败'}),{status:500}))
      : fetch(new URL(String(url),origin),options);
    assert.equal(await local.host.createProject('失败的脉络'),null);
    assert.equal(local.host.getSnapshot().currentProjectId,a.id);
    assert.equal(local.store.getState().nodes[0].title,'原判断');
    assert.equal(local.host.getSnapshot().projects.length,2);
    assert.ok(errors.includes('合成创建失败'));
    globalThis.fetch=(url,options)=>String(url)==='/api/topics'&&options?.method==='GET'
      ? Promise.resolve(new Response(JSON.stringify({error:'合成列表刷新失败'}),{status:500}))
      : fetch(new URL(String(url),origin),options);
    const id=await local.host.createProject('已保存的脉络');
    assert.ok(id);assert.equal((await backend.getTopic(id)).name,'已保存的脉络');
    assert.equal(local.host.getSnapshot().currentProjectId,id);
  });
});

test('空主题首次手工更新直接生成主题和图文，保留来源，不多跑推荐',async()=>{
  let calls=0;
  const answer='<doc>\n## 主题\n社区图书角的试运营。\n## 主线\n先确认许可再试办。\n## 试办\n### ◆ 先取得场地许可\n取得书面许可后才能开展。\n</doc>';
  await fixture(async prompt=>{calls++;assert.equal(prompt.action,'update');return answer;},async({local,errors})=>{
    const id=await local.host.createProject('新脉络');
    await local.requestManualUpdate();
    assert.equal(local.store.getState().nodes.length,1,JSON.stringify({errors,error:local.store.getState().error,doc:local.store.getState().doc}));
    local.store.getState().flushDoc();
    await waitFor(()=>backend.getView(id),view=>view.graph.nodes.length===1);
    const saved=await backend.getView(id);
    assert.equal(saved.scope,'社区图书角的试运营。');
    const sources=await backend.sourceEvents(id);
    assert.equal(sources.length,1);
    assert.equal(sources[0].inputs[0].content,'社区图书角：先取得书面许可才能试办。');
    assert.equal(sources[0].outputs.length,1);
    assert.match(saved.doc,/书面许可/);
    assert.equal(calls,1);
    assert.deepEqual(errors,[]);
  },{manual:async()=> '社区图书角：先取得书面许可才能试办。'});
});

test('改主题后重画读取被旧范围过滤的源消息，不扫描其他主题；可撤销且来源保留',async()=>{
  let calls=0;
  await fixture(async prompt=>{
    calls++;
    assert.match(prompt.system,/图书角的志愿者安排/);
    assert.match(prompt.user,/之前未入图：至少两名志愿者/);
    assert.doesNotMatch(prompt.user,/另一主题私有材料/);
    return '<doc>\n## 主线\n人员不足时暂停试办。\n## 人员\n### ◆ 至少两名志愿者\n不足两名就暂停。\n</doc>';
  },async({local,a,b,errors})=>{
    await backend.saveSourceEvent(a.id,{id:'source',layer:'L0->L1',sourceMeta:{sessionId:'source-a'},inputs:[{id:'excluded',role:'user',content:'之前未入图：至少两名志愿者，不足就暂停。'}],outputs:[]});
    await backend.saveSourceEvent(b.id,{id:'other',layer:'L0->L1',inputs:[{id:'private',role:'user',content:'另一主题私有材料'}],outputs:[]});
    const old=local.store.getState().nodes.map(node=>node.title);
    local.store.getState().setDocDraft(local.store.getState().doc.replace('只处理合成验证材料。','图书角的志愿者安排。'));
    await local.store.getState().redrawFromLedger();
    assert.equal(local.store.getState().nodes.length,1);
    assert.equal(local.store.getState().nodes[0].title,'至少两名志愿者');
    assert.equal((await backend.sourceEvents(a.id)).some(event=>event.inputs?.some?.(input=>input.id==='excluded')),true);
    local.store.getState().undo();
    assert.deepEqual(local.store.getState().nodes.map(node=>node.title),old);
    assert.equal(calls,1);assert.deepEqual(errors,[]);
  });
});

test('源消息存在但 Log 没有节点仍可重画；长来源先提炼，中途不展示半成品',async()=>{
  let calls=0,localRef;
  await fixture(async prompt=>{
    calls++;
    assert.equal(localRef.store.getState().nodes.length,0);
    if(prompt.system.includes('"summary"')) return JSON.stringify({summary:'社区图书角至少两名志愿者，不足就暂停。'});
    assert.match(prompt.user,/至少两名志愿者/);
    assert.ok(prompt.user.length<20000);
    return '<doc>\n## 主线\n先落实人员。\n## 人员\n### ◆ 两名志愿者才能试办\n不足就暂停。\n</doc>';
  },async({local,errors})=>{
    localRef=local;
    const id=await local.host.createProject('重画空图');
    local.store.getState().setDocDraft('## 主题\n\n社区图书角的人员安排。');
    local.store.getState().flushDocEdits();local.store.getState().flushDoc();
    await waitFor(()=>backend.getView(id),view=>view.scope.includes('人员安排'));
    await backend.saveSourceEvent(id,{id:'saved-long',layer:'L0->L1',inputs:[{id:'long',role:'user',content:'社区图书角至少两名志愿者，不足就暂停。'.repeat(1600)}],outputs:[]});
    await local.store.getState().syncFromRemote();
    assert.equal(local.host.getSnapshot().hasSourceMaterial,true);
    await local.store.getState().redrawFromLedger();
    assert.equal(local.store.getState().nodes.length,1);
    assert.ok(calls>=3);
    assert.deepEqual(errors,[]);
  });
});

test('重画提炼中取消，不继续下一批、不保存半成品，来源保留',async()=>{
  const started=deferred(),release=deferred();let calls=0;
  await fixture(async prompt=>{calls++;assert.match(prompt.system,/summary/);started.resolve();await release.promise;return JSON.stringify({summary:'合成材料摘要'});},async({local,a})=>{
    await backend.saveSourceEvent(a.id,{id:'long-cancel',layer:'L0->L1',inputs:[{id:'long',role:'user',content:'只处理合成验证材料。'.repeat(3000)}],outputs:[]});
    const before=local.store.getState().nodes;
    const running=local.store.getState().redrawFromLedger();
    try {
      await started.promise;local.store.getState().cancelGeneration();
      await waitFor(()=>backend.listTasks(),tasks=>tasks.some(task=>task.status==='cancelled'));
      release.resolve();await running;await new Promise(resolve=>setTimeout(resolve,60));
      assert.equal(calls,1);assert.deepEqual(local.store.getState().nodes,before);
      assert.equal((await backend.sourceEvents(a.id)).length,1);
    } finally {release.resolve();await running;}
  });
});

test('新建期间切换主题不被迟到响应拉回；重命名立即显示且串行保存最后输入',async()=>{
  const held=deferred(),release=deferred();
  await fixture(async()=>output,async({local,b,origin,fetch})=>{
    globalThis.fetch=async(url,options)=>{
      if(String(url)==='/api/topics'&&options?.method==='POST'){held.resolve();await release.promise;}
      return fetch(new URL(String(url),origin),options);
    };
    const pending=local.host.createProject('后台完成创建');
    try {
      await held.promise;await local.host.switchProject(b.id);
      release.resolve();await pending;
      assert.equal(local.host.getSnapshot().currentProjectId,b.id);
      assert.equal(local.store.getState().boundProjectId,b.id);
      const first=local.host.renameProject(b.id,'第一次名称');
      assert.equal(local.host.getSnapshot().projects.find(p=>p.id===b.id).name,'第一次名称');
      const second=local.host.renameProject(b.id,'最终名称');
      assert.equal(local.host.getSnapshot().projects.find(p=>p.id===b.id).name,'最终名称');
      await Promise.all([first,second]);
      assert.equal((await backend.getTopic(b.id)).name,'最终名称');
      assert.equal(local.host.getSnapshot().projects.find(p=>p.id===b.id).name,'最终名称');
    } finally {release.resolve();await pending;}
  });
});

test('手改立即整理，超过原1.2秒防抖窗口仍完成；模型只计算，面板只应用与保存一次',async()=>{
  const observed=[];
  await fixture(async task=>{
    observed.push({phase:'start',revision:(await backend.getTopic(task.topicId)).revision,baseRevision:task.baseRevision});
    await new Promise(resolve=>setTimeout(resolve,1450));
    observed.push({phase:'finish',revision:(await backend.getTopic(task.topicId)).revision,baseRevision:task.baseRevision});
    return output;
  },async({local,a})=>{
    local.store.getState().updateNode('j1',{title:'刚刚手改的判断'});
    const report=await local.store.getState().tidyWhitebox();
    assert.equal(report?.changed,true,local.store.getState().error??'整理未完成');
    assert.equal(local.store.getState().error,null);
    assert.deepEqual(observed,[{phase:'start',revision:2,baseRevision:2},{phase:'finish',revision:2,baseRevision:2}]);
    const calculated=await backend.getTopic(a.id);
    assert.equal(calculated.revision,2,'后台compute完成不能自行落账');
    assert.doesNotMatch(calculated.ledger,/整理后的合成判断/);
    assert.equal(local.store.getState().nodes[0].title,'整理后的合成判断');
    local.store.getState().flushDoc();
    const saved=await waitFor(()=>backend.getTopic(a.id),topic=>topic.revision===3);
    assert.equal(saved.ledger.match(/整理后的合成判断/g)?.length,1,'结果不能重复追加');
    assert.equal(saved.raw,calculated.raw);
    assert(saved.raw.startsWith(baseLedger));
    assert.match(saved.raw,/刚刚手改的判断/);
    assert.doesNotMatch(saved.raw,/整理后的合成判断/);
    assert.equal((await backend.listTasks()).filter(task=>task.mode==='compute').length,1);
    assert.equal((await backend.listTasks())[0].status,'completed');
  });
});

test('多轮整理的中间轮只计算，最后一次提交保存；选区仍由共享store维护',async()=>{
  let calls=0;
  await fixture(async task=>{
    calls++;
    assert.equal((await backend.getTopic(task.topicId)).revision,task.baseRevision);
    return calls===1
      ? '<merge title="合并前两判断" body="保留两条合成依据。" members="n1,n2"/>'
      : '<merge title="再合并相邻判断" body="保留原始三条依据。" members="n1,n2"/>';
  },async({local,a})=>{
    const extra=Array.from({length:5},(_,i)=>`◇ j${i+4} [验证] 合成判断${i+4}\n独立合成依据${i+4}`).join('\n');
    local.store.getState().updateLedger(`${baseLedger.replace('⏸ j2','◇ j2')}\n${extra}`);
    const report=await local.store.getState().tidyWhitebox();
    assert.equal(report?.changed,true,local.store.getState().error??'整理未完成');
    assert.ok(calls>1,'七条素材应触发多个安全收拢轮次');
    assert.equal((await backend.getTopic(a.id)).revision,2,'中间轮不能保存部分整理结果');
    local.store.getState().flushDoc();
    const saved=await waitFor(()=>backend.getTopic(a.id),topic=>topic.revision===3);
    assert.equal(saved.raw,baseLedger);
    assert.equal((await backend.listTasks()).filter(task=>task.status==='completed').length,calls);
  });
});

test('第一轮只改正文时追加一次明确收拢请求，归并补充说明并保留可撤销的一次提交',async()=>{
  let calls=0;
  await fixture(async task=>{
    calls++;
    if(calls===1) return '<prose domain="验证" refs="n1,n2,n3,n4,n5,n6">先验证需求，随后再评估开发。保留三位访谈对象与记录拒绝原因的要求。</prose>';
    assert.match(task.user,/上一轮尚未完成收拢/);
    assert.match(task.system,/补充理由、示例/);
    return '<merge title="先访谈验证需求" body="先找三位访谈对象并记录拒绝原因。" members="n1,n2,n3"/>';
  },async({local})=>{
    local.store.getState().updateLedger('[场次 2026-09-18T10:00:00Z · 合成验证]\n走向 p1 [主题]\n仅记录需求验证。\n'+Array.from({length:6},(_,i)=>`◇ j${i+1} [验证] 合成判断${i+1}\n保留依据${i+1}`).join('\n'));
    const report=await local.store.getState().tidyWhitebox();
    assert.equal(calls,2); assert.equal(report.before,6); assert.equal(report.after,4);
    assert.match(local.store.getState().doc,/三位访谈对象/);
    local.store.getState().undo();
    assert.equal(local.store.getState().nodes.length,6);
  });
});

test('两次都无可合并结果时停止，不无限调用，也不删除独立判断凑比例',async()=>{
  let calls=0;
  await fixture(async()=>{calls++;return '<noop/>';},async({local})=>{
    local.store.getState().updateLedger('[场次 2026-09-18T10:00:00Z · 合成验证]\n走向 p1 [主题]\n仅记录需求验证。\n'+Array.from({length:6},(_,i)=>`◇ j${i+1} [验证] 独立判断${i+1}`).join('\n'));
    const report=await local.store.getState().tidyWhitebox();
    assert.equal(calls,2); assert.equal(report.before,report.after); assert.equal(report.changed,false);
  });
});

test('计算中切换主题即取消旧任务，迟到输出不能写旧主题或新主题',async()=>{
  const started=deferred(),release=deferred();
  await fixture(async()=>{started.resolve();await release.promise;return output;},async({local,a,b})=>{
    const originalA=await backend.getTopic(a.id),originalB=await backend.getTopic(b.id);
    const send=globalThis.fetch, cancellationTrace=[];
    globalThis.fetch=async(url,options)=>{
      const isCancel=String(url).endsWith('/cancel');
      if(isCancel)cancellationTrace.push({request:String(url)});
      try {const response=await send(url,options);if(isCancel)cancellationTrace.push({status:response.status,body:await response.clone().json()});return response;}
      catch(error){if(isCancel)cancellationTrace.push({error:error.message});throw error;}
    };
    const running=local.store.getState().tidyWhitebox();
    try {
      await started.promise;
      await local.host.switchProject(b.id);
      const cancelled=await waitFor(()=>backend.listTasks(),tasks=>tasks.some(task=>task.status==='cancelled')).catch(error=>{throw new Error(`${error.message}; cancel=${JSON.stringify(cancellationTrace)}`);});
      assert.equal(cancelled[0].topicId,a.id);
      release.resolve();await running;
      assert.equal(local.store.getState().boundProjectId,b.id);
      assert.equal(local.store.getState().nodes[0].title,'另一主题判断');
      assert.equal(local.store.getState().isTidying,false);
      assert.deepEqual(await backend.getTopic(a.id),originalA);
      assert.deepEqual(await backend.getTopic(b.id),originalB);
    } finally {release.resolve();await running;}
  });
});

test('外部写入使本地保存CAS冲突时，远端不被覆盖，手改与pending镜像保留',async()=>{
  await fixture(async()=>output,async({local,a,browserCache})=>{
    const before=await backend.getTopic(a.id);
    await backend.saveGraph(a.id,before.revision,{kind:'edit',id:'j1',title:'外部刚写入的判断'});
    local.store.getState().updateNode('j1',{title:'本地未保存的手改'});
    local.store.getState().flushDoc();
    await waitFor(()=>local.store.getState().error,Boolean);
    assert.match(local.store.getState().error,/修改|版本|冲突/);
    assert.equal((await backend.getView(a.id)).graph.nodes[0].title,'外部刚写入的判断');
    assert.equal(local.store.getState().nodes[0].title,'本地未保存的手改');
    const mirror=JSON.parse(browserCache.get(`gft-local:panel:${a.id}`));
    assert.equal(mirror.pending,true);assert.match(mirror.map.ledger,/本地未保存的手改/);
  });
});

test('状态轮询断开后仍取消后台计算，失败退出不遗留占队列的任务',async()=>{
  const release=deferred();let executing=false;
  await fixture(async()=>{executing=true;await release.promise;return output;},async({local,a,origin,fetch})=>{
    const before=await backend.getTopic(a.id);let failed=false;
    globalThis.fetch=(url,options)=>{
      if(String(url).endsWith('/status')&&executing&&!failed){failed=true;return Promise.reject(new Error('合成轮询连接断开'));}
      return fetch(new URL(String(url),origin),options);
    };
    try {
      assert.equal(await local.store.getState().tidyWhitebox(),null);
      assert.match(local.store.getState().error??'',/合成轮询连接断开/);
      await waitFor(()=>backend.listTasks(),tasks=>tasks.some(task=>task.status==='cancelled'));
      assert.deepEqual(await backend.getTopic(a.id),before);
    } finally {release.resolve();}
  });
});

test('关闭面板使已完成但响应在途的refine失效，不产生迟到保存',async()=>{
  const held=deferred(),release=deferred();
  await fixture(async()=>'<node title="关闭后的迟到润色"/>',async({local,a,origin,fetch})=>{
    const before=await backend.getTopic(a.id);
    globalThis.fetch=async(url,options)=>{
      const response=await fetch(new URL(String(url),origin),options);
      if(String(url).endsWith('/result')) {held.resolve();await release.promise;}
      return response;
    };
    const refining=local.store.getState().refineNode('j1');
    try {
      await held.promise;local.dispose();release.resolve();await refining;
      assert.equal(local.store.getState().boundProjectId,null);
      assert.equal(local.store.getState().nodes.length,0);
      assert.deepEqual(await backend.getTopic(a.id),before);
    } finally {release.resolve();}
  });
});

test('同一主题的快速手工新增和独立并发来源写入均不丢存证',async()=>{
  await fixture(async()=>output,async({local,a,errors})=>{
    const one=local.store.getState().addNode({title:'第一条手工原话'});
    const two=local.store.getState().addNode({title:'第二条手工原话'});
    const event=id=>({layer:'L0->L1',inputs:[{id,role:'user',name:null,content:'独立合成来源',ts:1}],outputs:[id],sourceMeta:{sessionId:'manual',sessionTitle:'并发来源',fromId:id,toId:id,count:1}});
    await Promise.all([backend.saveSourceEvent(a.id,event('external-one')),backend.saveSourceEvent(a.id,event('external-two'))]);
    const sources=await waitFor(()=>backend.sourceEvents(a.id),items=>items.length===4);
    assert.deepEqual(new Set(sources.flatMap(source=>source.outputs)),new Set([one,two,'external-one','external-two']));
    assert.deepEqual(errors,[]);
    local.store.getState().flushDoc();await waitFor(()=>backend.getTopic(a.id),topic=>topic.revision===2);
  });
});

test('旧保存响应晚于重新加载的新版本时，不倒退浏览器保存基准',async()=>{
  const held=deferred(),release=deferred();
  await fixture(async()=>output,async({local,a,b,browserCache,origin,fetch})=>{
    let capture=true;
    globalThis.fetch=async(url,options)=>{
      const response=await fetch(new URL(String(url),origin),options);
      if(String(url).endsWith('/state')&&capture){capture=false;held.resolve();await release.promise;}
      return response;
    };
    local.store.getState().updateNode('j1',{title:'较早保存的本地修改'});local.store.getState().flushDoc();
    try {
      await held.promise;
      const saved=await backend.getTopic(a.id);assert.equal(saved.revision,2);
      await backend.saveGraph(a.id,2,{kind:'add',title:'外部后来的独立判断',content:'新增依据'});
      await local.host.switchProject(b.id);await local.host.switchProject(a.id);
      assert.equal(JSON.parse(browserCache.get(`gft-local:panel:${a.id}`)).revision,3,'已接受外部新版本');
      release.resolve();
      await new Promise(resolve=>setTimeout(resolve,30));
      assert.equal(JSON.parse(browserCache.get(`gft-local:panel:${a.id}`)).revision,3,'旧保存回执不能把基准退回2');
      local.store.getState().flushDoc();
      await waitFor(()=>backend.getTopic(a.id),topic=>topic.revision===4);
      assert.equal(local.store.getState().error,null);
      assert.match((await backend.getTopic(a.id)).ledger,/外部后来的独立判断/);
    } finally {release.resolve();}
  });
});

test('页面退出只保活小型取消请求，连续dispose两次仅取消一次且正文保存不占退出配额',async()=>{
  const started=deferred(),release=deferred();
  await fixture(async()=>{started.resolve();await release.promise;return output;},async({local,a,origin,fetch})=>{
    const traffic=[];
    globalThis.fetch=(url,options)=>{
      traffic.push({url:String(url),keepalive:options?.keepalive,body:options?.body});
      return fetch(new URL(String(url),origin),options);
    };
    local.store.getState().updateNode('j1',{title:'退出前已保存的手工修改'});
    const running=local.store.getState().tidyWhitebox();
    try {
      await started.promise;
      const before=await backend.getTopic(a.id);
      local.dispose();local.dispose();
      await waitFor(()=>backend.listTasks(),tasks=>tasks.some(task=>task.status==='cancelled'));
      release.resolve();await running;
      await waitFor(()=>local.store.getState().isTidying,value=>!value);
      const cancellations=traffic.filter(request=>request.url.endsWith('/cancel'));
      assert.equal(cancellations.length,1,'abort、异常收尾与重复dispose应共用同一取消请求');
      assert.equal(cancellations[0].keepalive,true);
      assert.equal(cancellations[0].body,'{}');
      assert.ok(traffic.some(request=>request.url.endsWith('/state')),'该场景必须包含正文保存');
      assert.ok(traffic.filter(request=>!request.url.endsWith('/cancel')).every(request=>request.keepalive!==true),'正文和模型请求不能争用退出保活配额');
      assert.equal(local.store.getState().boundProjectId,null);
      assert.deepEqual(await backend.getTopic(a.id),before);
    } finally {release.resolve();await running;}
  });
});
