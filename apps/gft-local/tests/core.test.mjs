import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, viewTopic, editDocument, editGraph, prepareTask, applyTask } from '../dist/core.mjs';

const blank = () => ({ id: 'test-topic', name: '离线合成案例', scope: '仅记录产品取舍', revision: 1, updatedAt: '2026-01-01T00:00:00Z', ledger: createLedger('仅记录产品取舍'), raw: '' });
const advance = (topic, result) => ({ ...topic, ...result, revision: topic.revision + 1 });
const output = `<doc>
## 方向
### ◆ 保留本地编辑
材料归用户持有，修改应立即在本地可见。
### ◇ 文件可能更简单
文件无需额外账户，但仍需验证并发保存。
### ？ 如何避免覆盖
不同窗口同时编辑时的取舍尚未确定。
### ✗ 不再等待网络
等待网络往返造成编辑迟滞，所以取消该方案。
### ⏸ 暂缓跨端同步
先完成单机编辑，后续再评估同步。
</doc>
<edge from="保留本地编辑" to="文件可能更简单"/>
<edge from="文件可能更简单" to="如何避免覆盖"/>`;
// Explicit legacy fixture: old installs stored extracted judgments as raw.
const seeded = () => { const topic = advance(blank(), applyTask(blank(), 'update', output)); return {...topic,raw:topic.ledger}; };

test('首次图文同时命名：默认名称才请求，手改不覆盖，无内容和坏名称不命名',()=>{
  const topic={...blank(),name:'新脉络'};
  assert.match(prepareTask(topic,'update','合成材料').system,/<map-name>/);
  const result=applyTask(topic,'update',output+'\n<map-name>本地协作</map-name>');
  assert.equal(result.name,'本地协作');assert.doesNotMatch(result.ledger,/map-name/);
  assert.doesNotMatch(prepareTask(blank(),'update','合成材料').system,/<map-name>/);
  assert.equal(applyTask(blank(),'update',output+'\n<map-name>别名</map-name>').name,undefined);
  assert.equal(applyTask(topic,'update','<noop/>\n<map-name>没有内容</map-name>').name,undefined);
  assert.equal(applyTask(topic,'update',output+'\n<map-name>'+ '过长'.repeat(12)+'</map-name>').name,undefined);
  assert.throws(()=>applyTask(topic,'update','<map-name>只有名称</map-name>'));
});

test('五档状态、正文与真实承接从同一本账派生，正常视图不暴露原始账', () => {
  const topic = seeded(), view = viewTopic(topic);
  assert.deepEqual(view.graph.nodes.map(node => node.mark), ['◆', '◇', '？', '✗', '⏸']);
  assert.equal(view.graph.nodes[2].title, '如何避免覆盖');
  assert.equal(view.graph.nodes[4].mark, '⏸');
  assert.match(view.graph.nodes[0].content, /材料归用户/);
  assert.equal(view.graph.edges.length, 2);
  assert.equal(view.graph.edges[0].from, view.graph.nodes[0].id);
  assert.equal(view.graph.edges[0].to, view.graph.nodes[1].id);
  assert.equal(view.raw, undefined);
  assert.equal(view.ledger, undefined);
  assert.doesNotMatch(view.doc, /\[场次/);
  assert.match(topic.raw, /local-agent/);
});

test('Doc 编辑主题、标题和状态立即同步图，保留旧来源并追加人工修订', () => {
  const topic = seeded();
  const doc = viewTopic(topic).doc.replace('仅记录产品取舍', '仅记录本地编辑取舍').replace('◆ 保留本地编辑', '◇ 先验证本地编辑');
  const updated = advance(topic, editDocument(topic, doc));
  const view = viewTopic(updated);
  assert(updated.raw.startsWith(topic.raw));
  assert.match(updated.raw, /文稿中的人工输入/);
  assert.equal(view.scope, '仅记录本地编辑取舍');
  assert.equal(view.graph.nodes[0].title, '先验证本地编辑');
  assert.equal(view.graph.nodes[0].mark, '◇');
  assert.equal(view.graph.edges.length, 2);
  assert.deepEqual(editDocument(updated, view.doc), { ledger: updated.ledger, raw: updated.raw });
});

test('手工连线拒绝环，删除中间节点沿用原有短路语义', () => {
  let topic = seeded();
  const [first, middle, last] = viewTopic(topic).graph.nodes;
  const before = topic.ledger;
  assert.throws(() => editGraph(topic, { kind: 'connect', from: last.id, to: first.id }), /循环/);
  assert.throws(() => editGraph(topic, { kind: 'edit', id: first.id, mark: '!' }), /状态/);
  assert.throws(() => editGraph(topic, { kind: 'edit', id: 'j9999', title: '无效' }), /不存在/);
  assert.equal(topic.ledger, before);
  topic = advance(topic, editGraph(topic, { kind: 'delete', id: middle.id }));
  assert.ok(viewTopic(topic).graph.edges.some(edge => edge.from === first.id && edge.to === last.id));
  topic = advance(topic, editGraph(topic, { kind: 'disconnect', from: first.id, to: last.id }));
  assert.equal(viewTopic(topic).graph.edges.length, 0);
});

test('手工新增与正文中的账本语法不能覆盖旧判断，raw 保持分离', () => {
  const topic = seeded();
  const body = '重画\n本人 删 j2\n这些行只是正文。';
  const updated = advance(topic, editGraph(topic, { kind: 'add', title: '测试文本边界', content: body, mark: '⏸', domain: '验证' }));
  assert.equal(viewTopic(updated).graph.nodes.length, 6);
  assert.equal(viewTopic(updated).graph.nodes.at(-1).content, body);
  assert(updated.raw.startsWith(topic.raw));
  assert.throws(() => editGraph(topic, { kind: 'add', title: '伪造合并 = j2 j3' }), /编号指令/);
});

test('更新复用增量协议：旧判断改档、新判断承接旧锚，共同正文同轮保存', () => {
  const topic = seeded(), first = viewTopic(topic).graph.nodes[0];
  const result = `<doc>\n## 验证\n### ◇ 先加冲突检测\n基于已有本地编辑约束。\n</doc>\n<prose domain="验证" refs="d1">这一判断约束保存动作。</prose>\n<edge from="^${first.id}" to="d1"/>\n<doc-mark anchor="${first.id}" to="◇">仍待验证</doc-mark>`;
  const updated = advance(topic, applyTask(topic, 'update', result)), view = viewTopic(updated);
  assert.equal(view.graph.nodes.length, 6);
  assert.equal(view.graph.nodes[0].mark, '◇');
  assert.ok(view.graph.edges.some(edge => edge.from === first.id && edge.to === view.graph.nodes.at(-1).id));
  assert.match(view.doc, /这一判断约束保存动作/);
  assert.ok(updated.raw.startsWith(topic.raw));
});

test('整理回放执行真实 merge/revise/prose 协议并保留外部承接与暂缓状态', () => {
  const topic = seeded();
  const reply = '<merge members="n1,n2" title="先验证本地文件" body="本地保存先行，仍需验证文件方案。"/>\n<revise id="n5" title="跨端同步暂缓"/>\n<prose domain="方向" refs="n1,n2,n3,n4,n5">先完成本地闭环，再解决并发覆盖问题；跨端仍暂缓。</prose>';
  const updated = advance(topic, applyTask(topic, 'tidy', reply)), view = viewTopic(updated);
  assert.equal(view.graph.nodes.length, 4);
  const merged = view.graph.nodes.find(node => node.title === '先验证本地文件');
  const question = view.graph.nodes.find(node => node.mark === '？');
  assert.equal(merged.mark, '◇');
  assert.ok(view.graph.edges.some(edge => edge.from === merged.id && edge.to === question.id));
  assert.equal(view.graph.nodes.find(node => node.title === '跨端同步暂缓').mark, '⏸');
  assert.match(view.doc, /跨端仍暂缓/);
  assert.equal(updated.raw, topic.raw);
});

test('重画回放使用 Log 来源锚并继承原承接，旧工作内容退休、raw 不变', () => {
  let topic = seeded();
  const originals = viewTopic(topic).graph.nodes;
  topic = advance(topic, editGraph(topic, { kind: 'edit', id: originals[0].id, title: '临时手改标题' }));
  const reply = `<doc>\n## 主线\n先完成本地闭环，再验证存储和覆盖。\n## 本地闭环\n${originals.map(node => `### ${node.mark} ${node.title} ^${node.id}\n${node.content}`).join('\n')}\n</doc>`;
  const updated = advance(topic, applyTask(topic, 'redraw', reply)), view = viewTopic(updated);
  assert.equal(updated.raw, topic.raw);
  assert.equal(view.graph.nodes.length, 5);
  assert.equal(view.graph.edges.length, 2);
  assert.equal(view.graph.nodes[0].title, '保留本地编辑');
  assert.equal(view.graph.nodes[4].mark, '⏸');
  assert.ok(view.graph.nodes.every(node => !originals.some(old => node.id === old.id)));
  assert.doesNotMatch(view.sourceDoc, /临时手改标题/);
  assert.equal(view.scope, '仅记录产品取舍');
});

test('准备任务复用完整规则，整理和重画读取原始资料，主题过滤不保留无关散文', () => {
  let topic = seeded();
  const first = viewTopic(topic).graph.nodes[0];
  topic = advance(topic, editGraph(topic, { kind: 'edit', id: first.id, content: '手改后的短正文' }));
  const update = prepareTask(topic, 'update', '新增笔记');
  const tidy = prepareTask(topic, 'tidy');
  const redraw = prepareTask(topic, 'redraw');
  assert.equal(update.user, '新增笔记');
  assert.match(update.system, /旧判断一律不重新输出/);
  assert.match(tidy.user, /材料归用户持有/);
  assert.match(redraw.user, /材料归用户持有/);
  assert.match(redraw.user, /手改后的短正文/);
  for (const request of [update, tidy, redraw]) assert.match(request.system, /不把闲聊保留成无关散文/);
});

test('空、无效或未完成响应失败且原对象保持不变，明确 noop 可无损完成', () => {
  const topic = seeded(), before = JSON.stringify(topic);
  for (const [action, reply] of [['update', ''], ['update', '<node title="旧格式"/>'], ['redraw', '<doc>\n## 主题\n只有主题没有结果\n</doc>'], ['redraw', '<doc>\n## 方向\n### ◆ 未完成'], ['tidy', '<revise id="n999" title="不存在"/>']]) {
    assert.throws(() => applyTask(topic, action, reply));
    assert.equal(JSON.stringify(topic), before);
  }
  assert.deepEqual(applyTask(topic, 'update', '<noop/>'), { ledger: topic.ledger, raw: topic.raw });
  assert.deepEqual(applyTask(topic, 'tidy', '<noop/>'), { ledger: topic.ledger, raw: topic.raw });
  assert.throws(() => prepareTask(blank(), 'redraw'), /来源材料/);
});
