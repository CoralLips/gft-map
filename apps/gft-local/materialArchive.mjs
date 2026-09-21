import {createReadStream} from 'node:fs';
import {mkdir,readdir,readFile,open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import * as store from './store.mjs';
import * as materials from './materials.mjs';

// A line-oriented transfer file. Every original is streamed in small blocks;
// restoring never parses or base64-decodes the complete file in memory.
export async function* archive(topicId) {
  const topic=await store.getTopic(topicId),jobs=await materials.list(topicId);
  if(jobs.some(j=>j.received!==j.size||!j.sha256))throw store.fail('原文件尚未接收完整，请完成续传后下载');
  if(jobs.some(j=>['running','queued'].includes(j.state)))throw store.fail('请先暂停材料整理，再下载完整存档');
  const hash=createHash('sha256');
  const line=value=>{const bytes=Buffer.from(JSON.stringify(value)+'\n');hash.update(bytes);return bytes;};
  yield line({format:'gft-materials',version:1,topic:{name:topic.name,ledger:topic.ledger,raw:topic.raw},materials:jobs.map(j=>({id:j.id,name:j.name,size:j.size,sha256:j.sha256,scope:j.scope,contentRevision:j.contentRevision,pendingEdits:j.pendingEdits||[],processed:topic.materialCheckpoints?.[j.id]?.offset||0,batches:topic.materialCheckpoints?.[j.id]?.batches||0}))});
  for(const job of jobs){
    let offset=0;
    for await(const bytes of createReadStream(materials.sourceFile(job.id),{highWaterMark:65536})){
      yield line({id:job.id,offset,data:bytes.toString('base64')});offset+=bytes.length;
    }
    for(const filename of await readdir(materials.directory(job.id)))if(/^(edit|part)-\d+\.json$/.test(filename))yield line({id:job.id,record:filename,value:JSON.parse(await readFile(path.join(materials.directory(job.id),filename),'utf8'))});
    const current=await materials.get(job.id);
    if(current.contentRevision!==job.contentRevision||current.epoch!==job.epoch)throw store.fail('下载期间材料已改变，请暂停后重新下载');
  }
  yield Buffer.from(JSON.stringify({end:true,sha256:hash.digest('hex')})+'\n');
}
async function* lines(filename) {
  let tail=Buffer.alloc(0);
  for await(const chunk of createReadStream(filename)) {
    tail=Buffer.concat([tail,chunk]);
    let end;
    while((end=tail.indexOf(10))!==-1){yield tail.subarray(0,end+1);tail=tail.subarray(end+1);}
    if(tail.length>16*1024*1024)throw store.fail('迁移文件记录过大或格式损坏');
  }
  if(tail.length)throw store.fail('迁移文件不完整，未创建脉络');
}
export async function restore(archiveId) {
  return store.withRecordLock('materials',archiveId,async()=>{
    const upload=await materials.get(archiveId);
    if(upload.restoredTopicId)return store.getView(upload.restoredTopicId);
    if(upload.kind!=='archive'||upload.received!==upload.size||!upload.sha256)throw store.fail('请先接收完整迁移文件');
    const hash=createHash('sha256'),entries=new Map();
    let header,ended=false;
    const topicId=upload.restoreTarget||randomUUID();
    await store.writeJsonAtomic(path.join(store.homeDir(),'materials',`${archiveId}.json`),{...upload,restoreTarget:topicId});
    for await(const line of lines(materials.sourceFile(archiveId))) {
      if(ended)throw store.fail('迁移文件结束后还有多余内容');
      let item;try{item=JSON.parse(line.toString('utf8'));}catch{throw store.fail('迁移文件无法解析');}
      if(item.end===true){if(item.sha256!==hash.digest('hex'))throw store.fail('迁移文件校验失败，未创建脉络');ended=true;continue;}
      hash.update(line);
      if(!header){
        if(item.format!=='gft-materials'||item.version!==1||!item.topic||typeof item.topic.name!=='string'||!item.topic.name.trim()||item.topic.name.length>200||typeof item.topic.ledger!=='string'||typeof item.topic.raw!=='string'||!Array.isArray(item.materials))throw store.fail('不支持的迁移文件');
        header=item;
        for(const source of item.materials){
          if(!/^[a-zA-Z0-9_-]{1,100}$/.test(source.id)||entries.has(source.id)||typeof source.name!=='string'||source.name.length>240||!Number.isSafeInteger(source.size)||source.size<=0||!Number.isSafeInteger(source.processed)||source.processed<0||source.processed>source.size||!/^[a-f0-9]{64}$/.test(source.sha256))throw store.fail('迁移文件材料目录无效');
          if(typeof source.scope!=='string'||!Number.isSafeInteger(source.batches)||source.batches<0||!Number.isSafeInteger(source.contentRevision)||source.contentRevision<0||!Array.isArray(source.pendingEdits)||!source.pendingEdits.every(n=>Number.isSafeInteger(n)&&n>=0&&n<source.processed))throw store.fail('迁移文件存档进度无效');
          const id=store.syncConflictId(archiveId,source.id);await mkdir(materials.directory(id),{recursive:true});
          entries.set(source.id,{...source,id,received:0,hash:createHash('sha256')});
        }
      }else{
        const entry=entries.get(item.id);if(!entry)throw store.fail('迁移文件包含未登记的材料');
        if(typeof item.data==='string'){
          if(item.offset!==entry.received||item.data.length>100000||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.data))throw store.fail('迁移文件分块无效');
          const bytes=Buffer.from(item.data,'base64');if(!bytes.length||entry.received+bytes.length>entry.size)throw store.fail('迁移文件材料大小不符');
          const handle=await open(materials.sourceFile(entry.id),entry.received===0?'w':'r+');
          try{await materials.writeAt(handle,bytes,entry.received);await handle.sync();}finally{await handle.close();}
          entry.hash.update(bytes);entry.received+=bytes.length;
        }else if(/^(edit|part)-\d+\.json$/.test(item.record||'')){
          if(!item.value||!Number.isSafeInteger(item.value.start)||item.value.start<0||!Number.isSafeInteger(item.value.end)||item.value.end>entry.size||item.value.end<=item.value.start||item.record.split('-')[1]!==`${item.value.start}.json`)throw store.fail('迁移文件原文记录无效');
          if(item.record.startsWith('edit-')&&(typeof item.value.text!=='string'||item.value.text.length>materials.PAGE_BYTES*2))throw store.fail('迁移文件修改记录无效');
          if(item.record.startsWith('part-')&&(typeof item.value.summary!=='string'||item.value.summary.length>12000||typeof item.value.etag!=='string'||(item.value.outputs!==undefined&&(!Array.isArray(item.value.outputs)||!item.value.outputs.every(id=>typeof id==='string')))))throw store.fail('迁移文件整理记录无效');
          await store.writeJsonAtomic(path.join(materials.directory(entry.id),item.record),item.value);
        }else throw store.fail('未知迁移文件记录');
      }
    }
    if(!header||!ended)throw store.fail('迁移文件不完整，未创建脉络');
    for(const entry of entries.values())if(entry.received!==entry.size||entry.hash.digest('hex')!==entry.sha256)throw store.fail('原文件校验失败，未创建脉络');
    const checkpoints={};
    for(const entry of entries.values()){
      checkpoints[entry.id]={offset:entry.processed,batches:entry.batches};
      const {hash,...metadata}=entry;
      await store.writeJsonAtomic(path.join(store.homeDir(),'materials',`${entry.id}.json`),{...metadata,topicId,name:path.basename(entry.name),kind:'text',state:entry.processed===entry.size&&!entry.pendingEdits?.length?'completed':'paused',epoch:0,contentRevision:entry.contentRevision||0,createdAt:new Date().toISOString()});
    }
    let view;
    try{view=await store.createTopic(header.topic.name,'',{ledger:header.topic.ledger,raw:header.topic.raw,materialCheckpoints:checkpoints},topicId);}
    catch(error){if(error.status!==409)throw error;view=await store.getView(topicId);}
    await store.writeJsonAtomic(path.join(store.homeDir(),'materials',`${archiveId}.json`),{...upload,state:'completed',restoreTarget:topicId,restoredTopicId:topicId});
    return view;
  });
}
