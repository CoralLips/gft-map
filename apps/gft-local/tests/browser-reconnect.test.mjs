import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const cacheRoot = path.resolve(web, '../node_modules/.cache');
const baseLedger = '走向 p1 [主题]\n只处理合成材料。\n◆ j1 [验证] 原判断\n保留原文。';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};
const waitFor = async predicate => {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('等待连接状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
let directory, createLocalRuntime, createReconnectMonitor, localRequest;
before(async () => {
  await mkdir(cacheRoot, { recursive: true });
  directory = await mkdtemp(path.join(cacheRoot, 'gft-browser-reconnect-'));
  const outfile = path.join(directory, 'runtime.mjs');
  await build({
    stdin: {
      contents:
        'export { createLocalRuntime, localRequest } from "./localRuntime"; export { createReconnectMonitor } from "./reconnect";',
      resolveDir: web,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    nodePaths: [path.resolve(web, '../node_modules')],
    logLevel: 'silent',
  });
  ({ createLocalRuntime, createReconnectMonitor, localRequest } = await import(
    pathToFileURL(outfile).href
  ));
});
after(async () => {
  const relative = path.relative(cacheRoot, path.resolve(directory));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(directory, { recursive: true, force: true });
});
async function fixture(run) {
  const old = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
    document: globalThis.document,
  };
  const cache = new Map();
  const state = {
    offline: false,
    calls: [],
    errors: [],
    loseSaveResponse: false,
    failSnapshotOnce: false,
    tasks: [],
    acceptTaskRequests: false,
    loseCancelResponse: false,
    cancelHold: null,
    hold: null,
    topic: {
      id: 'a',
      name: '合成脉络',
      scope: '只处理合成材料。',
      revision: 1,
      ledger: baseLedger,
      raw: '原始来源',
    },
  };
  globalThis.localStorage = {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
    removeItem: key => cache.delete(key),
  };
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  globalThis.document.visibilityState = 'visible';
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  globalThis.fetch = async (url, init) => {
    const address = new URL(url, 'http://synthetic.local');
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ url: address.pathname, method: init.method, body });
    if (state.offline) throw new TypeError('Failed to fetch');
    if (state.hold) await state.hold.promise;
    if (address.pathname === '/api/topics') return json([{ id: 'a', name: state.topic.name }]);
    if (address.pathname === '/api/tasks') return json(state.tasks);
    const taskRoute = address.pathname.match(/^\/api\/tasks\/([^/]+)\/(status|cancel)$/);
    if (taskRoute) {
      const task = state.tasks.find(task => task.id === taskRoute[1]);
      if (!task) return json({ error: '任务不存在' }, 404);
      if (taskRoute[2] === 'cancel') {
        if (state.cancelHold) await state.cancelHold.promise;
        if (['completed', 'cancelled'].includes(task.status))
          return json({ error: '任务状态已改变' }, 409);
        task.status = 'cancelled';
        if (state.loseCancelResponse) {
          state.loseCancelResponse = false;
          state.offline = true;
          throw new TypeError('Cancel reply lost');
        }
      }
      return json(task);
    }
    if (address.pathname === '/api/topics/a/snapshot') {
      if (state.failSnapshotOnce) {
        state.failSnapshotOnce = false;
        throw new TypeError('Snapshot unavailable');
      }
      return json({ topic: state.topic });
    }
    if (address.pathname === '/api/topics/a/state') {
      if (body.baseRevision !== state.topic.revision) return json({ error: '合成版本冲突' }, 409);
      Object.assign(state.topic, {
        ledger: body.map.ledger,
        raw: body.map.raw,
        panel: body.map,
        revision: state.topic.revision + 1,
      });
      if (state.loseSaveResponse) {
        state.loseSaveResponse = false;
        state.offline = true;
        throw new TypeError('Response lost');
      }
      return json({ revision: state.topic.revision });
    }
    if (address.pathname === '/api/topics/a/tasks') {
      if (state.acceptTaskRequests) {
        const task = {
          id: `task-${state.tasks.length + 1}`,
          topicId: 'a',
          status: 'running',
          mode: 'operation',
          action: body.action,
          params: body.params,
        };
        state.tasks.push(task);
        return json(task);
      }
      state.offline = true;
      throw new TypeError('Enqueue response lost');
    }
    if (address.pathname === '/api/runtime/executor')
      return json({ error: '合成 Agent 不可用' }, 503);
    if (address.pathname === '/api/connections') return json([]);
    throw new Error(`未预期请求：${address.pathname}`);
  };
  const local = createLocalRuntime({
    onRequestUpdate: async () => null,
    onError: message => state.errors.push(message),
  });
  try {
    await run({ local, state, cache });
  } finally {
    local.dispose();
    // Let an already queued final save finish before restoring the test globals.
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('Agent 切换不可用不误报服务掉线，但同一入口真正断线仍提示重连', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    await assert.rejects(
      local.request('/api/runtime/executor', { agent: 'claude-acp' }),
      /合成 Agent 不可用/,
    );
    assert.equal(local.service.getSnapshot().phase, 'connected');
    state.offline = true;
    await assert.rejects(
      local.request('/api/runtime/executor', { agent: 'claude-acp' }),
      /本地服务连接中断/,
    );
    assert.equal(local.service.getSnapshot().phase, 'disconnected');
  });
});

test('Agent 探测允许首次组件准备，普通读取仍及时超时，关闭探测仍可立即取消', async t => {
  const original = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  globalThis.fetch = async (_url, { signal }) =>
    new Promise((resolve, reject) => {
      requests.push({ signal, resolve });
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
    });
  try {
    const ordinary = assert.rejects(localRequest('/api/topics'), /本地服务连接中断/);
    const discovery = localRequest('/api/runtime/executors');
    t.mock.timers.tick(10000);
    await ordinary;
    assert.equal(requests[1].signal.aborted, false);
    const expired = assert.rejects(discovery, /本地服务连接中断/);
    t.mock.timers.tick(230000);
    await expired;
    const controller = new AbortController();
    const cancelled = assert.rejects(
      localRequest('/api/runtime/executors', undefined, controller.signal),
      { name: 'AbortError' },
    );
    controller.abort();
    await cancelled;
  } finally {
    globalThis.fetch = original;
    t.mock.timers.reset();
  }
});

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
    assert.equal(
      state.calls.filter(call => call.url.endsWith('/tasks') && call.method === 'POST').length,
      1,
    );
    assert.equal(local.store.getState().nodes[0].title, '原判断');
  });
});

test('节点停止请求断线不伪报结束，重连确认取消且不重新生成', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    state.acceptTaskRequests = true;
    const running = local.store.getState().refineNode('j1');
    await waitFor(() => state.tasks.length === 1);
    await waitFor(() => state.calls.some(call => call.url.endsWith('/status')));
    state.offline = true;
    local.store.getState().cancelNodeRefinement('j1');
    assert.equal(local.service.getSnapshot().stoppingTaskIds.length, 1, '反馈不等网络');
    await running;
    assert.equal(state.tasks[0].status, 'running');
    assert.match(local.service.getSnapshot().stopError, /停止尚未确认/);
    state.offline = false;
    await local.service.retry();
    assert.equal(state.tasks[0].status, 'cancelled');
    assert.equal(local.service.getSnapshot().stoppingTaskIds.length, 0);
    assert.equal(local.store.getState().nodes[0].title, '原判断');
    assert.equal(state.calls.filter(call => call.url === '/api/topics/a/tasks').length, 1);
  });
});

test('停止回执丢失时重试核对真实状态，确认后不再显示停止中，也不把任务接回', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    state.tasks.push({
      id: 'stop-reply-lost',
      topicId: 'a',
      action: 'tidy',
      mode: 'operation',
      status: 'running',
    });
    state.loseCancelResponse = true;
    await local.cancelTask('stop-reply-lost', 'a');
    assert.equal(state.tasks[0].status, 'cancelled');
    assert.equal(local.service.getSnapshot().stoppingTaskIds.length, 1, '连接断开时如实显示未确认');
    assert.match(local.service.getSnapshot().stopError, /停止尚未确认/);
    state.offline = false;
    await local.service.retry();
    assert.equal(local.service.getSnapshot().stoppingTaskIds.length, 0);
    assert.equal(local.service.getSnapshot().stopError, '');
    assert.equal(local.store.getState().isTidying, false);
    assert.equal(state.calls.filter(call => call.url === '/api/topics/a/tasks').length, 0);
  });
});

test('停止状态只存在当前页面：重新打开不再显示上次未确认的停止', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    state.offline = true;
    await local.cancelTask('unconfirmed', 'a');
    assert.equal(local.service.getSnapshot().stoppingTaskIds.length, 1);
    await local.dispose();
    state.offline = false;
    const reopened = createLocalRuntime({
      onRequestUpdate: async () => null,
      onError: message => state.errors.push(message),
    });
    try {
      assert.equal(reopened.service.getSnapshot().stoppingTaskIds.length, 0);
    } finally {
      await reopened.dispose();
    }
  });
});

test('停止与完成竞态保留真实结果，不把完成说成取消，重复停止合并请求', async () => {
  await fixture(async ({ local, state }) => {
    await local.start();
    state.tasks.push({ id: 'done-first', topicId: 'a', status: 'running' });
    state.cancelHold = deferred();
    const first = local.cancelTask('done-first', 'a');
    const second = local.cancelTask('done-first', 'a');
    await waitFor(() => state.calls.some(call => call.url.endsWith('/cancel')));
    state.tasks[0].status = 'completed';
    state.cancelHold.resolve();
    const result = await first;
    await second;
    assert.equal(result.status, 'completed');
    assert.equal(state.calls.filter(call => call.url.endsWith('/cancel')).length, 1);
    assert.equal(local.service.getSnapshot().stoppingTaskIds.length, 0);
    assert.match(state.errors.at(-1), /停止前任务已完成/);
  });
});

test('停止请求无响应时有限重试后结束等待，提示可以重试', async t => {
  await fixture(async ({ local, state }) => {
    await local.start();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) =>
      url.endsWith('/cancel')
        ? new Promise((_, reject) =>
            init.signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            ),
          )
        : original(url, init);
    try {
      let done = false;
      const stopping = local.cancelTask('stalled', 'a').finally(() => {
        done = true;
      });
      // Three attempts, each bounded by the request timeout, with short pauses between.
      for (let i = 0; i < 200 && !done; i++) {
        t.mock.timers.tick(500);
        await new Promise(resolve => setImmediate(resolve));
      }
      await stopping;
      assert.equal(local.service.getSnapshot().stoppingTaskIds.length, 1);
      assert.match(local.service.getSnapshot().stopError, /停止尚未确认/);
    } finally {
      globalThis.fetch = original;
      t.mock.timers.reset();
    }
  });
});

test('连续失败采用退避，dispose 清理唤醒事件与定时检查', async t => {
  await fixture(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const monitor = createReconnectMonitor(async () => {
      calls++;
      throw new Error('offline');
    });
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
    } finally {
      monitor.dispose();
      t.mock.timers.reset();
    }
  });
});
