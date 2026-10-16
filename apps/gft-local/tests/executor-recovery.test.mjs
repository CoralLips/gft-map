import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { startServer } from '../server.mjs';
import { loadExecutorConfig, saveExecutorConfig } from '../executor-config.mjs';
import * as store from '../store.mjs';

// Resolve from this file so the suite runs from the repository or the app directory.
const here = relative => fileURLToPath(new URL(relative, import.meta.url));
const fixture = here('fixtures/fake-codex.mjs');
const fakeOptions = mode => ({
  binary: process.execPath,
  prefixArgs: [fixture, `--fixture-mode=${mode}`],
  model: 'fixture-model',
});
const fakeClaude = {
  binary: process.execPath,
  prefixArgs: [here('fixtures/fake-acp.mjs'), '--fixture-adapter=claude'],
};
async function isolated(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-executor-recovery-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = directory;
  try {
    await run(directory);
  } finally {
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
const json = (base, pathname, init = {}) =>
  fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
async function freePort() {
  const socket = createTcpServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function runCli(directory, extra) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [here('../cli.mjs'), 'serve', '--port', String(port), ...extra],
    {
      env: { ...process.env, GFT_LOCAL_HOME: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI 启动超时：${output}`)), 7000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes('GFT Map:')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  let runtime;
  const deadline = Date.now() + 10000;
  do {
    runtime = await (await fetch(`http://127.0.0.1:${port}/api/runtime`)).json();
    if (runtime.executor.status !== 'checking') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.notEqual(
    runtime.executor.status,
    'checking',
    'executor preparation must finish before terminating the CLI',
  );
  child.kill();
  await new Promise(resolve => child.once('close', resolve));
  return runtime;
}

test('managed service serves content while the Agent initializes, then reports its failure separately', () =>
  isolated(async () => {
    const began = Date.now();
    const server = await startServer({
      port: 0,
      managed: true,
      agent: 'codex-acp',
      runnerOptions: {
        binary: process.execPath,
        prefixArgs: [here('fixtures/fake-acp.mjs'), '--fixture-mode=hang-initialize'],
        timeoutMs: 1800,
        checkTimeoutMs: 1800,
      },
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.ok(Date.now() - began < 1500, 'HTTP startup must not wait for Agent preparation');
      assert.equal((await json(base, '/api/topics')).status, 200);
      assert.equal((await (await json(base, '/api/runtime')).json()).executor.status, 'checking');
      const sharedCheck = json(base, '/api/runtime/executor', { method: 'POST', body: JSON.stringify({ agent: 'codex-acp' }) });
      let runtime;
      const deadline = Date.now() + 10000;
      do {
        await new Promise(resolve => setTimeout(resolve, 50));
        runtime = await (await json(base, '/api/runtime')).json();
      } while (runtime.executor.status === 'checking' && Date.now() < deadline);
      assert.notEqual(runtime.executor.status, 'checking');
      assert.ok(runtime.executor.lastError);
      const sharedResponse = await sharedCheck;
      assert.equal(sharedResponse.status, 503);
      assert.equal(typeof (await sharedResponse.json()).error, 'string');
      assert.equal((await json(base, '/api/topics')).status, 200);
    } finally {
      await server.shutdown();
    }
  }));

test('手动服务可连接已配置的 Codex，失败后保留配置并允许重试', () =>
  isolated(async directory => {
    await saveExecutorConfig({ agent: 'codex', runnerOptions: fakeOptions('auth-failure') });
    const server = await startServer({ port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const before = await store.createTopic('连接前', '本地内容');
      const failed = await json(base, '/api/runtime/executor', {
        method: 'POST',
        body: JSON.stringify({ agent: 'codex' }),
      });
      assert.equal(failed.status, 503);
      assert.match((await failed.json()).error, /尚未登录/);
      assert.equal((await (await json(base, '/api/runtime')).json()).mode, 'manual');
      assert.equal((await store.getTopic(before.id)).scope, '本地内容');
      await saveExecutorConfig({ agent: 'codex', runnerOptions: fakeOptions('success') });
      const connected = await json(base, '/api/runtime/executor', {
        method: 'POST',
        body: JSON.stringify({ agent: 'codex' }),
      });
      assert.equal(connected.status, 200);
      assert.equal((await connected.json()).executor.status, 'ready');
      assert.equal(
        (await loadExecutorConfig()).runnerOptions.prefixArgs.at(-1),
        '--fixture-mode=success',
      );
    } finally {
      await server.shutdown();
    }
  }));

test('连接执行器只接受枚举值，任务运行时拒绝检查且不改数据', () =>
  isolated(async () => {
    let release;
    const hold = new Promise(resolve => {
      release = resolve;
    });
    const server = await startServer({
      port: 0,
      agent: 'codex',
      execute: async () => {
        await hold;
        return '<doc>完成</doc>';
      },
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const topic = await store.createTopic('忙时连接', '保持原内容');
      const task = await store.createTask(topic.id, 'update', '等待');
      for (let n = 0; n < 100 && (await store.getTask(task.id)).status !== 'running'; n++)
        await new Promise(resolve => setTimeout(resolve, 20));
      const invalid = await json(base, '/api/runtime/executor', {
        method: 'POST',
        body: JSON.stringify({ agent: 'shell' }),
      });
      assert.equal(invalid.status, 400);
      const busy = await json(base, '/api/runtime/executor', {
        method: 'POST',
        body: JSON.stringify({ agent: 'codex' }),
      });
      assert.equal(busy.status, 409);
      assert.equal((await store.getTopic(topic.id)).scope, '保持原内容');
    } finally {
      release();
      await server.shutdown();
    }
  }));

test('配置的执行器不会被 --manual 运行抹掉（配置文件仅成功选择时更新）', () =>
  isolated(async directory => {
    await saveExecutorConfig({
      agent: 'codex-acp',
      runnerOptions: { binary: process.execPath, prefixArgs: [here('fixtures/fake-acp.mjs')] },
    });
    await saveExecutorConfig({ agent: 'codex', runnerOptions: fakeOptions('success') });
    const configBefore = await readFile(path.join(directory, 'executor.json'), 'utf8');
    assert.equal(JSON.parse(configBefore).agent, 'codex');
    assert.equal((await runCli(directory, [])).mode, 'automatic');
    assert.equal((await runCli(directory, ['--manual'])).mode, 'manual');
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, 'executor.json'), 'utf8')).agent,
      'codex-acp',
    );
  }));

test('设置检查不改当前Agent，空闲时可切换并保留每家配置，失败不丢原连接', () =>
  isolated(async () => {
    await saveExecutorConfig({
      agent: 'codex-acp',
      runnerOptions: { binary: process.execPath, prefixArgs: [here('fixtures/fake-acp.mjs')] },
    });
    await saveExecutorConfig({ agent: 'claude-acp', runnerOptions: fakeClaude });
    await saveExecutorConfig({ agent: 'codex', runnerOptions: fakeOptions('success') });
    const server = await startServer({
      port: 0,
      agent: 'codex',
      runnerOptions: fakeOptions('success'),
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const choose = agent =>
      json(base, '/api/runtime/executor', { method: 'POST', body: JSON.stringify({ agent }) });
    try {
      const candidates = await (await json(base, '/api/runtime/executors')).json();
      assert.equal(candidates.length, 2);
      assert.equal(candidates.find(item => item.agent === 'codex-acp').status, 'ready');
      assert.equal(candidates.find(item => item.agent === 'claude-acp').status, 'ready');
      assert.equal(server.runtime().agent, 'codex');
      const switched = await choose('claude-acp');
      assert.equal(switched.status, 200);
      assert.equal((await switched.json()).agent, 'claude-acp');
      assert.deepEqual((await loadExecutorConfig()).profiles.codex, fakeOptions('success'));
      const restored = await choose('codex');
      assert.equal(restored.status, 200);
      assert.equal(server.runtime().executor.model, 'fixture-model');
      await saveExecutorConfig({
        agent: 'claude-acp',
        runnerOptions: { binary: path.resolve('missing-acp-executable') },
      });
      await saveExecutorConfig({ agent: 'codex', runnerOptions: fakeOptions('success') });
      const before = await loadExecutorConfig();
      assert.equal((await choose('claude-acp')).status, 503);
      assert.equal(server.runtime().agent, 'codex');
      assert.equal(server.runtime().executor.status, 'ready');
      assert.equal(server.runtime().executor.lastError, null);
      assert.deepEqual(await loadExecutorConfig(), before);
    } finally {
      await server.shutdown();
    }
  }));
