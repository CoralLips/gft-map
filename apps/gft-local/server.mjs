import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import * as materials from './materials.mjs';
import { archiveStream, restore as restoreMaterialArchive } from './materialArchive.mjs';
import * as store from './store.mjs';
import { createAccount } from './account.mjs';
import { createCloudSync } from './sync.mjs';
import { pendingNotices, acknowledgeNotices } from './notifications.mjs';
import { createCodexRunner } from './runner.mjs';
import { createClaudeRunner } from './claudeRunner.mjs';
import { ensureAdapter } from './acpAdapters.mjs';
import { programVersion, installationId } from './version.mjs';
import { progressOf } from './progress.mjs';
import {
  prepareImport,
  parseImportSummary,
  redrawSummaryInput,
  tidyOperation,
  refineOperation,
  relationOperation,
} from './dist/core.mjs';
import {
  acpArguments,
  acpBinary,
  agents as executorAgents,
  loadExecutorConfig,
  saveExecutorConfig,
  defaultExecutor,
} from './executor-config.mjs';
import {
  acquireServiceLease,
  checkRecordedService,
  recordServiceStart,
  serviceEvent,
  disableSupervision,
} from './serviceLifecycle.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const agents = [...executorAgents];

const TICK_INTERVAL_MS = 800;
const CANCELLATION_POLL_MS = 250;
const MAX_NODE_JOBS = 2;
const JSON_BODY_LIMIT = 4 * 1024 * 1024;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
/** POST actions that would start model work; refused while the executor is being switched. */
const TASK_STARTING_ACTIONS = new Set(['tasks', 'update-from-chat', 'resume']);
const STOPPED_TASK_MESSAGE = '本地服务已停止，当前内容保留；可重新发起任务。';
const CANCELLED_TASK_MESSAGE = '任务已取消，当前内容保留。';
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const STATIC_FILES = new Map([
  ['', ['index.html', 'text/html']],
  ['app.js', ['app.js', 'text/javascript']],
  ['app.css', ['app.css', 'text/css']],
]);
const ASSET_TYPES = {
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  svg: 'image/svg+xml',
  png: 'image/png',
};
const TOPIC_READS = new Map([
  ['local-file', store.localFileLocation],
  ['operations', store.getOperations],
  ['update-receipt', store.getUpdateReceipt],
  ['history', store.history],
  ['export', store.exportTopic],
  ['snapshot', store.getSnapshot],
  ['sources', store.sourceEvents],
]);
/** Server-run model operations; tasks carrying `params` use these instead of a single prompt. */
const OPERATIONS = { tidy: tidyOperation, refine: refineOperation, relation: relationOperation };
/** Marks a request whose handler has already written the response. */
const RESPONDED = Symbol('responded');

export function revealCommand(filename, platform = process.platform) {
  if (platform === 'darwin') return ['open', ['-R', filename]];
  if (platform === 'win32') return ['explorer.exe', [`/select,${filename}`]];
  return ['xdg-open', [path.dirname(filename)]];
}

async function revealSavedFile(filename) {
  const [binary, args] = revealCommand(filename);
  try {
    await promisify(execFile)(binary, args, { timeout: 10000, windowsHide: true });
  } catch {
    throw store.fail('无法打开文件夹，请复制路径在文件管理器中打开。', 503);
  }
}

export async function createRunner(agent = 'codex', options) {
  if (agent === 'codex') return createCodexRunner(options);
  if (agent === 'claude') return createClaudeRunner(options);
  if (!agents.includes(agent)) throw store.fail(`执行器应为 ${agents.join('、')}`);
  const { createAcpRunner } = await import('./dist/acp.mjs');
  const configured = { binary: acpBinary(agent), prefixArgs: acpArguments(agent), ...options };
  if (!configured.binary) {
    Object.assign(configured, await ensureAdapter(agent));
  }
  // The vendor's recommended model unless one was chosen in "AI 处理"; effort stays the default.
  return createAcpRunner({
    ...configured,
    providerDefaults: true,
    adapter: agent === 'codex-acp' ? 'codex' : 'claude',
  });
}

const errorRecord = (error, code = error.code || null) => ({
  message: error.message,
  code,
  at: new Date().toISOString(),
});

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE_HEADERS });
  res.end(JSON.stringify(data));
}

/** Only the panel's own address may call the API (blocks DNS rebinding and cross-site requests). */
function checkLocalOrigin(req, port) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  const { host, origin } = req.headers;
  if (!allowed.includes(host) || (origin && !allowed.some(item => `http://${item}` === origin)))
    throw store.fail('不允许此来源', 403);
}

async function readLimited(req, limit, message) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw store.fail(message, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw store.fail('需要 JSON 请求', 415);
  const body = await readLimited(req, JSON_BODY_LIMIT, '内容过大');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw store.fail('JSON 无法解析');
  }
}

async function receiveUpload(req, url, materialId) {
  if (req.headers['content-type'] !== 'application/octet-stream')
    throw store.fail('需要文件分块', 415);
  const chunk = await readLimited(req, materials.UPLOAD_BYTES, '分块过大，请分批发送');
  return materials.upload(materialId, Number(url.searchParams.get('offset')), chunk);
}

async function serveStatic(req, parts, res) {
  if (req.method !== 'GET') throw store.fail('不支持的请求', 405);
  const assetPath = parts.join('/');
  const font = /^assets\/[\w.-]+\.(woff2?|ttf|svg|png)$/.exec(assetPath);
  const asset = STATIC_FILES.get(assetPath) ?? (font ? [assetPath, ASSET_TYPES[font[1]]] : null);
  if (!asset) throw store.fail('页面不存在', 404);
  const [file, type] = asset;
  const content = await readFile(path.join(root, 'dist/web', file));
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, ...NO_STORE_HEADERS });
  res.end(content);
}

/** A topic with file materials downloads as a .gftpack archive, otherwise as JSON. */
async function sendTopicDownload(res, topicId) {
  const topic = await store.getTopic(topicId);
  const safeName = topic.name.replace(/[\\/:*?"<>|]/g, '_');
  const disposition = extension =>
    `attachment; filename*=UTF-8''${encodeURIComponent(safeName + extension)}`;
  if ((await materials.list(topicId)).length > 0) {
    const stream = await archiveStream(topicId);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Disposition': disposition('.gftpack'),
    });
    await pipeline(stream, res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Disposition': disposition('.gft.json'),
  });
  res.end(JSON.stringify(await store.exportTopic(topicId), null, 2));
}

const readTopic = (id, action) => (TOPIC_READS.get(action) ?? store.getView)(id);

function readTask(id, action) {
  if (action === 'status') return store.getTaskStatus(id);
  return store.taskPrompt(id);
}

const searchParams = (url, keys) =>
  Object.fromEntries(
    keys.filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]),
  );

const outputOf = result => (typeof result === 'string' ? result : result.output);

/** Metrics of every model call in one task; a single call is stored unchanged. */
function combinedExecution(runs) {
  if (runs.length === 1) return runs[0];
  const total = key => runs.reduce((sum, run) => sum + (run[key] || 0), 0);
  return {
    ...runs.at(-1),
    calls: runs.length,
    runs: [...runs],
    elapsedMs: total('elapsedMs'),
    toolCallCount: total('toolCallCount'),
  };
}

/** Long histories are condensed chunk by chunk; the final call works from that summary. */
async function runPrompt(task, prompt, callModel) {
  let summary = '';
  for (const chunk of prompt.historyChunks || []) {
    const request = prepareImport(await store.getTopic(task.topicId), chunk, summary);
    const part = await callModel({ ...prompt, ...request, historyChunks: undefined });
    summary = parseImportSummary(outputOf(part));
  }
  const final = await callModel({
    ...prompt,
    ...(prompt.historyChunks ? { user: redrawSummaryInput(summary) } : {}),
    historyChunks: undefined,
  });
  return outputOf(final);
}

export async function startServer(options = {}) {
  if (options.agent && !agents.includes(options.agent))
    throw store.fail(`执行器应为 ${agents.join('、')}`);
  const releaseLease = options.managed ? await acquireServiceLease() : null;
  try {
    return await createService(options, releaseLease);
  } catch (error) {
    await releaseLease?.();
    throw error;
  }
}

async function createService(
  {
    port = 4317,
    agent = null,
    execute,
    runnerOptions,
    sourceReaders,
    connectionService,
    accountService,
    syncIntervalMs,
    managed = false,
    revealFile = revealSavedFile,
  },
  releaseLease,
) {
  if (managed) await checkRecordedService();
  await store.recover();
  // Housekeeping; a failure here must not keep the service from starting.
  await store.tidyTaskRecords().catch(error => console.warn('任务记录整理未完成：', error.message));

  // Executor. A switch replaces `runner` only after the new one passes its check.
  let activeAgent = agent;
  let activeRunnerOptions = runnerOptions;
  let runner = null;
  let lastError = null;
  let executorCheckPromise = null;
  let executorCheckAgent = null;
  /** Text each running model call has written so far, by task id; never persisted. */
  const liveOutput = new Map();
  let preparingInitial = false;
  async function prepareInitialExecutor() {
    try {
      const ready = await checkedRunner(activeAgent, activeRunnerOptions);
      runner = ready.candidate;
      activeRunnerOptions = ready.options;
      if (managed && !closed) {
        const saved = await loadExecutorConfig();
        if (
          saved?.agent !== activeAgent ||
          JSON.stringify(saved?.runnerOptions) !== JSON.stringify(activeRunnerOptions)
        )
          await saveExecutorConfig({ agent: activeAgent, runnerOptions: activeRunnerOptions });
      }
    } catch (error) {
      // Keep the failed runner: tasks re-check it, and status reads its snapshot.
      runner = error.candidate ?? runner;
      lastError = errorRecord(error, error.code);
    }
  }

  const version = await programVersion();
  const readers = sourceReaders || (await import('./dist/sources.mjs'));
  const { createConnections } = await import('./connections.mjs');
  const connections = connectionService || createConnections({ readers });
  const account = accountService || createAccount({ home: store.homeDir() });
  const sync = createCloudSync({ account, intervalMs: syncIntervalMs });
  const serviceInstanceId = randomUUID();

  // Lifecycle.
  let initialized = false;
  let closed = false;
  let checkingStop = false;
  let mutations = 0; // mutating requests in flight, including the current one
  let timer = null;
  let recordStop = null;
  let shutdownPromise = null;
  let executionClosePromise = null;

  // Work: one serial task or material batch at a time, plus bounded node jobs.
  let busy = false;
  let activeTaskId = null;
  let activeController = null;
  let tickPromise = null;
  const nodeJobs = new Map();
  // `busy` only keeps ticks from overlapping; an idle tick that merely scans for
  // materials is not work, or a switch landing in that moment is refused as busy.
  // Material processing is guarded by its own job state where it matters.
  const hasActiveWork = () => activeTaskId !== null || nodeJobs.size > 0;

  const materialWorker = materials.createWorker({
    run: async (request, signal) => {
      if (runner?.snapshot().status === 'unavailable') await runner.check();
      if (execute) return execute(request, { signal });
      if (!runner) throw store.fail('请先启用本地 Agent 执行器', 503);
      const directory = path.join(
        store.homeDir(),
        'runs',
        `material-${request.materialId}-${Date.now()}`,
      );
      return runner.run(request, { directory, signal });
    },
  });
  await materialWorker.recover();

  function backgroundFailure(error) {
    lastError = errorRecord(error, error.code || error.name);
    void serviceEvent('background-error', { code: error.code || error.name }).catch(() => {});
  }

  function executorStatus() {
    if (preparingInitial) return { status: 'checking', message: '正在准备 Agent 连接…', lastError };
    if (runner)
      return { ...runner.snapshot(), ...(hasActiveWork() ? { status: 'running' } : {}), lastError };
    let status = 'manual';
    if (activeAgent) status = lastError ? 'unavailable' : hasActiveWork() ? 'running' : 'ready';
    return { status, activeTaskId, lastError };
  }

  function serviceState() {
    if (closed || checkingStop) return 'stopping';
    return initialized ? 'running' : 'starting';
  }

  function runtime() {
    return {
      product: 'gft-map',
      version,
      installationId,
      dataDirectory: store.homeDir(),
      serviceInstanceId,
      serviceState: serviceState(),
      pid: process.pid,
      agent: activeAgent,
      mode: activeAgent ? 'automatic' : 'manual',
      executor: executorStatus(),
    };
  }

  const hasQueuedTasks = async () =>
    (await store.listTasks()).some(task => ['pending', 'running'].includes(task.status));
  const hasMaterialsIn = async states =>
    (await materials.list()).some(job => states.includes(job.state));

  /** Work a stop or upgrade must not interrupt. The stop request itself is one mutation. */
  async function busyForShutdown() {
    return (
      hasActiveWork() ||
      mutations > 1 ||
      !!executorCheckPromise ||
      (await hasQueuedTasks()) ||
      (await hasMaterialsIn(['queued', 'running']))
    );
  }

  function requireExecutor(message) {
    if (!activeAgent) throw store.fail(message, 503);
  }

  // ---- Executors ----

  async function optionsFor(requested) {
    if (requested === activeAgent && activeRunnerOptions) return activeRunnerOptions;
    const saved = await loadExecutorConfig();
    if (saved?.agent === requested) return saved.runnerOptions;
    if (saved?.profiles?.[requested]) return saved.profiles[requested];
    const native = requested.replace(/-acp$/, '');
    return requested.endsWith('-acp')
      ? defaultExecutor({
          agent: native,
          runnerOptions: saved?.agent === native ? saved.runnerOptions : saved?.profiles?.[native],
        }).runnerOptions
      : undefined;
  }

  /**
   * Creates and checks a runner. With `fallback`, a model chosen earlier that the
   * provider has since withdrawn gives way to the recommended one; otherwise the
   * agent would stay unusable, since the dialog cannot select an unavailable agent.
   * A failure carries the last runner as `error.candidate`.
   */
  async function checkedRunner(agentName, options, fallback = true) {
    let candidate = await createRunner(agentName, options);
    try {
      await candidate.check();
      return { candidate, options };
    } catch (error) {
      if (!fallback || error.code !== 'RUNNER_MODEL' || !options?.model)
        throw Object.assign(error, { candidate });
      await candidate.waitForIdle();
      const { model: _withdrawn, ...recommended } = options;
      candidate = await createRunner(agentName, recommended);
      try {
        await candidate.check();
      } catch (retryError) {
        throw Object.assign(retryError, { candidate });
      }
      return { candidate, options: recommended };
    }
  }

  async function checkExecutor(agentName) {
    if (agentName === activeAgent && runner && hasActiveWork())
      return { agent: agentName, ...runner.snapshot() };
    let candidate;
    try {
      ({ candidate } = await checkedRunner(agentName, await optionsFor(agentName)));
      return { agent: agentName, ...candidate.snapshot() };
    } catch (error) {
      candidate = error.candidate;
      return { agent: agentName, status: 'unavailable', error: error.message };
    } finally {
      await candidate?.waitForIdle();
    }
  }

  // The last check of each agent, so reopening the dialog shows results at once.
  // A switch checks again before it takes effect, so an old result is never trusted.
  const checkedExecutors = new Map();
  const pendingChecks = new Map();
  function candidateStatus(agentName, refresh) {
    const live = agentName === activeAgent && runner?.snapshot();
    if (!refresh && ['ready', 'running'].includes(live?.status))
      return { agent: agentName, ...live };
    if (!refresh && checkedExecutors.has(agentName)) return checkedExecutors.get(agentName);
    if (!pendingChecks.has(agentName))
      pendingChecks.set(
        agentName,
        checkExecutor(agentName)
          .then(result => (checkedExecutors.set(agentName, result), result))
          .finally(() => pendingChecks.delete(agentName)),
      );
    return pendingChecks.get(agentName);
  }

  function discoverExecutors({ agent: only, refresh = false } = {}) {
    if (only) {
      if (!agents.includes(only)) throw store.fail(`执行器应为 ${agents.join('、')}`);
      return candidateStatus(only, refresh);
    }
    return Promise.all(['codex-acp', 'claude-acp'].map(name => candidateStatus(name, refresh)));
  }

  /** `model`: undefined keeps the saved choice, null returns to the recommended one. */
  async function switchExecutor(requested, model) {
    if (!agents.includes(requested)) throw store.fail(`执行器应为 ${agents.join('、')}`);
    if (model !== undefined && model !== null && (typeof model !== 'string' || !model.trim()))
      throw store.fail('模型名称无效');
    if (closed) throw store.fail('本地服务正在关闭，请重新打开页面后重试。', 409);
    if (
      hasActiveWork() ||
      activeTaskId ||
      (await hasQueuedTasks()) ||
      (await hasMaterialsIn(['uploading', 'queued', 'running']))
    )
      throw store.fail('当前有任务或材料正在处理，请完成或暂停后再连接执行器。', 409);
    if (executorCheckPromise) {
      if (executorCheckAgent !== requested)
        throw store.fail('正在检查另一种执行器，请等待检查完成后再切换。', 409);
      await executorCheckPromise;
      if (lastError) throw store.fail(lastError.message || 'Agent 连接准备失败。', 503);
      return runtime();
    }
    if (hasActiveWork()) throw store.fail('任务正在处理，请稍后检查执行器。', 409);
    executorCheckAgent = requested;
    executorCheckPromise = activateExecutor(requested, model);
    try {
      return await executorCheckPromise;
    } finally {
      executorCheckPromise = null;
      executorCheckAgent = null;
    }
  }

  async function activateExecutor(requested, model) {
    const { model: savedModel, ...rest } = (await optionsFor(requested)) || {};
    const chosen = model === undefined ? savedModel : model;
    try {
      // A model picked just now must work; a saved one may fall back if withdrawn.
      const { candidate, options } = await checkedRunner(
        requested,
        { ...rest, ...(chosen ? { model: chosen } : {}) },
        model === undefined,
      );
      if (closed || hasActiveWork() || (await hasQueuedTasks()))
        throw store.fail('仍有任务正在处理，请完成或停止后再切换。', 409);
      await saveExecutorConfig({ agent: requested, runnerOptions: options });
      runner = candidate;
      activeAgent = requested;
      activeRunnerOptions = options;
      lastError = null;
      return runtime();
    } catch (error) {
      // A failed switch keeps the current executor and its status.
      if (!activeAgent || activeAgent === requested) lastError = errorRecord(error);
      throw store.fail(error.message, error.status || 503);
    }
  }

  // ---- Requests ----

  const server = http.createServer(async (req, res) => {
    const mutating = MUTATING_METHODS.has(req.method);
    if (mutating) mutations++;
    try {
      checkLocalOrigin(req, server.address()?.port);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api') {
        await serveStatic(req, parts, res);
        return;
      }
      if ((closed || checkingStop) && mutating)
        throw store.fail('本地服务正在关闭，请稍后重新打开。', 503);
      if (!initialized && mutating) throw store.fail('本地服务正在启动，请稍后重试。', 503);
      const [, group, id, action] = parts;
      const route = { res, url, group, id, action };
      let value;
      if (req.method === 'PUT' && group === 'materials' && action === 'upload')
        value = await receiveUpload(req, url, id);
      else if (req.method === 'GET') value = await handleGet(route);
      else if (req.method === 'POST') value = await handlePost(route, await readJson(req));
      else throw store.fail('不支持的请求', 405);
      if (value === RESPONDED) return;
      sendJson(res, 200, value);
      if (req.method === 'POST') void sync.run();
    } catch (error) {
      if (res.headersSent) res.destroy(error);
      else sendJson(res, error.status || 500, { error: error.message });
    } finally {
      if (mutating) mutations--;
    }
  });

  async function handleGet({ res, url, group, id, action }) {
    const query = name => url.searchParams.get(name);
    switch (group) {
      case 'topics':
        if (action === 'download') {
          await sendTopicDownload(res, id);
          return RESPONDED;
        }
        return id ? readTopic(id, action) : store.listTopics();
      case 'runtime':
        return id === 'executors'
          ? discoverExecutors({ agent: query('agent'), refresh: query('refresh') === '1' })
          : runtime();
      case 'material-evidence':
        return {
          text: await materials.evidence(query('topicId'), url.searchParams.getAll('node')),
        };
      case 'materials':
        if (!id) return materials.list(query('topicId'));
        return action === 'page'
          ? materials.page(id, Number(query('start') || 0))
          : materials.get(id);
      case 'account':
        return { ...(await account.status()), sync: sync.snapshot() };
      case 'chat-sessions':
        return listChatSessions(url);
      case 'chat-session':
        return readers.getChatSession({
          provider: query('provider'),
          id: query('id'),
          cwd: query('cwd') || undefined,
        });
      case 'connections':
        return connections.listConnections(searchParams(url, ['topicId', 'provider', 'sessionId']));
      case 'sessions':
        return store.listSessions();
      case 'tasks':
        if (id && action === 'status' && liveOutput.has(id)) {
          const written = liveOutput.get(id);
          return {
            ...(await readTask(id, action)),
            progress: [...written.earlier, ...progressOf(written.text, written.aliases)],
          };
        }
        return id ? readTask(id, action) : store.listTasks();
      default:
        throw store.fail('接口不存在', 404);
    }
  }

  async function handlePost({ res, group, id, action }, data) {
    if (executorCheckPromise && TASK_STARTING_ACTIONS.has(action))
      throw store.fail('正在切换处理 Agent，请稍后再开始任务。', 409);
    switch (group) {
      case 'runtime':
        if (id === 'executor') return switchExecutor(data?.agent, data?.model);
        break;
      case 'service':
        if (id === 'stop') {
          await stopOnRequest(res, data);
          return RESPONDED;
        }
        break;
      case 'upgrade':
        if (id === 'prepare') {
          await prepareUpgrade(res, data);
          return RESPONDED;
        }
        break;
      case 'materials':
        return materialAction(id, action, data);
      case 'import':
        return store.importTopic(data);
      case 'account':
        if (id === 'login') return account.begin();
        if (id === 'logout') return account.logout();
        if (id === 'cancel') return account.cancel();
        break;
      case 'connections':
        return connectionAction(id, data);
      case 'chat-preview':
        return readers.getChatPreview(data.source);
      case 'topics':
        return topicAction(id, action, data);
      case 'tasks':
        if (action === 'cancel') return cancelTask(id);
        if (action === 'complete') return store.completeTask(id, data.output);
        break;
    }
    throw store.fail('接口不存在', 404);
  }

  async function listChatSessions(url) {
    const encoded = url.searchParams.get('cursor');
    let cursor;
    if (encoded) {
      try {
        cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      } catch {
        throw store.fail('会话列表读取位置无效，请重新搜索');
      }
    }
    const page = await readers.listChatSessions({
      provider: url.searchParams.get('provider'),
      query: url.searchParams.get('query') || '',
      cursor,
      limit: 30,
    });
    const nextCursor = page.nextCursor
      ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url')
      : null;
    return { ...page, nextCursor };
  }

  async function materialAction(id, action, data) {
    if (!id) return materials.create(data);
    switch (action) {
      case 'finish':
        return materials.finish(id);
      case 'restore':
        return restoreMaterialArchive(id);
      case 'discard':
        return materials.discard(id);
      case 'pause':
      case 'resume':
        return materialWorker.control(id, action);
      case 'edit':
        return materials.editPage(id, data.start, data.end, data.text, data.etag);
      default:
        throw store.fail('接口不存在', 404);
    }
  }

  async function connectionAction(id, data) {
    switch (id) {
      case 'notices':
        return pendingNotices(data);
      case 'ack-notices':
        return acknowledgeNotices(data);
      case 'connect':
        return connections.connectSource(data);
      case 'disconnect':
        return connections.disconnectSource(data);
      case 'read':
        return connections.readConnectedContext(data);
      case 'sources':
        return connections.readConnectedSources(data);
      default:
        throw store.fail('接口不存在', 404);
    }
  }

  async function topicAction(id, action, data) {
    if (!id) return store.createTopic(data.name, data.scope, undefined, data.id);
    switch (action) {
      case 'reveal-file':
        await revealFile((await store.localFileLocation(id)).path);
        return { opened: true };
      case 'rollback-operation':
        return store.rollbackOperation(id, data.baseRevision, data.receiptId);
      case 'rollback-update':
        return store.rollbackUpdate(id, data.baseRevision, data.receiptId);
      case 'doc':
        return store.saveDoc(id, data.baseRevision, data.doc);
      case 'graph':
        return store.saveGraph(id, data.baseRevision, data.op);
      case 'state':
        return store.saveState(id, data.baseRevision, data.map);
      case 'rename':
        return store.renameTopic(id, data.baseRevision, data.name);
      case 'archive':
        return store.archiveTopic(id, data.baseRevision);
      case 'sources':
        await store.saveSourceEvent(id, data.event);
        return { saved: true };
      case 'clear-sources':
        await store.clearSourceEvents(id);
        return { saved: true };
      case 'tasks':
        // Page operations (tidy, node tidy, relation captions) only run on the
        // service's own executor; an Agent reading queued tasks cannot finish them.
        if (data.params !== undefined)
          requireExecutor(
            `本地执行器尚未启用，请选择 ${agents.join('、')}，并用 serve --agent 启动服务。`,
          );
        return store.createTask(id, data.action, data.input, {
          params: data.params,
          origin: data.origin,
        });
      case 'update-from-chat':
        requireExecutor('本地执行器尚未启用，请用 serve --agent 启动服务后再更新。');
        return connections.createSourceUpdate(id, {
          connectionId: data.connectionId,
          continuous: data.continuous === true,
          until: data.until,
        });
      default:
        throw store.fail('接口不存在', 404);
    }
  }

  async function cancelTask(id) {
    const task = await store.setTaskStatus(id, 'cancelled');
    if (activeTaskId === id) activeController?.abort('cancelled');
    nodeJobs.get(id)?.controller.abort('cancelled');
    return task;
  }

  async function stopOnRequest(res, data) {
    if (
      data.installationId !== installationId ||
      data.dataDirectory !== store.homeDir() ||
      data.serviceInstanceId !== serviceInstanceId
    )
      throw store.fail('服务身份已变化，未停止任何进程。', 409);
    checkingStop = true;
    try {
      if (await busyForShutdown())
        throw store.fail(
          '仍有任务正在处理，请等待完成，或先在页面暂停材料、取消任务，再关闭服务。',
          409,
        );
    } catch (error) {
      checkingStop = false;
      throw error;
    }
    closed = true;
    await disableSupervision();
    sendJson(res, 200, { stopping: true });
    setImmediate(() => void server.shutdown('requested-stop').catch(backgroundFailure));
  }

  async function prepareUpgrade(res, data) {
    if (data.installationId !== installationId)
      throw store.fail('此服务属于另一份安装，未停止。', 409);
    if (await busyForShutdown()) throw store.fail('请等待任务完成或暂停后再更新。', 409);
    closed = true;
    await disableSupervision();
    sendJson(res, 200, { stopped: true, version });
    setImmediate(() => void server.shutdown('upgrade').catch(backgroundFailure));
  }

  // ---- Task queue ----

  const isNodeJob = task => !!task && store.isConcurrentOperation(task);

  async function tick() {
    if (busy || closed || checkingStop || executorCheckPromise || !activeAgent) return;
    const pending = (await store.listTasks())
      .filter(task => task.status === 'pending' && !nodeJobs.has(task.id))
      .reverse(); // oldest first
    const next = pending[0];
    if (isNodeJob(next)) {
      startNodeJobs(pending);
      return;
    }
    if (nodeJobs.size || closed) return;
    busy = true;
    try {
      if (!next) {
        await materialWorker.tick();
        return;
      }
      activeTaskId = next.id;
      activeController = new AbortController();
      await runTask(next, activeController, false);
    } finally {
      activeTaskId = null;
      activeController = null;
      busy = false;
    }
  }

  /** Node computations run concurrently, bounded, and never overlap topic writers. */
  function startNodeJobs(pending) {
    for (const task of pending) {
      if (nodeJobs.size >= MAX_NODE_JOBS || !isNodeJob(task) || closed) break;
      const job = { controller: new AbortController(), promise: null };
      nodeJobs.set(task.id, job);
      job.promise = runTask(task, job.controller, true)
        .catch(backgroundFailure)
        .finally(() => nodeJobs.delete(task.id));
    }
  }

  async function runTask(task, controller, independent) {
    let claimed = false;
    let cancellation;
    let taskRunner = runner;
    try {
      await store.setTaskStatus(task.id, 'running');
      claimed = true;
      if (closed) {
        await store.setTaskStatus(task.id, 'failed', STOPPED_TASK_MESSAGE);
        return;
      }
      lastError = null;
      cancellation = watchCancellation(task.id, controller);
      // Each concurrent node job gets its own executor process.
      if (independent && !execute)
        taskRunner = await createRunner(activeAgent, activeRunnerOptions);
      if (taskRunner && (independent || taskRunner.snapshot().status === 'unavailable'))
        await taskRunner.check();
      if (task.params) {
        // A server-run operation: the shared core calls the model and returns lines to write.
        const callModel = modelCaller(task, controller, taskRunner, () => store.getTask(task.id));
        const topic = await store.getTopic(task.topicId);
        // The executor reads only system/user; task fields identify the call for logs and tests.
        const result = await OPERATIONS[task.action](
          topic,
          task.params,
          async request => outputOf(await callModel({ ...task, ...request })),
          // Progress only: a missed write just leaves the previous round showing.
          { onRound: round => store.setTaskRound(task.id, round).catch(() => {}) },
        );
        if (!closed) await store.completeOperation(task.id, result);
        return;
      }
      const prompt = await store.taskPrompt(task.id);
      const output = await runPrompt(task, prompt, modelCaller(task, controller, taskRunner));
      if (!closed) await store.completeTask(task.id, output);
    } catch (error) {
      if (!controller.signal.aborted) lastError = errorRecord(error);
      if (claimed) {
        if (error.execution) await saveExecution(task.id, error.execution).catch(() => {});
        await store.setTaskStatus(task.id, 'failed', error.message).catch(() => {});
      }
    } finally {
      clearInterval(cancellation);
      liveOutput.delete(task.id);
      if (independent && taskRunner) await taskRunner.waitForIdle();
    }
  }

  /** The CLI or another panel may cancel the task through the store. */
  function watchCancellation(taskId, controller) {
    return setInterval(async () => {
      try {
        if ((await store.getTask(taskId)).status !== 'running') controller.abort('cancelled');
      } catch {
        controller.abort('cancelled');
      }
    }, CANCELLATION_POLL_MS);
  }

  /** `verify` re-reads the task before each call; by default it also re-checks edits and the source. */
  function modelCaller(task, controller, taskRunner, verify = () => store.taskPrompt(task.id)) {
    const runs = [];
    return async request => {
      if (controller.signal.aborted) throw store.fail(CANCELLED_TASK_MESSAGE, 409);
      const current = await verify();
      if (current.status !== 'running') throw store.fail(CANCELLED_TASK_MESSAGE, 409);
      // What this call has written so far; the status read shows it as edit actions,
      // after those of the task's earlier calls so the step count keeps going.
      const previous = liveOutput.get(task.id);
      const written = {
        text: '',
        aliases: request.aliases || {},
        earlier: previous
          ? [...previous.earlier, ...progressOf(previous.text, previous.aliases)]
          : [],
      };
      liveOutput.set(task.id, written);
      const onText = text => (written.text += text);
      const result = execute
        ? await execute(request, { signal: controller.signal, onText })
        : await taskRunner.run(request, {
            directory: path.join(store.homeDir(), 'runs', task.id),
            signal: controller.signal,
            onText,
          });
      if (result?.execution) {
        runs.push(result.execution);
        await saveExecution(task.id, combinedExecution(runs));
      }
      return result;
    };
  }

  async function saveExecution(id, execution) {
    // Cancellation may be committing its task state as the child closes. Keep
    // the metrics without ever replacing that independently committed status.
    for (let attempt = 0; ; attempt++) {
      try {
        await store.saveTaskExecution(id, execution);
        return;
      } catch (error) {
        if (error.status !== 409 || attempt >= 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }

  // ---- Start and shutdown ----

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  if (managed) {
    try {
      recordStop = await recordServiceStart({
        url: `http://127.0.0.1:${server.address().port}`,
        runtime: runtime(),
      });
    } catch (error) {
      await new Promise(resolve => server.close(resolve));
      throw error;
    }
  }
  timer = setInterval(() => {
    if (closed || tickPromise) return;
    tickPromise = tick()
      .catch(backgroundFailure)
      .finally(() => {
        tickPromise = null;
      });
  }, TICK_INTERVAL_MS);
  sync.start();

  function stopExecution() {
    executionClosePromise ||= drainExecution();
    return executionClosePromise;
  }

  async function drainExecution() {
    closed = true;
    clearInterval(timer);
    activeController?.abort('shutdown');
    const interrupted = [activeTaskId, ...nodeJobs.keys()].filter(Boolean);
    const nodePromises = [...nodeJobs.values()].map(job => {
      job.controller.abort('shutdown');
      return job.promise;
    });
    // Start material cancellation before waiting: tick may be awaiting its
    // independent controller. Drain the whole tick, including atomic writes.
    const materialClose = materialWorker.close();
    const outcomes = await Promise.allSettled([
      tickPromise,
      materialClose,
      executorCheckPromise,
      ...pendingChecks.values(),
      ...nodePromises,
      Promise.resolve()
        .then(() => account.close())
        .finally(() => sync.close()),
    ]);
    if (runner) await runner.waitForIdle();
    for (const taskId of interrupted) {
      if ((await store.getTask(taskId)).status === 'running')
        await store.setTaskStatus(taskId, 'failed', STOPPED_TASK_MESSAGE);
    }
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  async function shutdown(reason) {
    closed = true;
    const steps = [
      () => stopExecution(),
      () => recordStop?.(reason),
      () =>
        new Promise((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve())),
        ),
      () => releaseLease?.(),
    ];
    const errors = [];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, errors.map(error => error.message).join('; '));
  }

  server.runtime = runtime;
  server.sync = sync;
  server.shutdown = (reason = 'shutdown') => {
    shutdownPromise ||= shutdown(reason);
    return shutdownPromise;
  };
  server.on('close', () => {
    void stopExecution().catch(backgroundFailure);
  });
  initialized = true;
  if (activeAgent && !execute) {
    preparingInitial = true;
    executorCheckAgent = activeAgent;
    executorCheckPromise = prepareInitialExecutor().finally(() => {
      preparingInitial = false;
      executorCheckPromise = null;
      executorCheckAgent = null;
    });
    if (!managed) await executorCheckPromise;
  }
  return server;
}
