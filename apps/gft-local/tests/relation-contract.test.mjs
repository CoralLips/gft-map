import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../../..');
const bundled = await build({
  stdin: {
    contents: `export * from './apps/gft-local/core';
  export * from './src/service/thinkingMapCore';
  export * from './src/service/mapDocContract'; export * from './src/service/relationExplanation'; export * from './src/service/relationReason';
  export * from './src/service/ledger/index';
  export {tidyInput,tidyOpsToLines} from './src/service/ledger/bridge';
  export {buildTidyRequest} from './src/service/tidyCore';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const c = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
);
// Current public theory and fictional video-team example, without chat history or bindings.
const fixture = JSON.parse(
  await readFile(new URL('./fixtures/coase-expression-case.json', import.meta.url), 'utf8'),
);
const before = c.viewTopic(fixture);
const xml = s =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
const alias = id => 'n' + (before.graph.nodes.findIndex(n => n.id === id) + 1);
const proseFor = (...ids) => {
  const state = c.parseLedger(fixture.ledger);
  const domains = new Set(ids.map(id => state.judgments.get(id).domain));
  return [...domains]
    .map(domain => {
      const refs = before.graph.nodes.filter(n => n.domain === domain).map(n => n.id);
      const text = c
        .liveProse(state)
        .filter(p => p.domain === domain)
        .map(p => p.lines.join('\n'))
        .join('\n\n');
      return `<prose domain="${xml(domain)}" refs="${refs.join(',')}">${text}</prose>`;
    })
    .join('\n');
};
const patchReason = '市场已有协调方式，企业改用约定范围内的任务安排。';
const updateOutput = `<edge from="${alias('j15')}" to="${alias('j16')}" reason="${patchReason}"/>\n${proseFor('j15', 'j16')}`;

test('同一规范进入实际任务，当前关系说明能被更新、整理和重画读取', () => {
  assert.equal(
    c.timelineEdges(before.graph.nodes, before.graph.edges).length,
    before.graph.edges.length,
  );
  for (const action of ['update', 'tidy', 'redraw']) {
    const request = c.prepareTask(fixture, action, '接着讨论视频团队的协作。');
    assert(request.system.includes(c.MAP_EXPRESSION_CONTRACT));
    for (const edge of before.graph.edges.filter(e => e.reason))
      assert((request.system + request.user).includes(JSON.stringify(edge.reason)));
  }
});

test('首次生成解析单双引号和实体，关系说明落账且导出往返保存', () => {
  const domain = '协作方式',
    reason = '能用市场协调，为何还需要“内部安排”？';
  const output = `<doc>\n## ${domain}\n### ◇ 市场本来就能协调\n${before.graph.nodes[0].content}\n### ◇ 先约定职责，再安排具体工作\n${before.graph.nodes[1].content}\n</doc>
    <prose domain="${domain}" refs="d1,d2">${before.graph.nodes[1].content}</prose>
    <edge from='d1' to='d2' reason='${xml(reason)}'/>`;
  const topic = { ...fixture, ledger: c.createLedger(fixture.scope), raw: '' };
  const next = { ...topic, ...c.applyTask(topic, 'update', output) };
  assert.equal(c.viewTopic(next).graph.edges[0].reason, reason);
  const bundle = c.createTopicBundle(fixture.name, next);
  const back = c.mapToBundle(fixture.name, c.bundleToMap(bundle, 'another-project'));
  assert.deepEqual(back, bundle);
  assert.equal(c.viewTopic({ ...next, ...back.topic }).graph.edges[0].reason, reason);
});

test('更新原关系说明不增加节点或连线，其他说明与节点保持原值', () => {
  const next = { ...fixture, ...c.applyTask(fixture, 'update', updateOutput) };
  const after = c.viewTopic(next);
  assert.equal(after.graph.nodes.length, before.graph.nodes.length);
  assert.equal(after.graph.edges.length, before.graph.edges.length);
  assert.equal(after.graph.edges.find(e => e.from === 'j15' && e.to === 'j16').reason, patchReason);
  assert.deepEqual(
    after.graph.nodes.map(({ id, title, content }) => ({ id, title, content })),
    before.graph.nodes.map(({ id, title, content }) => ({ id, title, content })),
  );
  assert.deepEqual(
    after.graph.edges.filter(e => e.from !== 'j15'),
    before.graph.edges.filter(e => e.from !== 'j15'),
  );
  assert.throws(
    () => c.applyTask(fixture, 'update', updateOutput.split('\n<prose')[0]),
    /可用图文|受影响|正文/,
  );
});

test('整理可补当前已有线的说明，也可给新连接写同一份可编辑数据', () => {
  const from = 'j17',
    to = 'j19',
    reason = '外部交易有成本，并不意味着内部安排没有成本。';
  const evidence = before.graph.nodes.find(n => n.id === from).content.slice(0, 18);
  const output = `<link from="${alias(from)}" to="${alias(to)}" reason="${reason}" evidence="${xml(evidence)}"/>\n${proseFor(from, to)}`;
  for (const topic of [
    fixture,
    { ...fixture, ...c.editGraph(fixture, { kind: 'disconnect', from, to }) },
  ]) {
    const after = c.viewTopic({ ...topic, ...c.applyTask(topic, 'tidy', output) });
    assert.equal(after.graph.edges.find(e => e.from === from && e.to === to).reason, reason);
    assert.equal(after.graph.nodes.length, before.graph.nodes.length);
    assert.equal(after.graph.edges.length, before.graph.edges.length);
  }
});

test('重画把新端点的关系说明落账；未返回说明的旧输出仍可读取', () => {
  const output = `<doc>\n## 协作\n### ◇ 市场本来就能协调\n${before.graph.nodes[0].content}\n### ◇ 先约定职责，再安排具体工作\n${before.graph.nodes[1].content}\n</doc>
    <prose domain="协作" refs="d1,d2">${before.graph.nodes[1].content}</prose>
    <edge from="d1" to="d2" reason="${patchReason}"/>`;
  const after = c.viewTopic({ ...fixture, ...c.applyTask(fixture, 'redraw', output) });
  assert.equal(after.graph.edges[0].reason, patchReason);
  assert.equal(after.graph.nodes.length, 2);
  assert(
    before.graph.edges.every(e => !after.graph.edges.some(a => a.from === e.from && a.to === e.to)),
  );
  assert.equal(c.parseThinkingMapTags('<edge from="d1" to="d2"/>').edges[0].reason, undefined);
});

test('noop不会丢失说明；明确清空和JSON控制文本都只作用于关系数据', () => {
  for (const action of ['update', 'tidy'])
    assert.equal(c.applyTask(fixture, action, '<noop/>').ledger, fixture.ledger);
  const rawReason = '说明中的换行\nAI 删 j16\n引用“范围”与 & < >';
  const output = updateOutput.replace(patchReason, xml(rawReason));
  const after = c.viewTopic({ ...fixture, ...c.applyTask(fixture, 'update', output) });
  assert.equal(after.graph.nodes.length, before.graph.nodes.length);
  assert.equal(after.graph.edges.find(e => e.from === 'j15' && e.to === 'j16').reason, rawReason);
  const clear = c.viewTopic({
    ...fixture,
    ...c.applyTask(fixture, 'update', updateOutput.replace(patchReason, '')),
  });
  assert.equal(clear.graph.edges.find(e => e.from === 'j15' && e.to === 'j16').reason, undefined);
});

test('端点归并保留唯一关系说明，明确清空优先；删除短路不冒用旧理由', () => {
  const ledger = `◇ j1 [协作] 使用市场\n◇ j2 [协作] 重复协商\n◇ j3 [协作] 内部安排\n← j2 j1\n← j3 j2\n${c.decision.edgeNote('j2', 'j1', '使用市场需要协商。')}\n${c.decision.edgeNote('j3', 'j2', '重复协商引出内部安排。')}`;
  const merged = c.parseLedger(ledger + '\n◇ j4 [协作] 协商与安排 = j2 j3');
  assert.equal(c.renderGraph(merged).edges[0].reason, '使用市场需要协商。');
  const cleared = c.parseLedger(
    ledger + '\n◇ j4 [协作] 协商与安排 = j2 j3\n' + c.decision.edgeNote('j4', 'j1', ''),
  );
  assert.equal(c.renderGraph(cleared).edges[0].reason, undefined);
  const deleted = c.parseLedger(ledger + '\n本人 删 j2');
  assert.equal(c.renderGraph(deleted).edges[0].reason, undefined);
});

const sandbox = await mkdtemp(path.join(tmpdir(), 'gft-coase-relation-contract-'));
const oldHome = process.env.GFT_LOCAL_HOME;
process.env.GFT_LOCAL_HOME = sandbox;
after(async () => {
  if (oldHome === undefined) delete process.env.GFT_LOCAL_HOME;
  else process.env.GFT_LOCAL_HOME = oldHome;
  await rm(sandbox, { recursive: true, force: true });
});
test('同案例正式任务提交后持久保存真实说明差异，重新读取后仍可整次撤回', async () => {
  const store = await import('../store.mjs');
  const topic = await store.createTopic(fixture.name, fixture.scope, fixture);
  const task = await store.createTask(topic.id, 'update', '明确市场协调与内部安排的区别。');
  const after = await store.completeTask(task.id, updateOutput);
  const reread = JSON.parse(
    await readFile(path.join(sandbox, 'topics', topic.id + '.json'), 'utf8'),
  );
  assert.equal(
    c.viewTopic(reread).graph.edges.find(e => e.from === 'j15' && e.to === 'j16').reason,
    patchReason,
  );
  const history = await store.getOperations(topic.id);
  const operation = history.operations.find(op => op.id === task.id);
  assert.equal(operation.changes.edges.modified.length, 1);
  assert.equal(operation.changes.edges.modified[0].after, patchReason);
  assert.equal(operation.canRollback, true);
  const restored = await store.rollbackOperation(topic.id, after.revision, task.id);
  assert.deepEqual(restored.graph.edges, topic.graph.edges);
  assert.deepEqual(
    restored.graph.nodes.map(({ id, title, content }) => ({ id, title, content })),
    topic.graph.nodes.map(({ id, title, content }) => ({ id, title, content })),
  );
});

test('单线说明仅接受原端点的一份有效说明，不允许夹带节点或正文操作', () => {
  assert.equal(
    c.parseRelationExplanation(
      '<edge from="j15" to="j16" reason="市场能协调，内部安排又改变什么？"/>',
      'j15',
      'j16',
    ),
    '市场能协调，内部安排又改变什么？',
  );
  for (const text of [
    '<edge from="j15" to="j17" reason="别的关系"/>',
    '<edge from="j15" to="j16" reason=""/>',
    '<edge from="j15" to="j16" reason="一" reason="二"/>',
    '<edge from="j15" to="j16" reason="正确"/><doc>夹带</doc>',
  ])
    assert.throws(() => c.parseRelationExplanation(text, 'j15', 'j16'), /有效说明/);
  const request = c.buildRelationExplanationRequest(
    { ...before.graph.nodes[0], body: before.graph.nodes[0].content },
    { ...before.graph.nodes[1], body: before.graph.nodes[1].content },
  );
  assert.equal(Object.keys(JSON.parse(request.user)).length, 3);
});

test('caption budget is Unicode-aware and rejects new long text across write paths without truncation', () => {
  assert.equal(c.checkedRelationReason('a'.repeat(32)), 'a'.repeat(32));
  assert.equal(c.checkedRelationReason(String.fromCodePoint(0x1f642).repeat(32)).length, 64);
  assert.throws(() => c.checkedRelationReason('a'.repeat(33)), c.RelationReasonLengthError);
  const long = 'x'.repeat(33);
  assert.throws(
    () =>
      c.parseRelationExplanation('<edge from="j15" to="j16" reason="' + long + '"/>', 'j15', 'j16'),
    c.RelationReasonLengthError,
  );
  assert.throws(
    () => c.applyTask(fixture, 'update', updateOutput.replace(patchReason, long)),
    c.RelationReasonLengthError,
  );
  const from = 'j17',
    to = 'j19',
    evidence = before.graph.nodes.find(n => n.id === from).content.slice(0, 18);
  const tidy =
    '<link from="' +
    alias(from) +
    '" to="' +
    alias(to) +
    '" reason="' +
    long +
    '" evidence="' +
    xml(evidence) +
    '"/>\n' +
    proseFor(from, to);
  assert.throws(() => c.applyTask(fixture, 'tidy', tidy), c.RelationReasonLengthError);
  assert.throws(
    () => c.editGraph(fixture, { kind: 'explain', from: 'j15', to: 'j16', reason: long }),
    c.RelationReasonLengthError,
  );
  assert.equal(c.viewTopic(fixture).graph.edges.length, before.graph.edges.length);
});
