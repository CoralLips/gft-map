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
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const call = (args, env = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
// Codex runs through its own app-server; Claude through the ACP adapter.
const executors = [
  {
    agent: 'codex-acp',
    env: 'GFT_CODEX_ACP',
    args: [fixture('fake-codex-app-server.mjs'), '--fixture-mode=success'],
    engine: 'codex-app-server',
    protocol: 'app-server',
    model: 'fixture-default',
    effort: 'medium',
  },
  {
    agent: 'claude-acp',
    env: 'GFT_CLAUDE_ACP',
    args: [fixture('fake-acp.mjs'), '--fixture-mode=success'],
    engine: 'claude-acp',
    protocol: 'acp',
    model: 'default',
    effort: 'auto',
  },
];

test('CLI doctor 检查两种默认执行器，支持显式参数和各自的环境配置', () => {
  for (const executor of executors) {
    const explicit = call([
      'doctor',
      '--agent',
      executor.agent,
      '--acp-bin',
      process.execPath,
      ...executor.args.flatMap(arg => ['--acp-arg', arg]),
    ]);
    assert.equal(explicit.status, 0, explicit.stderr);
    const status = JSON.parse(explicit.stdout);
    assert.equal(status.engine, executor.engine);
    assert.equal(status.protocol, executor.protocol);
    assert.equal(status.status, 'ready');
    assert.equal(status.modelSource, 'provider-default');
    assert.equal(status.model, executor.model);
    assert.equal(status.effort, executor.effort);
    assert.equal(status.authenticated, null, '握手不能冒充模型认证已通过');
    const fromEnv = call(['doctor', '--agent', executor.agent], {
      [`${executor.env}_BIN`]: process.execPath,
      [`${executor.env}_ARGS`]: JSON.stringify(executor.args),
    });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(JSON.parse(fromEnv.stdout).engine, executor.engine);
  }
});

test('CLI 拒绝坏 ACP 配置，不把参数字符串当作 shell 命令执行', () => {
  for (const [args, env] of [
    [['doctor', '--agent', 'unknown'], {}],
    [['doctor', '--agent', 'codex-acp', '--model', 'personal-model'], {}],
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

test('两种默认执行器均通过任务队列回填并公开实际执行协议', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-acp-cli-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = directory;
  try {
    for (const executor of executors) {
      const server = await startServer({
        port: 0,
        agent: executor.agent,
        runnerOptions: { binary: process.execPath, prefixArgs: executor.args },
      });
      try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const topic = await store.createTopic(`${executor.agent} 合成接线`, '只验证任务协议');
        const response = await fetch(`${origin}/api/topics/${topic.id}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', input: '这是合成协议回放，不调用真实模型。' }),
        });
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
        assert.equal(runtime.agent, executor.agent);
        assert.equal(runtime.executor.protocol, executor.protocol);
        assert.match((await store.getView(topic.id)).doc, /合成结果已回填/);
      } finally {
        await server.shutdown();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previous;
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  }
});
