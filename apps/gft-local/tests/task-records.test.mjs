import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as store from '../store.mjs';

const sandbox = await mkdtemp(path.join(tmpdir(), 'gft-task-records-'));
const previousHome = process.env.GFT_LOCAL_HOME;
process.env.GFT_LOCAL_HOME = sandbox;
after(async () => {
  if (previousHome === undefined) delete process.env.GFT_LOCAL_HOME;
  else process.env.GFT_LOCAL_HOME = previousHome;
  assert.ok(path.basename(sandbox).startsWith('gft-task-records-'));
  await rm(sandbox, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const exists = file =>
  access(file).then(
    () => true,
    () => false,
  );
const taskFile = id => path.join(sandbox, 'tasks', `${id}.json`);
/** Writes a task record as an older version of the service would have left it. */
async function seed(topicId, fields) {
  const id = randomUUID();
  await store.writeJsonAtomic(taskFile(id), {
    id,
    topicId,
    action: 'update',
    input: '整段聊天原文',
    baseRevision: 1,
    createdAt: new Date().toISOString(),
    source: { provider: 'codex', connectionId: 'c1', generation: 1, messages: [{ id: 'm1' }] },
    ...fields,
  });
  return id;
}

test('取消的任务不再保留聊天原文与输入', async () => {
  const topic = await store.createTopic('取消瘦身', '合成材料');
  const task = await store.createTask(topic.id, 'update', '只供本次处理的材料');
  await store.setTaskStatus(task.id, 'cancelled');
  const saved = await store.getTask(task.id);
  assert.equal(saved.status, 'cancelled');
  assert.equal('input' in saved, false);
});

test('启动整理：过期记录连同日志删除，近期记录去掉原文，运行中与待汇总的分批不动', async () => {
  const topic = await store.createTopic('任务整理', '合成材料');
  const now = Date.now();
  const old = new Date(now - 40 * DAY).toISOString();
  const recent = new Date(now - 2 * DAY).toISOString();
  const expired = await seed(topic.id, { status: 'completed', completedAt: old });
  await mkdir(path.join(sandbox, 'runs', expired), { recursive: true });
  await writeFile(path.join(sandbox, 'runs', expired, 'invocation.json'), '{}');
  const finished = await seed(topic.id, {
    status: 'cancelled',
    finishedAt: recent,
    output: '模型输出',
  });
  const running = await seed(topic.id, { status: 'running' });
  const pinnedChunk = await seed(topic.id, {
    action: 'compact',
    status: 'completed',
    completedAt: old,
  });
  const publishedChunk = await seed(topic.id, {
    action: 'compact',
    status: 'completed',
    completedAt: recent,
  });
  // The import that still needs `pinnedChunk` has not been published yet.
  const current = await store.getTopic(topic.id);
  await store.writeJsonAtomic(path.join(sandbox, 'topics', `${topic.id}.json`), {
    ...current,
    sourceImports: { 'c1:1': { taskIds: [pinnedChunk], hasMore: false } },
  });

  const result = await store.tidyTaskRecords(now);
  assert.deepEqual(result, { removed: 1, slimmed: 2 });
  assert.equal(await exists(taskFile(expired)), false);
  assert.equal(await exists(path.join(sandbox, 'runs', expired)), false);
  const slim = await store.getTask(finished);
  assert.equal('input' in slim || 'output' in slim, false);
  assert.equal(slim.source.messages, undefined);
  assert.equal(slim.source.connectionId, 'c1');
  assert.equal((await store.getTask(running)).input, '整段聊天原文');
  assert.deepEqual((await store.getTask(pinnedChunk)).source.messages, [{ id: 'm1' }]);
  assert.equal((await store.getTask(publishedChunk)).source.messages, undefined);

  assert.deepEqual(await store.tidyTaskRecords(now), { removed: 0, slimmed: 0 }, '再次整理不改动');
});
