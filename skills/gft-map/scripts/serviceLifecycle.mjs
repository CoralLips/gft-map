import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile, link } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { homeDir, writeJsonAtomic } from './store.mjs';
import { installationId, programDirectory } from './version.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = () => path.join(homeDir(), 'service');
const stateFile = () => path.join(directory(), 'state.json');
const launchFile = () => path.join(directory(), 'launch.json');
const failure = (message, status = 503) => Object.assign(new Error(message), { status });
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
async function readState() {
  try { return JSON.parse(await readFile(stateFile(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw failure('服务状态记录无法读取，请检查原数据目录。'); }
}
async function readLaunch() {
  try { return JSON.parse(await readFile(launchFile(), 'utf8')); } catch { return null; }
}
function address(value = process.env.GFT_LOCAL_URL || 'http://127.0.0.1:4317') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw failure('服务地址必须是本机 http://127.0.0.1:端口。', 400);
  }
  url.hostname = '127.0.0.1';
  return url.origin;
}
function owned(runtime) {
  if (runtime?.product !== 'gft-map' || runtime.installationId !== installationId || !samePath(runtime.dataDirectory, homeDir())) {
    throw failure('此端口属于另一份安装或数据目录，未启动或停止任何服务。请使用原安装和 GFT_LOCAL_HOME。', 409);
  }
}
function requested(runtime, { agent, manual, runnerOptions } = {}) {
  if ((agent && runtime.agent !== agent) || (manual && runtime.mode !== 'manual') ||
    (runnerOptions?.model && runtime.executor?.model !== runnerOptions.model) || runnerOptions?.timeoutMs || runnerOptions?.binary || runnerOptions?.prefixArgs?.length) {
    throw failure('已有服务正在使用另一种执行配置；请用 restart 指定新配置，当前服务未改动。', 409);
  }
}
async function probe(url) {
  let response;
  try { response = await fetch(`${url}/api/runtime`, { signal: AbortSignal.timeout(2500) }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw failure('本地服务暂时无响应，未重复启动。请稍后重试或查看 service 日志。');
  }
  if (!response.ok) throw failure(`本地端口返回 HTTP ${response.status}，未启动另一份服务。`, 409);
  let runtime;
  try { runtime = await response.json(); } catch { throw failure('本地端口正在提供其他服务，未启动或停止它。', 409); }
  owned(runtime);
  return runtime;
}

// Metadata only: no documents, prompts, account credentials, or model output.
export async function serviceEvent(event, details = {}) {
  await mkdir(directory(), { recursive: true });
  const log = path.join(directory(), 'events.jsonl');
  if ((await stat(log).catch(() => null))?.size > 1024 * 1024) {
    await rename(log, `${log}.previous`).catch(() => {});
  }
  await appendFile(log, `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...details })}\n`, { mode: 0o600 });
}

export function watchServiceProcess() {
  const log = path.join(directory(), 'events.jsonl');
  const write = (event, details) => { try { appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...details })}\n`); } catch {} };
  process.on('uncaughtExceptionMonitor', (error, origin) => write('uncaught-exception', { code: error.code || error.name, origin }));
  process.on('exit', code => write('process-exit', { code }));
}

/** Record an actual listening server, including foreground starts. */
export async function recordServiceStart({ url, runtime }) {
  const previous = await readState();
  if (previous?.state === 'running' && !alive(previous.pid)) {
    await serviceEvent('previous-exit-unobserved', { previousPid: previous.pid, startedAt: previous.startedAt });
  }
  const record = { state: 'running', url: address(url), pid: process.pid, installationId,
    dataDirectory: homeDir(), instanceId: runtime.serviceInstanceId, version: runtime.version, startedAt: new Date().toISOString() };
  await writeJsonAtomic(stateFile(), record);
  await serviceEvent('started', { instanceId: record.instanceId, version: record.version, url: record.url });
  return async (reason = 'shutdown') => {
    if ((await readState())?.instanceId === record.instanceId) {
      await writeJsonAtomic(stateFile(), { ...record, state: 'stopped', stoppedAt: new Date().toISOString(), reason });
    }
    await serviceEvent('stopped', { instanceId: record.instanceId, reason });
  };
}

export async function checkRecordedService() {
  const previous = await readState();
  if (['running', 'starting'].includes(previous?.state) && previous.pid !== process.pid && alive(previous.pid)) {
    throw failure(`原数据目录已有服务进程（${previous.url}），请复用原服务。`, 409);
  }
}

async function acquireLock(name, timeoutMs, wait = true) {
  await mkdir(directory(), { recursive: true });
  const file = path.join(directory(), name);
  const owner = { pid: process.pid, token: randomUUID() };
  const serialized = JSON.stringify(owner), until = Date.now() + timeoutMs;
  // Publish a fully written owner atomically, including on Windows. A crash
  // during creation leaves an unused ticket, never an ownerless live lock.
  async function claim(target) {
    const ticket = `${target}.${owner.token}.tmp`;
    await writeFile(ticket, serialized, { flag: 'wx', mode: 0o600 });
    try { await link(ticket, target); } finally { await unlink(ticket).catch(() => {}); }
  }
  async function claimCleanup(identity) {
    let generation = createHash('sha256').update(identity).digest('hex');
    while (Date.now() < until) {
      // Never delete or reuse a cleanup ticket: a delayed contender must not
      // unlink a new cleanup owner's lock. Crashes leave small metadata only.
      const ticket = `${file}.reap-${generation}`;
      try { await claim(ticket); return true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const text = await readFile(ticket, 'utf8').catch(() => '');
        if (text === serialized) return true; // Retry this acquisition's own cleanup after a transient file error.
        let cleaner; try { cleaner = JSON.parse(text); } catch {}
        if (cleaner && alive(cleaner.pid)) return false;
        if (!cleaner && !((await stat(ticket).catch(() => null))?.mtimeMs < Date.now() - 30000)) return false;
        // A dead cleaner cannot still remove the main lock. Its successor gets
        // another unique ticket; path length stays bounded even after crashes.
        generation = createHash('sha256').update(`${generation}\0${text}`).digest('hex');
      }
    }
    return false;
  }
  for (;;) {
    try { await claim(file); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const content = await readFile(file, 'utf8').catch(() => '');
      let current; try { current = JSON.parse(content); } catch {}
      const metadata = !current ? await stat(file).catch(() => null) : null;
      const incomplete = !current && metadata?.mtimeMs < Date.now() - 30000;
      if ((current && !alive(current.pid)) || incomplete) {
        const identity = current ? content : `${content}\0${metadata?.birthtimeMs}:${metadata?.mtimeMs}`;
        if (await claimCleanup(identity)) {
          if (await readFile(file, 'utf8').catch(() => '') === content) await unlink(file).catch(() => {});
        }
      } else if (current && !wait) {
        throw failure('此数据目录已有服务进程，未启动第二份。请使用 open 复用原服务。', 409);
      }
      if (Date.now() >= until) throw failure('另一项服务启动或关闭尚未结束，请稍后再试。');
      await delay(100);
    }
  }
  return async () => { if (await readFile(file, 'utf8').catch(() => '') === serialized) await unlink(file).catch(() => {}); };
}
async function locked(run, timeoutMs) {
  const release = await acquireLock('control.lock', timeoutMs);
  try { return await run(); } finally { await release(); }
}
export const acquireServiceLease = () => acquireLock('instance.lock', 3000, false);

export async function serviceStatus({ url } = {}) {
  url = address(url);
  const runtime = await probe(url);
  const record = await readState();
  return { state: runtime ? runtime.serviceState || 'running' : 'stopped', url, runtime, previous: record, logDirectory: directory() };
}

async function ensureUnlocked({ url, agent, runnerOptions, manual, timeoutMs }) {
  let existing = await probe(url);
  const stoppingUntil = Date.now() + timeoutMs;
  while (['starting', 'stopping'].includes(existing?.serviceState)) {
    if (Date.now() >= stoppingUntil) throw failure('原服务仍在启动或关闭，请稍后再试。');
    await delay(100); existing = await probe(url);
  }
  if (existing) { requested(existing, {agent, manual, runnerOptions}); return { state: 'running', reused: true, url, runtime: existing }; }
  const previous = await readState();
  if (['running', 'starting'].includes(previous?.state) && alive(previous.pid)) {
    throw failure(`已有服务进程仍在运行（${previous.url}），未启动第二份。请检查它的状态和原数据目录。`, 409);
  }
  const launching = await readLaunch();
  if (launching && alive(launching.pid) && !(previous?.pid === launching.pid && previous.state === 'stopped')) throw failure('上次启动进程仍在初始化，未重复启动。请稍后检查状态。');
  if (agent && manual) throw failure('--manual 不能与 --agent 同时使用。', 400);
  // Explicit overrides are passed once to serve. It persists them only after
  // the executor check succeeds. Ordinary starts restore the saved selection.
  const args = [path.join(programDirectory, 'cli.mjs'), 'serve', '--port', new URL(url).port || '80'];
  if (manual) args.push('--manual');
  else if (agent) args.push('--agent', agent);
  else if (!(await readFile(path.join(homeDir(), 'executor.json'), 'utf8').catch(() => ''))) args.push('--agent', 'codex');
  if (runnerOptions?.model) args.push('--model', runnerOptions.model);
  if (runnerOptions?.timeoutMs) args.push('--timeout-seconds', String(runnerOptions.timeoutMs / 1000));
  if (agent?.endsWith('-acp') && runnerOptions?.binary) args.push('--acp-bin', runnerOptions.binary);
  if (agent?.endsWith('-acp')) for (const value of runnerOptions?.prefixArgs || []) args.push('--acp-arg', value);
  await serviceEvent('start-requested', { url });
  if (previous?.state === 'running' && !alive(previous.pid)) await serviceEvent('previous-exit-unobserved', { previousPid: previous.pid, startedAt: previous.startedAt });
  for (const name of ['stdout.log', 'stderr.log']) {
    const filename = path.join(directory(), name);
    if ((await stat(filename).catch(() => null))?.size > 1024 * 1024) await rename(filename, `${filename}.previous`).catch(() => {});
  }
  const stdout = await open(path.join(directory(), 'stdout.log'), 'a', 0o600);
  const stderr = await open(path.join(directory(), 'stderr.log'), 'a', 0o600);
  let child, launchError;
  try {
    child = spawn(process.execPath, args, { cwd: programDirectory, env: { ...process.env, GFT_LOCAL_HOME: homeDir() },
      detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
    child.once('error', error => { launchError = error; });
    child.unref();
    if (child.pid) await writeJsonAtomic(launchFile(), { state: 'starting', pid: child.pid, url, installationId,
      dataDirectory: homeDir(), requestedAt: new Date().toISOString(), previousExitUnobserved: previous?.state === 'running' ? previous.pid : undefined });
  } finally { await stdout.close(); await stderr.close(); }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (launchError || child.exitCode !== null || child.signalCode !== null) {
      await serviceEvent('start-failed', { childPid: child.pid, code: launchError?.code || child.exitCode, signal: child.signalCode });
      throw failure(`服务启动后退出，请查看 ${path.join(directory(), 'stderr.log')}。`);
    }
    const runtime = await probe(url);
    if (runtime && !['starting', 'stopping'].includes(runtime.serviceState)) {
      // Check again after initialization settles; the caller owns no server stdio.
      await delay(200);
      if (await probe(url)) return { state: 'running', reused: false, url, runtime };
    }
    await delay(100);
  }
  await serviceEvent('start-timeout', { childPid: child.pid });
  throw failure(`启动仍未就绪，请查看 ${directory()}，未启动第二份服务。`);
}

export async function ensureService(options = {}) {
  const url = address(options.url), timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100) throw failure('启动等待时间无效。', 400);
  return locked(() => ensureUnlocked({ ...options, url, timeoutMs }), timeoutMs);
}

async function stopUnlocked(url) {
  const runtime = await probe(url);
  if (!runtime) return { state: 'stopped', url, alreadyStopped: true };
  if (!runtime.serviceInstanceId) throw failure('旧版服务不支持安全关闭，请先让 Agent 核对原进程。', 409);
  const response = await fetch(`${url}/api/service/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId, dataDirectory: runtime.dataDirectory, serviceInstanceId: runtime.serviceInstanceId }), signal: AbortSignal.timeout(10000) });
  const value = await response.json();
  if (!response.ok) throw failure(value.error || '服务未关闭。', response.status);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const remaining = await probe(url);
      if (!remaining) {
        const record = await readState();
        if (record?.instanceId !== runtime.serviceInstanceId || record.state === 'stopped' || !alive(runtime.pid)) return { state: 'stopped', url, alreadyStopped: false };
        await delay(100); continue;
      }
      if (remaining.serviceInstanceId !== runtime.serviceInstanceId) throw failure('服务实例已经改变，未停止新实例。', 409);
    } catch (error) { if (error.status === 409) throw error; }
    await delay(100);
  }
  throw failure('服务正在关闭，尚未确认退出；未强制结束进程。');
}
export async function stopService({ url, timeoutMs = 60000 } = {}) {
  url = address(url);
  return locked(() => stopUnlocked(url), timeoutMs);
}
export async function restartService(options = {}) {
  const url = address(options.url), timeoutMs = options.timeoutMs ?? 60000;
  return locked(async () => { await stopUnlocked(url); return ensureUnlocked({ ...options, url, timeoutMs }); }, timeoutMs);
}
