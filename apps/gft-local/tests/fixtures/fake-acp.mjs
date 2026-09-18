// Real stdio JSON-RPC peer; deliberately independent of the SDK under test.
// Synthetic data only. This executable never contacts a model or network.
import { createInterface } from 'node:readline';
import { writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = args.find(arg => arg.startsWith('--fixture-mode='))?.split('=')[1] || 'success';
const adapter = args.find(arg => arg.startsWith('--fixture-adapter='))?.split('=')[1] || 'codex';
const sessionId = `fixture-session-${process.pid}`;
const safeMode = adapter === 'claude' ? 'plan' : 'read-only';
const invocation = { pid: process.pid, args, requests: [], codexConfig: process.env.CODEX_CONFIG ? JSON.parse(process.env.CODEX_CONFIG) : null, initialMode: process.env.INITIAL_AGENT_MODE || null };
const persist = () => writeFileSync(path.join(process.cwd(), 'acp-invocation.json'), JSON.stringify(invocation));
persist();
let selectedMode = 'agent', selectedModel = 'fixture-default', promptId;
const pending = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const request = (method, params) => new Promise(resolve => {
  const id = `peer-${pending.size}-${Date.now()}-${Math.random()}`;
  pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params });
});
const config = () => [
  ...(mode === 'legacy-mode' ? [] : [{ id: 'session-mode', name: 'Mode', category: 'mode', type: 'select', currentValue: selectedMode, options: (mode === 'no-safe-mode' ? ['agent'] : ['agent', safeMode]).map(value => ({ value, name: value })) }]),
  ...(mode === 'no-model' ? [] : [{ id: 'chosen-model', name: 'Model', category: 'model', type: 'select', currentValue: selectedModel, options: [{ group: 'Available', name: 'Available', options: ['fixture-default', 'fixture-model'].map(value => ({ value, name: value })) }] }]),
];
const usage = { inputTokens: 100, outputTokens: 25, cachedReadTokens: 20, totalTokens: 145 };

async function handle(message) {
  if (!message.method) {
    pending.get(message.id)?.(message.result ?? { error: message.error });
    pending.delete(message.id); return;
  }
  invocation.requests.push({ method: message.method, params: message.params }); persist();
  appendFileSync(path.join(process.cwd(), 'acp-events.jsonl'), JSON.stringify({ method: message.method }) + '\n');
  const { method, id, params } = message;
  if (method === 'initialize') {
    if (mode === 'hang-initialize') return;
    result(id, { protocolVersion: mode === 'bad-version' ? 999 : params.protocolVersion, agentInfo: { name: `fixture-${adapter}`, version: 'fixture-1.0' }, agentCapabilities: {}, authMethods: [{ id: 'fixture-login', name: 'Fixture login', description: 'Synthetic' }] });
  } else if (method === 'session/new') {
    if (mode === 'auth-failure') { failure(id, -32000, 'Authentication required'); return; }
    if (mode === 'auth-expired') { failure(id, -32603, 'Internal error: Failed to authenticate: OAuth session expired and could not be refreshed'); return; }
    result(id, { sessionId, configOptions: config(), ...(mode === 'legacy-mode' ? { modes: { currentModeId: selectedMode, availableModes: [{ id: safeMode, name: safeMode }] } } : {}) });
  } else if (method === 'session/set_config_option') {
    if (mode === 'config-failure') { failure(id, -32602, 'Synthetic model/mode configuration error'); return; }
    if (params.configId === 'session-mode') selectedMode = params.value;
    if (params.configId === 'chosen-model') selectedModel = params.value;
    result(id, { configOptions: config() });
  } else if (method === 'session/set_mode') {
    selectedMode = params.modeId; result(id, {});
  } else if (method === 'session/cancel') {
    invocation.cancelled = true; persist();
    if (mode === 'cooperative-cancel' && promptId !== undefined) result(promptId, { stopReason: 'cancelled' });
  } else if (method === 'session/prompt') {
    promptId = id;
    if (mode === 'failure') { process.stderr.write('合成适配器退出错误'); process.exit(7); }
    if (mode === 'error-response') { failure(id, -32603, '合成模型错误'); return; }
    if (mode === 'bad-response') { result(id, { stopReason: 12 }); return; }
    if (mode === 'hang-tree') {
      const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
      writeFileSync(path.join(process.cwd(), 'descendant.pid'), String(descendant.pid));
    }
    if (['hang', 'hang-tree', 'cooperative-cancel'].includes(mode)) return;
    if (mode === 'huge-output') { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(2 * 1024 * 1024 + 1) } }); return; }
    if (mode === 'permissions') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: '不应进入指标的私人内容', kind: 'edit', status: 'pending', rawInput: { secret: '不应进入指标' } });
      invocation.permission = await request('session/request_permission', { sessionId, toolCall: { toolCallId: 'tool-1', title: '合成权限请求', kind: 'edit' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
      invocation.fileRequest = await request('fs/write_text_file', { sessionId, path: path.join(process.cwd(), 'must-not-exist.txt'), content: 'forbidden' });
      invocation.terminalRequest = await request('terminal/create', { sessionId, command: process.execPath, args: ['-e', 'process.exit(0)'] });
      persist();
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed', rawOutput: '不应进入指标' });
    }
    // A foreign session and thoughts must never contaminate the result text.
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'another-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '外国会话内容' } } } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '不应进入结果的思考' } });
    if (mode !== 'empty-output') {
      const text = '<doc>\n## ACP 回放\n### ◇ ACP 合成结果已回填\n没有调用真实模型。\n</doc>';
      const first = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, 34) } } } }) + '\n';
      const bytes = Buffer.from(first), split = bytes.indexOf(Buffer.from('回放')) + 1;
      process.stdout.write(bytes.subarray(0, split));
      await new Promise(resolve => setTimeout(resolve, 10));
      process.stdout.write(bytes.subarray(split));
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(34) } });
    }
    update({ sessionUpdate: 'usage_update', used: 70, size: 200000, cost: { amount: 0.002, currency: 'USD' } });
    result(id, { stopReason: mode === 'max-tokens' ? 'max_tokens' : mode === 'refusal' ? 'refusal' : 'end_turn', ...(mode === 'unknown-usage' ? {} : { usage }) });
  } else if (id !== undefined) failure(id, -32601, 'Unknown fixture method');
}

createInterface({ input: process.stdin }).on('line', line => {
  try { void handle(JSON.parse(line)).catch(error => { process.stderr.write(error.message); process.exitCode = 2; }); }
  catch { process.exitCode = 2; }
});
// ACP peers stay available after a completed prompt; the runner owns cleanup.
setInterval(() => {}, 1000);
