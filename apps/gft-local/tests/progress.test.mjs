import test from 'node:test';
import assert from 'node:assert/strict';
import { progressOf } from '../progress.mjs';

test('只把写完的标签和整行算作进度，并换成真实节点编号', () => {
  const aliases = { n1: 'j2', n2: 'j3', n3: 'j7' };
  assert.deepEqual(progressOf('<merge title="合在一起" members="n1,n2"', aliases), [], '标签没写完不算');
  assert.deepEqual(
    progressOf(
      '<link from="n1" to="n3" reason="r" evidence="e"/>\n<drop id="n3"/>\n<revise id="n2" title="新标题"/>\n<add id="new1" title="新判断" body="b"/>\n<prose domain="主题">x</prose>\n<prose domain="验证" refs="n1">',
      aliases,
    ),
    [
      { kind: 'link', ids: ['j2', 'j7'] },
      { kind: 'drop', ids: ['j7'] },
      { kind: 'revise', title: '新标题', ids: ['j3'] },
      { kind: 'add', title: '新判断', ids: [] },
      { kind: 'prose', domain: '验证' },
    ],
    '主题不算改写章节',
  );
});

test('更新和重画按写完的判断标题计步，最后一行没写完不算', () => {
  assert.deepEqual(progressOf('<doc>\n## 验证\n### ◆ 先做小样\n正文\n### ◇ 再看反馈'), [
    { kind: 'node', title: '先做小样' },
  ]);
});
