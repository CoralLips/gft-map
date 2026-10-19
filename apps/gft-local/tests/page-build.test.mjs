import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const built = file =>
  readFile(new URL(`../dist/web/${file}`, import.meta.url), 'utf8').catch(() => {
    throw new Error(`dist/web/${file} is missing; run npm run build first.`);
  });

test('构建出的页面带着全局布局样式，面板不会塌成空白', async () => {
  const [html, css] = await Promise.all([built('index.html'), built('app.css')]);
  assert.match(html, /<link rel="stylesheet" href="\/app\.css"/);
  assert.match(html, /<script type="module" src="\/app\.js"/);
  assert.match(css, /#root\{height:100vh/, '根节点占满整屏');
  assert.match(css, /\.gft-local-shell\{height:100%/, '外壳撑满根节点');
});
