import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import * as store from '../store.mjs';

const fixture=fileURLToPath(new URL('./fixtures/fake-codex.mjs',import.meta.url));
async function waitFor(read,accept) {
  const until=Date.now()+12000;
  while(Date.now()<until){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error('协议回归任务未按时结束');
}

test('异常事件只使当前任务失败，同一服务保留原内容并继续处理合法任务', {timeout:25000}, async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'gft-runner-protocol-'));
  const previous=process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME=directory;
  let server;
  try {
    server=await startServer({port:0,agent:'codex',runnerOptions:{binary:process.execPath,prefixArgs:[fixture,'--fixture-mode=protocol-by-input'],model:'fixture-model',timeoutMs:5000}});
    const origin=`http://127.0.0.1:${server.address().port}`,instance=server.runtime().serviceInstanceId;
    const topic=await store.createTopic('异常协议隔离','仅处理合成材料');
    const before=await store.getTopic(topic.id);
    for(const [mode,label] of [
      ['protocol-item-object','工具 ID 为不能转换成字符串的对象'],
      ['protocol-item-array','工具 ID 为嵌套异常对象的数组'],
      ['protocol-error-object','turn.failed 的错误 message 为对象'],
      ['protocol-message-object','error 的 message 为对象'],
      ['protocol-fragmented','异常 JSON 和 UTF-8 字符被拆成多个输出片段'],
      ['protocol-tail','没有末尾换行的异常事件在进程关闭时读出'],
    ]) await t.test(label,async()=>{
      const queued=await store.createTask(topic.id,'update',`合成协议验收 PROTOCOL_CASE=${mode}`);
      const failed=await waitFor(()=>store.getTask(queued.id),value=>['failed','completed'].includes(value.status) && value.execution);
      assert.equal(failed.status,'failed');
      assert.equal(failed.execution.errorCode,'RUNNER_PROTOCOL');
      assert.match(failed.error,/事件.*字段无效/);
      assert.equal(failed.execution.toolCallCount,0);
      const invocation=JSON.parse(await readFile(path.join(directory,'runs',queued.id,'invocation.json'),'utf8'));
      assert.throws(()=>process.kill(invocation.pid,0),{code:'ESRCH'});
      const response=await fetch(origin+'/api/runtime');assert.equal(response.status,200);
      assert.equal((await response.json()).serviceInstanceId,instance);
      assert.equal((await (await fetch(origin+'/api/topics')).json())[0].id,topic.id);
      assert.deepEqual(await store.getTopic(topic.id),before,'异常执行事件不得写入图文或 Log');
    });
    await t.test('之后的合法碎片事件仍完成任务并保留正常指标',async()=>{
      const queued=await store.createTask(topic.id,'update','合成协议验收 PROTOCOL_CASE=success');
      const done=await waitFor(()=>store.getTask(queued.id),value=>['failed','completed'].includes(value.status) && value.execution);
      assert.equal(done.status,'completed',done.error);
      assert.equal(done.execution.errorCode,undefined);
      assert.equal(done.execution.toolCallCount,1);
      assert.equal(done.execution.toolEvents.length,2);
      assert.equal(done.execution.toolEvents[0].server,'模拟工具');
      assert.deepEqual(done.execution.usage,{input_tokens:120,cached_input_tokens:30,output_tokens:24});
      assert.match((await store.getView(topic.id)).doc,/子进程结果已回填/);
      assert.equal((await (await fetch(origin+'/api/runtime')).json()).serviceInstanceId,instance);
    });
  } finally {
    await server?.shutdown();
    if(previous===undefined)delete process.env.GFT_LOCAL_HOME;else process.env.GFT_LOCAL_HOME=previous;
    const relative=path.relative(path.resolve(tmpdir()),path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory,{recursive:true,force:true});
  }
});
