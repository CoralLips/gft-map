import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('../tests/', import.meta.url));
const files = (await readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join(directory, file));
if (!files.length) throw new Error('No test files found');
execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
