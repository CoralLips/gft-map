import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as store from '../store.mjs';
import { createConnections } from '../connections.mjs';
import { readSourceLog } from '../dist/core.mjs';


const sandbox = await mkdtemp(path.join(tmpdir(),'gft-local-connections-test-'));
const previousHome = process.env.GFT_LOCAL_HOME;
process.env.GFT_LOCAL_HOME = sandbox;
after(async () => {
  if (previousHome === undefined) delete process.env.GFT_LOCAL_HOME; else process.env.GFT_LOCAL_HOME = previousHome;
  const relative = path.relative(path.resolve(tmpdir()),sandbox);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.ok(path.basename(sandbox).startsWith('gft-local-connections-test-'));
  await rm(sandbox,{recursive:true,force:true});
});

function fixture({batchSize = 100} = {}) {
  const sessions = new Map();
  const key = source => `${source.provider}:${source.id}`;
  const get = source => {
    const entry = sessions.get(key(source));
    if (!entry) throw store.fail('真实会话不存在',404);
    if (source.cwd && source.cwd !== entry.descriptor.cwd) throw store.fail('会话目录不匹配',404);
    return entry;
  };
  const readers = {
    async getChatSession(source) { return {...get(source).descriptor}; },
    async getChatHead(source) { return {offset:get(source).messages.length}; },
    async readChatDelta(source,cursor,{limit,until}) {
      const entry = get(source), start = cursor?.offset || 0;
      const end = until?.offset ?? entry.messages.length;
      const messages = entry.messages.slice(start,Math.min(end,start + Math.min(limit,batchSize)));
      return {messages:structuredClone(messages),cursor:{offset:start + messages.length},hasMore:start + messages.length < end};
    },
  };
  return {...createConnections({readers}),add(provider = 'codex',id = randomUUID(),messages = []) {
    const descriptor = {provider,id,title:`真实 ${provider} 合成会话`,cwd:`${sandbox}/workspace`,updatedAt:'2026-01-01T00:00:00Z'};
    sessions.set(key(descriptor),{descriptor,messages:[...messages]}); return descriptor;
  },append(source,...messages) { get(source).messages.push(...messages); }};
}
const message = (id,content = `仅供回查的源消息 ${id}`,extra = {}) => ({id,role:'user',content,timestamp:'2026-01-01T00:00:00Z',...extra});
const output = title => `<doc>\n## 工程取舍\n### ◆ ${title}\n先保护已有判断，再添加新的取舍。\n</doc>`;
const topic = name => store.createTopic(name,'仅记录本地编辑的工程判断');
const binding = async (api,source,target,history = 'all') => (await api.connectSource({source,topicIds:[target.id],history}))[0];
const cursorOf = async (target,connection) => (await store.getTopic(target.id)).sourceCursors?.[store.sourceCursorKey(connection)]?.cursor;

test('来源必须真实核验；连接多主题是增量操作，连接与读取版本分开，列表无原文或游标',async () => {
  const api = fixture(), source = api.add(), a = await topic('连接甲'), b = await topic('连接乙');
  await assert.rejects(api.connectSource({source:{...source,id:'伪造'},topicIds:[a.id],history:'all'}),{status:404});
  assert.deepEqual(await api.listConnections(),[]);
  const first = await binding(api,{...source,title:'客户端伪造标题'},a);
  assert.equal(first.source.title,source.title);
  assert.equal(first.loadedRevision,null);
  const context = await api.readConnectedContext({provider:source.provider,sessionId:source.id,topicId:a.id});
  assert.equal(context.projects[0].revision,a.revision);
  assert.equal(context.connections[0].loadedRevision,a.revision);
  await api.connectSource({source,topicIds:[b.id],history:'now',writeProjectId:b.id});
  await api.connectSource({source,topicIds:[a.id],history:'now'});
  const connected = await api.listConnections({provider:source.provider,sessionId:source.id});
  assert.equal(connected.length,2);
  assert.equal(connected.find(item => item.topicId === a.id).loadedRevision,a.revision);
  assert.equal(connected.find(item => item.topicId === a.id).history,'all');
  assert.equal(connected.find(item => item.topicId === b.id).loadedRevision,null);
  assert.deepEqual(connected.find(item => item.topicId === a.id).topic,{id:a.id,name:a.name,scope:a.scope,revision:a.revision,updatedAt:a.updatedAt,status:'active',summary:''});
  assert.doesNotMatch(JSON.stringify(connected), /"(?:raw|ledger|document|messages|initialCursor|fromCursor|toCursor)"/);
  const all = await api.readConnectedContext({provider:source.provider,sessionId:source.id,topicId:b.id});
  assert.deepEqual(new Set(all.projects.map(project => project.id)),new Set([b.id]));
  assert.equal(all.writeProjectId,b.id);
  assert.doesNotMatch(JSON.stringify(all), /"(?:raw|ledger|input|messages|initialCursor|fromCursor|toCursor)"/);
  await store.renameTopic(a.id,a.revision,'连接甲新版');
  assert.equal((await api.listConnections({topicId:a.id}))[0].loadedRevision,a.revision);
  const reread = await api.readConnectedContext({provider:source.provider,sessionId:source.id,topicId:a.id});
  assert.equal(reread.connections[0].loadedRevision,a.revision + 1);
});

test('真实会话没有 cwd 元数据仍可按 provider 与 ID 核验连接',async () => {
  const source={provider:'claude',id:randomUUID(),title:'没有目录元数据的真实会话',cwd:null,updatedAt:null};
  const requests=[];
  const api=createConnections({readers:{getChatSession:async request=>{requests.push(request);return source;},getChatHead:async()=>({offset:0})}});
  const a=await topic('未知来源目录');
  const connection=(await api.connectSource({source,topicIds:[a.id],history:'now'}))[0];
  assert.equal(connection.source.cwd,null);
  assert.equal(connection.verified,true);
  assert.deepEqual(requests,[{provider:source.provider,id:source.id}]);
});

test('相同会话 ID 的平台互相隔离；移除一个主题与全部断开只影响选中连接',async () => {
  const api = fixture(), id = randomUUID(), codex = api.add('codex',id), claude = api.add('claude',id);
  const a = await topic('断开甲'), b = await topic('断开乙');
  const [ca,cb] = await api.connectSource({source:codex,topicIds:[a.id,b.id],history:'all',writeProjectId:b.id});
  const other = await binding(api,claude,a);
  assert.deepEqual(await api.disconnectSource({connectionId:ca.id}),{disconnected:[ca.id]});
  assert.deepEqual((await api.listConnections({provider:'codex',sessionId:id})).map(item=>item.id),[cb.id]);
  await assert.rejects(api.readConnectedContext({provider:'codex',sessionId:id,topicId:a.id}),{status:404});
  await assert.rejects(api.disconnectSource({}),{status:400});
  assert.deepEqual(await api.disconnectSource({provider:'codex',sessionId:id}),{disconnected:[cb.id]});
  assert.deepEqual((await api.listConnections({sessionId:id})).map(item=>item.id),[other.id]);
  assert.deepEqual(await api.disconnectSource({topicIds:[a.id]}),{disconnected:[other.id]});
  assert.deepEqual(await api.listConnections({sessionId:id}),[]);
});

test('now 排除已有材料，all 独立从头读取；成功同次原子保存图文、真实来源与每主题水位',async () => {
  const api = fixture(), source = api.add('codex',undefined,[message('old')]);
  const a = await topic('现在开始'), b = await topic('包含历史');
  const ca = await binding(api,source,a,'now'), cb = await binding(api,source,b,'all');
  assert.equal((await api.createSourceUpdate(a.id,{connectionId:ca.id})).unchanged,true);
  api.append(source,message('new','新材料正文'),message('draft','仍在推敲',{role:'assistant',phase:'commentary',turnStatus:'interrupted'}));
  const created = await api.createSourceUpdate(a.id,{connectionId:ca.id});
  const pending = await store.getTask(created.task.id), request = await store.taskPrompt(pending.id);
  assert.deepEqual(pending.source.messages.map(item=>item.id),['new','draft']);
  assert.match(request.user,/用户：\n新材料正文/);
  assert.match(request.user,/助手（过程说明；本轮已中断，内容未完成）/);
  assert.doesNotMatch(JSON.stringify(created),/"(?:input|messages|fromCursor|toCursor|initialCursor)"/);
  assert.equal(await cursorOf(a,ca),undefined);
  const updated = await store.completeTask(pending.id,output('保持本地反馈'));
  assert.equal(updated.graph.nodes.length,1);
  assert.deepEqual(await cursorOf(a,ca),{offset:3});
  assert.equal(await cursorOf(b,cb),undefined);
  assert.equal((await api.createSourceUpdate(a.id,{connectionId:ca.id})).unchanged,true);
  const other = await api.createSourceUpdate(b.id,{connectionId:cb.id});
  assert.deepEqual((await store.getTask(other.task.id)).source.messages.map(item=>item.id),['old','new','draft']);
  await store.completeTask(other.task.id,'<noop/>');
  assert.deepEqual(await cursorOf(b,cb),{offset:3});
  const sources = await store.sourceEvents(a.id);
  assert.equal(sources.length,1);
  assert.equal(sources[0].inputs[0].content,'新材料正文');
  assert.equal(sources[0].inputs[1].turnStatus,'interrupted');
  assert.deepEqual(sources[0].outputs,updated.graph.nodes.map(node=>node.id));
  assert.equal(sources[0].sourceMeta.sessionId,source.id);
  const context = await api.readConnectedContext({provider:source.provider,sessionId:source.id,topicId:a.id});
  assert.doesNotMatch(JSON.stringify(context),/新材料正文|仍在推敲/);
  await store.saveSourceEvent(a.id,{layer:'L0->L1',outputs:[],inputs:[],sourceMeta:{sessionId:'manual'}});
  assert.equal((await store.sourceEvents(a.id)).filter(event=>event.id===pending.id).length,1);
  await store.clearSourceEvents(a.id);
  assert.equal((await store.sourceEvents(a.id)).length,1);
  assert.deepEqual(await cursorOf(a,ca),{offset:3});
});

test('并发点击同来源只产生一个任务，不同主题各自排队；分批成功才前进水位',async () => {
  const api = fixture({batchSize:1}), source = api.add('codex',undefined,[message('first'),message('second')]);
  const a = await topic('分页甲'), b = await topic('分页乙');
  const ca = await binding(api,source,a), cb = await binding(api,source,b);
  const concurrent = await Promise.allSettled([api.createSourceUpdate(a.id,{connectionId:ca.id}),api.createSourceUpdate(a.id,{connectionId:ca.id})]);
  const first = concurrent.find(result=>result.status==='fulfilled').value;
  for (const result of concurrent.filter(result=>result.status==='rejected')) assert.equal(result.reason.status,409);
  const same = await api.createSourceUpdate(a.id,{connectionId:ca.id});
  assert.equal(same.task.id,first.task.id);
  assert.equal(same.reused,true);
  assert.equal(first.hasMore,true);
  const other = await api.createSourceUpdate(b.id,{connectionId:cb.id});
  assert.notEqual(other.task.id,first.task.id);
  assert.equal((await store.listTasks()).filter(task=>task.source?.connectionId===ca.id).length,1);
  await store.completeTask(first.task.id,output('第一条已保存'));
  const second = await api.createSourceUpdate(a.id,{connectionId:ca.id});
  assert.equal(second.hasMore,false);
  assert.deepEqual((await store.getTask(second.task.id)).source.messages.map(item=>item.id),['second']);
  await store.completeTask(second.task.id,output('第二条已保存'));
  assert.equal((await store.getView(a.id)).graph.nodes.length,2);
  assert.deepEqual(await cursorOf(a,ca),{offset:2});
  assert.equal(await cursorOf(b,cb),undefined);
  await store.setTaskStatus(other.task.id,'cancelled');
});

test('无效输出、失败和取消不推进；手工保存使旧任务冲突，重发仍读取原增量',async () => {
  const api = fixture(), source = api.add('claude',undefined,[message('keep')]), a = await topic('失败保护');
  const connection = await binding(api,source,a);
  const first = (await api.createSourceUpdate(a.id,{connectionId:connection.id})).task;
  await assert.rejects(store.completeTask(first.id,'不是协议输出'));
  assert.equal((await store.getView(a.id)).revision,a.revision);
  assert.equal(await cursorOf(a,connection),undefined);
  await store.setTaskStatus(first.id,'running');
  await store.setTaskStatus(first.id,'failed','合成失败');
  const retry = (await api.createSourceUpdate(a.id,{connectionId:connection.id})).task;
  assert.notEqual(retry.id,first.id);
  await store.setTaskStatus(retry.id,'cancelled');
  await assert.rejects(store.completeTask(retry.id,output('不可落账')),{status:409});
  assert.equal(await cursorOf(a,connection),undefined);
  const stale = (await api.createSourceUpdate(a.id,{connectionId:connection.id})).task;
  const manual = await store.saveGraph(a.id,a.revision,{kind:'add',title:'保留手工判断',mark:'◇',content:'手工修改优先',domain:'工程取舍'});
  await assert.rejects(store.completeTask(stale.id,output('过期结果')),{status:409});
  await assert.rejects(api.createSourceUpdate(a.id,{connectionId:connection.id}),{status:409});
  assert.deepEqual(await store.getView(a.id),manual);
  assert.equal(await cursorOf(a,connection),undefined);
  assert.deepEqual(await store.sourceEvents(a.id),[]);
  await store.setTaskStatus(stale.id,'cancelled');
  const fresh = (await api.createSourceUpdate(a.id,{connectionId:connection.id})).task;
  assert.deepEqual((await store.getTask(fresh.id)).source.messages.map(item=>item.id),['keep']);
  await store.completeTask(fresh.id,output('本次新判断'));
  assert.deepEqual((await store.getView(a.id)).graph.nodes.map(node=>node.title),['保留手工判断','本次新判断']);
});

test('断开取消旧任务；重连的新 generation 按显式 history 起步，旧结果不能跨代写入',async () => {
  const api = fixture(), source = api.add('codex',undefined,[message('old')]), a = await topic('断开迟到结果');
  const old = await binding(api,source,a);
  const queued = (await api.createSourceUpdate(a.id,{connectionId:old.id})).task;
  await store.setTaskStatus(queued.id,'running');
  await api.disconnectSource({connectionId:old.id});
  assert.equal((await store.getTaskStatus(queued.id)).status,'cancelled');
  await assert.rejects(store.completeTask(queued.id,output('迟到结果')),{status:409});
  const next = await binding(api,source,a,'now');
  assert.equal(next.id,old.id);
  assert.notEqual(next.generation,old.generation);
  assert.equal(next.loadedRevision,null);
  assert.equal((await api.createSourceUpdate(a.id,{connectionId:next.id})).unchanged,true);
  // Simulate an older task-file receipt surviving a disconnect; connection state remains authoritative.
  const taskFile = path.join(sandbox,'tasks',`${queued.id}.json`);
  const oldTask = JSON.parse(await readFile(taskFile,'utf8'));
  await writeFile(taskFile,JSON.stringify({...oldTask,status:'pending'}),'utf8');
  await assert.rejects(store.completeTask(queued.id,output('跨代旧结果')),{status:409});
  assert.equal((await store.getView(a.id)).revision,a.revision);
  assert.equal(await cursorOf(a,next),undefined);
  api.append(source,message('new'));
  const fresh = (await api.createSourceUpdate(a.id,{connectionId:next.id})).task;
  assert.deepEqual((await store.getTask(fresh.id)).source.messages.map(item=>item.id),['new']);
  await store.completeTask(fresh.id,output('重连后的判断'));
  assert.deepEqual(await cursorOf(a,next),{offset:2});
  assert.equal(await cursorOf(a,old),undefined);
  await store.setTaskStatus(queued.id,'cancelled');
});

test('主题已落账但任务回执中断，重试只补状态；其间手改或断开仍不重复判断与来源',async () => {
  const api = fixture(), source = api.add('codex',undefined,[message('once')]), a = await topic('事务回执恢复');
  const connection = await binding(api,source,a), task = (await api.createSourceUpdate(a.id,{connectionId:connection.id})).task;
  const taskFile = path.join(sandbox,'tasks',`${task.id}.json`), pending = await readFile(taskFile,'utf8');
  const applied = await store.completeTask(task.id,output('只写入一次'));
  const originalCursor = await cursorOf(a,connection);
  await api.disconnectSource({connectionId:connection.id});
  const manual = await store.saveGraph(a.id,applied.revision,{kind:'edit',id:applied.graph.nodes[0].id,title:'保留恢复前手改',mark:'⏸'});
  await writeFile(taskFile,pending,'utf8');
  const replayed = await store.completeTask(task.id,output('不得出现第二次'));
  assert.deepEqual(replayed,manual);
  assert.equal((await store.getTaskStatus(task.id)).resultRevision,applied.revision);
  assert.equal((await store.getTaskStatus(task.id)).status,'completed');
  assert.deepEqual(await cursorOf(a,connection),originalCursor);
  assert.equal((await store.sourceEvents(a.id)).length,1);
  assert.equal((await store.getView(a.id)).graph.nodes.length,1);
});

test('长历史先提炼后一次成稿，取消恢复不重读，当前边界后的消息留给下次',async () => {
  const api = fixture({batchSize:2}), source = api.add('codex',undefined,[1,2,3,4,5].map(n=>message(String(n)))), a = await topic('历史提炼');
  const connection = await binding(api,source,a);
  const start = await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true});
  assert.equal(start.stage,'distill'); assert.equal(start.hasMore,true);
  assert.match((await store.taskPrompt(start.task.id)).system,/不生成 Map/);
  await store.completeTask(start.task.id,JSON.stringify({summary:'决定先验证；原因是实际需求仍待证实。'}));
  assert.deepEqual(await store.getView(a.id),a,'中间提炼不能改变图文或其版本');
  assert.equal(await cursorOf(a,connection),undefined,'正式水位在成稿前不冒充完成');
  const second = await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true});
  assert.deepEqual((await store.getTask(second.task.id)).source.messages.map(m=>m.id),['3','4']);
  await store.setTaskStatus(second.task.id,'cancelled');
  api.append(source,message('6','导入期间才出现的新消息'));
  const resume = await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true});
  assert.deepEqual(resume.until,{offset:5},'恢复必须保持最初的会话边界');
  assert.match((await store.taskPrompt(resume.task.id)).user,/决定先验证/);
  await store.completeTask(resume.task.id,JSON.stringify({summary:'决定先验证；先访谈三位用户，并记录拒绝原因。'}));
  const last = await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true});
  assert.equal(last.hasMore,true,'最后一次提炼之后还需要成稿');
  assert.deepEqual((await store.getTask(last.task.id)).source.messages.map(m=>m.id),['5']);
  await store.completeTask(last.task.id,JSON.stringify({summary:'决定先验证。愿景是改善续接效率，尚不能当作验证结果。先访谈三位用户并记录拒绝原因；收费方式未定。'}));
  assert.deepEqual(await store.getView(a.id),a);
  const publish = await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true});
  assert.equal(publish.stage,'publish'); assert.equal(publish.hasMore,false);
  const prompt = await store.taskPrompt(publish.task.id);
  assert.match(prompt.system,/8–16/); assert.match(prompt.user,/愿景/);
  assert.doesNotMatch(prompt.user,/导入期间才出现/);
  await store.completeTask(publish.task.id,output('先验证再开发'));
  assert.equal((await store.getView(a.id)).graph.nodes.length,1);
  assert.deepEqual(await cursorOf(a,connection),{offset:5});
  assert.deepEqual((await store.sourceEvents(a.id))[0].inputs.map(m=>m.id),['1','2','3','4','5']);
  assert.deepEqual((await store.getTopic(a.id)).sourceImports,{});
  const increment = await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true});
  assert.equal(increment.stage,undefined); assert.deepEqual((await store.getTask(increment.task.id)).source.messages.map(m=>m.id),['6']);
  await store.completeTask(increment.task.id,'<noop/>');
  const count = (await store.listTasks()).length;
  assert.equal((await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true})).unchanged,true);
  assert.equal((await store.listTasks()).length,count,'追平后的空增量不能新建推理任务');
});

test('提炼格式/长度不合格、取消、断开均不推进；更改主题不沿用旧提炼',async () => {
  const api = fixture({batchSize:1}), source = api.add('claude',undefined,[message('a'),message('b')]), a = await topic('提炼保护');
  const connection = await binding(api,source,a);
  const first = (await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true})).task;
  await assert.rejects(store.completeTask(first.id,'坏格式'),/无效格式/);
  await assert.rejects(store.completeTask(first.id,JSON.stringify({summary:'长'.repeat(10001)})),/限定长度/);
  assert.equal((await store.getTopic(a.id)).sourceImports,undefined);
  await store.completeTask(first.id,JSON.stringify({summary:'先验证原主题。'}));
  const changed = await store.saveDoc(a.id,a.revision,'## 主题\n\n改为另一主题');
  await assert.rejects(api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true}),/主题范围已改变/);
  await store.saveDoc(a.id,changed.revision,a.doc);
  const pending = (await api.createSourceUpdate(a.id,{connectionId:connection.id,continuous:true})).task;
  await api.disconnectSource({connectionId:connection.id});
  await assert.rejects(store.completeTask(pending.id,JSON.stringify({summary:'迟到的内容'})),{status:409});
  assert.equal(await cursorOf(a,connection),undefined);
});

test('断开真实来源后，完整备份携带未命中主题的材料，导入副本可独立改主题重画',async () => {
  const api = fixture(), source = api.add('claude',undefined,[message('photo','摄影展预算500元。')]);
  const a = await topic('来源可迁移'), connection = await binding(api,source,a);
  const update = await api.createSourceUpdate(a.id,{connectionId:connection.id});
  await store.completeTask(update.task.id,'<noop/>');
  assert.equal((await store.getView(a.id)).graph.nodes.length,0);
  assert.deepEqual(await cursorOf(a,connection),{offset:1});
  assert.equal(readSourceLog((await store.getTopic(a.id)).raw)[0].content,'摄影展预算500元。');
  assert.equal((await api.createSourceUpdate(a.id,{connectionId:connection.id})).unchanged,true);
  await api.disconnectSource({connectionId:connection.id});
  const bundle = await store.exportTopic(a.id);
  const copy = await store.importTopic(JSON.parse(JSON.stringify(bundle)));
  const before = await store.getTopic(copy.id);
  assert.equal(readSourceLog(before.raw).length,1,'备份里的双份兼容存证不能变成重复材料');
  await store.saveDoc(copy.id,copy.revision,'## 主题\n只记录摄影展');
  const redraw = await store.createTask(copy.id,'redraw');
  assert.match((await store.taskPrompt(redraw.id)).user,/摄影展预算500元/);
  const view = await store.completeTask(redraw.id,'<doc>\n## 展览\n### ◇ 摄影展预算500元\n待核对。\n</doc>');
  assert.equal(view.scope,'只记录摄影展');
  assert.equal(view.graph.nodes.length,1);
  const after = await store.getTopic(copy.id);
  assert.equal(after.raw,before.raw);
  assert.deepEqual(after.sourceCursors,before.sourceCursors);
});
