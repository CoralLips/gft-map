import { createThinkingMapStore } from '../../../src/store/thinkingMap/createStore';
import type { MapHostSnapshot, ThinkingMapHost, ThinkingMapRuntime } from '../../../src/store/thinkingMap/runtime';
import type { PersistedThinkingMap } from '../../../src/type/thinkingMap';
import { bundleToMap, createTopicBundle, parseTopicBundle } from '../../../src/service/topicBundle';
import { examples, exampleBundle } from './examples';

/** Browser-only host for the real shared workspace. No local service or model requests. */
export function createShowcaseRuntime(initial: string, notify: (message: string) => void) {
  const maps = new Map<string, PersistedThinkingMap>();
  const listeners = new Set<() => void>();
  const key = 'gft-map:showcase:v1';
  let projects = examples.map(example => ({ id: example.id as string, name: example.name as string, status: 'active' as const }));
  for (const example of examples) maps.set(example.id, bundleToMap(exampleBundle(example), example.id));
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (Array.isArray(saved) && saved.length) {
      const restored = saved.map(record => {
        if (typeof record?.id !== 'string') throw new Error('Invalid example state');
        return { id: record.id as string, bundle: parseTopicBundle(record.bundle) };
      });
      maps.clear(); projects = [];
      for (const { id, bundle } of restored) {
        maps.set(id, bundleToMap(bundle, id));
        projects.push({ id, name: bundle.topic.name, status: 'active' });
      }
    }
  } catch { /* Samples remain usable if browser storage is unavailable. */ }
  let snapshot: MapHostSnapshot = {
    projects, currentProjectId: maps.has(initial) ? initial : projects[0].id,
    currentSession: null, chatHistory: [], sourceLabel: '示例材料', showMemoryToggle: false,
    hasSourceMaterial: true,
    redrawDescription: '在线示例不连接模型。安装本地版后，重画会按当前主题重新筛选 Log，生成新的 Doc 和 Map。',
  };
  const publish = (change: Partial<MapHostSnapshot>) => {
    snapshot = { ...snapshot, ...change }; listeners.forEach(listener => listener());
  };
  let storageWarning = false;
  const persist = () => {
    try { sessionStorage.setItem(key, JSON.stringify(snapshot.projects.map(p => ({ id: p.id, bundle: createTopicBundle(p.name, maps.get(p.id)!) })))); }
    catch { if (!storageWarning) { storageWarning = true; notify('浏览器暂时无法保存这份试改。当前页面仍可使用，请导出脉络包保留修改。'); } }
  };
  const flush = () => { store.getState().flushDocEdits(); store.getState().flushDoc(); };
  const modelNotice = () => notify('这是可编辑的浏览器示例，不连接模型或本机聊天。安装本地版后，可执行更新、整理和重画。');
  const host: ThinkingMapHost = {
    getSnapshot: () => snapshot,
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async switchProject(id) {
      if (!maps.has(id)) return;
      flush();
      publish({ currentProjectId: id, hasSourceMaterial: Boolean(maps.get(id)?.raw) });
      await store.getState().hydrateForProject(id);
    },
    async createProject(name) {
      flush(); const id = crypto.randomUUID();
      maps.set(id, bundleToMap(createTopicBundle(name, { ledger: '', raw: '' }), id));
      publish({ projects: [...snapshot.projects, { id, name, status: 'active' }] });
      await host.switchProject(id); persist(); return id;
    },
    async renameProject(id, name) { publish({ projects: snapshot.projects.map(p => p.id === id ? { ...p, name } : p) }); persist(); },
    async deleteProject(id) {
      flush();
      if (snapshot.projects.length === 1) { notify('至少保留一份示例；可以用“恢复本例”重新开始。'); return; }
      publish({ projects: snapshot.projects.filter(p => p.id !== id) });
      if (snapshot.currentProjectId === id) await host.switchProject(snapshot.projects[0].id);
      maps.delete(id); persist();
    },
    ensureCanGenerate: () => { modelNotice(); return false; },
    requestUpdate: async () => { modelNotice(); },
    fetchSourceBatches: async () => [],
    async importBundle(input) {
      const bundle = parseTopicBundle(input); flush();
      const id = crypto.randomUUID(); maps.set(id, bundleToMap(bundle, id));
      publish({ projects: [...snapshot.projects, { id, name: bundle.topic.name, status: 'active' }] });
      await host.switchProject(id); store.getState().setRightView('doc'); persist();
      notify('已导入为一份新脉络，原来的示例仍保留。文件只在此浏览器中读取。');
    },
  };
  const noModel = async (): Promise<never> => { throw new Error('在线示例不运行模型。请安装本地版后使用这项操作；当前修改已保留。'); };
  const persistence: ThinkingMapRuntime['persistence'] = {
    load: async id => maps.get(id) || null, loadCached: id => maps.get(id) || null,
    save: async (id, map) => { if (maps.has(id)) { maps.set(id, map); persist(); } return null; },
    cachePending: (id, map) => { if (maps.has(id)) { maps.set(id, map); persist(); } },
    hasPending: () => false, hasRemoteChanges: () => false, accept: () => {},
    insertCondensation: async () => {}, clearCondensations: async () => {}, fetchSourceSnapshots: async () => '',
  };
  const store = createThinkingMapStore({ host, persistence, ai: { generate: noModel, tidy: noModel, refine: noModel } });
  // Model controls explain the boundary; never pretend a static demo generated a result.
  store.setState({ tidyWhitebox: async () => { modelNotice(); return null; }, redrawFromLedger: async () => { modelNotice(); }, refineNode: async () => { modelNotice(); } });
  return {
    store, host, flush,
    async start() { await store.getState().hydrateForProject(snapshot.currentProjectId!); },
    async reset(id: string) {
      const example = examples.find(e => e.id === id); if (!example) return;
      flush(); maps.set(id, bundleToMap(exampleBundle(example), id));
      const projects = snapshot.projects.filter(p => p.id !== id);
      publish({ projects: [...projects, { id, name: example.name, status: 'active' }] });
      // Force a clean hydrate, including clearing the undo stack for this explicit reset.
      store.getState().resetLocal(); await host.switchProject(id); persist();
    },
  };
}
