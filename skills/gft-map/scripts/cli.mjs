#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import * as store from './store.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, createRunner } from './server.mjs';
const [command, ...args] = process.argv.slice(2);
const values = key => args.flatMap((s,i)=>s===`--${key}` ? [args[i+1]] : []);
const arg = key => values(key).at(-1);
const need = key => { const v=arg(key); if(!v || v.startsWith('--')) throw store.fail(`缺少 --${key}`); return v; };
const print = data => console.log(JSON.stringify(data,null,2));
function runnerOptions(agent) {
  const timeoutMs = arg('timeout-seconds') ? Number(arg('timeout-seconds')) * 1000 : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw store.fail('执行超时必须是正数');
  if (!agent?.endsWith('-acp')) return { ...(arg('model') ? { model: arg('model') } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  const prefix = agent === 'claude-acp' ? 'GFT_CLAUDE_ACP' : 'GFT_CODEX_ACP';
  const binary = arg('acp-bin') || process.env[`${prefix}_BIN`];
  if (args.includes('--acp-bin') && !arg('acp-bin')) throw store.fail('缺少 --acp-bin');
  if (binary && !path.isAbsolute(binary)) throw store.fail('ACP binary 必须是可执行文件的绝对路径');
  let prefixArgs = values('acp-arg');
  if (!prefixArgs.length && process.env[`${prefix}_ARGS`]) {
    try { prefixArgs = JSON.parse(process.env[`${prefix}_ARGS`]); }
    catch { throw store.fail(`${prefix}_ARGS 必须是 JSON 字符串数组`); }
  }
  if (!Array.isArray(prefixArgs) || !prefixArgs.every(value => typeof value === 'string' && !value.includes('\0'))) throw store.fail('ACP 参数必须是字符串数组');
  return { ...(binary ? { binary } : {}), ...(prefixArgs.length ? { prefixArgs } : {}), ...(arg('model') ? { model: arg('model') } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
}
try {
  if(command === 'install-hooks') {
    const {installChangeHook} = await import('./install-hooks.mjs');
    print(await installChangeHook({provider:need('provider'),project:need('project')}));
  } else if(command === 'mcp') {
    const { startMcp } = await import('./dist/mcp.mjs');
    await startMcp();
  } else if(command === 'mcp-config') {
    print({ mcpServers: { 'gft-local': { command: process.execPath, args: [fileURLToPath(import.meta.url), 'mcp'], env: { GFT_LOCAL_URL: process.env.GFT_LOCAL_URL || 'http://127.0.0.1:4317' } } } });
  } else if(['chat-sessions','connections','connect','disconnect','read-connected','sources-connected','update-connected'].includes(command)) {
    const { createLocalClient } = await import('./dist/mcp.mjs');
    const request = createLocalClient();
    const provider = arg('provider');
    const sessionId = arg('session') || (provider === 'codex' ? process.env.CODEX_THREAD_ID : undefined);
    if (!['codex','claude'].includes(provider)) throw store.fail('请指定 --provider codex 或 claude');
    if(command !== 'chat-sessions' && !sessionId) throw store.fail('无法取得本场真实会话编号；请通过页面选择会话，不能生成替代编号');
    const query = new URLSearchParams({provider,...(sessionId ? {sessionId}:{}),...(arg('query') ? {query:arg('query')}:{}),...(arg('cursor') ? {cursor:arg('cursor')}:{})});
    if(command === 'chat-sessions') print(await request(`/api/chat-sessions?${query}`));
    else if(command === 'connections') print(await request(`/api/connections?${query}`));
    else if(command === 'read-connected' || command === 'sources-connected') print(await request(command === 'read-connected' ? '/api/connections/read' : '/api/connections/sources',
      {provider,sessionId,topicId:need('project'),...(values('node').length ? {nodeIds:values('node')} : {}),...(arg('cursor') ? {cursor:arg('cursor')} : {})}));
    else if(command === 'connect') {
      if (!args.includes('--confirmed')) throw store.fail('先通过宿主原生选项让用户确认主题和历史范围，确认后传 --confirmed；也可使用 gft_local_connect 原生表单');
      const history = need('history');
      if (!['now','all'].includes(history) || !values('project').length) throw store.fail('请明确主题以及 --history now|all');
      print(await request('/api/connections/connect',{source:{provider,id:sessionId,...(arg('cwd') ? {cwd:arg('cwd')}: {})},topicIds:values('project'),history}));
    } else if(command === 'disconnect') {
      if (!args.includes('--confirmed')) throw store.fail('请先确认要断开的主题，再传 --confirmed');
      if (!values('project').length && !args.includes('--all')) throw store.fail('请指定 --project，或 --all 断开本场全部主题');
      print(await request('/api/connections/disconnect',{provider,sessionId,...(values('project').length ? {topicIds:values('project')}: {})}));
    } else {
      const topicId=need('project');
      const connections=await request(`/api/connections?${query}`);
      const connection=connections.find(item=>item.topicId===topicId);
      if(!connection) throw store.fail('该主题尚未连接到本场对话');
      print(await request(`/api/topics/${encodeURIComponent(topicId)}/update-from-chat`,{connectionId:connection.id}));
    }
  } else if(command === 'serve') {
    const port = arg('port') ? Number(arg('port')) : 4317;
    if(!Number.isInteger(port) || port < 1 || port > 65535) throw store.fail('端口无效');
    const agent = arg('agent') || null;
    const server = await startServer({port,agent,runnerOptions:runnerOptions(agent)});
    console.log(`GFT Map: http://127.0.0.1:${server.address().port}\n数据目录: ${store.homeDir()}\n执行器: ${arg('agent') || '当前 Agent 经 Skill 处理待办'}\n按 Ctrl+C 停止。`);
    if (agent) print(server.runtime());
    else console.log('如需网页自动执行，选择 codex、codex-acp 或 claude-acp 后用 serve --agent 启动；可先用 doctor --agent 检查。');
    for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{void server.shutdown().then(()=>process.exit(0),()=>process.exit(1));});
  } else if(command === 'list' && args.includes('--remote')) {
    const {createLocalClient}=await import('./dist/mcp.mjs');
    print(await createLocalClient()('/api/topics'));
  } else if(command === 'list') print(await store.listTopics());
  else if(command === 'doctor') { const agent = arg('agent') || 'codex'; print(await (await createRunner(agent,runnerOptions(agent))).check()); }
  else if(command === 'recover') print(await store.recover());
  else if(command === 'create') print(await store.createTopic(need('name'),arg('scope') || ''));
  else if(command === 'link') print(await store.linkSession(need('session'),values('project'),arg('write')));
  else if(command === 'read') print(await store.readContext(arg('session'),arg('project')));
  else if(command === 'history') print(await store.history(need('project')));
  else if(command === 'tasks') print(await store.listTasks());
  else if(command === 'task-status') {
    const id=need('id');
    if(args.includes('--remote')) {
      const {createLocalClient}=await import('./dist/mcp.mjs');
      print(await createLocalClient()(`/api/tasks/${encodeURIComponent(id)}/status`));
    } else print(await store.getTaskStatus(id));
  }
  else if(command === 'task') {
    const task = arg('id') ? {id:arg('id')} : await store.createTask(need('project'),need('action'),arg('input') ? await readFile(arg('input'),'utf8') : '');
    print(await store.taskPrompt(task.id));
  } else if(command === 'complete') print(await store.completeTask(need('id'),await readFile(need('file'),'utf8')));
  else if(command === 'cancel') print(await store.setTaskStatus(need('id'),'cancelled'));
  else if(command === 'export') {await writeFile(need('file'),JSON.stringify(await store.exportTopic(need('project')),null,2),'utf8');print({saved:arg('file')});}
  else if(command === 'import') print(await store.importTopic(JSON.parse(await readFile(need('file'),'utf8'))));
  else {console.log('连接入口: mcp | mcp-config | install-hooks --provider codex|claude --project 工作目录 | chat-sessions --provider codex|claude [--query TEXT] | connections --provider PROVIDER --session ID | connect --provider PROVIDER --session ID --project TOPIC [--project TOPIC] --history now|all --confirmed | read-connected --provider PROVIDER --session ID --project TOPIC [--node ID] | sources-connected --provider PROVIDER --session ID --project TOPIC [--cursor CURSOR] | update-connected --provider PROVIDER --session ID --project TOPIC | disconnect --provider PROVIDER --session ID (--project TOPIC | --all) --confirmed | task-status --id ID --remote\nGFT Map: list | create --name NAME --scope TEXT | link --session ID --project ID [--project ID] [--write ID] | read --session ID | task --project ID --action update|tidy|redraw [--input FILE] | tasks | task --id ID | task-status --id ID | complete --id ID --file FILE | cancel --id ID | history --project ID | export --project ID --file FILE | import --file FILE | recover | doctor [--agent codex|codex-acp|claude-acp] [--model MODEL] | serve [--port 4317] [--agent codex|codex-acp|claude-acp] [--model MODEL] [--timeout-seconds 900]\nACP: --acp-bin ABSOLUTE_EXECUTABLE [--acp-arg ARG ...]，或 GFT_CODEX_ACP_BIN/GFT_CLAUDE_ACP_BIN 与对应 _ARGS JSON数组。旧Codex入口继续使用 GFT_CODEX_BIN。默认手工处理任务，只有 --agent 才启用自动执行。'); if(command && command !== 'help') process.exitCode=1;}
} catch(e) {console.error(JSON.stringify({error:e.message,status:e.status || 500}));process.exitCode=1;}
