// A real child process with the Claude Code CLI's print-mode contract; never calls a model.
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const mode = args.find(arg => arg.startsWith('--fixture-mode='))?.split('=')[1] || 'success';
const print = value => process.stdout.write(JSON.stringify(value));

if (args.includes('--version')) {
  console.log('2.1.0 (Claude Code fixture)');
  process.exit(0);
}
if (args.includes('auth')) {
  print({
    loggedIn: mode !== 'logged-out',
    authMethod: mode === 'logged-out' ? 'none' : 'claude.ai',
  });
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const instructionsFile = args[args.indexOf('--system-prompt-file') + 1];
await writeFile(
  'invocation.json',
  JSON.stringify({
    args,
    input,
    instructions: await readFile(instructionsFile, 'utf8'),
    parentSession: process.env.CLAUDECODE ?? null,
    pid: process.pid,
  }),
  'utf8',
);

const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [] };
const result = fields => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  stop_reason: 'end_turn',
  total_cost_usd: 0.0123,
  usage: { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5 },
  modelUsage: { 'claude-helper': { outputTokens: 3 }, 'claude-fixture': { outputTokens: 34 } },
  permission_denials: [],
  ...fields,
});

if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'garbage') process.stdout.write('not json');
else if (mode === 'auth-expired') {
  print([
    init,
    result({ is_error: true, result: 'Failed to authenticate: OAuth session expired' }),
  ]);
  process.exitCode = 1;
} else if (mode === 'model-error') {
  print([init, result({ is_error: true, result: 'Overloaded' })]);
  process.exitCode = 1;
} else print([init, { type: 'assistant' }, result({ result: `已处理：${input}` })]);
