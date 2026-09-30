import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import * as store from '../store.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
async function fixture(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'gft-shutdown-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = home;
  const original = {rename:fs.promises.rename,readdir:fs.promises.readdir};
  try { await run(home,original); }
  finally {
    Object.assign(fs.promises,original); syncBuiltinESMExports();
    if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;
    await rm(home,{recursive:true,force:true});
  }
}

for(const stage of ['claim','save']) test(`服务关闭等待${stage==='claim'?'尚未领取的任务检查':'模型完成后的结果落盘'}结束`, {timeout:10000}, () => fixture(async (home,original) => {
  const entered=deferred(),release=deferred();
  const topic=await store.createTopic('停止时保留','仅用于合成验收');
  const task=await store.createTask(topic.id,'update','保留完成的判断');
  const server=await startServer({port:0,managed:true,agent:'codex',execute:async()=>'<doc>\n## 验收\n### ◇ 已完成\n结果必须写完。\n</doc>\n<prose domain="验收" refs="d1">已完成，结果必须写完。</prose>'});
  let blocked=false,stopping,finished=false;
  const intercept = originalCall => async (...args) => {
    const candidate=String(args[stage==='claim'?0:1]);
    const target=stage==='claim'?path.join(home,'tasks'):path.join(home,'topics',`${topic.id}.json`);
    if(!blocked && candidate===target){blocked=true;entered.resolve();await release.promise;}
    return originalCall(...args);
  };
  if(stage==='claim')fs.promises.readdir=intercept(original.readdir);else fs.promises.rename=intercept(original.rename);
  syncBuiltinESMExports();
  try {
    await Promise.race([entered.promise,delay(5000).then(()=>{throw new Error('任务未进入受控写入');})]);
    stopping=server.shutdown().then(()=>{finished=true;});
    await delay(100);
    assert.equal(finished,false,'服务不能在任务仍读写数据时宣布关闭');
    const state=JSON.parse(await readFile(path.join(home,'service','state.json'),'utf8'));
    assert.equal(state.state,'running','落盘结束前不能记录为已停止');
    release.resolve();await stopping;
    const saved=await store.getTask(task.id);
    assert.equal(saved.status,stage==='claim'?'failed':'completed');
    if(stage==='save')assert.match((await store.getView(topic.id)).doc,/结果必须写完/);
    assert.equal(server.listening,false);
  } finally {
    release.resolve(); await stopping?.catch(()=>{}); await server.shutdown().catch(()=>{});
  }
}));

test('关闭记录写入失败仍关闭端口并释放同数据目录的锁', {timeout:10000}, () => fixture(async (home,original) => {
  const server=await startServer({port:0,managed:true});
  fs.promises.rename=async (from,to)=>{
    if(to===path.join(home,'service','state.json'))throw Object.assign(new Error('模拟磁盘写入失败'),{code:'ENOSPC'});
    return original.rename(from,to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(server.shutdown(),/模拟磁盘写入失败/);
    assert.equal(server.listening,false);
    await assert.rejects(readFile(path.join(home,'service','instance.lock')),{code:'ENOENT'});
  } finally {
    fs.promises.rename=original.rename;syncBuiltinESMExports();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
}));
