import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../store.mjs';
import * as materials from '../materials.mjs';
import { saveExecutorConfig } from '../executor-config.mjs';
import { installationId } from '../version.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.mjs',import.meta.url));
const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.mjs',import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const samePath = (a,b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const isAlive = pid => {try {process.kill(pid,0);return true;} catch (error) {if(error.code === 'ESRCH')return false;throw error;}};
async function waitFor(read, accept, timeout = 12000) {
  const until = Date.now()+timeout;
  let last;
  while (Date.now()<until) {last=await read();if(accept(last))return last;await delay(30);}
  throw new Error(`等待服务状态超时：${JSON.stringify(last)}`);
}
async function freeUrl() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${socket.address().port}`;
  await new Promise(resolve => socket.close(resolve));
  return url;
}
async function json(url,route,body) {
  const response = await fetch(url+route,{...(body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
  const value = await response.json();
  assert.equal(response.status,200,JSON.stringify(value));
  return value;
}
async function scenario(run) {
  const directory = await mkdtemp(path.join(tmpdir(),'gft-service-lifecycle-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = directory;
  const urls = new Set(), processes = new Set(), createdPids = new Set();
  const env = url => ({...process.env,GFT_LOCAL_HOME:directory,GFT_LOCAL_URL:url});
  const owned = runtime => {
    assert.equal(runtime.installationId,installationId);
    assert.ok(samePath(runtime.dataDirectory,directory));
    assert.equal(runtime.product,'gft-map');
    assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 0);
  };
  const reserve = async () => {let url;do {url=await freeUrl();} while(urls.has(url));urls.add(url);return url;};
  const call = async (url,args,overrides={}) => {
    const output = await execute(process.execPath,[cli,...args],{env:{...env(url),...overrides},windowsHide:true,timeout:20000});
    const value = JSON.parse(output.stdout);
    if(value.runtime && !overrides.GFT_LOCAL_HOME){owned(value.runtime);createdPids.add(value.runtime.pid);}
    return value;
  };
  const serve = url => {
    const child = spawn(process.execPath,[cli,'serve','--manual','--port',new URL(url).port],{env:env(url),stdio:['ignore','pipe','pipe'],windowsHide:true});
    let output='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const closed = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,output}));});
    void closed.catch(()=>{});
    const processRecord={child,closed,output:()=>output};processes.add(processRecord);createdPids.add(child.pid);
    return processRecord;
  };
  try {await run({directory,reserve,call,serve,owned,createdPids});}
  finally {
    for(const url of urls) {
      const runtime = await fetch(url+'/api/runtime',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).catch(()=>null);
      if(!runtime)continue;
      owned(runtime);
      assert.ok(createdPids.has(runtime.pid),'清理只处理本测试创建且已经核验身份的进程');
      for(const task of await json(url,'/api/tasks')) if(['pending','running'].includes(task.status)) await json(url,`/api/tasks/${task.id}/cancel`,{});
      for(const job of await json(url,'/api/materials')) if(['queued','running'].includes(job.state)) await json(url,`/api/materials/${job.id}/pause`,{});
      try {await call(url,['stop']);}
      catch(error) {
        // A failed test may have left the service unhealthy. Reconfirm the exact
        // owned instance before cleaning up only our newly created process.
        const latest=await json(url,'/api/runtime');owned(latest);
        assert.equal(latest.serviceInstanceId,runtime.serviceInstanceId);assert.equal(latest.pid,runtime.pid);
        process.kill(runtime.pid,'SIGKILL');
        await waitFor(()=>isAlive(runtime.pid),alive=>!alive);
        throw error;
      }
    }
    for(const record of processes) {
      if(record.child.exitCode === null && record.child.signalCode === null) await Promise.race([record.closed,delay(5000).then(()=>{throw new Error(`测试前台进程尚未退出：${record.output()}`);})]);
    }
    if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;
    const relative=path.relative(path.resolve(tmpdir()),path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory,{recursive:true,force:true});
  }
}

test('并发 CLI start 只启动同一份后台服务', {timeout:30000}, () => scenario(async ({directory,reserve,call}) => {
  const url=await reserve();
  const starts=await Promise.all(Array.from({length:5},()=>call(url,['start','--manual'])));
  assert.equal(new Set(starts.map(value=>value.runtime.serviceInstanceId)).size,1);
  assert.equal(new Set(starts.map(value=>value.runtime.pid)).size,1);
  assert.equal(starts.filter(value=>!value.reused).length,1);
  const events=(await readFile(path.join(directory,'service','events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event=>event.event==='started').length,1);
}));

test('前台 serve 的整个生命周期独占数据，另一端口的拒绝者不能恢复任务', {timeout:30000}, () => scenario(async ({directory,reserve,serve,owned}) => {
  const firstUrl=await reserve(),secondUrl=await reserve(),first=serve(firstUrl);
  const runtime=await waitFor(()=>fetch(firstUrl+'/api/runtime').then(r=>r.json()).catch(()=>null),Boolean);
  owned(runtime);assert.equal(runtime.pid,first.child.pid);
  const topic=await store.createTopic('互斥验证','仅记录隔离测试');
  const task=await store.createTask(topic.id,'update','拒绝者不得改动这条记录');
  const expired=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{expired.once('error',reject);expired.once('close',resolve);});
  assert.equal(isAlive(expired.pid),false);
  const taskFile=path.join(directory,'tasks',`${task.id}.json`);
  await writeFile(taskFile,JSON.stringify({...task,status:'running',runnerPid:expired.pid}));
  const before=await readFile(taskFile,'utf8');
  const rejected=serve(secondUrl);
  const result=await rejected.closed;
  assert.equal(result.code,1,result.output);assert.match(result.output,/已有服务进程|未启动第二份/);
  assert.equal(await readFile(taskFile,'utf8'),before,'拒绝者必须在 store.recover 之前退出');
  assert.equal((await json(firstUrl,'/api/runtime')).serviceInstanceId,runtime.serviceInstanceId);
  await assert.rejects(fetch(secondUrl+'/api/runtime'));
}));

test('核验后强杀自己的服务，重新 open 保留主题 Log 与暂停材料存档', {timeout:30000}, () => scenario(async ({directory,reserve,call,serve,owned}) => {
  const topic=await store.createTopic('恢复原内容','只记录服务恢复',{ledger:'走向 p1 [主题]\n只记录服务恢复\n◆ j1 [保留] 原判断\n原判断不能丢失。',raw:'原始 Log：恢复必须保留这段文字。'});
  const bytes=Buffer.from('材料原文😀：只处理合成测试。\n'.repeat(12000));
  const job=await materials.create({topicId:topic.id,name:'retained.txt',size:bytes.length});
  for(let offset=0;offset<bytes.length;offset+=materials.UPLOAD_BYTES) await materials.upload(job.id,offset,bytes.subarray(offset,offset+materials.UPLOAD_BYTES));
  await materials.finish(job.id);
  const worker=materials.createWorker({run:async request=>request.stage==='extract'?'{"summary":"原始材料保留。"}':'<noop/>'});
  try {await worker.tick();await worker.control(job.id,'pause');} finally {await worker.close();}
  const savedJob=await materials.get(job.id),savedTopic=await store.getTopic(topic.id);
  assert.equal(savedJob.state,'paused');assert.equal(savedJob.batches,1);assert.ok(savedJob.processed>0 && savedJob.processed<bytes.length);
  const url=await reserve(),first=serve(url);
  const runtime=await waitFor(()=>fetch(url+'/api/runtime').then(r=>r.json()).catch(()=>null),Boolean);
  owned(runtime);assert.equal(runtime.pid,first.child.pid);
  const state=await waitFor(()=>readFile(path.join(directory,'service','state.json'),'utf8').then(JSON.parse).catch(()=>null),value=>value?.instanceId===runtime.serviceInstanceId);
  assert.equal(state.instanceId,runtime.serviceInstanceId);assert.equal(state.pid,first.child.pid);
  process.kill(first.child.pid,'SIGKILL');await first.closed;
  const restored=await call(url,['open','--manual','--no-browser']);
  assert.notEqual(restored.runtime.serviceInstanceId,runtime.serviceInstanceId);
  const after=await store.getTopic(topic.id),material=await materials.get(job.id);
  assert.equal(after.ledger,savedTopic.ledger);assert.equal(after.raw,savedTopic.raw);
  assert.deepEqual(after.materialCheckpoints,savedTopic.materialCheckpoints);
  assert.equal(material.state,'paused');assert.equal(material.processed,savedJob.processed);assert.equal(material.batches,savedJob.batches);
  assert.deepEqual(await materials.readBytes(job.id,0,bytes.length),bytes);
  const events=(await readFile(path.join(directory,'service','events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event=>event.event==='previous-exit-unobserved' && event.previousPid===runtime.pid));
}));

test('后台启动恢复原 executor.json，并由合成 Codex 子进程完成任务', {timeout:30000}, () => scenario(async ({directory,reserve,call}) => {
  await saveExecutorConfig({agent:'codex',runnerOptions:{binary:process.execPath,prefixArgs:[fakeCodex,'--fixture-mode=success'],model:'fixture-model'}});
  const configuration=await readFile(path.join(directory,'executor.json'),'utf8');
  const url=await reserve(),started=await call(url,['start']);
  assert.equal(started.runtime.agent,'codex');assert.equal(started.runtime.mode,'automatic');assert.equal(started.runtime.executor.status,'ready');
  const topic=await store.createTopic('执行器恢复','只记录合成验收');
  const task=await json(url,`/api/topics/${topic.id}/tasks`,{action:'update',input:'这是合成任务，不调用真实模型。'});
  const completed=await waitFor(()=>store.getTask(task.id),value=>['completed','failed'].includes(value.status));
  assert.equal(completed.status,'completed',completed.error);
  assert.match((await store.getView(topic.id)).doc,/子进程结果已回填/);
  await call(url,['stop']);
  const restored=await call(url,['start']);
  assert.equal(restored.runtime.agent,'codex');assert.equal(restored.runtime.executor.status,'ready');
  assert.equal(await readFile(path.join(directory,'executor.json'),'utf8'),configuration);
}));

test('忙时 stop 和错误数据或安装身份均不能关闭已核验服务', {timeout:30000}, () => scenario(async ({directory,reserve,call}) => {
  const url=await reserve(),started=await call(url,['start','--manual']);
  const topic=await store.createTopic('忙时保留','保留排队任务'),task=await store.createTask(topic.id,'update','尚未开始的授权任务');
  await assert.rejects(call(url,['stop']),error=>{assert.equal(JSON.parse(error.stderr).status,409);return true;});
  assert.equal((await store.getTask(task.id)).status,'pending');
  assert.equal((await json(url,'/api/runtime')).serviceInstanceId,started.runtime.serviceInstanceId);
  await json(url,`/api/tasks/${task.id}/cancel`,{});
  await assert.rejects(call(url,['stop'],{GFT_LOCAL_HOME:path.join(directory,'different-data')}),error=>{assert.equal(JSON.parse(error.stderr).status,409);return true;});
  const response=await fetch(url+'/api/service/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({installationId:'another-installation',dataDirectory:directory,serviceInstanceId:started.runtime.serviceInstanceId})});
  assert.equal(response.status,409);
  assert.equal((await json(url,'/api/runtime')).serviceInstanceId,started.runtime.serviceInstanceId);
}));
