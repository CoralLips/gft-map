import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThinkingMapRuntimeProvider } from '../../../src/component/focus/ThinkingMapRuntime';
import { ThinkingMapWorkspace } from '../../../src/component/focus/ThinkingMapWorkspace';
import { ConfirmDialog, confirmDialog } from '../../../src/component/common/ConfirmDialog';
import { renderSourceLog } from '../../../src/service/sourceLog';
import { themeOf } from '../../../src/service/ledger';
import { createTopicBundle, topicSummary } from '../../../src/service/topicBundle';
import { initTheme, setThemePref } from '../../../src/util/theme';
import { examples } from './examples';
import { createShowcaseRuntime } from './runtime';
import '../../../src/style/index.css';
import '../web/styles.css';
import './demo.css';

const params = new URLSearchParams(location.search);
const selected = examples.find(e => e.id === params.get('case')) || examples[0];
const runtime = createShowcaseRuntime(selected.id, message => window.dispatchEvent(new CustomEvent('showcase-notice', { detail: message })));
type Panel = 'sources' | 'handoff' | 'transfer' | null;

function Modal({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className="demo-dialog" ref={ref} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header><h2>{title}</h2><button autoFocus aria-label="关闭" onClick={close}>×</button></header>{children}
  </dialog>;
}

function downloadCurrent() {
  runtime.flush();
  const snapshot = runtime.host.getSnapshot();
  const name = snapshot.projects.find(p => p.id === snapshot.currentProjectId)?.name || selected.name;
  const content = JSON.stringify(createTopicBundle(name, runtime.store.getState()), null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.gft.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [panel, setPanel] = useState<Panel>(params.get('step') === 'transfer' ? 'transfer' : null);
  const [notice, setNotice] = useState('');
  const [readBody, setReadBody] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const host = useSyncExternalStore(runtime.host.subscribe, runtime.host.getSnapshot);
  const activeExample = examples.find(e => e.id === host.currentProjectId) || selected;
  const ledger = runtime.store(s => s.ledger);
  const raw = runtime.store(s => s.raw);
  const doc = runtime.store(s => s.doc);
  const state = runtime.store(s => s.ledgerState);
  const view = runtime.store(s => s.rightView);
  const name = host.projects.find(p => p.id === host.currentProjectId)?.name || activeExample.name;
  useEffect(() => {
    const onNotice = (event: Event) => setNotice((event as CustomEvent<string>).detail);
    const save = () => runtime.flush();
    window.addEventListener('showcase-notice', onNotice); window.addEventListener('pagehide', save);
    return () => { window.removeEventListener('showcase-notice', onNotice); window.removeEventListener('pagehide', save); };
  }, []);
  const open = (next: Panel) => { runtime.flush(); setReadBody(false); setPanel(next); };
  const switchView = (next: 'map' | 'doc') => { setPanel(null); runtime.store.getState().setRightView(next); };
  const controls = <div className="demo-workspace-actions"><button onClick={() => open('sources')}>Log · 来源</button><button aria-label={dark ? '切换浅色' : '切换深色'} onClick={() => { setThemePref(dark ? 'light' : 'dark'); setDark(!dark); }}>{dark ? '☀' : '☾'}</button></div>;
  return <>
    <header className="demo-header"><a className="demo-brand" href="./"><span aria-hidden="true">↳</span> GFT Map</a><nav aria-label="选择样例">{examples.map(e => <a key={e.id} href={`demo.html?case=${e.id}`} aria-current={e.id === activeExample.id ? 'page' : undefined}>{e.category}</a>)}</nav><a className="demo-install" href="./#start">在本地使用</a></header>
    <main className="demo-layout">
      <aside className="demo-guide">
        <span className="demo-caption">可编辑的产品示例</span>
        <h1>{activeExample.headline}</h1><p className="demo-situation">{activeExample.situation}</p>
        <div className="demo-steps" aria-label="体验步骤">
          <button aria-pressed={view === 'map' && !panel} onClick={() => switchView('map')}><b>1</b><span>看清已经想到哪儿<small>点节点，查看决定和理由</small></span></button>
          <button aria-pressed={view === 'doc' && !panel} onClick={() => switchView('doc')}><b>2</b><span>把理解改成你的<small>直接编辑主题、正文和判断</small></span></button>
          <button aria-pressed={panel === 'handoff'} onClick={() => open('handoff')}><b>3</b><span>交给下一场聊天<small>预览索引与当前正文</small></span></button>
          <button aria-pressed={panel === 'transfer'} onClick={() => open('transfer')}><b>4</b><span>带到自己的本地面板<small>下载、导入，继续使用</small></span></button>
        </div>
        <p className="demo-tip">{activeExample.editTip}</p>
        <div className="demo-footnote"><p>这里使用本地版同一套图文组件。案例为人工编写的示例，不是真实用户聊天，也不是模型效果评测。</p><p>编辑仅保存在此浏览器标签页；在线示例不连接你的聊天或模型。更新、整理、重画请在本地版使用。</p><button onClick={async () => { if (await confirmDialog({ title: '恢复本例', message: '恢复这份示例的初始内容，放弃本例尚未导出的试改。其他脉络不变。', confirmText: '恢复', danger: true })) { await runtime.reset(activeExample.id); setNotice('已恢复本例。'); } }}>恢复本例</button><a href="https://github.com/CoralLips/gft-map">查看源码</a></div>
      </aside>
      <section className="demo-product" aria-label="GFT Map 可交互面板">
        <div className="demo-window-bar"><div aria-hidden="true"><i/><i/><i/></div><span>GFT Map · {activeExample.category}示例</span><span>浏览器内试用</span></div>
        <ThinkingMapRuntimeProvider store={runtime.store} host={runtime.host}>
          <div className="gft-local-shell"><ThinkingMapWorkspace showLogTab={false} secondaryActions={controls}/></div>
        </ThinkingMapRuntimeProvider>
      </section>
    </main>
    {notice && <div className="demo-toast" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
    {panel === 'sources' && <Modal title="Log · 收到的来源材料" close={() => setPanel(null)}><p>这份示例的原始讨论保留在这里。主题筛选影响 Doc／Map，来源不会随主题改变而删掉。</p><pre>{renderSourceLog(raw) || '尚无来源材料。'}</pre></Modal>}
    {panel === 'handoff' && <Modal title="下一场聊天，能读到什么？" close={() => setPanel(null)}>
      <p>Agent 先取得已连接主题的简短索引，再按当前任务选择正文。这里展示读取内容，不启动模型或代替 Agent 作答。</p>
      <div className="demo-index"><span>主题索引 · 当前版本</span><h3>{name}</h3><p><strong>范围：</strong>{themeOf(state) || '尚未填写'}</p><p><strong>当前主线：</strong>{topicSummary(ledger) || '尚未填写'}</p></div>
      <button className="demo-primary" onClick={() => setReadBody(!readBody)}>{readBody ? '收起正文' : '预览按需读取的正文'}</button>
      {readBody && <pre className="demo-read-result" data-testid="read-result">{doc}</pre>}
      <h3>在本地 Agent 里这样继续</h3><blockquote>使用 gft-map，{activeExample.nextPrompt}</blockquote><p className="demo-small">先把这份脉络包导入本地版，再在那场聊天连接它。右侧更新不会自动唤醒聊天；再次读取时会得到当前内容。</p>
    </Modal>}
    {panel === 'transfer' && <Modal title="把这份上下文带走" close={() => setPanel(null)}>
      <p>导出的是当前版本，包含你刚才的修改，以及主题、Doc、Map 和已接收的 Log。</p>
      <ol><li><button className="demo-primary" onClick={downloadCurrent}>下载当前脉络包 .json</button></li><li>打开本地 GFT Map。在脉络名称的下拉菜单里，选择「导入脉络」。</li><li>选中刚下载的文件。它会成为一份新脉络，原来的内容不会被覆盖。</li><li>在新的聊天中连接这份脉络，让 Agent 按需读取。</li></ol>
      <p>也可以在本页左上角的脉络菜单中重新导入文件，试一次完整来回。</p><p className="demo-small">连接关系、聊天读取进度和账号凭证不随文件迁移。在线文件只在浏览器内读取，不上传服务器。</p><a className="demo-text-link" href="./#start">还没安装？查看本地使用步骤</a>
    </Modal>}
    <ConfirmDialog/>
  </>;
}

initTheme();
await runtime.start();
runtime.store.getState().setRightView(params.get('view') === 'doc' ? 'doc' : 'map');
createRoot(document.getElementById('root')!).render(<App/>);
