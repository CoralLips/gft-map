import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTestEnvironment } from './test-environment.mjs';

/**
 * The default run guards what the person relies on: decided behaviour, no lost
 * content, undo and redo, and a page that renders. `--all` adds the slower process,
 * protocol, import, sync and upgrade tests; run it before a release.
 */
const CORE = [
  'core',
  'map-doc-write',
  'map-doc-contract',
  'relation-contract',
  'map-selection',
  'map-highlights',
  'log-edit',
  'store',
  'store-atomic',
  'recovery',
  'update-receipt',
  'task-records',
  'topic-bundle',
  'import',
  'progress',
  'page-build',
  'server-operations',
  'source-readers',
  'connections',
  'connections-ui',
  'panel-runtime',
  'executor-recovery',
  'acp-defaults',
];

const directory = fileURLToPath(new URL('../tests/', import.meta.url));
const all = (await readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort();
if (!all.length) throw new Error('No test files found');
const memory = process.argv.includes('--memory');
const chosen = memory
  ? ['panel-runtime.test.mjs']
  : process.argv.includes('--all')
    ? all
    : CORE.map(name => `${name}.test.mjs`);
const missing = chosen.filter(file => !all.includes(file));
if (missing.length) throw new Error(`Test files not found: ${missing.join(', ')}`);
const environment = createTestEnvironment();
try {
  execFileSync(
    process.execPath,
    [
      ...(memory ? ['--expose-gc', '--test-name-pattern=堆内存'] : []),
      '--test',
      // A test that hangs fails after three minutes instead of stalling the whole run.
      '--test-timeout=180000',
      ...chosen.map(file => path.join(directory, file)),
    ],
    { stdio: 'inherit', env: environment.env },
  );
} finally {
  environment.dispose();
}
