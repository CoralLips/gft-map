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

async function isolated(execute, run) {
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
  const finished = async id => {
    for (let i = 0; i < 400; i++) {
      const task = await store.getTaskStatus(id);
      if (!['pending', 'running'].includes(task.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('任务未结束');
  };
  try {
    const topic = await store.createTopic('服务端操作', '', { ledger, raw: '' });
    await run({ topic, post, finished });
  } finally {
    await server.shutdown();
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test('节点整理只改该节点标题与说明，结果按节点核对后写入并留回执', () =>
  isolated(
    async request => {
      assert.match(request.system, /完整说明/);
      return '<node title="先约定职责与范围" body="双方先谈好职责、报酬与可调整的范围，具体任务以后再定。"/>';
    },
    async ({ topic, post, finished }) => {
      const task = await post(`/api/topics/${topic.id}/tasks`, {
        action: 'refine',
        params: { nodeId: 'j2' },
      });
      const done = await finished(task.id);
      assert.equal(done.status, 'completed');
      assert.equal(done.changed, true);
      const view = await store.getView(topic.id);
      const node = view.graph.nodes.find(n => n.id === 'j2');
      assert.equal(node.title, '先约定职责与范围');
      assert.match(node.content, /可调整的范围/);
      assert.equal(view.graph.nodes.find(n => n.id === 'j3').title, '内部组织也有代价');
      const { operations } = await store.getOperations(topic.id);
      assert.equal(operations[0].id, task.id);
      assert.equal(operations[0].canRollback, true);
    },
  ));

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
