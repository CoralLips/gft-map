import { build } from 'esbuild';
import { mkdir, copyFile, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';
const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Shared source lives outside this app. Resolve framework packages once so a
// nested install cannot put two React / CodeMirror instances in one browser.
const dependencies = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).dependencies;
const alias = {};
for (const name of Object.keys(dependencies).filter(name => name === 'react' || name === 'react-dom' || name.startsWith('@codemirror/') || name.startsWith('@lezer/'))) {
  let directory = path.dirname(require.resolve(name));
  while (true) {
    const manifest = await readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (manifest?.name === name) { alias[name] = directory; break; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot resolve package directory: ${name}`);
    directory = parent;
  }
}
await mkdir(path.join(root, 'dist/web'), { recursive: true });
await writeFile(path.join(root,'dist/version.json'),JSON.stringify({product:'gft-map',version:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version}));
await build({ entryPoints: [path.join(root, 'core.ts')], outfile: path.join(root, 'dist/core.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20', treeShaking: true, nodePaths: [path.join(root,'node_modules')] });
const acp = await build({ entryPoints: [path.join(root, 'acpRunner.mjs')], outfile: path.join(root, 'dist/acp.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20', metafile: true, nodePaths: [path.join(root,'node_modules')] });
await writeFile(path.join(root, 'dist/acp-inputs.json'), JSON.stringify(Object.keys(acp.metafile.inputs), null, 2));
for (const [entry, name] of [['mcp.mjs','mcp'], ['sourceReaders.mjs','sources']]) {
  const bundle = await build({ entryPoints: [path.join(root, entry)], outfile: path.join(root, `dist/${name}.mjs`), bundle: true, platform: 'node', format: 'esm', target: 'node20', metafile: true, nodePaths: [path.join(root,'node_modules')], banner: { js: "import { createRequire as __gftCreateRequire } from 'node:module'; const require = __gftCreateRequire(import.meta.url);" } });
  await writeFile(path.join(root, `dist/${name}-inputs.json`), JSON.stringify(Object.keys(bundle.metafile.inputs), null, 2));
}
const browser = await build({ entryPoints: [path.join(root, 'web/main.tsx')], outfile: path.join(root, 'dist/web/app.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', alias, nodePaths: [path.join(root,'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, minify: true, metafile: true,
  assetNames: 'assets/[name]-[hash]', loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
  plugins: [{ name: 'shared-design-tokens', setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]style[\\/]index\.css$/ }, async ({path:cssPath}) => {
      const result = await postcss([tailwind({base:path.resolve(root,'../..')}),autoprefixer()]).process(await readFile(cssPath,'utf8'),{from:cssPath});
      return {contents:result.css,loader:'css',resolveDir:path.dirname(cssPath)};
    });
  }}],
});
await writeFile(path.join(root,'dist/browser-inputs.json'), JSON.stringify(Object.keys(browser.metafile.inputs),null,2));
await copyFile(path.join(root, 'web/index.html'), path.join(root, 'dist/web/index.html'));
if (process.argv.includes('--skill')) {
  const target = path.join(root, 'release/gft-map');
  await cp(path.join(root, 'skill'), target, { recursive: true });
  await mkdir(path.join(target, 'scripts/dist'), { recursive: true });
  for (const f of ['cli.mjs', 'store.mjs', 'server.mjs', 'account.mjs', 'sync.mjs', 'runner.mjs', 'connections.mjs', 'memory.mjs', 'notifications.mjs', 'change-hook.mjs', 'install-hooks.mjs', 'version.mjs', 'upgrade.mjs']) await copyFile(path.join(root, f), path.join(target, 'scripts', f));
  await cp(path.join(root, 'dist'), path.join(target, 'scripts/dist'), { recursive: true });
  for (const file of ['browser-inputs.json', 'acp-inputs.json', 'mcp-inputs.json', 'sources-inputs.json']) {
    // Metadata is retained for source packaging, not needed by an installed Skill.
    await rm(path.join(target, 'scripts/dist', file), { force: true });
  }
  console.log(target);
} else console.log('GFT Map build ready');
