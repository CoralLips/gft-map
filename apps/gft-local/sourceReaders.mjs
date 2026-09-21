import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

// This module never starts/resumes a conversation or calls an inference API.
const READ_METHODS = new Set(['initialize', 'thread/list', 'thread/read', 'thread/turns/list', 'model/list']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_TURNS = new Set(['completed', 'interrupted', 'failed']);

export class SourceReaderError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SourceReaderError';
    this.code = code;
  }
}

function fail(code, message) { throw new SourceReaderError(code, message); }
function providerOf(provider) {
  if (provider !== 'codex' && provider !== 'claude') fail('SOURCE_UNSUPPORTED', '目前只支持本机 Codex 和 Claude Code 会话。');
  return provider;
}
function sourceOf(source) {
  if (!source || !UUID.test(source.id || '')) fail('SOURCE_INVALID', '请使用真实会话 ID，不能用会话名称代替。');
  return { ...source, provider: providerOf(source.provider) };
}
function bounded(value, fallback, maximum) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) fail('SOURCE_INVALID', '读取数量超出允许范围。');
  return n;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function initialCursor(source) { return { v: 1, provider: source.provider, sessionId: source.id, kind: 'messages', position: null }; }
function decodeCursor(source, cursor) {
  if (cursor === null || cursor === undefined) return initialCursor(source);
  if (typeof cursor !== 'object' || ![1,2].includes(cursor.v) || cursor.kind !== 'messages'
      || cursor.provider !== source.provider || cursor.sessionId !== source.id
      || !Object.hasOwn(cursor, 'position')) fail('SOURCE_CURSOR_INVALID', '来源游标无效或属于另一场会话，请重新选择读取起点。');
  return cursor;
}
function changed() { fail('SOURCE_CURSOR_STALE', '已读位置发生变化：会话可能被截断、压缩或切换分支。请重新选择读取起点。'); }
function dateOf(value) {
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  return typeof value === 'string' ? value : null;
}
function codexDescriptor(thread) {
  if (!thread?.id || !UUID.test(thread.id)) fail('SOURCE_RESPONSE_INVALID', 'Codex 没有返回有效会话标识。');
  return { provider: 'codex', id: thread.id, title: thread.name || thread.title || thread.preview || thread.id,
    cwd: thread.cwd || null, updatedAt: dateOf(thread.updatedAt) };
}
function claudeDescriptor(session) {
  return { provider: 'claude', id: session.sessionId, title: session.customTitle || session.summary || session.sessionId,
    cwd: session.cwd || null, updatedAt: dateOf(session.lastModified) };
}
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' || block?.type === 'input_text')
    .map(block => block.text || '').filter(Boolean).join('\n');
}
function codexMessages(turn) {
  if (!Array.isArray(turn.items)) fail('SOURCE_CAPABILITY_MISSING', '当前 Codex 未提供完整消息内容，请升级本地 Codex。');
  return turn.items.flatMap(item => {
    const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'assistant' : null;
    if (!role) return [];
    const content = (role === 'assistant' ? item.text : textContent(item.content)) || '';
    if (!content.trim()) return [];
    if (!item.id) fail('SOURCE_RESPONSE_INVALID', 'Codex 消息缺少稳定标识，无法安全记录读取位置。');
    return [{ id: String(item.id), role, content, turnStatus: turn.status,
      ...(item.phase ? { phase: item.phase } : {}), ...(item.timestamp ? { timestamp: item.timestamp } : {}) }];
  });
}
function terminalTurn(turn) {
  if (TERMINAL_TURNS.has(turn.status)) return true;
  if (turn.status === 'inProgress') return false;
  fail('SOURCE_CAPABILITY_MISSING', 'Codex 返回了尚未支持的轮次状态，请升级会话读取组件。');
}

/** A short-lived, read-only app-server connection. No thread/start or turn/start exists here. */
export async function connectCodexReadOnly({ binary = process.env.GFT_CODEX_BIN || 'codex', timeoutMs = 20000, spawnImpl = spawn } = {}) {
  if (/\.(?:cmd|bat|ps1)$/i.test(binary)) fail('SOURCE_CAPABILITY_MISSING', '请配置原生 Codex 可执行文件，不能使用 shell 包装脚本。');
  const child = spawnImpl(binary, ['app-server', '--listen', 'stdio://'], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0;
  let stopped = false;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  const rejectAll = error => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  const close = () => {
    if (stopped) return;
    stopped = true;
    lines.close();
    child.stdin.end();
    child.kill();
    rejectAll(new SourceReaderError('SOURCE_CONNECTION_CLOSED', '本地会话读取连接已关闭。'));
  };
  child.stderr.on('data', () => {}); // Drain diagnostics without exposing transcript/config contents.
  child.stdin.on('error', () => {});
  child.once('error', error => rejectAll(new SourceReaderError('SOURCE_CAPABILITY_MISSING', '无法启动本地 Codex 只读接口，请检查 Codex 安装。', error)));
  child.once('exit', () => {
    rejectAll(new SourceReaderError('SOURCE_CONNECTION_CLOSED', 'Codex 只读接口提前退出。'));
    lines.close();
  });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only client does not execute server requests' } }) + '\n');
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      const code = message.error.code === -32601 || /unsupported|not supported|experimental/i.test(message.error.message || '')
        ? 'SOURCE_CAPABILITY_MISSING' : 'SOURCE_READ_FAILED';
      request.reject(new SourceReaderError(code, code === 'SOURCE_CAPABILITY_MISSING'
        ? '当前 Codex 不支持所需的只读会话接口，请升级 Codex。' : '无法读取所选 Codex 会话。', message.error));
    } else request.resolve(message.result);
  });
  const request = (method, params) => {
    if (!READ_METHODS.has(method)) fail('SOURCE_READ_ONLY', '来源接口只允许读取会话。');
    if (stopped) fail('SOURCE_CONNECTION_CLOSED', '本地会话读取连接已关闭。');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new SourceReaderError('SOURCE_TIMEOUT', '本地会话读取超时，请重试。')); close(); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
  try {
    await request('initialize', { clientInfo: { name: 'gft_history_reader', title: 'GFT history reader', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return { request, close };
  } catch (error) { close(); throw error; }
}

async function defaultClaudeSdk() {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    if (!sdk.getSessionInfo || !sdk.getSessionMessages || !sdk.listSessions) throw new Error('missing history helpers');
    return sdk;
  } catch (error) { throw new SourceReaderError('SOURCE_CAPABILITY_MISSING', 'Claude Code 会话读取组件未安装或版本过旧，请重新安装本地 GFT。', error); }
}

export function createSourceReaders({ codexConnect = connectCodexReadOnly, claudeSdk = defaultClaudeSdk } = {}) {
  const sdk = async () => typeof claudeSdk === 'function' ? claudeSdk() : claudeSdk;
  const withCodex = async fn => {
    const connection = await codexConnect();
    try { return await fn(connection.request); } finally { connection.close(); }
  };
  const codexSession = async (request, source) => {
    const result = await request('thread/read', { threadId: source.id, includeTurns: false });
    if (!result?.thread || result.thread.id !== source.id) fail('SOURCE_NOT_FOUND', '没有找到指定的 Codex 会话。');
    return codexDescriptor(result.thread);
  };
  const claudeSession = async (api, source) => {
    const result = await api.getSessionInfo(source.id, source.cwd ? { dir: source.cwd } : undefined);
    if (!result || result.sessionId !== source.id) fail('SOURCE_NOT_FOUND', '没有找到指定的 Claude Code 会话，请检查来源目录。');
    return claudeDescriptor(result);
  };
  const turns = async (request, source, cursor, direction = 'asc') => {
    const result = await request('thread/turns/list', { threadId: source.id, limit: 1, sortDirection: direction, itemsView: 'full', ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) fail('SOURCE_RESPONSE_INVALID', 'Codex 未返回有效的会话分页。');
    return result;
  };

  async function getChatSession(input) {
    const source = sourceOf(input);
    return source.provider === 'codex' ? withCodex(request => codexSession(request, source)) : claudeSession(await sdk(), source);
  }

  async function listChatSessions({ provider, query = '', cursor = null, limit = 30, cwd } = {}) {
    providerOf(provider);
    limit = bounded(limit, 30, 200);
    query = String(query).trim();
    const scope = { provider, query, cwd: cwd || null };
    if (cursor && (cursor.v !== 1 || cursor.kind !== 'sessions' || cursor.scope !== hash(scope))) fail('SOURCE_CURSOR_INVALID', '会话列表游标已失效，请重新加载列表。');
    if (UUID.test(query)) {
      if (cursor) return { sessions: [], nextCursor: null };
      try { return { sessions: [await getChatSession({ provider, id: query, ...(cwd ? { cwd } : {}) })], nextCursor: null }; }
      catch (error) { if (error.code === 'SOURCE_NOT_FOUND') return { sessions: [], nextCursor: null }; throw error; }
    }
    if (provider === 'codex') return withCodex(async request => {
      const result = await request('thread/list', { limit, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true,
        ...(query ? { searchTerm: query } : {}), ...(cwd ? { cwd } : {}), ...(cursor?.native ? { cursor: cursor.native } : {}) });
      if (!Array.isArray(result?.data)) fail('SOURCE_RESPONSE_INVALID', 'Codex 未返回有效会话列表。');
      return { sessions: result.data.map(codexDescriptor), nextCursor: result.nextCursor
        ? { v: 1, kind: 'sessions', scope: hash(scope), native: result.nextCursor } : null };
    });
    const api = await sdk();
    // Global discovery uses the SDK's head/tail metadata reads, not full bodies.
    // Only an explicit directory scopes discovery; an installation cwd is not a user's project.
    const sessions = (await api.listSessions({ ...(cwd ? { dir: cwd } : {}), includeWorktrees: false, includeProgrammatic: false }))
      .map(claudeDescriptor).filter(session => !query || `${session.title}\n${session.id}`.toLowerCase().includes(query.toLowerCase()));
    const offset = cursor?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset && sessions[offset - 1]?.id !== cursor.anchor)) fail('SOURCE_CURSOR_STALE', '会话列表已经变化，请重新加载列表。');
    const page = sessions.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return { sessions: page, nextCursor: nextOffset < sessions.length
      ? { v: 1, kind: 'sessions', scope: hash(scope), offset: nextOffset, anchor: page.at(-1).id } : null };
  }

  const claudeComplete = async (api, source) => {
    const descriptor = await claudeSession(api, source);
    // Official SDK resolves parentUuid branches and compaction; no query()/resume() is used.
    const raw = await api.getSessionMessages(source.id, { ...(source.cwd || descriptor.cwd ? { dir: source.cwd || descriptor.cwd } : {}), includeSystemMessages: false });
    if (!Array.isArray(raw)) fail('SOURCE_RESPONSE_INVALID', 'Claude Code 未返回有效消息列表。');
    let complete = -1;
    for (let i = 0; i < raw.length; i++) {
      const message = raw[i];
      if (message.type === 'assistant' && !message.interruptedByShutdown
          && ['end_turn', 'stop_sequence', 'max_tokens'].includes(message.message?.stop_reason)) complete = i;
    }
    const messages = [];
    const ids = new Set();
    for (const item of raw.slice(0, complete + 1)) {
      if (!['user', 'assistant'].includes(item.type) || item.isMeta || item.is_meta || item.isCompactSummary || item.parent_tool_use_id || item.parent_agent_id) continue;
      if (item.type === 'user' && Array.isArray(item.message?.content) && item.message.content.some(block => block?.type === 'tool_result')) continue;
      if (item.session_id && item.session_id !== source.id) fail('SOURCE_RESPONSE_INVALID', 'Claude Code 返回了不属于所选会话的消息。');
      const content = textContent(item.message?.content);
      if (!content.trim()) continue;
      if (!item.uuid || ids.has(item.uuid)) fail('SOURCE_RESPONSE_INVALID', 'Claude Code 消息标识缺失或重复，无法安全读取。');
      ids.add(item.uuid);
      messages.push({ id: item.uuid, role: item.type, content, ...(item.timestamp ? { timestamp: item.timestamp } : {}) });
    }
    return messages;
  };

  async function getChatHead(input) {
    const source = sourceOf(input);
    const cursor = initialCursor(source);
    if (source.provider === 'claude') {
      const messages = await claudeComplete(await sdk(), source);
      if (messages.length) cursor.position = { id: messages.at(-1).id, digest: hash(messages.at(-1)) };
      return cursor;
    }
    return withCodex(async request => {
      await codexSession(request, source);
      let native = null;
      const visited = new Set();
      for (;;) {
        if (visited.has(native)) fail('SOURCE_CURSOR_STALE','来源分页未推进，请更新 Codex 后重试。');
        visited.add(native);
        const page = await turns(request, source, native, 'desc');
        const turn = page.data[0];
        if (!turn) return cursor;
        if (terminalTurn(turn)) {
          // Native backwardsCursor replays this page's first turn inclusively.
          // It is not the exclusive nextCursor of the preceding turn.
          const before = page.backwardsCursor;
          if (!before) fail('SOURCE_CAPABILITY_MISSING', 'Codex 缺少双向会话游标，请升级 Codex。');
          const messages = codexMessages(turn);
          cursor.position = { before, turnId: turn.id, consumed: messages.length, digest: hash(messages) };
          return cursor;
        }
        if (!page.nextCursor) return cursor;
        native = page.nextCursor;
      }
    });
  }

  async function getChatPreview(input) {
    const source = sourceOf(input);
    let selected = [];
    if (source.provider === 'claude') selected = (await claudeComplete(await sdk(), source)).slice(-12);
    else selected = await withCodex(async request => {
      await codexSession(request, source);
      let native = null; const entries = [];
      for (let i = 0; i < 12; i++) {
        const page = await turns(request, source, native, 'desc');
        const turn = page.data[0];
        if (!turn) break;
        if (terminalTurn(turn)) entries.unshift(...codexMessages(turn));
        if (entries.length >= 12 || !page.nextCursor) break;
        native = page.nextCursor;
      }
      return entries.slice(-12);
    });
    const text = selected.map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`).join('\n\n').slice(-6000);
    return { text, chars: text.length, description: '所选会话最近已结束的消息节选，最多 6000 字符' };
  }

  async function readChatDelta(input, suppliedCursor = null, { limit = 100, maxChars = 60000, until } = {}) {
    const source = sourceOf(input);
    limit = bounded(limit, 100, 1000);
    maxChars = Math.max(2, bounded(maxChars, 60000, 1000000));
    const start = decodeCursor(source, suppliedCursor);
    const end = until === undefined ? undefined : decodeCursor(source, until);
    if (end && !end.position) return { messages: [], cursor: start, hasMore: false };
    const messages = [];
    let chars = 0;
    const append = (message, offset = 0) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= message.content.length) changed();
      if (messages.length >= limit || (messages.length && chars + message.content.length - offset > maxChars)) return null;
      let next = Math.min(message.content.length, offset + maxChars - chars);
      // Never cut a Unicode surrogate pair. Fragment IDs include the offset so
      // equal adjacent passages remain distinct receipts in the source Log.
      if (next < message.content.length && /[\uD800-\uDBFF]/.test(message.content[next - 1])) next--;
      const content = message.content.slice(offset,next);
      messages.push({...message,content,...(offset || next < message.content.length ? {id:`${message.id}#gft-part-${offset}`} : {})});
      chars += content.length;
      return next;
    };
    if (source.provider === 'claude') {
      const all = await claudeComplete(await sdk(), source);
      let endOffset = all.length;
      if (end?.position) {
        const index = all.findIndex(message => message.id === end.position.id);
        if (index < 0 || hash(all[index]) !== end.position.digest) changed();
        endOffset = index + 1;
      }
      let offset = 0, charOffset = 0;
      if (start.position) {
        if (typeof start.position.id !== 'string' || typeof start.position.digest !== 'string') fail('SOURCE_CURSOR_INVALID', 'Claude Code 来源游标格式无效。');
        const index = all.findIndex(message => message.id === start.position.id);
        if (index < 0 || hash(all[index]) !== start.position.digest) changed();
        offset = index + (start.position.offset === undefined ? 1 : 0);
        charOffset = start.position.offset ?? 0;
      }
      let cursor = start;
      for (; offset < endOffset; offset++) {
        const next = append(all[offset], charOffset);
        if (next === null) break;
        const partial = next < all[offset].content.length;
        cursor = { ...start, v:partial ? 2 : 1, position: { id: all[offset].id, digest: hash(all[offset]), ...(partial ? {offset:next} : {}) } };
        if (partial) break;
        charOffset = 0;
      }
      return { messages, cursor, hasMore: offset < endOffset };
    }
    return withCodex(async request => {
      await codexSession(request, source);
      let native = start.position?.before ?? null;
      let cursor = start;
      let anchor = start.position;
      if (anchor && (typeof anchor.turnId !== 'string' || !Number.isSafeInteger(anchor.consumed) || anchor.consumed < 0 || typeof anchor.digest !== 'string'
          || (anchor.before !== null && typeof anchor.before !== 'string'))) fail('SOURCE_CURSOR_INVALID', 'Codex 来源游标格式无效。');
      const visited = new Set();
      for (;;) {
        if (visited.has(native)) fail('SOURCE_CURSOR_STALE','来源分页未推进，请更新 Codex 后重试。');
        visited.add(native);
        const page = await turns(request, source, native);
        const turn = page.data[0];
        if (anchor && (!turn || turn.id !== anchor.turnId || !terminalTurn(turn))) changed();
        if (!turn || !terminalTurn(turn)) {
          if (end?.position) changed();
          return { messages, cursor, hasMore: false };
        }
        const entries = codexMessages(turn);
        const lastTurn = end?.position?.turnId === turn.id;
        const endConsumed = lastTurn ? end.position.consumed : entries.length;
        if (lastTurn && (!Number.isSafeInteger(endConsumed) || endConsumed < 0 || endConsumed > entries.length || hash(entries.slice(0, endConsumed)) !== end.position.digest)) changed();
        let consumed = anchor?.consumed ?? 0;
        if (anchor && (consumed > entries.length || hash(entries.slice(0, consumed)) !== anchor.digest)) changed();
        let offset = anchor?.offset ?? 0;
        if (anchor?.offset !== undefined && (!entries[consumed] || hash(entries[consumed]) !== anchor.messageDigest)) changed();
        anchor = null;
        for (; consumed < endConsumed; consumed++) {
          const next = append(entries[consumed],offset);
          if (next === null) return { messages, cursor, hasMore: true };
          if (next < entries[consumed].content.length) return {messages,hasMore:true,cursor:{...start,v:2,position:{before:native,turnId:turn.id,consumed,digest:hash(entries.slice(0,consumed)),offset:next,messageDigest:hash(entries[consumed])}}};
          offset = 0;
          cursor = { ...start, v:1, position: { before: native, turnId: turn.id, consumed: consumed + 1, digest: hash(entries.slice(0, consumed + 1)) } };
        }
        // Keep an anchor even for a completed turn without user-visible text.
        cursor = { ...start, v:1, position: { before: native, turnId: turn.id, consumed: endConsumed, digest: hash(entries.slice(0, endConsumed)) } };
        if (lastTurn) return { messages, cursor, hasMore: false };
        if (!page.nextCursor) {
          if (end?.position) changed();
          return { messages, cursor, hasMore: false };
        }
        native = page.nextCursor;
      }
    });
  }

  return { listChatSessions, getChatSession, getChatHead, getChatPreview, readChatDelta };
}

const readers = createSourceReaders();
// A metadata query only; no conversation or inference is created.
export async function getCodexDefaults(options) {
  const client = await connectCodexReadOnly(options);
  try {
    let cursor;
    do {
      const page = await client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      const item = page.data?.find(model => model.isDefault);
      if (item?.model) return { model: item.model, ...(item.defaultReasoningEffort ? {effort:item.defaultReasoningEffort} : {}) };
      cursor = page.nextCursor;
    } while (cursor);
    fail('MODEL_DEFAULT_MISSING', '执行器未提供默认模型，请更新 Codex 后重试。');
  } finally { client.close(); }
}
export const listChatSessions = readers.listChatSessions;
export const getChatSession = readers.getChatSession;
export const getChatHead = readers.getChatHead;
export const getChatPreview = readers.getChatPreview;
export const readChatDelta = readers.readChatDelta;
