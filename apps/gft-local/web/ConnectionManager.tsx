import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useThinkingMapHost } from '../../../src/component/focus/ThinkingMapRuntime';
import { localRequest, type ChatConnection, type ChatProvider, type ChatSession, type UpdateSource, type createLocalRuntime } from './localRuntime';

type LocalRuntime = ReturnType<typeof createLocalRuntime>;
type Project = { id: string; name: string; status: 'active' | 'archived' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const providerName = (provider: ChatProvider) => provider === 'codex' ? 'Codex' : 'Claude';

export function LocalDialog({ title, children, onClose, wide = false, closeDisabled = false }: { title: string; children: React.ReactNode; onClose(): void; wide?: boolean; closeDisabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="gft-local-shade"><div className={`gft-local-modal${wide ? ' gft-local-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!closeDisabled) onClose(); }
    if (event.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary') || [])];
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div className="gft-local-modal-heading"><h2>{title}</h2><button aria-label="关闭" disabled={closeDisabled} onClick={onClose}>×</button></div><div className="gft-local-modal-body">{children}</div></div></div>, document.body);
}

export function connectionLoadLabel(connection: ChatConnection, revision: number | null) {
  if (connection.loadedRevision === null) return '待读取';
  if (revision === null || connection.loadedRevision >= revision) return `聊天最近读取 · 版本 ${connection.loadedRevision}`;
  return `聊天最近读取 · 版本 ${connection.loadedRevision} · 脉络有更新`;
}

export function ConnectionManager({ runtime, topicId, projects, purpose = 'manage', onClose }: {
  runtime: LocalRuntime; topicId: string; projects: Project[]; purpose?: 'manage' | 'update'; onClose(source: UpdateSource): void;
}) {
  const snapshot = useSyncExternalStore(runtime.connections.subscribe, runtime.connections.getSnapshot);
  const connections = snapshot.topicId === topicId ? snapshot.connections : [];
  const revision = snapshot.topicId === topicId ? snapshot.revision : null;
  const [browse, setBrowse] = useState(purpose === 'update' && connections.length === 0);
  const [provider, setProvider] = useState<ChatProvider>('codex');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ChatSession | null>(null);
  const [topicIds, setTopicIds] = useState([topicId]);
  const [history, setHistory] = useState<'now' | 'all'>('now');
  const [result, setResult] = useState<{ key: string; sessions: ChatSession[]; nextCursor: string | null; error: string }>({ key: '', sessions: [], nextCursor: null, error: '' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [disconnectAll, setDisconnectAll] = useState(false);
  const queryKey = `${provider}:${query.trim()}`;
  const currentKey = useRef(queryKey); currentKey.current = queryKey;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (!browse) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void localRequest<{ sessions: ChatSession[]; nextCursor: string | null }>(`/api/chat-sessions?provider=${provider}&query=${encodeURIComponent(query.trim())}`, undefined, controller.signal)
        .then(page => { if (!controller.signal.aborted) setResult({ ...page, key: queryKey, error: '' }); })
        .catch(error => { if (!controller.signal.aborted) setResult({ key: queryKey, sessions: [], nextCursor: null, error: messageOf(error) }); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [browse, provider, query, queryKey]);
  const loading = result.key !== queryKey;
  const choose = (session: ChatSession) => { setSelected(session); setError(''); };
  const loadMore = async () => {
    if (!result.nextCursor || loadingMore) return;
    const key = queryKey;
    setLoadingMore(true);
    try {
      const page = await localRequest<{ sessions: ChatSession[]; nextCursor: string | null }>(`/api/chat-sessions?provider=${provider}&query=${encodeURIComponent(query.trim())}&cursor=${encodeURIComponent(result.nextCursor)}`);
      if (alive.current && currentKey.current === key) setResult(current => ({ ...current, sessions: [...current.sessions, ...page.sessions.filter(item => !current.sessions.some(old => old.id === item.id && old.provider === item.provider))], nextCursor: page.nextCursor }));
    } catch (error) { if (alive.current && currentKey.current === key) setError(messageOf(error)); }
    finally { if (alive.current) setLoadingMore(false); }
  };
  const connect = async () => {
    if (!selected || !topicIds.length || busy) return;
    setBusy('正在连接…'); setError('');
    try {
      const created = await runtime.connections.connect(selected, topicIds, history);
      if (!alive.current) return;
      if (purpose === 'update') {
        const connection = created.find(item => item.topicId === topicId);
        if (!connection) throw new Error('连接未返回当前脉络，请重新读取连接。');
        onClose({ connectionId: connection.id });
      } else { setSelected(null); setBrowse(false); }
    } catch (error) { if (alive.current) setError(messageOf(error)); }
    finally { if (alive.current) setBusy(''); }
  };
  const disconnect = async (id?: string) => {
    if (busy) return;
    setBusy(id ? '正在断开连接…' : '正在断开全部连接…'); setError('');
    try { if (id) await runtime.connections.disconnect(id); else await runtime.connections.disconnectAll(topicId); setDisconnectAll(false); }
    catch (error) { if (alive.current) setError(messageOf(error)); }
    finally { if (alive.current) setBusy(''); }
  };
  return <LocalDialog title={purpose === 'update' ? '选择更新来源' : '管理会话连接'} wide closeDisabled={!!busy} onClose={() => { if (!busy) onClose(null); }}>
    <p className="gft-local-note">{projects.find(project => project.id === topicId)?.name || '当前脉络'} · 连接不会自动把脉络送进聊天。读取记录表示最近通过 Skill 或 MCP 取回的版本。</p>
    {!browse && <>
      {snapshot.status === 'loading' ? <p role="status">正在读取连接…</p> : connections.length === 0 ? <p className="gft-local-note">这条脉络还没有连接会话。</p> : <ul className="gft-local-connections">{connections.map(connection => <li key={connection.id}>
        <div><strong className="gft-local-session-title">{connection.source.title || connection.source.id}</strong><span>{providerName(connection.source.provider)} · {connection.source.cwd || '未记录目录'}</span><small>已连接 · {connectionLoadLabel(connection, revision)}</small></div>
        {purpose === 'update' ? <button disabled={!!busy} onClick={() => onClose({ connectionId: connection.id })}>用此会话更新</button> : <button disabled={!!busy} onClick={() => { void disconnect(connection.id); }}>断开</button>}
      </li>)}</ul>}
      <div className="gft-local-connection-controls"><button disabled={!!busy} onClick={() => { setBrowse(true); setDisconnectAll(false); }}>连接另一个会话</button>
        {purpose === 'manage' && connections.length > 0 && <button disabled={!!busy} onClick={() => setDisconnectAll(true)}>断开此脉络的全部连接</button>}
      </div>
      {disconnectAll && <div className="gft-local-connection-confirm"><p>断开此脉络的 {connections.length} 个连接？已保存的脉络内容会保留。</p><button disabled={!!busy} onClick={() => setDisconnectAll(false)}>取消</button><button disabled={!!busy} onClick={() => { void disconnect(); }}>确认断开全部</button></div>}
    </>}
    {browse && <>
      <div className="gft-local-provider-tabs" aria-label="会话来源">{(['codex', 'claude'] as const).map(item => <button key={item} disabled={!!busy} aria-pressed={provider === item} onClick={() => { setProvider(item); setSelected(null); setError(''); }}>{providerName(item)}</button>)}</div>
      <label>搜索会话<input type="search" disabled={!!busy} value={query} placeholder="按标题或目录搜索，不读取聊天正文" onChange={event => { setQuery(event.target.value); setSelected(null); setError(''); }} /></label>
      <div className="gft-local-session-list" aria-label="会话列表">{loading ? <p role="status" className="gft-local-note">正在查找会话…</p> : result.error ? <p role="alert" className="gft-local-error">{result.error}</p> : !result.sessions.length ? <p className="gft-local-note">没有找到会话。可切换来源或修改搜索。</p> : result.sessions.map(session => <button key={`${session.provider}:${session.id}`} className="gft-local-session" disabled={!!busy} aria-pressed={selected?.id === session.id && selected.provider === session.provider} onClick={() => choose(session)}>
        <strong className="gft-local-session-title">{session.title || session.id}</strong><span>{session.cwd || '未记录目录'}</span><small>{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : ''} · {session.id}</small>
      </button>)}</div>
      {!loading && result.nextCursor && <button disabled={loadingMore || !!busy} onClick={() => { void loadMore(); }}>{loadingMore ? '正在读取…' : '更多会话'}</button>}
      {selected && <div className="gft-local-connection-confirm">
        <p><strong className="gft-local-session-title">将连接：{providerName(selected.provider)} · {selected.title || selected.id}</strong></p>
        <fieldset disabled={!!busy}><legend>连接到哪些脉络</legend>{projects.filter(project => project.status !== 'archived').map(project => <label className="gft-local-option" key={project.id}><input type="checkbox" checked={topicIds.includes(project.id)} disabled={purpose === 'update' && project.id === topicId} onChange={event => setTopicIds(ids => event.target.checked ? [...ids, project.id] : ids.filter(id => id !== project.id))} /><span>{project.name}{project.id === topicId ? '（当前）' : ''}</span></label>)}</fieldset>
        <fieldset disabled={!!busy}><legend>收录起点</legend><label className="gft-local-option"><input type="radio" name="connection-history" checked={history === 'now'} onChange={() => setHistory('now')} /><span>从现在开始 <small>跳过已结束的历史；当前轮结束后可更新</small></span></label><label className="gft-local-option"><input type="radio" name="connection-history" checked={history === 'all'} onChange={() => setHistory('all')} /><span>包含已有内容 <small>按脉络主题筛选已有会话；较长时分批更新</small></span></label></fieldset>
        {purpose === 'update' && history === 'now' && <p className="gft-local-note">若当前还没有结束的新一轮对话，确认后会显示暂无新增材料。</p>}
      </div>}
    </>}
    {(error || (snapshot.topicId === topicId && snapshot.error)) && <p className="gft-local-error" role="alert">{error || snapshot.error}</p>}
    {busy && <p role="status">{busy}</p>}
    <div className="gft-local-dialog-actions">
      {browse && connections.length > 0 && <button disabled={!!busy} onClick={() => { setBrowse(false); setSelected(null); }}>返回已连接</button>}
      <button disabled={!!busy} onClick={() => onClose(null)}>取消</button>
      {browse && <button className="gft-local-primary" disabled={!!busy || !selected || !topicIds.length} onClick={() => { void connect(); }}>{purpose === 'update' ? '确认连接并更新' : '确认连接'}</button>}
    </div>
  </LocalDialog>;
}

export function ConnectionActions({ runtime }: { runtime: LocalRuntime }) {
  const topicId = useThinkingMapHost(snapshot => snapshot.currentProjectId);
  const projects = useThinkingMapHost(snapshot => snapshot.projects);
  const snapshot = useSyncExternalStore(runtime.connections.subscribe, runtime.connections.getSnapshot);
  const [dialogTopic, setDialogTopic] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState('');
  useEffect(() => { setDialogTopic(null); }, [topicId]);
  const current = snapshot.topicId === topicId ? snapshot : null;
  const connections = current?.connections ?? [];
  const operation = current?.operation;
  const busy = operation && ['reading', 'running', 'cancelling'].includes(operation.phase);
  return <>
    <span className="gft-local-connection-chips" role="group" aria-label="已连接的会话，可横向滚动" tabIndex={0}>
      {connections.map(connection => <span className="gft-local-connection-chip" key={connection.id}>
        <button aria-haspopup="dialog" title={`${providerName(connection.source.provider)} · ${connection.source.title}\n管理连接`} onClick={() => setDialogTopic(topicId)}>
          <span>{providerName(connection.source.provider)} · {connection.source.title}</span>
        </button>
        <button aria-label={`断开 ${connection.source.title}`} onClick={() => { setDisconnectError(''); void runtime.connections.disconnect(connection.id).catch(error => setDisconnectError(messageOf(error))); }}>×</button>
      </span>)}
      {!current?.connections.length && <button className="gft-local-connection-trigger" aria-haspopup="dialog" disabled={!topicId} onClick={() => { if (topicId) { setDialogTopic(topicId); void runtime.connections.refresh(topicId).catch(() => {}); } }}>{current?.status === 'loading' ? '读取连接…' : '＋连接'}</button>}
    </span>
    {disconnectError && <div className="gft-local-banner" role="alert">{disconnectError}<button aria-label="关闭提示" onClick={() => setDisconnectError('')}>×</button></div>}
    {operation && <div className={`gft-local-update-status${operation.phase === 'failed' ? ' gft-local-error' : ''}`} role={operation.phase === 'failed' ? 'alert' : 'status'}><span>{operation.message}</span>{busy ? <button disabled={operation.phase === 'cancelling'} onClick={runtime.connections.cancel}>取消</button> : operation.phase !== 'choosing' && <button aria-label="关闭更新提示" onClick={runtime.connections.dismiss}>×</button>}</div>}
    {dialogTopic && dialogTopic === topicId && <ConnectionManager key={dialogTopic} runtime={runtime} topicId={dialogTopic} projects={projects} onClose={() => setDialogTopic(null)} />}
  </>;
}
