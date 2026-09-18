// A real child process with the CLI's transport contract; never calls a model.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const args = process.argv.slice(2);
let mode = args.find(arg => arg.startsWith('--fixture-mode='))?.split('=')[1] || 'success';
const event = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (args.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
if (args.includes('--help')) { console.log('--ignore-user-config --ignore-rules --strict-config --ephemeral --json --output-last-message'); process.exit(0); }
if (args.includes('login')) {
  console.error(mode === 'auth-failure' ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(mode === 'auth-failure' ? 1 : 0);
}
const outputFile = args[args.indexOf('-o') + 1];
const dir = path.dirname(outputFile);
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (mode === 'select-by-input') mode = input.includes('RUN_NEXT_SUCCESS') ? 'success' : 'hang-tree';
const instructionsArg = args.find(value => value.startsWith('model_instructions_file='));
const instructions = instructionsArg ? await readFile(JSON.parse(instructionsArg.slice('model_instructions_file='.length)), 'utf8') : '';
await writeFile(path.join(dir, 'invocation.json'), JSON.stringify({ args, input, instructions, pid: process.pid }), 'utf8');
if (mode === 'failure') { event({ type: 'turn.failed', error: { message: '合成执行错误' } }); process.exit(7); }
if (mode === 'malformed-events') { console.log('not-json'); setInterval(() => {}, 1000); }
else if (mode === 'hang' || mode === 'hang-tree') {
  event({ type: 'thread.started', thread_id: 'fixture-hanging' });
  if (mode === 'hang-tree') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
    await writeFile(path.join(dir, 'descendant.pid'), String(child.pid));
  }
  setInterval(() => {}, 1000);
} else {
  event({ type: 'thread.started', thread_id: 'fixture-thread' });
  event({ type: 'turn.started' });
  // Deliberately split a UTF-8 JSON line across writes to exercise streaming.
  const line = Buffer.from(JSON.stringify({ type: 'item.started', item: { id: 'fixture-tool', type: 'mcp_tool_call', server: '模拟工具', tool: 'inspect', arguments: { private: '不应进入指标' } } }) + '\n');
  const split = line.indexOf(Buffer.from('模拟')) + 1;
  process.stdout.write(line.subarray(0, split));
  await new Promise(resolve => setTimeout(resolve, 10));
  process.stdout.write(line.subarray(split));
  event({ type: 'item.completed', item: { id: 'fixture-tool', type: 'mcp_tool_call', server: '模拟工具', tool: 'inspect', status: 'completed', result: '不应进入指标' } });
  event({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 30, output_tokens: 24 } });
  if (mode !== 'missing-output') {
    const output = mode === 'empty-output' ? '' : mode === 'invalid-output' ? '没有协议内容' : '<doc>\n## 真实进程回放\n### ◇ 子进程结果已回填\n这是合成材料，没有调用真实模型。\n</doc>';
    await writeFile(outputFile, output, 'utf8');
  }
}
