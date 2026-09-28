import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { startServer } from '../server.mjs';
import { loadExecutorConfig, saveExecutorConfig } from '../executor-config.mjs';
import * as store from '../store.mjs';

const fixture = path.resolve('apps/gft-local/tests/fixtures/fake-codex.mjs');
const fakeOptions = mode => ({ binary: process.execPath, prefixArgs: [fixture, `--fixture-mode=${mode}`], model: 'fixture-model' });
async function isolated(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-executor-recovery-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = directory;
  try { await run(directory); }
  finally { if (previous === undefined) delete process.env.GFT_LOCAL_HOME; else process.env.GFT_LOCAL_HOME = previous; await rm(directory, { recursive: true, force: true }); }
}
const json = (base, pathname, init = {}) => fetch(`${base}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
async function freePort() {
  const socket = createTcpServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function runCli(directory, extra) {
  const port = await freePort();
  const child = spawn(process.execPath, ['apps/gft-local/cli.mjs', 'serve', '--port', String(port), ...extra], { cwd: path.resolve('.'), env: { ...process.env, GFT_LOCAL_HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI 启动超时：${output}`)), 7000);
    const onData = chunk => { output += chunk.toString(); if (output.includes('GFT Map:')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData); child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const runtime = await (await fetch(`http://127.0.0.1:${port}/api/runtime`)).json();
  child.kill();
  await new Promise(resolve => child.once('close', resolve));
  return runtime;
}

test('手动服务可连接已配置的 Codex，失败后保留配置并允许重试', () => isolated(async directory => {
  await saveExecutorConfig({ agent: 'codex', runnerOptions: fakeOptions('auth-failure') });
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await store.createTopic('连接前', '本地内容');
    const failed = await json(base, '/api/runtime/executor', { method: 'POST', body: JSON.stringify({ agent: 'codex' }) });
    assert.equal(failed.status, 503);
    assert.match((await failed.json()).error, /尚未登录/);
    assert.equal((await (await json(base, '/api/runtime')).json()).mode, 'manual');
    assert.equal((await store.getTopic(before.id)).scope, '本地内容');
    await saveExecutorConfig({ agent: 'codex', runnerOptions: fakeOptions('success') });
    const connected = await json(base, '/api/runtime/executor', { method: 'POST', body: JSON.stringify({ agent: 'codex' }) });
    assert.equal(connected.status, 200);
    assert.equal((await connected.json()).executor.status, 'ready');
    assert.equal((await loadExecutorConfig()).runnerOptions.prefixArgs.at(-1), '--fixture-mode=success');
  } finally { await server.shutdown(); }
}));

test('连接执行器只接受枚举值，任务运行时拒绝检查且不改数据', () => isolated(async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const server = await startServer({ port: 0, agent: 'codex', execute: async () => { await hold; return '<doc>完成</doc>'; } });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const topic = await store.createTopic('忙时连接', '保持原内容');
    const task = await store.createTask(topic.id, 'update', '等待');
    for (let n = 0; n < 100 && (await store.getTask(task.id)).status !== 'running'; n++) await new Promise(resolve => setTimeout(resolve, 20));
    const invalid = await json(base, '/api/runtime/executor', { method: 'POST', body: JSON.stringify({ agent: 'shell' }) });
    assert.equal(invalid.status, 400);
    const busy = await json(base, '/api/runtime/executor', { method: 'POST', body: JSON.stringify({ agent: 'codex' }) });
    assert.equal(busy.status, 409);
    assert.equal((await store.getTopic(topic.id)).scope, '保持原内容');
  } finally { release(); await server.shutdown(); }
}));

test('配置的执行器不会被 --manual 运行抹掉（配置文件仅成功选择时更新）', () => isolated(async directory => {
  await saveExecutorConfig({ agent: 'codex', runnerOptions: fakeOptions('success') });
  const configBefore = await readFile(path.join(directory, 'executor.json'), 'utf8');
  assert.equal(JSON.parse(configBefore).agent, 'codex');
  assert.equal((await runCli(directory, [])).mode, 'automatic');
  assert.equal((await runCli(directory, ['--manual'])).mode, 'manual');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'executor.json'), 'utf8')).agent, 'codex');
}));
