import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTestEnvironment } from './test-environment.mjs';

const directory = fileURLToPath(new URL('../tests/', import.meta.url));
const files = (await readdir(directory))
  .filter(file => file.endsWith('.test.mjs'))
  .sort()
  .map(file => path.join(directory, file));
if (!files.length) throw new Error('No test files found');
const memory = process.argv.includes('--memory');
const environment = createTestEnvironment();
try {
  execFileSync(
    process.execPath,
    [
      ...(memory ? ['--expose-gc', '--test-name-pattern=堆内存'] : []),
      '--test',
      ...(memory ? files.filter(file => file.endsWith('panel-runtime.test.mjs')) : files),
    ],
    { stdio: 'inherit', env: environment.env },
  );
} finally {
  environment.dispose();
}
