import { copyFile, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = path.join(root, 'apps/gft-local');
const release = path.join(app, 'release');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (metadata.name !== 'gft-map' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(metadata.version)) throw new Error('Run from the exported gft-map source repository');
// A release package must be traceable to an unchanged, verified export.
execFileSync(process.execPath, [path.join(release, 'verify-source.mjs')], { cwd: root, stdio: 'inherit' });
// Only these two generated directories are reset; source and runtime data are untouched.
for (const relative of ['apps/gft-local/dist', 'apps/gft-local/release/gft-map']) {
  const directory = path.resolve(root, relative);
  if (path.relative(root, directory).replaceAll('\\', '/') !== relative) throw new Error('Unexpected generated directory');
  const stat = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || path.relative(directory, await realpath(directory)))) throw new Error(`Refusing generated directory alias: ${relative}`);
  await rm(directory, { recursive: true, force: true });
}
execFileSync(process.execPath, [path.join(app, 'build.mjs'), '--skill'], { cwd: root, stdio: 'inherit' });
const notices = await writeNotices();
for (const file of ['LICENSE', 'SOURCE-MANIFEST.json', 'THIRD_PARTY_NOTICES.txt']) await copyFile(path.join(root, file), path.join(release, 'gft-map', file));
// esbuild input paths are useful to the packager, never needed by an installed Skill.
for (const file of ['browser-inputs.json', 'acp-inputs.json', 'mcp-inputs.json', 'sources-inputs.json']) await rm(path.join(release, 'gft-map/scripts/dist', file), { force: true });
const name = `gft-map-${metadata.version}.tar.gz`;
const archive = path.join(release, name);
// tar is provided by current Windows, macOS, and the Linux release runner.
execFileSync('tar', ['-czf', archive, '-C', release, 'gft-map'], { stdio: 'inherit' });
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(path.join(release, 'SHA256SUMS'), `${sha256}  ${name}\n`);
console.log(`Packaged ${name}; notices cover ${notices.packages} bundled dependencies.`);
