import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexRunner } from '../runner.mjs';
import { startServer } from '../server.mjs';
import * as store from '../store.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const options = (mode = 'success', extra = {}) => ({ binary: process.execPath, prefixArgs: [fixture, `--fixture-mode=${mode}`], resolveDefaults: async () => ({ model: 'fixture-default', effort: 'medium' }), ...extra });
async function isolated(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gft-local-runner-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = dir;
  try { await run(dir); }
  finally {
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME; else process.env.GFT_LOCAL_HOME = previous;
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(dir).startsWith('gft-local-runner-'));
    await rm(dir, { recursive: true, force: true });
  }
}
const waitFor = async (run, accept) => {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const result = await run(); if (accept(result)) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('等待执行器状态超时');
};
const task = { id: 'fixture-task', system: '合成系统规则', user: '合成用户材料' };

test('自动模型每次由执行器解析，模型及默认强度变化会用于下一次临时执行', () => isolated(async dir => {
  let defaults = { model: 'default-a', effort: 'low' };
  const runner = createCodexRunner(options('success', { resolveDefaults: async () => defaults }));
  await runner.check();
  assert.equal(runner.snapshot().model, 'default-a');
  defaults = { model: 'default-b', effort: 'medium' };
  const result = await runner.run(task, { directory: dir });
  assert.equal(result.execution.model, 'default-b');
  assert.equal(result.execution.effort, 'medium');
  const invocation = JSON.parse(await readFile(path.join(dir, 'invocation.json'), 'utf8'));
  assert(invocation.args.includes('default-b'));
  assert(invocation.args.includes('model_reasoning_effort="medium"'));
  assert(invocation.args.includes('--ephemeral'));
}));
const waitForExit = pid => waitFor(async () => {
  try { process.kill(Number(pid),0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}, Boolean);

test('执行器启动预检：真实子进程报告版本与登录，缺命令/未登录明确失败', () => isolated(async () => {
  const runner = createCodexRunner(options());
  const status = await runner.check();
  assert.equal(status.status, 'ready');
  assert.equal(status.authenticated, true);
  assert.equal(status.version, 'codex-cli fixture');
  await assert.rejects(createCodexRunner(options('auth-failure')).check(), { code: 'RUNNER_AUTH' });
  await assert.rejects(createCodexRunner({ binary: path.join(tmpdir(), 'nonexistent-gft-codex-executable') }).check(), { code: 'RUNNER_START' });
}));

test('真实spawn传stdin与隔离参数，读取结果文件，汇总JSON事件/usage/耗时且不记录工具内容', () => isolated(async dir => {
  const runner = createCodexRunner(options('success', { model: 'fixture-model' }));
  await runner.check();
  const result = await runner.run(task, { directory: dir });
  const invocation = JSON.parse(await readFile(path.join(dir, 'invocation.json'), 'utf8'));
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--strict-config', '--json', '--ephemeral']) assert.ok(invocation.args.includes(flag));
  assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'fixture-model');
  assert.ok(invocation.args.includes('features.shell_tool=false'));
  assert.ok(invocation.args.includes('features.plugins=false'));
  assert.ok(invocation.args.includes('skills.include_instructions=false'));
  assert.equal(invocation.input, '合成用户材料');
  assert.match(invocation.instructions, /合成系统规则/);
  assert.doesNotMatch(invocation.instructions, /合成用户材料/);
  assert.equal(result.execution.ephemeral, true);
  assert.equal(result.execution.instructions, 'task-only');
  assert.match(result.output, /子进程结果已回填/);
  assert.deepEqual(result.execution.usage, { input_tokens: 120, cached_input_tokens: 30, output_tokens: 24 });
  assert.ok(result.execution.elapsedMs > 0);
  assert.equal(result.execution.toolCallCount, 1);
  assert.equal(result.execution.toolEvents.length, 2);
  assert.equal(result.execution.toolEvents[0].server, '模拟工具');
  assert.doesNotMatch(JSON.stringify(result.execution), /不应进入指标/);
  await assert.rejects(access(path.join(dir, 'result.txt')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(dir, 'task-instructions.md')), { code: 'ENOENT' });
  assert.equal(runner.snapshot().status, 'ready');
}));

test('子进程非零退出、缺失/空结果及坏JSON事件均明确失败并结束进程', () => isolated(async dir => {
  for (const [mode, code] of [['failure', 'RUNNER_EXIT'], ['missing-output', 'RUNNER_OUTPUT'], ['empty-output', 'RUNNER_OUTPUT'], ['malformed-events', 'RUNNER_PROTOCOL']]) {
    const runner = createCodexRunner(options(mode));
    await assert.rejects(runner.run(task, { directory: path.join(dir, mode) }), error => error.code === code && error.execution.elapsedMs > 0);
    const invocation = JSON.parse(await readFile(path.join(dir, mode, 'invocation.json'), 'utf8'));
    assert.throws(() => process.kill(invocation.pid, 0), { code: 'ESRCH' });
  }
}));

test('超时结束实际子进程；取消会同时结束其后代，随后仍可执行下一任务', () => isolated(async dir => {
  const timeoutDir = path.join(dir, 'timeout');
  const timeoutRunner = createCodexRunner(options('hang', { timeoutMs: 400 }));
  await assert.rejects(timeoutRunner.run(task, { directory: timeoutDir }), { code: 'RUNNER_TIMEOUT' });
  const timeoutInvocation = JSON.parse(await readFile(path.join(timeoutDir, 'invocation.json'), 'utf8'));
  assert.throws(() => process.kill(timeoutInvocation.pid, 0), { code: 'ESRCH' });

  const controller = new AbortController(), directory = path.join(dir, 'cancel');
  const runner = createCodexRunner(options('hang-tree'));
  const running = runner.run(task, { directory, signal: controller.signal });
  const rejection = assert.rejects(running, { code: 'RUNNER_CANCELLED' });
  const childPid = await waitFor(() => readFile(path.join(directory, 'descendant.pid'), 'utf8').catch(() => ''), Boolean);
  const invocation = JSON.parse(await readFile(path.join(directory, 'invocation.json'), 'utf8'));
  controller.abort('cancelled');
  await rejection;
  assert.throws(() => process.kill(invocation.pid, 0), { code: 'ESRCH' });
  await waitForExit(childPid);
  await runner.waitForIdle();
  const next = await createCodexRunner(options()).run({ ...task, id: 'next-task' }, { directory: path.join(dir, 'next') });
  assert.match(next.output, /子进程结果已回填/);
}));

test('网页任务经真实子进程自动回填，API公开执行指标而不公开输入', () => isolated(async dir => {
  const server = await startServer({ port: 0, agent: 'codex', runnerOptions: options() });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const runtime = await (await fetch(`${base}/api/runtime`)).json();
    assert.equal(runtime.mode, 'automatic'); assert.equal(runtime.executor.status, 'ready');
    const topic = await store.createTopic('进程集成测试', '仅处理合成材料');
    const queued = await (await fetch(`${base}/api/topics/${topic.id}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update', input: '这一输入不出现在状态接口' }) })).json();
    const done = await waitFor(() => store.getTask(queued.id), value => ['completed','failed'].includes(value.status));
    assert.equal(done.status,'completed',done.error);
    assert.equal(done.execution.usage.input_tokens, 120);
    assert.equal((await store.getView(topic.id)).graph.nodes[0].title, '子进程结果已回填');
    const status = await (await fetch(`${base}/api/tasks/${queued.id}/status`)).json();
    assert.equal(status.execution.toolCallCount, 1);
    assert.equal(status.input, undefined);
    assert.equal(status.status, 'completed');
  } finally { await server.shutdown(); }
}));

test('网页取消停止真实进程树且保留原账，同一服务随后自动执行下一任务', () => isolated(async dir => {
  const server = await startServer({ port: 0, agent: 'codex', runnerOptions: options('select-by-input') });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const topic = await store.createTopic('网页取消测试','仅处理合成材料');
    const original = await store.getTopic(topic.id);
    const queued = await store.createTask(topic.id,'update','等待网页取消');
    const directory = path.join(dir,'runs',queued.id);
    const childPid = await waitFor(() => readFile(path.join(directory,'descendant.pid'),'utf8').catch(()=>''),Boolean);
    const invocation = JSON.parse(await readFile(path.join(directory,'invocation.json'),'utf8'));
    const response = await fetch(`${base}/api/tasks/${queued.id}/cancel`, {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,200);
    assert.equal((await response.json()).status,'cancelled');
    const ended = await waitFor(() => store.getTask(queued.id),value=>Boolean(value.execution));
    assert.equal(ended.status,'cancelled');
    assert.equal(ended.execution.errorCode,'RUNNER_CANCELLED');
    await waitForExit(invocation.pid); await waitForExit(childPid);
    assert.deepEqual(await store.getTopic(topic.id),original);
    const next = await store.createTask(topic.id,'update','RUN_NEXT_SUCCESS');
    const done = await waitFor(() => store.getTask(next.id),value=>['completed','failed'].includes(value.status));
    assert.equal(done.status,'completed',done.error);
    assert.equal((await store.getView(topic.id)).graph.nodes[0].title,'子进程结果已回填');
  } finally { await server.shutdown(); }
}));

test('子进程结果格式错误显示failed且保持原账；关闭服务会终止实际子进程', () => isolated(async dir => {
  let server = await startServer({ port: 0, agent: 'codex', runnerOptions: options('invalid-output') });
  const topic = await store.createTopic('结果校验测试', '仅处理合成材料');
  const before = await store.getTopic(topic.id);
  try {
    const queued = await store.createTask(topic.id, 'update', '无效输出不能写入');
    const failed = await waitFor(() => store.getTask(queued.id), value => value.status === 'failed');
    assert.match(failed.error, /可用图文/);
    assert.equal(failed.execution.usage.output_tokens, 24);
    assert.deepEqual(await store.getTopic(topic.id), before);
  } finally { await server.shutdown(); }
  server = await startServer({ port: 0, agent: 'codex', runnerOptions: options('hang-tree') });
  try {
    const queued = await store.createTask(topic.id, 'update', '服务停止应结束进程');
    const directory = path.join(dir, 'runs', queued.id);
    const childPid = await waitFor(() => readFile(path.join(directory, 'descendant.pid'), 'utf8').catch(() => ''), Boolean);
    const invocation = JSON.parse(await readFile(path.join(directory, 'invocation.json'), 'utf8'));
    await server.shutdown();
    const ended = await waitFor(() => store.getTask(queued.id), value => value.status === 'failed' && value.execution);
    assert.equal(ended.execution.errorCode, 'RUNNER_SHUTDOWN');
    assert.throws(() => process.kill(invocation.pid, 0), { code: 'ESRCH' });
    await waitForExit(childPid);
    assert.deepEqual(await store.getTopic(topic.id), before);
  } finally { await server.shutdown(); }
}));
