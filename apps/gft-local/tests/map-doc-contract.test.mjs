import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundled = await build({
  stdin: {
    contents: `export * from './src/service/thinkingMapCore';
      export * from './src/service/mapDocContract';
      export {createLedger, prepareImport} from './apps/gft-local/core';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
});
const core = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const doc = '<doc>\n## 验证\n### ◆ 先做小样\n只有一周，因此先测试核心能力。\n### ？ 离线能否使用\n断网后的数据保留还待确认。\n</doc>';

test('首次、更新、重画与长历史成稿使用同一内容分工，没有旧式无限节点正文要求', () => {
  const topic = {id:'contract',name:'合成验证',ledger:core.createLedger('验证离线能力'),raw:'',revision:1,updatedAt:0};
  const prompts = [
    core.buildFreshPrompt(20),
    core.buildUpdatePrompt('节点：\nn1: 先做小样',20),
    core.buildRewritePrompt('验证离线能力'),
    core.prepareImport(topic,'先做小样，离线能力待验证。','',true).system,
  ];
  for (const prompt of prompts) {
    assert(prompt.includes(core.MAP_DOC_RULES));
    assert(prompt.includes('<prose domain='));
    assert(prompt.includes('中等篇幅'));
    assert(!prompt.includes('不限长度'));
    assert(!prompt.includes('格式要求只有两条'));
    assert(!prompt.includes('按本节覆盖前面'));
  }
});

test('单双引号属性与XML实体统一读取，实体只解码一次', () => {
  assert.deepEqual(core.readTagAttributes('domain="范围&amp;依据" refs=\'d1,d2\' note="&quot;&apos;&lt;&gt;&amp;quot;"'), {
    domain:'范围&依据', refs:'d1,d2', note:"\"'<>&quot;",
  });
  const output = `${doc}\n<prose domain='验证' refs='d1,d2'>时间有限，因此先做小样确认离线能力。</prose >`;
  assert.doesNotThrow(() => core.validateMapDocOutput(output));
  assert.deepEqual(core.parseThinkingMapTags(output).docSegments.at(-1), {
    domain:'验证',refs:['d1','d2'],text:'时间有限，因此先做小样确认离线能力。',
  });
  const embedded = doc.replace('### ？', '<prose domain=\'验证\' refs=\'d1,d2\'>共同解释。</prose >\n### ？');
  assert.equal(core.parseThinkingMapTags(embedded).nodes.length,2);
});

test('未知引用保留给落账校验，已有节点别名即使没有edge也能映射', () => {
  const parsed = core.parseThinkingMapTags('<prose domain="验证" refs="n1,d1,j999,n999,typo">完整解释。</prose>');
  assert.deepEqual(parsed.docSegments[0].refs,['n1','d1','j999','n999','typo']);
  const resolved = core.resolveEdgeRefs(parsed,{aliasToNode:new Map([['n1',{id:'node-id',anchor:'j42',title:'先做小样'}]])});
  assert.deepEqual(resolved.docSegments[0].refs,['j42','d1','j999','n999','typo']);
});

test('新AI完整响应拒绝损坏章节，历史和流式解析仍能读取可用内容', () => {
  const bad = [
    '<prose domain="验证" refs="d1,d2">尚未闭合',
    '<prose domain="验证" refs="d1,d2"/>',
    '<prose domain=验证 refs="d1,d2">缺少属性引号。</prose>',
    '<prose domain="验证">没有引用属性。</prose>',
    '<prose domain="验证" refs="d1,d2"> </prose>',
    '<prose domain="验[证]" refs="d1,d2">无效章节名。</prose>',
    '<prose domain="验证" refs="d1,d2"><prose domain="嵌套" refs="">嵌套。</prose></prose>',
    '</prose>',
  ];
  for (const prose of bad) {
    assert.throws(() => core.validateMapDocOutput(`${doc}\n${prose}`),/章节正文/);
    assert.throws(() => core.parseGenerateResponse(`${doc}\n${prose}`),/章节正文/);
    assert.equal(core.parseThinkingMapTags(`${doc}\n${prose}`).nodes.length,2);
  }
  assert.equal(core.parseThinkingMapTags(doc).nodes.length,2);
  assert.doesNotThrow(() => core.parseGenerateResponse(`${doc}\n${bad[0]}`,undefined,undefined,{streaming:true}));
  assert.doesNotThrow(() => core.validateMapDocOutput('<prose domain="主线">现在先验证核心能力。</prose>'));
  assert.doesNotThrow(() => core.validateMapDocOutput('<prose domain="背景" refs="">共同背景说明。</prose>'));
});

test('完整响应要求唯一成对Doc标签，允许标签空白并保留半开流式预览', () => {
  const prose = '<prose domain="验证" refs="d1,d2">时间有限，先验证小样和离线能力。</prose>';
  const spaced = doc.replace('<doc>','<doc >').replace('</doc>','</doc \n>');
  assert.doesNotThrow(() => core.validateMapDocOutput(spaced + prose));
  assert.equal(core.parseThinkingMapTags(spaced).nodes.length,2);
  assert.equal(core.parseGenerateResponse(spaced + prose).docEntryNodeIds.length,2);
  const partial = doc.replace('</doc>','');
  for (const broken of [partial + prose, '<doc', '</doc>', '<doc/>', doc + doc, '</doc><doc>', '<doc invalid="yes">内容</doc>']) {
    assert.throws(() => core.validateMapDocOutput(broken),/文档标签/);
    assert.throws(() => core.parseGenerateResponse(broken),/文档标签/);
  }
  assert.equal(core.parseThinkingMapTags(partial).nodes.length,2);
  assert.doesNotThrow(() => core.parseGenerateResponse(partial,undefined,undefined,{streaming:true}));
  assert.doesNotThrow(() => core.validateMapDocOutput('<doc-mark anchor="j3" to="✗">依据失效。</doc-mark>'));
  assert.doesNotThrow(() => core.validateMapDocOutput(prose));
});
