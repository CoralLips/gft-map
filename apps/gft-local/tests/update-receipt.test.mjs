import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as store from '../store.mjs';
import { createConnections } from '../connections.mjs';
import { startServer } from '../server.mjs';

const sandbox = await mkdtemp(path.join(tmpdir(), 'gft-update-receipt-'));
const previousHome = process.env.GFT_LOCAL_HOME;
process.env.GFT_LOCAL_HOME = sandbox;
after(async () => {
  if (previousHome === undefined) delete process.env.GFT_LOCAL_HOME;
  else process.env.GFT_LOCAL_HOME = previousHome;
  assert.ok(path.basename(sandbox).startsWith('gft-update-receipt-'));
  await rm(sandbox, { recursive: true, force: true });
});
const initialLedger = `[场次 2026-10-01T00:00:00Z · local-agent · 测试基线]
走向 p1 [主题]
企业为什么存在，以及企业的边界。
◆ j2 [组织] 先约定职责，再安排具体工作
剪辑师加入团队后，在约定职责内调整任务，无须每次重谈价格。`;
const output = `<doc>
## 组织
### ◇ 内部组织也有代价
团队扩大可能增加排期冲突、等待和返工。
</doc>
<doc-mark anchor="j2" to="◇">安排权的范围需要先约定。</doc-mark>
<edge from="^j2" to="d1"/>
<prose domain="组织" refs="j2,d1">先约定职责可以减少反复订约；但范围仍需协商。团队扩大也可能增加排期冲突、等待和返工。</prose>`;
const seed = () =>
  store.createTopic('企业的性质 · 回归副本', '', { ledger: initialLedger, raw: '' });
async function update(topic) {
  const task = await store.createTask(
    topic.id,
    'update',
    '企业内安排任务有边界，团队扩大也有协调代价。',
  );
  return { task, view: await store.completeTask(task.id, output) };
}

test('回执从实际提交前后生成，持久化并覆盖节点、连线与章节变化', async () => {
  const before = await seed();
  assert.equal((await store.getUpdateReceipt(before.id)).receipt, null);
  const { task, view } = await update(before);
  const { receipt, currentRevision } = await store.getUpdateReceipt(before.id);
  assert.equal(currentRevision, view.revision);
  assert.equal(receipt.id, task.id);
  assert.equal(receipt.canRollback, true);
  assert.equal(receipt.baseRevision, before.revision);
  assert.equal(receipt.resultRevision, view.revision);
  assert.equal(receipt.changes.nodes.filter(node => node.kind === 'added').length, 1);
  assert.equal(receipt.changes.nodes.filter(node => node.kind === 'modified').length, 1);
  assert.equal(receipt.changes.nodes.find(node => node.id === 'j2').before.mark, '◆');
  assert.equal(receipt.changes.nodes.find(node => node.id === 'j2').after.mark, '◇');
  assert.equal(receipt.changes.edges.added.length, 1);
  assert.equal(receipt.changes.chapters.length, 1);
  assert.equal(receipt.changes.chapters[0].domain, '组织');
  assert.equal(receipt.changes.doc, null); // the changed chapter already shows the difference
  assert.equal('before' in receipt, false); // private ledger snapshots are not sent to the panel
  const saved = JSON.parse(
    await readFile(path.join(sandbox, 'topics', `${before.id}.json`), 'utf8'),
  );
  assert.equal(saved.latestUpdateReceipt.id, task.id);
  // The ledger only grew, so the receipt marks its prefixes instead of copying them.
  assert.equal('ledger' in saved.latestUpdateReceipt.before, false);
  assert.equal(saved.latestUpdateReceipt.before.ledgerLength, initialLedger.length);
  assert.equal(saved.latestUpdateReceipt.after.ledgerLength, saved.ledger.length);
  assert.equal(saved.operationHistory.at(-1).before.ledgerLength, initialLedger.length);
  assert.equal(saved.appliedTasks[task.id], view.revision);
});

test('退回更新保留 Log 原文、退回读取进度，再次更新重读那批消息，后续节点不复用撤回编号', async () => {
  const before = await seed();
  const messages = [
    {
      id: 'm1',
      role: 'user',
      content: '企业内安排任务有边界，团队扩大也有协调代价。',
      timestamp: '2026-10-01T00:00:00Z',
    },
  ];
  const source = { provider: 'codex', id: `source-${before.id}`, title: '企业讨论', cwd: sandbox };
  const api = createConnections({
    readers: {
      getChatSession: async () => source,
      getChatHead: async () => ({ offset: messages.length }),
      readChatDelta: async (_source, cursor) => ({
        messages: messages.slice(cursor?.offset || 0),
        cursor: { offset: messages.length },
        hasMore: false,
      }),
    },
  });
  const [binding] = await api.connectSource({ source, topicIds: [before.id], history: 'all' });
  const page = await api.createSourceUpdate(before.id, { connectionId: binding.id });
  const published = await store.completeTask(page.task.id, output);
  const saved = await store.getTopic(before.id);
  const restored = await store.rollbackUpdate(before.id, published.revision, page.task.id);
  const after = await store.getTopic(before.id);
  assert.equal(restored.doc, before.doc);
  assert.deepEqual(restored.graph, before.graph);
  for (const key of ['raw', 'sourceImports', 'materialCheckpoints', 'appliedTasks'])
    assert.deepEqual(after[key], saved[key], key);
  assert.deepEqual(after.sourceCursors, {}, '读取进度退回到更新之前');
  assert.equal(after.sourceUpdates[page.task.id], undefined, '撤回的更新不再作为节点出处');
  assert.equal((await store.getUpdateReceipt(before.id)).receipt.canRollback, false);
  assert.match(after.ledger, /退回更新/);
  const again = await api.createSourceUpdate(before.id, { connectionId: binding.id });
  assert.deepEqual(
    (await store.getTask(again.task.id)).source.messages.map(item => item.id),
    ['m1'],
  );
  await store.setTaskStatus(again.task.id, 'cancelled');
  const removed = published.graph.nodes.find(node => node.id !== 'j2').id;
  const next = await store.saveGraph(before.id, restored.revision, {
    kind: 'add',
    title: '核查其他成本',
    domain: '组织',
  });
  assert.ok(
    Number(next.graph.nodes.find(node => node.id !== 'j2').id.slice(1)) > Number(removed.slice(1)),
  );
});

test('只保存阅读状态后仍能退回；请求版本和真实后续编辑都受到保护', async () => {
  const before = await seed(),
    { task, view } = await update(before);
  const saved = await store.getTopic(before.id);
  const map = {
    ledger: saved.ledger,
    raw: saved.raw,
    nodes: view.graph.nodes.map(node => ({ ...node, unread: false })),
    edges: view.graph.edges,
    doc: view.doc,
    watermarks: { reader: 'kept' },
  };
  const read = await store.saveState(before.id, view.revision, map);
  assert.equal((await store.getUpdateReceipt(before.id)).receipt.canRollback, true);
  await assert.rejects(store.rollbackUpdate(before.id, view.revision, task.id), { status: 409 });
  const result = await store.rollbackUpdate(before.id, read.revision, task.id);
  assert.equal(result.doc, before.doc);
  assert.deepEqual((await store.getTopic(before.id)).panel.watermarks, { reader: 'kept' });
  await assert.rejects(store.rollbackUpdate(before.id, result.revision, task.id), { status: 409 });
  const other = await seed(),
    run = await update(other);
  const edited = await store.saveGraph(other.id, run.view.revision, {
    kind: 'edit',
    id: 'j2',
    title: '保留用户的新修改',
  });
  assert.equal((await store.getUpdateReceipt(other.id)).receipt.canRollback, false);
  await assert.rejects(store.rollbackUpdate(other.id, edited.revision, run.task.id), {
    status: 409,
  });
  assert.equal(
    (await store.getView(other.id)).graph.nodes.find(node => node.id === 'j2').title,
    '保留用户的新修改',
  );
});

test('连续更新与退回保留编号上界，旧回执不能退回新的更新', async () => {
  const before = await seed();
  let previousNumber = 2,
    current = before;
  for (let round = 0; round < 3; round++) {
    const { task, view } = await update(current);
    const added = view.graph.nodes.find(node => node.id !== 'j2');
    assert.ok(Number(added.id.slice(1)) > previousNumber);
    previousNumber = Number(added.id.slice(1));
    if (round)
      await assert.rejects(store.rollbackUpdate(before.id, view.revision, 'prior-update'), {
        status: 409,
      });
    current = await store.rollbackUpdate(before.id, view.revision, task.id);
    assert.equal(current.doc, before.doc);
    assert.deepEqual(current.graph, before.graph);
  }
});

test('无改动更新没有虚构差异，也不提供无效退回', async () => {
  const before = await seed(),
    task = await store.createTask(before.id, 'update', '本轮无新内容');
  const view = await store.completeTask(task.id, '<noop/>');
  const { receipt } = await store.getUpdateReceipt(before.id);
  assert.equal(receipt.id, task.id);
  assert.deepEqual(receipt.changes.nodes, []);
  assert.equal(receipt.changes.doc, null);
  assert.equal(receipt.canRollback, false);
  await assert.rejects(store.rollbackUpdate(before.id, view.revision, task.id), { status: 409 });
});

test('失败或取消不会冒充新变化，仍可检查最后一次已经提交的更新', async () => {
  const before = await seed(),
    { view } = await update(before);
  const receipt = await store.getUpdateReceipt(before.id);
  const failed = await store.createTask(before.id, 'update', '无效的输出不应覆盖前次回执');
  await assert.rejects(store.completeTask(failed.id, '这不是可执行图文'));
  await store.setTaskStatus(failed.id, 'running');
  await store.setTaskStatus(failed.id, 'failed', '测试失败');
  assert.deepEqual(await store.getUpdateReceipt(before.id), receipt);
  const cancelled = await store.createTask(before.id, 'update', '取消的更新');
  await store.setTaskStatus(cancelled.id, 'cancelled');
  assert.deepEqual(await store.getUpdateReceipt(before.id), receipt);
  assert.equal((await store.getView(before.id)).revision, view.revision);
});

test('提交后任务状态落盘失败的恢复保留同一回执，不重复应用', async () => {
  const before = await seed(),
    { task, view } = await update(before);
  const receipt = await store.getUpdateReceipt(before.id);
  const p = path.join(sandbox, 'tasks', `${task.id}.json`),
    current = JSON.parse(await readFile(p, 'utf8'));
  await writeFile(p, JSON.stringify({ ...current, status: 'pending' }));
  const result = await store.completeTask(task.id, output);
  assert.equal(result.revision, view.revision);
  assert.deepEqual(await store.getUpdateReceipt(before.id), receipt);
});

test('HTTP 回执和退回使用同一主题与请求版本，错误不覆盖内容', async t => {
  const before = await seed(),
    { task, view } = await update(before);
  const server = await startServer({ port: 0, sourceReaders: {} });
  t.after(() => server.shutdown('test'));
  const base = `http://127.0.0.1:${server.address().port}/api/topics/${before.id}`;
  const receipt = await (await fetch(`${base}/update-receipt`)).json();
  assert.equal(receipt.topicId, before.id);
  const request = body =>
    fetch(`${base}/rollback-update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await request({ baseRevision: view.revision, receiptId: 'not-the-latest' })).status,
    409,
  );
  const response = await request({ baseRevision: view.revision, receiptId: task.id });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).doc, before.doc);
  assert.equal((await request({ baseRevision: view.revision, receiptId: task.id })).status, 409);
});
