import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import * as store from '../store.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const call = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000, windowsHide: true });
const fixtureArgs = adapter => [fixture, '--fixture-mode=success', `--fixture-adapter=${adapter}`];

test('CLI doctor 经打包的 ACP SDK 握手，支持显式参数和每种适配器的环境配置', () => {
  for (const adapter of ['codex', 'claude']) {
    const explicit = call(['doctor', '--agent', `${adapter}-acp`, '--acp-bin', process.execPath, ...fixtureArgs(adapter).flatMap(arg => ['--acp-arg', arg]), '--model', 'fixture-model']);
    assert.equal(explicit.status, 0, explicit.stderr);
    const status = JSON.parse(explicit.stdout);
    assert.equal(status.engine, `${adapter}-acp`);
    assert.equal(status.protocol, 'acp');
    assert.equal(status.status, 'ready');
    assert.equal(status.authenticated, null, 'initialize 握手不能冒充模型认证已通过');
    const prefix = `GFT_${adapter.toUpperCase()}_ACP`;
    const fromEnv = call(['doctor', '--agent', `${adapter}-acp`], { [`${prefix}_BIN`]: process.execPath, [`${prefix}_ARGS`]: JSON.stringify(fixtureArgs(adapter)) });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(JSON.parse(fromEnv.stdout).engine, `${adapter}-acp`);
  }
});

test('CLI 拒绝坏 ACP 配置，不把参数字符串当作 shell 命令执行', () => {
  for (const [args, env] of [
    [['doctor', '--agent', 'unknown'], {}],
    [['doctor', '--agent', 'codex-acp', '--acp-bin', 'relative.exe'], {}],
    [['doctor', '--agent', 'codex-acp'], { GFT_CODEX_ACP_ARGS: '{not-json' }],
    [['doctor', '--agent', 'claude-acp'], { GFT_CLAUDE_ACP_ARGS: '"whole shell command"' }],
    [['doctor', '--agent', 'codex-acp', '--acp-arg'], {}],
  ]) {
    const result = call(args, env);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).status, 400);
  }
});

test('两个 ACP 服务入口均通过任务队列回填并公开实际执行协议', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-acp-cli-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = directory;
  try {
    for (const adapter of ['codex', 'claude']) {
      const server = await startServer({ port: 0, agent: `${adapter}-acp`, runnerOptions: { binary: process.execPath, prefixArgs: fixtureArgs(adapter) } });
      try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const topic = await store.createTopic(`${adapter} 合成接线`, '只验证任务协议');
        const response = await fetch(`${origin}/api/topics/${topic.id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update', input: '这是合成协议回放，不调用真实模型。' }) });
        assert.equal(response.status, 200);
        const created = await response.json();
        let task;
        const deadline = Date.now() + 8000;
        do {
          task = await store.getTask(created.id);
          if (task.status === 'completed' || task.status === 'failed') break;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        assert.equal(task.status, 'completed', task.error);
        const runtime = await (await fetch(`${origin}/api/runtime`)).json();
        assert.equal(runtime.agent, `${adapter}-acp`);
        assert.equal(runtime.executor.protocol, 'acp');
        assert.match((await store.getView(topic.id)).doc, /ACP 合成结果已回填/);
      } finally { await server.shutdown(); }
    }
  } finally {
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME; else process.env.GFT_LOCAL_HOME = previous;
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  }
});
