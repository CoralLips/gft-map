import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getEventListeners } from 'node:events';
import { startServer } from '../server.mjs';
import * as backend from '../store.mjs';
import * as materials from '../materials.mjs';
import { appendSourceLog, editSourceLog, renderSourceLog } from '../dist/core.mjs';

const entry = fileURLToPath(new URL('../web/localRuntime.ts', import.meta.url));
const nodePath = fileURLToPath(new URL('../node_modules', import.meta.url));
const cacheRoot = path.join(nodePath, '.cache');
const coaseCase = JSON.parse(
  await readFile(new URL('./fixtures/coase-expression-case.json', import.meta.url), 'utf8'),
);
const baseLedger =
  '[场次 2026-09-06T10:00:00Z · 合成回放]\n走向 p3 [主题]\n只处理合成验证材料。\n◆ j1 [验证] 原判断\n先保留原文。\n⏸ j2 [验证] 暂缓扩展\n最小闭环验证后再决定。\n← j2 j1';
const output =
  '<revise id="n1" title="整理后的合成判断"/>\n<prose domain="验证" refs="n1,n2">先保留原文，完成最小闭环验证后再决定是否扩展。</prose>';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

test('reopening restores undo for a task completed while the page was closed, followed by saved manual edits', async () => {
  const entered = deferred(),
    release = deferred();
  await fixture(
    async () => {
      entered.resolve();
      await release.promise;
      return '<node title="后台整理结果" body="后台说明"/>';
    },
    async ({ local, a, createLocalRuntime }) => {
      const task = local.store.getState().refineNode('j1');
      await entered.promise;
      local.dispose();
      release.resolve();
      await task;
      await waitFor(
        () => backend.listTasks(),
        tasks => tasks[0]?.status === 'completed',
      );
      let page = createLocalRuntime({
        onRequestUpdate: async () => null,
        onError: message => {
          throw Error(message);
        },
      });
      try {
        await page.start();
        assert.equal(page.store.getState().nodes.find(n => n.id === 'j1').title, '后台整理结果');
        page.store.getState().updateNode('j2', { title: '刷新后的手工改字' });
        page.store.getState().flushDoc();
        await waitFor(
          () => backend.getView(a.id),
          view => view.graph.nodes.find(n => n.id === 'j2').title === '刷新后的手工改字',
        );
        page.dispose();
        page = createLocalRuntime({
          onRequestUpdate: async () => null,
          onError: message => {
            throw Error(message);
          },
        });
        await page.start();
        page.store.getState().undo();
        assert.equal(page.store.getState().nodes.find(n => n.id === 'j2').title, '暂缓扩展？');
        page.store.getState().undo();
        assert.equal(page.store.getState().nodes.find(n => n.id === 'j1').title, '原判断');
        await waitFor(
          () => backend.getView(a.id),
          view => view.graph.nodes.find(n => n.id === 'j1').title === '原判断',
        );
        assert.equal(page.store.getState().error, null);
        page.dispose();
        page = createLocalRuntime({
          onRequestUpdate: async () => null,
          onError: message => {
            throw Error(message);
          },
        });
        await page.start();
        page.store.getState().undo();
        assert.equal(
          page.store.getState().nodes.find(n => n.id === 'j1').title,
          '原判断',
          'refresh must not revive already undone changes',
        );
      } finally {
        release.resolve();
        page.dispose();
      }
    },
  );
});

test('healthy checks do not repeatedly scan task history', async () => {
  await fixture(
    async () => '<noop/>',
    async ({ local, origin, fetch }) => {
      let scans = 0;
      globalThis.fetch = (url, options) => {
        if (String(url) === '/api/tasks') scans++;
        return fetch(new URL(String(url), origin), options);
      };
      await local.service.retry();
      await local.service.retry();
      assert.equal(scans, 0);
    },
  );
});

test('超长手动粘贴保留完整原文并进入可暂停的材料流程', async () => {
  const text = '长材料内容。'.repeat(40000);
  const oldWindow = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    await fixture(
      async () => '<noop/>',
      async ({ local, a, origin, fetch }) => {
        const uploads = [];
        globalThis.fetch = async (url, options) => {
          if (String(url).includes('/upload?')) uploads.push(options.body.size);
          const response = await fetch(new URL(String(url), origin), options);
          if (String(url).endsWith('/finish')) {
            const job = await response.clone().json();
            await fetch(origin + `/api/materials/${job.id}/pause`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            });
          }
          return response;
        };
        await local.requestManualUpdate();
        const jobs = await materials.list(a.id);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].state, 'paused');
        assert.equal(await readFile(materials.sourceFile(jobs[0].id), 'utf8'), text);
        assert.ok(uploads.length > 1);
        assert.ok(uploads.every(size => size <= 512 * 1024));
        assert.equal((await backend.listTasks()).length, 0);
      },
      { manual: async () => text },
    );
  } finally {
    globalThis.window = oldWindow;
  }
});
async function waitFor(read, accept, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (accept(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待本地面板回归状态超时：${JSON.stringify(last)}`);
}
async function fixture(execute, run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-panel-runtime-'));
  await mkdir(cacheRoot, { recursive: true });
  const bundleDirectory = await mkdtemp(path.join(cacheRoot, 'gft-panel-runtime-'));
  const previousHome = process.env.GFT_LOCAL_HOME,
    previousFetch = globalThis.fetch,
    previousStorage = globalThis.localStorage;
  process.env.GFT_LOCAL_HOME = directory;
  let server, local;
  try {
    const outfile = path.join(bundleDirectory, 'panel-runtime.mjs');
    // Resolve dependencies from the app's own install when root node_modules is absent.
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      nodePaths: [nodePath],
      logLevel: 'silent',
    });
    const { createLocalRuntime } = await import(pathToFileURL(outfile).href);
    server = await startServer({ port: 0, agent: 'codex', execute });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browserCache = new Map();
    globalThis.localStorage = {
      getItem: key => browserCache.get(key) ?? null,
      setItem: (key, value) => browserCache.set(key, value),
      removeItem: key => browserCache.delete(key),
    };
    globalThis.fetch = (url, options) => previousFetch(new URL(String(url), origin), options);
    const a = await backend.createTopic(
      options.coase ? coaseCase.name : '面板回放A',
      options.coase ? coaseCase.scope : '只处理合成验证材料。',
      options.coase ? coaseCase : { ledger: baseLedger, raw: baseLedger },
    );
    const b = await backend.createTopic('面板回放B', '只处理合成验证材料。', {
      ledger: baseLedger.replace('原判断', '另一主题判断'),
      raw: baseLedger,
    });
    browserCache.set('gft-local:selected', a.id);
    const errors = [];
    local = createLocalRuntime({
      onRequestUpdate: options.manual || (async () => null),
      onError: message => errors.push(message),
    });
    await local.start();
    await run({
      createLocalRuntime,
      local,
      server,
      a,
      b,
      browserCache,
      errors,
      origin,
      directory,
      fetch: previousFetch,
    });
  } finally {
    await local?.dispose();
    if (server) await server.shutdown();
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousHome === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previousHome;
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    assert.ok(
      relative &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative) &&
        path.basename(directory).startsWith('gft-panel-runtime-'),
    );
    await rm(directory, { recursive: true, force: true });
    const bundleRelative = path.relative(path.resolve(cacheRoot), path.resolve(bundleDirectory));
    assert.ok(
      bundleRelative &&
        !bundleRelative.startsWith('..') &&
        !path.isAbsolute(bundleRelative) &&
        path.basename(bundleDirectory).startsWith('gft-panel-runtime-'),
    );
    await rm(bundleDirectory, { recursive: true, force: true });
  }
}

test(
  '反复打开关闭释放页面监听器，固定数据的堆内存不持续累积',
  { skip: !globalThis.gc },
  async t => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = new EventTarget();
    globalThis.document = new EventTarget();
    globalThis.document.documentElement = {};
    try {
      await fixture(
        async () => '<noop/>',
        async ({ local, createLocalRuntime }) => {
          local.dispose();
          const samples = [];
          for (let group = 0; group < 4; group++) {
            for (let i = 0; i < 25; i++) {
              const panel = createLocalRuntime({
                onRequestUpdate: async () => null,
                onError: () => {},
              });
              await panel.start();
              panel.dispose();
              assert.equal(getEventListeners(window, 'focus').length, 0);
              assert.equal(getEventListeners(window, 'online').length, 0);
              assert.equal(getEventListeners(document, 'visibilitychange').length, 0);
            }
            await new Promise(resolve => setTimeout(resolve, 50));
            globalThis.gc();
            samples.push(process.memoryUsage().heapUsed);
          }
          t.diagnostic(
            JSON.stringify({
              cycles: 100,
              heapMiB: samples.map(n => +(n / 1048576).toFixed(2)),
              remainingListeners: 0,
            }),
          );
          // Warm-up is excluded. A generous ceiling avoids treating V8 bookkeeping as a leak.
          assert.ok(samples[3] - samples[1] < 8 * 1048576, '固定数据重开面板后的堆增长超过 8 MiB');
        },
      );
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  },
);

test('导入文稿直接打开Doc；保存后的列表刷新失败不当成导入失败', async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      return output;
    },
    async ({ local, origin, fetch, errors }) => {
      globalThis.fetch = (url, options) =>
        String(url) === '/api/topics'
          ? Promise.resolve(
              new Response(JSON.stringify({ error: '列表暂时不可用' }), { status: 503 }),
            )
          : fetch(new URL(String(url), origin), options);
      const id = await local.importTopic({
        format: 'gft-document',
        version: 1,
        name: '导入验收',
        text: '## 主线\n\n这是直接粘贴的材料。',
      });
      assert.equal(local.host.getSnapshot().currentProjectId, id);
      assert.equal(local.store.getState().rightView, 'doc');
      assert.match(local.store.getState().doc, /直接粘贴的材料/);
      assert.ok(local.host.getSnapshot().projects.some(project => project.id === id));
      assert.equal((await backend.listTopics()).length, 3);
      assert.ok(errors.some(message => message.includes('已导入')));
      assert.equal(calls, 0);
    },
  );
});

test('新建直接展示空脉络，创建响应在途不重复创建；取消材料输入不调用模型、也不强制切到Doc', async () => {
  const held = deferred(),
    release = deferred();
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      return output;
    },
    async ({ local, origin, fetch }) => {
      globalThis.fetch = async (url, options) => {
        if (String(url) === '/api/topics' && options?.method === 'POST') {
          held.resolve();
          await release.promise;
        }
        return fetch(new URL(String(url), origin), options);
      };
      const pending = local.host.createProject('新脉络');
      const id = local.host.getSnapshot().currentProjectId;
      try {
        assert.ok(id);
        assert.equal(local.store.getState().boundProjectId, id);
        assert.equal(local.store.getState().nodes.length, 0, '首帧不能显示旧图');
        assert.equal(local.host.getSnapshot().projects[0].name, '新脉络');
        assert.equal(local.host.createProject('新脉络'), pending);
        await held.promise;
        release.resolve();
        assert.equal(await pending, id);
        assert.equal((await backend.getTopic(id)).scope, '');
        await local.host.requestUpdate();
        assert.equal(local.store.getState().rightView, 'map');
        assert.match(local.store.getState().doc, /## 主题/);
        assert.equal(calls, 0);
        assert.deepEqual(await backend.listTasks(), []);
        local.store.getState().setDocDraft('## 主题\n\n只记录社区图书角的试运营。');
        local.store.getState().flushDocEdits();
        local.store.getState().flushDoc();
        await waitFor(
          () => backend.getView(id),
          topic => topic.scope === '只记录社区图书角的试运营。',
        );
      } finally {
        release.resolve();
        await pending;
      }
    },
  );
});

test('新建失败恢复原主题；新建成功后列表刷新失败不撤销已经保存的脉络', async () => {
  await fixture(
    async () => output,
    async ({ local, a, origin, fetch, errors }) => {
      globalThis.fetch = (url, options) =>
        String(url) === '/api/topics' && options?.method === 'POST'
          ? Promise.resolve(
              new Response(JSON.stringify({ error: '合成创建失败' }), { status: 500 }),
            )
          : fetch(new URL(String(url), origin), options);
      assert.equal(await local.host.createProject('失败的脉络'), null);
      assert.equal(local.host.getSnapshot().currentProjectId, a.id);
      assert.equal(local.store.getState().nodes[0].title, '原判断');
      assert.equal(local.host.getSnapshot().projects.length, 2);
      assert.ok(errors.includes('合成创建失败'));
      globalThis.fetch = (url, options) =>
        String(url) === '/api/topics' && options?.method === 'GET'
          ? Promise.resolve(
              new Response(JSON.stringify({ error: '合成列表刷新失败' }), { status: 500 }),
            )
          : fetch(new URL(String(url), origin), options);
      const id = await local.host.createProject('已保存的脉络');
      assert.ok(id);
      assert.equal((await backend.getTopic(id)).name, '已保存的脉络');
      assert.equal(local.host.getSnapshot().currentProjectId, id);
    },
  );
});

test('空主题首次手工更新直接生成主题和图文，保留来源，不多跑推荐', async () => {
  let calls = 0;
  const answer =
    '<doc>\n## 主题\n社区图书角的试运营。\n## 主线\n先确认许可再试办。\n## 试办\n### ◆ 先取得场地许可\n取得书面许可后才能开展。\n</doc>\n<prose domain="试办" refs="d1">先取得场地许可，收到书面许可后再开展社区图书角试办。</prose>';
  await fixture(
    async prompt => {
      calls++;
      assert.equal(prompt.action, 'update');
      return answer;
    },
    async ({ local, errors }) => {
      const id = await local.host.createProject('新脉络');
      await local.requestManualUpdate();
      assert.equal(
        local.store.getState().nodes.length,
        1,
        JSON.stringify({
          errors,
          error: local.store.getState().error,
          doc: local.store.getState().doc,
        }),
      );
      local.store.getState().flushDoc();
      await waitFor(
        () => backend.getView(id),
        view => view.graph.nodes.length === 1,
      );
      const saved = await backend.getView(id);
      assert.equal(saved.scope, '社区图书角的试运营。');
      const sources = await backend.sourceEvents(id);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].inputs[0].content, '社区图书角：先取得书面许可才能试办。');
      assert.equal(sources[0].outputs.length, 1);
      assert.match(saved.doc, /书面许可/);
      assert.equal(calls, 1);
      assert.deepEqual(errors, []);
    },
    { manual: async () => '社区图书角：先取得书面许可才能试办。' },
  );
});

test('改主题后重画读取被旧范围过滤的源消息，不扫描其他主题；可撤销且来源保留', async () => {
  let calls = 0;
  await fixture(
    async prompt => {
      calls++;
      assert.match(prompt.system, /图书角的志愿者安排/);
      assert.match(prompt.user, /之前未入图：至少两名志愿者/);
      assert.doesNotMatch(prompt.user, /另一主题私有材料/);
      return '<doc>\n## 主线\n人员不足时暂停试办。\n## 人员\n### ◆ 至少两名志愿者\n不足两名就暂停。\n</doc>\n<prose domain="人员" refs="d1">试办至少需要两名志愿者，不足两名就暂停。</prose>';
    },
    async ({ local, a, b, errors }) => {
      await backend.saveSourceEvent(a.id, {
        id: 'source',
        layer: 'L0->L1',
        sourceMeta: { sessionId: 'source-a' },
        inputs: [
          { id: 'excluded', role: 'user', content: '之前未入图：至少两名志愿者，不足就暂停。' },
        ],
        outputs: [],
      });
      await backend.saveSourceEvent(b.id, {
        id: 'other',
        layer: 'L0->L1',
        inputs: [{ id: 'private', role: 'user', content: '另一主题私有材料' }],
        outputs: [],
      });
      const old = local.store.getState().nodes.map(node => node.title);
      local.store
        .getState()
        .setDocDraft(
          local.store.getState().doc.replace('只处理合成验证材料。', '图书角的志愿者安排。'),
        );
      await local.store.getState().redrawFromLedger();
      assert.equal(local.store.getState().nodes.length, 1);
      assert.equal(local.store.getState().nodes[0].title, '至少两名志愿者');
      assert.equal(
        (await backend.sourceEvents(a.id)).some(event =>
          event.inputs?.some?.(input => input.id === 'excluded'),
        ),
        true,
      );
      local.store.getState().undo();
      assert.deepEqual(
        local.store.getState().nodes.map(node => node.title),
        old,
      );
      assert.equal(calls, 1);
      assert.deepEqual(errors, []);
    },
  );
});

test('整篇编辑 Log 通过真实面板保存：图文和水位保留，旧快照不复活，重画只读取修订版及当前主题', async () => {
  let calls = 0;
  const text = '第二段移到前面：试办需要三名志愿者。\n\n删掉旧规则后，只在三人到齐时开展。\n';
  await fixture(
    async prompt => {
      calls++;
      assert.equal(prompt.action, 'redraw');
      assert.match(prompt.system, /社区图书角的当前人员规则/);
      assert.match(prompt.user, /三名志愿者/);
      assert.match(prompt.user, /第二段移到前面/);
      assert.doesNotMatch(prompt.user, /旧规则只需一名|后来补存的过期快照/);
      return '<doc>\n## 主线\n按人工修订后的人员规则试办。\n## 人员\n### ◆ 三名志愿者到齐才试办\n不足三人时暂停。\n</doc>\n<prose domain="人员" refs="d1">按人工修订后的规则，三名志愿者到齐才试办，不足三人时暂停。</prose>';
    },
    async ({ local, a, b, errors, directory, browserCache }) => {
      await backend.saveSourceEvent(a.id, {
        id: 'old-original',
        layer: 'L0->L1',
        inputs: [
          { id: 'old-message', role: 'user', name: null, content: '旧规则只需一名志愿者。', ts: 1 },
        ],
        outputs: ['j1'],
        sourceMeta: { provider: 'codex', sessionId: 'old-chat', sessionTitle: '合成会话' },
      });
      const view = await backend.getView(a.id);
      await backend.saveDoc(
        a.id,
        view.revision,
        view.doc.replace('只处理合成验证材料。', '社区图书角的当前人员规则。'),
      );
      const filename = path.join(directory, 'topics', `${a.id}.json`);
      const sourceCursors = {
        'connection:1': { cursor: { offset: 42 }, taskId: 'completed-before-edit' },
      };
      const persisted = JSON.parse(await readFile(filename, 'utf8'));
      await writeFile(filename, JSON.stringify({ ...persisted, sourceCursors }));
      await local.store.getState().syncFromRemote();
      assert.match(renderSourceLog(local.store.getState().raw), /旧规则只需一名/);
      const before = local.store.getState();
      const doc = before.doc,
        nodes = structuredClone(before.nodes),
        edges = structuredClone(before.edges);
      const watermarks = [...before.sourceWatermarks];
      local.store.getState().updateRaw(editSourceLog(before.raw, text));
      assert.equal(local.store.getState().doc, doc);
      assert.deepEqual(local.store.getState().nodes, nodes);
      assert.deepEqual(local.store.getState().edges, edges);
      assert.equal(calls, 0, '保存 Log 本身不得触发模型');
      local.store.getState().flushDoc();
      await waitFor(
        () => backend.getTopic(a.id),
        topic => renderSourceLog(topic.raw) === text,
      );
      await waitFor(
        () => JSON.parse(browserCache.get(`gft-local:panel:${a.id}`)),
        entry => entry.pending === false,
      );
      assert.deepEqual((await backend.getTopic(a.id)).sourceCursors, sourceCursors);
      assert.deepEqual([...local.store.getState().sourceWatermarks], watermarks);
      await backend.saveSourceEvent(a.id, {
        id: 'late-old',
        layer: 'L0->L1',
        inputs: [{ id: 'late-message', role: 'user', content: '后来补存的过期快照' }],
        outputs: ['j1'],
      });
      await local.store.getState().syncFromRemote();
      assert.equal(renderSourceLog(local.store.getState().raw), text);
      assert.equal((await backend.readSources(a.id)).text, text);
      await local.host.switchProject(b.id);
      await local.host.switchProject(a.id);
      assert.equal(
        renderSourceLog(local.store.getState().raw),
        text,
        '切换离开后重载仍使用全文编辑版',
      );
      assert.equal(local.store.getState().doc, doc);
      await local.store.getState().redrawFromLedger();
      assert.equal(calls, 1);
      assert.equal(local.store.getState().error, null);
      assert.equal(local.store.getState().nodes.length, 1);
      assert.equal(local.store.getState().nodes[0].title, '三名志愿者到齐才试办');
      local.store.getState().flushDoc();
      await waitFor(
        () => backend.getView(a.id),
        saved =>
          saved.graph.nodes.length === 1 && saved.graph.nodes[0].title === '三名志愿者到齐才试办',
      );
      assert.equal(renderSourceLog((await backend.getTopic(a.id)).raw), text);
      assert.deepEqual((await backend.getTopic(a.id)).sourceCursors, sourceCursors);
      assert.deepEqual([...local.store.getState().sourceWatermarks], watermarks);
      assert.deepEqual(errors, []);
    },
  );
});

test('面板清空 Log 后同步与重载保留显式空来源，重画不回填工作账也不调用模型', async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      return output;
    },
    async ({ local, a, b, browserCache, errors }) => {
      const before = local.store.getState();
      const doc = before.doc,
        nodes = structuredClone(before.nodes);
      local.store.getState().updateRaw(editSourceLog(before.raw, ''));
      local.store.getState().flushDoc();
      await waitFor(
        () => backend.history(a.id),
        history => history.sourceText === '',
      );
      await waitFor(
        () => JSON.parse(browserCache.get(`gft-local:panel:${a.id}`)),
        entry => entry.pending === false,
      );
      await local.store.getState().syncFromRemote();
      await local.host.switchProject(b.id);
      await local.host.switchProject(a.id);
      assert.equal(renderSourceLog(local.store.getState().raw), '');
      assert.equal(local.store.getState().doc, doc);
      assert.deepEqual(local.store.getState().nodes, nodes);
      await local.store.getState().redrawFromLedger();
      assert.equal(calls, 0);
      assert.equal((await backend.readSources(a.id)).text, '');
      assert.deepEqual(await backend.sourceEvents(a.id), []);
      assert.deepEqual(errors, []);
    },
  );
});

test('最后一次轮询后后台追加来源：Log 保存遇到409仅合入新来源，保存成功并清除pending', async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      return output;
    },
    async ({ local, a, errors, browserCache }) => {
      const baseRaw = local.store.getState().raw;
      const doc = local.store.getState().doc;
      const topic = await backend.getTopic(a.id),
        view = await backend.getView(a.id);
      const newRecord = {
        v: 1,
        provider: 'codex',
        sessionId: 'independent',
        id: 'fresh-receipt',
        role: 'user',
        content: '后台在编辑期间新增的有效来源',
      };
      const remote = await backend.saveState(a.id, topic.revision, {
        ledger: topic.ledger,
        raw: appendSourceLog(topic.raw, [newRecord]),
        nodes: view.graph.nodes,
        edges: view.graph.edges,
        doc: view.doc,
        watermarks: {},
      });
      assert.equal(remote.revision, topic.revision + 1);
      assert.equal(local.store.getState().raw, baseRaw, '尚未轮询到后台新增来源');
      local.store.getState().updateRaw(editSourceLog(baseRaw, '用户整篇修改后的来源\n'));
      local.store.getState().flushDoc();
      const saved = await waitFor(
        () => backend.getTopic(a.id),
        topic => topic.revision > remote.revision,
      );
      await waitFor(
        () => JSON.parse(browserCache.get(`gft-local:panel:${a.id}`)),
        entry => entry.pending === false,
      );
      const text = renderSourceLog(saved.raw);
      assert.match(text, /用户整篇修改后的来源/);
      assert.match(text, /后台在编辑期间新增的有效来源/);
      assert.doesNotMatch(text, /原判断|先保留原文/);
      assert.equal((await backend.getView(a.id)).doc, doc);
      assert.equal(local.store.getState().doc, doc);
      assert.equal(local.store.getState().error, null);
      await local.store.getState().syncFromRemote();
      assert.equal(renderSourceLog(local.store.getState().raw), text);
      assert.equal(calls, 0);
      assert.deepEqual(errors, []);
    },
  );
});

test('源消息存在但 Log 没有节点仍可重画；长来源先提炼，中途不展示半成品', async () => {
  let calls = 0,
    localRef;
  await fixture(
    async prompt => {
      calls++;
      assert.equal(localRef.store.getState().nodes.length, 0);
      if (prompt.system.includes('"summary"'))
        return JSON.stringify({ summary: '社区图书角至少两名志愿者，不足就暂停。' });
      assert.match(prompt.user, /至少两名志愿者/);
      assert.ok(prompt.user.length < 20000);
      return '<doc>\n## 主线\n先落实人员。\n## 人员\n### ◆ 两名志愿者才能试办\n不足就暂停。\n</doc>\n<prose domain="人员" refs="d1">两名志愿者才能试办，先落实人员，不足就暂停。</prose>';
    },
    async ({ local, errors }) => {
      localRef = local;
      const id = await local.host.createProject('重画空图');
      local.store.getState().setDocDraft('## 主题\n\n社区图书角的人员安排。');
      local.store.getState().flushDocEdits();
      local.store.getState().flushDoc();
      await waitFor(
        () => backend.getView(id),
        view => view.scope.includes('人员安排'),
      );
      await backend.saveSourceEvent(id, {
        id: 'saved-long',
        layer: 'L0->L1',
        inputs: [
          {
            id: 'long',
            role: 'user',
            content: '社区图书角至少两名志愿者，不足就暂停。'.repeat(1600),
          },
        ],
        outputs: [],
      });
      await local.store.getState().syncFromRemote();
      assert.equal(local.host.getSnapshot().hasSourceMaterial, true);
      await local.store.getState().redrawFromLedger();
      assert.equal(local.store.getState().nodes.length, 1);
      assert.ok(calls >= 3);
      assert.deepEqual(errors, []);
    },
  );
});

test('重画提炼中取消，不继续下一批、不保存半成品，来源保留', async () => {
  const started = deferred(),
    release = deferred();
  let calls = 0;
  await fixture(
    async prompt => {
      calls++;
      assert.match(prompt.system, /summary/);
      started.resolve();
      await release.promise;
      return JSON.stringify({ summary: '合成材料摘要' });
    },
    async ({ local, a }) => {
      await backend.saveSourceEvent(a.id, {
        id: 'long-cancel',
        layer: 'L0->L1',
        inputs: [{ id: 'long', role: 'user', content: '只处理合成验证材料。'.repeat(3000) }],
        outputs: [],
      });
      const before = local.store.getState().nodes;
      const running = local.store.getState().redrawFromLedger();
      try {
        await started.promise;
        local.store.getState().cancelGeneration();
        await waitFor(
          () => backend.listTasks(),
          tasks => tasks.some(task => task.status === 'cancelled'),
        );
        release.resolve();
        await running;
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(calls, 1);
        assert.deepEqual(local.store.getState().nodes, before);
        assert.equal((await backend.sourceEvents(a.id)).length, 1);
      } finally {
        release.resolve();
        await running;
      }
    },
  );
});

test('新建期间切换主题不被迟到响应拉回；重命名立即显示且串行保存最后输入', async () => {
  const held = deferred(),
    release = deferred();
  await fixture(
    async () => output,
    async ({ local, b, origin, fetch }) => {
      globalThis.fetch = async (url, options) => {
        if (String(url) === '/api/topics' && options?.method === 'POST') {
          held.resolve();
          await release.promise;
        }
        return fetch(new URL(String(url), origin), options);
      };
      const pending = local.host.createProject('后台完成创建');
      try {
        await held.promise;
        await local.host.switchProject(b.id);
        release.resolve();
        await pending;
        assert.equal(local.host.getSnapshot().currentProjectId, b.id);
        assert.equal(local.store.getState().boundProjectId, b.id);
        const first = local.host.renameProject(b.id, '第一次名称');
        assert.equal(local.host.getSnapshot().projects.find(p => p.id === b.id).name, '第一次名称');
        const second = local.host.renameProject(b.id, '最终名称');
        assert.equal(local.host.getSnapshot().projects.find(p => p.id === b.id).name, '最终名称');
        await Promise.all([first, second]);
        assert.equal((await backend.getTopic(b.id)).name, '最终名称');
        assert.equal(local.host.getSnapshot().projects.find(p => p.id === b.id).name, '最终名称');
      } finally {
        release.resolve();
        await pending;
      }
    },
  );
});

test('手改立即整理，超过原1.2秒防抖窗口仍完成；服务端写入一次，撤回按回执退回', async () => {
  const observed = [];
  await fixture(
    async task => {
      observed.push({
        phase: 'start',
        revision: (await backend.getTopic(task.topicId)).revision,
        baseRevision: task.baseRevision,
      });
      await new Promise(resolve => setTimeout(resolve, 1450));
      observed.push({
        phase: 'finish',
        revision: (await backend.getTopic(task.topicId)).revision,
        baseRevision: task.baseRevision,
      });
      return output;
    },
    async ({ local, a }) => {
      local.store.getState().updateNode('j1', { title: '刚刚手改的判断' });
      const report = await local.store.getState().tidyWhitebox();
      assert.equal(report?.changed, true, local.store.getState().error ?? '整理未完成');
      assert.equal(local.store.getState().error, null);
      assert.deepEqual(observed, [
        { phase: 'start', revision: 2, baseRevision: 2 },
        { phase: 'finish', revision: 2, baseRevision: 2 },
      ]);
      assert.equal(local.store.getState().nodes[0].title, '整理后的合成判断');
      const saved = await backend.getTopic(a.id);
      assert.equal(saved.revision, 3, '手改先保存，整理结果由服务端写入一次');
      assert.equal(saved.ledger.match(/整理后的合成判断/g)?.length, 1, '结果不能重复追加');
      assert(saved.raw.startsWith(baseLedger));
      assert.match(saved.raw, /刚刚手改的判断/);
      assert.doesNotMatch(saved.raw, /整理后的合成判断/);
      const tasks = await backend.listTasks();
      assert.deepEqual(
        tasks.map(task => [task.action, task.status]),
        [['tidy', 'completed']],
      );
      local.store.getState().undo();
      assert.notEqual(local.store.getState().nodes[0].title, '整理后的合成判断', '撤回立即生效');
      const restored = await waitFor(
        () => backend.getTopic(a.id),
        topic => topic.revision === 4,
      );
      assert.doesNotMatch(restored.ledger, /整理后的合成判断/);
      assert.match(restored.ledger, /刚刚手改的判断/, '撤回只退整理，不退之前的手改');
    },
  );
});

test('多轮整理的中间轮只计算，服务端最后写入一次；选区仍由共享store维护', async () => {
  let calls = 0;
  await fixture(
    async task => {
      calls++;
      assert.equal((await backend.getTopic(task.topicId)).revision, task.baseRevision);
      const refs = [...task.user.matchAll(/^(n\d+) \[/gm)].map(match => match[1]).join(',');
      const merge =
        calls === 1
          ? '<merge title="合并前两判断" body="保留两条合成依据。" members="n1,n2"/>'
          : '<merge title="再合并相邻判断" body="保留原始三条依据。" members="n1,n2"/>';
      return `${merge}\n<prose domain="验证" refs="${refs}">先保留原文和最小闭环的依据，再核对其余独立合成依据；本轮只合并相邻两条，后续判断仍按各自依据继续验证。</prose>`;
    },
    async ({ local, a }) => {
      const extra = Array.from(
        { length: 5 },
        (_, i) => `◇ j${i + 4} [验证] 合成判断${i + 4}\n独立合成依据${i + 4}`,
      ).join('\n');
      local.store.getState().updateLedger(`${baseLedger.replace('⏸ j2', '◇ j2')}\n${extra}`);
      const report = await local.store.getState().tidyWhitebox();
      assert.equal(report?.changed, true, local.store.getState().error ?? '整理未完成');
      assert.ok(calls > 1, '七条素材应触发多个安全收拢轮次');
      const saved = await backend.getTopic(a.id);
      assert.equal(saved.revision, 3, '中间轮不保存，最后只写入一次');
      assert.equal(saved.raw, baseLedger);
      assert.deepEqual(
        (await backend.listTasks()).map(task => task.status),
        ['completed'],
      );
    },
  );
});

test('第一轮只改正文时追加一次明确收拢请求，归并补充说明并保留可撤销的一次提交', async () => {
  let calls = 0;
  await fixture(
    async task => {
      calls++;
      if (calls === 1)
        return '<prose domain="验证" refs="n1,n2,n3,n4,n5,n6">先验证需求，随后再评估开发。保留三位访谈对象与记录拒绝原因的要求。</prose>';
      assert.match(task.user, /上一轮尚未完成收拢/);
      assert.match(task.system, /补充理由、示例/);
      return '<merge title="先访谈验证需求" body="先找三位访谈对象并记录拒绝原因。" members="n1,n2,n3"/>\n<prose domain="验证" refs="n1,n2,n3,n4,n5,n6">先找三位访谈对象并记录拒绝原因，验证需求后再评估开发；其余独立依据仍保留，不能当作需求已获验证。</prose>';
    },
    async ({ local }) => {
      local.store
        .getState()
        .updateLedger(
          '[场次 2026-09-18T10:00:00Z · 合成验证]\n走向 p1 [主题]\n仅记录需求验证。\n' +
            Array.from(
              { length: 6 },
              (_, i) => `◇ j${i + 1} [验证] 合成判断${i + 1}\n保留依据${i + 1}`,
            ).join('\n'),
        );
      const report = await local.store.getState().tidyWhitebox();
      assert.equal(calls, 2);
      assert.equal(report.before, 6);
      assert.equal(report.after, 4);
      assert.match(local.store.getState().doc, /三位访谈对象/);
      local.store.getState().undo();
      assert.equal(local.store.getState().nodes.length, 6);
    },
  );
});

test('两次都无可合并结果时停止，不无限调用，也不删除独立判断凑比例', async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      return '<noop/>';
    },
    async ({ local }) => {
      local.store
        .getState()
        .updateLedger(
          '[场次 2026-09-18T10:00:00Z · 合成验证]\n走向 p1 [主题]\n仅记录需求验证。\n' +
            Array.from({ length: 6 }, (_, i) => `◇ j${i + 1} [验证] 独立判断${i + 1}`).join('\n'),
        );
      const report = await local.store.getState().tidyWhitebox();
      assert.equal(calls, 2);
      assert.equal(report.before, report.after);
      assert.equal(report.changed, false);
    },
  );
});

test('计算中切换主题即取消旧任务，迟到输出不能写旧主题或新主题', async () => {
  const started = deferred(),
    release = deferred();
  await fixture(
    async () => {
      started.resolve();
      await release.promise;
      return output;
    },
    async ({ local, a, b }) => {
      const originalA = await backend.getTopic(a.id),
        originalB = await backend.getTopic(b.id);
      const send = globalThis.fetch,
        cancellationTrace = [];
      globalThis.fetch = async (url, options) => {
        const isCancel = String(url).endsWith('/cancel');
        if (isCancel) cancellationTrace.push({ request: String(url) });
        try {
          const response = await send(url, options);
          if (isCancel)
            cancellationTrace.push({
              status: response.status,
              body: await response.clone().json(),
            });
          return response;
        } catch (error) {
          if (isCancel) cancellationTrace.push({ error: error.message });
          throw error;
        }
      };
      const running = local.store.getState().tidyWhitebox();
      try {
        await started.promise;
        await local.host.switchProject(b.id);
        const cancelled = await waitFor(
          () => backend.listTasks(),
          tasks => tasks.some(task => task.status === 'cancelled'),
        ).catch(error => {
          throw new Error(`${error.message}; cancel=${JSON.stringify(cancellationTrace)}`);
        });
        assert.equal(cancelled[0].topicId, a.id);
        release.resolve();
        await running;
        assert.equal(local.store.getState().boundProjectId, b.id);
        assert.equal(local.store.getState().nodes[0].title, '另一主题判断');
        assert.equal(local.store.getState().isTidying, false);
        assert.deepEqual(await backend.getTopic(a.id), originalA);
        assert.deepEqual(await backend.getTopic(b.id), originalB);
      } finally {
        release.resolve();
        await running;
      }
    },
  );
});

test('材料批次先落盘，随后保存人的编辑：批次与手改都保留且页面继续刷新', async () => {
  await fixture(
    async () => output,
    async ({ local, a, browserCache }) => {
      const before = await backend.getTopic(a.id);
      await backend.commitMaterialBatch(
        a.id,
        before.revision,
        { id: 'synthetic-material', start: 0, end: 100 },
        '<doc>\n## 分批来源\n### ◆ 后台新判断\n来自文件首段。\n</doc>\n<prose domain="分批来源" refs="d1">后台新判断来自文件首段，与这一批材料的进度一起保存。</prose>',
      );
      local.store.getState().updateNode('j1', { title: '人的最新决定' });
      local.store.getState().flushDoc();
      await waitFor(
        () => JSON.parse(browserCache.get(`gft-local:panel:${a.id}`)),
        entry => entry.pending === false && entry.revision >= 3,
      );
      const view = await backend.getView(a.id);
      assert.match(view.doc, /人的最新决定/);
      assert.match(view.doc, /后台新判断/);
      assert.equal(local.store.getState().error, null);
      assert.equal(
        (await backend.getTopic(a.id)).materialCheckpoints['synthetic-material'].offset,
        100,
      );
    },
  );
});

test('外部写入使本地保存CAS冲突时，远端不被覆盖，手改与pending镜像保留', async () => {
  await fixture(
    async () => output,
    async ({ local, a, browserCache }) => {
      const before = await backend.getTopic(a.id);
      await backend.saveGraph(a.id, before.revision, {
        kind: 'edit',
        id: 'j1',
        title: '外部刚写入的判断',
      });
      local.store.getState().updateNode('j1', { title: '本地未保存的手改' });
      local.store.getState().flushDoc();
      await waitFor(() => local.store.getState().error, Boolean);
      assert.match(local.store.getState().error, /修改|版本|冲突/);
      assert.equal((await backend.getView(a.id)).graph.nodes[0].title, '外部刚写入的判断');
      assert.equal(local.store.getState().nodes[0].title, '本地未保存的手改');
      const mirror = JSON.parse(browserCache.get(`gft-local:panel:${a.id}`));
      assert.equal(mirror.pending, true);
      assert.match(mirror.map.ledger, /本地未保存的手改/);
    },
  );
});

test('状态查询短暂断线不取消任务，恢复后只应用同一个结果', async () => {
  const entered = deferred(),
    release = deferred();
  await fixture(
    async () => {
      entered.resolve();
      await release.promise;
      return output;
    },
    async ({ local, a, origin, fetch }) => {
      let failures = 0;
      globalThis.fetch = (url, options) => {
        if (String(url).endsWith('/status') && failures++ < 2)
          return Promise.reject(new TypeError('Failed to fetch'));
        return fetch(new URL(String(url), origin), options);
      };
      const running = local.store.getState().tidyWhitebox();
      try {
        await entered.promise;
        await waitFor(
          () => failures,
          n => n >= 3,
        );
        assert.equal((await backend.listTasks()).length, 1);
        assert.equal((await backend.listTasks())[0].status, 'running');
        release.resolve();
        await running;
        assert.equal((await backend.listTasks())[0].status, 'completed');
        assert.equal(local.store.getState().error, null);
      } finally {
        release.resolve();
      }
    },
  );
});

test('关闭面板只脱离任务，后台节点整理完成并保存', async () => {
  const entered = deferred(),
    release = deferred();
  await fixture(
    async () => {
      entered.resolve();
      await release.promise;
      return '<node title="后台完成的润色"/>';
    },
    async ({ local, a }) => {
      const running = local.store.getState().refineNode('j1');
      try {
        await entered.promise;
        local.dispose();
        assert.equal((await backend.listTasks())[0].status, 'running');
        release.resolve();
        await running;
        await waitFor(
          () => backend.listTasks(),
          tasks => tasks[0]?.status === 'completed',
        );
        assert.equal(local.store.getState().boundProjectId, null);
        assert.equal(local.store.getState().nodes.length, 0);
        assert.match(JSON.stringify(await backend.getView(a.id)), /后台完成的润色/);
      } finally {
        release.resolve();
      }
    },
  );
});

test('同一主题的快速手工新增和独立并发来源写入均不丢存证', async () => {
  await fixture(
    async () => output,
    async ({ local, a, errors }) => {
      const one = local.store.getState().addNode({ title: '第一条手工原话' });
      const two = local.store.getState().addNode({ title: '第二条手工原话' });
      const event = id => ({
        layer: 'L0->L1',
        inputs: [{ id, role: 'user', name: null, content: '独立合成来源', ts: 1 }],
        outputs: [id],
        sourceMeta: {
          sessionId: 'manual',
          sessionTitle: '并发来源',
          fromId: id,
          toId: id,
          count: 1,
        },
      });
      await Promise.all([
        backend.saveSourceEvent(a.id, event('external-one')),
        backend.saveSourceEvent(a.id, event('external-two')),
      ]);
      const sources = await waitFor(
        () => backend.sourceEvents(a.id),
        items => items.length === 4,
      );
      assert.deepEqual(
        new Set(sources.flatMap(source => source.outputs)),
        new Set([one, two, 'external-one', 'external-two']),
      );
      assert.deepEqual(errors, []);
      local.store.getState().flushDoc();
      await waitFor(
        () => backend.getTopic(a.id),
        topic => topic.revision === 2,
      );
    },
  );
});

test('旧保存响应晚于重新加载的新版本时，不倒退浏览器保存基准', async () => {
  const held = deferred(),
    release = deferred();
  await fixture(
    async () => output,
    async ({ local, a, b, browserCache, origin, fetch }) => {
      let capture = true;
      globalThis.fetch = async (url, options) => {
        const response = await fetch(new URL(String(url), origin), options);
        if (String(url).endsWith('/state') && capture) {
          capture = false;
          held.resolve();
          await release.promise;
        }
        return response;
      };
      local.store.getState().updateNode('j1', { title: '较早保存的本地修改' });
      local.store.getState().flushDoc();
      try {
        await held.promise;
        const saved = await backend.getTopic(a.id);
        assert.equal(saved.revision, 2);
        await backend.saveGraph(a.id, 2, {
          kind: 'add',
          title: '外部后来的独立判断',
          content: '新增依据',
        });
        await local.host.switchProject(b.id);
        await local.host.switchProject(a.id);
        assert.equal(
          JSON.parse(browserCache.get(`gft-local:panel:${a.id}`)).revision,
          3,
          '已接受外部新版本',
        );
        release.resolve();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(
          JSON.parse(browserCache.get(`gft-local:panel:${a.id}`)).revision,
          3,
          '旧保存回执不能把基准退回2',
        );
        local.store.getState().flushDoc();
        await waitFor(
          () => backend.getTopic(a.id),
          topic => topic.revision === 4,
        );
        assert.equal(local.store.getState().error, null);
        assert.match((await backend.getTopic(a.id)).ledger, /外部后来的独立判断/);
      } finally {
        release.resolve();
      }
    },
  );
});

test('重复退出不会取消服务端任务，退出前手工修改保持已保存', async () => {
  const entered = deferred(),
    release = deferred();
  await fixture(
    async () => {
      entered.resolve();
      await release.promise;
      return '<noop/>';
    },
    async ({ local, a, origin, fetch }) => {
      const traffic = [];
      globalThis.fetch = (url, options) => {
        traffic.push(String(url));
        return fetch(new URL(String(url), origin), options);
      };
      local.store.getState().updateNode('j1', { title: '退出前已保存的手工修改' });
      const running = local.store.getState().tidyWhitebox();
      try {
        await entered.promise;
        local.dispose();
        local.dispose();
        assert.equal(traffic.filter(url => url.endsWith('/cancel')).length, 0);
        assert.equal((await backend.listTasks())[0].status, 'running');
        release.resolve();
        await running;
        await waitFor(
          () => backend.listTasks(),
          tasks => tasks[0]?.status === 'completed',
        );
        assert.match(JSON.stringify(await backend.getView(a.id)), /退出前已保存的手工修改/);
      } finally {
        release.resolve();
      }
    },
  );
});

test('原案例未直连两点可以连线，自动说明只处理该线；圈圈状态不把整个图设为生成中', async () => {
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  await fixture(
    async request => {
      calls++;
      assert.equal(request.action, 'relation');
      const input = JSON.parse(request.user);
      assert.deepEqual(Object.keys(input), ['from', 'to', 'reason']);
      assert.equal(input.from.id, 'j15');
      assert.equal(input.to.id, 'j17');
      entered.resolve();
      await release.promise;
      return '<edge from="j15" to="j17" reason="市场能协调，使用它仍要付寻找和订约的成本。"/>';
    },
    async ({ local, a, errors }) => {
      const initial = local.store.getState(),
        originalDoc = initial.doc;
      assert.equal(
        initial.edges.some(e => e.from === 'j15' && e.to === 'j17'),
        false,
      );
      assert.equal(initial.addEdgeManual('j17', 'j15'), true); // 反向发起仍沿既有思考顺序。
      await entered.promise;
      const pending = local.store.getState(),
        edge = pending.edges.find(e => e.from === 'j15' && e.to === 'j17');
      assert.deepEqual([...pending.explainingEdgeIds], [edge.id]);
      assert.equal(pending.isGenerating, false);
      assert.equal(pending.isTidying, false);
      assert.equal(pending.isRefining, false);
      assert.equal(pending.doc, originalDoc);
      release.resolve();
      await waitFor(
        () => local.store.getState(),
        s => s.explainingEdgeIds.size === 0 && s.edges.find(e => e.id === edge.id)?.reason,
      );
      await waitFor(
        () => backend.getView(a.id),
        view => view.graph.edges.find(e => e.from === 'j15' && e.to === 'j17')?.reason,
      );
      assert.equal(calls, 1);
      assert.deepEqual(errors, []);
      assert.equal(local.store.getState().doc, originalDoc);
      assert.equal(local.store.getState().nodes.length, initial.nodes.length);
    },
    { coase: true },
  );
});

test('承接分析可以取消或被手工编辑取代，迟到的AI不覆盖人工说明', async () => {
  const entered = deferred(),
    release = deferred();
  await fixture(
    async request => {
      entered.resolve();
      await release.promise;
      const input = JSON.parse(request.user);
      return `<edge from="${input.from.id}" to="${input.to.id}" reason="迟到的模型说明。"/>`;
    },
    async ({ local }) => {
      assert.equal(local.store.getState().addEdgeManual('j15', 'j17'), true);
      await entered.promise;
      const edge = local.store.getState().edges.find(e => e.from === 'j15' && e.to === 'j17');
      local.store.getState().editEdgeReason(edge.id, '我希望比较市场协调与使用市场的代价。');
      assert.equal(local.store.getState().explainingEdgeIds.size, 0);
      release.resolve();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(
        local.store.getState().edges.find(e => e.id === edge.id).reason,
        '我希望比较市场协调与使用市场的代价。',
      );
    },
    { coase: true },
  );
});

test('快速连两条线逐条分析，结果不互踩且只保存对应说明', async () => {
  let calls = 0;
  await fixture(
    async request => {
      calls++;
      const input = JSON.parse(request.user);
      return `<edge from="${input.from.id}" to="${input.to.id}" reason="比较这两点各自承担的协作成本与安排方式。"/>`;
    },
    async ({ local, a, errors }) => {
      const st = local.store.getState();
      st.addEdgeManual('j15', 'j17');
      st.addEdgeManual('j16', 'j19');
      assert.equal(local.store.getState().explainingEdgeIds.size, 2);
      await waitFor(
        () => local.store.getState(),
        s =>
          s.explainingEdgeIds.size === 0 &&
          s.edges
            .filter(
              e => (e.from === 'j15' && e.to === 'j17') || (e.from === 'j16' && e.to === 'j19'),
            )
            .every(e => e.reason),
      );
      await waitFor(
        () => backend.getView(a.id),
        view =>
          view.graph.edges
            .filter(
              e => (e.from === 'j15' && e.to === 'j17') || (e.from === 'j16' && e.to === 'j19'),
            )
            .every(e => e.reason),
      );
      assert.equal(calls, 2);
      assert.deepEqual(errors, []);
    },
    { coase: true },
  );
});

test('long standalone caption gets one focused retry and never saves a cut sentence', async () => {
  let calls = 0;
  await fixture(
    async request => {
      calls++;
      const input = JSON.parse(request.user);
      const reason = calls === 1 ? 'x'.repeat(33) : 'Compare internal vs market cost.';
      return (
        '<edge from="' + input.from.id + '" to="' + input.to.id + '" reason="' + reason + '"/>'
      );
    },
    async ({ local, a, errors }) => {
      local.store.getState().addEdgeManual('j15', 'j17');
      await waitFor(
        () => local.store.getState(),
        s =>
          s.explainingEdgeIds.size === 0 &&
          s.edges.find(e => e.from === 'j15' && e.to === 'j17')?.reason,
      );
      const expected = 'Compare internal vs market cost.';
      assert.equal(
        local.store.getState().edges.find(e => e.from === 'j15' && e.to === 'j17').reason,
        expected,
      );
      assert.equal(calls, 2);
      assert.deepEqual(errors, []);
      await waitFor(
        () => backend.getView(a.id),
        v => v.graph.edges.find(e => e.from === 'j15' && e.to === 'j17')?.reason === expected,
      );
    },
    { coase: true },
  );
});

test('selected-object deletion persists a real disconnection, keeps endpoints and can restore explanation', async () => {
  await fixture(
    async () => {
      throw new Error('No model call is expected for deletion.');
    },
    async ({ local, a }) => {
      const initial = local.store.getState();
      const edge = initial.edges.find(e => e.from === 'j15' && e.to === 'j16');
      const nodeIds = initial.nodes.map(n => n.id),
        raw = initial.raw;
      initial.setSelectedEdges([edge.id]);
      initial.deleteElements([], [edge.id]);
      assert.equal(local.store.getState().selectedEdgeIds.size, 0);
      assert.deepEqual(
        local.store.getState().nodes.map(n => n.id),
        nodeIds,
      );
      assert.equal(local.store.getState().raw, raw);
      await waitFor(
        () => backend.getView(a.id),
        v => !v.graph.edges.some(e => e.from === edge.from && e.to === edge.to),
      );
      local.store.getState().undo();
      await waitFor(
        () => backend.getView(a.id),
        v =>
          v.graph.edges.some(
            e => e.from === edge.from && e.to === edge.to && e.reason === edge.reason,
          ),
      );
      const restored = local.store.getState().edges.find(e => e.id === edge.id);
      assert.equal(restored.reason, edge.reason);
    },
    { coase: true },
  );
});

test('mixed node and line deletion persists together and one undo restores both', async () => {
  await fixture(
    async () => {
      throw new Error('Deletion needs no model.');
    },
    async ({ local, a }) => {
      const initial = local.store.getState();
      const edge = initial.edges.find(e => e.from === 'j15' && e.to === 'j16');
      const node = initial.nodes.find(n => n.id === 'j23');
      const ledger = initial.ledger,
        raw = initial.raw;
      initial.setSelectedNodes([node.id]);
      initial.setSelectedEdges([edge.id]);
      initial.deleteElements([node.id], [edge.id]);
      assert.equal(local.store.getState().selectedNodeIds.size, 0);
      assert.equal(local.store.getState().selectedEdgeIds.size, 0);
      await waitFor(
        () => backend.getView(a.id),
        v =>
          !v.graph.nodes.some(n => n.id === node.id) &&
          !v.graph.edges.some(e => e.from === edge.from && e.to === edge.to),
      );
      assert.equal(local.store.getState().raw, raw);
      local.store.getState().undo();
      assert.equal(local.store.getState().ledger, ledger);
      await waitFor(
        () => backend.getView(a.id),
        v =>
          v.graph.nodes.some(n => n.id === node.id) &&
          v.graph.edges.some(
            e => e.from === edge.from && e.to === edge.to && e.reason === edge.reason,
          ),
      );
    },
    { coase: true },
  );
});
test('selection deletion preserves an active text draft', async () => {
  await fixture(
    async () => {
      throw new Error('Deletion needs no model.');
    },
    async ({ local }) => {
      const initial = local.store.getState(),
        edge = initial.edges[0],
        ledger = initial.ledger;
      initial.setEditingEdge(edge.id);
      initial.deleteElements([], [edge.id]);
      assert.equal(local.store.getState().ledger, ledger);
      initial.setEditingEdge(null);
    },
    { coase: true },
  );
});

/** Which baseLedger node a node-tidy request targets: 0 for j1, 1 for j2. */
const tidiedNode = request => (/^title: 原判断$/m.test(request.system) ? 0 : 1);
const body = (local, id) => local.store.getState().ledgerState.judgments.get(id).content;

test('independent node tidy runs concurrently, changes only its node, and undoes one step at a time', async () => {
  const releases = [deferred(), deferred()];
  let calls = 0;
  await fixture(
    async request => {
      const index = tidiedNode(request);
      calls++;
      await releases[index].promise;
      return index === 0
        ? '<node title="原判断理顺" body="First tidy result."/>'
        : '<node title="暂缓扩展理顺" body="Second tidy result."/>';
    },
    async ({ local, a }) => {
      const original = local.store.getState().ledger,
        doc = local.store.getState().doc;
      const first = local.store.getState().refineNode('j1');
      const second = local.store.getState().refineNode('j2');
      try {
        assert.deepEqual([...local.store.getState().refiningNodeIds], ['j1', 'j2']);
        await waitFor(
          () => calls,
          value => value === 2,
        );
        releases[0].resolve();
        await first;
        assert.equal(local.store.getState().refiningNodeIds.has('j2'), true);
        assert.equal(body(local, 'j1'), 'First tidy result.', '先完成的节点先显示');
        releases[1].resolve();
        await second;
        assert.equal(calls, 2, '各节点只调用一次模型，不重算文档');
        assert.equal(body(local, 'j2'), 'Second tidy result.');
        assert.equal(local.store.getState().error, null);
        assert.equal(local.store.getState().refiningNodeIds.size, 0);
        local.store.getState().undo();
        assert.equal(body(local, 'j2'), '最小闭环验证后再决定。');
        assert.equal(body(local, 'j1'), 'First tidy result.');
        local.store.getState().undo();
        assert.equal(local.store.getState().ledger, original);
        assert.equal(local.store.getState().doc, doc);
        const view = await waitFor(
          () => backend.getView(a.id),
          v => v.graph.nodes.find(n => n.id === 'j1').content === '先保留原文。',
        );
        assert.equal(view.graph.nodes.find(n => n.id === 'j2').content, '最小闭环验证后再决定。');
        assert.equal(local.store.getState().error, null);
      } finally {
        releases.forEach(item => item.resolve());
        await Promise.all([first, second]);
      }
    },
  );
});

test('undo keeps its immediate result when the confirmation read disconnects', async () => {
  await fixture(
    async () => '<node title="整理完成" body="新的说明。"/>',
    async ({ local, a }) => {
      const original = local.store.getState().ledger;
      await local.store.getState().refineNode('j1');
      const browserFetch = globalThis.fetch;
      let rolledBack = false;
      globalThis.fetch = async (url, options) => {
        if (rolledBack && String(url).endsWith('/snapshot')) throw new TypeError('synthetic disconnect');
        const response = await browserFetch(url, options);
        if (String(url).endsWith('/rollback-operation')) rolledBack = true;
        return response;
      };
      try {
        local.store.getState().undo();
        assert.equal(local.store.getState().ledger, original);
        await waitFor(() => local.store.getState().error, error => !!error);
        assert.equal(local.store.getState().ledger, original);
        assert.equal((await backend.getView(a.id)).graph.nodes.find(n => n.id === 'j1').title, '原判断');
        globalThis.fetch = browserFetch;
        await local.service.retry();
        assert.equal(local.store.getState().nodes.find(n => n.id === 'j1').title, '原判断');
        assert.equal(body(local, 'j1'), '先保留原文。');
      } finally {
        globalThis.fetch = browserFetch;
      }
    },
  );
});

test('two quick undos take back a hand edit and then the server operation before it', async () => {
  await fixture(
    async () => '<node title="原判断理顺" body="理顺的说明。"/>',
    async ({ local, a }) => {
      const original = local.store.getState().ledger,
        before = await backend.getView(a.id);
      await local.store.getState().refineNode('j1');
      assert.equal(local.store.getState().nodes.find(n => n.id === 'j1').title, '原判断理顺');
      local.store.getState().updateNode('j2', { title: '手改的暂缓' });
      local.store.getState().undo();
      local.store.getState().undo();
      assert.equal(local.store.getState().ledger, original, '两步撤回立即生效');
      const view = await waitFor(
        () => backend.getView(a.id),
        v => v.graph.nodes.find(n => n.id === 'j1').title === '原判断',
      );
      assert.deepEqual(view.graph.nodes, before.graph.nodes);
      await waitFor(
        () => local.store.getState().nodes.find(n => n.id === 'j1').title,
        title => title === '原判断',
      );
      assert.equal(local.store.getState().error, null);
    },
  );
});

test('clicking a running node stops only that task and discards its late result', async () => {
  const releases = [deferred(), deferred()];
  let calls = 0;
  await fixture(
    async request => {
      const index = tidiedNode(request);
      calls++;
      await releases[index].promise;
      return index === 0 ? '<node title="不该写入的迟到结果"/>' : '<noop/>';
    },
    async ({ local }) => {
      const original = local.store.getState().ledger;
      const first = local.store.getState().refineNode('j1');
      const second = local.store.getState().refineNode('j2');
      try {
        assert.equal(local.store.getState().refiningNodeIds.size, 2);
        await waitFor(
          () => calls,
          value => value === 2,
        );
        await local.store.getState().refineNode('j1');
        assert.deepEqual([...local.store.getState().refiningNodeIds], ['j2']);
        await waitFor(
          () => backend.listTasks(),
          tasks => tasks.some(task => task.status === 'cancelled'),
        );
        releases.forEach(item => item.resolve());
        await Promise.all([first, second]);
        assert.equal(local.store.getState().ledger, original);
        assert.equal(local.store.getState().error, null);
        assert.equal(local.store.getState().isRefining, false);
      } finally {
        releases.forEach(item => item.resolve());
        await Promise.all([first, second]);
      }
    },
  );
});

test('editing a node while it is being tidied stops that tidy; the person’s edit stands', async () => {
  const entered = deferred(),
    release = deferred();
  await fixture(
    async () => {
      entered.resolve();
      await release.promise;
      return '<node title="模型的整理结果"/>';
    },
    async ({ local, a }) => {
      const run = local.store.getState().refineNode('j1');
      try {
        await entered.promise;
        local.store.getState().updateNode('j1', { title: '人的最新修正' });
        assert.equal(local.store.getState().refiningNodeIds.has('j1'), false);
        await waitFor(
          () => backend.listTasks(),
          tasks => tasks[0]?.status === 'cancelled',
        );
        release.resolve();
        await run;
        local.store.getState().flushDoc();
        await waitFor(
          () => backend.getView(a.id),
          v => v.graph.nodes.find(n => n.id === 'j1').title === '人的最新修正',
        );
        assert.equal(local.store.getState().error, null);
        assert.doesNotMatch((await backend.getTopic(a.id)).ledger, /模型的整理结果/);
      } finally {
        release.resolve();
        await run;
      }
    },
  );
});

test('a tidy that lands while the node is open for editing stays under the person’s later edit', async () => {
  const entered = deferred(),
    release = deferred();
  await fixture(
    async () => {
      entered.resolve();
      await release.promise;
      return '<node title="模型的整理结果" body="模型理顺的说明。"/>';
    },
    async ({ local, a }) => {
      const run = local.store.getState().refineNode('j1');
      await entered.promise;
      local.store.getState().setEditingNode('j1');
      release.resolve();
      await run;
      assert.equal((await backend.listTasks())[0].status, 'completed');
      assert.equal(local.store.getState().nodes.find(n => n.id === 'j1').title, '原判断');
      // Editing kept the result from syncing in; the edit is committed afterwards.
      local.store.getState().updateNode('j1', { title: '人的最新修正' });
      local.store.getState().setEditingNode(null);
      local.store.getState().flushDoc();
      const view = await waitFor(
        () => backend.getView(a.id),
        v => v.graph.nodes.find(n => n.id === 'j1').title === '人的最新修正',
      );
      assert.equal(view.graph.nodes.find(n => n.id === 'j1').content, '模型理顺的说明。');
      assert.equal(local.store.getState().nodes.find(n => n.id === 'j1').title, '人的最新修正');
      assert.equal(local.store.getState().error, null);
    },
  );
});

test('node tidy rewrites only its own title and full explanation, leaves the Doc, and undoes by receipt', async () => {
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const note = 'Avoiding renegotiation still requires coordination.';
  await fixture(
    async request => {
      calls++;
      assert.match(request.system, /保留原说明的全部信息/);
      entered.resolve();
      await release.promise;
      return `<node title="内部安排省去重复订约" body="${note}"/>`;
    },
    async ({ local, a, errors }) => {
      const before = local.store.getState(),
        ledger = before.ledger,
        original = before.ledgerState.judgments.get('j16').content;
      const run = before.refineNode('j16');
      await entered.promise;
      assert.equal(local.store.getState().isRefining, true);
      assert.deepEqual([...local.store.getState().refiningNodeIds], ['j16']);
      local.store.getState().setSelectedNodes(['j20']);
      assert.deepEqual([...local.store.getState().refiningNodeIds], ['j16']);
      release.resolve();
      await run;
      assert.equal(body(local, 'j16'), note);
      assert.equal(
        local.store.getState().ledgerState.judgments.get('j16').title,
        '内部安排省去重复订约',
      );
      for (const node of before.nodes.filter(n => n.id !== 'j16'))
        assert.equal(body(local, node.id), before.ledgerState.judgments.get(node.id).content);
      assert.doesNotMatch(local.store.getState().doc, /Avoiding renegotiation/, '说明不写进文档');
      assert.equal(local.store.getState().tidyScopeIds, null);
      assert.equal(calls, 1);
      assert.deepEqual(errors, []);
      assert.equal(
        (await backend.getView(a.id)).graph.nodes.find(n => n.id === 'j16').content,
        note,
      );
      local.store.getState().undo();
      assert.equal(local.store.getState().ledger, ledger);
      await waitFor(
        () => backend.getView(a.id),
        v => v.graph.nodes.find(n => n.id === 'j16').content === original,
      );
    },
    { coase: true },
  );
});

test('node tidy that returns nothing usable leaves the map and its revision unchanged', async () => {
  await fixture(
    async () => '<revise id="n5" title="Not the node-tidy format"/>',
    async ({ local, a }) => {
      const before = local.store.getState().ledger,
        revision = (await backend.getTopic(a.id)).revision;
      await local.store.getState().refineNode('j16');
      assert.equal(local.store.getState().ledger, before);
      assert.equal(local.store.getState().error, null);
      assert.equal((await backend.getTopic(a.id)).revision, revision);
      assert.equal(local.store.getState().tidyScopeIds, null);
    },
    { coase: true },
  );
});

test('removed relations cannot remain as invisible selected delete targets', async () => {
  await fixture(
    async () => {
      throw Error('No model call.');
    },
    async ({ local }) => {
      const initial = local.store.getState(),
        edge = initial.edges[0];
      initial.setSelectedNodes(['j15']);
      initial.setSelectedEdges([edge.id]);
      initial.deleteEdge(edge.id);
      assert.equal(local.store.getState().selectedEdgeIds.size, 0);
      assert.deepEqual([...local.store.getState().selectedNodeIds], ['j15']);
    },
    { coase: true },
  );
});

test('unified node deletion retains undo metadata and cancels affected relation computation', async () => {
  const entered = deferred(),
    release = deferred();
  await fixture(
    async request => {
      entered.resolve();
      await release.promise;
      const input = JSON.parse(request.user);
      return (
        '<edge from="' +
        input.from.id +
        '" to="' +
        input.to.id +
        '" reason="Compare the two arrangements."/>'
      );
    },
    async ({ local, a, errors }) => {
      local.store.getState().addEdgeManual('j15', 'j17');
      await entered.promise;
      local.store.getState().deleteElements(['j17'], []);
      assert.equal(local.store.getState().lastDeleted.node.id, 'j17');
      assert.equal(local.store.getState().explainingEdgeIds.size, 0);
      // The cancel may arrive after the server saved the caption; the deletion
      // then rebases onto it instead of reporting a conflict.
      release.resolve();
      await waitFor(
        () => backend.getView(a.id),
        v => !v.graph.nodes.some(n => n.id === 'j17'),
      );
      assert.equal(
        local.store.getState().nodes.some(n => n.id === 'j17'),
        false,
      );
      assert.equal(local.store.getState().error, null);
      assert.deepEqual(errors, []);
    },
    { coase: true },
  );
});
