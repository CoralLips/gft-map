import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmDialog } from '../../../src/component/common/ConfirmDialog';
import { ThinkingMapWorkspace } from '../../../src/component/focus/ThinkingMapWorkspace';
import { ThinkingMapRuntimeProvider, useThinkingMapHost } from '../../../src/component/focus/ThinkingMapRuntime';
import { SourceLogEditor, type SourceLogEditorHandle } from '../../../src/component/focus/SourceLogEditor';
import { useLangStore, useT } from '../../../src/i18n';
import { initTheme, getThemePref, setThemePref, type ThemePref } from '../../../src/util/theme';
import { ImportDialog } from './ImportDialog';
import {Materials,addMaterial} from './Materials';
import { AccountDialog } from './AccountDialog';
import { createLocalRuntime, type UpdateSource } from './localRuntime';
import { ConnectionActions, ConnectionManager, LocalDialog as Modal } from './ConnectionManager';
import { ExportMenu } from '../../../src/component/focus/MapDocActions';
import '../../../src/style/index.css';
import './styles.css';

type LocalRuntime = ReturnType<typeof createLocalRuntime>;
type Task = { id: string; topicId: string; action: string; status: string; mode?: string; error?: string; createdAt?: string };
type RuntimeStatus = { agent: string | null; mode?: string; executor?: { status: string; model?: string; effort?: string; lastError?: string | { message: string } } };
type UpdateRequest = { resolve: (input: string | null) => void };
type SourceRequest = { topicId: string; resolve: (source: UpdateSource) => void };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const actionNames: Record<string, string> = { update: '更新', tidy: '整理', redraw: '重画', refine: '润色', theme: '推荐主题', compact: '提炼历史' };
const statusNames: Record<string, string> = { pending: '等待 Agent', queued: '等待 Agent', running: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const isActive = (task: Task) => task.status === 'pending' || task.status === 'queued' || task.status === 'running';
const executorReady = (value: RuntimeStatus | null) => value?.mode === 'automatic' && ['ready', 'running'].includes(value.executor?.status || '');
const Workspace = memo(ThinkingMapWorkspace);

function HistoryDialog({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const editor = useRef<SourceLogEditorHandle>(null);
  return <Modal title="Log" wide onClose={() => { if (editor.current?.save()) onClose(); }}>
    <Materials key={projectId} topicId={projectId}/>
    <SourceLogEditor ref={editor} projectId={projectId} />
  </Modal>;
}

// Polling stays outside the shared Doc and canvas to preserve editor selections.
const LocalActions = memo(function LocalActions({ runtime }: { runtime: LocalRuntime }) {
  const tr = useT();
  const lang = useLangStore(s => s.lang);
  const setLang = useLangStore(s => s.setLang);
  const projectId = useThinkingMapHost(snapshot => snapshot.currentProjectId);
  const projects = useThinkingMapHost(snapshot => snapshot.projects);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [dialog, setDialog] = useState<'tasks' | 'history' | 'import' | 'account' | null>(null);
  const [error, setError] = useState('');
  const service = useSyncExternalStore(runtime.service.subscribe, runtime.service.getSnapshot);
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [executorError, setExecutorError] = useState('');
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (service.phase !== 'connected') return;
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const [nextTasks, nextStatus] = await Promise.all([
          runtime.request<Task[]>('/api/tasks', undefined, controller.signal),
          runtime.request<RuntimeStatus>('/api/runtime', undefined, controller.signal),
        ]);
        if (!controller.signal.aborted) { setTasks(nextTasks); setStatus(nextStatus); }
      } catch { /* The shared connection status owns background failures. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 2500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [runtime, service.phase]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const open = (value: typeof dialog) => { setError(''); setDialog(value); if (menuRef.current) menuRef.current.open = false; };
  const active = tasks.filter(isActive).length;
  const cancel = async (task: Task) => {
    setCancelling(task.id);
    try {
      await runtime.request(`/api/tasks/${task.id}/cancel`, {});
      setTasks(current => current.map(item => item.id === task.id ? { ...item, status: 'cancelled' } : item));
    } catch (error) { setError(messageOf(error)); }
    finally { setCancelling(null); }
  };
  const connectExecutor = async () => {
    if (connecting) return;
    setConnecting(true); setExecutorError('');
    try {
      const next = await runtime.request<RuntimeStatus>('/api/runtime/executor', { agent: status?.agent || 'codex' });
      setStatus(next);
    } catch (error) {
      setExecutorError(messageOf(error));
      try { setStatus(await runtime.request<RuntimeStatus>('/api/runtime')); } catch { /* polling will retry */ }
    } finally { setConnecting(false); }
  };
  const executorUnavailable = status !== null && !executorReady(status);
  return <>
    <Materials key={projectId||'none'} topicId={projectId} hideWhenEmpty />
    <span className="gft-local-transfer-actions" aria-label={tr('导入与导出')}>
      <button className="gft-local-transfer-button" onClick={() => open('import')} title={tr('从文件或粘贴内容导入脉络')}>
        <span aria-hidden="true">↑</span>{tr('导入')}
      </button>
      <ExportMenu className="gft-local-transfer-button" icon="↓" disableWhenUnavailable />
    </span>
    {executorUnavailable && <button className="gft-local-executor-trigger" onClick={() => open('tasks')} title={tr('连接本机 Agent 后才能执行页面任务')}>
      {connecting ? tr('正在连接…') : status?.agent ? tr('重试连接') : tr('启用 Codex')}
    </button>}
    <details className="gft-local-menu" ref={menuRef}>
      <summary aria-label={tr('设置')} title={tr('设置')} onKeyDown={event=>{if(event.key==='Escape' && menuRef.current) menuRef.current.open=false;}}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9.5 3-.5 2a8 8 0 0 0-2 1.2L5 5.6 3 9l1.5 1.4a8 8 0 0 0 0 2.4L3 14.2l2 3.4 2-.6a8 8 0 0 0 2 1.2l.5 2h4l.5-2a8 8 0 0 0 2-1.2l2 .6 2-3.4-1.5-1.4a8 8 0 0 0 0-2.4L20 9l-2-3.4-2 .6a8 8 0 0 0-2-1.2l-.5-2Z"/><circle cx="11.5" cy="11.6" r="3.1"/></svg>
        {active>0 && <span className="gft-local-task-count">{active}</span>}
      </summary>
      <div className="gft-local-menu-items" onKeyDown={event=>{if(event.key==='Escape' && menuRef.current) {menuRef.current.open=false;menuRef.current.querySelector('summary')?.focus();}}}>
        <div className="gft-local-appearance"><span>{tr('语言')}</span><div role="group" aria-label={tr('语言')}>{([['zh','中文'],['en','EN']] as const).map(([value,label])=><button key={value} aria-pressed={lang===value} onClick={()=>setLang(value)}>{label}</button>)}</div></div>
        <div className="gft-local-appearance"><span>{tr('外观')}</span><div role="group" aria-label={tr('外观')}>{([['light','浅色'],['dark','深色'],['system','跟随系统']] as const).map(([value,label])=><button key={value} aria-pressed={theme===value} onClick={()=>{setTheme(value);setThemePref(value);}}>{tr(label)}</button>)}</div></div>
        <button onClick={() => open('tasks')}>{tr('任务')}{active > 0 ? ` · ${active} ${tr('处理中')}` : ''}</button>
        <button disabled={!projectId} onClick={() => open('history')}>Log</button>
        <button onClick={() => open('account')}>{tr('GFT 账号')}</button>
      </div>
    </details>
    {dialog === 'import' && <ImportDialog importTopic={runtime.importTopic} importMaterial={async file=>{
      let target=runtime.host.getSnapshot().currentProjectId;
      if(!target&&!file.name.toLowerCase().endsWith('.gftpack'))target=await runtime.host.createProject(file.name.replace(/\.[^.]+$/,''));
      const result=await addMaterial(file,target||'');
      await runtime.refreshProjects();await runtime.host.switchProject(result.topicId);
    }} onClose={()=>setDialog(null)} />}
    {dialog === 'account' && <AccountDialog onClose={() => setDialog(null)} />}
    {error && !dialog && <div className="gft-local-banner" role="alert">{tr(error)}<button aria-label={tr('关闭提示')} onClick={() => setError('')}>×</button></div>}
    {dialog === 'history' && projectId && <HistoryDialog key={projectId} projectId={projectId} onClose={() => setDialog(null)} />}
    {dialog === 'tasks' && <Modal title={tr('任务')} wide onClose={() => setDialog(null)}>
      <p className="gft-local-note">{!status ? tr('正在读取执行状态…') : status.agent ? tr('当前由本机 {agent} 处理页面任务。', {agent:status.agent}) : tr('未启用自动 Agent。排队任务需由当前 Agent 对话通过 Skill 读取并处理。')}</p>
      {error && <p role="alert" className="gft-local-error">{tr(error)}</p>}
      {status?.executor?.model && <p className="gft-local-note">{tr('执行模型：{model} · 思考强度：{effort}（自动）', {model:status.executor.model, effort:status.executor.effort || tr('执行器默认')})}</p>}
      {status?.executor?.lastError && <p className="gft-local-error">{typeof status.executor.lastError === 'string' ? status.executor.lastError : status.executor.lastError.message}</p>}
      {!executorReady(status) && <div className="gft-local-executor-recovery">
        <p className="gft-local-note">{tr(status?.agent ? '页面 Agent 当前不可用，可以重新检查连接。' : '页面任务需要本机 Agent；连接 Codex 后，当前脉络和已保存材料不会改变。')}</p>
        {executorError && <p role="alert" className="gft-local-error">{tr(executorError)}</p>}
        <button className="gft-local-primary" disabled={connecting} onClick={() => { void connectExecutor(); }}>{connecting ? tr('正在连接…') : status?.agent ? tr('重新检查') : tr('连接 Codex')}</button>
      </div>}
      {tasks.length === 0 ? <p className="gft-local-note">{tr('还没有任务。')}</p> : <ul className="gft-local-tasks">{tasks.map(task => <li key={task.id}>
        <div><strong>{tr(actionNames[task.action] || task.action)}</strong><span>{projects.find(project => project.id === task.topicId)?.name || tr('已归档脉络')}</span>{task.error && <p className="gft-local-error">{tr(task.error)}</p>}</div>
        <span>{tr(cancelling === task.id ? '正在取消…' : task.mode === 'compute' && task.status === 'completed' ? '模型已返回' : statusNames[task.status] || task.status)}</span>
        {isActive(task) && <button disabled={cancelling === task.id} onClick={() => { void cancel(task); }}>{tr('取消')}</button>}
      </li>)}</ul>}
    </Modal>}
  </>;
});

function App() {
  const tr = useT();
  const lang = useLangStore(s => s.lang);
  useEffect(() => { document.title = lang === 'en' ? 'GFT Map · Local' : 'GFT Map · 本地脉络'; }, [lang]);
  const [error, setError] = useState('');
  const [updateRequest, setUpdateRequest] = useState<UpdateRequest | null>(null);
  const [sourceRequest, setSourceRequest] = useState<SourceRequest | null>(null);
  const [updateDraft, setUpdateDraft] = useState('');
  const [runtime] = useState(() => createLocalRuntime({
    onRequestUpdate: () => new Promise(resolve => setUpdateRequest({ resolve })),
    onRequestSource: topicId => new Promise(resolve => setSourceRequest({ topicId, resolve })),
    onError: setError,
  }));
  const service = useSyncExternalStore(runtime.service.subscribe, runtime.service.getSnapshot);
  const ready = service.hasConnected;
  const [saving, setSaving] = useState(false);
  const [actions] = useState(() => <LocalActions runtime={runtime} />);
  const [memoryControl] = useState(() => <ConnectionActions runtime={runtime} />);
  useEffect(() => {
    let selectedId = runtime.host.getSnapshot().currentProjectId;
    return runtime.host.subscribe(() => {
      const id = runtime.host.getSnapshot().currentProjectId;
      if (id !== selectedId) {
        selectedId = id;
        setSourceRequest(current => { current?.resolve(null); return null; });
        setUpdateRequest(current => { current?.resolve(null); return null; });
      }
    });
  }, [runtime]);
  useEffect(() => {
    void runtime.start();
    const flush = () => { runtime.store.getState().flushDocEdits(); runtime.store.getState().flushDoc(); };
    const dispose = () => runtime.dispose();
    // A cancelled navigation must leave the live runtime intact.
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', dispose);
    return () => { window.removeEventListener('beforeunload', flush); window.removeEventListener('pagehide', dispose); runtime.dispose(); };
  }, [runtime]);
  const closeUpdate = (input: string | null) => { updateRequest?.resolve(input); setUpdateRequest(null); };
  return <ThinkingMapRuntimeProvider store={runtime.store} host={runtime.host} memoryControl={memoryControl}>
    <main className="gft-local-shell">{ready ? <Workspace showLogTab={false} showExport={false} secondaryActions={actions} /> : <div className="gft-local-loading" role="status">{tr(service.phase === 'disconnected' ? '暂时无法连接本地服务，正在自动重试…' : '正在打开本地脉络…')}{service.phase === 'disconnected' && <button disabled={service.checking} onClick={() => { void runtime.service.retry(); }}>{tr(service.checking ? '正在重连…' : '立即重试')}</button>}</div>}</main>
    {ready && service.phase !== 'connected' && <div className="gft-local-service-status" role="status"><span>{tr('连接已中断，当前内容和未保存修改已保留。正在自动重连…')}</span><button disabled={service.checking} onClick={() => { void runtime.service.retry(); }}>{tr(service.checking ? '正在重连…' : '立即重试')}</button></div>}
    {ready && service.phase === 'connected' && service.pending && service.saveFailed && <div className="gft-local-service-status" role="status"><span>{tr('连接正常，尚有本地修改未保存。')}</span><button disabled={saving} onClick={() => {
      setSaving(true);
      void runtime.service.savePending().catch(error => setError(messageOf(error))).finally(() => setSaving(false));
    }}>{tr(saving ? '正在保存…' : '重试保存')}</button></div>}
    {ready && error && <div className="gft-local-banner" role="alert">{tr(error)}<button aria-label={tr('关闭提示')} onClick={() => setError('')}>×</button></div>}
    {sourceRequest && sourceRequest.topicId === runtime.host.getSnapshot().currentProjectId && <ConnectionManager key={sourceRequest.topicId} runtime={runtime} topicId={sourceRequest.topicId} projects={runtime.host.getSnapshot().projects} purpose="update" onClose={source => { sourceRequest.resolve(source); setSourceRequest(null); }} />}
    {updateRequest && <Modal title={tr('更新脉络')} wide onClose={() => closeUpdate(null)}><form onSubmit={event => { event.preventDefault(); if (updateDraft.trim()) closeUpdate(updateDraft.trim()); }}>
      <p className="gft-local-note">{tr('粘贴当前对话或要收录的材料。Agent 将按这条脉络的主题范围提取判断。')}</p>
      <label>{tr('材料')}<textarea autoFocus rows={12} required value={updateDraft} onChange={event => setUpdateDraft(event.target.value)} placeholder={tr('把要记下来的对话或材料放在这里…')} /></label>
      <div className="gft-local-dialog-actions"><button type="button" onClick={() => closeUpdate(null)}>{tr('取消')}</button><button className="gft-local-primary" disabled={!updateDraft.trim()}>{tr('交给 Agent')}</button></div>
    </form></Modal>}
    <ConfirmDialog />
  </ThinkingMapRuntimeProvider>;
}

initTheme();
createRoot(document.getElementById('root')!).render(<App />);
