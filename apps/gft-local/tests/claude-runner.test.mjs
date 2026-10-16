import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment, createClaudeRunner, resolveClaudeBinary } from '../claudeRunner.mjs';
import { createRunner } from '../server.mjs';

const fixture = fileURLToPath(new URL('fixtures/fake-claude.mjs', import.meta.url));
const options = mode => ({
  binary: process.execPath,
  prefixArgs: [fixture, `--fixture-mode=${mode}`],
});
const task = { id: 'claude-task', system: '按合同输出。', user: '材料正文' };

async function workspace(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-claude-runner-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('检查读取版本与登录状态，不调用模型；未登录给出登录指引', async () => {
  const ready = await createClaudeRunner(options('success')).check();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.authenticated, true);
  assert.match(ready.version, /Claude Code fixture/);

  const runner = createClaudeRunner(options('logged-out'));
  await assert.rejects(runner.check(), { code: 'RUNNER_AUTH', message: /claude auth login/ });
  assert.equal(runner.snapshot().status, 'unavailable');
  assert.equal(runner.snapshot().authenticated, false);
});

test('单次无工具调用：提示词走文件、材料走 stdin，结果与用量来自 CLI', () =>
  workspace(async directory => {
    const { output, execution } = await createClaudeRunner(options('success')).run(task, {
      directory,
    });
    assert.equal(output, '已处理：材料正文');
    const invocation = JSON.parse(await readFile(path.join(directory, 'invocation.json'), 'utf8'));
    for (const [flag, value] of [
      ['--tools', ''],
      ['--setting-sources', ''],
      ['--output-format', 'json'],
    ])
      assert.equal(invocation.args[invocation.args.indexOf(flag) + 1], value, flag);
    for (const flag of [
      '-p',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ])
      assert.ok(invocation.args.includes(flag), flag);
    assert.equal(invocation.input, '材料正文');
    assert.match(invocation.instructions, /不调用工具[\s\S]*按合同输出。$/);
    await assert.rejects(access(path.join(directory, 'task-instructions.md')), { code: 'ENOENT' });
    assert.equal(execution.engine, 'claude');
    assert.equal(execution.model, 'claude-fixture');
    assert.deepEqual(execution.usage, {
      input_tokens: 120,
      output_tokens: 34,
      cached_input_tokens: 5,
      cache_write_tokens: 0,
    });
    assert.equal(execution.costUsd, 0.0123);
  }));

test('登录过期、模型错误与无法解析的输出分别给出明确失败', () =>
  workspace(async directory => {
    const run = mode => createClaudeRunner(options(mode)).run(task, { directory });
    await assert.rejects(run('auth-expired'), {
      code: 'RUNNER_AUTH',
      message: /claude auth login/,
    });
    await assert.rejects(run('model-error'), { code: 'RUNNER_MODEL', message: /Overloaded/ });
    await assert.rejects(run('garbage'), { code: 'RUNNER_PROTOCOL' });
  }));

test('取消会结束 CLI 进程并保留明确原因', () =>
  workspace(async directory => {
    const runner = createClaudeRunner(options('hang'));
    const controller = new AbortController();
    const running = runner.run(task, { directory, signal: controller.signal });
    setTimeout(() => controller.abort('cancelled'), 300);
    await assert.rejects(running, { code: 'RUNNER_CANCELLED' });
    assert.equal(runner.snapshot().status, 'unchecked');
    await runner.waitForIdle();
  }));

test('不继承父 Claude Code 会话的标记与代理地址，保留用户自己的配置', () => {
  const env = childEnvironment({
    CLAUDECODE: '1',
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
    CLAUDE_AGENT_SDK_VERSION: '0.3.0',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
    ANTHROPIC_API_KEY: 'user-key',
    CLAUDE_CODE_USE_BEDROCK: '1',
    PATH: '/bin',
  });
  assert.deepEqual(env, {
    ANTHROPIC_API_KEY: 'user-key',
    CLAUDE_CODE_USE_BEDROCK: '1',
    PATH: '/bin',
  });
  assert.equal(
    childEnvironment({ ANTHROPIC_BASE_URL: 'https://proxy' }).ANTHROPIC_BASE_URL,
    'https://proxy',
  );
});

test('Windows 上找到 npm 外壳背后的 claude.exe；可用 GFT_CLAUDE_BIN 指定', () =>
  workspace(async directory => {
    const native = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    await mkdir(native, { recursive: true });
    await writeFile(path.join(directory, 'claude.cmd'), '@echo off');
    await writeFile(path.join(native, 'claude.exe'), '');
    assert.equal(
      resolveClaudeBinary({ PATH: directory }, 'win32'),
      path.join(native, 'claude.exe'),
    );
    assert.equal(
      resolveClaudeBinary({ PATH: directory, GFT_CLAUDE_BIN: 'C:/x/claude.exe' }, 'win32'),
      'C:/x/claude.exe',
    );
    assert.equal(resolveClaudeBinary({ PATH: directory }, 'linux'), 'claude');
  }));

test('服务的 claude 执行器入口使用同一实现', async () => {
  const runner = await createRunner('claude', options('success'));
  assert.equal((await runner.check()).engine, 'claude');
});
