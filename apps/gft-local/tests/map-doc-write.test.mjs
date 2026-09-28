import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundled = await build({
  stdin: {
    contents: `export * from './apps/gft-local/core.ts';
export { parseLedger, appendLines, liveProse } from './src/service/ledger/index.ts';
export { tidyOpsToLines } from './src/service/ledger/bridge.ts';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'warning',
});
const core = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const ledger = `[场次 2026-09-01T10:00:00Z · local:test]
走向 p1 [主题]
验证路径与投入条件。
◆ j2 [验证] 先限制范围
只有一周，先限制验证范围。
◆ j3 [验证] 先做核心小样
核心小样用于尽早确认失败条件。
◇ j4 [后续] 验证后再投入
是否继续投入仍取决于验证结果。
◆ j5 [旧章] 保留原有边界
这是没有共同正文的历史判断，原说明不能丢失。
走向 p6 [验证]
> ^j2
> ^j3

只有一周，先用小样确认失败条件。
走向 p7 [后续]
> ^j4

根据验证结果再决定投入。`;

function topic(existing = true) {
  return Object.freeze({
    id: 'synthetic-map-doc-write',
    name: '合成验证样本',
    scope: '验证路径与投入条件。',
    ledger: existing ? ledger : '[场次 2026-09-01T10:00:00Z · local:test]\n走向 p1 [主题]\n验证路径与投入条件。',
    raw: existing ? ledger : '',
    revision: 7,
    updatedAt: '2026-09-01T10:00:00Z',
  });
}

function rejectUnchanged(original, action, output, pattern = /正文|引用/) {
  const before = structuredClone(original);
  assert.throws(() => core.applyTask(original, action, output), pattern);
  assert.deepEqual(original, before);
}

function applyUnchanged(original, action, output) {
  const before = structuredClone(original);
  const result = core.applyTask(original, action, output);
  assert.deepEqual(original, before);
  assert.equal(result.raw, original.raw, '模型结果不能代替已接收的原始来源');
  return { ...original, ...result };
}

const newJudgment = body => `<doc>
## 验证
### ？ 样本是否足够？
${body}
</doc>`;
const validationProse = refs => `<prose domain="验证" refs="${refs}">时间只有一周，先做小样暴露失败条件，再确认样本能否支持下一步判断。</prose>`;

test('首次生成和重画缺少章节正文时拒绝整次写入，有完整正文才接受', () => {
  const empty = topic(false);
  const doc = newJudgment('目前还没有确定样本数量。');
  rejectUnchanged(empty, 'update', doc);
  rejectUnchanged(topic(), 'redraw', doc);
  const next = applyUnchanged(empty, 'update', doc + validationProse('d1'));
  const view = core.viewTopic(next);
  assert.equal(view.graph.nodes.length, 1);
  assert.match(view.doc, /> ？ 样本是否足够？/);
  assert.match(view.doc, /先做小样暴露失败条件/);
  assert.doesNotMatch(view.doc, /### ？ 样本是否足够/);
});

test('增量正文必须覆盖已有同章判断，未知引用和跨章引用不能悄悄丢掉', () => {
  const original = topic();
  const doc = newJudgment('目前还没有确定样本数量。');
  for (const refs of ['d1', 'j2,d1', 'j2,j3,d1,d99', 'j2,j3,d1,j999', 'j2,j3,d1,j4']) {
    rejectUnchanged(original, 'update', doc + validationProse(refs));
  }
  rejectUnchanged(original, 'update', doc + validationProse('j2,j3,d1') + validationProse('j2,j3,d1'));
  const next = applyUnchanged(original, 'update', doc + validationProse('j2,j3,d1'));
  const before = core.viewTopic(original), after = core.viewTopic(next);
  assert.equal(after.graph.nodes.length, before.graph.nodes.length + 1);
  const beforeState = core.parseLedger(original.ledger), afterState = core.parseLedger(next.ledger);
  for (const old of before.graph.nodes) assert.deepEqual(afterState.judgments.get(old.id), beforeState.judgments.get(old.id));
  assert.deepEqual(after.graph.nodes.filter(node => beforeState.judgments.has(node.id)).map(node => node.id), before.graph.nodes.map(node => node.id));
  assert.equal(after.graph.nodes.find(node => node.title === '样本是否足够？').content, '目前还没有确定样本数量。');
});

test('只改判断档位时也要同步受影响章节正文，不要求重写无关旧章', () => {
  const original = topic();
  const mark = '<doc-mark anchor="j2" to="◇">验证范围仍待确认。</doc-mark>';
  rejectUnchanged(original, 'update', mark);
  const next = applyUnchanged(original, 'update', mark + validationProse('j2,j3'));
  const before = core.parseLedger(original.ledger), after = core.parseLedger(next.ledger);
  assert.equal(after.judgments.get('j2').mark, '◇');
  assert.deepEqual(after.judgments.get('j5'), before.judgments.get('j5'));
});

test('已有判断章节只增加自由段落时仍需完整共同正文，无节点背景章可以独立保留', () => {
  const original = topic();
  const paragraph = '<doc>\n## 验证\n本轮还发现需要记录参与者拒绝的原因。\n</doc>';
  rejectUnchanged(original, 'update', paragraph);
  rejectUnchanged(original, 'update', paragraph + validationProse('j2'));
  const next = applyUnchanged(original, 'update', paragraph + '<prose domain="验证" refs="j2,j3">时间只有一周，先做核心小样暴露失败条件，并记录参与者拒绝的原因。</prose>');
  const view = core.viewTopic(next);
  assert.equal(view.graph.nodes.length, core.viewTopic(original).graph.nodes.length);
  assert.match(view.doc, /并记录参与者拒绝的原因/);
  assert.doesNotMatch(view.doc, /本轮还发现需要记录参与者拒绝的原因/);
  const background = applyUnchanged(original, 'update', '<doc>\n## 背景\n这次讨论发生在样本尚未收集的阶段，此处只补充背景，不新增判断。\n</doc>');
  const backgroundView = core.viewTopic(background);
  assert.equal(backgroundView.graph.nodes.length, core.viewTopic(original).graph.nodes.length);
  assert.match(backgroundView.doc, /## 背景\n\n这次讨论发生在样本尚未收集的阶段/);
  assert.equal(backgroundView.graph.nodes.some(node => node.domain === '背景'), false);
});

test('整理 revise 必须同步完整同章正文，未触及的旧章无需补写', () => {
  const original = topic();
  const revise = '<revise id="n1" body="先限制范围，是因为验证只有一周。"/>';
  rejectUnchanged(original, 'tidy', revise);
  rejectUnchanged(original, 'tidy', revise + validationProse('n1'));
  const next = applyUnchanged(original, 'tidy', revise + validationProse('n1,n2'));
  const before = core.viewTopic(original), after = core.viewTopic(next);
  assert.equal(after.graph.nodes.find(node => node.id === 'j2').content, '先限制范围，是因为验证只有一周。');
  const beforeState = core.parseLedger(original.ledger), afterState = core.parseLedger(next.ledger);
  for (const id of ['j3', 'j4', 'j5']) assert.deepEqual(afterState.judgments.get(id), beforeState.judgments.get(id));
  assert.deepEqual(after.graph.nodes.map(node => node.id), before.graph.nodes.map(node => node.id));
  assert.match(after.doc, /### ◆ 保留原有边界 \^j5\n这是没有共同正文的历史判断，原说明不能丢失。/);
  assert.equal(core.liveProse(core.parseLedger(next.ledger)).find(block => block.id === 'p7').lines.join('\n'), core.liveProse(core.parseLedger(original.ledger)).find(block => block.id === 'p7').lines.join('\n'));
});

test('中等篇幅是生成规则，必要的长节点说明和人工长说明仍完整保存', () => {
  const body = '这里保留一项不同的适用条件、例外以及尚未解决的疑问。'.repeat(30);
  const fresh = applyUnchanged(topic(false), 'update', newJudgment(body) + validationProse('d1'));
  assert.equal(core.viewTopic(fresh).graph.nodes[0].content, body);
  const original = topic();
  const tidy = applyUnchanged(original, 'tidy', `<revise id="n1" body="${body}"/>` + validationProse('n1,n2'));
  assert.equal(core.viewTopic(tidy).graph.nodes.find(node => node.id === 'j2').content, body);
  const human = core.editGraph(original, { kind: 'edit', id: 'j2', content: body });
  assert.equal(core.viewTopic({ ...original, ...human }).graph.nodes.find(node => node.id === 'j2').content, body);
  assert.equal(original.ledger, ledger);
});

test('整理迁移判断必须同步源章与目标章，迁移不改变其他判断内容', () => {
  const original = topic();
  const move = '<revise id="n1" domain="后续"/>';
  const target = '<prose domain="后续" refs="n1,n3">投入前先明确验证范围，是否继续仍取决于验证结果。</prose>';
  const source = '<prose domain="验证" refs="n2">核心小样仍用于暴露失败条件。</prose>';
  rejectUnchanged(original, 'tidy', move + target);
  rejectUnchanged(original, 'tidy', move + source);
  rejectUnchanged(original, 'tidy', move + source + target.replace('n1,n3', 'n2,n3'));
  const next = applyUnchanged(original, 'tidy', move + source + target);
  const before = core.viewTopic(original), after = core.viewTopic(next);
  assert.equal(after.graph.nodes.find(node => node.id === 'j2').domain, '后续');
  for (const node of before.graph.nodes) assert.equal(after.graph.nodes.find(item => item.id === node.id).content, node.content);
  assert.match(after.doc, /核心小样仍用于暴露失败条件/);
  assert.match(after.doc, /投入前先明确验证范围/);
});

test('合并后 refs 转到新判断，整章迁空时收掉旧正文', () => {
  const original = topic();
  const merge = '<merge title="先做有限验证" body="时间有限，先用核心小样验证。" members="n1,n2" domain="后续"/>';
  rejectUnchanged(original, 'tidy', merge);
  const next = applyUnchanged(original, 'tidy', merge + '<prose domain="后续" refs="n1,n2,n3">时间有限，先用核心小样检验，再决定投入。</prose>');
  const view = core.viewTopic(next);
  assert.equal(view.graph.nodes.length, 3);
  assert.equal(view.graph.nodes.filter(node => node.domain === '验证').length, 0);
  assert.equal(view.graph.nodes.find(node => node.title === '先做有限验证').domain, '后续');
  assert.doesNotMatch(view.doc, /## 验证/);
  assert.match(view.doc, /先用核心小样检验/);
});

test('删除后正文只引用存活判断，缺正文或继续引用已删判断都拒绝', () => {
  const original = topic();
  const drop = '<drop id="n2"/>';
  rejectUnchanged(original, 'tidy', drop);
  rejectUnchanged(original, 'tidy', drop + validationProse('n1,n2'));
  const next = applyUnchanged(original, 'tidy', drop + '<prose domain="验证" refs="n1">时间只有一周，验证范围仍须限制。</prose>');
  assert.equal(core.viewTopic(next).graph.nodes.some(node => node.id === 'j3'), false);
  assert.match(core.viewTopic(next).doc, /验证范围仍须限制/);
});

test('严格局部 bridge 不扩大选区，失败不修改账状态，成功保留无关章节', () => {
  const state = core.parseLedger(ledger), before = structuredClone(state);
  const scope = new Set(['j2', 'j3']);
  const revision = { kind: 'revise', id: 'j2', body: '只有一周，因此限制范围。' };
  const chapter = { kind: 'prose', domain: '验证', refs: ['j2', 'j3'], text: '只有一周，先通过核心小样确认失败条件。' };
  const strict = { requireChapterDoc: true };
  for (const ops of [
    [revision],
    [revision, { ...chapter, refs: ['j2'] }],
    [revision, chapter, { kind: 'prose', domain: '后续', refs: ['j4'], text: '不应修改的无关章节。' }],
  ]) {
    assert.throws(() => core.tidyOpsToLines(state, ops, undefined, scope, strict), /正文|章节/);
    assert.deepEqual(state, before);
  }
  const result = core.tidyOpsToLines(state, [revision, chapter], undefined, scope, strict);
  assert.deepEqual(state, before);
  const next = core.parseLedger(core.appendLines(ledger, result.lines));
  assert.equal(next.judgments.get('j2').content, revision.body);
  assert.deepEqual(next.judgments.get('j4'), state.judgments.get('j4'));
  assert.deepEqual(next.judgments.get('j5'), state.judgments.get('j5'));
  assert.deepEqual(next.prose.find(block => block.id === 'p7'), state.prose.find(block => block.id === 'p7'));
});
