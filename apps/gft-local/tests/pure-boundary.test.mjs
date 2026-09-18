import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entries = [
  'src/service/thinkingMapCore.ts',
  'src/service/tidyCore.ts',
  'src/service/ledger/index.ts',
  'src/service/ledger/bridge.ts',
  'src/service/ledger/docEdit.ts',
  'src/service/ledger/merge.ts',
  'src/component/focus/ThinkingMapView/layout.ts',
  'src/type/sourceSnapshot.ts',
];

test('共享核心的完整 TypeScript 依赖闭包可独立检查，不经过平台服务或 UI 组件', () => {
  const files = entries.map(file => path.join(root, file));
  for (const file of files) assert.ok(existsSync(file), `Missing shared source: ${file}`);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowSyntheticDefaultImports: true,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  const allowedFiles = new Set([
    ...entries,
    'src/type/focusCard.ts',
    'src/type/thinkingMap.ts',
    'src/service/whiteboxDoc.ts',
    'src/service/sourceLog.ts',
    'src/service/sourceCompaction.ts',
  ]);
  const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile).map(file => path.relative(root, file.fileName).replaceAll('\\', '/'));
  for (const file of sources) {
    assert.ok(allowedFiles.has(file) || /^src\/service\/ledger\/[\w-]+\.ts$/.test(file), `Unexpected shared dependency: ${file}`);
  }
});

test('宿主共用生成请求与最终解析，重画和增量使用同一套完整规则', async () => {
  const bundled = await build({ entryPoints: [path.join(root, 'src/service/thinkingMapCore.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
  const core = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const firstRaw = '<doc>\n## 验证\n### ◆ 先验证问题\n用户已决定先验证问题。\n</doc>';
  const first = core.buildFreshMap(core.parseThinkingMapTags(firstRaw));
  first.nodes[0].id = 'j1';
  first.nodes[0].anchor = 'j1';
  const options = { previousMap: first, theme: '只记录验证方法', live: true };
  const request = core.buildGenerateRequest('新材料原文', options);
  assert.equal(request.user, '新材料原文');
  assert.match(request.system, /旧判断一律不重新输出/);
  assert.match(request.system, /只记录验证方法/);
  const nextRaw = `<doc>\n## 验证\n### ？ 需要多少样本？\n仍未决定。\n</doc>\n<edge from="n1" to="d1"/><doc-mark anchor="${first.nodes[0].id}" to="◇">仍待验证</doc-mark><digest>样本数尚未决定。</digest>`;
  const ctx = core.createBuildCtx();
  const preview = core.parseGenerateResponse(nextRaw, options, ctx, { streaming: true });
  const result = core.parseGenerateResponse(nextRaw, options, ctx);
  assert.deepEqual(result.nodes.map(node => node.id), preview.nodes.map(node => node.id));
  assert.equal(result.nodes.length, 2);
  assert.equal(result.nodes[0].id, first.nodes[0].id);
  assert.equal(result.edges.length, 1);
  assert.equal(result.docMarks.length, 1);
  assert.equal(result.digest, '样本数尚未决定。');
  assert.equal(core.buildGenerateRequest('原始记录', { ...options, rewrite: true }).system, core.buildRewritePrompt(options.theme));
});
