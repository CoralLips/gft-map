import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Include license text for actual browser and ACP runtime bundle dependencies. */
export async function writeNotices() {
  const inputs = (await Promise.all(['browser-inputs.json', 'acp-inputs.json', 'mcp-inputs.json', 'sources-inputs.json'].map(file => readFile(path.join(root, 'apps/gft-local/dist', file), 'utf8').then(JSON.parse)))).flat();
  const directories = new Set();
  for (const input of inputs) {
    const normalized = path.resolve(root, input).replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('/node_modules/');
    if (marker === -1) continue;
    const segments = normalized.slice(marker + 14).split('/');
    const name = segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
    directories.add(`${normalized.slice(0, marker + 14)}${name}`);
  }
  if (!directories.size) throw new Error('No bundled dependency metadata; build from the public repository root first');
  const sections = [];
  for (const directory of [...directories].sort()) {
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name));
    if (!files.length) throw new Error(`License text missing for ${metadata.name}`);
    const texts = [];
    for (const file of files.sort()) texts.push(`${file}\n${await readFile(path.join(directory, file), 'utf8')}`);
    sections.push(`${metadata.name}@${metadata.version}\nLicense: ${metadata.license || 'See text below'}\n\n${texts.join('\n\n')}`);
  }
  const heading = 'GFT Local — bundled third-party notices\n\nThese packages are included in the browser or ACP runtime distribution. Their original license terms follow. Build-only dependencies are recorded with versions and license identifiers in package-lock.json and are not shipped in the Skill.\n';
  const output = path.join(root, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(output, `${heading}\n${sections.join('\n\n' + '='.repeat(72) + '\n\n')}\n`);
  return { output, packages: directories.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await writeNotices());
