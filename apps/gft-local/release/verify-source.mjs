import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'SOURCE-MANIFEST.json'), 'utf8'));
if (manifest.format !== 1 || manifest.hashAlgorithm !== 'sha256-utf8-lf') throw new Error('Unsupported source manifest');
for (const item of manifest.files) {
  if (!item.path || path.isAbsolute(item.path) || item.path.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('Unsafe manifest path');
  const text = (await readFile(path.join(root, item.path), 'utf8')).replaceAll('\r\n', '\n');
  if (createHash('sha256').update(text).digest('hex') !== item.sha256) throw new Error(`Source changed after export: ${item.path}`);
}
console.log(`Verified ${manifest.files.length} files from source ${manifest.sourceRevision}${manifest.sourceDirty ? ' (working tree)' : ''}.`);
