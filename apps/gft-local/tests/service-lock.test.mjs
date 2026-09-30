import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const lifecycleUrl = new URL('../serviceLifecycle.mjs',import.meta.url).href;
const digest = text => createHash('sha256').update(text).digest('hex');
const staleOwner = JSON.stringify({pid:-1,token:'expired-instance'});
const staleCleaner = JSON.stringify({pid:-1,token:'expired-cleaner'});
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

async function isolated(run) {
  const directory=await mkdtemp(path.join(tmpdir(),'gft-service-lock-'));
  await mkdir(path.join(directory,'service'));
  const main=path.join(directory,'service','instance.lock');
  await writeFile(main,staleOwner);
  try {await run({directory,main,env:{...process.env,GFT_LOCAL_HOME:directory,GFT_LOCK_MODULE:lifecycleUrl}});}
  finally {
    const relative=path.relative(path.resolve(tmpdir()),path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory,{recursive:true,force:true});
  }
}

// Each scenario patches built-in promises only inside an isolated Node child.
// The production module and other concurrently running tests remain untouched.
const delayedCleaner = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
const main=path.join(process.env.GFT_LOCAL_HOME,'service','instance.lock');
const contexts=new AsyncLocalStorage();
const original={readFile:fs.readFile,unlink:fs.unlink};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const held=deferred(),resume=deferred();
const within=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('受控清理调度超时')),5000);})]);}finally{clearTimeout(timer);}};
let intercepted=false,protectedUnlinks=0,winnerRelease,slowResult;
fs.readFile=async function(file,...args){
  const value=await original.readFile.call(this,file,...args);
  if(contexts.getStore()==='slow' && !intercepted && String(file).startsWith(main+'.reap-')) {
    intercepted=true;held.resolve();await resume.promise;
  }
  return value;
};
fs.unlink=async function(file,...args){
  if(String(file).startsWith(main+'.reap-') && !String(file).endsWith('.tmp')) {
    protectedUnlinks++;throw new Error('清理票据不能删除或复用');
  }
  return original.unlink.call(this,file,...args);
};
syncBuiltinESMExports();
const {acquireServiceLease}=await import(process.env.GFT_LOCK_MODULE);
const slow=contexts.run('slow',()=>acquireServiceLease()).then(release=>({release}),error=>({error}));
try {
  await within(held.promise);
  winnerRelease=await contexts.run('winner',()=>acquireServiceLease());
  const accepted=await original.readFile(main,'utf8');
  const filenames=(await fs.readdir(path.dirname(main))).filter(name=>name.startsWith('instance.lock.reap-')&&!name.endsWith('.tmp'));
  const tickets=await Promise.all(filenames.map(async name=>[name,await original.readFile(path.join(path.dirname(main),name),'utf8')]));
  assert.equal(tickets.length,2,'死清理票据与接管者各保留一张独立票据');
  resume.resolve();slowResult=await within(slow);
  assert.ok(slowResult.error,'旧读取恢复后不能取得第二份仍被占用的lease');
  assert.equal(slowResult.error.status,409);
  assert.equal(await original.readFile(main,'utf8'),accepted,'迟到的清理不得删除或替换活owner');
  await assert.rejects(acquireServiceLease(),{status:409});
  assert.equal(protectedUnlinks,0);
  for(const [name,text] of tickets)assert.equal(await original.readFile(path.join(path.dirname(main),name),'utf8'),text);
  await winnerRelease();winnerRelease=null;
  for(const [name,text] of tickets)assert.equal(await original.readFile(path.join(path.dirname(main),name),'utf8'),text,'释放lease也不删除清理票据');
  console.log(JSON.stringify({uniqueOwner:true,retainedTickets:tickets.length,protectedUnlinks}));
} finally {
  resume.resolve();slowResult ||= await slow;
  await slowResult.release?.();await winnerRelease?.();
  fs.readFile=original.readFile;fs.unlink=original.unlink;syncBuiltinESMExports();
}
`;

test('旧清理读取延迟返回时不能删除活 owner，清理票据始终原样保留', {timeout:12000}, () => isolated(async ({directory,main,env}) => {
  await writeFile(`${main}.reap-${digest(staleOwner)}`,staleCleaner);
  const output=await execute(process.execPath,['--input-type=module','-e',delayedCleaner],{env,windowsHide:true,timeout:10000});
  assert.deepEqual(JSON.parse(output.stdout),{uniqueOwner:true,retainedTickets:2,protectedUnlinks:0});
  assert.equal((await readdir(path.join(directory,'service'))).filter(name=>name.startsWith('instance.lock.reap-')).length,2);
}));

const pausedOwner = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const main=path.join(process.env.GFT_LOCAL_HOME,'service','instance.lock');
const original=fs.unlink;
if(process.env.GFT_LOCK_PAUSE==='yes') {
  fs.unlink=async function(file,...args){
    if(String(file)===main) {process.send({event:'cleanup-held',pid:process.pid});await new Promise(()=>{});}
    return original.call(this,file,...args);
  };
  syncBuiltinESMExports();
}
const keepAlive=setInterval(()=>{},1000);
process.on('message',()=>{});
try {
  const {acquireServiceLease}=await import(process.env.GFT_LOCK_MODULE);
  const release=await acquireServiceLease();
  process.send({event:'lease-held',pid:process.pid,owner:JSON.parse(await fs.readFile(main,'utf8'))});
  await new Promise(resolve=>{process.on('message',message=>{if(message==='release')resolve();});});
  await release();
} finally {clearInterval(keepAlive);process.disconnect();}
`;
function child(env) {
  const processHandle=spawn(process.execPath,['--input-type=module','-e',pausedOwner],{env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let output='';const messages=[];
  processHandle.stdout.on('data',value=>{output+=value;});processHandle.stderr.on('data',value=>{output+=value;});
  processHandle.on('message',value=>{messages.push(value);});
  const closed=new Promise((resolve,reject)=>{processHandle.once('error',reject);processHandle.once('close',(code,signal)=>resolve({code,signal,output}));});
  void closed.catch(()=>{});
  const event=async name=>{
    const until=Date.now()+5000;
    while(Date.now()<until) {
      const value=messages.find(message=>message.event===name);if(value)return value;
      if(processHandle.exitCode!==null || processHandle.signalCode!==null)throw new Error(`锁进程提前退出：${output}`);
      await delay(20);
    }
    throw new Error(`等待 ${name} 超时：${output}`);
  };
  return {processHandle,closed,event};
}

test('清理票据的主人被终止后，下一进程沿新票据恢复且仍保持互斥', {timeout:15000}, () => isolated(async ({directory,main,env}) => {
  const crashed=child({...env,GFT_LOCK_PAUSE:'yes'});let successor;
  try {
    const held=await crashed.event('cleanup-held');assert.equal(held.pid,crashed.processHandle.pid);
    const originalTicket=`${main}.reap-${digest(staleOwner)}`;
    const originalText=await readFile(originalTicket,'utf8');assert.equal(JSON.parse(originalText).pid,crashed.processHandle.pid);
    assert.equal(await readFile(main,'utf8'),staleOwner,'清理进程尚未删除死主锁');
    // The process is our exact child and its published cleanup ticket matches it.
    crashed.processHandle.kill('SIGKILL');await crashed.closed;
    successor=child(env);
    const active=await successor.event('lease-held');assert.equal(active.owner.pid,successor.processHandle.pid);
    assert.equal(await readFile(originalTicket,'utf8'),originalText);
    const successorTicket=`${main}.reap-${digest(`${digest(staleOwner)}\0${originalText}`)}`;
    assert.equal(JSON.parse(await readFile(successorTicket,'utf8')).pid,successor.processHandle.pid);
    const contender=await execute(process.execPath,['--input-type=module','-e',`const {acquireServiceLease}=await import(process.env.GFT_LOCK_MODULE);try {const release=await acquireServiceLease();await release();process.exitCode=2;}catch(error){console.log(JSON.stringify({status:error.status}));}`],{env,windowsHide:true,timeout:5000});
    assert.equal(JSON.parse(contender.stdout).status,409);
    assert.deepEqual(JSON.parse(await readFile(main,'utf8')),active.owner);
    successor.processHandle.send('release');assert.equal((await successor.closed).code,0);
    assert.equal((await readdir(path.join(directory,'service'))).filter(name=>name.startsWith('instance.lock.reap-')).length,2);
  } finally {
    for(const ownedChild of [crashed,successor].filter(Boolean)) {
      if(ownedChild.processHandle.exitCode===null && ownedChild.processHandle.signalCode===null)ownedChild.processHandle.kill('SIGKILL');
      await ownedChild.closed;
    }
  }
}));
