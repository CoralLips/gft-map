import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import * as store from '../store.mjs';
import { startServer } from '../server.mjs';

const output = '<doc>\n## 本地恢复\n### ◆ 只应用一次\n中断恢复不能重复追加已经保存的判断。\n</doc>';

async function isolated(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gft-local-recovery-'));
  const previousHome = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = dir;
  try { await run(dir); }
  finally {
    if (previousHome === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previousHome;
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(dir).startsWith('gft-local-recovery-'));
    await rm(dir, { recursive: true, force: true });
  }
}

const recordPath = (dir, kind, id) => path.join(dir, kind, `${id}.json`);
// Only fixture JSON is rewritten: this reproduces interruption after topic save
// but before the task's completed status reaches disk.
const restoreTaskFixture = (dir, task) => writeFile(recordPath(dir, 'tasks', task.id), JSON.stringify(task), 'utf8');

async function savedTask() {
  const topic = await store.createTopic('中断恢复合成案例', '只讨论中断恢复和保存一致性');
  const task = await store.createTask(topic.id, 'update', '确认相同任务只应用一次');
  const view = await store.completeTask(task.id, output);
  return { topic, task, view };
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.ok(Number.isInteger(child.pid));
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return child.pid;
}

test('starting the panel recovers dead-owner tasks and locks without requiring a CLI repair',()=>isolated(async dir=>{
  const topic=await store.createTopic('重启恢复','服务重启后可以继续编辑');
  const task=await store.createTask(topic.id,'update','中断前的材料');
  const pid=await exitedPid();
  await restoreTaskFixture(dir,{...task,status:'running',runnerPid:pid});
  await writeFile(`${recordPath(dir,'topics',topic.id)}.lock`,String(pid));
  const server=await startServer({port:0});
  try {
    assert.equal((await store.getTask(task.id)).status,'failed');
    await store.saveGraph(topic.id,topic.revision,{kind:'add',title:'重启后仍能编辑'});
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/runtime`);assert.equal(response.status,200);
  }finally{await server.shutdown();}
}));

test('主题已保存而任务仍 pending：重试只补 completed，不重复追加或推进版本', () => isolated(async dir => {
  const { topic, task, view } = await savedTask();
  const before = await store.getTopic(topic.id);
  assert.equal(before.appliedTasks[task.id], view.revision);
  await restoreTaskFixture(dir, task);

  const retried = await store.completeTask(task.id, output);
  assert.deepEqual(await store.getTopic(topic.id), before);
  assert.equal(retried.revision, view.revision);
  assert.equal(retried.graph.nodes.length, 1);
  const done = await store.getTask(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.resultRevision, view.revision);
  assert.equal(done.input, '');
}));

test('中断之后已有手工修正：重试旧任务保留修正，记录最初应用版本', () => isolated(async dir => {
  const { topic, task, view } = await savedTask();
  await restoreTaskFixture(dir, task);
  const edited = await store.saveGraph(topic.id, view.revision, {
    kind: 'edit', id: view.graph.nodes[0].id, title: '用户后来修正的判断', content: '这一人工修正必须继续保留。', mark: '◇',
  });
  const beforeRetry = await store.getTopic(topic.id);

  const retried = await store.completeTask(task.id, '<doc>\n## 本地恢复\n### ◆ 不应再应用这份结果\n</doc>');
  assert.deepEqual(await store.getTopic(topic.id), beforeRetry);
  assert.equal(retried.revision, edited.revision);
  assert.equal(retried.graph.nodes[0].title, '用户后来修正的判断');
  assert.equal(retried.graph.nodes[0].mark, '◇');
  assert.equal((await store.getTask(task.id)).resultRevision, view.revision);
}));

test('recover 根据主题中的应用记录补全任务，不重放模型结果', () => isolated(async dir => {
  const { topic, task, view } = await savedTask();
  await restoreTaskFixture(dir, task);
  const before = await store.getTopic(topic.id);

  const recovery = await store.recover();
  assert.ok(recovery.recovered.includes(task.id));
  assert.deepEqual(await store.getTopic(topic.id), before);
  const done = await store.getTask(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.resultRevision, view.revision);
  assert.equal(done.input, '');
}));

test('recover 回收确定已退出进程的锁并结束遗留 running 任务，恢复后可继续保存', () => isolated(async dir => {
  const pid = await exitedPid();
  const topic = await store.createTopic('退出进程恢复', '只验证退出进程留下的状态');
  const task = await store.createTask(topic.id, 'update', '测试进程退出');
  await restoreTaskFixture(dir, { ...task, status: 'running', runnerPid: pid });
  const topicLock = `${recordPath(dir, 'topics', topic.id)}.lock`;
  const taskLock = `${recordPath(dir, 'tasks', task.id)}.lock`;
  await writeFile(topicLock, String(pid), 'utf8');
  await writeFile(taskLock, String(pid), 'utf8');

  const recovery = await store.recover();
  await assert.rejects(access(topicLock), { code: 'ENOENT' });
  await assert.rejects(access(taskLock), { code: 'ENOENT' });
  assert.ok(recovery.recovered.includes(task.id));
  assert.equal((await store.getTask(task.id)).status, 'failed');
  assert.match((await store.getTask(task.id)).error, /进程已退出/);
  assert.equal((await store.getView(topic.id)).revision, topic.revision);

  const saved = await store.saveGraph(topic.id, topic.revision, { kind: 'add', title: '恢复后继续保存' });
  assert.equal(saved.graph.nodes[0].title, '恢复后继续保存');
}));

test('recover 不删除活进程持有的锁，也不接管该进程的 running 任务', () => isolated(async dir => {
  const topic = await store.createTopic('活进程保护', '只验证活进程仍持有的数据');
  const task = await store.createTask(topic.id, 'update', '活进程仍在处理');
  await store.setTaskStatus(task.id, 'running');
  const topicLock = `${recordPath(dir, 'topics', topic.id)}.lock`;
  await writeFile(topicLock, String(process.pid), 'utf8');

  const recovery = await store.recover();
  assert.deepEqual(recovery.recovered, []);
  assert.equal(await readFile(topicLock, 'utf8'), String(process.pid));
  assert.equal((await store.getTask(task.id)).status, 'running');
  await assert.rejects(store.saveGraph(topic.id, topic.revision, { kind: 'add', title: '不能越过活锁' }), { status: 409 });
  await unlink(topicLock);
}));

test('正常 shutdown 等待任务标记失败，执行器迟到结果不能写入主题', () => isolated(async () => {
  const topic = await store.createTopic('服务关闭案例', '只讨论正常退出时的数据一致性');
  const task = await store.createTask(topic.id, 'update', '这一迟到输出应被丢弃');
  const before = await store.getTopic(topic.id);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const server = await startServer({ port: 0, agent: 'codex', execute: async () => { signalStarted(); await held; return output; } });
  let timeout;
  try {
    await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('执行器未及时开始')), 5000); })]);
    clearTimeout(timeout);
    assert.equal((await store.getTask(task.id)).status, 'running');
    await server.shutdown();
    assert.equal(server.listening, false);
    assert.equal((await store.getTask(task.id)).status, 'failed');
    assert.match((await store.getTask(task.id)).error, /服务已停止/);
    release();
    await nextTurn();
    assert.deepEqual(await store.getTopic(topic.id), before);
    assert.equal((await store.getTask(task.id)).status, 'failed');
    await assert.rejects(store.completeTask(task.id, output), { status: 409 });
  } finally {
    clearTimeout(timeout);
    if (server.listening) await server.shutdown();
    release();
    await nextTurn();
  }
}));
