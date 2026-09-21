import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from '../server.mjs';
import * as store from '../store.mjs';
import * as materials from '../materials.mjs';
const wait=async(read,ok)=>{for(let i=0;i<250;i++){const v=await read();if(ok(v))return v;await new Promise(r=>setTimeout(r,30));}throw new Error('timeout');};
test('HTTP pause discards late output; restart resumes checkpoints; human edits survive retry; full completion includes tail',async()=>{
  const previous=process.env.GFT_LOCAL_HOME,dir=await mkdtemp(path.join(tmpdir(),'gft-material-http-'));process.env.GFT_LOCAL_HOME=dir;
  let server,release,hold=true,calls=0;
  const execute=async request=>{
    calls++;
    if(request.stage==='extract')return JSON.stringify({summary:request.user.includes('TAIL-MARKER')?'尾部材料已读':'合成内容'});
    if(hold)await new Promise(r=>{release=r;});
    return request.user.includes('尾部材料已读')?'<doc>\n## 验收\n### ◆ 已读最后一段\n尾部也在。\n</doc>':'<doc>\n## 验收\n### ◆ 首段完成\n原文保留。\n</doc>';
  };
  try {
    server=await startServer({port:0,agent:'codex',execute});let base=`http://127.0.0.1:${server.address().port}`;
    const post=async(route,data={})=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
    const topic=await post('/api/topics',{name:'暂停验收',scope:'只记录测试'}),data=Buffer.from('😀材料\n'.repeat(10000)+'TAIL-MARKER');
    const job=await post('/api/materials',{topicId:topic.id,name:'test.txt',size:data.length});
    assert.equal((await fetch(base+`/api/materials/${job.id}/upload?offset=0`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:data})).status,200);
    await post(`/api/materials/${job.id}/finish`);
    await wait(()=>release,Boolean);
    await post(`/api/materials/${job.id}/pause`);release();
    await new Promise(r=>setTimeout(r,80));assert.equal((await store.getView(topic.id)).revision,1);
    assert.equal((await materials.get(job.id)).processed,0);
    await server.shutdown();server=await startServer({port:0,agent:'codex',execute});base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await materials.get(job.id)).state,'paused');
    release=null;await post(`/api/materials/${job.id}/resume`);await wait(()=>release,Boolean);
    await store.saveDoc(topic.id,1,'## 主题\n只记录测试\n\n## 人工决定\n保留我刚改的内容。');
    hold=false;release();
    const completed=await wait(()=>materials.get(job.id),j=>j.state==='completed');
    assert.equal(completed.processed,data.length);assert.ok(completed.batches>=2);assert.ok(calls>=4);
    const view=await store.getView(topic.id);assert.match(view.doc,/保留我刚改的内容/);assert.match(view.doc,/已读最后一段/);
    const response=await fetch(base+`/api/topics/${topic.id}/download`);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/gftpack/);
    const exported=await response.text();assert.match(exported,/gft-materials/);assert.ok(JSON.parse(exported.trim().split('\n').at(-1)).end);
  }finally{release?.();await server?.shutdown();if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;await rm(dir,{recursive:true,force:true});}
});
