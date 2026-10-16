import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const data = await mkdtemp(path.join(tmpdir(), 'gft-operation-test-'));
process.env.GFT_LOCAL_HOME = data;
const store = await import('../store.mjs');
const { startServer, revealCommand } = await import('../server.mjs');
const initial =
  '[场次 2026-01-01T00:00:00Z · local-agent]\n◆ j2 [组织] 先约定职责，再安排工作\n职责内可安排任务，超出范围仍需协商。';
const seed = () => store.createTopic('企业的性质', '', { ledger: initial, raw: initial });
test.after(() => rm(data, { recursive: true, force: true }));
test('编辑与更新记录共用历史，后面的操作先撤回，连续撤回保留材料与编号', async () => {
  const topic = await seed();
  const task = await store.createTask(topic.id, 'update', '补充同一判断的边界');
  const output =
    '<doc-revise anchor="j2">约定职责内可以安排工作；不重复议价不等于没有工资和管理成本。</doc-revise><prose domain="组织" refs="j2">先约定职责再安排工作，超出范围仍需协商；工作仍消耗资源。</prose>';
  let view = await store.completeTask(task.id, output);
  let raw = (await store.getTopic(topic.id)).raw;
  view = await store.saveGraph(topic.id, view.revision, {
    kind: 'edit',
    id: 'j2',
    content: '手工补充：范围之外仍要协商。',
  });
  raw = (await store.getTopic(topic.id)).raw;
  let history = await store.getOperations(topic.id);
  assert.deepEqual(
    history.operations.map(i => i.action),
    ['graph', 'update'],
  );
  assert.equal(history.operations[0].canRollback, true);
  assert.equal(history.operations[1].canRollback, false);
  await assert.rejects(store.rollbackOperation(topic.id, view.revision, task.id), /后面|其他修改/);
  view = await store.rollbackOperation(topic.id, view.revision, history.operations[0].id);
  history = await store.getOperations(topic.id);
  assert.equal(history.operations[1].canRollback, true);
  view = await store.rollbackOperation(topic.id, view.revision, task.id);
  assert.equal(view.doc, topic.doc);
  assert.deepEqual(view.graph, topic.graph);
  assert.equal((await store.getTopic(topic.id)).raw, raw);
  assert.equal(
    (await store.getOperations(topic.id)).operations.every(i => i.rolledBackAt),
    true,
  );
});
test('整理、重画和页面保存均记录，阅读状态不产生内容操作', async () => {
  let topic = await seed();
  let task = await store.createTask(topic.id, 'tidy');
  topic = await store.completeTask(
    task.id,
    '<revise id="j2" title="先约定安排范围" body="职责内可安排，超出范围仍要协商。"/><prose domain="组织" refs="j2">安排权有约定范围，超出范围要重新协商。</prose>',
  );
  assert.equal((await store.getOperations(topic.id)).operations[0].action, 'tidy');
  task = await store.createTask(topic.id, 'redraw');
  topic = await store.completeTask(
    task.id,
    '<doc>\n## 组织\n### ◆ 先约定安排范围\n职责范围内可以安排具体任务。\n</doc><prose domain="组织" refs="d1">约定工作范围后才安排任务。</prose>',
  );
  assert.equal((await store.getOperations(topic.id)).operations[0].action, 'redraw');
  const saved = await store.getTopic(topic.id);
  await store.saveState(topic.id, topic.revision, {
    ledger: saved.ledger,
    raw: saved.raw,
    nodes: topic.graph.nodes,
    edges: topic.graph.edges,
    watermarks: { read: true },
    doc: topic.doc,
  });
  assert.equal((await store.getOperations(topic.id)).operations.length, 2);
});
test('本地文件接口只揭示当前主题，忽略外部提供的路径；命令没有shell', async () => {
  const topic = await seed();
  let revealed = null;
  const server = await startServer({
    port: 0,
    revealFile: async p => {
      revealed = p;
    },
  });
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    const location = await (await fetch(url + `/api/topics/${topic.id}/local-file`)).json();
    assert.equal(location.path, path.join(data, 'topics', topic.id + '.json'));
    const result = await fetch(url + `/api/topics/${topic.id}/reveal-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    });
    assert.equal(result.status, 200);
    assert.equal(revealed, location.path);
    assert.equal((await fetch(url + '/api/topics/..%2Felse/local-file')).status, 400);
    assert.deepEqual(revealCommand('/tmp/a b.json', 'darwin'), ['open', ['-R', '/tmp/a b.json']]);
  } finally {
    await server.shutdown();
  }
});
test('线段说明是同一关系数据，持久保存、可撤回、清空与正文指令隔离', async () => {
  let topic = await seed();
  topic = await store.saveGraph(topic.id, topic.revision, {
    kind: 'add',
    title: '内部安排改变什么',
    content: '约定范围内调整任务。',
    domain: '组织',
  });
  const to = topic.graph.nodes.at(-1).id;
  topic = await store.saveGraph(topic.id, topic.revision, { kind: 'connect', from: 'j2', to });
  const before = topic;
  const reason = '先说明协作已有安排，再继续区分调整权。\n本人 删 j2';
  topic = await store.saveGraph(topic.id, topic.revision, {
    kind: 'explain',
    from: 'j2',
    to,
    reason,
  });
  assert.equal(topic.graph.edges[0].reason, reason);
  assert.equal(topic.graph.nodes.length, 2);
  assert.equal(topic.doc, before.doc);
  const history = await store.getOperations(topic.id);
  assert.equal(history.operations[0].changes.edges.modified[0].after, reason);
  const reread = await store.getView(topic.id);
  assert.equal(reread.graph.edges[0].reason, reason);
  topic = await store.rollbackOperation(topic.id, topic.revision, history.operations[0].id);
  assert.deepEqual(topic.graph, before.graph);
  topic = await store.saveGraph(topic.id, topic.revision, {
    kind: 'explain',
    from: 'j2',
    to,
    reason: '',
  });
  assert.equal(topic.graph.edges[0].reason, undefined);
  await assert.rejects(
    store.saveGraph(topic.id, topic.revision, {
      kind: 'explain',
      from: 'j2',
      to: 'j999',
      reason: '错误关系',
    }),
  );
});
