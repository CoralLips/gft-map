import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import * as store from '../store.mjs';

const ledger = `[场次 2026-01-01T00:00:00Z · local-agent · 创建脉络]
走向 p1 [主题]
企业为什么存在，以及企业的边界。
◆ j2 [组织] 先约定职责
双方先谈好职责和报酬，具体任务以后再定。
◆ j3 [组织] 内部组织也有代价
团队扩大会增加排期冲突。
本人 接 j3 j2`;

async function isolated(execute, run, seedLedger = ledger) {
  const home = await mkdtemp(path.join(tmpdir(), 'gft-server-operations-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = home;
  const server = await startServer({ port: 0, agent: 'codex', execute });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => {
    const response = await fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  post.base = base;
  const finished = async id => {
    for (let i = 0; i < 400; i++) {
      const task = await store.getTaskStatus(id);
      if (!['pending', 'running'].includes(task.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('任务未结束');
  };
  try {
    const topic = await store.createTopic('服务端操作', '', { ledger: seedLedger, raw: '' });
    await run({ topic, post, finished });
  } finally {
    await server.shutdown();
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test('整理进行中，任务状态带出已写出的编辑动作（用真实节点编号），结束后不再带', async () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const written =
    '<merge title="先约定职责再看代价" body="两条一起说明。" members="n1,n2"/>\n<prose domain="组织" refs="n1,n2">';
  await isolated(
    async (request, { onText }) => {
      onText(written);
      await gate;
      return `${written}先约定职责，团队扩大后再看排期代价。</prose>`;
    },
    async ({ topic, post, finished }) => {
      const task = await post(`/api/topics/${topic.id}/tasks`, { action: 'tidy', params: {} });
      let status;
      for (let i = 0; i < 200 && !status?.progress; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        status = await (await fetch(`${post.base}/api/tasks/${task.id}/status`)).json();
      }
      release();
      assert.deepEqual(status.progress, [
        { kind: 'merge', title: '先约定职责再看代价', ids: ['j2', 'j3'] },
        { kind: 'prose', domain: '组织' },
      ]);
      assert.equal((await finished(task.id)).status, 'completed');
      const after = await (await fetch(`${post.base}/api/tasks/${task.id}/status`)).json();
      assert.equal(after.progress, undefined, '结束后不再带过程');
    },
  );
});

test('补一次收拢时，第二次调用的动作接在第一次之后计步', async () => {
  let calls = 0,
    release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const seed =
    '[场次 2026-01-01T00:00:00Z · 合成测试]\n走向 p1 [主题]\n仅保留合成判断。\n' +
    Array.from(
      { length: 9 },
      (_, i) => `◇ j${i + 1} [验证] 合成判断${i + 1}\n独立依据${i + 1}`,
    ).join('\n');
  await isolated(
    async (request, { onText }) => {
      const refs = [...request.user.matchAll(/^(n\d+) \[/gm)].map(match => match[1]).join(',');
      if (++calls === 1) {
        const prose = `<prose domain="验证" refs="${refs}">逐条核对独立依据。</prose>`;
        onText(prose);
        return prose;
      }
      const merge = '<merge title="合并前两条" body="两条依据。" members="n1,n2"/>\n';
      onText(merge);
      await gate;
      return `${merge}<prose domain="验证" refs="${refs}">合并后仍保留各自依据。</prose>`;
    },
    async ({ topic, post, finished }) => {
      const task = await post(`/api/topics/${topic.id}/tasks`, { action: 'tidy', params: {} });
      let status;
      for (let i = 0; i < 200 && status?.progress?.length !== 2; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        status = await (await fetch(`${post.base}/api/tasks/${task.id}/status`)).json();
      }
      release();
      assert.deepEqual(
        status.progress.map(action => action.kind),
        ['prose', 'merge'],
      );
      assert.equal((await finished(task.id)).status, 'completed');
    },
    seed,
  );
});

test('整理结构纠错期间仍可明确停止，迟到结果不得写入', async () => {
  let entered, release;
  const correcting = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let calls = 0;
  await isolated(
    async () => {
      if (++calls === 1)
        return (
          '<revise id="n1" domain="新章"/>' +
          '<prose domain="新章" refs="n1,n2">职责和内部成本分别保留。</prose>'
        );
      entered();
      await gate;
      return (
        '<revise id="n1" domain="新章"/><revise id="n2" domain="新章"/>' +
        '<prose domain="新章" refs="n1,n2">职责和内部成本分别保留。</prose>'
      );
    },
    async ({ topic, post, finished }) => {
      const before = await store.getView(topic.id);
      const task = await post(`/api/topics/${topic.id}/tasks`, { action: 'tidy', params: {} });
      try {
        await Promise.race([
          correcting,
          finished(task.id).then(() => {
            throw new Error('没有进入纠错');
          }),
        ]);
        assert.deepEqual((await store.getView(topic.id)).graph, before.graph);
        await post(`/api/tasks/${task.id}/cancel`, {});
      } finally {
        release();
      }
      const done = await finished(task.id);
      assert.equal(done.status, 'cancelled');
      assert.equal(calls, 2);
      const after = await store.getView(topic.id);
      assert.equal(after.doc, before.doc);
      assert.deepEqual(after.graph, before.graph);
    },
  );
});

test('节点整理保留长说明中的证据与条件，图文同源且可撤销（执行器回放）', () => {
  const original =
    '客户甲在9月6日试用，保存按钮失败了三次，依据是工单A-17和当日录屏。三次都在离线编辑后重连时发生，在线直接保存尚未复现；目前只排查重连后的保存流程，不能据此判断所有保存都会失败。客户暂未提供浏览器版本，根因仍未确定。';
  const revised =
    '客户甲9月6日试用时，离线编辑后重连保存失败了三次，证据为工单A-17和当日录屏。在线直接保存尚未复现，因此目前只排查重连后的保存流程，不能推断所有保存都会失败。客户暂未提供浏览器版本，根因仍未确定。';
  const seed = `${ledger.replace('先约定职责\n双方先谈好职责和报酬，具体任务以后再定。', `重连保存待排查\n${original}`)}
走向 p4 [组织]
本章记录目前能确认的情况。
> ^j2
这段独立说明保持原样。
> ^j3`;
  assert(original.length > 80 && revised.length > 80);
  return isolated(
    async request => {
      assert(request.system.includes(original), '执行器收到完整原说明');
      assert.match(request.system, /保留原标题和说明里的全部信息/);
      assert.match(request.system, /不会修改章节正文/);
      assert.doesNotMatch(request.system, /40[–—-]80/);
      return `<node title="重连保存问题待核实" body="${revised}"/>`;
    },
    async ({ topic, post, finished }) => {
      const before = await store.getView(topic.id);
      const task = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'refine',
        params: { nodeId: 'j2' },
      });
      const done = await finished(task.id);
      assert.equal(done.status, 'completed');
      assert.equal(done.changed, true);
      const view = await store.getView(topic.id);
      const node = view.graph.nodes.find(n => n.id === 'j2');
      assert.equal(node.title, '重连保存问题待核实');
      assert.equal(node.content, revised);
      assert.equal(
        view.doc,
        before.doc.replace('重连保存待排查', node.title).replace(original, revised),
      );
      assert.deepEqual(
        view.graph.nodes.find(n => n.id === 'j3'),
        before.graph.nodes.find(n => n.id === 'j3'),
      );
      assert.deepEqual(view.graph.edges, before.graph.edges);
      const { operations } = await store.getOperations(topic.id);
      assert.equal(operations[0].id, task.id);
      assert.equal(operations[0].canRollback, true);
      await store.rollbackOperation(topic.id, view.revision, task.id);
      const restored = await store.getView(topic.id);
      assert.equal(restored.doc, before.doc);
      assert.deepEqual(restored.graph, before.graph);
    },
    seed,
  );
});

test('节点在处理期间被改过时，旧结果不覆盖当前内容', () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  return isolated(
    async () => {
      await gate;
      return '<node title="模型的旧版本" body="旧说明"/>';
    },
    async ({ topic, post, finished }) => {
      const task = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'refine',
        params: { nodeId: 'j2' },
      });
      while ((await store.getTaskStatus(task.id)).status !== 'running')
        await new Promise(resolve => setTimeout(resolve, 20));
      const current = await store.getView(topic.id);
      await store.saveGraph(topic.id, current.revision, {
        kind: 'edit',
        id: 'j2',
        title: '人改过的标题',
      });
      release();
      const done = await finished(task.id);
      assert.equal(done.status, 'failed');
      assert.match(done.error, /处理期间已修改/);
      assert.equal(
        (await store.getView(topic.id)).graph.nodes.find(n => n.id === 'j2').title,
        '人改过的标题',
      );
    },
  );
});

test('服务端操作标记为只追加写入，浏览器可以把自己的编辑续接在后面', () =>
  isolated(
    async () => '<node title="先约定职责与范围"/>',
    async ({ topic, post, finished }) => {
      const task = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'refine',
        params: { nodeId: 'j2' },
      });
      await finished(task.id);
      const { topic: snapshot } = await store.getSnapshot(topic.id);
      assert.equal(snapshot.appendRevision, snapshot.revision);
      await store.saveGraph(topic.id, snapshot.revision, {
        kind: 'edit',
        id: 'j3',
        title: '人改过的标题',
      });
      const { topic: after } = await store.getSnapshot(topic.id);
      assert.equal(after.revision, snapshot.revision + 1);
      assert.notEqual(after.appendRevision, after.revision, '手工保存不是后台追加');
    },
  ));

test('之后的修改都已撤回、账本回到操作完成时，可以按回执撤回该操作', () =>
  isolated(
    async () => '<node title="先约定职责与范围"/>',
    async ({ topic, post, finished }) => {
      const task = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'refine',
        params: { nodeId: 'j2' },
      });
      await finished(task.id);
      const tidied = await store.getTopic(topic.id);
      await store.saveGraph(topic.id, tidied.revision, { kind: 'edit', id: 'j3', title: '人改过' });
      const receipt = async () =>
        (await store.getOperations(topic.id)).operations.find(item => item.id === task.id);
      assert.equal((await receipt()).canRollback, false, '后面还有未撤回的手改');
      // The panel undoes its hand edit by saving the ledger it had before.
      const edited = await store.getTopic(topic.id);
      await store.saveState(topic.id, edited.revision, {
        ledger: tidied.ledger,
        raw: '',
        nodes: [],
        edges: [],
        watermarks: {},
      });
      assert.equal((await receipt()).canRollback, true);
      const current = await store.getTopic(topic.id);
      await store.rollbackOperation(topic.id, current.revision, task.id);
      const view = await store.getView(topic.id);
      assert.equal(view.graph.nodes.find(n => n.id === 'j2').title, '先约定职责');
      assert.equal(view.graph.nodes.find(n => n.id === 'j3').title, '内部组织也有代价');
    },
  ));

test('面板手动输入记为手工材料并记下产出节点；Agent 提交的仍按原标签只进 Log', () =>
  isolated(
    async () => '<noop/>',
    async ({ topic, post, finished }) => {
      const manual = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'update',
        input: '手工输入的材料',
        origin: 'manual',
      });
      await finished(manual.id);
      const agent = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'update',
        input: 'Agent 提交的材料内容',
      });
      await finished(agent.id);
      const { sourceText } = await store.history(topic.id);
      assert.match(sourceText, /## 手工材料 · user[\s\S]*手工输入的材料/);
      assert.match(sourceText, /## Agent 提交的材料 · user[\s\S]*Agent 提交的材料内容/);
      const events = await store.sourceEvents(topic.id);
      assert.deepEqual(
        events.map(event => event.sourceMeta.sessionId),
        ['manual'],
      );
      await assert.rejects(
        post(`/api/topics/${topic.id}/tasks`, { action: 'tidy', origin: 'manual' }),
        /任务来源无效/,
      );
    },
  ));

test('关系说明只写这条线的说明', () =>
  isolated(
    async () => '<edge from="j2" to="j3" reason="约定之外的协调成本"/>',
    async ({ topic, post, finished }) => {
      const task = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'relation',
        params: { from: 'j2', to: 'j3' },
      });
      const done = await finished(task.id);
      assert.equal(done.status, 'completed', done.error);
      const edge = (await store.getView(topic.id)).graph.edges.find(
        e => e.from === 'j2' && e.to === 'j3',
      );
      assert.equal(edge.reason, '约定之外的协调成本');
    },
  ));

// Model iteration policies belong here; panel tests retain visible results and undo coverage.
test('补一次收拢时第一轮不落盘，最终结果只提交一次', async () => {
  let calls = 0;
  const seed =
    '[场次 2026-01-01T00:00:00Z · 合成测试]\n走向 p1 [主题]\n仅保留合成判断。\n' +
    Array.from(
      { length: 12 },
      (_, i) => `◇ j${i + 1} [验证] 合成判断${i + 1}\n独立依据${i + 1}`,
    ).join('\n');
  await isolated(
    async task => {
      calls++;
      assert.equal(
        (await store.getTopic(task.topicId)).revision,
        task.baseRevision,
        '中间轮不可改变落盘版本',
      );
      const refs = [...task.user.matchAll(/^(n\d+) \[/gm)].map(match => match[1]).join(',');
      // 第一轮只改正文、没合并：补一次收拢请求。
      if (calls === 1)
        return `<prose domain="验证" refs="${refs}">先核对独立依据，其余判断继续分别验证。</prose>`;
      return `<merge title="相邻判断合并${calls}" body="保留两条依据。" members="n1,n2"/><prose domain="验证" refs="${refs}">先核对独立依据，本轮合并相邻判断，其余判断继续分别验证。</prose>`;
    },
    async ({ topic, post, finished }) => {
      const before = await store.getTopic(topic.id);
      const task = await post(`/api/topics/${topic.id}/tasks`, { action: 'tidy', params: {} });
      const done = await finished(task.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(calls, 2, '没合并才补一次，且只补一次');
      assert.equal(done.round, calls, '页面能看到整理进行到第几轮');
      const saved = await store.getTopic(topic.id);
      assert.equal(saved.revision, before.revision + 1);
      assert.equal(saved.raw, before.raw);
      assert.ok((await store.getView(topic.id)).graph.nodes.length < 12);
    },
    seed,
  );
});

test('条数已在目标内且无需修改时只调用一次，不产生保存记录', async () => {
  let calls = 0;
  await isolated(
    async () => {
      calls++;
      return '<noop/>';
    },
    async ({ topic, post, finished }) => {
      const before = await store.getView(topic.id);
      const task = await post(`/api/topics/${topic.id}/tasks`, { action: 'tidy', params: {} });
      const done = await finished(task.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(calls, 1);
      const after = await store.getView(topic.id);
      assert.deepEqual(after.graph, before.graph);
      assert.equal(after.doc, before.doc);
      assert.equal(after.revision, before.revision);
    },
  );
});

test('高于目标却无可合并时，只追加一次收拢请求即停止，不删除独立判断凑数', async () => {
  const requests = [];
  const seed =
    '[场次 2026-01-01T00:00:00Z · 合成测试]\n走向 p1 [主题]\n仅保留合成判断。\n' +
    Array.from(
      { length: 9 },
      (_, i) => `◇ j${i + 1} [验证] 独立判断${i + 1}\n各自依据${i + 1}`,
    ).join('\n');
  await isolated(
    async task => {
      requests.push(task.user);
      return '<noop/>';
    },
    async ({ topic, post, finished }) => {
      const before = await store.getView(topic.id);
      const task = await post(`/api/topics/${topic.id}/tasks`, { action: 'tidy', params: {} });
      const done = await finished(task.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(requests.length, 2, '收拢检查只追加一次，不能无限重试');
      assert.match(requests[1], /上一轮尚未完成收拢/);
      const after = await store.getView(topic.id);
      assert.equal(after.graph.nodes.length, 9);
      assert.equal(after.revision, before.revision);
    },
    seed,
  );
});

test('七条以内人看得过来：独立判断不为压缩条数追加调用', async () => {
  const requests = [];
  const seed =
    '[场次 2026-01-01T00:00:00Z · 合成测试]\n走向 p1 [主题]\n仅保留合成判断。\n' +
    Array.from(
      { length: 7 },
      (_, i) => `◇ j${i + 1} [验证] 独立判断${i + 1}\n各自依据${i + 1}`,
    ).join('\n');
  await isolated(
    async task => {
      requests.push(task.user);
      return '<noop/>';
    },
    async ({ topic, post, finished }) => {
      const before = await store.getView(topic.id);
      const task = await post(`/api/topics/${topic.id}/tasks`, { action: 'tidy', params: {} });
      const done = await finished(task.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(requests.length, 1);
      const after = await store.getView(topic.id);
      assert.equal(after.graph.nodes.length, 7);
      assert.equal(after.revision, before.revision);
    },
    seed,
  );
});

test('关系说明过长只补充重试一次，保存完整短句而不截断', async () => {
  let calls = 0;
  const expected = 'Compare internal vs market cost.';
  await isolated(
    async request => {
      calls++;
      const input = JSON.parse(request.user);
      return `<edge from="${input.from.id}" to="${input.to.id}" reason="${calls === 1 ? 'x'.repeat(33) : expected}"/>`;
    },
    async ({ topic, post, finished }) => {
      const task = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'relation',
        params: { from: 'j2', to: 'j3' },
      });
      const done = await finished(task.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(calls, 2);
      assert.equal(
        (await store.getView(topic.id)).graph.edges.find(e => e.from === 'j2' && e.to === 'j3')
          .reason,
        expected,
      );
    },
  );
});
