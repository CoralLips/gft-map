import {mkdir,readFile,open,readdir,stat,unlink,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import * as store from './store.mjs';
import {prepareImport,parseImportSummary,prepareTask,viewTopic} from './dist/core.mjs';

// Limits are per transfer/read, never a total source-size limit.
export const UPLOAD_BYTES=512*1024;
export const PAGE_BYTES=48000;
const validId=id=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id || ''))throw store.fail('无效的材料 ID');return id;};
export const directory=id=>path.join(store.homeDir(),'materials',validId(id));
const metaFile=id=>path.join(store.homeDir(),'materials',`${validId(id)}.json`);
export const sourceFile=id=>path.join(directory(id),'original');
const digest=value=>createHash('sha256').update(value).digest('hex');
const save=job=>store.writeJsonAtomic(metaFile(job.id),{...job,updatedAt:new Date().toISOString()});
async function lock(id,run) {
  for(let attempt=0;;attempt++) {
    let acquired=false;
    try{return await store.withRecordLock('materials',id,()=>{acquired=true;return run();});}
    catch(error){if(acquired||error.status!==409||attempt>=79)throw error;await new Promise(resolve=>setTimeout(resolve,25));}
  }
}
export async function get(id) {
  try {return JSON.parse(await readFile(metaFile(id),'utf8'));}
  catch(error){if(error.code==='ENOENT')throw store.fail('材料不存在',404);throw error;}
}
export async function list(topicId) {
  const root=path.join(store.homeDir(),'materials');await mkdir(root,{recursive:true});
  const result=[];
  for(const name of await readdir(root))if(/^[a-zA-Z0-9_-]+\.json$/.test(name)) {
    const job=await get(name.slice(0,-5));
    if(!topicId || (job.topicId===topicId&&job.kind==='text'))result.push(job);
  }
  return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export async function evidence(topicId,nodeIds=[],limit=12000) {
  let text='';
  for(const job of await list(topicId)) {
    if(job.kind!=='text')continue;
    const names=(await readdir(directory(job.id))).filter(n=>/^part-\d+\.json$/.test(n)).sort((a,b)=>Number(b.slice(5,-5))-Number(a.slice(5,-5)));
    for(const name of names){const item=JSON.parse(await readFile(path.join(directory(job.id),name),'utf8'));
      if(!item.outputs?.some(id=>nodeIds.includes(id)))continue;
      const source=await page(job.id,item.start);text+=`\n\n[${job.name} · ${source.start}–${source.end}]\n${source.text.slice(0,limit-text.length)}`;
      if(text.length>=limit)return text.slice(0,limit);
    }
  }
  return text;
}
export async function create({topicId,name,size,kind='text'}) {
  if(typeof name!=='string'||!name.trim()||name.length>240||/[\x00-\x1f]/.test(name))throw store.fail('文件名无效');
  if(!Number.isSafeInteger(size)||size<=0)throw store.fail('文件为空或大小无效');
  if(!['text','archive'].includes(kind))throw store.fail('不支持的材料类型');
  if(kind==='text'&&!/\.(txt|md|markdown|jsonl|ndjson|json)$/i.test(name))throw store.fail('请使用 UTF-8 文本、Markdown 或聊天记录文件');
  // A transfer archive restores a new topic; it is never an original belonging
  // to the topic that happened to be selected when the user opened Import.
  if(kind==='archive')topicId=null;
  const topic=topicId ? await store.getTopic(topicId) : null;
  if(kind==='text'&&(!topic||topic.archived))throw store.fail('请先选择要加入的脉络');
  const job={id:randomUUID(),topicId:topicId || null,name:path.basename(name),size,kind,scope:topic?.scope || '',received:0,processed:0,batches:0,state:'uploading',epoch:0,contentRevision:0,createdAt:new Date().toISOString()};
  await mkdir(directory(job.id),{recursive:true});await save(job);return job;
}
export async function upload(id,offset,bytes) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>UPLOAD_BYTES||!Number.isSafeInteger(offset)||offset<0)throw store.fail('文件分块无效');
  return store.withRecordLock('materials',id,async()=>{
    const job=await get(id);
    if(job.state!=='uploading'||offset+bytes.length>job.size)throw store.fail('文件接收状态已改变',409);
    if(offset<job.received) {
      if(offset+bytes.length>job.received||!(await readBytes(id,offset,bytes.length)).equals(bytes))throw store.fail('续传文件与已保存内容不一致，请选择原文件',409);
      return job;
    }
    if(offset!==job.received)throw store.fail('文件接收位置不同，请从存档位置继续',409);
    const handle=await open(sourceFile(id),offset===0?'w':'r+');
    try {await handle.truncate(offset);await writeAt(handle,bytes,offset);await handle.sync();}
    finally{await handle.close();}
    const next={...job,received:offset+bytes.length};await save(next);return next;
  });
}
export async function writeAt(handle,bytes,position) {
  let written=0;
  while(written<bytes.length){const {bytesWritten}=await handle.write(bytes,written,bytes.length-written,position+written);if(!bytesWritten)throw store.fail('无法保存文件分块');written+=bytesWritten;}
}
export async function readBytes(id,start,length) {
  const handle=await open(sourceFile(id),'r');
  try {const bytes=Buffer.alloc(length);let received=0;while(received<length){const {bytesRead}=await handle.read(bytes,received,length-received,start+received);if(!bytesRead)break;received+=bytesRead;}return bytes.subarray(0,received);}
  finally{await handle.close();}
}
export async function finish(id) {
  const job=await get(id);
  if(job.state!=='uploading')return job;
  if(job.received!==job.size||(await stat(sourceFile(id))).size!==job.size)throw store.fail('文件尚未接收完整，可继续上传',409);
  // Completed upload bytes are immutable. Hash outside the short metadata lock
  // so a pause request remains responsive even for a multi-gigabyte original.
  const hash=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true});
  try {for await(const bytes of createReadStream(sourceFile(id))){hash.update(bytes);if(job.kind==='text'){const text=decoder.decode(bytes,{stream:true});if(text.includes('\0'))throw new TypeError('binary');}}if(job.kind==='text')decoder.decode();}
  catch(error) {if(error instanceof TypeError)throw store.fail('文件不是有效 UTF-8 文本，请先转换为文本；原文件已保留');throw error;}
  return lock(id,async()=>{
    const current=await get(id);if(current.state!=='uploading')return current;
    const next={...current,sha256:hash.digest('hex'),state:current.kind==='archive'?'ready':current.pauseAfterUpload?'paused':'queued',error:null};
    await save(next);return next;
  });
}
export async function discard(id) {
  return lock(id,async()=>{
    const job=await get(id);
    if(job.state!=='uploading')throw store.fail('只能取消未完成的文件导入；已保存的材料请使用暂停',409);
    const root=path.resolve(store.homeDir(),'materials'),target=path.resolve(directory(id));
    if(path.dirname(target)!==root)throw store.fail('材料目录无效');
    await rm(target,{recursive:true,force:true});await unlink(metaFile(id));return {removed:true};
  });
}
async function slice(job,start) {
  if(!Number.isSafeInteger(start)||start<0||start>=job.size)throw store.fail('原文位置无效');
  let bytes=await readBytes(job.id,start,Math.min(PAGE_BYTES+4,job.size-start));
  let length=Math.min(PAGE_BYTES,bytes.length);
  // Keep UTF-8 scalars intact and prefer a nearby paragraph/line boundary.
  if(start+length<job.size)while(length>0&&(bytes[length]&0xc0)===0x80)length--;
  const newline=bytes.lastIndexOf(10,length-1);
  if(start+length<job.size&&newline>length/2)length=newline+1;
  bytes=bytes.subarray(0,length);
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw store.fail('原文位置不在字符边界');}
  return {start,end:start+length,text};
}
const editFile=(id,start)=>path.join(directory(id),`edit-${start}.json`);
export async function page(id,start=0) {
  const job=await get(id);
  if(job.received!==job.size)throw store.fail('文件接收后可查看原文',409);
  const part=await slice(job,Number(start));
  try {const edit=JSON.parse(await readFile(editFile(id,part.start),'utf8'));if(edit.end===part.end)part.text=edit.text;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  return {...part,id,size:job.size,etag:digest(part.text),processed:job.processed};
}
export async function editPage(id,start,end,text,etag) {
  if(typeof text!=='string'||text.length>PAGE_BYTES*2)throw store.fail('请分段编辑材料');
  return store.withRecordLock('materials',id,async()=>{
    const job=await get(id);if(!['paused','completed','failed'].includes(job.state))throw store.fail('请先暂停整理，再编辑原文',409);
    const current=await page(id,start);
    if(current.end!==end||current.etag!==etag)throw store.fail('原文已被另一处修改，未覆盖当前版本',409);
    await store.writeJsonAtomic(editFile(id,start),{start,end,text});
    await save({...job,contentRevision:job.contentRevision+1,pendingEdits:[...new Set([...(job.pendingEdits||[]),...(start<job.processed?[start]:[])])]});
    return page(id,start);
  });
}
export async function receipt(id,start) {
  if(!Number.isSafeInteger(start)||start<0)throw store.fail('存档位置无效');
  try{return JSON.parse(await readFile(path.join(directory(id),`part-${start}.json`),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
const exited=pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}};
export function createWorker({run}) {
  let closed=false,running=null,active=null;
  async function recover() {
    const root=path.join(store.homeDir(),'materials');await mkdir(root,{recursive:true});
    for(const name of await readdir(root))if(name.endsWith('.json.lock')) {
      const filename=path.join(root,name),pid=Number(await readFile(filename,'utf8').catch(()=>0));
      if(pid>0&&exited(pid))await unlink(filename).catch(()=>{});
    }
    for(const job of await list())if(job.state==='running'&&job.pid&&exited(job.pid))await save({...job,state:'queued',pid:null});
    // A hard exit may occur inside the atomic topic commit, before its short
    // lock is removed. Recover only locks belonging to dead owners of our topics.
    for(const job of await list())if(job.topicId){
      const filename=path.join(store.homeDir(),'topics',`${validId(job.topicId)}.json.lock`);
      const pid=Number(await readFile(filename,'utf8').catch(()=>0));if(pid>0&&exited(pid))await unlink(filename).catch(()=>{});
    }
  }
  async function control(id,action) {
    if(!['pause','resume'].includes(action))throw store.fail('不支持的材料操作');
    // Abort immediately; the epoch check also discards a late model response.
    if(action==='pause'&&active?.id===id)active.controller.abort();
    return lock(id,async()=>{
      const job=await get(id);
      if(job.kind!=='text')throw store.fail('文件尚未准备好',409);
      if(job.state==='uploading') {
        const next={...job,pauseAfterUpload:action==='pause',epoch:job.epoch+1};await save(next);return next;
      }
      if(job.state==='completed'&&!job.pendingEdits?.length)return job;
      if(action==='resume'&&job.state==='running')return job;
      const next={...job,state:action==='pause'?'paused':'queued',epoch:job.epoch+1,error:null,pid:null};await save(next);return next;
    });
  }
  async function step() {
    const candidate=(await list()).filter(j=>j.state==='queued').at(-1);if(!candidate)return;
    const job=await store.withRecordLock('materials',candidate.id,async()=>{
      const current=await get(candidate.id);if(current.state!=='queued')return null;
      const topic=await store.getTopic(current.topicId),checkpoint=topic.materialCheckpoints?.[current.id];
      const next={...current,processed:checkpoint?.offset || 0,batches:checkpoint?.batches || 0,state:'running',pid:process.pid};
      await save(next);return next;
    });
    if(!job)return;
    const controller=new AbortController();active={id:job.id,controller};
    const check=async()=>{const current=await get(job.id);if(closed||controller.signal.aborted||current.state!=='running'||current.epoch!==job.epoch)throw store.fail('整理已暂停，存档保留',409);return current;};
    try {
      const topic=await store.getTopic(job.topicId);
      if(topic.archived)throw store.fail('脉络已删除，材料保留');
      if(job.scope&&topic.scope!==job.scope)throw store.fail('主题范围已改变，请恢复原主题再继续；已完成内容保留');
      if(job.processed>=job.size&&!job.pendingEdits?.length){await save({...job,state:'completed',pid:null});return;}
      const correction=job.pendingEdits?.length>0;
      const part=await page(job.id,correction?job.pendingEdits[0]:job.processed);
      if(correction&&topic.materialCheckpoints?.[job.id]?.corrections?.[part.start]>=job.contentRevision){await save({...job,pendingEdits:job.pendingEdits.slice(1),state:'queued',pid:null});return;}
      let saved=await receipt(job.id,part.start);
      const appliedCorrection=topic.materialCheckpoints?.[job.id]?.corrections?.[part.start];
      const alreadyApplied=saved?.correctionRevision&&appliedCorrection>=saved.correctionRevision;
      const previousSummary=alreadyApplied?saved.summary:saved?.previousSummary ?? saved?.summary ?? '';
      if(!saved||saved.etag!==part.etag) {
        const request=prepareImport(topic,part.text);
        const result=part.text.trim()?await run({...request,materialId:job.id,stage:'extract'},controller.signal):'{"summary":""}';
        await check();
        const summary=parseImportSummary(typeof result==='string'?result:result.output);
        saved={start:part.start,end:part.end,etag:part.etag,summary,scope:job.scope,...(correction?{previousSummary,correctionRevision:job.contentRevision}: {})};
        await store.writeJsonAtomic(path.join(directory(job.id),`part-${part.start}.json`),saved);
      }
      let base=await store.getTopic(job.topicId),output='';
      if(base.scope!==topic.scope)throw store.fail('主题范围已改变，请恢复原主题再继续；已完成内容保留');
      if(saved.summary||correction) {
        const request=prepareTask(base,'update',`文件：${job.name}\n原文位置：${part.start}–${part.end} 字节\n${correction?`此段来源已由人修改，以下当前内容取代原内容。撤销只由旧内容支撑的判断，保留其他依据与人工编辑。\n修改前提炼：${previousSummary}\n修改后：\n`:''}${saved.summary||'（此段已清空）'}`);
        const result=await run({...request,materialId:job.id,stage:'publish'},controller.signal);
        output=typeof result==='string'?result:result.output;
      }
      await check();
      await store.withRecordLock('materials',job.id,async()=>{
        await check();
        const before=new Map(viewTopic(base).graph.nodes.map(n=>[n.id,JSON.stringify(n)]));
        const result=await store.commitMaterialBatch(job.topicId,base.revision,{id:job.id,start:part.start,end:part.end,...(correction?{correction:job.contentRevision}: {})},output);
        const {previousSummary:_previous,...appliedReceipt}=saved;
        await store.writeJsonAtomic(path.join(directory(job.id),`part-${part.start}.json`),{...appliedReceipt,outputs:result.graph.nodes.filter(n=>before.get(n.id)!==JSON.stringify(n)).map(n=>n.id)});
        const pendingEdits=correction?job.pendingEdits.slice(1):job.pendingEdits||[],processed=correction?job.processed:part.end;
        await save({...job,scope:job.scope||result.scope||'',processed,batches:job.batches+(correction?0:1),pendingEdits,state:processed===job.size&&!pendingEdits.length?'completed':'queued',pid:null,error:null});
      });
    }catch(error) {
      await store.withRecordLock('materials',job.id,async()=>{
        const current=await get(job.id);
        if(current.epoch!==job.epoch||current.state==='paused')return;
        // Concurrent human edits only invalidate this publication, not extraction.
        const retry=error.status===409&&!controller.signal.aborted&&!closed;
        await save({...current,state:closed?'queued':retry?'queued':'failed',pid:null,error:retry?null:error.message});
      }).catch(()=>{});
    }finally{active=null;}
  }
  return {recover,control,snapshot:()=>active?{id:active.id}:null,
    tick(){if(closed||running)return running;running=step().finally(()=>{running=null;});return running;},
    async close(){closed=true;active?.controller.abort();await running;}};
}
