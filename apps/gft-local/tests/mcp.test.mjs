import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGftMcpServer, createLocalClient } from '../mcp.mjs';

async function fixture({ capabilities = { elicitation: { form: {} } }, answer = { action: 'accept', content: { topicIds: ['a','b'], history: 'now' } }, onRequest, onForm } = {}) {
  const calls = [], forms = [], formIds = [], notifications = [];
  const topics = [{ id: 'a', name: '方向' }, { id: 'b', name: '产品' }];
  const bindings = topics.map(topic => ({ id: `binding-${topic.id}`, topicId: topic.id, source: { provider: 'codex', id: 'real-thread' } }));
  const request = async (route, body) => {
    calls.push({ route, body });
    const override = await onRequest?.(route,body);
    if (override !== undefined) return override;
    if (route === '/api/topics') return topics;
    if (route.startsWith('/api/chat-session?')) return { provider: 'codex', id: 'real-thread', title: '当前对话' };
    if (route.startsWith('/api/connections?')) return bindings;
    if (route === '/api/connections/connect') return bindings.filter(binding=>body.topicIds.includes(binding.topicId));
    if (route === '/api/connections/read') return { session:body.sessionId,provider:body.provider,writeProjectId:'b',
      projects: topics.filter(topic=>!body.topicId || topic.id===body.topicId).map(topic => ({ ...topic, revision: 2, document: `主题：${topic.name}` })),
      connections: bindings.filter(binding=>!body.topicId || binding.topicId===body.topicId).map(binding=>({...binding,loadedRevision:2})) };
    if (route === '/api/connections/disconnect') return { disconnected: body.topicIds };
    if (route.endsWith('/update-from-chat')) return { task: { id: 'task-one', status: 'pending' } };
    if (route.endsWith('/cancel')) return {status:'cancelled'};
    throw new Error(`Unexpected request: ${route}`);
  };
  const server = createGftMcpServer({ request });
  const client = new Client({ name: 'test-native-host', version: '1' }, { capabilities });
  if (capabilities.elicitation) client.setRequestHandler(ElicitRequestSchema, async (req,extra) => { forms.push(req.params); formIds.push(extra.requestId); return onForm ? onForm(req,extra) : answer; });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const receive = clientTransport.onmessage;
  clientTransport.onmessage = (message,extra) => { if(message.method === 'notifications/cancelled') notifications.push(message); receive(message,extra); };
  return { calls, forms, formIds, notifications, client, close: async () => { await client.close(); await server.close(); } };
}
const args = { provider: 'codex', sessionId: 'real-thread' };
const payload = result => JSON.parse(result.content[0].text);
const deferred = () => { let resolve; const promise=new Promise(done=>resolve=done); return {promise,resolve}; };
const nextTurn = () => new Promise(resolve=>setImmediate(resolve));

test('读取漏选主题不发请求；来源走同一服务的分页入口',async()=>{
  const f=await fixture({onRequest:async(route,body)=>route==='/api/connections/sources'?{topicId:body.topicId,text:'原文',nextCursor:'next'}:undefined});
  try {
    const missing=await f.client.callTool({name:'gft_local_read',arguments:args});
    assert.equal(missing.isError,true); assert.equal(f.calls.length,0);
    const page=payload(await f.client.callTool({name:'gft_local_sources',arguments:{...args,topicId:'b',cursor:'previous'}}));
    assert.equal(page.nextCursor,'next');
    assert.deepEqual(f.calls.at(-1),{route:'/api/connections/sources',body:{...args,topicId:'b',cursor:'previous'}});
  } finally {await f.close();}
});

test('原生确认后才建立多主题连接，只返回索引，再按需读取正文', async () => {
  const f = await fixture();
  try {
    const result = await f.client.callTool({ name: 'gft_local_connect', arguments: args });
    assert.equal(result.isError, undefined);
    assert.equal(f.forms.length, 1);
    assert.match(f.forms[0].message, /当前对话/);
    assert.equal(f.forms[0].requestedSchema.properties.topicIds.type, 'array');
    assert.deepEqual(f.calls.find(item => item.route === '/api/connections/connect').body.topicIds, ['a','b']);
    assert.equal(payload(result).connections.length, 2);
    assert.equal(f.calls.some(call=>call.route === '/api/connections/read'),false);
    const read = payload(await f.client.callTool({name:'gft_local_read',arguments:{...args,topicId:'b'}}));
    assert.deepEqual(read.projects.map(project=>project.id),['b']);
    assert.equal(f.calls.at(-1).route, '/api/connections/read');
  } finally { await f.close(); }
});

for (const action of ['decline','cancel']) test(`原生${action}不建立绑定也不读取记忆`, async () => {
  const f = await fixture({ answer: { action } });
  try {
    const result = await f.client.callTool({ name: 'gft_local_connect', arguments: args });
    assert.equal(payload(result).status, 'cancelled');
    assert.ok(f.calls.every(item => item.body === undefined));
  } finally { await f.close(); }
});

test('宿主没有表单能力时明确降级，不以文字冒充确认成功', async () => {
  const f = await fixture({ capabilities: {} });
  try {
    const result = await f.client.callTool({ name: 'gft_local_connect', arguments: args });
    assert.equal(payload(result).status, 'needs_confirmation');
    assert.equal(f.forms.length, 0);
    assert.ok(f.calls.every(item => item.body === undefined));
  } finally { await f.close(); }
});

test('断开只处理用户选中的主题；取消不会断开', async () => {
  const f = await fixture({ answer: { action: 'accept', content: { topicIds: ['b'] } } });
  try {
    const result = await f.client.callTool({ name: 'gft_local_disconnect', arguments: args });
    assert.deepEqual(payload(result).disconnected, ['b']);
    assert.deepEqual(f.calls.at(-1).body, { ...args, topicIds: ['b'] });
  } finally { await f.close(); }
});

test('多主题存回先选择，不广播写入；返回排队不是保存成功', async () => {
  const f = await fixture({ answer: { action: 'accept', content: { topicId: 'b' } } });
  try {
    const result = await f.client.callTool({ name: 'gft_local_update', arguments: args });
    assert.equal(f.forms.length, 1);
    assert.equal(f.calls.at(-1).route, '/api/topics/b/update-from-chat');
    assert.deepEqual(f.calls.at(-1).body, { connectionId: 'binding-b' });
    assert.equal(payload(result).task.status, 'pending');
  } finally { await f.close(); }
});

test('本地连接器不接受远端服务地址或URL中凭证', () => {
  for (const address of ['https://example.com', 'http://127.0.0.1:4317/other', 'http://user:secret@localhost:4317', 'http://localhost:4317/?token=x']) assert.throws(() => createLocalClient(address));
  assert.equal(typeof createLocalClient('http://localhost:4317'), 'function');
});

test('连接返回本场索引，所有主题正文均不预读或标记版本',async () => {
  const f=await fixture({answer:{action:'accept',content:{topicIds:['b'],history:'all'}}});
  try {
    const value=payload(await f.client.callTool({name:'gft_local_connect',arguments:args}));
    assert.deepEqual(value.connections.map(binding=>binding.topicId),['a','b']);
    assert.equal(value.memory,undefined);
    assert.deepEqual(f.calls.filter(call=>call.route==='/api/connections/read'),[]);
    assert.doesNotMatch(value.message,/已采用/);
  } finally {await f.close();}
});

test('连接确认已提交但工具在响应途中取消，不继续读取或冒充记忆已送达',async () => {
  const began=deferred(),release=deferred(),finished=deferred();
  const f=await fixture({onRequest:async route=>{
    if(route==='/api/connections/connect') {began.resolve();await release.promise;finished.resolve();}
  }});
  try {
    const controller=new AbortController();
    const result=f.client.callTool({name:'gft_local_connect',arguments:args},undefined,{signal:controller.signal});
    await began.promise;controller.abort();await assert.rejects(result);await nextTurn();release.resolve();
    await finished.promise;await nextTurn();
    assert.equal(f.calls.filter(call=>call.route==='/api/connections/connect').length,1);
    assert.equal(f.calls.filter(call=>call.route==='/api/connections/read').length,0);
    assert.equal(f.calls.filter(call=>call.route==='/api/connections/disconnect').length,0);
  } finally {release.resolve();await f.close();}
});

for(const reused of [false,true]) test(`更新排队响应在途取消：${reused?'保留之前已存在的任务':'只取消本次新建任务'}`,async () => {
  const began=deferred(),release=deferred(),finished=deferred();
  const f=await fixture({onRequest:async route=>{
    if(route.endsWith('/update-from-chat')) {began.resolve();await release.promise;finished.resolve();return {task:{id:'task-one',status:'pending'},reused};}
  }});
  try {
    const controller=new AbortController();
    const result=f.client.callTool({name:'gft_local_update',arguments:{...args,topicId:'a'}},undefined,{signal:controller.signal});
    await began.promise;controller.abort();await assert.rejects(result);await nextTurn();release.resolve();
    await finished.promise;await nextTurn();
    assert.equal(f.calls.filter(call=>call.route==='/api/tasks/task-one/cancel').length,reused?0:1);
    assert.equal(f.calls.filter(call=>call.route.endsWith('/update-from-chat')).length,1);
  } finally {release.resolve();await f.close();}
});

test('取消正在等待的原生表单，会发送对应协议取消通知且不写连接',async () => {
  const began=deferred(),release=deferred();
  const f=await fixture({onForm:async()=>{
    began.resolve();await release.promise;
    return {action:'accept',content:{topicIds:['a'],history:'now'}};
  }});
  try {
    const controller=new AbortController();
    const result=f.client.callTool({name:'gft_local_connect',arguments:args},undefined,{signal:controller.signal});
    await began.promise;controller.abort();await assert.rejects(result);await nextTurn();
    // Assert the wire notification, not SDK 1.30's client-side requestId=0
    // truthiness bug; receiving hosts own whether their visible form closes.
    assert.deepEqual(f.notifications.map(message=>message.params.requestId),f.formIds);
    assert.equal(f.formIds.length,1);
    release.resolve();await nextTurn();
    assert.ok(f.calls.every(call=>call.body===undefined));
  } finally {release.resolve();await f.close();}
});

test('任务查询区分模型完成与落账完成，compute 不宣称已保存',async () => {
  for(const mode of ['compute','apply','compact']) {
    const f=await fixture({onRequest:async route=>route.endsWith('/status')?{id:'task-one',status:'completed',...(mode==='compute'?{mode}:{}),...(mode==='compact'?{action:'compact'}:{}),resultRevision:mode==='compute'?undefined:3}:undefined});
    try {
      const value=payload(await f.client.callTool({name:'gft_local_task',arguments:{taskId:'task-one'}}));
      assert.equal(value.saved,mode==='apply');
      assert.equal(value.status,'completed');
    } finally {await f.close();}
  }
});
