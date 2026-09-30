import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalClient } from '../mcp.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

async function fixture(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('本地客户端每次读取和写入前检查同一服务，原请求只发送一次', async () => {
  const events = [];
  const f = await fixture(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    events.push({method:req.method, route:req.url, body});
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ok:true}));
  });
  try {
    const client = createLocalClient(f.url, {ensureService:async options => {events.push(options);}});
    await client('/api/topics');
    await client('/api/topics/topic/update-from-chat', {connectionId:'binding'});
    assert.deepEqual(events, [
      {url:f.url}, {method:'GET', route:'/api/topics', body:''},
      {url:f.url}, {method:'POST', route:'/api/topics/topic/update-from-chat', body:'{"connectionId":"binding"}'},
    ]);
  } finally {await f.close();}
});

test('身份检查或恢复失败阻止原请求，不向不匹配的服务写入', async () => {
  let requests = 0;
  const f = await fixture((_req, res) => {requests++;res.end('{}');});
  try {
    const client = createLocalClient(f.url, {ensureService:async () => {throw Object.assign(new Error('数据目录不一致'),{status:409});}});
    await assert.rejects(client('/api/topics', {name:'不应创建'}), {message:'数据目录不一致',status:409});
    assert.equal(requests,0);
  } finally {await f.close();}
});

for (const failure of ['disconnect','http']) test(`模型写请求${failure === 'disconnect' ? '断线' : '返回错误'}后不自动重发`, async () => {
  let requests = 0, checks = 0;
  const f = await fixture(async (req,res) => {
    for await (const _chunk of req) {} // The action may have committed before its response is lost.
    requests++;
    if (failure === 'disconnect') req.socket.destroy();
    else {res.writeHead(503, {'Content-Type':'application/json'});res.end('{"error":"执行器不可用"}');}
  });
  try {
    const client = createLocalClient(f.url, {ensureService:async () => {checks++;}});
    await assert.rejects(client('/api/topics/topic/update-from-chat', {connectionId:'binding'}), failure === 'http' ? {status:503,message:'执行器不可用'} : undefined);
    assert.equal(requests,1);
    assert.equal(checks,1);
  } finally {await f.close();}
});

test('MCP 配置固定原数据目录，离线文件命令不启动网页', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'gft-cli-lifecycle-'));
  const env = {...process.env,GFT_LOCAL_HOME:directory,GFT_LOCAL_URL:'http://127.0.0.1:1'};
  try {
    const run = async args => JSON.parse((await execute(process.execPath,[cli,...args],{env,windowsHide:true,timeout:10000})).stdout);
    const config = await run(['mcp-config']);
    assert.equal(config.mcpServers['gft-local'].env.GFT_LOCAL_HOME,directory);
    assert.equal(config.mcpServers['gft-local'].env.GFT_LOCAL_URL,env.GFT_LOCAL_URL);
    const topic = await run(['create','--name','离线主题']);
    assert.equal((await run(['list']))[0].id,topic.id);
    assert.equal((await run(['version'])).dataDirectory,directory);
  } finally {
    const relative = path.relative(path.resolve(tmpdir()),path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory,{recursive:true,force:true});
  }
});

test('CLI 启动命令结束后可复用、查询、重启和关闭同一份面板', {timeout:40000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'gft-cli-panel-'));
  const available = await fixture((_req,res) => res.end('{}'));
  const url = available.url;
  await available.close();
  const env = {...process.env,GFT_LOCAL_HOME:directory,GFT_LOCAL_URL:url};
  const run = async args => JSON.parse((await execute(process.execPath,[cli,...args],{env,windowsHide:true,timeout:15000})).stdout);
  let stopped = false;
  try {
    const started = await run(['start','--manual']);
    assert.equal(started.state,'running');
    assert.equal(started.reused,false);
    assert.equal(started.runtime.mode,'manual');
    assert.equal(path.resolve(started.runtime.dataDirectory),path.resolve(directory));
    const opened = await run(['open','--no-browser']);
    assert.equal(opened.reused,true);
    assert.equal(opened.runtime.serviceInstanceId,started.runtime.serviceInstanceId);
    assert.equal((await run(['status'])).state,'running');
    const restarted = await run(['restart','--manual']);
    assert.equal(restarted.state,'running');
    assert.notEqual(restarted.runtime.serviceInstanceId,started.runtime.serviceInstanceId);
    assert.equal((await run(['stop'])).state,'stopped');
    stopped = true;
    assert.equal((await run(['status'])).state,'stopped');
  } finally {
    if (!stopped) stopped = (await run(['stop'])).state === 'stopped';
    const relative = path.relative(path.resolve(tmpdir()),path.resolve(directory));
    assert.ok(stopped && relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory,{recursive:true,force:true});
  }
});

test('CLI 拒绝未指定执行器的模型参数，不留下启动记录', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'gft-cli-options-'));
  const env = {...process.env,GFT_LOCAL_HOME:directory,GFT_LOCAL_URL:'http://127.0.0.1:1'};
  try {
    for (const args of [
      ['start','--model','test-model'], ['open','--timeout-seconds','90'],
      ['restart','--acp-bin',process.execPath], ['start','--acp-arg','adapter.mjs'],
    ]) {
      await assert.rejects(execute(process.execPath,[cli,...args],{env,windowsHide:true,timeout:5000}), error => {
        assert.equal(JSON.parse(error.stderr).status,400);
        assert.match(error.stderr,/需要同时指定 --agent/);
        return true;
      });
    }
    await assert.rejects(stat(path.join(directory,'service')), {code:'ENOENT'});
  } finally {
    const relative = path.relative(path.resolve(tmpdir()),path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory,{recursive:true,force:true});
  }
});
