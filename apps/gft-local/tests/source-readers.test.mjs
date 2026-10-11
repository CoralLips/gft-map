import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSourceReaders, connectCodexReadOnly } from '../sourceReaders.mjs';

const SESSION = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const codexSource = { provider: 'codex', id: SESSION };
const claudeSource = { provider: 'claude', id: SESSION, cwd: '/fixture/project' };
const turn = (id, status = 'completed') => ({ id, status, items: [
  { type: 'userMessage', id: `${id}-u`, content: [{ type: 'text', text: `question ${id}` }] },
  { type: 'reasoning', id: `${id}-reason`, summary: 'private reasoning' },
  { type: 'commandExecution', id: `${id}-tool`, aggregatedOutput: 'private tool output' },
  { type: 'agentMessage', id: `${id}-a`, text: `answer ${id}` },
] });

function fakeCodex(initial = [turn('t1'), turn('t2')]) {
  const state = { turns: initial, calls: [], closed: 0 };
  const readers = createSourceReaders({ codexConnect: async () => ({
    close: () => { state.closed++; },
    request: async (method, params) => {
      state.calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: params.threadId, name: 'fixture', cwd: '/fixture', updatedAt: 1700000000 } };
      if (method === 'thread/list') return { data: [{ id: SESSION, name: 'fixture', cwd: '/fixture', updatedAt: 1700000000 }], nextCursor: null };
      assert.equal(method, 'thread/turns/list');
      const after = params.cursor === undefined ? null : Number(params.cursor.slice(1));
      const index = params.cursor?.startsWith('b') ? after : params.sortDirection === 'desc'
        ? (after === null ? state.turns.length - 1 : after - 1)
        : (after === null ? 0 : after + 1);
      if (index < 0 || index >= state.turns.length) return { data: [], nextCursor: null, backwardsCursor: null };
      const next = params.sortDirection === 'desc' ? index > 0 : index < state.turns.length - 1;
      return { data: [state.turns[index]], nextCursor: next ? `n${index}` : null, backwardsCursor: `b${index}` };
    },
  }) });
  return { state, readers };
}

const claudeMessage = (id, type, text, extra = {}) => ({
  type, uuid: id, session_id: SESSION, parent_tool_use_id: null, parent_agent_id: null,
  message: { role: type, content: [{ type: 'text', text }], ...(type === 'assistant' ? { stop_reason: 'end_turn' } : {}) }, ...extra,
});
function fakeClaude(initial = [claudeMessage('u1', 'user', 'question'), claudeMessage('a1', 'assistant', 'answer')]) {
  const state = { messages: initial, calls: [], sessions: [{ sessionId: SESSION, summary: 'first', cwd: '/fixture/project', lastModified: 1700000000000 }] };
  const api = {
    getSessionInfo: async (id, options) => { state.calls.push({ method: 'getSessionInfo', id, options }); return state.sessions.find(s => s.sessionId === id); },
    getSessionMessages: async (id, options) => { state.calls.push({ method: 'getSessionMessages', id, options }); return state.messages; },
    listSessions: async options => { state.calls.push({ method: 'listSessions', options }); return state.sessions; },
    query: () => { assert.fail('must never invoke a model'); },
  };
  return { state, readers: createSourceReaders({ claudeSdk: api }) };
}

test('Codex continuous import stops at captured head; new turns wait for next update', async () => {
  const { state, readers } = fakeCodex();
  const until = await readers.getChatHead(codexSource);
  state.turns.push(turn('t3'));
  let cursor = null; const ids = [];
  for (;;) {
    const delta = await readers.readChatDelta(codexSource, cursor, { limit: 1, until });
    ids.push(...delta.messages.map(message => message.id)); cursor = delta.cursor;
    if (!delta.hasMore) break;
  }
  assert.deepEqual(ids, ['t1-u', 't1-a', 't2-u', 't2-a']);
  assert.deepEqual((await readers.readChatDelta(codexSource, cursor)).messages.map(message => message.id), ['t3-u', 't3-a']);
  state.turns = [turn('t1')];
  await assert.rejects(readers.readChatDelta(codexSource, null, { until }), { code: 'SOURCE_CURSOR_STALE' });
});

test('Claude continuous import stops at captured message UUID; preview is bounded and source-specific', async () => {
  const { state, readers } = fakeClaude();
  const until = await readers.getChatHead(claudeSource);
  state.messages.push(claudeMessage('u2', 'user', 'new question'), claudeMessage('a2', 'assistant', 'new answer'));
  const first = await readers.readChatDelta(claudeSource, null, { limit: 1, until });
  const second = await readers.readChatDelta(claudeSource, first.cursor, { limit: 1, until });
  assert.equal(second.hasMore, false);
  assert.deepEqual(second.messages.map(message => message.id), ['a1']);
  assert.deepEqual((await readers.readChatDelta(claudeSource, second.cursor)).messages.map(message => message.id), ['u2', 'a2']);
  state.messages.push(claudeMessage('a3', 'assistant', 'x'.repeat(20000)));
  const preview = await readers.getChatPreview(claudeSource);
  assert.equal(preview.chars, 6000);
  assert(state.calls.filter(call => call.method === 'getSessionMessages').every(call => call.id === SESSION));
});

test('Codex lists metadata only and addresses thread.id without resume', async () => {
  const { state, readers } = fakeCodex();
  const result = await readers.listChatSessions({ provider: 'codex', query: 'fixture', cwd: '/fixture' });
  assert.equal(result.sessions[0].id, SESSION);
  assert.deepEqual(state.calls.map(c => c.method), ['thread/list']);
  assert.equal(state.calls[0].params.useStateDbOnly, true);
  await readers.getChatSession(codexSource);
  assert.deepEqual(state.calls.at(-1), { method: 'thread/read', params: { threadId: SESSION, includeTurns: false } });
  assert.equal(state.closed, 2);
});

test('Codex message paging neither skips nor repeats and omits tools/reasoning', async () => {
  const { readers } = fakeCodex();
  let cursor = null;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const page = await readers.readChatDelta(codexSource, cursor, { limit: 1 });
    assert.equal(page.messages.length, 1);
    ids.push(page.messages[0].id);
    cursor = page.cursor;
  }
  assert.deepEqual(ids, ['t1-u', 't1-a', 't2-u', 't2-a']);
  const empty = await readers.readChatDelta(codexSource, cursor);
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.hasMore, false);
});

test('Codex head waits for active turn and later reads only its completed content', async () => {
  const { readers, state } = fakeCodex([turn('t1'), turn('t2', 'inProgress')]);
  const head = await readers.getChatHead(codexSource);
  assert.equal(head.position.turnId, 't1');
  assert.deepEqual((await readers.readChatDelta(codexSource, head)).messages, []);
  state.turns[1].status = 'completed';
  const result = await readers.readChatDelta(codexSource, head);
  assert.deepEqual(result.messages.map(m => m.id), ['t2-u', 't2-a']);
  state.turns.push(turn('t3'));
  assert.deepEqual((await readers.readChatDelta(codexSource, result.cursor)).messages.map(m => m.id), ['t3-u', 't3-a']);
});

test('Codex head uses reverse page anchor without reading all historical bodies', async () => {
  const { readers, state } = fakeCodex(Array.from({ length: 100 }, (_, i) => turn(`t${i}`)));
  const head = await readers.getChatHead(codexSource);
  assert.equal(head.position.turnId, 't99');
  assert.equal(state.calls.filter(c => c.method === 'thread/turns/list').length, 1);
  const result = await readers.readChatDelta(codexSource, head);
  assert.equal(result.messages.length, 0);
  assert.equal(state.calls.at(-1).params.cursor, 'b99');
});

test('Codex interrupted/failed terminal turns do not block later completed turns', async () => {
  const { readers } = fakeCodex([turn('t1', 'interrupted'), turn('t2', 'failed'), turn('t3')]);
  assert.equal((await readers.readChatDelta(codexSource)).messages.length, 6);
});

test('Codex defers a latest interrupted draft without final text, then reads it once when completed', async () => {
  const draft = turn('draft', 'interrupted');
  draft.items.at(-1).phase = 'commentary';
  const { readers, state } = fakeCodex([turn('previous'), draft]);
  const head = await readers.getChatHead(codexSource);
  assert.equal(head.position.turnId, 'previous');
  assert.equal((await readers.getChatPreview(codexSource)).text.includes('draft'), false);
  const waiting = await readers.readChatDelta(codexSource, head);
  assert.deepEqual(waiting.messages, []);
  assert.deepEqual(waiting.cursor, head);
  state.turns[1].status = 'completed';
  state.turns[1].items.push({ type: 'agentMessage', id: 'draft-final', text: 'finished', phase: 'final_answer' });
  const complete = await readers.readChatDelta(codexSource, waiting.cursor);
  assert.deepEqual(complete.messages.map(message => message.id), ['draft-u', 'draft-a', 'draft-final']);
  assert.deepEqual((await readers.readChatDelta(codexSource, complete.cursor)).messages, []);
});

test('Codex preserves real interrupted/failed turns until a later turn establishes the boundary', async () => {
  for (const status of ['interrupted', 'failed']) {
    const { readers, state } = fakeCodex([turn('previous'), turn('stopped', status)]);
    const first = await readers.readChatDelta(codexSource);
    assert.deepEqual(first.messages.map(message => message.id), ['previous-u', 'previous-a']);
    assert.equal(first.cursor.position.turnId, 'previous');
    state.turns.push(turn('active', 'inProgress'));
    const next = await readers.readChatDelta(codexSource, first.cursor);
    assert.deepEqual(next.messages.map(message => message.id), ['stopped-u', 'stopped-a']);
    assert.ok(next.messages.every(message => message.turnStatus === status));
    assert.equal((await readers.getChatHead(codexSource)).position.turnId, 'stopped');
    assert.equal(next.cursor.position.turnId, 'stopped');
    assert.deepEqual((await readers.readChatDelta(codexSource, next.cursor)).messages, []);
  }
});

test('Codex final text establishes a boundary despite an interrupted status; inProgress never does', async () => {
  for (const phase of ['final', 'final_answer']) {
    const last = turn('last', 'interrupted');
    last.items.at(-1).phase = phase;
    const { readers } = fakeCodex([last]);
    assert.equal((await readers.getChatHead(codexSource)).position.turnId, 'last');
    assert.equal((await readers.readChatDelta(codexSource)).messages.length, 2);
  }
  const { readers } = fakeCodex([turn('active', 'inProgress'), turn('later')]);
  const delta = await readers.readChatDelta(codexSource);
  assert.deepEqual(delta.messages, []);
  assert.equal(delta.cursor.position, null);
});

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyEntries = (id, status) => [
  { id: `${id}-u`, role: 'user', content: `question ${id}`, turnStatus: status },
  { id: `${id}-a`, role: 'assistant', content: `answer ${id}`, turnStatus: status },
];
const legacyCursor = (id, status, consumed = 2) => ({ v: 1, provider: 'codex', sessionId: SESSION, kind: 'messages',
  position: { before: 'b0', turnId: id, consumed, digest: digest(legacyEntries(id, status).slice(0, consumed)) } });

test('Codex safely upgrades legacy digests across status changes, including bounded reads', async () => {
  for (const status of ['completed', 'interrupted', 'failed']) {
    const { readers } = fakeCodex([turn('old'), turn('new')]);
    const start = legacyCursor('old', status);
    const result = await readers.readChatDelta(codexSource, start);
    assert.deepEqual(result.messages.map(message => message.id), ['new-u', 'new-a']);
    assert.equal(result.cursor.position.digestVersion, 2);
    const bounded = await readers.readChatDelta(codexSource, null, { until: start });
    assert.deepEqual(bounded.messages.map(message => message.id), ['old-u', 'old-a']);
  }
});

test('Codex legacy partial cursors keep every remaining character after status settles', async () => {
  const { readers } = fakeCodex([turn('old')]);
  const start = legacyCursor('old', 'interrupted', 0);
  start.v = 2;
  start.position.offset = 4;
  start.position.messageDigest = digest(legacyEntries('old', 'interrupted')[0]);
  const result = await readers.readChatDelta(codexSource, start, { maxChars: 4 });
  assert.equal(result.messages[0].content, 'tion');
  assert.equal(result.cursor.v, 2);
  assert.equal(result.cursor.position.digestVersion, 2);
  const remainder = await readers.readChatDelta(codexSource, result.cursor);
  assert.equal(result.messages[0].content + remainder.messages[0].content, 'question old'.slice(4));
  assert.equal(remainder.messages[1].id, 'old-a');
});

test('Codex content digests survive status-only changes but never accept edited text or metadata', async () => {
  const { readers, state } = fakeCodex([turn('old')]);
  const start = await readers.getChatHead(codexSource);
  state.turns[0].status = 'interrupted';
  state.turns.push(turn('new'));
  assert.deepEqual((await readers.readChatDelta(codexSource, start)).messages.map(message => message.id), ['new-u', 'new-a']);
  for (const cursor of [start, legacyCursor('old', 'failed')]) {
    for (const change of ['content', 'id', 'phase', 'timestamp']) {
      const copy = structuredClone(state.turns[0]);
      if (change === 'content') state.turns[0].items[0].content[0].text = 'changed';
      else state.turns[0].items[0][change] = 'changed';
      await assert.rejects(readers.readChatDelta(codexSource, cursor), { code: 'SOURCE_CURSOR_STALE' });
      state.turns[0] = copy;
    }
  }
});

test('Codex waits on a previously consumed unfinished anchor without losing its later final answer', async () => {
  for (const status of ['interrupted', 'inProgress']) {
    const { readers, state } = fakeCodex([turn('old', status)]);
    const start = legacyCursor('old', 'interrupted');
    const waiting = await readers.readChatDelta(codexSource, start);
    assert.deepEqual(waiting.messages, []);
    assert.deepEqual(waiting.cursor, start);
    state.turns[0].status = 'completed';
    state.turns[0].items.push({ type: 'agentMessage', id: 'final', text: 'final content', phase: 'final_answer' });
    assert.deepEqual((await readers.readChatDelta(codexSource, waiting.cursor)).messages.map(message => message.id), ['final']);
  }
});

test('Codex rejects changed partial/bounded legacy content and unknown digest versions', async () => {
  const { readers, state } = fakeCodex([turn('old')]);
  const partial = legacyCursor('old', 'interrupted', 0);
  partial.v = 2;
  partial.position.offset = 4;
  partial.position.messageDigest = digest(legacyEntries('old', 'interrupted')[0]);
  state.turns[0].items[0].content[0].text = 'different';
  await assert.rejects(readers.readChatDelta(codexSource, partial), { code: 'SOURCE_CURSOR_STALE' });
  await assert.rejects(readers.readChatDelta(codexSource, null, { until: legacyCursor('old', 'interrupted') }), { code: 'SOURCE_CURSOR_STALE' });
  state.turns[0] = turn('old');
  const unknown = legacyCursor('old', 'completed');
  unknown.position.digestVersion = 99;
  await assert.rejects(readers.readChatDelta(codexSource, unknown), { code: 'SOURCE_CURSOR_INVALID' });
});

test('Codex fixed imports never report completion before an unfinished boundary is reached', async () => {
  for (const blockedStatus of ['inProgress', 'interrupted', 'failed']) {
    const { readers, state } = fakeCodex([turn('first'), turn('last')]);
    const until = await readers.getChatHead(codexSource);
    state.turns[1].status = blockedStatus;
    await assert.rejects(readers.readChatDelta(codexSource, null, { until }), { code: 'SOURCE_NOT_READY' });
    state.turns[1].status = 'completed';
    assert.deepEqual((await readers.readChatDelta(codexSource, null, { until })).messages.map(message => message.id),
      ['first-u', 'first-a', 'last-u', 'last-a']);
  }
  const { readers, state } = fakeCodex([turn('first'), turn('middle'), turn('last')]);
  const until = await readers.getChatHead(codexSource);
  const firstPage = await readers.readChatDelta(codexSource, null, { limit: 2, until });
  state.turns[1].status = 'inProgress';
  await assert.rejects(readers.readChatDelta(codexSource, firstPage.cursor, { until }), { code: 'SOURCE_NOT_READY' });
  state.turns[1].status = 'completed';
  assert.deepEqual((await readers.readChatDelta(codexSource, firstPage.cursor, { until })).messages.map(message => message.id),
    ['middle-u', 'middle-a', 'last-u', 'last-a']);
});

test('Codex scans tool-only turns until actual text or EOF instead of returning an empty resumable page', async () => {
  const emptyTurn = id => ({ id, status: 'completed', items: [{ type: 'commandExecution', id: `${id}-tool`, aggregatedOutput: 'not chat' }] });
  const { readers, state } = fakeCodex([emptyTurn('empty1'), emptyTurn('empty2'), turn('text'), emptyTurn('empty3')]);
  const result = await readers.readChatDelta(codexSource);
  assert.deepEqual(result.messages.map(message => message.id), ['text-u', 'text-a']);
  assert.equal(result.hasMore, false);
  state.turns.push(emptyTurn('empty4'));
  const tail = await readers.readChatDelta(codexSource, result.cursor);
  assert.deepEqual(tail.messages, []);
  assert.equal(tail.hasMore, false);
  state.turns.push(turn('later'));
  assert.deepEqual((await readers.readChatDelta(codexSource, result.cursor)).messages.map(message => message.id), ['later-u', 'later-a']);
});

test('Codex skips long tool-only spans without rejecting the following chat', async () => {
  const { readers, state } = fakeCodex([...Array.from({ length: 1001 }, (_, id) => ({ id: String(id), status: 'completed', items: [] })), turn('later')]);
  const result=await readers.readChatDelta(codexSource);
  assert.deepEqual(result.messages.map(m=>m.id),['later-u','later-a']);
  assert.equal(state.calls.filter(call => call.method === 'thread/turns/list').length, 1002);
});

test('Codex rejects branch/truncation/content changes and a cursor from another session', async () => {
  const { readers, state } = fakeCodex();
  const head = await readers.getChatHead(codexSource);
  await assert.rejects(readers.readChatDelta({ provider: 'codex', id: OTHER }, head), { code: 'SOURCE_CURSOR_INVALID' });
  state.turns[1].items[0].content[0].text = 'edited';
  await assert.rejects(readers.readChatDelta(codexSource, head), { code: 'SOURCE_CURSOR_STALE' });
  state.turns.pop();
  await assert.rejects(readers.readChatDelta(codexSource, head), { code: 'SOURCE_CURSOR_STALE' });
});

test('oversized messages page without loss, including repeated text and Unicode', async () => {
  const text = '很长的材料😀\n'.repeat(20000);
  const t = turn('huge'); t.items[0].content[0].text = text;
  for (const [source, readers] of [[codexSource, fakeCodex([t]).readers],
    [claudeSource, fakeClaude([claudeMessage('huge-u','user',text),claudeMessage('huge-a','assistant','done')]).readers]]) {
    const until = await readers.getChatHead(source);
    let cursor = null; const parts = [], ids = [];
    for (let n = 0; n < 20; n++) {
      const page = await readers.readChatDelta(source,cursor,{maxChars:60000,until});
      for (const m of page.messages) { if (m.role === 'user') {parts.push(m.content);ids.push(m.id);} assert.ok(m.content.length <= 60000); }
      assert.notDeepEqual(page.cursor,cursor); cursor = page.cursor;
      if (!page.hasMore) break;
    }
    assert.equal(parts.join(''),text);
    assert.equal(new Set(ids).size,ids.length);
    assert.equal((await readers.readChatDelta(source,cursor)).messages.length,0);
  }
});

test('limits do not advance past data that was not returned', async () => {
  const { readers } = fakeCodex();
  const page = await readers.readChatDelta(codexSource, null, { maxChars: 15 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal((await readers.readChatDelta(codexSource, page.cursor)).messages[0].id, 't1-a');
});

test('unknown providers, cursor shape and unsupported turn content fail explicitly', async () => {
  const { readers, state } = fakeCodex();
  await assert.rejects(readers.getChatSession({ provider: 'other', id: SESSION }), { code: 'SOURCE_UNSUPPORTED' });
  await assert.rejects(readers.getChatSession({ provider: 'codex', id: 'my title' }), { code: 'SOURCE_INVALID' });
  await assert.rejects(readers.readChatDelta(codexSource, { offset: 3 }), { code: 'SOURCE_CURSOR_INVALID' });
  state.turns[0].status = 'unknown';
  await assert.rejects(readers.readChatDelta(codexSource), { code: 'SOURCE_CAPABILITY_MISSING' });
  state.turns[0].status = 'completed';
  delete state.turns[0].items;
  await assert.rejects(readers.readChatDelta(codexSource), { code: 'SOURCE_CAPABILITY_MISSING' });
});

test('Claude reads only selected session, filters tool/system/compaction, waits for completion', async () => {
  const { readers, state } = fakeClaude([
    claudeMessage('u1', 'user', 'real question'),
    claudeMessage('summary', 'user', 'compressed injection', { isCompactSummary: true }),
    claudeMessage('system', 'system', 'system injection'),
    claudeMessage('tool', 'user', '', { message: { content: [{ type: 'text', text: 'tool wrapper' }, { type: 'tool_result', content: 'tool output' }] } }),
    claudeMessage('a1', 'assistant', 'real answer'),
    claudeMessage('u2', 'user', 'unfinished question'),
    claudeMessage('a2', 'assistant', 'still working', { message: { content: [{ type: 'text', text: 'still working' }], stop_reason: 'tool_use' } }),
  ]);
  const first = await readers.readChatDelta(claudeSource);
  assert.deepEqual(first.messages.map(m => m.id), ['u1', 'a1']);
  assert.equal(state.calls.find(c => c.method === 'getSessionMessages').options.dir, '/fixture/project');
  state.messages.push(claudeMessage('a3', 'assistant', 'finished'));
  assert.deepEqual((await readers.readChatDelta(claudeSource, first.cursor)).messages.map(m => m.id), ['u2', 'a2', 'a3']);
  assert.equal(state.calls.some(c => c.method === 'listSessions'), false);
});

test('Claude message UUID cursors detect branch replacement and preserve paging', async () => {
  const { readers, state } = fakeClaude();
  const first = await readers.readChatDelta(claudeSource, null, { limit: 1 });
  assert.equal(first.hasMore, true);
  const second = await readers.readChatDelta(claudeSource, first.cursor, { limit: 1 });
  assert.deepEqual(second.messages.map(m => m.id), ['a1']);
  const head = await readers.getChatHead(claudeSource);
  assert.equal((await readers.readChatDelta(claudeSource, head)).messages.length, 0);
  state.messages[1].uuid = 'fork-a1';
  await assert.rejects(readers.readChatDelta(claudeSource, head), { code: 'SOURCE_CURSOR_STALE' });
});

test('Claude metadata discovery scopes a project and fails stale list pagination', async () => {
  const { readers, state } = fakeClaude();
  state.sessions.push({ sessionId: OTHER, summary: 'second', cwd: '/fixture/project', lastModified: 1600000000000 });
  const first = await readers.listChatSessions({ provider: 'claude', cwd: '/fixture/project', limit: 1 });
  assert.equal(first.sessions[0].id, SESSION);
  const second = await readers.listChatSessions({ provider: 'claude', cwd: '/fixture/project', limit: 1, cursor: first.nextCursor });
  assert.equal(second.sessions[0].id, OTHER);
  assert.equal(second.nextCursor, null);
  assert.ok(state.calls.every(c => c.method === 'listSessions'));
  assert.equal(state.calls[0].options.includeWorktrees, false);
  state.sessions.reverse();
  await assert.rejects(readers.listChatSessions({ provider: 'claude', cwd: '/fixture/project', cursor: first.nextCursor }), { code: 'SOURCE_CURSOR_STALE' });
});

test('Claude missing selected session fails rather than returning an empty successful delta', async () => {
  const { readers } = fakeClaude();
  await assert.rejects(readers.readChatDelta({ ...claudeSource, id: OTHER }), { code: 'SOURCE_NOT_FOUND' });
});

test('Claude discovery is global metadata by default, never scoped to the installation cwd', async () => {
  const { readers, state } = fakeClaude();
  const result = await readers.listChatSessions({ provider: 'claude' });
  assert.equal(result.sessions[0].id, SESSION);
  assert.equal(Object.hasOwn(state.calls[0].options, 'dir'), false);
  assert.deepEqual(state.calls.map(call => call.method), ['listSessions']);
});

test('app-server transport sends only read RPCs and closes without starting a model', async () => {
  const methods = [];
  let killed = false;
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { killed = true; child.stdout.end(); };
  child.stdin.on('data', buffer => {
    for (const line of buffer.toString().trim().split('\n')) {
      const request = JSON.parse(line);
      methods.push(request.method);
      if (request.id !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
    }
  });
  const connection = await connectCodexReadOnly({ binary: '/fixture/codex', spawnImpl: (_binary, args, options) => {
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
    assert.equal(options.shell, false);
    return child;
  } });
  await connection.request('thread/read', { threadId: SESSION, includeTurns: false });
  assert.throws(() => connection.request('turn/start', {}), { code: 'SOURCE_READ_ONLY' });
  connection.close();
  assert.equal(killed, true);
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/read']);
});

test('app-server timeout fails visibly and terminates its read-only process', async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { killed = true; child.stdout.end(); };
  await assert.rejects(connectCodexReadOnly({ timeoutMs: 10, spawnImpl: () => child }), { code: 'SOURCE_TIMEOUT' });
  assert.equal(killed, true);
});

test('official Claude SDK selects the active UUID branch and preserves stale-cursor detection', async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const entry = (uuid, parentUuid, type, text) => ({
    uuid, parentUuid, type, sessionId: SESSION, cwd: '/fixture/project', timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: type, content: text, ...(type === 'assistant' ? { id: `msg-${uuid}`, stop_reason: 'end_turn' } : {}) },
  });
  const entries = [entry('u1', null, 'user', 'root question'), entry('a1', 'u1', 'assistant', 'root answer'),
    entry('u2', 'a1', 'user', 'old branch question'), entry('a2', 'u2', 'assistant', 'old branch answer')];
  const sessionStore = { load: async key => key.sessionId === SESSION ? entries : null };
  const readers = createSourceReaders({ claudeSdk: {
    getSessionInfo: (id, options) => sdk.getSessionInfo(id, { ...options, sessionStore }),
    getSessionMessages: (id, options) => sdk.getSessionMessages(id, { ...options, sessionStore }),
  } });
  const head = await readers.getChatHead(claudeSource);
  entries.push(entry('u3', 'a1', 'user', 'new branch question'), entry('a3', 'u3', 'assistant', 'new branch answer'));
  const result = await readers.readChatDelta(claudeSource);
  assert.deepEqual(result.messages.map(m => m.id), ['u1', 'a1', 'u3', 'a3']);
  await assert.rejects(readers.readChatDelta(claudeSource, head), { code: 'SOURCE_CURSOR_STALE' });
});

test('official Claude SDK skips compaction/tail fragments, including an isolated standalone bundle', async () => {
  // The SDK resolves dir before encoding its project key. Windows runners can
  // expose an 8.3 TEMP alias; seed the transcript under the canonical path too.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gft-source-fixture-')));
  try {
    const cwd = join(root, 'project');
    await mkdir(cwd, { recursive: true });
    const projectDir = join(root, 'config', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
    await mkdir(projectDir, { recursive: true });
    const records = [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'fixture question' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'msg-a1', role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: 'a1', content: 'system boundary' },
      { type: 'user', uuid: 'summary', parentUuid: 'c1', isCompactSummary: true, message: { role: 'user', content: 'injected summary, not user input' } },
      { type: 'user', uuid: 'u2', parentUuid: 'summary', message: { role: 'user', content: 'second real question' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'msg-a2', role: 'assistant', content: [{ type: 'text', text: 'second real answer' }], stop_reason: 'end_turn' } },
    ].map(record => ({ ...record, sessionId: SESSION, cwd, timestamp: '2026-01-01T00:00:00.000Z', isSidechain: false }));
    await writeFile(join(projectDir, `${SESSION}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n{"type":"assistant","uuid":"partial');
    const script = fileURLToPath(new URL('./fixtures/claude-source-reader-child.mjs', import.meta.url));
    const bundlePath = join(root, 'standalone-sources.mjs');
    // Same packaging settings as build.mjs, but no SDK files/node_modules are
    // copied beside the bundle. This exercises only the official read helpers.
    await build({ entryPoints: [fileURLToPath(new URL('../sourceReaders.mjs', import.meta.url))], outfile: bundlePath,
      bundle: true, platform: 'node', format: 'esm', target: 'node20',
      banner: { js: "import { createRequire as __gftCreateRequire } from 'node:module'; const require = __gftCreateRequire(import.meta.url);" } });
    for (const modulePath of ['', bundlePath]) {
      const child = spawn(process.execPath, ['--preserve-symlinks', script, SESSION, cwd, modulePath], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'config') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(exitCode, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), { ids: ['u1', 'a1', 'u2', 'a2'], hasMore: false });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
