import { randomUUID } from 'node:crypto';
import * as store from './store.mjs';
import { IMPORT_COMPACT_THRESHOLD } from './dist/core.mjs';

const now = () => new Date().toISOString();
const active = binding => !binding.disconnectedAt;
const publicBinding = ({ id, topicId, source, history, generation, loadedRevision, loadedAt, connectedAt, updatedAt }) =>
  ({ id, topicId, source, history, generation, loadedRevision, loadedAt: loadedAt || null, connectedAt, updatedAt, verified: true });
const jsonCopy = value => JSON.parse(JSON.stringify(value ?? null));
const has = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
function sourceIdentity(source) {
  if (!source || !['codex','claude'].includes(source.provider) || typeof source.id !== 'string' || !source.id.trim()
    || source.id.length > 500 || /[\x00-\x1f]/.test(source.id)) throw store.fail('请明确来源平台与真实会话 ID');
  if (source.cwd != null && (typeof source.cwd !== 'string' || source.cwd.length > 4000)) throw store.fail('来源工作目录无效');
  return { provider:source.provider, id:source.id, ...(source.cwd ? {cwd:source.cwd} : {}) };
}
function topicSelection(ids,required = true) {
  if (ids === undefined && !required) return undefined;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw store.fail('请明确要连接或断开的主题');
  return [...new Set(ids)];
}
function verifyDescriptor(request,found) {
  if (!found || found.provider !== request.provider || found.id !== request.id || (found.cwd != null && typeof found.cwd !== 'string')) throw store.fail('无法核验该来源会话，请重新选择真实会话',404);
  return { provider:found.provider,id:found.id,title:typeof found.title === 'string' ? found.title : found.id,
    cwd:found.cwd || null,updatedAt:typeof found.updatedAt === 'string' ? found.updatedAt : null };
}
function checkMessages(messages) {
  if (!Array.isArray(messages) || messages.some(message => !message || typeof message.id !== 'string' || !message.id
    || !['user','assistant'].includes(message.role) || typeof message.content !== 'string')) throw store.fail('来源读取器返回了无效消息',502);
  return messages.map(({id,role,content,timestamp,phase,turnStatus}) => ({id,role,content,...(timestamp !== undefined ? {timestamp} : {}),
    ...(typeof phase === 'string' ? {phase} : {}),...(typeof turnStatus === 'string' ? {turnStatus} : {})}));
}
function messageText(message) {
  const notes = [];
  if (message.phase === 'commentary') notes.push('过程说明');
  if (message.turnStatus && message.turnStatus !== 'completed') notes.push(message.turnStatus === 'interrupted' ? '本轮已中断，内容未完成' : message.turnStatus === 'failed' ? '本轮失败，内容未完成' : '本轮完成状态不明');
  return `${message.role === 'user' ? '用户' : '助手'}${notes.length ? `（${notes.join('；')}）` : ''}：\n${message.content}`;
}

/** Adapter only: extraction and graph application still use the shared core. */
export function createConnections({ readers } = {}) {
  let readerPromise;
  const reader = async () => readers || (readerPromise ||= import('./dist/sources.mjs'));
  const verifiedSource = async source => {
    const request = sourceIdentity(source);
    return verifyDescriptor(request,await (await reader()).getChatSession(request));
  };

  async function listConnections({ topicId, provider, sessionId } = {}) {
    if (provider !== undefined && !['codex','claude'].includes(provider)) throw store.fail('未知来源平台');
    const bindings = (await store.listConnectionGroups()).filter(group => (!provider || group.provider === provider) && (!sessionId || group.sessionId === sessionId))
      .flatMap(group => group.connections.filter(binding => active(binding) && (!topicId || binding.topicId === topicId)).map(publicBinding))
      .sort((a,b) => a.connectedAt.localeCompare(b.connectedAt) || a.id.localeCompare(b.id));
    // Only metadata of explicitly bound GFT topics, never chat history or Doc bodies.
    const topics = new Map(await Promise.all([...new Set(bindings.map(binding => binding.topicId))].map(async id => {
      return [id,await store.getTopicIndex(id)];
    })));
    return bindings.filter(binding => topics.get(binding.topicId)?.status === 'active')
      .map(binding => ({...binding,topic:topics.get(binding.topicId)}));
  }

  async function connectSource({ source, topicIds, history, writeProjectId } = {}) {
    if (!['now','all'].includes(history)) throw store.fail('请选择从现在开始，或包含已有聊天');
    const ids = topicSelection(topicIds);
    const descriptor = await verifiedSource(source);
    for (const id of ids) if ((await store.getTopic(id)).archived) throw store.fail('已归档主题不能建立新连接',409);
    return store.withSourceConnections(descriptor.provider,descriptor.id,async group => {
      const adding = ids.filter(id => !group.connections.some(binding => binding.topicId === id && active(binding)));
      const initialCursor = adding.length && history === 'now' ? jsonCopy(await (await reader()).getChatHead(descriptor)) : null;
      const selected = [];
      for (const topicId of ids) {
        let binding = group.connections.find(item => item.topicId === topicId);
        if (!binding || !active(binding)) {
          const next = { id:binding?.id || randomUUID(),topicId,source:descriptor,history,initialCursor,
            generation:randomUUID(),loadedRevision:null,loadedAt:null,connectedAt:now(),updatedAt:now() };
          if (binding) Object.assign(binding,next,{disconnectedAt:undefined,notice:undefined});
          else { binding = next; group.connections.push(binding); }
        } else {
          // Reconnecting an already linked topic is additive and never rewinds it.
          binding.source = descriptor; binding.updatedAt = now();
        }
        selected.push(binding);
      }
      if (writeProjectId !== undefined) {
        if (writeProjectId !== null && !group.connections.some(binding => active(binding) && binding.topicId === writeProjectId)) throw store.fail('存回目标必须是该会话已连接的主题');
        group.writeProjectId = writeProjectId;
      } else if (!group.writeProjectId && group.connections.filter(active).length === 1) group.writeProjectId = group.connections.find(active).topicId;
      return selected.map(publicBinding);
    });
  }

  async function cancelDisconnectedTasks(bindings) {
    const keys = new Set(bindings.map(binding => `${binding.id}:${binding.generation}`));
    for (const task of await store.listTasks()) {
      if (!task.source || !keys.has(`${task.source.connectionId}:${task.source.generation}`) || !['pending','running'].includes(task.status)) continue;
      // Do this after releasing the source lock: complete holds task before source.
      for (let attempt = 0; ; attempt++) {
        const current = await store.getTaskStatus(task.id);
        if (!['pending','running'].includes(current.status)) break;
        try { await store.setTaskStatus(task.id,'cancelled','来源连接已断开，当前内容保留。'); break; }
        catch (error) {
          if (error.status !== 409 || attempt >= 39) throw error;
          await new Promise(resolve => setTimeout(resolve,25));
        }
      }
    }
  }

  async function disconnectSource({ connectionId, provider, sessionId, topicIds } = {}) {
    const ids = topicSelection(topicIds,false);
    if (connectionId !== undefined && (typeof connectionId !== 'string' || !connectionId || connectionId.length > 100)) throw store.fail('连接 ID 无效');
    if ((provider === undefined) !== (sessionId === undefined)) throw store.fail('请同时指定来源平台和会话 ID');
    if (provider !== undefined) sourceIdentity({provider,id:sessionId});
    if (!connectionId && provider === undefined && !ids) throw store.fail('请明确要断开的连接、来源会话或主题');
    const groups = (await store.listConnectionGroups()).filter(group => (!provider || group.provider === provider) && (!sessionId || group.sessionId === sessionId)
      && group.connections.some(binding => (!connectionId || binding.id === connectionId) && (!ids || ids.includes(binding.topicId))));
    const disconnected = [], selected = [];
    for (const candidate of groups) await store.withSourceConnections(candidate.provider,candidate.sessionId,group => {
      for (const binding of group.connections) {
        if ((connectionId && binding.id !== connectionId) || (ids && !ids.includes(binding.topicId))) continue;
        selected.push({...binding});
        if (!active(binding)) continue;
        binding.disconnectedAt = now(); binding.updatedAt = binding.disconnectedAt;
        disconnected.push(binding.id);
        if (group.writeProjectId === binding.topicId) group.writeProjectId = null;
      }
    });
    await cancelDisconnectedTasks(selected);
    return {disconnected};
  }

  async function readConnectedContext({provider,sessionId,topicId, nodeIds} = {}) {
    sourceIdentity({provider,id:sessionId});
    topicSelection([topicId]);
    if (nodeIds !== undefined && (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > 20 || nodeIds.some(id=>typeof id !== 'string'))) throw store.fail('请指定 1–20 个节点 ID');
    return store.withSourceConnections(provider,sessionId,async group => {
      const bindings = group.connections.filter(binding => active(binding) && (!topicId || binding.topicId === topicId));
      if (!bindings.length) throw store.fail('该会话尚未连接所选主题，请先连接',404);
      if (nodeIds) {
        const view = await store.getView(topicId);
        const nodes = nodeIds.map(id => view.graph.nodes.find(node=>node.id === id));
        if (nodes.some(node=>!node)) throw store.fail('节点不存在，请重新读取主题索引',404);
        return {topicId,revision:view.revision,nodes}; // Details alone do not acknowledge the entire Doc.
      }
      const projects = [];
      for (const binding of bindings) {
        const context = await store.readContext(null,binding.topicId);
        const project = context.projects[0];
        projects.push(project);
        binding.loadedRevision = project.revision; binding.loadedAt = now(); binding.updatedAt = now();
      }
      const writeProjectId = group.writeProjectId && group.connections.some(binding => active(binding) && binding.topicId === group.writeProjectId)
        && (await store.getTopicIndex(group.writeProjectId)).status === 'active' ? group.writeProjectId : null;
      return { session:sessionId,provider,writeProjectId,projects,connections:bindings.map(publicBinding) };
    });
  }

  async function readConnectedSources({provider,sessionId,topicId,cursor} = {}) {
    sourceIdentity({provider,id:sessionId}); topicSelection([topicId]);
    return store.withSourceConnections(provider,sessionId,async group => {
      if (!group.connections.some(binding=>active(binding) && binding.topicId === topicId)) throw store.fail('该会话尚未连接所选主题，请先连接',404);
      return store.readSources(topicId,cursor); // Source reads do not mark the current Doc as loaded.
    });
  }

  async function createSourceUpdate(topicId,{connectionId,continuous = false,until} = {}) {
    const candidates = await listConnections({topicId});
    const selected = connectionId ? candidates.find(binding => binding.id === connectionId) : candidates.length === 1 ? candidates[0] : null;
    if (!selected) throw store.fail(candidates.length > 1 && !connectionId ? '该主题连接了多个会话，请明确本次更新来源' : '该主题尚未连接所选来源',400);
    return store.withSourceConnections(selected.source.provider,selected.source.id,async group => {
      const binding = group.connections.find(item => item.id === selected.id && item.generation === selected.generation && active(item));
      if (!binding) throw store.fail('来源连接已改变，请重新选择',409);
      const descriptor = await verifiedSource(binding.source);
      const topic = await store.getTopic(topicId);
      if (topic.archived) throw store.fail('已归档主题不能更新',409);
      const existing = (await store.listTasks()).find(task => task.source?.connectionId === binding.id && task.source.generation === binding.generation && ['pending','running'].includes(task.status));
      if (existing) {
        if (existing.baseRevision !== topic.revision) throw store.fail('此来源的旧任务已过期，请先取消再重新更新',409);
        const original = await store.getTask(existing.id);
        return {task:existing,hasMore:original.source.stage === 'distill' || existing.source.hasMore,until:original.source.until,messageCount:original.source.messages.length,stage:original.source.stage,reused:true};
      }
      const key = store.sourceCursorKey(binding);
      const checkpoint = topic.sourceImports?.[key];
      if (checkpoint && checkpoint.scope !== topic.scope) throw store.fail('提炼期间主题范围已改变。请恢复原范围继续，或断开重连后按新主题导入；原图文保留。',409);
      const boundary = checkpoint?.until ?? until ?? (continuous ? await (await reader()).getChatHead(descriptor) : undefined);
      if (checkpoint && !checkpoint.hasMore) {
        const chunks = await Promise.all(checkpoint.taskIds.map(store.getTask));
        const messages = chunks.flatMap(task => task.source.messages);
        const source = {provider:descriptor.provider,id:descriptor.id,title:descriptor.title,connectionId:binding.id,generation:binding.generation,
          initialCursor:jsonCopy(binding.initialCursor),fromCursor:checkpoint.fromCursor,toCursor:checkpoint.cursor,messages,hasMore:false,until:boundary,stage:'publish'};
        const task = await store.createTask(topicId,'update',checkpoint.summary || '所选历史没有与主题相关的新判断，请返回 <noop/>。',source);
        return {task:await store.getTaskStatus(task.id),hasMore:false,until:boundary,messageCount:messages.length,stage:'publish'};
      }
      const fromCursor = jsonCopy(checkpoint ? checkpoint.cursor : has(topic.sourceCursors || {},key) ? topic.sourceCursors[key].cursor : binding.initialCursor);
      const delta = await (await reader()).readChatDelta(descriptor,fromCursor,{limit:100,maxChars:IMPORT_COMPACT_THRESHOLD,...(boundary === undefined ? {} : {until:boundary})});
      if (!delta || !has(delta,'cursor')) throw store.fail('来源读取器未返回增量水位',502);
      const messages = checkMessages(delta.messages);
      if (!messages.length) return {unchanged:true,message:'这段会话没有新增可收录的消息。',hasMore:!!delta.hasMore};
      if (JSON.stringify(fromCursor) === JSON.stringify(delta.cursor ?? null)) throw store.fail('来源读取器未推进增量水位，未创建重复任务',502);
      const input = messages.map(messageText).join('\n\n');
      const compact = !!checkpoint || delta.cursor?.v === 2 || (continuous && (delta.hasMore || input.length > IMPORT_COMPACT_THRESHOLD));
      const source = {provider:descriptor.provider,id:descriptor.id,title:descriptor.title,connectionId:binding.id,generation:binding.generation,
        initialCursor:jsonCopy(binding.initialCursor),fromCursor,toCursor:jsonCopy(delta.cursor),messages,hasMore:!!delta.hasMore,...(boundary === undefined ? {} : {until:boundary}),
        ...(compact ? {stage:'distill',summary:checkpoint?.summary || ''} : {})};
      const task = await store.createTask(topicId,compact ? 'compact' : 'update',input,source);
      return {task:await store.getTaskStatus(task.id),hasMore:compact || !!delta.hasMore,until:boundary,messageCount:messages.length,stage:source.stage};
    });
  }

  return {listConnections,connectSource,disconnectSource,readConnectedContext,readConnectedSources,createSourceUpdate};
}

const defaults = createConnections();
export const {listConnections,connectSource,disconnectSource,readConnectedContext,createSourceUpdate} = defaults;
