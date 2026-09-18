import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { memoryDocument, sourcePage } from './memory.mjs';
import { createTopicBundle, parseTopicBundle, topicSummary } from './dist/core.mjs';
import { createLedger, viewTopic, editDocument, editGraph, prepareTask, applyTask, prepareImport, parseImportSummary, prepareSourceRedraw, appendSourceLog, readSourceLog, sourceRecordsFromEvents, renderSourceLog } from './dist/core.mjs';

export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const checkedId = id => { if (!idPattern.test(id || '')) throw fail('无效的记录 ID'); return id; };
export const homeDir = () => path.resolve(process.env.GFT_LOCAL_HOME || path.join(homedir(), '.gft-local'));
const file = (kind, id) => path.join(homeDir(), kind, `${checkedId(id)}.json`);
async function jsonRead(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') throw fail('记录不存在', 404); throw e; } }
async function atomic(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, p); break; }
      catch (error) {
        // Windows readers and file scanners can briefly hold the destination.
        // Keep the complete temporary file and retry only this atomic replace.
        if (process.platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 19) throw error;
        await new Promise(resolve => setTimeout(resolve,25));
      }
    }
  }
  finally { await unlink(tmp).catch(() => {}); }
}
// A short filesystem lock covers read/version-check/write across CLI and panel processes.
async function locked(kind, id, run) {
  const p = `${file(kind, id)}.lock`;
  await mkdir(path.dirname(p), { recursive: true });
  try { await writeFile(p, String(process.pid), { flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') throw fail('此记录正在保存，请稍后重试；异常退出后可用 recover 恢复。', 409); throw e; }
  try { return await run(); } finally { await unlink(p).catch(() => {}); }
}
async function list(kind) {
  const dir = path.join(homeDir(), kind);
  await mkdir(dir, { recursive: true });
  const names = await readdir(dir);
  return Promise.all(names.filter(n => n.endsWith('.json')).map(n => jsonRead(path.join(dir, n))));
}
const meta = ({ id, name, scope, revision, updatedAt, archived }) => ({ id, name, scope, revision, updatedAt, status: archived ? 'archived' : 'active' });
export async function listTopics() { return (await list('topics')).filter(t => !t.archived).map(meta).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
export const getTopic = async id => {
  const topic = await jsonRead(file('topics', id));
  // Adopt old saved source snapshots without changing the document, revision or cursors.
  const events = [...await storedSourceEvents(id), ...Object.values(topic.sourceUpdates || {})];
  return {...topic, raw: appendSourceLog(topic.raw, sourceRecordsFromEvents(events))};
};
export const getView = async id => viewTopic(await getTopic(id));
export async function getSnapshot(id) {
  const { id: topicId, name, scope, revision, ledger, raw, panel } = await getTopic(id);
  return { topic: { id: topicId, name, scope, revision, ledger, raw, panel } };
}
export async function getTopicIndex(id) {
  const topic = await jsonRead(file('topics', id));
  return { ...meta(topic), summary: topicSummary(topic.ledger) };
}
// Notifications only inspect the selected topic's published view, never read chat files or source archives.
export async function getNoticeView(id) {
  const topic = await jsonRead(file('topics',id));
  if (topic.archived) return null;
  return viewTopic(topic);
}
export async function createTopic(name, scope = '', data, requestedId) {
  if (typeof name !== 'string' || !name.trim() || typeof scope !== 'string') throw fail('请填写有效的脉络名称与主题文本');
  const id = requestedId === undefined ? randomUUID() : checkedId(requestedId);
  const topic = { id, name: name.trim(), scope: scope.trim(), ledger: data?.ledger ?? createLedger(scope.trim()), raw: data?.raw ?? '', ...(data?.panel ? {panel: data.panel} : {}), revision: 1, updatedAt: new Date().toISOString() };
  const view = viewTopic(topic);
  topic.scope = view.scope;
  await locked('topics', id, async () => {
    try { await getTopic(id); } catch (error) {
      if (error.status !== 404) throw error;
      await atomic(file('topics', id), topic); return;
    }
    throw fail('该脉络已经存在，请重新创建',409);
  });
  return view;
}
async function mutateTopic(id, baseRevision, change, taskId, advanceRevision = true) {
  return locked('topics', id, async () => {
    const current = await getTopic(id);
    if (taskId && current.appliedTasks?.[taskId]) return { view: viewTopic(current), resultRevision: current.appliedTasks[taskId] };
    if (current.revision !== baseRevision) throw fail('主题已被另一处修改。请重新读取后再保存，当前内容未被覆盖。', 409);
    const delta = await change(current);
    const next = { ...current, ...delta, revision: current.revision + (advanceRevision ? 1 : 0), updatedAt: advanceRevision ? new Date().toISOString() : current.updatedAt };
    if (taskId) next.appliedTasks = { ...current.appliedTasks, [taskId]: next.revision };
    const view = viewTopic(next);
    // Theme is derived from the same current record; manual Doc changes must affect future extraction.
    // Empty themes are editable drafts. Enforce the boundary when generating,
    // not while saving, renaming or archiving a person's work.
    next.scope = view.scope;
    await atomic(file('topics', id), next);
    const saved = viewTopic(next);
    return taskId ? { view: saved, resultRevision: next.revision } : saved;
  });
}
export const saveDoc = (id, revision, doc) => {
  if (typeof doc !== 'string') throw fail('文档必须是文本');
  return mutateTopic(id, revision, topic => editDocument(topic, doc));
};
export const saveGraph = (id, revision, op) => mutateTopic(id, revision, topic => editGraph(topic, op));
// The shared panel owns all graph/Doc actions. Persist its resulting ledger once,
// rather than applying the model response a second time on the server.
export const saveState = (id, revision, map) => {
  if (!map || typeof map.ledger !== 'string' || typeof map.raw !== 'string'
    || !Array.isArray(map.nodes) || !Array.isArray(map.edges)
    || !map.watermarks || typeof map.watermarks !== 'object') throw fail('面板状态无效');
  return mutateTopic(id, revision, topic => ({ ledger: map.ledger, raw: appendSourceLog(map.raw, readSourceLog(topic.raw)),
    panel: { nodes: map.nodes, edges: map.edges, watermarks: map.watermarks, doc: typeof map.doc === 'string' ? map.doc : '' } }));
};
export const renameTopic = (id, revision, name) => {
  if (typeof name !== 'string' || !name.trim()) throw fail('名称不能为空');
  return mutateTopic(id, revision, () => ({ name: name.trim() }));
};
export const archiveTopic = (id, revision) => mutateTopic(id, revision, () => ({ archived: true }));
async function storedSourceEvents(id) {
  try { return await jsonRead(file('sources',id)); } catch (error) { if(error.status !== 404) throw error; return []; }
}
export async function sourceEvents(id) {
  const topic = await getTopic(id);
  return [...await storedSourceEvents(id), ...Object.values(topic.sourceUpdates || {})];
}
async function changeSources(id, update) {
  // Independent browser/CLI writers append to the same source stream. A busy
  // short lock must not discard a hand-written node's only source record.
  for (let attempt = 0; ; attempt++) {
    try { return await locked('sources',id,async () => {
      await getTopic(id);
      await atomic(file('sources',id), update(await storedSourceEvents(id)));
    }); }
    catch (error) {
      if (error.status !== 409 || attempt >= 19) throw error;
      await new Promise(resolve => setTimeout(resolve,50));
    }
  }
}
export async function saveSourceEvent(id, event) {
  if (!event || !['L0->L1','L1->L2'].includes(event.layer) || !Array.isArray(event.outputs)) throw fail('来源记录无效');
  return changeSources(id, records => [...records,event]);
}
export async function clearSourceEvents(id) {
  await changeSources(id, records => records.filter(event => !event.sourceMeta || event.sourceMeta.sessionId === 'manual'));
  // Clear redraw provenance without resetting the independent import cursors.
  return locked('topics',id,async () => {
    const topic = await getTopic(id);
    if (topic.sourceUpdates) await atomic(file('topics',id),{...topic,sourceUpdates:{}});
  });
}
export async function history(id) { const t = await getTopic(id); return { ledger: t.ledger, raw: t.raw, sourceText: renderSourceLog(t.raw) }; }
export async function readSources(id,cursor) { const topic = await getTopic(id); return sourcePage(id,topic.raw,cursor); }
export async function exportTopic(id) { const topic = await getTopic(id); return createTopicBundle(topic.name, topic); }
export async function importTopic(bundle) {
  if (bundle?.format === 'gft-document' && bundle.version === 1) {
    if (typeof bundle.text !== 'string' || !bundle.text.trim() || bundle.text.length > 1000000) throw fail('请输入有效的文稿（最多 100 万字符）');
    if (typeof bundle.name !== 'string' || !bundle.name.trim()) throw fail('请填写脉络名称');
    const seed = {id:'import',name:bundle.name,scope:'',ledger:createLedger(''),raw:'',revision:1};
    const edited = editDocument(seed,bundle.text);
    // Preserve the exact imported text as received material, including headings.
    const raw = appendSourceLog('',[{v:1,provider:'human',sessionId:'import',id:randomUUID(),role:'user',title:bundle.name,content:bundle.text,ts:Date.now()}]);
    return createTopic(bundle.name,'',{...edited,raw});
  }
  let portable;
  try { portable = parseTopicBundle(bundle); } catch (error) { throw fail(error.message); }
  return createTopic(portable.topic.name, portable.topic.scope, portable.topic);
}
const sessionKey = id => createHash('sha256').update(String(id)).digest('hex');
const sourceKey = (provider, id) => {
  if (!['codex','claude'].includes(provider) || typeof id !== 'string' || !id.trim() || id.length > 500 || /[\x00-\x1f]/.test(id)) throw fail('请明确有效的来源平台与会话 ID');
  return sessionKey(`${provider}\0${id}`);
};
/** One source lock serializes binding changes with commits from that source. */
export async function getSourceConnections(provider,id) {
  try { return await jsonRead(file('connections',sourceKey(provider,id))); }
  catch (error) { if (error.status !== 404) throw error; return null; }
}
export async function withSourceConnections(provider, id, run) {
  const key = sourceKey(provider,id);
  return locked('connections',key,async () => {
    let group;
    try { group = await jsonRead(file('connections',key)); }
    catch (error) { if(error.status !== 404) throw error; group = { provider, sessionId: id, connections: [], writeProjectId: null }; }
    const before = JSON.stringify(group);
    const result = await run(group);
    if (before !== JSON.stringify(group)) await atomic(file('connections',key),group);
    return result;
  });
}
export const listConnectionGroups = () => list('connections');
export const sourceCursorKey = connection => `${connection.id}:${connection.generation}`;
const sameCursor = (left,right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
function requireTaskConnection(group, source, topicId) {
  const binding = group.connections.find(connection => connection.id === source.connectionId && connection.generation === source.generation && connection.topicId === topicId && !connection.disconnectedAt);
  if (!binding) throw fail('来源连接已断开或重新建立，旧任务未写入主题。',409);
  return binding;
}
export async function linkSession(id, projectIds, writeProjectId) {
  if (!id || !projectIds.length || (writeProjectId && !projectIds.includes(writeProjectId))) throw fail('请明确 session、要连接的主题，以及其中一个存回目标');
  for (const p of projectIds) await getTopic(p);
  const p = file('sessions', sessionKey(id));
  return locked('sessions', sessionKey(id), async () => {
    let old; try { old = await jsonRead(p); } catch (e) { if(e.status !== 404) throw e; }
    const s = { id, projectIds: [...new Set(projectIds)], writeProjectId: writeProjectId || (projectIds.length === 1 ? projectIds[0] : null), reads: Object.fromEntries(Object.entries(old?.reads || {}).filter(([key]) => projectIds.includes(key))) };
    await atomic(p, s); return s;
  });
}
export const listSessions = () => list('sessions');
export async function readContext(sessionId, projectId) {
  if (sessionId) return locked('sessions', sessionKey(sessionId), async () => readSelected(await jsonRead(file('sessions',sessionKey(sessionId))),projectId));
  return readSelected(null,projectId);
}
async function readSelected(s, projectId) {
  const ids = projectId ? [projectId] : s?.projectIds;
  if (!ids?.length) throw fail('请明确主题 ID，或先连接本场 session');
  if (s && ids.some(id => !s.projectIds.includes(id))) throw fail('该主题尚未连接到本场 session');
  const projects = await Promise.all(ids.map(async id => {
    const v = await getView(id);
    return memoryDocument(v);
  }));
  if (s) {
    for (const p of projects) s.reads[p.id] = p.revision;
    await atomic(file('sessions', sessionKey(s.id)), s);
  }
  return { session: s?.id || null, writeProjectId: s?.writeProjectId || null, projects };
}
export async function createTask(topicId, action, input = '', source) {
  if (!['update', 'tidy', 'redraw', 'compact'].includes(action)) throw fail('未知任务');
  if (action === 'compact' && source?.stage !== 'distill') throw fail('历史提炼需要明确的来源连接');
  if (typeof input !== 'string' || input.length > 200000) throw fail('输入内容过长或不是文本');
  const topic = await getTopic(topicId);
  if (action === 'redraw') prepareSourceRedraw(topic,await sourceEvents(topicId));
  else promptFor(topic, {action, input, source}); // validate before publishing a task
  const task = { id: randomUUID(), topicId, action, input, baseRevision: topic.revision, status: 'pending', createdAt: new Date().toISOString(), ...(source ? {source} : {}) };
  await atomic(file('tasks', task.id), task);
  return task;
}
export const getTask = id => jsonRead(file('tasks', id));
const taskStatus = ({ input, output, request, source, ...task }) => ({ ...task, ...(source ? {source: { provider: source.provider, id: source.id, connectionId: source.connectionId, generation: source.generation, title: source.title, hasMore: source.hasMore, stage: source.stage }} : {}) });
export const getTaskStatus = async id => taskStatus(await getTask(id));
export async function createComputation(topicId, revision, request) {
  if (!request || !['update','redraw','tidy','refine','theme'].includes(request.action)
    || typeof request.system !== 'string' || typeof request.user !== 'string'
    || request.system.length + request.user.length > 500000) throw fail('模型请求无效');
  const topic = await getTopic(topicId);
  if (topic.revision !== revision) throw fail('主题已有新版本，请重新读取后再处理', 409);
  const task = { id: randomUUID(), topicId, action: request.action, mode: 'compute', request,
    baseRevision: revision, status: 'pending', createdAt: new Date().toISOString() };
  await atomic(file('tasks', task.id), task);
  return taskStatus(task);
}
export async function computationResult(id) {
  const task = await getTask(id);
  if (task.mode !== 'compute' || task.status !== 'completed') throw fail('结果尚未就绪', 409);
  return { output: task.output, baseRevision: task.baseRevision, execution: task.execution };
}
export async function taskPrompt(id) {
  const task = await getTask(id), topic = await getTopic(task.topicId);
  if (task.source) await withSourceConnections(task.source.provider,task.source.id,group => requireTaskConnection(group,task.source,task.topicId));
  if (topic.revision !== task.baseRevision) throw fail('主题已有新版本，请取消旧任务并重新发起', 409);
  return { ...task, ...(task.action === 'redraw' ? prepareSourceRedraw(topic,await sourceEvents(topic.id)) : task.mode === 'compute' ? task.request : promptFor(topic, task)) };
}
function promptFor(topic, task) {
  return task.source?.stage
    ? prepareImport(topic, task.input, task.source.summary || '', task.source.stage === 'publish')
    : prepareTask(topic, task.action, task.input);
}
export async function listTasks() { return (await list('tasks')).map(taskStatus).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
export async function saveTaskExecution(id, execution) {
  return locked('tasks', id, async () => {
    const task = await getTask(id);
    await atomic(file('tasks', id), { ...task, execution });
  });
}
export async function setTaskStatus(id, status, error) {
  return locked('tasks', id, async () => {
    const t = await getTask(id);
    const allowed = { pending: ['running', 'cancelled'], running: ['failed', 'cancelled'], failed: ['cancelled'] };
    if (!allowed[t.status]?.includes(status)) throw fail('任务状态已改变，请刷新后重试',409);
    const next = { ...t, status, ...(status === 'running' ? { runnerPid: process.pid, startedAt: new Date().toISOString() } : { finishedAt: new Date().toISOString() }), ...(error ? { error } : {}) };
    await atomic(file('tasks',id),next); return next;
  });
}
export async function completeTask(id, output) {
  if (typeof output !== 'string' || output.length > 2000000) throw fail('结果无效');
  return locked('tasks', id, async () => {
    const task = await getTask(id);
    if (!['pending','running'].includes(task.status)) throw fail('任务已结束，不能重复应用',409);
    if (task.mode === 'compute') {
      if (!output.trim()) throw fail('模型返回空结果');
      const topic = await getTopic(task.topicId);
      if (topic.revision !== task.baseRevision) throw fail('生成期间主题已修改，旧结果未覆盖当前内容。', 409);
      const next = { ...task, request: undefined, output, status: 'completed', completedAt: new Date().toISOString() };
      await atomic(file('tasks', id), next);
      return taskStatus(next);
    }
    const apply = () => mutateTopic(task.topicId, task.baseRevision, topic => {
      if (task.source?.stage === 'distill') {
        const summary = parseImportSummary(output);
        const key = `${task.source.connectionId}:${task.source.generation}`;
        const checkpoint = topic.sourceImports?.[key];
        const cursor = checkpoint?.cursor ?? topic.sourceCursors?.[key]?.cursor ?? task.source.initialCursor;
        if (!sameCursor(cursor, task.source.fromCursor)) throw fail('历史提炼进度已变化，旧结果未重复写入。',409);
        return {sourceImports: {...topic.sourceImports, [key]: {
          scope: topic.scope, summary, cursor: task.source.toCursor, until: task.source.until,
          fromCursor: checkpoint ? checkpoint.fromCursor : task.source.fromCursor,
          taskIds: [...(checkpoint?.taskIds || []), id], hasMore: task.source.hasMore,
        }}};
      }
      const delta = applyTask(topic, task.action, output);
      if (!task.source) return task.action === 'update' ? {...delta, raw: appendSourceLog(topic.raw, [{
        v:1,provider:'local-agent',sessionId:'submitted',id:task.id,role:'user',content:task.input,title:'Agent 提交的材料',ts:Date.parse(task.createdAt),
      }])} : delta;
      const key = `${task.source.connectionId}:${task.source.generation}`;
      const currentCursor = Object.hasOwn(topic.sourceCursors || {},key) ? topic.sourceCursors[key].cursor : task.source.initialCursor;
      if (!sameCursor(currentCursor,task.source.fromCursor)) throw fail('来源水位已变化，旧任务未重复写入。',409);
      const before = new Map(viewTopic(topic).graph.nodes.map(node => [node.id,JSON.stringify(node)]));
      const after = viewTopic({...topic,...delta});
      const event = { id: task.id, layer: 'L0->L1',
        inputs: task.source.messages.map(message => ({id:message.id,role:message.role,name:null,content:message.content,ts:typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp || '') || 0,
          ...(message.phase ? {phase:message.phase} : {}),...(message.turnStatus ? {turnStatus:message.turnStatus} : {})})),
        outputs: after.graph.nodes.filter(node => before.get(node.id) !== JSON.stringify(node)).map(node => node.id),
        sourceMeta: { provider:task.source.provider,sessionId:task.source.id,sessionTitle:task.source.title,fromId:task.source.messages[0]?.id || null,toId:task.source.messages.at(-1)?.id || null,count:task.source.messages.length },
      };
      const sourceImports = {...topic.sourceImports};
      if (task.source.stage === 'publish') delete sourceImports[key];
      return {...delta,raw:appendSourceLog(topic.raw,sourceRecordsFromEvents([event])),sourceImports,sourceCursors:{...topic.sourceCursors,[key]:{cursor:task.source.toCursor,taskId:id,updatedAt:new Date().toISOString()}},sourceUpdates:{...topic.sourceUpdates,[id]:event}};
    }, id, task.action !== 'compact');
    // If topic save succeeded before task status was persisted, replay only the
    // receipt, even when the source was disconnected or the user edited later.
    const alreadyApplied = (await getTopic(task.topicId)).appliedTasks?.[id];
    const { view, resultRevision } = task.source && !alreadyApplied
      ? await withSourceConnections(task.source.provider,task.source.id,group => { requireTaskConnection(group,task.source,task.topicId); return apply(); })
      : await apply();
    await atomic(file('tasks', id), { ...task, input: '', status: 'completed', completedAt: new Date().toISOString(), resultRevision });
    return view;
  });
}
function processExited(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid,0); return false; } catch(e) { return e.code === 'ESRCH'; }
}
// Explicit recovery after an interrupted local process. A live owner's files
// are never reclaimed; normal reads/writes do not run a background repair loop.
export async function recover() {
  const recovered = [];
  for (const kind of ['topics','sessions','tasks','sources','connections']) {
    const dir = path.join(homeDir(),kind);
    await mkdir(dir,{recursive:true});
    for (const name of await readdir(dir)) {
      if (!/^[a-zA-Z0-9_-]+\.json\.lock$/.test(name)) continue;
      const p = path.join(dir,name), owner = await readFile(p,'utf8').catch(()=> '');
      if (processExited(Number(owner))) { await unlink(p).catch(()=>{}); recovered.push(`${kind}/${name}`); }
    }
  }
  for (const task of await list('tasks')) {
    if (['completed','cancelled'].includes(task.status)) continue;
    const topic = await getTopic(task.topicId);
    if (topic.appliedTasks?.[task.id]) await locked('tasks',task.id,async()=>{
      const current = await getTask(task.id);
      await atomic(file('tasks',task.id),{...current,status:'completed',input:'',resultRevision:topic.appliedTasks[task.id]});
      recovered.push(task.id);
    });
    else if (task.status === 'running' && processExited(task.runnerPid)) { await setTaskStatus(task.id,'failed','执行进程已退出，当前内容保留；请重新发起任务。'); recovered.push(task.id); }
  }
  return {recovered};
}
