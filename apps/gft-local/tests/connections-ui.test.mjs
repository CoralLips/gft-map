import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const cacheRoot = path.resolve(web, '../node_modules/.cache');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};
const baseLedger =
  '[场次 2026-09-17T10:00:00Z · 合成回放]\n走向 p3 [主题]\n只处理合成材料。\n◆ j1 [验证] 原判断\n保留原文。';
const source = (id, provider = 'codex') => ({
  provider,
  id,
  title: `合成会话 ${id}`,
  cwd: 'synthetic',
  updatedAt: '2026-09-17T10:00:00Z',
});
const connection = (id, topicId = 'a', loadedRevision = null) => ({
  id,
  topicId,
  source: source(id),
  history: 'now',
  loadedRevision,
});
let directory, createLocalRuntime, connectionLoadLabel, receiptDisplayText;
before(async () => {
  await mkdir(cacheRoot, { recursive: true });
  directory = await mkdtemp(path.join(cacheRoot, 'gft-connections-ui-'));
  const outfile = path.join(directory, 'runtime.mjs');
  await build({
    stdin: {
      contents:
        'export { createLocalRuntime } from "./localRuntime"; export { connectionLoadLabel, receiptDisplayText } from "./ConnectionManager";',
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
  ({ createLocalRuntime, connectionLoadLabel, receiptDisplayText } = await import(
    pathToFileURL(outfile).href
  ));
});
after(async () => {
  const relative = path.relative(cacheRoot, path.resolve(directory));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(directory, { recursive: true, force: true });
});
async function fixture(options, run) {
  const previousFetch = globalThis.fetch,
    previousStorage = globalThis.localStorage;
  const cache = new Map();
  globalThis.localStorage = {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
  };
  const state = {
    topics: new Map(
      ['a', 'b'].map(id => [
        id,
        {
          id,
          name: `主题 ${id}`,
          scope: '只处理合成材料。',
          revision: 1,
          ledger: baseLedger.replace('原判断', `${id} 原判断`),
          raw: baseLedger,
        },
      ]),
    ),
    connections: options.connections || [],
    calls: [],
    task: 'completed',
    chooses: 0,
    errors: [],
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(String(url), 'http://synthetic.local');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = {
      pathname: address.pathname,
      query: address.searchParams,
      body,
      method: init.method || 'GET',
      signal: init.signal,
    };
    state.calls.push(call);
    const override = await options.route?.(call, state, json);
    if (override !== undefined) return override;
    if (address.pathname === '/api/tasks') return json([]);
    if (address.pathname === '/api/topics')
      return json(
        [...state.topics.values()].map(({ id, name }) => ({ id, name, status: 'active' })),
      );
    if (address.pathname === '/api/connections')
      return json(
        state.connections.filter(item => item.topicId === address.searchParams.get('topicId')),
      );
    if (address.pathname === '/api/connections/connect') {
      const created = body.topicIds.map(topicId => ({
        id: `${body.source.id}-${topicId}`,
        topicId,
        source: body.source,
        history: body.history,
        loadedRevision: null,
      }));
      state.connections.push(...created);
      return json(created);
    }
    if (address.pathname === '/api/connections/disconnect') {
      state.connections = state.connections.filter(item => item.id !== body.connectionId);
      return json({ disconnected: [body.connectionId] });
    }
    if (address.pathname.endsWith('/update-receipt'))
      return json({
        topicId: address.pathname.split('/')[3],
        currentRevision: state.topics.get(address.pathname.split('/')[3])?.revision,
        receipt: null,
      });
    const topicMatch = address.pathname.match(
      /^\/api\/topics\/([^/]+)\/(snapshot|state|sources|update-from-chat|operations|rollback-operation)$/,
    );
    if (topicMatch) {
      const topic = state.topics.get(topicMatch[1]);
      if (topicMatch[2] === 'snapshot') return json({ topic });
      if (topicMatch[2] === 'operations')
        return json({
          currentRevision: topic.revision,
          operations: [
            { id: 'task-1', ...(state.rolledBackAt ? { rolledBackAt: state.rolledBackAt } : {}) },
          ],
        });
      if (topicMatch[2] === 'rollback-operation') {
        state.rolledBackAt = new Date().toISOString();
        // The synthetic updates only append AI lines; rolling back drops them and keeps the material.
        topic.ledger = topic.ledger
          .split('\n')
          .filter(line => !line.startsWith('AI '))
          .join('\n');
        topic.revision++;
        return json({ revision: topic.revision });
      }
      if (topicMatch[2] === 'sources') return json([]);
      if (topicMatch[2] === 'state') {
        if (body.baseRevision !== topic.revision) return json({ error: '合成版本冲突' }, 409);
        Object.assign(topic, {
          ledger: body.map.ledger,
          raw: body.map.raw,
          revision: topic.revision + 1,
        });
        return json({ revision: topic.revision });
      }
      return json({ task: { id: 'task-1' } });
    }
    if (address.pathname === '/api/tasks/task-1/status')
      return json({
        status: state.task,
        error: state.task === 'failed' ? '合成来源无法读取' : undefined,
      });
    if (address.pathname === '/api/tasks/task-1/cancel') {
      state.task = 'cancelled';
      return json({ status: 'cancelled' });
    }
    throw new Error(`未预期的合成请求：${address.pathname}`);
  };
  const local = createLocalRuntime({
    onRequestUpdate: options.manual || (async () => null),
    onRequestSource: async (...args) => {
      state.chooses++;
      return options.choose?.(...args) ?? null;
    },
    onError: message => state.errors.push(message),
  });
  try {
    await local.start();
    await local.connections.refresh();
    await run({ local, state });
  } finally {
    await local.dispose();
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
}
const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待 UI 状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('首次无主题直接按已连接来源更新，不弹主题选项也不额外调用推荐', async () => {
  await fixture({ connections: [connection('one')] }, async ({ local, state }) => {
    const topic = state.topics.get('a');
    topic.ledger = '';
    topic.raw = '';
    topic.scope = '';
    await local.host.switchProject('b');
    await local.host.switchProject('a');
    await local.host.requestUpdate();
    assert.equal(state.chooses, 0);
    assert.equal(state.calls.filter(call => call.pathname.endsWith('update-from-chat')).length, 1);
    assert.equal(
      state.calls.filter(
        call => call.pathname.endsWith('compute') || call.pathname === '/api/chat-preview',
      ).length,
      0,
    );
    assert.equal(local.connections.getSnapshot().operation.phase, 'completed');
  });
});

test('更新同次返回的名称随图文同步，下拉框无需刷新且不另发命名任务', async () => {
  await fixture(
    {
      connections: [connection('one')],
      route: (call, state, json) => {
        if (call.pathname.endsWith('/update-from-chat')) {
          const topic = state.topics.get('a');
          topic.name = '同次生成的名称';
          topic.revision++;
          return json({ task: { id: 'task-1' } });
        }
      },
    },
    async ({ local, state }) => {
      await local.host.requestUpdate();
      assert.equal(
        local.host.getSnapshot().projects.find(p => p.id === 'a').name,
        '同次生成的名称',
      );
      assert.equal(
        state.calls.filter(c => c.pathname.endsWith('/compute') || c.pathname.endsWith('/rename'))
          .length,
        0,
      );
    },
  );
});

test('连续更新固定起点时的末尾，自动读取下一批；空增量不创建计算任务', async () => {
  let batches = 0;
  const until = { snapshot: 'fixed-head' };
  await fixture(
    {
      connections: [connection('one')],
      route: (call, state, json) => {
        if (call.pathname.endsWith('/update-from-chat')) {
          batches++;
          if (batches > 1) assert.deepEqual(call.body.until, until);
          return json({ task: { id: 'task-1' }, hasMore: batches < 3, until, messageCount: 2 });
        }
      },
    },
    async ({ local }) => {
      await local.host.requestUpdate();
      assert.equal(batches, 3);
      assert.equal(local.connections.getSnapshot().operation.phase, 'completed');
      assert.equal(local.connections.getSnapshot().operation.hasMore, false);
    },
  );
});

test('断开标签立即消失；保存失败后恢复连接并报告错误', async () => {
  const gate = deferred();
  await fixture(
    {
      connections: [connection('one')],
      route: async (call, state, json) => {
        if (call.pathname === '/api/connections/disconnect') {
          await gate.promise;
          return json({ error: '断开失败' }, 500);
        }
      },
    },
    async ({ local }) => {
      const pending = local.connections.disconnect('one');
      assert.equal(local.connections.getSnapshot().connections.length, 0);
      gate.resolve();
      await assert.rejects(pending, /断开失败/);
      assert.equal(local.connections.getSnapshot().connections.length, 1);
    },
  );
});

test('连接和聊天最近读取分别表达；旧版本不会冒充当前上下文', () => {
  assert.equal(connectionLoadLabel(connection('one'), 3), '待读取');
  assert.equal(connectionLoadLabel(connection('one', 'a', 3), 3), '聊天最近读取 · 版本 3');
  assert.equal(
    connectionLoadLabel(connection('one', 'a', 2), 3),
    '聊天最近读取 · 版本 2 · 脉络有更新',
  );
});

test('无连接点击更新立即显示读取，取消选择不写连接或提交任务', async () => {
  const gate = deferred();
  let blocked = false;
  await fixture(
    {
      route: async call => {
        if (blocked && call.pathname === '/api/connections') await gate.promise;
      },
    },
    async ({ local, state }) => {
      blocked = true;
      const pending = local.host.requestUpdate();
      assert.equal(local.connections.getSnapshot().operation.phase, 'reading');
      assert.equal(state.chooses, 0);
      gate.resolve();
      await pending;
      assert.equal(state.chooses, 1);
      assert.equal(local.connections.getSnapshot().operation, null);
      assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);
    },
  );
});

test('单连接直接更新：先保存 Doc/节点修改，再提交任务并同步后台结果', async () => {
  await fixture(
    {
      connections: [connection('one')],
      route: (call, state) => {
        if (call.pathname === '/api/tasks/task-1/status') {
          const topic = state.topics.get('a');
          topic.ledger += '\nAI 改 j1 标题：聊天更新后的判断';
          topic.revision++;
        }
      },
    },
    async ({ local, state }) => {
      local.store.getState().updateNode('j1', { title: '手工判断' });
      local.store
        .getState()
        .setDocDraft(local.store.getState().doc.replace('保留原文。', '刚输入但尚未失焦的正文。'));
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
    },
  );
});

const rollbacks = state =>
  state.calls
    .filter(call => call.pathname.endsWith('/rollback-operation'))
    .map(call => call.body.receiptId);

test('多个已连接会话一次更新全部读取，不再选择来源，图文变化合为一次撤销', async () => {
  await fixture(
    {
      connections: [connection('one'), connection('two')],
      route: (call, state, json) => {
        if (call.pathname.endsWith('/update-from-chat')) {
          const topic = state.topics.get('a');
          topic.ledger += `\nAI 改 j1 标题：${call.body.connectionId} 更新后的判断`;
          topic.raw += `\n已接收 ${call.body.connectionId}`;
          topic.revision++;
          return json({ task: { id: 'task-1' } });
        }
      },
    },
    async ({ local, state }) => {
      const before = local.store.getState().ledger;
      await local.host.requestUpdate();
      assert.equal(state.chooses, 0);
      assert.deepEqual(
        state.calls
          .filter(call => call.pathname.endsWith('update-from-chat'))
          .map(call => call.body.connectionId),
        ['one', 'two'],
      );
      const after = local.store.getState().ledger;
      assert.match(after, /two 更新后的判断/);
      local.store.getState().undo();
      assert.equal(local.store.getState().ledger, before);
      assert.match(local.store.getState().raw, /已接收 one\n已接收 two/);
      // Rolled back on the server by receipt; such a step is not redone.
      await waitFor(() => rollbacks(state).length > 0);
      local.store.getState().redo();
      assert.equal(local.store.getState().ledger, before);
    },
  );
});

test('聊天更新进入统一撤销栈，撤销图文保留材料且仍可撤销更早手工修改', async () => {
  await fixture(
    {
      connections: [connection('one')],
      route: (call, state, json) => {
        if (call.pathname.endsWith('/update-from-chat')) {
          const topic = state.topics.get('a');
          topic.ledger += '\nAI 改 j1 标题：聊天更新后的判断';
          topic.raw += '\n已接收的新材料';
          topic.revision++;
          return json({ task: { id: 'task-1' } });
        }
      },
    },
    async ({ local, state }) => {
      const original = local.store.getState().ledger;
      local.store.getState().updateNode('j1', { title: '手工修改' });
      const before = local.store.getState().ledger;
      await local.host.requestUpdate();
      const after = local.store.getState().ledger;
      assert.notEqual(after, before);
      local.store.getState().undo();
      assert.equal(local.store.getState().ledger, before);
      assert.match(local.store.getState().raw, /已接收的新材料/);
      local.store.getState().undo();
      assert.equal(local.store.getState().ledger, original);
      await waitFor(() => rollbacks(state).length > 0);
      // Only the hand edit comes back; the server rollback is not redone.
      local.store.getState().redo();
      local.store.getState().redo();
      assert.equal(local.store.getState().ledger, before);
    },
  );
});

test('取消发生在提交响应在途时，收到任务 ID 后仍发取消且不重置内容', async () => {
  const gate = deferred();
  let enqueued = false;
  await fixture(
    {
      connections: [connection('one')],
      route: async call => {
        if (call.pathname.endsWith('update-from-chat')) {
          enqueued = true;
          await gate.promise;
        }
      },
    },
    async ({ local, state }) => {
      const before = local.store.getState().ledger;
      const pending = local.host.requestUpdate();
      await waitFor(() => enqueued);
      local.connections.cancel();
      assert.equal(local.connections.getSnapshot().operation.phase, 'cancelling');
      gate.resolve();
      await pending;
      assert.equal(local.connections.getSnapshot().operation.phase, 'cancelled');
      assert.equal(state.calls.filter(call => call.pathname.endsWith('/cancel')).length, 1);
      assert.equal(local.store.getState().ledger, before);
    },
  );
});

test('多来源各自固定批次末尾，一次撤销包含全部批次，空来源不会终止后续读取', async () => {
  const batches = new Map();
  await fixture(
    {
      connections: [connection('empty'), connection('one'), connection('two')],
      route: (call, state, json) => {
        if (!call.pathname.endsWith('/update-from-chat')) return;
        const id = call.body.connectionId;
        if (id === 'empty') return json({ unchanged: true });
        const n = (batches.get(id) || 0) + 1;
        batches.set(id, n);
        if (n === 1) assert.equal(call.body.until, undefined);
        else assert.deepEqual(call.body.until, { end: id });
        const topic = state.topics.get('a');
        topic.ledger += `\nAI 改 j1 标题：${id} 第 ${n} 批`;
        topic.raw += `\n材料 ${id}-${n}`;
        topic.revision++;
        return json({ task: { id: 'task-1' }, hasMore: n < 2, until: { end: id } });
      },
    },
    async ({ local, state }) => {
      const before = local.store.getState().ledger;
      await local.host.requestUpdate();
      assert.deepEqual(
        [...batches],
        [
          ['one', 2],
          ['two', 2],
        ],
      );
      const group = local.connections.getSnapshot().operation.undoGroup;
      assert.equal(local.store.getState().canUndoGroup(group), true);
      local.connections.undo();
      assert.equal(local.store.getState().ledger, before);
      assert.match(local.store.getState().raw, /材料 two-2/);
      await waitFor(() => rollbacks(state).length > 0);
      assert.deepEqual(rollbacks(state), ['task-1'], '同一回执只撤回一次');
    },
  );
});

test('后续来源失败或取消时，停止队列并保留前面成功的更新及撤销入口', async () => {
  for (const cancel of [false, true]) {
    const gate = deferred();
    let secondStarted = false;
    await fixture(
      {
        connections: [connection('one'), connection('two'), connection('three')],
        route: async (call, state, json) => {
          if (!call.pathname.endsWith('/update-from-chat')) return;
          if (call.body.connectionId === 'two') {
            secondStarted = true;
            await gate.promise;
            return cancel
              ? json({ task: { id: 'task-1' } })
              : json({ error: '第二个来源暂时不可用' }, 400);
          }
          const topic = state.topics.get('a');
          topic.ledger += '\nAI 改 j1 标题：第一个来源完成';
          topic.revision++;
          return json({ task: { id: 'task-1' } });
        },
      },
      async ({ local, state }) => {
        const before = local.store.getState().ledger;
        const pending = local.host.requestUpdate();
        await waitFor(() => secondStarted);
        if (cancel) local.connections.cancel();
        gate.resolve();
        await pending;
        assert.equal(
          local.connections.getSnapshot().operation.phase,
          cancel ? 'cancelled' : 'failed',
        );
        assert.deepEqual(
          state.calls
            .filter(call => call.pathname.endsWith('/update-from-chat'))
            .map(call => call.body.connectionId),
          ['one', 'two'],
        );
        assert.match(local.store.getState().ledger, /第一个来源完成/);
        local.connections.undo();
        assert.equal(local.store.getState().ledger, before);
      },
    );
  }
});

test('无增量不制造撤销步骤；有后续手工编辑时，通知撤销不能误撤手工内容', async () => {
  let empty = true;
  await fixture(
    {
      connections: [connection('one')],
      route: (call, state, json) => {
        if (!call.pathname.endsWith('/update-from-chat')) return;
        if (empty) return json({ unchanged: true });
        const topic = state.topics.get('a');
        topic.ledger += '\nAI 改 j1 标题：更新完成';
        topic.revision++;
        return json({ task: { id: 'task-1' } });
      },
    },
    async ({ local }) => {
      const original = local.store.getState().ledger;
      local.store.getState().updateNode('j1', { title: '先手工修改' });
      await local.host.requestUpdate();
      assert.equal(local.connections.getSnapshot().operation.undoGroup, undefined);
      local.store.getState().undo();
      assert.equal(local.store.getState().ledger, original);
      empty = false;
      await local.host.requestUpdate();
      const group = local.connections.getSnapshot().operation.undoGroup;
      local.store.getState().updateNode('j1', { title: '更新后的手工修改' });
      assert.equal(local.store.getState().canUndoGroup(group), false);
      const manual = local.store.getState().ledger;
      local.connections.undo();
      assert.equal(local.store.getState().ledger, manual);
      local.store.getState().undo();
      assert.match(local.store.getState().ledger, /更新完成/);
      local.store.getState().undo();
      assert.equal(local.store.getState().ledger, original);
    },
  );
});

test('切主题首帧清除旧连接及进度，旧任务迟到不会同步进新主题', async () => {
  const gate = deferred();
  let enqueued = false;
  await fixture(
    {
      connections: [connection('one'), connection('other', 'b')],
      route: async call => {
        if (call.pathname.endsWith('update-from-chat')) {
          enqueued = true;
          await gate.promise;
        }
      },
    },
    async ({ local, state }) => {
      const pending = local.host.requestUpdate();
      await waitFor(() => enqueued);
      const switchPending = local.host.switchProject('b');
      assert.equal(local.connections.getSnapshot().topicId, 'b');
      assert.deepEqual(local.connections.getSnapshot().connections, []);
      assert.equal(local.connections.getSnapshot().operation, null);
      await switchPending;
      gate.resolve();
      await pending;
      assert.equal(local.host.getSnapshot().currentProjectId, 'b');
      assert.match(local.store.getState().doc, /b 原判断/);
      assert.equal(local.connections.getSnapshot().operation, null);
      assert.ok(state.calls.some(call => call.pathname.endsWith('/cancel')));
    },
  );
});

test('来源任务失败显示真实错误并保留原图文，无新消息有明确结果', async () => {
  await fixture({ connections: [connection('one')] }, async ({ local, state }) => {
    const before = local.store.getState().ledger;
    state.task = 'failed';
    await local.host.requestUpdate();
    assert.equal(local.connections.getSnapshot().operation.phase, 'failed');
    assert.match(local.connections.getSnapshot().operation.message, /合成来源无法读取/);
    assert.equal(local.store.getState().ledger, before);
  });
  await fixture(
    {
      connections: [connection('one')],
      route: (call, _state, json) =>
        call.pathname.endsWith('update-from-chat')
          ? json({ unchanged: true, message: '没有新增消息' })
          : undefined,
    },
    async ({ local, state }) => {
      await local.host.requestUpdate();
      assert.equal(local.connections.getSnapshot().operation.message, '已连接会话没有新增材料。');
      assert.equal(state.calls.filter(call => call.pathname.includes('/api/tasks/')).length, 0);
    },
  );
});

test('一次确认可连接多个主题；单条与当前主题全部断开不影响其他主题', async () => {
  await fixture({}, async ({ local, state }) => {
    const items = await local.connections.connect(source('shared', 'claude'), ['a', 'b'], 'all');
    assert.equal(items.length, 2);
    assert.equal(items[0].loadedRevision, null);
    await local.connections.connect(source('second'), ['a'], 'now');
    await local.connections.disconnect('second-a');
    assert.deepEqual(
      state.connections.map(item => item.id),
      ['shared-a', 'shared-b'],
    );
    await local.connections.disconnectAll('a');
    assert.deepEqual(
      state.connections.map(item => item.id),
      ['shared-b'],
    );
  });
});

const savedReceipt = (id = 'saved-update') => ({
  id,
  action: 'update',
  baseRevision: 0,
  resultRevision: 1,
  createdAt: '2026-10-10T08:00:00Z',
  source: { provider: 'codex', sessionTitle: '企业的性质', messageCount: 2 },
  changes: {
    nodes: [
      {
        id: 'j1',
        kind: 'modified',
        before: {
          id: 'j1',
          title: '旧判断',
          content: '旧说明',
          mark: '◆',
          domain: '验证',
          superseded: false,
        },
        after: {
          id: 'j1',
          title: 'a 原判断',
          content: '保留原文。',
          mark: '◆',
          domain: '验证',
          superseded: false,
        },
      },
    ],
    edges: { added: [], removed: [] },
    chapters: [],
    doc: null,
  },
  canRollback: true,
  rollbackBlockedReason: null,
});

test('保存的最近改动在重新打开页面后仍可读取，不依赖本场完成提示', async () => {
  await fixture(
    {
      route: (call, state, json) =>
        call.pathname.endsWith('/update-receipt')
          ? json({
              topicId: call.pathname.split('/')[3],
              currentRevision: 1,
              receipt: savedReceipt(),
            })
          : undefined,
    },
    async ({ local }) => {
      assert.equal(local.connections.getSnapshot().operation, null);
      assert.equal(local.receipts.getSnapshot().receipt.id, 'saved-update');
      const second = createLocalRuntime({ onRequestUpdate: async () => null, onError: () => {} });
      try {
        await second.start();
        assert.equal(second.receipts.getSnapshot().receipt.id, 'saved-update');
        assert.equal(second.connections.getSnapshot().operation, null);
      } finally {
        second.dispose();
      }
    },
  );
});

test('未保存的 Doc 编辑会阻止整次退回，不会自动提交或吞掉草稿', async () => {
  await fixture(
    {
      route: (call, state, json) =>
        call.pathname.endsWith('/update-receipt')
          ? json({ topicId: 'a', currentRevision: 1, receipt: savedReceipt() })
          : undefined,
    },
    async ({ local, state }) => {
      local.store.getState().setDocDraft('仍在编辑的理解');
      await local.receipts.rollback();
      assert.equal(local.store.getState().docDraft, '仍在编辑的理解');
      assert.match(local.receipts.getSnapshot().error, /先完成或取消当前编辑/);
      assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);
    },
  );
});

test('版本冲突时保留当前图文并显示服务端原因，不会刷新覆盖草稿', async () => {
  await fixture(
    {
      route: (call, state, json) => {
        if (call.pathname.endsWith('/update-receipt'))
          return json({ topicId: 'a', currentRevision: 1, receipt: savedReceipt() });
        if (call.pathname.endsWith('/rollback-update'))
          return json({ error: '这次更新之后已有其他修改，不能整次退回。' }, 409);
      },
    },
    async ({ local, state }) => {
      const doc = local.store.getState().doc;
      await local.receipts.rollback();
      assert.equal(local.store.getState().doc, doc);
      assert.match(local.receipts.getSnapshot().error, /已有其他修改/);
      const request = state.calls.find(call => call.pathname.endsWith('/rollback-update'));
      assert.equal(request.body.baseRevision, 1);
      assert.equal(request.body.receiptId, 'saved-update');
      assert.equal(local.receipts.getSnapshot().rollingBack, false);
    },
  );
});

test('退回请求等待期间开始的本地编辑仍然保留', async () => {
  const gate = deferred();
  let posted = false,
    rolledBack = false;
  await fixture(
    {
      route: async (call, state, json) => {
        if (call.pathname.endsWith('/update-receipt'))
          return json({
            topicId: 'a',
            currentRevision: rolledBack ? 2 : 1,
            receipt: {
              ...savedReceipt(),
              canRollback: !rolledBack,
              ...(rolledBack ? { rolledBackAt: '2026-10-10T08:02:00Z' } : {}),
            },
          });
        if (call.pathname.endsWith('/rollback-update')) {
          posted = true;
          await gate.promise;
          rolledBack = true;
          const topic = state.topics.get('a');
          topic.ledger = topic.ledger.replace('a 原判断', '恢复的旧判断');
          topic.revision = 2;
          return json({ id: 'a', revision: 2 });
        }
      },
    },
    async ({ local }) => {
      const pending = local.receipts.rollback();
      await waitFor(() => posted);
      local.store.getState().setDocDraft('退回期间仍在编写的内容');
      gate.resolve();
      await pending;
      assert.equal(local.store.getState().docDraft, '退回期间仍在编写的内容');
      assert.equal(local.receipts.getSnapshot().receipt.rolledBackAt, '2026-10-10T08:02:00Z');
      assert.equal(local.receipts.getSnapshot().rollingBack, false);
    },
  );
});

test('读取改动失败不把已完成更新报告成失败', async () => {
  await fixture(
    {
      connections: [connection('one')],
      route: (call, state, json) => {
        if (call.pathname.endsWith('/update-receipt'))
          return json({ error: '改动暂时无法读取' }, 503);
      },
    },
    async ({ local }) => {
      await local.host.requestUpdate();
      assert.equal(local.connections.getSnapshot().operation.phase, 'completed');
      assert.match(local.receipts.getSnapshot().error, /改动暂时无法读取/);
    },
  );
});

test('换主题后迟到的改动记录不能串进新的脉络', async () => {
  const gate = deferred();
  let held = false,
    block = false;
  await fixture(
    {
      route: async (call, state, json) => {
        if (call.pathname.endsWith('/update-receipt')) {
          const id = call.pathname.split('/')[3];
          if (block && id === 'a') {
            held = true;
            await gate.promise;
          }
          return json({ topicId: id, currentRevision: 1, receipt: savedReceipt(`update-${id}`) });
        }
      },
    },
    async ({ local }) => {
      block = true;
      const pending = local.receipts.refresh();
      await waitFor(() => held);
      await local.host.switchProject('b');
      gate.resolve();
      await pending;
      assert.equal(local.receipts.getSnapshot().topicId, 'b');
      assert.equal(local.receipts.getSnapshot().receipt.id, 'update-b');
    },
  );
});

test('节点短说明编辑期间不能整次退回或被同步覆盖', async () => {
  await fixture(
    {
      route: (call, state, json) =>
        call.pathname.endsWith('/update-receipt')
          ? json({ topicId: 'a', currentRevision: 1, receipt: savedReceipt() })
          : undefined,
    },
    async ({ local, state }) => {
      local.store.getState().setEditingNodeBody('j1');
      await local.receipts.rollback();
      assert.equal(local.store.getState().editingNodeBodyId, 'j1');
      assert.match(local.receipts.getSnapshot().error, /先完成或取消当前编辑/);
      assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);
      local.store.getState().setEditingNodeBody(null);
    },
  );
});

test('回执隐藏段末节点锚，不改变正文中的普通文字和源字符串', () => {
  const source =
    '> ◆ 使用市场也要付成本 ^j15\n\n正文说明，^j15 在句中是原材料的一部分。\n> ◇ 新的条件 ^j23  \r\n';
  assert.equal(
    receiptDisplayText(source),
    '> ◆ 使用市场也要付成本\n\n正文说明，^j15 在句中是原材料的一部分。\n> ◇ 新的条件\r\n',
  );
  assert.ok(source.includes('成本 ^j15'));
});
