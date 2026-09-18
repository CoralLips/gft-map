import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as store from '../store.mjs';
import { startServer } from '../server.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const sandbox = await mkdtemp(path.join(tmpdir(), 'gft-local-store-test-'));
const previousHome = process.env.GFT_LOCAL_HOME;
process.env.GFT_LOCAL_HOME = sandbox;

test('首次更新填充原有空主题记录，之后更新和重画保留用户主题', async () => {
  const topic = await store.createTopic('空主题回归','');
  const answer = '<doc>\n## 主题\n只收录社区图书角的试办。\n## 试办\n### ◇ 先取得许可\n书面许可后开展。\n</doc>';
  const task = await store.createTask(topic.id,'update','合成的社区试办材料');
  const generated = await store.completeTask(task.id,answer);
  assert.equal(generated.scope,'只收录社区图书角的试办。');
  const next = await store.createTask(topic.id,'update','继续试办');
  const updated = await store.completeTask(next.id,answer.replace('只收录社区图书角的试办。','模型擅自改的范围').replace('先取得许可','暂缓收费'));
  assert.equal(updated.scope,generated.scope);
  const redraw = await store.createTask(topic.id,'redraw');
  const rebuilt = await store.completeTask(redraw.id,answer.replace('只收录社区图书角的试办。','再次擅自改的范围'));
  assert.equal(rebuilt.scope,generated.scope);
});

after(async () => {
  if (previousHome === undefined) delete process.env.GFT_LOCAL_HOME;
  else process.env.GFT_LOCAL_HOME = previousHome;
  const relative = path.relative(path.resolve(tmpdir()), sandbox);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.ok(path.basename(sandbox).startsWith('gft-local-store-test-'));
  await rm(sandbox, { recursive: true, force: true });
});

const modelOutput = `<doc>
## 本地保存
### ◆ 保留完整判断
保存结论和依据，允许在文档与图中继续编辑。
### ◇ 文件足以验证
先用本地文件验证，尚未决定跨设备实现。
### ？ 如何处理并发
同时编辑时需要保护较新的版本。
### ✗ 放弃整段聊天入库
无关内容不属于这个主题。
### ⏸ 暂缓跨设备同步
当前先验证单机流程。
</doc>
<edge from="保留完整判断" to="文件足以验证"/>
<edge from="文件足以验证" to="如何处理并发"/>`;

async function seeded(name = '合成主题') {
  const topic = await store.createTopic(name, '仅收录本地保存的工程取舍');
  const task = await store.createTask(topic.id, 'update', '离线测试材料，不含用户记录');
  return store.completeTask(task.id, modelOutput);
}

async function cli(args, cwd = root) {
  const result = await execute(process.execPath, [path.join(root, 'cli.mjs'), ...args], {
    cwd,
    env: { ...process.env, GFT_LOCAL_HOME: sandbox },
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

test('创建主题持久化稳定 ID 与范围；空主题可编辑，允许首次生成再确定范围', async () => {
  const draft = await store.createTopic('新脉络');
  assert.equal(draft.scope, '');
  assert.match(draft.doc, /## 主题/);
  const renamed = await store.renameTopic(draft.id, draft.revision, '可稍后改名');
  const edited = await store.saveDoc(draft.id, renamed.revision, '## 主题\n\n## 思考\n### ◇ 手工判断\n还没有确定范围');
  assert.equal(edited.graph.nodes.length, 1);
  const beforeTasks = (await store.listTasks()).length;
  const first = await store.createTask(draft.id, 'update', '社区图书角：先取得许可再试办。');
  assert.equal(first.status,'pending');
  await store.createComputation(draft.id, edited.revision, {action:'update',system:'test',user:'test'});
  assert.equal((await store.listTasks()).length, beforeTasks + 2);
  const ready = await store.saveDoc(draft.id, edited.revision, edited.doc.replace('## 主题', '## 主题\n\n只记录合成测试'));
  assert.equal(ready.scope, '只记录合成测试');
  const queued = await store.createTask(draft.id, 'update', '只记录合成测试');
  assert.equal(queued.status, 'pending');
  await assert.rejects(store.createTopic('不能覆盖', '', undefined, draft.id), {status:409});
  assert.equal((await store.getTopic(draft.id)).name, '可稍后改名');
  const topic = await cli(['create', '--name', '  合成 CLI 主题  ', '--scope', '  仅收录测试判断  ']);
  const persisted = await store.getTopic(topic.id);
  assert.equal(persisted.name, '合成 CLI 主题');
  assert.equal(persisted.scope, '仅收录测试判断');
  assert.equal(persisted.revision, 1);
  assert.ok((await cli(['list'])).some(item => item.id === topic.id));
  assert.equal(store.homeDir(), sandbox);
});

test('真实 CLI 在同一工作目录中以不同 session 隔离绑定，跨目录仍可读回', async () => {
  const first = await seeded('会话甲主题'), second = await seeded('会话乙主题');
  const sessionA = `test-session-a-${randomUUID()}`, sessionB = `test-session-b-${randomUUID()}`;
  await cli(['link', '--session', sessionA, '--project', first.id, '--write', first.id]);
  await cli(['link', '--session', sessionB, '--project', second.id, '--write', second.id]);
  const a = await cli(['read', '--session', sessionA], sandbox);
  const b = await cli(['read', '--session', sessionB], sandbox);
  assert.deepEqual(a.projects.map(topic => topic.id), [first.id]);
  assert.deepEqual(b.projects.map(topic => topic.id), [second.id]);
  assert.equal(a.writeProjectId, first.id);
  assert.equal(b.writeProjectId, second.id);
  await assert.rejects(cli(['read', '--session', sessionA, '--project', second.id]), error => {
    assert.equal(JSON.parse(error.stderr).status, 400);
    return true;
  });
});

test('多主题加载保留独立写回目标，不能指向未链接主题', async () => {
  const first = await seeded('阅读主题甲'), second = await seeded('写回主题乙');
  const outsider = await seeded('未链接主题');
  const session = `test-multi-${randomUUID()}`;
  const binding = await cli(['link', '--session', session, '--project', first.id, '--project', second.id, '--write', second.id]);
  assert.deepEqual(binding.projectIds, [first.id, second.id]);
  const context = await cli(['read', '--session', session]);
  assert.deepEqual(context.projects.map(topic => topic.id), [first.id, second.id]);
  assert.equal(context.writeProjectId, second.id);
  const one = await cli(['read', '--session', session, '--project', first.id]);
  assert.equal(one.writeProjectId, second.id);
  assert.deepEqual(one.projects.map(topic => topic.id), [first.id]);
  await assert.rejects(store.linkSession(session, [first.id, second.id], outsider.id), { status: 400 });
  assert.equal((await store.readContext(session)).writeProjectId, second.id);
});

test('默认上下文完整保留五档判断和承接，但不泄露原始账；history 显式可读', async () => {
  const topic = await seeded('默认上下文');
  const context = await cli(['read', '--project', topic.id]);
  const [project] = context.projects;
  assert.deepEqual(project.graph.nodes.map(node => node.mark), ['◆', '◇', '？', '✗', '⏸']);
  assert.equal(project.graph.edges.length, 2);
  for (const node of topic.graph.nodes) assert.match(project.document, new RegExp(node.title));
  assert.match(project.document, /保存结论和依据/);
  for (const key of ['raw', 'rawLog', 'ledger']) assert.equal(key in project, false);
  assert.doesNotMatch(JSON.stringify(context), /local-agent|离线测试材料/);
  const history = await cli(['history', '--project', topic.id]);
  assert.ok(history.ledger.length > 0);
  assert.match(history.raw, /local-agent/);
  assert.deepEqual(history, await store.history(topic.id));
});

test('两个 HTTP 保存竞争同一 revision 时仅一份成功，另一份收到 409', async t => {
  const topic = await seeded('并发保存');
  const server = await startServer({ port: 0 });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const node = topic.graph.nodes[0];
  const url = `http://127.0.0.1:${server.address().port}/api/topics/${topic.id}/graph`;
  const choices = ['甲窗口的新标题', '乙窗口的新标题'];
  const results = await Promise.all(choices.map(async title => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: topic.revision, op: { kind: 'edit', id: node.id, title } }),
    });
    return { status: response.status, value: await response.json(), title };
  }));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.find(result => result.status === 200);
  const current = await store.getView(topic.id);
  assert.equal(current.revision, topic.revision + 1);
  assert.equal(current.graph.nodes[0].title, winner.title);
  assert.equal(current.graph.nodes.length, topic.graph.nodes.length);
  assert.equal(current.graph.edges.length, topic.graph.edges.length);
  await assert.rejects(store.saveGraph(topic.id, topic.revision, { kind: 'edit', id: node.id, title: '迟到的旧版本' }), { status: 409 });
  assert.deepEqual(await store.getView(topic.id), current);
});

test('CLI 导出再导入生成新 ID，正文、状态、图和逐字历史保真', async () => {
  let topic = await seeded('导出主题');
  topic = await store.saveGraph(topic.id, topic.revision, { kind: 'edit', id: topic.graph.nodes[0].id, title: '人工修正后的判断', mark: '◇' });
  const exportFile = path.join(sandbox, `export-${randomUUID()}.json`);
  const result = await cli(['export', '--project', topic.id, '--file', exportFile]);
  assert.equal(result.saved, exportFile);
  const bundle = JSON.parse(await readFile(exportFile, 'utf8'));
  assert.equal(bundle.version, 2);
  assert.equal(bundle.topic.id, undefined); // New imports get a new identity, never a live source binding.
  const imported = await cli(['import', '--file', exportFile]);
  assert.notEqual(imported.id, topic.id);
  assert.equal(imported.name, topic.name);
  assert.equal(imported.scope, topic.scope);
  assert.equal(imported.doc, topic.doc);
  assert.equal(imported.sourceDoc, topic.sourceDoc);
  assert.deepEqual(imported.graph, topic.graph);
  assert.deepEqual(await store.history(imported.id), await store.history(topic.id));
  assert.deepEqual(await store.getView(topic.id), topic);
});

test('任务准备后发生人工编辑时，complete 拒绝旧版本并保留人工修改', async () => {
  const topic = await seeded('过期任务');
  const task = await store.createTask(topic.id, 'update', '候选新增判断');
  const prompt = await store.taskPrompt(task.id);
  assert.equal(prompt.baseRevision, topic.revision);
  assert.equal(prompt.user, '候选新增判断');
  assert.ok(prompt.system.length > 100);
  const edited = await store.saveDoc(topic.id, topic.revision, topic.doc.replace('保留完整判断', '人工修改优先保留'));
  const expectedHistory = await store.history(topic.id);
  await assert.rejects(store.completeTask(task.id, '<noop/>'), { status: 409 });
  await assert.rejects(store.taskPrompt(task.id), { status: 409 });
  assert.deepEqual(await store.getView(topic.id), edited);
  assert.deepEqual(await store.history(topic.id), expectedHistory);
  assert.equal((await store.getTask(task.id)).status, 'pending');
});

test('技能中的 task/input、task/id、tasks、complete 命令构成真实离线闭环', async () => {
  const topic = await seeded('技能命令闭环');
  const inputFile = path.join(sandbox, `input-${randomUUID()}.txt`);
  const outputFile = path.join(sandbox, `output-${randomUUID()}.txt`);
  await writeFile(inputFile, '本轮没有新的相关判断。', 'utf8');
  await writeFile(outputFile, '<noop/>', 'utf8');
  const update = await cli(['task', '--project', topic.id, '--action', 'update', '--input', inputFile]);
  assert.equal(update.user, '本轮没有新的相关判断。');
  assert.equal((await cli(['task', '--id', update.id])).system, update.system);
  assert.ok((await cli(['tasks'])).some(task => task.id === update.id && task.status === 'pending'));
  const result = await cli(['complete', '--id', update.id, '--file', outputFile]);
  assert.equal(result.revision, topic.revision + 1);
  assert.equal(result.doc, topic.doc);
  assert.deepEqual(result.graph, topic.graph);
  await assert.rejects(store.completeTask(update.id, '<noop/>'), { status: 409 });
  for (const action of ['tidy', 'redraw']) {
    const task = await cli(['task', '--project', topic.id, '--action', action]);
    assert.equal(task.action, action);
    assert.ok(task.system.length > 100);
    assert.ok(task.user.length > 0);
    assert.equal((await cli(['cancel', '--id', task.id])).status, 'cancelled');
  }
});

test('待办只能由一个执行器认领，已完成任务不可重新提交或重新认领', async () => {
  const topic = await seeded('任务认领');
  const task = await store.createTask(topic.id, 'update', '无变更');
  const results = await Promise.allSettled([
    store.setTaskStatus(task.id, 'running'),
    store.setTaskStatus(task.id, 'running'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal((await store.getTask(task.id)).status, 'running');
  await assert.rejects(store.setTaskStatus(task.id, 'running'), { status: 409 });
  await store.completeTask(task.id, '<noop/>');
  await assert.rejects(store.setTaskStatus(task.id, 'running'), { status: 409 });
  await assert.rejects(store.completeTask(task.id, '<noop/>'), { status: 409 });
});
