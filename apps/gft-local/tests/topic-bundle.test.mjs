import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopicBundle, parseTopicBundle, bundleToMap, mapToBundle, createLedger, editDocument, appendSourceLog, readSourceLog, topicSummary } from '../dist/core.mjs';

test('平台与本地共同格式往返保住主题、文稿、关系、Log；不携带绑定和水位', () => {
  const topic = { name: '迁移验收', id: 'local', ledger: createLedger('只讨论产品'), raw: '', revision: 5 };
  Object.assign(topic, editDocument(topic, '## 主题\n只讨论产品\n\n## 主线\n人工修正要保留。\n\n### ◇ 本地优先\n离线仍可查看。\n\n### ？ 同步待验证\n明确条件。'));
  topic.raw = appendSourceLog('旧版来源也保留', [{ v: 1, provider: 'codex', sessionId: 'original', id: 'message', role: 'user', content: '当前主题排除的旅行材料。' }]);
  const bundle = createTopicBundle(topic.name, { ...topic, watermarks: { source: 'old' } });
  const platform = bundleToMap(bundle, 'new-platform-project');
  const back = mapToBundle(topic.name, platform);
  assert.deepEqual(back, bundle); assert.equal(bundle.version, 2);
  assert.equal(bundle.topic.id, undefined); assert.equal(bundle.topic.revision, undefined);
  assert.deepEqual(platform.watermarks, {}); assert.ok(platform.nodes.every(n => n.projectId === 'new-platform-project'));
  assert.match(platform.doc, /人工修正要保留/); assert.equal(readSourceLog(platform.raw)[0].content, '当前主题排除的旅行材料。');
});

test('旧 v1 来源快照纳入 Log；范围以真实账为准；拒绝未知版本和损坏数据', () => {
  const old = { format: 'gft-theme', version: 1, topic: { name: '旧包', scope: '过时的范围', ledger: createLedger('当前范围'), raw: '', sourceCursors: { x: 'not-portable' } }, sources: [{ layer: 'L0->L1', outputs: [], inputs: [{ id: '1', role: 'user', content: '没有成图的来源' }], sourceMeta: { sessionId: 'a' } }] };
  const upgraded = parseTopicBundle(old);
  assert.equal(upgraded.topic.scope, '当前范围'); assert.equal(readSourceLog(upgraded.topic.raw).length, 1);
  assert.equal(upgraded.topic.sourceCursors, undefined);
  assert.throws(() => parseTopicBundle({ ...old, version: 3 }));
  assert.throws(() => parseTopicBundle({ ...old, sources: [{ layer: 'bad' }] }));
});

test('索引摘要有界且不破坏 emoji；无主线时保持空，不复制 Log', () => {
  assert.equal(topicSummary(createLedger('范围')), '');
  const topic = { ledger: createLedger(), raw: '' };
  const { ledger } = editDocument(topic, '## 主线\n' + '🙂'.repeat(500));
  assert.equal(Array.from(topicSummary(ledger)).length, 241);
  assert.doesNotMatch(topicSummary(ledger), /�/);
});

test('迁移包按真实 UTF-8 文件大小校验，中文 Log 不会导出成另一端无法导入的包', () => {
  const bundle=createTopicBundle('中文来源',{ledger:createLedger('范围'),raw:'原文'.repeat(500000)});
  const exported=JSON.stringify(bundle,null,2);
  assert.ok(Buffer.byteLength(exported)<4*1024*1024);
  assert.deepEqual(parseTopicBundle(JSON.parse(exported)),bundle);
  assert.throws(()=>createTopicBundle('过大的来源',{ledger:'',raw:'原'.repeat(1500000)}),/4 MB/);
});
