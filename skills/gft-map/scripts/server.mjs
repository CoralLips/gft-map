import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as materials from './materials.mjs';
import {archive as materialArchive,restore as restoreMaterialArchive} from './materialArchive.mjs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import * as store from './store.mjs';
import { createAccount } from './account.mjs';
import { createCloudSync } from './sync.mjs';
import {pendingNotices,acknowledgeNotices} from './notifications.mjs';
import { createCodexRunner } from './runner.mjs';
import {programVersion,installationId} from './version.mjs';
import { prepareImport, parseImportSummary, redrawSummaryInput } from './dist/core.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const agents = ['codex', 'codex-acp', 'claude-acp'];

export async function createRunner(agent = 'codex', options) {
  if (agent === 'codex') return createCodexRunner(options);
  if (!agents.includes(agent)) throw store.fail(`执行器应为 ${agents.join('、')}`);
  const { createAcpRunner } = await import('./dist/acp.mjs');
  return createAcpRunner({ ...options, adapter: agent === 'codex-acp' ? 'codex' : 'claude' });
}

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw store.fail('需要 JSON 请求',415);
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if(length > 4 * 1024 * 1024) throw store.fail('内容过大',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw store.fail('JSON 无法解析'); }
}
export async function startServer({ port = 4317, agent = null, execute, runnerOptions, sourceReaders, connectionService, accountService, syncIntervalMs } = {}) {
  if (agent && !agents.includes(agent)) throw store.fail(`执行器应为 ${agents.join('、')}`);
  await store.recover();
  const runner = agent && !execute ? await createRunner(agent, runnerOptions) : null;
  let startupError = null;
  if (runner) try { await runner.check(); } catch (error) { startupError = {message:error.message,code:error.code,at:new Date().toISOString()}; }
  const version = await programVersion();
  const readers = sourceReaders || await import('./dist/sources.mjs');
  const { createConnections } = await import('./connections.mjs');
  const connections = connectionService || createConnections({ readers });
  const account = accountService || createAccount({ home: store.homeDir() });
  const sync = createCloudSync({ account, intervalMs:syncIntervalMs });
  let busy = false, closed = false, activeTaskId = null, activeController = null, lastError = startupError, shutdownPromise = null;
  async function saveExecution(id, execution) {
    // Cancellation may be committing its task state as the child closes. Keep
    // the metrics without ever replacing that independently committed status.
    for (let attempt = 0; ; attempt++) {
      try { await store.saveTaskExecution(id,execution); return; }
      catch (error) { if (error.status !== 409 || attempt >= 19) throw error; await new Promise(resolve=>setTimeout(resolve,25)); }
    }
  }
  const materialWorker=materials.createWorker({run:async (request,signal)=>{
    if(runner?.snapshot().status==='unavailable')await runner.check();
    if(execute)return execute(request,{signal});
    if(!runner)throw store.fail('请先启用本地 Agent 执行器',503);
    return runner.run(request,{directory:path.join(store.homeDir(),'runs',`material-${request.materialId}-${Date.now()}`),signal});
  }});
  await materialWorker.recover();
  const runtime = () => ({ product:'gft-map',version,installationId,pid:process.pid,agent, mode: agent ? 'automatic' : 'manual', executor: runner ? { ...runner.snapshot(), lastError } : { status: agent ? (busy ? 'running' : 'ready') : 'manual', activeTaskId, lastError } });
  const server = http.createServer(async (req,res) => {
    const send = (status,data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(data)); };
    try {
      const authority = req.headers.host;
      const actualPort = server.address()?.port;
      const allowed = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!allowed.includes(authority) || (req.headers.origin && !allowed.map(h=>`http://${h}`).includes(req.headers.origin))) throw store.fail('不允许此来源',403);
      const url = new URL(req.url, `http://${authority}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api') {
        if(req.method !== 'GET') throw store.fail('不支持的请求',405);
        const assets = { '': ['index.html','text/html'], 'app.js':['app.js','text/javascript'], 'app.css':['app.css','text/css'] };
        const assetPath = parts.join('/');
        const fontTypes = { woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', svg: 'image/svg+xml', png: 'image/png' };
        const font = /^assets\/[\w.-]+\.(woff2?|ttf|svg|png)$/.exec(assetPath);
        const asset = assets[assetPath] || (font ? [assetPath, fontTypes[font[1]]] : null);
        if(!asset) throw store.fail('页面不存在',404);
        const content = await readFile(path.join(root,'dist/web',asset[0]));
        res.writeHead(200,{'Content-Type':`${asset[1]}; charset=utf-8`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);return;
      }
      const [,group,id,action] = parts;
      let value;
      if(req.method==='PUT'&&group==='materials'&&action==='upload') {
        if(req.headers['content-type']!=='application/octet-stream')throw store.fail('需要文件分块',415);
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>materials.UPLOAD_BYTES)throw store.fail('分块过大，请分批发送',413);chunks.push(chunk);}
        value=await materials.upload(id,Number(url.searchParams.get('offset')),Buffer.concat(chunks));
        send(200,value);return;
      }
      if(req.method === 'GET') {
        if(group==='topics'&&action==='download') {
          const topic=await store.getTopic(id),hasMaterials=(await materials.list(id)).length>0;
          if(hasMaterials){
            const stream=materialArchive(id),first=await stream.next();
            res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(topic.name.replace(/[\\/:*?"<>|]/g,'_')+'.gftpack')}`});
            await pipeline(Readable.from((async function*(){yield first.value;yield* stream;})()),res);return;
          }
          res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(topic.name.replace(/[\\/:*?"<>|]/g,'_')+'.gft.json')}`});
          res.end(JSON.stringify(await store.exportTopic(id),null,2));return;
        }
        if(group === 'runtime') value = runtime();
        else if(group==='material-evidence')value={text:await materials.evidence(url.searchParams.get('topicId'),url.searchParams.getAll('node'))};
        else if(group==='materials') value=!id ? await materials.list(url.searchParams.get('topicId')) : action==='page' ? await materials.page(id,Number(url.searchParams.get('start') || 0)) : await materials.get(id);
        else if(group === 'account') value = {...await account.status(),sync:sync.snapshot()};
        else if(group === 'chat-sessions') {
          let cursor;
          const encoded = url.searchParams.get('cursor');
          if (encoded) {
            try { cursor = JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')); }
            catch { throw store.fail('会话列表读取位置无效，请重新搜索'); }
          }
          const page = await readers.listChatSessions({provider:url.searchParams.get('provider'),query:url.searchParams.get('query') || '',cursor,limit:30});
          value = {...page,nextCursor:page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url') : null};
        }
        else if(group === 'chat-session') value = await readers.getChatSession({provider:url.searchParams.get('provider'),id:url.searchParams.get('id'),cwd:url.searchParams.get('cwd') || undefined});
        else if(group === 'connections') value = await connections.listConnections(Object.fromEntries(['topicId','provider','sessionId'].flatMap(key=>url.searchParams.has(key)?[[key,url.searchParams.get(key)]]:[])));
        else if(group === 'sessions') value = await store.listSessions();
        else if(group === 'topics') value = !id ? await store.listTopics() : action === 'history' ? await store.history(id) : action === 'export' ? await store.exportTopic(id) : action === 'snapshot' ? await store.getSnapshot(id) : action === 'sources' ? await store.sourceEvents(id) : await store.getView(id);
        else if(group === 'tasks') value = id ? action === 'status' ? await store.getTaskStatus(id) : action === 'result' ? await store.computationResult(id) : await store.taskPrompt(id) : await store.listTasks();
        else throw store.fail('接口不存在',404);
      } else if(req.method === 'POST') {
        const data = await body(req);
        if(group === 'upgrade' && id === 'prepare') {
          if(data.installationId !== installationId) throw store.fail('此服务属于另一份安装，未停止。',409);
          if(busy || (await store.listTasks()).some(t=>['pending','running'].includes(t.status)) || (await materials.list()).some(j=>['queued','running'].includes(j.state))) throw store.fail('请等待任务完成或暂停后再更新。',409);
          closed=true;
          send(200,{stopped:true,version});
          setImmediate(()=>void server.shutdown()); return;
        }
        else if(group==='materials') {
          if(!id)value=await materials.create(data);
          else if(action==='finish')value=await materials.finish(id);
          else if(action==='restore')value=await restoreMaterialArchive(id);
          else if(action==='discard')value=await materials.discard(id);
          else if(action==='pause'||action==='resume')value=await materialWorker.control(id,action);
          else if(action==='edit')value=await materials.editPage(id,data.start,data.end,data.text,data.etag);
          else throw store.fail('接口不存在',404);
        }
        else if(group === 'import') value = await store.importTopic(data);
        else if(group === 'account' && id === 'login') value = await account.begin();
        else if(group === 'account' && id === 'logout') value = await account.logout();
        else if(group === 'account' && id === 'cancel') value = await account.cancel();
        else if(group === 'connections' && id === 'notices') value = await pendingNotices(data);
        else if(group === 'connections' && id === 'ack-notices') value = await acknowledgeNotices(data);
        else if(group === 'connections' && id === 'connect') value = await connections.connectSource(data);
        else if(group === 'connections' && id === 'disconnect') value = await connections.disconnectSource(data);
        else if(group === 'connections' && id === 'read') value = await connections.readConnectedContext(data);
        else if(group === 'connections' && id === 'sources') value = await connections.readConnectedSources(data);
        else if(group === 'chat-preview') value = await readers.getChatPreview(data.source);
        else if(group === 'topics' && !id) value = await store.createTopic(data.name,data.scope,undefined,data.id);
        else if(group === 'topics' && action === 'doc') value = await store.saveDoc(id,data.baseRevision,data.doc);
        else if(group === 'topics' && action === 'graph') value = await store.saveGraph(id,data.baseRevision,data.op);
        else if(group === 'topics' && action === 'state') value = await store.saveState(id,data.baseRevision,data.map);
        else if(group === 'topics' && action === 'rename') value = await store.renameTopic(id,data.baseRevision,data.name);
        else if(group === 'topics' && action === 'archive') value = await store.archiveTopic(id,data.baseRevision);
        else if(group === 'topics' && action === 'sources') { await store.saveSourceEvent(id,data.event); value = {saved:true}; }
        else if(group === 'topics' && action === 'clear-sources') { await store.clearSourceEvents(id); value = {saved:true}; }
        else if(group === 'topics' && action === 'compute') {
          if (!agent) throw store.fail('本地执行器尚未启用，请选择 codex、codex-acp 或 claude-acp，并用 serve --agent 启动服务。', 503);
          value = await store.createComputation(id,data.baseRevision,data.request);
        }
        else if(group === 'topics' && action === 'tasks') value = await store.createTask(id,data.action,data.input);
        else if(group === 'topics' && action === 'update-from-chat') {
          if (!agent) throw store.fail('本地执行器尚未启用，请用 serve --agent 启动服务后再更新。',503);
          value = await connections.createSourceUpdate(id,{connectionId:data.connectionId,continuous:data.continuous === true,until:data.until});
        }
        else if(group === 'tasks' && action === 'cancel') { value = await store.setTaskStatus(id,'cancelled'); if (activeTaskId === id) activeController?.abort('cancelled'); }
        else if(group === 'tasks' && action === 'complete') value = await store.completeTask(id,data.output);
        else throw store.fail('接口不存在',404);
      } else throw store.fail('不支持的请求',405);
      send(200,value);
      if(req.method === 'POST') void sync.run();
    } catch(e) { if(res.headersSent)res.destroy(e);else send(e.status || 500,{error:e.message}); }
  });
  async function tick() {
    if(busy || closed || !agent) return;
    busy = true; let task, claimed = false, cancellation;
    try {
      task = (await store.listTasks()).filter(t=>t.status === 'pending').at(-1);
      if(!task) {await materialWorker.tick();return;}
      await store.setTaskStatus(task.id,'running');
      claimed = true;
      activeTaskId = task.id;
      activeController = new AbortController();
      if (closed) { await store.setTaskStatus(task.id,'failed','本地服务已停止，当前内容保留；可重新发起任务。'); return; }
      lastError = null;
      const controller = activeController;
      // A CLI or another local panel may cancel this task too.
      cancellation = setInterval(async () => {
        try { if ((await store.getTask(task.id)).status !== 'running') controller.abort('cancelled'); }
        catch { controller.abort('cancelled'); }
      }, 250);
      const prompt = await store.taskPrompt(task.id);
      if(runner?.snapshot().status === 'unavailable') await runner.check();
      const runs = [];
      const run = async request => {
        if (controller.signal.aborted) throw store.fail('任务已取消，当前内容保留。',409);
        const current = await store.taskPrompt(task.id); // Re-check edits and connection before each model call.
        if (current.status !== 'running') throw store.fail('任务已取消，当前内容保留。',409);
        const result = execute ? await execute(request) : await runner.run(request, { directory: path.join(store.homeDir(),'runs',task.id), signal: controller.signal });
        if (result?.execution) {
          runs.push(result.execution);
          await saveExecution(task.id, runs.length === 1 ? result.execution : {...result.execution,calls:runs.length,runs:[...runs],elapsedMs:runs.reduce((sum,item)=>sum+(item.elapsedMs||0),0),toolCallCount:runs.reduce((sum,item)=>sum+(item.toolCallCount||0),0)});
        }
        return result;
      };
      let summary = '';
      for (const chunk of prompt.historyChunks || []) {
        const request = prepareImport(await store.getTopic(task.topicId),chunk,summary);
        const part = await run({...prompt,...request,historyChunks:undefined});
        summary = parseImportSummary(typeof part === 'string' ? part : part.output);
      }
      const result = await run({...prompt,...(prompt.historyChunks ? {user:redrawSummaryInput(summary)} : {}),historyChunks:undefined});
      const output = typeof result === 'string' ? result : result.output;
      if(!closed) await store.completeTask(task.id,output);
    } catch(e) {
      lastError = { message: e.message, code: e.code || null, at: new Date().toISOString() };
      if(claimed) {
        if(e.execution) await saveExecution(task.id,e.execution).catch(()=>{});
        await store.setTaskStatus(task.id,'failed',e.message).catch(()=>{});
      }
    }
    finally { clearInterval(cancellation); activeTaskId = null; activeController = null; busy = false; }
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const timer = setInterval(()=>void tick(),800);
  sync.start();
  async function stopExecution() {
    closed=true;clearInterval(timer);activeController?.abort('shutdown');
    await materialWorker.close();
    account.close();
    await sync.close();
    if (activeTaskId) await store.setTaskStatus(activeTaskId,'failed','本地服务已停止，当前内容保留；可重新发起任务。').catch(()=>{});
    if (runner) await runner.waitForIdle();
  }
  server.runtime = runtime;
  server.sync = sync;
  server.shutdown = () => shutdownPromise ||= (async () => { await stopExecution(); await new Promise(resolve=>server.close(resolve)); })();
  server.on('close',()=>{void stopExecution();});
  return server;
}
