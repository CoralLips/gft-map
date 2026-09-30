import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { startServer } from '../server.mjs';
import { acquireServiceLease, ensureService, stopService } from '../serviceLifecycle.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function isolated(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'gft-service-control-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = home;
  try { await run(home); }
  finally { if (previous === undefined) delete process.env.GFT_LOCAL_HOME; else process.env.GFT_LOCAL_HOME = previous; await rm(home, {recursive:true,force:true}); }
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('正在关闭的服务不能被打开入口判定为可复用', () => isolated(async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const server = await startServer({ port: await freePort(), managed:true, accountService:{session:()=>hold,close(){}} });
  const url = `http://127.0.0.1:${server.address().port}`, old = server.runtime().serviceInstanceId;
  const stopping = server.shutdown();
  let finished = false;
  const opening = ensureService({url,manual:true,timeoutMs:10000}).then(result=>{finished=true;return result;});
  try {
    await wait(250);
    assert.equal(finished,false);
    assert.equal((await (await fetch(`${url}/api/runtime`)).json()).serviceState,'stopping');
    release(null); await stopping;
    const opened = await opening;
    assert.notEqual(opened.runtime.serviceInstanceId,old);
    assert.equal(opened.runtime.serviceState,'running');
  } finally { release(null); await stopping; await opening.catch(()=>{}); await stopService({url}); }
}));

test('异常退出与损坏实例锁能够恢复，活进程锁不被抢占', () => isolated(async home => {
  await mkdir(path.join(home,'service'),{recursive:true});
  const instance = path.join(home,'service','instance.lock');
  await writeFile(instance,JSON.stringify({pid:2147483647,token:'dead'}));
  let release = await acquireServiceLease();
  assert.equal(JSON.parse(await readFile(instance,'utf8')).pid,process.pid);
  await assert.rejects(acquireServiceLease(), /已有服务进程/);
  await release();
  await writeFile(instance,'');
  const stale = new Date(Date.now()-60000); await utimes(instance,stale,stale);
  release = await acquireServiceLease(); await release();
  await writeFile(instance,'invalid-json'); await utimes(instance,stale,stale);
  release = await acquireServiceLease(); await release();
}));

test('运行实例不能静默忽略新的执行参数，错误关闭身份不影响它', () => isolated(async () => {
  const server = await startServer({port:0,agent:'codex',execute:async()=>'<noop/>'});
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(ensureService({url,agent:'codex',runnerOptions:{timeoutMs:5000}}), /restart/);
    const response = await fetch(`${url}/api/service/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...server.runtime(),serviceInstanceId:'not-this-instance'})});
    assert.equal(response.status,409);
    assert.equal((await (await fetch(`${url}/api/runtime`)).json()).serviceState,'running');
  } finally { await server.shutdown(); }
}));
