import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.mjs';
import * as store from '../store.mjs';

const reply = '<doc>\n## 本地体验\n### ◇ 先验证续接\n在另一会话中复用当前判断。\n</doc>';
const waitFor = async (run, accept) => {
  for(let n=0;n<100;n++) { const result=await run(); if(accept(result)) return result; await new Promise(resolve=>setTimeout(resolve,50)); }
  throw new Error('等待状态超时');
};

test('独立本地页面：HTTP 点击任务→执行器→当前账，取消及并发修改不被旧输出覆盖', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'gft-local-http-'));
  process.env.GFT_LOCAL_HOME=dir;
  let execute = async task => { assert.match(task.system,/主题边界/); return reply; };
  const server=await startServer({port:0,agent:'codex',execute:task=>execute(task)});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async (url,data,headers={}) => fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
  try {
    assert.equal((await fetch(base)).status,200);
    assert.equal((await fetch(base+'/app.js')).status,200);
    assert.equal((await post('/api/topics',{name:'错误请求',scope:'不可创建'},{Origin:'https://unrelated.example'})).status,403);
    const badHostStatus=await new Promise((resolve,reject)=>http.get(base+'/api/topics',{headers:{Host:'malicious.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
    assert.equal(badHostStatus,403);
    assert.equal((await fetch(base+'/api/topics',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
    assert.equal((await fetch(base+'/api/topics',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
    const topic=await (await post('/api/topics',{name:'合成演示',scope:'仅讨论本地续接'})).json();
    const task=await (await post(`/api/topics/${topic.id}/tasks`,{action:'update',input:'先验证另一会话能继续工作'})).json();
    const done=await waitFor(()=>store.getTask(task.id),t=>t.status==='completed');
    assert.equal(done.resultRevision,2);
    const view=await (await fetch(base+`/api/topics/${topic.id}`)).json();
    assert.equal(view.graph.nodes[0].title,'先验证续接');
    assert.equal(view.raw,undefined);
    assert.match((await (await fetch(base+`/api/topics/${topic.id}/history`)).json()).raw,/先验证另一会话能继续工作/);
    assert.equal((await post(`/api/tasks/${task.id}/complete`,{output:reply})).status,409);
    const exported=await (await fetch(base+`/api/topics/${topic.id}/export`)).json();
    assert.equal(exported.version,2);
    assert.equal(exported.topic.revision,undefined);
    const snapshot=await (await fetch(base+`/api/topics/${topic.id}/snapshot`)).json();
    assert.equal(snapshot.topic.revision,done.resultRevision);
    assert.equal(snapshot.topic.id,topic.id);
    assert.equal(snapshot.topic.appliedTasks,undefined);
    const imported=await (await post('/api/import',exported)).json();
    assert.notEqual(imported.id,topic.id);
    assert.deepEqual(imported.graph,view.graph);

    let release;
    execute=()=>new Promise(resolve=>{release=resolve;});
    const stale=await store.createTask(topic.id,'tidy');
    await waitFor(()=>store.getTask(stale.id),t=>t.status==='running');
    assert.equal((await store.getTask(stale.id)).status,'running');
    await assert.rejects(()=>store.setTaskStatus(stale.id,'running'),{status:409});
    const current=await store.getView(topic.id);
    await store.saveGraph(topic.id,current.revision,{kind:'edit',id:current.graph.nodes[0].id,title:'人的新修正'});
    await waitFor(async()=>Boolean(release),Boolean);
    release('<noop/>');
    const failed=await waitFor(()=>store.getTask(stale.id),t=>t.status==='failed');
    assert.match(failed.error,/另一处修改/);
    assert.equal((await store.getView(topic.id)).graph.nodes[0].title,'人的新修正');

    release=null;
    const cancelled=await store.createTask(topic.id,'tidy');
    await waitFor(()=>store.getTask(cancelled.id),t=>t.status==='running');
    await waitFor(async()=>Boolean(release),Boolean);
    assert.equal((await post(`/api/tasks/${cancelled.id}/cancel`,{})).status,200);
    release('<noop/>');
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal((await store.getTask(cancelled.id)).status,'cancelled');
    assert.equal((await store.getView(topic.id)).revision,3);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
