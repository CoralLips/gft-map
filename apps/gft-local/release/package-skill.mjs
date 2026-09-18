import { copyFile, readFile, writeFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = path.join(root, 'apps/gft-local');
const release = path.join(app, 'release');
const metadata = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(metadata.version)) throw new Error('Invalid application version');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--directory-only')) throw new Error('Usage: node package-skill.mjs [--directory-only]');
// Developers may change and package their code. Export provenance is checked by
// the maintenance repository before publishing, never required for local builds.
// Only these two generated directories are reset; source and runtime data are untouched.
for (const relative of ['apps/gft-local/dist', 'apps/gft-local/release/gft-map']) {
  const directory = path.resolve(root, relative);
  if (path.relative(root, directory).replaceAll('\\', '/') !== relative) throw new Error('Unexpected generated directory');
  const stat = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || path.relative(directory, await realpath(directory)))) throw new Error(`Refusing generated directory alias: ${relative}`);
  await rm(directory, { recursive: true, force: true });
}
execFileSync(process.execPath, [path.join(app, 'build.mjs'), '--skill'], { cwd: root, stdio: 'inherit' });
const notices = await writeNotices({ output: path.join(release, 'gft-map/THIRD_PARTY_NOTICES.txt') });
await copyFile(path.join(release, 'LICENSE'), path.join(release, 'gft-map/LICENSE'));
// esbuild input paths are useful to the packager, never needed by an installed Skill.
for (const file of ['browser-inputs.json', 'acp-inputs.json', 'mcp-inputs.json', 'sources-inputs.json']) await rm(path.join(release, 'gft-map/scripts/dist', file), { force: true });
// Source checkouts can use CRLF. Keep the distributed text consistent on all
// platforms while preserving binary font/image bytes exactly.
const textExtensions = new Set(['.md', '.mjs', '.js', '.css', '.html', '.txt', '.json', '.svg']);
async function normalizeText(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected packaged symlink: ${file}`);
    if (entry.isDirectory()) await normalizeText(file);
    else if (entry.isFile() && (entry.name === 'LICENSE' || textExtensions.has(path.extname(entry.name)))) {
      const text = await readFile(file, 'utf8');
      if (text.includes('\r\n')) await writeFile(file, text.replaceAll('\r\n', '\n'));
    }
  }
}
await normalizeText(path.join(release, 'gft-map'));
const name = `gft-map-${metadata.version}.tar.gz`;
const archive = path.join(release, name);
if (args.includes('--directory-only')) {
  console.log(`Installable Skill: ${path.join(release, 'gft-map')}; notices cover ${notices.packages} bundled dependencies.`);
} else {
  // tar is provided by current Windows, macOS, and the Linux release runner.
  execFileSync('tar', ['-czf', archive, '-C', release, 'gft-map'], { stdio: 'inherit' });
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(path.join(release, 'SHA256SUMS'), `${sha256}  ${name}\n`);
  console.log(`Packaged ${name}; notices cover ${notices.packages} bundled dependencies.`);
}
