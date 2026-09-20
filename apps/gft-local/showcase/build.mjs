import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';

const source = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(source, '..');
const repo = path.resolve(app, '../..');
const output = path.join(app, 'site-dist');
const require = createRequire(path.join(app, 'package.json'));
const dependencies = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8')).dependencies;
const alias = {};
for (const name of Object.keys(dependencies).filter(name => name === 'react' || name === 'react-dom' || name.startsWith('@codemirror/') || name.startsWith('@lezer/'))) {
  let directory = path.dirname(require.resolve(name));
  for (;;) {
    const manifest = await readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (manifest?.name === name) { alias[name] = directory; break; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot resolve ${name}`);
    directory = parent;
  }
}
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(source, 'demo.tsx')], outfile: path.join(output, 'demo.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
  alias, nodePaths: [path.join(app, 'node_modules')], minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
  assetNames: 'assets/[name]-[hash]', loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
  plugins: [{ name: 'same-gft-styles', setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]style[\\/]index\.css$/ }, async ({ path: cssPath }) => {
      const result = await postcss([tailwind({ base: repo }), autoprefixer()]).process(await readFile(cssPath, 'utf8'), { from: cssPath });
      return { contents: result.css, loader: 'css', resolveDir: path.dirname(cssPath) };
    });
  }}],
});
for (const name of ['index.html', 'index.en.html', 'demo.html', 'site.css', 'site.js']) await copyFile(path.join(source, name), path.join(output, name));
await cp(path.join(source, 'assets'), path.join(output, 'assets'), { recursive: true });
await writeFile(path.join(output, '.nojekyll'), '');
const generated = path.join(app, 'node_modules/.cache/gft-showcase');
await mkdir(generated, { recursive: true });
await build({ entryPoints: [path.join(source, 'examples.ts')], outfile: path.join(generated, 'examples.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20' });
const { examples, exampleBundle, getExamples } = await import(pathToFileURL(path.join(generated, 'examples.mjs')).href);
await mkdir(path.join(output, 'examples'), { recursive: true });
for (const example of examples) await writeFile(path.join(output, 'examples', `${example.id}.gft.json`), JSON.stringify(exampleBundle(example), null, 2) + '\n');
for (const example of getExamples('en')) await writeFile(path.join(output, 'examples', `${example.id}.en.gft.json`), JSON.stringify(exampleBundle(example, 'en'), null, 2) + '\n');
console.log(`GFT Map showcase: ${output}`);
if (process.argv.includes('--serve')) {
  const { createServer } = await import('node:http');
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
  createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const target = path.resolve(output, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
      const relative = path.relative(output, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
      const content = await readFile(target);
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
  }).listen(4318, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4318/'));
}
