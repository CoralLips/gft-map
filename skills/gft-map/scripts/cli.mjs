#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as store from './store.mjs';
import { startServer, createRunner } from './server.mjs';
import {
  acpArguments,
  acpBinary,
  loadExecutorConfig,
  saveExecutorConfig,
  defaultExecutor,
} from './executor-config.mjs';

const SERVICE_URL = process.env.GFT_LOCAL_URL || 'http://127.0.0.1:4317';
const UPLOAD_BLOCK_BYTES = 512 * 1024;
const AGENT_CHOICES = 'codex|claude|codex-acp|claude-acp';
const USAGE = [
  [
    '打开与关闭',
    [
      'open [--no-browser]',
      'start',
      'status',
      'stop',
      `restart [--port 4317] [--agent ${AGENT_CHOICES}] [--manual]`,
    ],
  ],
  [
    '连接入口',
    [
      'mcp',
      'mcp-config',
      'install-hooks --provider codex|claude --project 工作目录',
      'chat-sessions --provider codex|claude [--query TEXT]',
      'connections --provider PROVIDER --session ID',
      'connect --provider PROVIDER --session ID --project TOPIC [--project TOPIC] --history now|all --confirmed',
      'read-connected --provider PROVIDER --session ID --project TOPIC [--node ID]',
      'sources-connected --provider PROVIDER --session ID --project TOPIC [--cursor CURSOR]',
      'update-connected --provider PROVIDER --session ID --project TOPIC',
      'disconnect --provider PROVIDER --session ID (--project TOPIC | --all) --confirmed',
      'task-status --id ID --remote',
    ],
  ],
  [
    '材料',
    [
      'import-file --project ID --file FILE [--id MATERIAL]',
      'materials --project ID',
      'material --id ID',
      'pause-material --id ID',
      'resume-material --id ID',
      'read-material --id ID --start BYTE_OFFSET',
    ],
  ],
  [
    'GFT Map',
    [
      'list',
      'create --name NAME --scope TEXT',
      'link --session ID --project ID [--project ID] [--write ID]',
      'read --session ID',
      'task --project ID --action update|tidy|redraw [--input FILE]',
      'tasks',
      'task --id ID',
      'task-status --id ID',
      'complete --id ID --file FILE',
      'cancel --id ID',
      'history --project ID',
      'export --project ID --file FILE',
      'import --file FILE',
      'recover',
      `doctor [--agent ${AGENT_CHOICES}] [--model MODEL]`,
      `serve [--port 4317] [--agent ${AGENT_CHOICES}] [--manual] [--model MODEL] [--timeout-seconds 900]`,
    ],
  ],
]
  .map(([title, commands]) => `${title}: ${commands.join(' | ')}`)
  .concat(
    '默认使用 ACP，首次自动准备固定版本连接组件（需 Node.js 22+、npm 和网络）。原生 codex/claude 入口仅用于明确的兼容障碍。诊断覆盖参数: --acp-bin ABSOLUTE_EXECUTABLE [--acp-arg ARG ...]，或 GFT_CODEX_ACP_BIN/GFT_CLAUDE_ACP_BIN 与对应 _ARGS JSON数组。旧Codex入口继续使用 GFT_CODEX_BIN。open/start 自动启动或复用同一安装和数据的面板，默认恢复执行器，首次使用 Codex；stop/restart 遇到未完成任务时保留任务并提示。serve 保留前台运行；需要纯手动模式时使用 --manual。',
  )
  .join('\n');

// ---- Arguments ----

const [command, ...args] = process.argv.slice(2);
const has = flag => args.includes(`--${flag}`);
const values = key =>
  args.flatMap((value, index) => (value === `--${key}` ? [args[index + 1]] : []));
const arg = key => values(key).at(-1);
function need(key) {
  const value = arg(key);
  if (!value || value.startsWith('--')) throw store.fail(`缺少 --${key}`);
  return value;
}
const print = data => console.log(JSON.stringify(data, null, 2));
const encode = encodeURIComponent;
const isPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;

async function localClient() {
  const { createLocalClient } = await import('./dist/mcp.mjs');
  return createLocalClient();
}

function runnerOptions(agent) {
  const timeoutMs = arg('timeout-seconds') ? Number(arg('timeout-seconds')) * 1000 : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
    throw store.fail('执行超时必须是正数');
  const common = {
    ...(arg('model') ? { model: arg('model') } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
  if (!agent?.endsWith('-acp')) return common;
  if (arg('model')) throw store.fail('ACP 使用厂商默认模型；--model 仅用于原生 CLI 兼容诊断。');
  if (has('acp-bin') && !arg('acp-bin')) throw store.fail('缺少 --acp-bin');
  const binary = arg('acp-bin') || acpBinary(agent);
  if (binary && !path.isAbsolute(binary)) throw store.fail('ACP binary 必须是可执行文件的绝对路径');
  const prefixArgs = values('acp-arg').length ? values('acp-arg') : (acpArguments(agent) ?? []);
  if (
    !Array.isArray(prefixArgs) ||
    !prefixArgs.every(value => typeof value === 'string' && !value.includes('\0'))
  )
    throw store.fail('ACP 参数必须是字符串数组');
  return {
    ...(binary ? { binary } : {}),
    ...(prefixArgs.length ? { prefixArgs } : {}),
    ...common,
  };
}

function serviceOptions() {
  const agent = arg('agent');
  const manual = has('manual');
  if (manual && agent) throw store.fail('--manual 不能与 --agent 同时使用');
  if (has('agent') && (!agent || agent.startsWith('--'))) throw store.fail('缺少 --agent');
  if (!agent && ['model', 'timeout-seconds', 'acp-bin', 'acp-arg'].some(has))
    throw store.fail('指定模型、超时或 ACP 参数时，需要同时指定 --agent');
  const port = arg('port');
  if (has('port') && (!port || !isPort(Number(port)))) throw store.fail('端口无效');
  return {
    ...(port ? { url: `http://127.0.0.1:${Number(port)}` } : {}),
    ...(agent ? { agent, runnerOptions: runnerOptions(agent) } : {}),
    ...(manual ? { manual: true } : {}),
  };
}

function browserCommand(href) {
  if (process.platform === 'win32') {
    const rundll = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'rundll32.exe');
    return [rundll, ['url.dll,FileProtocolHandler', href]];
  }
  return [process.platform === 'darwin' ? 'open' : 'xdg-open', [href]];
}

async function openBrowser(address) {
  const url = new URL(address);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw store.fail('只能打开本机 GFT Map 地址');
  const [executable, parameters] = browserCommand(url.href);
  return new Promise(resolve => {
    const child = spawn(executable, parameters, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.once('error', error =>
      resolve({
        browserOpened: false,
        browserError: `页面已可用，请打开 ${url.href}（${error.message}）`,
      }),
    );
    child.once('spawn', () => {
      child.unref();
      resolve({ browserOpened: true });
    });
  });
}

// ---- Service lifecycle ----

async function lifecycleCommand() {
  const lifecycle = await import('./serviceLifecycle.mjs');
  const actions = {
    open: lifecycle.ensureService,
    start: lifecycle.ensureService,
    status: lifecycle.serviceStatus,
    stop: lifecycle.stopService,
    restart: lifecycle.restartService,
  };
  const service = await actions[command](serviceOptions());
  const browser = command === 'open' && !has('no-browser') ? await openBrowser(service.url) : {};
  print({ ...service, ...browser });
}

async function serve() {
  const { watchServiceProcess } = await import('./serviceLifecycle.mjs');
  watchServiceProcess();
  const port = arg('port') ? Number(arg('port')) : 4317;
  if (!isPort(port)) throw store.fail('端口无效');
  const explicitAgent = arg('agent') || null;
  const manual = has('manual');
  if (explicitAgent && manual) throw store.fail('--manual 不能与 --agent 同时使用');
  // Without --agent, restore the executor saved by the last successful start.
  const saved = !explicitAgent && !manual ? await loadExecutorConfig() : null;
  const preferred = defaultExecutor(saved);
  const agent = manual ? null : explicitAgent || preferred.agent;
  const options = explicitAgent ? runnerOptions(explicitAgent) : preferred.runnerOptions;
  const server = await startServer({ port, agent, runnerOptions: options, managed: true });
  if (
    agent &&
    (explicitAgent || saved?.agent !== agent) &&
    server.runtime().executor.status === 'ready'
  )
    await saveExecutorConfig({ agent, runnerOptions: options });
  console.log(
    [
      `GFT Map: http://127.0.0.1:${server.address().port}`,
      `数据目录: ${store.homeDir()}`,
      `执行器: ${agent || '当前 Agent 经 Skill 处理待办'}`,
      '按 Ctrl+C 停止。',
    ].join('\n'),
  );
  if (agent) print(server.runtime());
  else
    console.log(
      '当前为手动模式；网页中可选择“连接 Codex”进行检查。已配置的执行器会在下次省略 --agent 启动时恢复。',
    );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void server.shutdown(signal).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

// ---- File materials ----

async function importFile() {
  const request = await localClient();
  const filename = path.resolve(need('file'));
  const info = await stat(filename);
  if (!info.isFile()) throw store.fail('请选择一个文件');
  const isArchive = filename.toLowerCase().endsWith('.gftpack');
  const project = isArchive ? arg('project') : need('project');
  const job = arg('id')
    ? await request(`/api/materials/${encode(arg('id'))}`)
    : await request('/api/materials', {
        topicId: project,
        name: path.basename(filename),
        size: info.size,
        kind: isArchive ? 'archive' : 'text',
      });
  if (job.size !== info.size || job.name !== path.basename(filename))
    throw store.fail('请选择同一份原文件继续上传');
  console.error(`材料 ID: ${job.id}`);
  if (job.state === 'uploading') await uploadFile(job.id, filename, info.size);
  await request(`/api/materials/${job.id}/finish`, {});
  print(
    job.kind === 'archive'
      ? await request(`/api/materials/${job.id}/restore`, {})
      : await request(`/api/materials/${job.id}`),
  );
}

async function uploadFile(materialId, filename, size) {
  const { ensureService } = await import('./serviceLifecycle.mjs');
  const handle = await open(filename, 'r');
  const buffer = Buffer.alloc(UPLOAD_BLOCK_BYTES);
  try {
    for (let offset = 0; offset < size; ) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) throw store.fail('文件在读取期间发生变化');
      await ensureService();
      const response = await fetch(
        new URL(`/api/materials/${materialId}/upload?offset=${offset}`, SERVICE_URL),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buffer.subarray(0, bytesRead),
          signal: AbortSignal.timeout(60000),
        },
      );
      const value = await response.json();
      if (!response.ok) throw store.fail(value.error, response.status);
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

async function materialCommand() {
  const request = await localClient();
  const material = () => `/api/materials/${encode(need('id'))}`;
  switch (command) {
    case 'materials':
      return print(await request(`/api/materials?topicId=${encode(need('project'))}`));
    case 'material':
      return print(await request(material()));
    case 'read-material':
      return print(await request(`${material()}/page?start=${Number(arg('start') || 0)}`));
    case 'pause-material':
      return print(await request(`${material()}/pause`, {}));
    case 'resume-material':
      return print(await request(`${material()}/resume`, {}));
  }
}

// ---- Chat connections ----

async function connectionCommand() {
  const request = await localClient();
  const provider = arg('provider');
  const sessionId =
    arg('session') || (provider === 'codex' ? process.env.CODEX_THREAD_ID : undefined);
  if (!['codex', 'claude'].includes(provider))
    throw store.fail('请指定 --provider codex 或 claude');
  if (command !== 'chat-sessions' && !sessionId)
    throw store.fail('无法取得本场真实会话编号；请通过页面选择会话，不能生成替代编号');
  const query = new URLSearchParams({
    provider,
    ...(sessionId ? { sessionId } : {}),
    ...(arg('query') ? { query: arg('query') } : {}),
    ...(arg('cursor') ? { cursor: arg('cursor') } : {}),
  });
  const projects = values('project');
  switch (command) {
    case 'chat-sessions':
      return print(await request(`/api/chat-sessions?${query}`));
    case 'connections':
      return print(await request(`/api/connections?${query}`));
    case 'read-connected':
    case 'sources-connected':
      return print(
        await request(
          command === 'read-connected' ? '/api/connections/read' : '/api/connections/sources',
          {
            provider,
            sessionId,
            topicId: need('project'),
            ...(values('node').length ? { nodeIds: values('node') } : {}),
            ...(arg('cursor') ? { cursor: arg('cursor') } : {}),
          },
        ),
      );
    case 'connect': {
      if (!has('confirmed'))
        throw store.fail(
          '先通过宿主原生选项让用户确认主题和历史范围，确认后传 --confirmed；也可使用 gft_local_connect 原生表单',
        );
      const history = need('history');
      if (!['now', 'all'].includes(history) || !projects.length)
        throw store.fail('请明确主题以及 --history now|all');
      return print(
        await request('/api/connections/connect', {
          source: { provider, id: sessionId, ...(arg('cwd') ? { cwd: arg('cwd') } : {}) },
          topicIds: projects,
          history,
        }),
      );
    }
    case 'disconnect':
      if (!has('confirmed')) throw store.fail('请先确认要断开的主题，再传 --confirmed');
      if (!projects.length && !has('all'))
        throw store.fail('请指定 --project，或 --all 断开本场全部主题');
      return print(
        await request('/api/connections/disconnect', {
          provider,
          sessionId,
          ...(projects.length ? { topicIds: projects } : {}),
        }),
      );
    case 'update-connected': {
      const topicId = need('project');
      const connections = await request(`/api/connections?${query}`);
      const connection = connections.find(item => item.topicId === topicId);
      if (!connection) throw store.fail('该主题尚未连接到本场对话');
      return print(
        await request(`/api/topics/${encode(topicId)}/update-from-chat`, {
          connectionId: connection.id,
        }),
      );
    }
  }
}

// ---- Topics, tasks and transfer ----

async function runTaskCommand() {
  const task = arg('id')
    ? { id: arg('id') }
    : await store.createTask(
        need('project'),
        need('action'),
        arg('input') ? await readFile(arg('input'), 'utf8') : '',
      );
  print(await store.taskPrompt(task.id));
}

async function taskStatus() {
  const id = need('id');
  if (has('remote')) print(await (await localClient())(`/api/tasks/${encode(id)}/status`));
  else print(await store.getTaskStatus(id));
}

async function exportTopic() {
  const id = need('project');
  const filename = need('file');
  const materials = await import('./materials.mjs');
  if ((await materials.list(id)).length) {
    if (!filename.toLowerCase().endsWith('.gftpack'))
      throw store.fail('含文件材料的脉络请使用 .gftpack 后缀，完整保存原文与进度');
    const { archiveStream } = await import('./materialArchive.mjs');
    await pipeline(await archiveStream(id), createWriteStream(filename));
  } else {
    await writeFile(filename, JSON.stringify(await store.exportTopic(id), null, 2), 'utf8');
  }
  print({ saved: filename });
}

async function listTopics() {
  if (has('remote')) print(await (await localClient())('/api/topics'));
  else print(await store.listTopics());
}

const commands = {
  open: lifecycleCommand,
  start: lifecycleCommand,
  status: lifecycleCommand,
  stop: lifecycleCommand,
  restart: lifecycleCommand,
  serve,
  async version() {
    const { programVersion, installationId } = await import('./version.mjs');
    print({
      product: 'gft-map',
      version: await programVersion(),
      installationId,
      dataDirectory: store.homeDir(),
    });
  },
  async upgrade() {
    const { upgradeSkill } = await import('./upgrade.mjs');
    const installed = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    print(
      await upgradeSkill({
        directory: arg('directory') || installed,
        dataDirectory: store.homeDir(),
        url: SERVICE_URL,
      }),
    );
  },
  'import-file': importFile,
  materials: materialCommand,
  material: materialCommand,
  'pause-material': materialCommand,
  'resume-material': materialCommand,
  'read-material': materialCommand,
  async 'install-hooks'() {
    const { installChangeHook } = await import('./install-hooks.mjs');
    print(await installChangeHook({ provider: need('provider'), project: need('project') }));
  },
  async mcp() {
    const { startMcp } = await import('./dist/mcp.mjs');
    await startMcp();
  },
  'mcp-config': () =>
    print({
      mcpServers: {
        'gft-local': {
          command: process.execPath,
          args: [fileURLToPath(import.meta.url), 'mcp'],
          env: { GFT_LOCAL_URL: SERVICE_URL, GFT_LOCAL_HOME: store.homeDir() },
        },
      },
    }),
  'chat-sessions': connectionCommand,
  connections: connectionCommand,
  connect: connectionCommand,
  disconnect: connectionCommand,
  'read-connected': connectionCommand,
  'sources-connected': connectionCommand,
  'update-connected': connectionCommand,
  list: listTopics,
  async doctor() {
    const saved = defaultExecutor(await loadExecutorConfig());
    const agent = arg('agent') || saved.agent;
    print(
      await (
        await createRunner(
          agent,
          arg('agent') ? runnerOptions(agent) : { ...saved.runnerOptions, ...runnerOptions(agent) },
        )
      ).check(),
    );
  },
  recover: async () => print(await store.recover()),
  create: async () => print(await store.createTopic(need('name'), arg('scope') || '')),
  link: async () =>
    print(await store.linkSession(need('session'), values('project'), arg('write'))),
  read: async () => print(await store.readContext(arg('session'), arg('project'))),
  history: async () => print(await store.history(need('project'))),
  tasks: async () => print(await store.listTasks()),
  'task-status': taskStatus,
  task: runTaskCommand,
  complete: async () =>
    print(await store.completeTask(need('id'), await readFile(need('file'), 'utf8'))),
  cancel: async () => print(await store.setTaskStatus(need('id'), 'cancelled')),
  export: exportTopic,
  import: async () =>
    print(await store.importTopic(JSON.parse(await readFile(need('file'), 'utf8')))),
};

try {
  if (Object.hasOwn(commands, command)) await commands[command]();
  else {
    console.log(USAGE);
    if (command && command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message, status: error.status || 500 }));
  process.exitCode = 1;
}
