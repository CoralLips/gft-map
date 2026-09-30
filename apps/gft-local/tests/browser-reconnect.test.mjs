import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const cacheRoot = path.resolve(web, '../node_modules/.cache');
const baseLedger = '走向 p1 [主题]\n只处理合成材料。\n◆ j1 [验证] 原判断\n保留原文。';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async predicate => {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待连接状态超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
let directory, createLocalRuntime, createReconnectMonitor;
before(async () => {
  await mkdir(cacheRoot, { recursive: true });
  directory = await mkdtemp(path.join(cacheRoot, 'gft-browser-reconnect-'));
  const outfile = path.join(directory, 'runtime.mjs');
  await build({ stdin: { contents: 'export { createLocalRuntime } from "./localRuntime"; export { createReconnectMonitor } from "./reconnect";', resolveDir: web, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', nodePaths: [path.resolve(web, '../node_modules')], logLevel: 'silent' });
  ({ createLocalRuntime, createReconnectMonitor } = await import(pathToFileURL(outfile).href));
});
after(async () => {
  const relative = path.relative(cacheRoot, path.resolve(directory));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(directory, { recursive: true, force: true });
});
async function fixture(run) {
  const old = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, window: globalThis.window, document: globalThis.document };
  const cache = new Map();
  const state = { offline: false, calls: [], errors: [], loseSaveResponse: false, failSnapshotOnce: false, hold: null,
    topic: { id: 'a', name: '合成脉络', scope: '只处理合成材料。', revision: 1, ledger: baseLedger, raw: '原始来源' } };
  globalThis.localStorage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) };
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  globalThis.document.visibilityState = 'visible';
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init) => {
    const address = new URL(url, 'http://synthetic.local');
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ url: address.pathname, method: init.method, body });
    if (state.offline) throw new TypeError('Failed to fetch');
    if (state.hold) await state.hold.promise;
    if (address.pathname === '/api/topics') return json([{ id: 'a', name: state.topic.name }]);
    if (address.pathname === '/api/topics/a/snapshot') {
      if (state.failSnapshotOnce) { state.failSnapshotOnce = false; throw new TypeError('Snapshot unavailable'); }
      return json({ topic: state.topic });
    }
    if (address.pathname === '/api/topics/a/state') {
      if (body.baseRevision !== state.topic.revision) return json({ error: '合成版本冲突' }, 409);
      Object.assign(state.topic, { ledger: body.map.ledger, raw: body.map.raw, panel: body.map, revision: state.topic.revision + 1 });
      if (state.loseSaveResponse) { state.loseSaveResponse = false; state.offline = true; throw new TypeError('Response lost'); }
      return json({ revision: state.topic.revision });
    }
    if (address.pathname === '/api/topics/a/compute') { state.offline = true; throw new TypeError('Enqueue response lost'); }
    if (address.pathname === '/api/connections') return json([]);
    throw new Error(`未预期请求：${address.pathname}`);
  };
  const local = createLocalRuntime({ onRequestUpdate: async () => null, onError: message => state.errors.push(message) });
  try { await run({ local, state, cache }); }
  finally {
    local.dispose();
    // Let an already queued final save finish before restoring the test globals.
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
}

test('首次 API 失败仍会自动重试，恢复后正常打开；不产生循环错误提示', async () => {
  await fixture(async ({ local, state }) => {
    state.offline = true;
    await local.start();
    assert.equal(local.service.getSnapshot().phase, 'disconnected');
    assert.equal(local.service.getSnapshot().hasConnected, false);
    state.offline = false;
    await waitFor(() => local.service.getSnapshot().hasConnected);
    assert.equal(local.host.getSnapshot().currentProjectId, 'a');
    assert.match(local.store.getState().doc, /原判断/);
    assert.deepEqual(state.errors, []);
    assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);
  });
});

test('断线和恢复保留 Doc 草稿、选中节点与视图；重复唤醒合并为一个检查', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    local.store.getState().setRightView('doc');
    local.store.getState().setDocDraft('## 主线\n\n还没有提交的正文。');
    const selected = new Set([local.store.getState().nodes[0].id]);
    local.store.setState({ selectedNodeIds: selected });
    const generation = local.store.getState().generation;
    state.offline = true;
    await local.service.retry();
    assert.equal(local.service.getSnapshot().phase, 'disconnected');
    state.topic.ledger += '\n◆ j2 [验证] 新增的远端判断';
    state.topic.revision++;
    state.offline = false;
    state.hold = deferred();
    const before = state.calls.length;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => state.calls.length > before);
    assert.equal(state.calls.length - before, 1);
    const pending = local.service.retry();
    state.hold.resolve();
    state.hold = null;
    await pending;
    assert.equal(local.service.getSnapshot().phase, 'connected');
    assert.equal(local.store.getState().docDraft, '## 主线\n\n还没有提交的正文。');
    assert.equal(local.store.getState().rightView, 'doc');
    assert.equal(local.store.getState().generation, generation);
    assert.equal(local.store.getState().selectedNodeIds, selected);
    assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);
    local.store.setState({ docDraft: null });
  });
});

test('首轮列表成功但正文读取失败，下一次检查补回正文且不误报已连接', async () => {
  await fixture(async ({ local, state }) => {
    state.failSnapshotOnce = true;
    await local.start();
    assert.equal(local.service.getSnapshot().phase, 'disconnected');
    assert.equal(local.service.getSnapshot().hasConnected, false);
    await local.service.retry();
    assert.equal(local.service.getSnapshot().phase, 'connected');
    assert.match(local.store.getState().doc, /原判断/);
    assert.equal(local.store.getState().error, null);
  });
});

test('断线时未送达的编辑保留镜像，恢复不自动写入，显式重试保存成功', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    state.offline = true;
    local.store.getState().updateRaw('离线编辑的新来源');
    local.store.getState().flushDoc();
    await waitFor(() => local.service.getSnapshot().saveFailed);
    assert.equal(state.topic.raw, '原始来源');
    state.offline = false;
    await local.service.retry();
    assert.equal(local.store.getState().raw, '离线编辑的新来源');
    assert.equal(state.topic.raw, '原始来源');
    await local.service.savePending();
    assert.equal(state.topic.raw, '离线编辑的新来源');
    assert.equal(state.topic.revision, 2);
    assert.equal(local.service.getSnapshot().pending, false);
  });
});

test('写入回执丢失不自动重发；用户重试先确认已保存版本，不重复写事件', async () => {
  await fixture(async ({ local, state, cache }) => {
    await local.start();
    state.loseSaveResponse = true;
    local.store.getState().updateRaw('保留这份本地修改。');
    local.store.getState().flushDoc();
    await waitFor(() => local.service.getSnapshot().saveFailed);
    assert.equal(local.service.getSnapshot().pending, true);
    assert.equal(JSON.parse(cache.get('gft-local:panel:a')).map.raw, '保留这份本地修改。');
    assert.equal(state.topic.revision, 2);
    state.offline = false;
    await local.service.retry();
    await local.service.retry();
    assert.equal(state.calls.filter(call => call.method === 'POST').length, 1);
    await local.service.savePending();
    assert.equal(local.service.getSnapshot().pending, false);
    assert.equal(state.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(state.topic.revision, 2);
  });
});

test('保存遇到版本冲突后读取断线，仍保留显式重试保存入口', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    state.topic.revision++;
    state.failSnapshotOnce = true;
    local.store.getState().updateRaw('冲突后仍保留我的编辑');
    local.store.getState().flushDoc();
    await waitFor(() => local.service.getSnapshot().saveFailed);
    assert.equal(local.service.getSnapshot().pending, true);
    assert.equal(local.service.getSnapshot().phase, 'disconnected');
    assert.equal(local.store.getState().raw, '冲突后仍保留我的编辑');
  });
});

test('无法安全合并的版本冲突保留手改与重试入口，不覆盖远端', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    state.topic.revision++;
    state.topic.ledger = baseLedger.replace('原判断', '远端改写');
    local.store.getState().updateRaw('需要人工确认的来源');
    local.store.getState().flushDoc();
    await waitFor(() => local.service.getSnapshot().saveFailed);
    assert.equal(local.service.getSnapshot().pending, true);
    assert.match(state.topic.ledger, /远端改写/);
    assert.equal(state.topic.raw, '原始来源');
    assert.equal(local.store.getState().raw, '需要人工确认的来源');
  });
});

test('模型任务入队回执丢失后重连不重新提交模型任务', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    await local.store.getState().generate('新增材料');
    assert.equal(local.service.getSnapshot().phase, 'disconnected');
    state.offline = false;
    await local.service.retry();
    assert.equal(state.calls.filter(call => call.url.endsWith('/compute')).length, 1);
    assert.equal(local.store.getState().nodes[0].title, '原判断');
  });
});

test('连续失败采用退避，dispose 清理唤醒事件与定时检查', async t => {
  await fixture(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const monitor = createReconnectMonitor(async () => { calls++; throw new Error('offline'); });
    try {
    await monitor.start();
    assert.equal(calls, 1);
    t.mock.timers.tick(1000);
    await monitor.retry();
    assert.equal(calls, 2);
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(calls, 2, '第二次失败后要退避到两秒');
    t.mock.timers.tick(1000);
    await monitor.retry();
    assert.equal(calls, 3);
    monitor.dispose();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    t.mock.timers.tick(60000);
    await Promise.resolve();
    assert.equal(calls, 3);
    } finally { monitor.dispose(); t.mock.timers.reset(); }
  });
});
