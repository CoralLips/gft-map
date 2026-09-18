import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from '../server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';

const waitFor = async run => {
  for (let attempt=0;attempt<150;attempt++) {
    const value=await run();
    if (value) return value;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error('HTTP task did not settle');
};

test('双入口通过同一 HTTP 连接；真实更新事务独立消费两个主题，失败与断开可恢复',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'gft-connections-http-'));
  process.env.GFT_LOCAL_HOME=directory;
  const source={provider:'codex',id:'00000000-0000-4000-8000-000000000001',title:'合成会话',cwd:directory,updatedAt:'2026-09-17T01:00:00Z'};
  const messages=[{id:'m1',role:'user',content:'只验证两个主题独立读取进度。'}];
  const reads=[];
  const readers={
    listChatSessions:async({provider,query,cursor})=>{
      if(cursor){assert.deepEqual(cursor,{position:1});return {sessions:[],nextCursor:null};}
      return {sessions:provider===source.provider && (!query || source.title.includes(query))?[source]:[],nextCursor:{position:1}};
    },
    getChatSession:async selected=>{assert.equal(selected.id,source.id);return source;},
    getChatHead:async()=>({position:messages.length}),
    readChatDelta:async(selected,cursor)=>{assert.equal(selected.id,source.id);reads.push(cursor?.position||0);return {messages:messages.slice(cursor?.position||0),cursor:{position:messages.length},hasMore:false};},
  };
  let run=async()=>'<doc>\n## 验证\n### ◇ 各主题独立保存\n两个主题分别消费明确来源的消息。\n</doc>';
  const server=await startServer({port:0,agent:'codex',execute:task=>run(task),sourceReaders:readers});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(url,data)=>{
    const response=await fetch(base+url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const value=await response.json();
    assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const taskStatus=async(id,status)=>waitFor(async()=>{const task=await request(`/api/tasks/${id}/status`);return task.status===status?task:null;});
  try {
    const page=await request('/api/chat-sessions?provider=codex&query=合成');
    assert.equal(page.sessions[0].id,source.id);
    assert.equal(typeof page.nextCursor,'string');
    assert.equal((await request(`/api/chat-sessions?provider=codex&query=合成&cursor=${page.nextCursor}`)).nextCursor,null);
    assert.equal((await request(`/api/chat-session?provider=codex&id=${source.id}`)).id,source.id);
    const a=await request('/api/topics',{name:'合成主题一',scope:'只记录验证方法'});
    const b=await request('/api/topics',{name:'合成主题二',scope:'只记录验证方法'});
    const connected=await request('/api/connections/connect',{source,topicIds:[a.id,b.id],history:'all'});
    assert.equal(connected.length,2);
    assert.ok(connected.every(item=>item.loadedRevision===null));
    const loaded=await request('/api/connections/read',{provider:source.provider,sessionId:source.id,topicId:a.id});
    assert.equal(loaded.projects.length,1);
    const state=await request(`/api/connections?provider=codex&sessionId=${source.id}`);
    assert.equal(state.find(item=>item.topicId===b.id).loadedRevision,null);
    assert.equal(state.find(item=>item.topicId===a.id).loadedRevision,1);
    const queued=await request(`/api/topics/${a.id}/update-from-chat`,{connectionId:connected[0].id});
    assert.equal(queued.task.source.messages,undefined);
    await taskStatus(queued.task.id,'completed');
    assert.equal((await request(`/api/topics/${a.id}`)).graph.nodes.length,1);
    const client=new Client({name:'memory-http-acceptance',version:'1'});
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'mcp'],env:{...process.env,GFT_LOCAL_URL:base},stderr:'pipe'});
    try {
      await client.connect(transport);
      assert.ok((await client.listTools()).tools.some(tool=>tool.name==='gft_local_sources'));
      const identity={provider:source.provider,sessionId:source.id,topicId:a.id};
      const log=await client.callTool({name:'gft_local_sources',arguments:identity});
      assert.notEqual(log.isError,true);
      assert.match(JSON.parse(log.content[0].text).text,/只验证两个主题独立读取进度/);
      const memory=await client.callTool({name:'gft_local_read',arguments:identity});
      assert.notEqual(memory.isError,true);
      const project=JSON.parse(memory.content[0].text).projects[0];
      assert.ok(project.document);
      assert.equal(project.graph.nodes[0].content,undefined);
    } finally {await client.close();}
    assert.equal((await request(`/api/topics/${b.id}`)).graph.nodes.length,0);
    const again=await request(`/api/topics/${a.id}/update-from-chat`,{connectionId:connected[0].id});
    assert.equal(again.unchanged,true);
    run=async()=>{throw new Error('合成模型错误');};
    const failed=await request(`/api/topics/${b.id}/update-from-chat`,{connectionId:connected[1].id});
    await taskStatus(failed.task.id,'failed');
    run=async()=>'<noop/>';
    const retry=await request(`/api/topics/${b.id}/update-from-chat`,{connectionId:connected[1].id});
    await taskStatus(retry.task.id,'completed');
    assert.deepEqual(reads,[0,1,0,0]);
    const snapshots=await request(`/api/topics/${b.id}/sources`);
    assert.match(JSON.stringify(snapshots),/两个主题独立读取/);
    messages.push({id:'m2',role:'user',content:'这条将在断开时取消，重连后仍可收录。'});
    let release;
    run=()=>new Promise(resolve=>{release=resolve;});
    const pending=await request(`/api/topics/${a.id}/update-from-chat`,{connectionId:connected[0].id});
    await taskStatus(pending.task.id,'running');
    await waitFor(async()=>Boolean(release));
    await request('/api/connections/disconnect',{provider:source.provider,sessionId:source.id,topicIds:[a.id]});
    release('<noop/>');
    await taskStatus(pending.task.id,'cancelled');
    assert.equal((await request(`/api/connections?provider=codex&sessionId=${source.id}`)).length,1);
    assert.equal((await request(`/api/topics/${a.id}`)).revision,2);
    const forbidden=await fetch(base+`/api/topics/${a.id}/update-from-chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:connected[0].id})});
    assert.equal(forbidden.status,400);
  } finally {
    await server.shutdown();
    await rm(directory,{recursive:true,force:true});
  }
});
