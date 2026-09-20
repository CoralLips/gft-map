import assert from 'node:assert/strict';
import { readFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(source, '../site-dist');
// Relative assets must keep working below the GitHub Pages repository prefix.
for (const file of ['index.html', 'index.en.html', 'demo.html']) {
  const html = await readFile(path.join(output, file), 'utf8');
  for (const [, raw] of html.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) {
    if (/^(?:https?:|data:)/.test(raw)) continue;
    assert.ok(!raw.startsWith('/'), `${file} has a root-relative URL: ${raw}`);
    const [location, fragment] = raw.replaceAll('&amp;', '&').split('#');
    const target = location.split('?')[0] || file;
    const relative = target.endsWith('/') ? target + 'index.html' : target;
    await access(path.join(output, relative));
    if (fragment) {
      const page = await readFile(path.join(output, relative), 'utf8');
      assert.ok(page.includes(`id="${fragment}"`), `Missing anchor: ${raw}`);
    }
  }
}
for (const [name, signature] of [['product.png', '89504e470d0a1a0a'], ['writing.png', '89504e470d0a1a0a'], ['engineering.png', '89504e470d0a1a0a'], ['walkthrough.gif', '474946383961']]) {
  const asset = await readFile(path.join(output, 'assets', name));
  assert.equal(asset.subarray(0, signature.length / 2).toString('hex'), signature, `Corrupt asset: ${name}`);
}
const cache = path.resolve(source, '../node_modules/.cache/gft-showcase');
await mkdir(cache, { recursive: true });
const outfile = path.join(cache, 'check-runtime.mjs');
await build({ entryPoints: [path.join(source, 'runtime.ts')], outfile, bundle: true, platform: 'node', format: 'esm', nodePaths: [path.resolve(source, '../node_modules')], logLevel: 'silent' });
const { createShowcaseRuntime } = await import(pathToFileURL(outfile).href);
const saved = new Map();
const previous = globalThis.sessionStorage;
globalThis.sessionStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
const messages = [];
try {
  const runtime = createShowcaseRuntime('product', message => messages.push(message));
  await runtime.start();
  assert.equal(runtime.host.getSnapshot().projects.length, 3);
  for (const id of ['product', 'writing', 'engineering']) {
    const bundle = JSON.parse(await readFile(path.join(output, 'examples', `${id}.gft.json`), 'utf8'));
    assert.equal(bundle.format, 'gft-theme'); assert.equal(bundle.version, 2);
    await runtime.host.importBundle(bundle);
    assert.equal(runtime.store.getState().ledger, bundle.topic.ledger);
    assert.equal(runtime.store.getState().raw, bundle.topic.raw, 'Keep the original sources');
    assert.equal(runtime.store.getState().nodes.length, 6);
  }
  assert.equal(runtime.host.getSnapshot().projects.length, 6, 'Imports create new topics');
  await runtime.host.switchProject('product');
  const original = runtime.store.getState().doc;
  runtime.store.getState().setDocDraft(original + '\n\n验证：调整为五位用户独立试用。');
  runtime.flush();
  assert.match(runtime.store.getState().doc, /五位用户独立试用/);
  const reloaded = createShowcaseRuntime('product', message => messages.push(message));
  await reloaded.start();
  assert.match(reloaded.store.getState().doc, /五位用户独立试用/, 'Reload preserves human edits');
  await reloaded.reset('product');
  assert.equal(reloaded.store.getState().doc, original, 'Reset restores only the selected authored example');
  assert.equal(reloaded.host.getSnapshot().projects.length, 6, 'Reset preserves imported copies');
  const count = messages.length;
  await reloaded.host.requestUpdate();
  await reloaded.store.getState().tidyWhitebox();
  await reloaded.store.getState().redrawFromLedger();
  assert.equal(messages.length, count + 3, 'Model buttons explain their boundary');
  assert.equal(reloaded.store.getState().doc, original, 'Static demo never fabricates generation');
  reloaded.flush();
  const english = createShowcaseRuntime('product', message => messages.push(message), 'en');
  await english.start();
  assert.match(english.store.getState().doc, /Main thread/);
  assert.doesNotMatch(english.store.getState().doc, /主线|五位用户独立试用/);
  for (const id of ['product', 'writing', 'engineering']) {
    const bundle = JSON.parse(await readFile(path.join(output, 'examples', id + '.en.gft.json'), 'utf8'));
    await english.host.importBundle(bundle);
    assert.equal(english.store.getState().nodes.length, 6);
    assert.equal(english.store.getState().raw, bundle.topic.raw);
    assert.match(english.store.getState().doc, /Main thread/, 'English main thread survives import');
  }
  await english.host.switchProject('product');
  english.store.getState().setDocDraft(english.store.getState().doc + '\n\nAcceptance: five independent users.');
  english.flush();
  const englishReload = createShowcaseRuntime('product', () => {}, 'en');
  await englishReload.start();
  assert.match(englishReload.store.getState().doc, /five independent users/);
  const chineseReload = createShowcaseRuntime('product', () => {}, 'zh');
  await chineseReload.start();
  assert.equal(chineseReload.store.getState().doc, original, 'Language switch cannot overwrite Chinese edits');
} finally {
  if (previous === undefined) delete globalThis.sessionStorage;
  else globalThis.sessionStorage = previous;
}
console.log('Showcase verified: links, images, three portable examples, edit/reload, import/reset, model boundary.');
