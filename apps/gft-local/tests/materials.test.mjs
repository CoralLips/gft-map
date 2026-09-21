import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as store from '../store.mjs';
import * as materials from '../materials.mjs';
import {archive,restore} from '../materialArchive.mjs';

test('restoring an archive does not attach the transfer file to the currently selected topic',async()=>{
  const previous=process.env.GFT_LOCAL_HOME,dir=await mkdtemp(path.join(tmpdir(),'gft-material-transfer-'));process.env.GFT_LOCAL_HOME=dir;
  try {
    const topic=await store.createTopic('正在查看的脉络','保留已有内容');
    const blocks=[];for await(const block of archive(topic.id))blocks.push(block);
    const bytes=Buffer.concat(blocks),upload=await materials.create({topicId:topic.id,name:'restore.gftpack',size:bytes.length,kind:'archive'});
    await materials.upload(upload.id,0,bytes);await materials.finish(upload.id);await restore(upload.id);
    assert.deepEqual(await materials.list(topic.id),[],'a transport archive is not source material');
    // Upgrades must also hide transport records incorrectly attached by v0.3.1.
    await writeFile(path.join(dir,'materials',`${upload.id}.json`),JSON.stringify({...await materials.get(upload.id),topicId:topic.id}));
    assert.deepEqual(await materials.list(topic.id),[]);
    const exported=[];for await(const block of archive(topic.id))exported.push(block);
    assert.deepEqual(JSON.parse(Buffer.concat(exported).toString().split('\n')[0]).materials,[]);
  } finally {if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;await rm(dir,{recursive:true,force:true});}
});

test('successive source corrections replace the last applied summary, not the first-ever summary',async()=>{
  const previous=process.env.GFT_LOCAL_HOME,dir=await mkdtemp(path.join(tmpdir(),'gft-material-correction-'));process.env.GFT_LOCAL_HOME=dir;
  let worker;
  try {
    const topic=await store.createTopic('连续修正','只记录计划'),bytes=Buffer.from('plan-A');
    const job=await materials.create({topicId:topic.id,name:'plan.txt',size:bytes.length});
    await materials.upload(job.id,0,bytes);await materials.finish(job.id);
    const publications=[];
    worker=materials.createWorker({run:async request=>{
      if(request.stage==='extract')return JSON.stringify({summary:request.user.match(/plan-[ABC]/)?.[0]||'missing'});
      publications.push(request.user);return '<noop/>';
    }});
    await worker.tick();
    for(const text of ['plan-B','plan-C']) {
      const page=await materials.page(job.id,0);await materials.editPage(job.id,0,page.end,text,page.etag);
      await worker.control(job.id,'resume');await worker.tick();
    }
    assert.equal(publications.length,3);
    assert.match(publications[1],/修改前提炼：plan-A/);
    assert.match(publications[2],/修改前提炼：plan-B/);
    assert.doesNotMatch(publications[2],/修改前提炼：plan-A/);
  } finally {await worker?.close();if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;await rm(dir,{recursive:true,force:true});}
});

test('pausing at the end of upload prevents automatic processing; abandoned transfers can be removed without touching results',async()=>{
  const previous=process.env.GFT_LOCAL_HOME,dir=await mkdtemp(path.join(tmpdir(),'gft-material-upload-pause-'));process.env.GFT_LOCAL_HOME=dir;
  let worker;
  try {
    const topic=await store.createTopic('上传暂停','保存来源'),bytes=Buffer.from('暂停不应启动模型。'.repeat(1000));
    const job=await materials.create({topicId:topic.id,name:'pause.txt',size:bytes.length});
    await materials.upload(job.id,0,bytes);
    let calls=0;worker=materials.createWorker({run:async()=>{calls++;return '<noop/>';}});
    const finish=materials.finish(job.id);const pause=worker.control(job.id,'pause');
    await Promise.all([finish,pause]);await worker.tick();
    assert.equal(calls,0);assert.equal((await materials.get(job.id)).state,'paused');
    await worker.control(job.id,'resume');assert.equal((await materials.get(job.id)).state,'queued');
    await worker.control(job.id,'pause');
    const abandoned=await materials.create({topicId:topic.id,name:'interrupted.txt',size:bytes.length});
    await materials.upload(abandoned.id,0,bytes.subarray(0,100));
    await assert.rejects(async()=>{for await(const _ of archive(topic.id)){};},/续传/);
    await materials.discard(abandoned.id);
    assert.equal((await materials.list(topic.id)).length,1);
    for await(const _ of archive(topic.id)){};
    await assert.rejects(materials.discard(job.id),/未完成/);
    assert.equal((await materials.get(job.id)).state,'paused');
  } finally {await worker?.close();if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;await rm(dir,{recursive:true,force:true});}
});

test('agent source pagination reads the complete Unicode file and rejects cursors made stale by an edit',async()=>{
  const previous=process.env.GFT_LOCAL_HOME,dir=await mkdtemp(path.join(tmpdir(),'gft-material-pagination-'));process.env.GFT_LOCAL_HOME=dir;
  let worker;
  try {
    const topic=await store.createTopic('来源分页','读取完整原文'),text=('中文😀abc\n'.repeat(16000))+'LAST-MARKER';
    const bytes=Buffer.from(text),job=await materials.create({topicId:topic.id,name:'unicode.txt',size:bytes.length});
    for(let offset=0;offset<bytes.length;offset+=materials.UPLOAD_BYTES)await materials.upload(job.id,offset,bytes.subarray(offset,offset+materials.UPLOAD_BYTES));
    await materials.finish(job.id);worker=materials.createWorker({run:async()=>{throw new Error('Reading must not invoke a model');}});await worker.control(job.id,'pause');
    const initial=(await store.readSources(topic.id)).files[0].cursor;let cursor=initial,all='',count=0;
    while(cursor){const part=await store.readSources(topic.id,cursor);assert.ok(part.text.length<=12000);all+=part.text;cursor=part.nextCursor;assert.ok(++count<50);}
    assert.equal(all,text);assert.ok(count>2);
    const first=await materials.page(job.id,0);await materials.editPage(job.id,0,first.end,'corrected first page',first.etag);
    await assert.rejects(store.readSources(topic.id,initial),/材料已改变/);
    const current=(await store.readSources(topic.id)).files[0].cursor;assert.equal((await store.readSources(topic.id,current)).text,'corrected first page');
  }finally{await worker?.close();if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;await rm(dir,{recursive:true,force:true});}
});

test('large source: bounded upload, durable visible checkpoints, pause/restart and exact Unicode recovery', async () => {
  const previous=process.env.GFT_LOCAL_HOME, dir=await mkdtemp(path.join(tmpdir(),'gft-material-'));
  process.env.GFT_LOCAL_HOME=dir;
  let worker;
  try {
    const topic=await store.createTopic('材料验收','记录合成材料中的决定');
    const bytes=Buffer.from('原文😀\n决定：保留来源与人的编辑。\n'.repeat(150000));
    assert.ok(bytes.length>4*1024*1024);
    let job=await materials.create({topicId:topic.id,name:'large.txt',size:bytes.length});
    for(let offset=0;offset<bytes.length;offset+=materials.UPLOAD_BYTES) {
      const block=bytes.subarray(offset,offset+materials.UPLOAD_BYTES);
      await materials.upload(job.id,offset,block);
      if(offset===0) await materials.upload(job.id,offset,block); // lost response is safe to retry
    }
    await assert.rejects(materials.upload(job.id,0,Buffer.from('wrong')), /不同|不一致/);
    await materials.finish(job.id);
    let calls=0;
    worker=materials.createWorker({run:async request=>{
      assert.ok(request.user.length<60000);
      return ++calls%2===1 ? JSON.stringify({summary:'决定：保留来源与人的编辑。'}) : '<doc>\n## 验收\n### ◆ 保留原始来源\n可以追溯。\n</doc>';
    }});
    await worker.tick();
    job=await materials.get(job.id);
    assert.ok(job.processed>0 && job.processed<bytes.length);
    assert.equal(job.batches,1);
    assert.match((await store.getView(topic.id)).doc,/保留原始来源/);
    await worker.control(job.id,'pause');
    await worker.tick();
    assert.equal((await materials.get(job.id)).processed,job.processed);
    await worker.close();
    worker=materials.createWorker({run:async request=> request.system.includes('只输出 JSON') ? '{"summary":"仍然保留来源"}' : '<noop/>'});
    await worker.recover();
    assert.equal((await materials.get(job.id)).state,'paused');
    await worker.control(job.id,'resume');
    await worker.tick();
    assert.equal((await materials.get(job.id)).batches,2);
    assert.deepEqual(await materials.readBytes(job.id,0,bytes.length),bytes);
    assert.ok(JSON.stringify(await store.getSnapshot(topic.id)).length<50000, 'panel never receives full original');
    const page=await materials.page(job.id,0);
    assert.ok(page.text.length<60000);
    await worker.control(job.id,'pause');
    await materials.editPage(job.id,page.start,page.end,'人的修正',page.etag);
    assert.equal((await materials.page(job.id,0)).text,'人的修正');
    const blocks=[];for await(const block of archive(topic.id)){assert.ok(block.length<200000);blocks.push(block);}
    const pack=Buffer.concat(blocks),upload=await materials.create({name:'backup.gftpack',size:pack.length,kind:'archive'});
    for(let offset=0;offset<pack.length;offset+=materials.UPLOAD_BYTES)await materials.upload(upload.id,offset,pack.subarray(offset,offset+materials.UPLOAD_BYTES));
    await materials.finish(upload.id);
    const restored=await restore(upload.id),copies=await materials.list(restored.id);
    assert.notEqual(restored.id,topic.id);assert.equal(restored.doc,(await store.getView(topic.id)).doc);
    assert.equal(copies.length,1);assert.equal(copies[0].state,'paused');
    assert.equal((await materials.page(copies[0].id,0)).text,'人的修正');
    assert.deepEqual(await materials.readBytes(copies[0].id,0,bytes.length),bytes);
    assert.equal((await restore(upload.id)).id,restored.id,'retry is idempotent');
    const refs=await store.readSources(topic.id);assert.equal(refs.files.length,1);
    assert.equal((await store.readSources(topic.id,refs.files[0].cursor)).text,'人的修正');
  } finally {await worker?.close(); if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;await rm(dir,{recursive:true,force:true});}
});

test('checkpoint wins after crash between topic and job writes; interrupted uploads and malformed text are recoverable',async()=>{
  const previous=process.env.GFT_LOCAL_HOME,dir=await mkdtemp(path.join(tmpdir(),'gft-material-recovery-'));process.env.GFT_LOCAL_HOME=dir;
  let worker;
  try{
    const topic=await store.createTopic('恢复验收','只记录恢复测试'),bytes=Buffer.from('第一段材料。\n'.repeat(12000)+'尾部');
    let job=await materials.create({topicId:topic.id,name:'recovery.txt',size:bytes.length});
    await materials.upload(job.id,0,bytes.subarray(0,1000));
    await assert.rejects(materials.finish(job.id),/尚未接收完整/);
    await materials.upload(job.id,1000,bytes.subarray(1000));await materials.finish(job.id);
    const first=await materials.page(job.id,0);
    await store.commitMaterialBatch(topic.id,1,{id:job.id,start:0,end:first.end},'<doc>\n## 验收\n### ◆ 已保存首段\n进度和图文同一事务。\n</doc>');
    let firstPrompt='';
    worker=materials.createWorker({run:async request=>{firstPrompt ||= request.user;return request.stage==='extract'?'{"summary":"恢复后的第二段"}':'<noop/>';}});
    await worker.recover();await worker.tick();
    const recovered=await materials.get(job.id);
    assert.equal(recovered.batches,2);assert.ok(recovered.processed>first.end);
    assert.match((await store.getView(topic.id)).doc,/已保存首段/);
    await worker.control(job.id,'pause');
    const source=await materials.page(job.id,0);await materials.editPage(job.id,0,source.end,'改过的首段',source.etag);
    await assert.rejects(materials.editPage(job.id,0,source.end,'旧编辑器迟到的改动',source.etag),/另一处修改/);
    const raw=Buffer.from([0xff,0xfe,0x00]),bad=await materials.create({topicId:topic.id,name:'invalid.txt',size:raw.length});
    await materials.upload(bad.id,0,raw);await assert.rejects(materials.finish(bad.id),/UTF-8/);
    const state=await materials.get(bad.id);assert.equal(state.received,raw.length);
    const small=Buffer.from('短材料中的第一行比较长。\n第二行。'),tiny=await materials.create({topicId:topic.id,name:'tiny.txt',size:small.length});
    await materials.upload(tiny.id,0,small);await materials.finish(tiny.id);assert.equal((await materials.page(tiny.id,0)).end,small.length,'small files should not cause extra model calls merely because of a newline');
    // A corrupt transfer archive must not create an apparently successful topic.
    const fake=Buffer.from('{"format":"gft-materials","version":1,"topic":{"name":"bad","ledger":"","raw":""},"materials":[]}\n{"end":true,"sha256":"bad"}\n');
    const pack=await materials.create({name:'bad.gftpack',size:fake.length,kind:'archive'});await materials.upload(pack.id,0,fake);await materials.finish(pack.id);
    const before=(await store.listTopics()).length;await assert.rejects(restore(pack.id),/校验失败/);assert.equal((await store.listTopics()).length,before);
  }finally{await worker?.close();if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;await rm(dir,{recursive:true,force:true});}
});
