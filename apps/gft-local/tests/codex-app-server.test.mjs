import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAppServerRunner } from '../codexAppServer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const task = { id: 'synthetic-codex-task', system: '合成系统规则', user: '合成用户材料' };

async function isolated(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-codex-app-server-'));
  const runner = (mode = 'success', extra = {}) =>
    createCodexAppServerRunner({
      binary: process.execPath,
      prefixArgs: [fixture, `--fixture-mode=${mode}`, `--fixture-record=${directory}`],
      ...extra,
    });
  /** What each started app-server received, oldest first. */
  const invocations = async () => {
    const files = (await readdir(directory)).filter(name => name.startsWith('app-server-'));
    const all = await Promise.all(
      files.map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))),
    );
    return all.sort((a, b) => a.requests.length - b.requests.length);
  };
  try {
    await run({ directory, runner, invocations });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}
async function waitForExit(pid) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      process.kill(Number(pid), 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`进程 ${pid} 没有结束`);
}

test('页面任务在 Codex 不保留的临时线程里运行：文本边写边传，结果、用量与计时如实记录', () =>
  isolated(async ({ directory, runner, invocations }) => {
    const chunks = [];
    const work = path.join(directory, 'run');
    const result = await runner().run(task, { directory: work, onText: text => chunks.push(text) });
    const [call] = await invocations();
    assert.deepEqual(call.args.slice(-3), ['app-server', '--listen', 'stdio://']);
    assert.deepEqual(
      call.requests.map(request => request.method),
      ['initialize', 'model/list', 'model/list', 'thread/start', 'turn/start'],
    );
    const thread = call.requests[3].params;
    assert.equal(thread.ephemeral, true, 'Codex 不保留这个线程，列表里不会出现');
    assert.equal(thread.approvalPolicy, 'never');
    assert.equal(thread.sandbox, 'read-only');
    assert.equal(thread.cwd, work);
    assert.equal(thread.config.features.shell_tool, false);
    assert.equal(thread.config.memories.generate_memories, false);
    const turn = call.requests[4].params;
    assert.match(turn.input[0].text, /合成系统规则[\s\S]*合成用户材料/);
    assert.ok(chunks.length > 1, '文本分段送达，页面可以边写边显示进度');
    assert.doesNotMatch(chunks.join(''), /外线|不应进入结果/);
    assert.match(result.output, /^<doc>[\s\S]*Codex 合成结果已回填[\s\S]*<\/prose>$/);
    assert.equal(result.output, chunks.join(''), '结果是最终回答，不含过程说明');
    const { execution } = result;
    assert.deepEqual(execution.usage, {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 25,
      reasoning_output_tokens: 5,
      total_tokens: 145,
    });
    assert.ok(execution.promptSentMs >= 0 && execution.firstTextMs >= execution.promptSentMs);
    assert.ok(execution.elapsedMs >= execution.firstTextMs);
    assert.equal(execution.version, 'fixture-1.0');
    await waitForExit(call.pid);
  }));

test('默认用推荐模型；所选模型只换模型，强度用该模型自己的默认；已下架的选择明确报错', () =>
  isolated(async ({ directory, runner, invocations }) => {
    const status = await runner().check();
    assert.equal(status.status, 'ready');
    assert.equal(status.model, 'fixture-default');
    assert.equal(status.effort, 'medium');
    assert.equal(status.modelSource, 'provider-default');
    assert.deepEqual(
      status.models.map(item => item.value),
      ['fixture-default', 'fixture-model'],
      '隐藏模型不列，第二页的模型也列出',
    );
    const chosen = await runner('success', { model: 'fixture-model' }).run(task, {
      directory: path.join(directory, 'chosen'),
    });
    assert.equal(chosen.execution.model, 'fixture-model');
    assert.equal(chosen.execution.effort, 'high');
    assert.equal(chosen.execution.modelSource, 'chosen');
    const turn = (await invocations())
      .flatMap(call => call.requests)
      .find(request => request.method === 'turn/start').params;
    assert.equal(turn.model, 'fixture-model');
    assert.equal(turn.effort, 'high');
    await assert.rejects(runner('success', { model: 'withdrawn' }).check(), {
      code: 'RUNNER_MODEL',
    });
  }));

test('取消时中断这一轮并结束整棵进程树', () =>
  isolated(async ({ directory, runner, invocations }) => {
    const codex = runner('hang-tree');
    const controller = new AbortController();
    const running = codex.run(task, {
      directory: path.join(directory, 'cancel'),
      signal: controller.signal,
    });
    const rejected = assert.rejects(running, { code: 'RUNNER_CANCELLED' });
    let call;
    const deadline = Date.now() + 7000;
    while (!(call = (await invocations())[0])?.descendant && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(codex.snapshot().status, 'running');
    await assert.rejects(codex.run(task, { directory }), { code: 'RUNNER_BUSY' });
    controller.abort('cancelled');
    await rejected;
    await codex.waitForIdle();
    call = (await invocations())[0];
    assert.equal(call.interrupted, true);
    await waitForExit(call.pid);
    await waitForExit(call.descendant);
  }));

test('失败不当成功：模型错误、未登录、进程退出如实报告；审批请求一律拒绝', () =>
  isolated(async ({ directory, runner, invocations }) => {
    for (const [mode, code, message] of [
      ['failed', 'RUNNER_MODEL', /合成模型错误/],
      ['logged-out', 'RUNNER_AUTH', /重新登录 Codex/],
      ['exit', 'RUNNER_EXIT', /合成 Codex 退出错误/],
    ])
      await assert.rejects(
        runner(mode).run(task, { directory: path.join(directory, mode) }),
        error => error.code === code && message.test(error.message) && !!error.execution,
      );
    await assert.rejects(runner('hang-initialize', { checkTimeoutMs: 300 }).check(), {
      code: 'RUNNER_CHECK',
    });
    const approved = await runner('approval').run(task, {
      directory: path.join(directory, 'approval'),
    });
    assert.equal(approved.execution.permissionDeniedCount, 1);
    const call = (await invocations()).find(item => 'approvalResponse' in item);
    assert.equal(call.approvalResponse.code, -32601);
    for (const item of await invocations()) await waitForExit(item.pid);
  }));
