import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {appendSourceLog,editSourceLog,renderSourceLog,createTopicBundle,parseTopicBundle,bundleToMap,mapToBundle} from '../dist/core.mjs';
import {sourcePage} from '../memory.mjs';
import * as store from '../store.mjs';

const receipt={v:1,provider:'codex',sessionId:'chat',id:'m1',role:'user',content:'待删除的旧来源',title:'合成会话'};
const sourceEvent={id:'old',layer:'L0->L1',outputs:[],inputs:[{id:receipt.id,role:receipt.role,content:receipt.content}],sourceMeta:{provider:receipt.provider,sessionId:receipt.sessionId}};
async function fixture(run) {
  const directory=await mkdtemp(path.join(tmpdir(),'gft-log-edit-'));
  const previous=process.env.GFT_LOCAL_HOME;process.env.GFT_LOCAL_HOME=directory;
  try {await run(directory);} finally {
    if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;
    const relative=path.relative(path.resolve(tmpdir()),path.resolve(directory));
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(directory).startsWith('gft-log-edit-'));
    await rm(directory,{recursive:true,force:true});
  }
}
async function saveLog(id,text) {
  const topic=await store.getTopic(id),view=await store.getView(id);
  return store.saveState(id,topic.revision,{ledger:topic.ledger,raw:editSourceLog(topic.raw,text),nodes:view.graph.nodes,edges:view.graph.edges,doc:view.doc,watermarks:{}});
}

test('编辑 Log 持久化不重生快照、不改变图文/水位；重画、Agent、迁移读取编辑版，后续增量仍能追加',async()=>fixture(async directory=>{
  const created=await store.createTopic('编辑来源','只看合成材料',{raw:appendSourceLog('',[receipt])});
  await store.saveSourceEvent(created.id,sourceEvent);
  const file=path.join(directory,'topics',`${created.id}.json`);
  const initial=JSON.parse(await readFile(file,'utf8'));
  const cursors={'binding:1':{cursor:{offset:9},taskId:'prior'}};
  await writeFile(file,JSON.stringify({...initial,sourceCursors:cursors,sourceUpdates:{old:sourceEvent}}));
  const text='我修改了来源。\n\n第二段先放这里。\n';
  const saved=await saveLog(created.id,text);
  assert.equal(saved.doc,created.doc);assert.deepEqual(saved.graph,created.graph);
  const reloaded=await store.getTopic(created.id);
  assert.equal(renderSourceLog(reloaded.raw),text);
  assert.deepEqual(reloaded.sourceCursors,cursors);
  await store.saveSourceEvent(created.id,{...sourceEvent,id:'late-archive',inputs:[{id:'late-old',role:'user',content:'延迟保存的旧快照也不能补回'}]});
  assert.equal((await store.history(created.id)).sourceText,text);
  const index=await store.getTopicIndex(created.id);
  assert.equal(index.raw,undefined);assert.equal(index.sourceUpdates,undefined);assert.equal(typeof index.summary,'string');
  assert.equal((await store.readSources(created.id)).text,text);
  assert.doesNotMatch(JSON.stringify(await store.sourceEvents(created.id)),/待删除的旧来源/);
  const redraw=await store.createTask(created.id,'redraw');
  assert.equal((await store.taskPrompt(redraw.id)).user,text);
  await store.setTaskStatus(redraw.id,'cancelled');
  const bundle=await store.exportTopic(created.id);
  assert.equal(bundle.version,3);
  assert.equal(renderSourceLog(bundle.topic.raw),text);
  assert.deepEqual(mapToBundle(bundle.topic.name,bundleToMap(bundle,'portable')),bundle);
  const imported=await store.importTopic(JSON.parse(JSON.stringify(bundle)));
  assert.equal((await store.readSources(imported.id)).text,text);
  const update=await store.createTask(created.id,'update','后来的新材料');
  await store.completeTask(update.id,'<noop/>');
  const current=(await store.history(created.id)).sourceText;
  assert.ok(current.startsWith(text));assert.match(current,/后来的新材料/);assert.doesNotMatch(current,/待删除的旧来源/);
  assert.deepEqual((await store.getTopic(created.id)).sourceCursors,cursors);
  const empty=await saveLog(created.id,'');
  assert.equal((await store.history(created.id)).sourceText,'');
  assert.deepEqual(await store.sourceEvents(created.id),[]);
  assert.equal((await store.readSources(created.id)).text,'');
  await assert.rejects(store.createTask(created.id,'redraw'),/没有可供重画/);
  const emptyCopy=await store.importTopic(await store.exportTopic(created.id));
  assert.equal((await store.readSources(emptyCopy.id)).text,'');
  await assert.rejects(store.saveState(created.id,empty.revision-1,{ledger:initial.ledger,raw:initial.raw,nodes:[],edges:[],watermarks:{}}),{status:409});
}));

test('编辑后的迁移包忽略旧兼容快照；未知 Log 版本拒绝处理',()=>{
  const raw=editSourceLog(appendSourceLog('',[receipt]),'');
  const bundle=createTopicBundle('空来源',{ledger:'',raw});
  const parsed=parseTopicBundle({...bundle,sources:[sourceEvent]});
  assert.equal(renderSourceLog(parsed.topic.raw),'');
  assert.equal(parsed.version,3);
  assert.throws(()=>parseTopicBundle({...bundle,topic:{...bundle.topic,raw:'来源正文 {"v":4,"text":"未来内容"}'}}),/升级/);
});

test('Agent 来源分页只读有效文本，追加可续读，人工重写使旧游标失效',()=>{
  const text='修订后的长材料🙂'.repeat(3000);
  const raw=editSourceLog(appendSourceLog('',[receipt]),text);
  let page=sourcePage('a',raw),combined=page.text;const first=page;
  assert.equal(first.legacyOnly,false);
  while(page.nextCursor){page=sourcePage('a',raw,page.nextCursor);combined+=page.text;}
  assert.equal(combined,text);assert.doesNotMatch(combined,/待删除|来源正文|seen|editId/);
  const added=appendSourceLog(raw,[{...receipt,id:'m2',content:'追加新消息'}]);
  assert.doesNotThrow(()=>sourcePage('a',added,first.nextCursor));
  assert.throws(()=>sourcePage('a',editSourceLog(raw,'不同的开头'+text),first.nextCursor),/已改变/);
});
