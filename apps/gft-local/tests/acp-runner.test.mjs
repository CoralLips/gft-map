import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpRunner } from '../acpRunner.mjs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const options = (mode = 'success', extra = {}) => ({ binary: process.execPath, prefixArgs: [fixture, `--fixture-mode=${mode}`, `--fixture-adapter=${extra.adapter || 'codex'}`], ...extra });
const task = { id: 'synthetic-acp-task', system: '合成系统规则', user: '合成用户材料' };
const invocation = async dir => JSON.parse(await readFile(path.join(dir, 'acp-invocation.json'), 'utf8'));
async function isolated(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gft-acp-runner-'));
  try { await run(dir); }
  finally {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(dir).startsWith('gft-acp-runner-'));
    await rm(dir, { recursive: true, force: true });
  }
}
async function waitFor(read, accept = Boolean) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('等待假 ACP 进程超时');
}
const waitForExit = pid => waitFor(() => {
  try { process.kill(Number(pid), 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
});

test('Windows 预检临时目录被占用不阻止成功启动，也不覆盖真正的握手错误', async t => {
  const remove=fsPromises.rm, leftovers=[];
  const mocked=t.mock.method(fsPromises,'rm',async(directory,options)=>{
    if(path.basename(String(directory)).startsWith('gft-acp-check-')) {
      assert.ok(options.maxRetries > 0);
      leftovers.push(directory);
      throw Object.assign(new Error('synthetic locked check directory'),{code:'EBUSY'});
    }
    return remove(directory,options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await createAcpRunner(options()).check()).status,'ready');
    await assert.rejects(createAcpRunner(options('bad-version')).check(),{code:'RUNNER_PROTOCOL'});
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports();
    for(const directory of leftovers) {
      const relative=path.relative(path.resolve(tmpdir()),path.resolve(directory));
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('gft-acp-check-'));
      await remove(directory,{recursive:true,force:true,maxRetries:6,retryDelay:150});
    }
  }
});

test('ACP预检真实stdio握手，不声称认证已完成；命令/协议错误明确失败', () => isolated(async () => {
  const runner = createAcpRunner(options());
  const status = await runner.check();
  assert.equal(status.status, 'ready'); assert.equal(status.version, 'fixture-1.0');
  assert.equal(status.checkScope, 'session-and-model'); assert.equal(status.authenticated, null);
  assert.equal(status.model, 'fixture-default');
  await assert.rejects(createAcpRunner(options('auth-failure')).check(), {code:'RUNNER_AUTH'});
  await assert.rejects(createAcpRunner(options('success',{model:'not-available'})).check(), {code:'RUNNER_MODEL'});
  assert.deepEqual(status.authMethods, ['fixture-login']);
  await assert.rejects(createAcpRunner(options('bad-version')).check(), { code: 'RUNNER_PROTOCOL' });
  await assert.rejects(createAcpRunner({ binary: path.join(tmpdir(), 'nonexistent-gft-acp') }).check(), { code: 'RUNNER_START' });
  assert.throws(() => createAcpRunner({ binary: 'adapter.cmd' }), { code: 'RUNNER_CONFIG' });
  assert.throws(() => createAcpRunner({ prefixArgs: 'not-an-array' }), { code: 'RUNNER_CONFIG' });
}));

test('ACP初始化/新会话/配置/流式文本与用量来自实际进程，未知字段不杜撰为0', () => isolated(async directory => {
  const runner = createAcpRunner(options('success', { model: 'fixture-model' }));
  const chunks = [];
  const result = await runner.run(task, { directory, onText: chunk => chunks.push(chunk) });
  const input = await invocation(directory);
  assert.deepEqual(input.requests.map(request => request.method), ['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt']);
  assert.deepEqual(input.requests[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.equal(input.requests[1].params.cwd, directory); assert.deepEqual(input.requests[1].params.mcpServers, []);
  assert.equal(input.requests[2].params.value, 'read-only'); assert.equal(input.requests[3].params.value, 'fixture-model');
  assert.match(input.requests[4].params.prompt[0].text, /合成系统规则[\s\S]*合成用户材料/);
  assert.equal(input.initialMode, 'read-only'); assert.equal(input.codexConfig.features.plugins, false);
  assert.equal(input.codexConfig.skills.include_instructions, false);
  assert.equal(input.codexConfig.features.hooks, false); assert.deepEqual(input.codexConfig.notify, []);
  assert.equal(result.output, chunks.join('')); assert.equal(chunks.length, 2);
  assert.match(result.output, /ACP 合成结果已回填/); assert.doesNotMatch(result.output, /外国|思考/);
  assert.deepEqual(result.execution.usage, { input_tokens: 100, output_tokens: 25, cached_input_tokens: 20, total_tokens: 145 });
  assert.equal(result.execution.usageSource, 'acp-prompt-response');
  assert.equal(result.execution.usage.cache_write_tokens, undefined);
  assert.deepEqual(result.execution.contextUsage, { used: 70, size: 200000 });
  assert.equal(result.execution.model, 'fixture-model'); assert.equal(result.execution.mode, 'read-only');
  assert.ok(result.execution.elapsedMs > 0); assert.equal(result.execution.toolCallCount, 0);
  await waitForExit(input.pid);
  const second = await createAcpRunner(options('unknown-usage')).run(task, { directory: path.join(directory, 'unknown') });
  assert.equal(second.execution.usage, null); assert.equal(second.execution.usageSource, null);
  assert.equal(second.execution.contextUsage.used, 70);
}));

test('Claude使用明确adapter扩展禁工具/设置来源并选plan，不继承旧会话', () => isolated(async directory => {
  const result = await createAcpRunner(options('success', { adapter: 'claude', model: 'fixture-model' })).run(task, { directory });
  const input = await invocation(directory), session = input.requests.find(request => request.method === 'session/new').params;
  assert.deepEqual(session._meta.claudeCode.options, { allowDangerouslySkipPermissions: false, tools: [], settingSources: [], mcpServers: {} });
  assert.equal(session._meta.systemPrompt, task.system);
  assert.equal(result.execution.mode, 'plan'); assert.equal(result.execution.engine, 'claude-acp');
  assert.ok(input.requests.every(request => !/load|resume/.test(request.method)));
  const prompt = input.requests.find(request => request.method === 'session/prompt').params.prompt[0].text;
  assert.match(prompt, /合成用户材料/); assert.doesNotMatch(prompt, /合成系统规则/);
}));

test('权限请求明确拒绝且不提供文件/终端能力，工具指标不包含内容', () => isolated(async directory => {
  const result = await createAcpRunner(options('permissions')).run(task, { directory });
  const input = await invocation(directory);
  assert.deepEqual(input.permission, { outcome: { outcome: 'selected', optionId: 'reject' } });
  assert.equal(input.fileRequest.error.code, -32601); assert.equal(input.terminalRequest.error.code, -32601);
  await assert.rejects(access(path.join(directory, 'must-not-exist.txt')), { code: 'ENOENT' });
  assert.equal(result.execution.permissionDeniedCount, 1); assert.equal(result.execution.toolCallCount, 1);
  assert.equal(result.execution.toolEvents.length, 2);
  assert.doesNotMatch(JSON.stringify(result.execution), /不应进入指标|rawInput|rawOutput/);
}));

test('不支持模式/模型时不发送任务；认证与非完整结果明确失败', () => isolated(async dir => {
  for (const [mode, code, extra] of [
    ['no-safe-mode', 'RUNNER_MODE'], ['no-model', 'RUNNER_MODEL', { model: 'fixture-model' }],
    ['success', 'RUNNER_MODEL', { model: 'missing-model' }], ['auth-failure', 'RUNNER_AUTH'], ['auth-expired', 'RUNNER_AUTH'],
    ['empty-output', 'RUNNER_OUTPUT'], ['max-tokens', 'RUNNER_INCOMPLETE'], ['refusal', 'RUNNER_INCOMPLETE'],
    ['failure', 'RUNNER_EXIT'],
    ['error-response', 'RUNNER_PROTOCOL'], ['bad-response', 'RUNNER_PROTOCOL'], ['huge-output', 'RUNNER_OUTPUT'],
  ]) {
    const directory = path.join(dir, `${mode}-${code}`);
    await assert.rejects(createAcpRunner(options(mode, extra)).run(task, { directory }), error => error.code === code && error.execution.elapsedMs > 0);
    const input = await invocation(directory);
    if (['RUNNER_MODE', 'RUNNER_MODEL', 'RUNNER_AUTH'].includes(code)) assert.ok(input.requests.every(request => request.method !== 'session/prompt'));
    await waitForExit(input.pid);
  }
  const legacy = await createAcpRunner(options('legacy-mode')).run(task, { directory: path.join(dir, 'legacy') });
  assert.equal(legacy.execution.mode, 'read-only');
}));

test('ACP取消发送协议通知并结束实际进程树，busy及waitForIdle保持正确', () => isolated(async directory => {
  const runner = createAcpRunner(options('hang-tree'));
  const controller = new AbortController();
  const running = runner.run(task, { directory, signal: controller.signal });
  const rejected = assert.rejects(running, { code: 'RUNNER_CANCELLED' });
  const descendant = await waitFor(() => readFile(path.join(directory, 'descendant.pid'), 'utf8').catch(() => ''));
  assert.equal(runner.snapshot().status, 'running');
  await assert.rejects(runner.run(task, { directory }), { code: 'RUNNER_BUSY' });
  controller.abort('cancelled');
  await rejected; await runner.waitForIdle();
  const input = await invocation(directory);
  assert.equal(input.cancelled, true);
  assert.equal(input.requests.filter(request => request.method === 'session/cancel').length, 1);
  await waitForExit(input.pid); await waitForExit(descendant);
}));

test('初始化/模型超时及服务关闭均清理进程，并保留明确终止原因', () => isolated(async dir => {
  await assert.rejects(createAcpRunner(options('hang-initialize', { checkTimeoutMs: 250 })).check(), { code: 'RUNNER_CHECK' });
  const timeoutDir = path.join(dir, 'timeout');
  await assert.rejects(createAcpRunner(options('hang', { timeoutMs: 350 })).run(task, { directory: timeoutDir }), { code: 'RUNNER_TIMEOUT' });
  const input = await invocation(timeoutDir); await waitForExit(input.pid); assert.equal(input.cancelled, true);
  const controller = new AbortController(), directory = path.join(dir, 'shutdown');
  const runner = createAcpRunner(options('cooperative-cancel'));
  const running = runner.run(task, { directory, signal: controller.signal });
  const rejected = assert.rejects(running, { code: 'RUNNER_SHUTDOWN' });
  await waitFor(() => invocation(directory).catch(() => null), input => input?.requests.some(request => request.method === 'session/prompt'));
  controller.abort('shutdown'); await rejected; await runner.waitForIdle();
  await waitForExit((await invocation(directory)).pid);
  const next = await createAcpRunner(options()).run(task, { directory: path.join(dir, 'next') });
  assert.match(next.output, /ACP 合成结果/);
}));
