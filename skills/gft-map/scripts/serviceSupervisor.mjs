// Owns one background service. An intentional stop ends this supervisor too.
import { spawn } from 'node:child_process';
import { readFile, open, mkdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { homeDir, writeJsonAtomic } from './store.mjs';
import { programDirectory, installationId } from './version.mjs';
import { serviceEvent } from './serviceLifecycle.mjs';

const args = process.argv.slice(2);
const directory = path.join(homeDir(), 'service');
const read = async name =>
  JSON.parse(await readFile(path.join(directory, name), 'utf8').catch(() => 'null'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child,
  stopping = false;
const enabled = async () => {
  const state = await read('supervision.json').catch(() => null);
  return state?.enabled && state.generation === process.env.GFT_SERVICE_GENERATION;
};
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
await mkdir(directory, { recursive: true });
const initialExecutor = await readFile(path.join(homeDir(), 'executor.json'), 'utf8').catch(
  () => '',
);
let failures = 0,
  previouslyStarted = false;
async function giveUp(reason, code) {
  const state = await read('supervision.json');
  if (state?.generation === process.env.GFT_SERVICE_GENERATION)
    await writeJsonAtomic(path.join(directory, 'supervision.json'), {
      ...state,
      enabled: false,
      failure: reason,
    });
  await serviceEvent(reason, { childPid: child?.pid, exitCode: code });
  process.exitCode = 1;
}
for (let attempt = 0; !stopping; attempt++) {
  if (!(await enabled())) break;
  // UI Agent switches are saved. Restarts must use that current choice.
  const saved = await readFile(path.join(homeDir(), 'executor.json'), 'utf8').catch(() => '');
  const nextArgs =
    attempt === 0
      ? args
      : [
          'serve',
          '--port',
          args[args.indexOf('--port') + 1],
          ...(args.includes('--manual') && saved === initialExecutor ? ['--manual'] : []),
        ];
  for (const name of ['stdout.log', 'stderr.log']) {
    const file = path.join(directory, name);
    if ((await stat(file).catch(() => null))?.size > 1024 * 1024)
      await rename(file, `${file}.previous`).catch(() => {});
  }
  const stdout = await open(path.join(directory, 'stdout.log'), 'a');
  const stderr = await open(path.join(directory, 'stderr.log'), 'a');
  const started = Date.now();
  let code;
  try {
    child = spawn(process.execPath, [path.join(programDirectory, 'cli.mjs'), ...nextArgs], {
      cwd: programDirectory,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', stdout.fd, stderr.fd],
    });
    code = await new Promise(resolve => {
      child.once('error', () => resolve('spawn-failed'));
      child.once('close', value => resolve(value));
    });
  } finally {
    await stdout.close();
    await stderr.close();
  }
  const record = await read('state.json').catch(() => null);
  previouslyStarted ||= record?.pid === child.pid && record.installationId === installationId;
  if (
    stopping ||
    (record?.pid === child.pid &&
      record.installationId === installationId &&
      record.state === 'stopped' &&
      ['requested-stop', 'upgrade', 'SIGINT', 'SIGTERM'].includes(record.reason))
  )
    break;
  if (!previouslyStarted) {
    await giveUp('initial-start-failed', code);
    break;
  }
  // Another instance must never be replaced by this supervisor.
  if (record?.state === 'running' && record.pid !== child.pid) {
    let alive = false;
    try {
      process.kill(record.pid, 0);
      alive = true;
    } catch {}
    if (alive) break;
  }
  failures = Date.now() - started > 60000 ? 1 : failures + 1;
  if (failures >= 5) {
    await giveUp('automatic-restart-exhausted', code);
    break;
  }
  const waitMs = Math.min(30000, 500 * 2 ** Math.min(failures - 1, 6));
  await serviceEvent('automatic-restart', { childPid: child.pid, exitCode: code, waitMs });
  for (let waited = 0; waited < waitMs && !stopping && (await enabled()); waited += 250)
    await delay(250);
}
