import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const cacheRoot = path.resolve(web, '../node_modules/.cache');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const baseLedger = '[场次 2026-09-17T10:00:00Z · 合成回放]\n走向 p3 [主题]\n只处理合成材料。\n◆ j1 [验证] 原判断\n保留原文。';
const source = (id, provider = 'codex') => ({ provider, id, title: `合成会话 ${id}`, cwd: 'synthetic', updatedAt: '2026-09-17T10:00:00Z' });
const connection = (id, topicId = 'a', loadedRevision = null) => ({ id, topicId, source: source(id), history: 'now', loadedRevision });
let directory, createLocalRuntime, connectionLoadLabel;
before(async () => {
  await mkdir(cacheRoot, { recursive: true });
  directory = await mkdtemp(path.join(cacheRoot, 'gft-connections-ui-'));
  const outfile = path.join(directory, 'runtime.mjs');
  await build({ stdin: { contents: 'export { createLocalRuntime } from "./localRuntime"; export { connectionLoadLabel } from "./ConnectionManager";', resolveDir: web, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', nodePaths: [path.resolve(web, '../node_modules')], logLevel: 'silent' });
  ({ createLocalRuntime, connectionLoadLabel } = await import(pathToFileURL(outfile).href));
});
after(async () => {
  const relative = path.relative(cacheRoot, path.resolve(directory));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(directory, { recursive: true, force: true });
});
async function fixture(options, run) {
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage;
  const cache = new Map();
  globalThis.localStorage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) };
  const state = { topics: new Map(['a', 'b'].map(id => [id, { id, name: `主题 ${id}`, scope: '只处理合成材料。', revision: 1, ledger: baseLedger.replace('原判断', `${id} 原判断`), raw: baseLedger }])), connections: options.connections || [], calls: [], task: 'completed', chooses: 0, errors: [] };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(String(url), 'http://synthetic.local');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { pathname: address.pathname, query: address.searchParams, body, method: init.method || 'GET', signal: init.signal };
    state.calls.push(call);
    const override = await options.route?.(call, state, json);
    if (override !== undefined) return override;
    if (address.pathname === '/api/topics') return json([...state.topics.values()].map(({ id, name }) => ({ id, name, status: 'active' })));
    if (address.pathname === '/api/connections') return json(state.connections.filter(item => item.topicId === address.searchParams.get('topicId')));
    if (address.pathname === '/api/connections/connect') {
      const created = body.topicIds.map(topicId => ({ id: `${body.source.id}-${topicId}`, topicId, source: body.source, history: body.history, loadedRevision: null }));
      state.connections.push(...created); return json(created);
    }
    if (address.pathname === '/api/connections/disconnect') { state.connections = state.connections.filter(item => item.id !== body.connectionId); return json({ disconnected: [body.connectionId] }); }
    const topicMatch = address.pathname.match(/^\/api\/topics\/([^/]+)\/(snapshot|state|sources|update-from-chat)$/);
    if (topicMatch) {
      const topic = state.topics.get(topicMatch[1]);
      if (topicMatch[2] === 'snapshot') return json({ topic });
      if (topicMatch[2] === 'sources') return json([]);
      if (topicMatch[2] === 'state') {
        if (body.baseRevision !== topic.revision) return json({ error: '合成版本冲突' }, 409);
        Object.assign(topic, { ledger: body.map.ledger, raw: body.map.raw, revision: topic.revision + 1 });
        return json({ revision: topic.revision });
      }
      return json({ task: { id: 'task-1' } });
    }
    if (address.pathname === '/api/tasks/task-1/status') return json({ status: state.task, error: state.task === 'failed' ? '合成来源无法读取' : undefined });
    if (address.pathname === '/api/tasks/task-1/cancel') { state.task = 'cancelled'; return json({ status: 'cancelled' }); }
    throw new Error(`未预期的合成请求：${address.pathname}`);
  };
  const local = createLocalRuntime({ onRequestUpdate: options.manual || (async () => null), onRequestSource: async (...args) => { state.chooses++; return options.choose?.(...args) ?? null; }, onError: message => state.errors.push(message) });
  try {
    await local.start(); await local.connections.refresh();
    await run({ local, state });
  } finally {
    local.dispose();
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
  }
}
const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('等待 UI 状态超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

test('首次无主题直接按已连接来源更新，不弹主题选项也不额外调用推荐', async () => {
  await fixture({ connections: [connection('one')] }, async ({ local, state }) => {
    const topic = state.topics.get('a'); topic.ledger = ''; topic.raw = ''; topic.scope = '';
    await local.host.switchProject('b'); await local.host.switchProject('a');
    await local.host.requestUpdate();
    assert.equal(state.chooses,0);
    assert.equal(state.calls.filter(call => call.pathname.endsWith('update-from-chat')).length,1);
    assert.equal(state.calls.filter(call => call.pathname.endsWith('compute') || call.pathname === '/api/chat-preview').length,0);
    assert.equal(local.connections.getSnapshot().operation.phase,'completed');
  });
});

test('更新同次返回的名称随图文同步，下拉框无需刷新且不另发命名任务',async()=>{
  await fixture({connections:[connection('one')],route:(call,state,json)=>{
    if (call.pathname.endsWith('/update-from-chat')) {
      const topic=state.topics.get('a');topic.name='同次生成的名称';topic.revision++;
      return json({task:{id:'task-1'}});
    }
  }},async({local,state})=>{
    await local.host.requestUpdate();
    assert.equal(local.host.getSnapshot().projects.find(p=>p.id==='a').name,'同次生成的名称');
    assert.equal(state.calls.filter(c=>c.pathname.endsWith('/compute') || c.pathname.endsWith('/rename')).length,0);
  });
});

test('连续更新固定起点时的末尾，自动读取下一批；空增量不创建计算任务', async () => {
  let batches = 0;
  const until = { snapshot: 'fixed-head' };
  await fixture({ connections: [connection('one')], route: (call, state, json) => {
    if (call.pathname.endsWith('/update-from-chat')) {
      batches++;
      if (batches > 1) assert.deepEqual(call.body.until, until);
      return json({ task: { id: 'task-1' }, hasMore: batches < 3, until, messageCount: 2 });
    }
  } }, async ({ local }) => {
    await local.host.requestUpdate();
    assert.equal(batches, 3);
    assert.match(local.connections.getSnapshot().operation.message, /3 批/);
  });
});

test('断开标签立即消失；保存失败后恢复连接并报告错误', async () => {
  const gate = deferred();
  await fixture({ connections: [connection('one')], route: async (call, state, json) => {
    if (call.pathname === '/api/connections/disconnect') { await gate.promise; return json({ error: '断开失败' }, 500); }
  } }, async ({ local }) => {
    const pending = local.connections.disconnect('one');
    assert.equal(local.connections.getSnapshot().connections.length, 0);
    gate.resolve(); await assert.rejects(pending, /断开失败/);
    assert.equal(local.connections.getSnapshot().connections.length, 1);
  });
});

test('连接和聊天最近读取分别表达；旧版本不会冒充当前上下文', () => {
  assert.equal(connectionLoadLabel(connection('one'), 3), '待读取');
  assert.equal(connectionLoadLabel(connection('one', 'a', 3), 3), '聊天最近读取 · 版本 3');
  assert.equal(connectionLoadLabel(connection('one', 'a', 2), 3), '聊天最近读取 · 版本 2 · 脉络有更新');
});

test('无连接点击更新立即显示读取，取消选择不写连接或提交任务', async () => {
  const gate = deferred(); let blocked = false;
  await fixture({ route: async call => { if (blocked && call.pathname === '/api/connections') await gate.promise; } }, async ({ local, state }) => {
    blocked = true;
    const pending = local.host.requestUpdate();
    assert.equal(local.connections.getSnapshot().operation.phase, 'reading');
    assert.equal(state.chooses, 0);
    gate.resolve(); await pending;
    assert.equal(state.chooses, 1);
    assert.equal(local.connections.getSnapshot().operation, null);
    assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);
  });
});

test('单连接直接更新：先保存 Doc/节点修改，再提交任务并同步后台结果', async () => {
  await fixture({ connections: [connection('one')], route: (call, state) => {
    if (call.pathname === '/api/tasks/task-1/status') {
      const topic = state.topics.get('a'); topic.ledger += '\nAI 改 j1 标题：聊天更新后的判断'; topic.revision++;
    }
  } }, async ({ local, state }) => {
    local.store.getState().updateNode('j1', { title: '手工判断' });
    local.store.getState().setDocDraft(local.store.getState().doc.replace('保留原文。', '刚输入但尚未失焦的正文。'));
    await local.host.requestUpdate();
    assert.equal(state.chooses, 0);
    const writes = state.calls.filter(call => call.method === 'POST');
    assert.equal(writes[0].pathname, '/api/topics/a/state');
    assert.match(writes[0].body.map.ledger, /手工判断/);
    assert.match(writes[0].body.map.ledger, /刚输入但尚未失焦的正文/);
    assert.equal(writes[1].pathname, '/api/topics/a/update-from-chat');
    assert.equal(writes[1].body.connectionId, 'one');
    assert.match(local.store.getState().doc, /聊天更新后的判断/);
    assert.equal(local.connections.getSnapshot().operation.phase, 'completed');
  });
});

test('多个连接必须明确选来源，选择第二个不会误用第一个或最近会话', async () => {
  await fixture({ connections: [connection('one'), connection('two')], choose: async (_topicId, items) => { assert.equal(items.length, 2); return { connectionId: 'two' }; } }, async ({ local, state }) => {
    await local.host.requestUpdate();
    assert.equal(state.chooses, 1);
    assert.equal(state.calls.find(call => call.pathname.endsWith('update-from-chat')).body.connectionId, 'two');
  });
});

test('取消发生在提交响应在途时，收到任务 ID 后仍发取消且不重置内容', async () => {
  const gate = deferred(); let enqueued = false;
  await fixture({ connections: [connection('one')], route: async call => { if (call.pathname.endsWith('update-from-chat')) { enqueued = true; await gate.promise; } } }, async ({ local, state }) => {
    const before = local.store.getState().ledger;
    const pending = local.host.requestUpdate();
    await waitFor(() => enqueued);
    local.connections.cancel();
    assert.equal(local.connections.getSnapshot().operation.phase, 'cancelling');
    gate.resolve(); await pending;
    assert.equal(local.connections.getSnapshot().operation.phase, 'cancelled');
    assert.equal(state.calls.filter(call => call.pathname.endsWith('/cancel')).length, 1);
    assert.equal(local.store.getState().ledger, before);
  });
});

test('切主题首帧清除旧连接及进度，旧任务迟到不会同步进新主题', async () => {
  const gate = deferred(); let enqueued = false;
  await fixture({ connections: [connection('one'), connection('other', 'b')], route: async call => { if (call.pathname.endsWith('update-from-chat')) { enqueued = true; await gate.promise; } } }, async ({ local, state }) => {
    const pending = local.host.requestUpdate();
    await waitFor(() => enqueued);
    const switchPending = local.host.switchProject('b');
    assert.equal(local.connections.getSnapshot().topicId, 'b');
    assert.deepEqual(local.connections.getSnapshot().connections, []);
    assert.equal(local.connections.getSnapshot().operation, null);
    await switchPending;
    gate.resolve(); await pending;
    assert.equal(local.host.getSnapshot().currentProjectId, 'b');
    assert.match(local.store.getState().doc, /b 原判断/);
    assert.equal(local.connections.getSnapshot().operation, null);
    assert.ok(state.calls.some(call => call.pathname.endsWith('/cancel')));
  });
});

test('来源任务失败显示真实错误并保留原图文，无新消息有明确结果', async () => {
  await fixture({ connections: [connection('one')] }, async ({ local, state }) => {
    const before = local.store.getState().ledger;
    state.task = 'failed'; await local.host.requestUpdate();
    assert.equal(local.connections.getSnapshot().operation.phase, 'failed');
    assert.match(local.connections.getSnapshot().operation.message, /合成来源无法读取/);
    assert.equal(local.store.getState().ledger, before);
  });
  await fixture({ connections: [connection('one')], route: (call, _state, json) => call.pathname.endsWith('update-from-chat') ? json({ unchanged: true, message: '没有新增消息' }) : undefined }, async ({ local, state }) => {
    await local.host.requestUpdate();
    assert.equal(local.connections.getSnapshot().operation.message, '没有新增消息');
    assert.equal(state.calls.filter(call => call.pathname.includes('/api/tasks/')).length, 0);
  });
});

test('一次确认可连接多个主题；单条与当前主题全部断开不影响其他主题', async () => {
  await fixture({}, async ({ local, state }) => {
    const items = await local.connections.connect(source('shared', 'claude'), ['a', 'b'], 'all');
    assert.equal(items.length, 2);
    assert.equal(items[0].loadedRevision, null);
    await local.connections.connect(source('second'), ['a'], 'now');
    await local.connections.disconnect('second-a');
    assert.deepEqual(state.connections.map(item => item.id), ['shared-a', 'shared-b']);
    await local.connections.disconnectAll('a');
    assert.deepEqual(state.connections.map(item => item.id), ['shared-b']);
  });
});
