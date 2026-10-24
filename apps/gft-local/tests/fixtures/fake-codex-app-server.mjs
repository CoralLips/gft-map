// A stand-in for `codex app-server --listen stdio://`: real stdio JSON-RPC lines,
// synthetic data only. It never contacts a model or the network.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--fixture-${name}=`))?.split('=')[1];
const mode = option('mode') || 'success';
// Where to record what the runner sent: one file per process, only when a test asks.
const record = option('record');
const threadId = `fixture-thread-${process.pid}`;
const turnId = `fixture-turn-${process.pid}`;
const invocation = { pid: process.pid, cwd: process.cwd(), args, requests: [], notifications: [] };
const persist = () =>
  record &&
  writeFileSync(path.join(record, `app-server-${process.pid}.json`), JSON.stringify(invocation));
persist();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => send({ id, result: value });
const notify = (method, params) => send({ method, params });
const models = [
  [
    {
      model: 'fixture-default',
      displayName: 'Fixture Default',
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: 'medium',
    },
    { model: 'fixture-hidden', displayName: 'Hidden', isDefault: false, hidden: true },
  ],
  [
    {
      model: 'fixture-model',
      displayName: 'Fixture Model',
      description: 'A second model',
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: 'high',
    },
  ],
];
const answer =
  '<doc>\n## Codex 回放\n### ◇ Codex 合成结果已回填\n没有调用真实模型。\n</doc>\n<prose domain="Codex 回放" refs="d1">Codex 合成结果已回填，本次只验证协议回放，没有调用真实模型。</prose>';

function finishTurn(status, extra = {}) {
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, status, error: null, items: [], ...extra },
  });
}

async function startTurn() {
  if (mode === 'exit') {
    process.stderr.write('合成 Codex 退出错误');
    process.exit(7);
  }
  if (mode === 'hang-tree') {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    invocation.descendant = descendant.pid;
    persist();
    return;
  }
  if (mode === 'approval') {
    send({ id: 'peer-1', method: 'item/commandExecution/requestApproval', params: { threadId } });
    await new Promise(resolve => (invocation.awaitApproval = resolve));
  }
  if (mode === 'failed' || mode === 'logged-out') {
    const message = mode === 'failed' ? '合成模型错误' : 'Not logged in. Please run codex login.';
    notify('error', { threadId, turnId, willRetry: true, error: { message: '重试中' } });
    notify('error', { threadId, turnId, willRetry: false, error: { message } });
    finishTurn('failed', { error: { message } });
    return;
  }
  // Another thread's text and reasoning must never reach the result.
  notify('item/agentMessage/delta', { threadId: 'another', turnId, itemId: 'x', delta: '外线' });
  notify('item/reasoning/textDelta', { threadId, turnId, itemId: 'r', delta: '不应进入结果' });
  for (const delta of [answer.slice(0, 30), answer.slice(30)])
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm', delta });
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      total: {
        totalTokens: 145,
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 25,
        reasoningOutputTokens: 5,
      },
      last: {},
      modelContextWindow: 200000,
    },
  });
  finishTurn('completed', {
    items: [
      { type: 'agentMessage', id: 'c', phase: 'commentary', text: '先说明一下' },
      { type: 'agentMessage', id: 'm', phase: 'final_answer', text: answer },
    ],
  });
}

createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params, error } = JSON.parse(line);
  if (!method) {
    invocation.approvalResponse = error ?? null;
    persist();
    invocation.awaitApproval?.();
    return;
  }
  (id === undefined ? invocation.notifications : invocation.requests).push({ method, params });
  persist();
  if (method === 'initialize') {
    if (mode === 'hang-initialize') return;
    result(id, { userAgent: 'codex_fixture/fixture-1.0 (synthetic)', codexHome: process.cwd() });
  } else if (method === 'model/list') {
    const page = params.cursor === 'page-2' ? 1 : 0;
    result(id, { data: models[page], nextCursor: page ? null : 'page-2' });
  } else if (method === 'thread/start') {
    result(id, { thread: { id: threadId, ephemeral: params.ephemeral, path: null } });
  } else if (method === 'turn/start') {
    result(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
    void startTurn();
  } else if (method === 'turn/interrupt') {
    invocation.interrupted = true;
    persist();
    result(id, {});
    finishTurn('interrupted');
  } else if (id !== undefined) send({ id, error: { code: -32601, message: 'Unknown method' } });
});
// Like the real app-server, it keeps serving after a turn; the runner owns cleanup.
setInterval(() => {}, 1000);
