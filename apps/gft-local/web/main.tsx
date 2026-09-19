import { memo, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmDialog } from '../../../src/component/common/ConfirmDialog';
import { ThinkingMapWorkspace } from '../../../src/component/focus/ThinkingMapWorkspace';
import { ThinkingMapRuntimeProvider, useThinkingMapHost } from '../../../src/component/focus/ThinkingMapRuntime';
import { SourceLogEditor, type SourceLogEditorHandle } from '../../../src/component/focus/SourceLogEditor';
import { useLangStore, useT } from '../../../src/i18n';
import { initTheme, getThemePref, setThemePref, type ThemePref } from '../../../src/util/theme';
import { ImportDialog } from './ImportDialog';
import { AccountDialog } from './AccountDialog';
import { createLocalRuntime, localRequest, type UpdateSource } from './localRuntime';
import { ConnectionActions, ConnectionManager, LocalDialog as Modal } from './ConnectionManager';
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
const Workspace = memo(ThinkingMapWorkspace);

function HistoryDialog({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const editor = useRef<SourceLogEditorHandle>(null);
  return <Modal title="Log" wide onClose={() => { if (editor.current?.save()) onClose(); }}>
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
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const [nextTasks, nextStatus] = await Promise.all([
          localRequest<Task[]>('/api/tasks', undefined, controller.signal),
          localRequest<RuntimeStatus>('/api/runtime', undefined, controller.signal),
        ]);
        if (!controller.signal.aborted) { setTasks(nextTasks); setStatus(nextStatus); }
      } catch (error) { if (!controller.signal.aborted) setError(messageOf(error)); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 2500);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
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
      await localRequest(`/api/tasks/${task.id}/cancel`, {});
      setTasks(current => current.map(item => item.id === task.id ? { ...item, status: 'cancelled' } : item));
    } catch (error) { setError(messageOf(error)); }
    finally { setCancelling(null); }
  };
  return <>
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
        <button onClick={() => open('import')}>{tr('导入脉络')}</button>
        <button onClick={() => open('account')}>{tr('GFT 账号')}</button>
      </div>
    </details>
    {dialog === 'import' && <ImportDialog importTopic={runtime.importTopic} onClose={()=>setDialog(null)} />}
    {dialog === 'account' && <AccountDialog onClose={() => setDialog(null)} />}
    {error && !dialog && <div className="gft-local-banner" role="alert">{tr(error)}<button aria-label={tr('关闭提示')} onClick={() => setError('')}>×</button></div>}
    {dialog === 'history' && projectId && <HistoryDialog key={projectId} projectId={projectId} onClose={() => setDialog(null)} />}
    {dialog === 'tasks' && <Modal title={tr('任务')} wide onClose={() => setDialog(null)}>
      <p className="gft-local-note">{!status ? tr('正在读取执行状态…') : status.agent ? tr('当前由本机 {agent} 处理页面任务。', {agent:status.agent}) : tr('未启用自动 Agent。排队任务需由当前 Agent 对话通过 Skill 读取并处理。')}</p>
      {error && <p role="alert" className="gft-local-error">{tr(error)}</p>}
      {status?.executor?.model && <p className="gft-local-note">{tr('执行模型：{model} · 思考强度：{effort}（自动）', {model:status.executor.model, effort:status.executor.effort || tr('执行器默认')})}</p>}
      {status?.executor?.lastError && <p className="gft-local-error">{typeof status.executor.lastError === 'string' ? status.executor.lastError : status.executor.lastError.message}</p>}
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
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [updateRequest, setUpdateRequest] = useState<UpdateRequest | null>(null);
  const [sourceRequest, setSourceRequest] = useState<SourceRequest | null>(null);
  const [updateDraft, setUpdateDraft] = useState('');
  const [runtime] = useState(() => createLocalRuntime({
    onRequestUpdate: () => new Promise(resolve => setUpdateRequest({ resolve })),
    onRequestSource: topicId => new Promise(resolve => setSourceRequest({ topicId, resolve })),
    onError: setError,
  }));
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
    let alive = true;
    void runtime.start().then(() => { if (alive) setReady(true); }).catch(error => { if (alive) setError(messageOf(error)); });
    const flush = () => { runtime.store.getState().flushDocEdits(); runtime.store.getState().flushDoc(); };
    const dispose = () => runtime.dispose();
    // A cancelled navigation must leave the live runtime intact.
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', dispose);
    return () => { alive = false; window.removeEventListener('beforeunload', flush); window.removeEventListener('pagehide', dispose); runtime.dispose(); };
  }, [runtime]);
  const closeUpdate = (input: string | null) => { updateRequest?.resolve(input); setUpdateRequest(null); };
  return <ThinkingMapRuntimeProvider store={runtime.store} host={runtime.host} memoryControl={memoryControl}>
    <main className="gft-local-shell">{ready ? <Workspace showLogTab={false} secondaryActions={actions} /> : <div className="gft-local-loading">{tr(error || '正在打开本地脉络…')}{error && <button onClick={() => window.location.reload()}>{tr('重新打开')}</button>}</div>}</main>
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
