import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useThinkingMapHost } from '../../../src/component/focus/ThinkingMapRuntime';
import { localRequest, type ChatConnection, type ChatProvider, type ChatSession, type UpdateSource, type UpdateReceipt, type ReceiptNode, type createLocalRuntime } from './localRuntime';
import { t, useT } from '../../../src/i18n';

type LocalRuntime = ReturnType<typeof createLocalRuntime>;
type Project = { id: string; name: string; status: 'active' | 'archived' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const providerName = (provider: ChatProvider) => provider === 'codex' ? 'Codex' : 'Claude';

export function LocalDialog({ title, children, onClose, wide = false, closeDisabled = false }: { title: string; children: React.ReactNode; onClose(): void; wide?: boolean; closeDisabled?: boolean }) {
  const tr = useT();
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
  }}><div className="gft-local-modal-heading"><h2>{title}</h2><button aria-label={tr('关闭')} disabled={closeDisabled} onClick={onClose}>×</button></div><div className="gft-local-modal-body">{children}</div></div></div>, document.body);
}

export function connectionLoadLabel(connection: ChatConnection, revision: number | null) {
  if (connection.loadedRevision === null) return t('待读取');
  const label = t('聊天最近读取 · 版本 {version}', { version: connection.loadedRevision });
  if (revision === null || connection.loadedRevision >= revision) return label;
  return `${label} · ${t('脉络有更新')}`;
}

export function ConnectionManager({ runtime, topicId, projects, purpose = 'manage', onClose }: {
  runtime: LocalRuntime; topicId: string; projects: Project[]; purpose?: 'manage' | 'update'; onClose(source: UpdateSource): void;
}) {
  const tr = useT();
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
  return <LocalDialog title={tr(purpose === 'update' ? '选择更新来源' : '管理会话连接')} wide closeDisabled={!!busy} onClose={() => { if (!busy) onClose(null); }}>
    <p className="gft-local-note">{projects.find(project => project.id === topicId)?.name || tr('当前脉络')} · {tr('连接不会自动把脉络送进聊天。读取记录表示最近通过 Skill 或 MCP 取回的版本。')}</p>
    {!browse && <>
      {snapshot.status === 'loading' ? <p role="status">{tr('正在读取连接…')}</p> : connections.length === 0 ? <p className="gft-local-note">{tr('这条脉络还没有连接会话。')}</p> : <ul className="gft-local-connections">{connections.map(connection => <li key={connection.id}>
        <div><strong className="gft-local-session-title">{connection.source.title || connection.source.id}</strong><span>{providerName(connection.source.provider)} · {connection.source.cwd || tr('未记录目录')}</span><small>{tr('已连接')} · {connectionLoadLabel(connection, revision)}</small></div>
        {purpose === 'update' ? <button disabled={!!busy} onClick={() => onClose({ connectionId: connection.id })}>{tr('用此会话更新')}</button> : <button disabled={!!busy} onClick={() => { void disconnect(connection.id); }}>{tr('断开')}</button>}
      </li>)}</ul>}
      <div className="gft-local-connection-controls"><button disabled={!!busy} onClick={() => { setBrowse(true); setDisconnectAll(false); }}>{tr('连接另一个会话')}</button>
        {purpose === 'manage' && connections.length > 0 && <button disabled={!!busy} onClick={() => setDisconnectAll(true)}>{tr('断开此脉络的全部连接')}</button>}
      </div>
      {disconnectAll && <div className="gft-local-connection-confirm"><p>{tr('断开此脉络的 {count} 个连接？已保存的脉络内容会保留。', { count: connections.length })}</p><button disabled={!!busy} onClick={() => setDisconnectAll(false)}>{tr('取消')}</button><button disabled={!!busy} onClick={() => { void disconnect(); }}>{tr('确认断开全部')}</button></div>}
    </>}
    {browse && <>
      <div className="gft-local-provider-tabs" aria-label={tr('会话来源')}>{(['codex', 'claude'] as const).map(item => <button key={item} disabled={!!busy} aria-pressed={provider === item} onClick={() => { setProvider(item); setSelected(null); setError(''); }}>{providerName(item)}</button>)}</div>
      <label>{tr('搜索会话')}<input type="search" disabled={!!busy} value={query} placeholder={tr('按标题或目录搜索，不读取聊天正文')} onChange={event => { setQuery(event.target.value); setSelected(null); setError(''); }} /></label>
      <div className="gft-local-session-list" aria-label={tr('会话列表')}>{loading ? <p role="status" className="gft-local-note">{tr('正在查找会话…')}</p> : result.error ? <p role="alert" className="gft-local-error">{tr(result.error)}</p> : !result.sessions.length ? <p className="gft-local-note">{tr('没有找到会话。可切换来源或修改搜索。')}</p> : result.sessions.map(session => <button key={`${session.provider}:${session.id}`} className="gft-local-session" disabled={!!busy} aria-pressed={selected?.id === session.id && selected.provider === session.provider} onClick={() => choose(session)}>
        <strong className="gft-local-session-title">{session.title || session.id}</strong><span>{session.cwd || tr('未记录目录')}</span><small>{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : ''} · {session.id}</small>
      </button>)}</div>
      {!loading && result.nextCursor && <button disabled={loadingMore || !!busy} onClick={() => { void loadMore(); }}>{tr(loadingMore ? '正在读取…' : '更多会话')}</button>}
      {selected && <div className="gft-local-connection-confirm">
        <p><strong className="gft-local-session-title">{tr('将连接：')}{providerName(selected.provider)} · {selected.title || selected.id}</strong></p>
        <fieldset disabled={!!busy}><legend>{tr('连接到哪些脉络')}</legend>{projects.filter(project => project.status !== 'archived').map(project => <label className="gft-local-option" key={project.id}><input type="checkbox" checked={topicIds.includes(project.id)} disabled={purpose === 'update' && project.id === topicId} onChange={event => setTopicIds(ids => event.target.checked ? [...ids, project.id] : ids.filter(id => id !== project.id))} /><span>{project.name}{project.id === topicId ? tr('（当前）') : ''}</span></label>)}</fieldset>
        <fieldset disabled={!!busy}><legend>{tr('收录起点')}</legend><label className="gft-local-option"><input type="radio" name="connection-history" checked={history === 'now'} onChange={() => setHistory('now')} /><span>{tr('从现在开始')} <small>{tr('跳过已结束的历史；当前轮结束后可更新')}</small></span></label><label className="gft-local-option"><input type="radio" name="connection-history" checked={history === 'all'} onChange={() => setHistory('all')} /><span>{tr('包含已有内容')} <small>{tr('已有会话进入 Log，再按主题生成图文；较长时分批处理')}</small></span></label></fieldset>
        {purpose === 'update' && history === 'now' && <p className="gft-local-note">{tr('若当前还没有结束的新一轮对话，确认后会显示暂无新增材料。')}</p>}
      </div>}
    </>}
    {(error || (snapshot.topicId === topicId && snapshot.error)) && <p className="gft-local-error" role="alert">{tr(error || snapshot.error)}</p>}
    {busy && <p role="status">{tr(busy)}</p>}
    <div className="gft-local-dialog-actions">
      {browse && connections.length > 0 && <button disabled={!!busy} onClick={() => { setBrowse(false); setSelected(null); }}>{tr('返回已连接')}</button>}
      <button disabled={!!busy} onClick={() => onClose(null)}>{tr('取消')}</button>
      {browse && <button className="gft-local-primary" disabled={!!busy || !selected || !topicIds.length} onClick={() => { void connect(); }}>{tr(purpose === 'update' ? '确认连接并更新' : '确认连接')}</button>}
    </div>
  </LocalDialog>;
}

// Document anchors belong to the stored mapping, not the reader-facing change text.
export const receiptDisplayText = (text: string) => text.replace(/[ \t]+\^j\d+[ \t]*(?=\r?$)/gm, '');

function ReceiptNodeText({ node }: { node: ReceiptNode }) {
  const tr = useT();
  return <><strong>{node.title}</strong><small>{node.mark} · {node.domain}{node.superseded ? ` · ${tr('历史判断')}` : ''}</small><p>{node.content}</p></>;
}

export function ReceiptDetails({ receipt, runtime, onNavigate }: { receipt: UpdateReceipt; runtime: LocalRuntime; onNavigate(): void }) {
  const tr = useT();
  const state = runtime.store.getState();
  const titleOf = (id: string) => state.nodes.find(node => node.id === id)?.title || receipt.changes.nodes.find(node => node.id === id)?.after?.title || receipt.changes.nodes.find(node => node.id === id)?.before?.title || id;
  const canNavigate = runtime.receipts.rollbackBlocked() === null;
  return <div className="gft-local-receipt-details">
    {receipt.source && <p className="gft-local-receipt-source">{tr('取材于：')}{receipt.source.sessionTitle} · {tr('{count} 条消息', {count:receipt.source.messageCount})}</p>}
    {receipt.changes.name && <p className="gft-local-receipt-source">{tr('名称')}：{receipt.changes.name.before} → {receipt.changes.name.after}</p>}
    {receipt.changes.nodes.map(change => <section key={change.id} className="gft-local-receipt-change">
      <div className="gft-local-receipt-heading"><strong>{tr(change.kind === 'added' ? '新增节点' : change.kind === 'removed' ? '移除节点' : '修改节点')}</strong>{state.nodes.some(node => node.id === change.id) && <button disabled={!canNavigate} onClick={() => { runtime.store.getState().focusOnMap(change.id); onNavigate(); }}>{tr('在 Map 查看')}</button>}</div>
      {change.before && <div className="gft-local-receipt-before"><span>{tr('修改前')}</span><ReceiptNodeText node={change.before}/></div>}
      {change.after && <div className="gft-local-receipt-after"><span>{tr('修改后')}</span><ReceiptNodeText node={change.after}/></div>}
    </section>)}
    {receipt.changes.chapters.map(change => <section key={change.domain} className="gft-local-receipt-change">
      <div className="gft-local-receipt-heading"><strong>{tr('正文')} · {change.domain}</strong><button disabled={!canNavigate} onClick={() => { runtime.store.getState().jumpToDoc(change.domain); onNavigate(); }}>{tr('在 Doc 查看')}</button></div>
      {change.before !== null && <div className="gft-local-receipt-before"><span>{tr('修改前')}</span><p>{receiptDisplayText(change.before) || tr('空')}</p></div>}
      {change.after !== null && <div className="gft-local-receipt-after"><span>{tr('修改后')}</span><p>{receiptDisplayText(change.after) || tr('空')}</p></div>}
    </section>)}
    {(['added','removed'] as const).flatMap(kind => receipt.changes.edges[kind].map((edge,index) => <p className="gft-local-receipt-edge" key={`${kind}-${index}`}>{tr(kind === 'added' ? '新增承接' : '移除承接')}：{titleOf(edge.from)} → {titleOf(edge.to)}</p>))}
    {receipt.changes.edges.modified?.map(edge=><section className="gft-local-receipt-change" key={`${edge.from}:${edge.to}`}><strong>{tr('修改承接说明')}：{titleOf(edge.from)} → {titleOf(edge.to)}</strong><p>{tr('修改前')}：{edge.before || tr('空')}</p><p>{tr('修改后')}：{edge.after || tr('空')}</p></section>)}
    {!receipt.changes.chapters.length && receipt.changes.doc && <section className="gft-local-receipt-change"><strong>{tr('文档变化')}</strong><div className="gft-local-receipt-before"><span>{tr('修改前')}</span><p>{receiptDisplayText(receipt.changes.doc.before)}</p></div><div className="gft-local-receipt-after"><span>{tr('修改后')}</span><p>{receiptDisplayText(receipt.changes.doc.after)}</p></div></section>}
    <p className="gft-local-receipt-source">{tr('撤回只恢复本次操作前的图文；已接收的材料和读取进度保留。')}</p>
  </div>;
}

export function ConnectionActions({ runtime }: { runtime: LocalRuntime }) {
  const tr = useT();
  const topicId = useThinkingMapHost(snapshot => snapshot.currentProjectId);
  const projects = useThinkingMapHost(snapshot => snapshot.projects);
  const snapshot = useSyncExternalStore(runtime.connections.subscribe, runtime.connections.getSnapshot);
  const [dialogTopic, setDialogTopic] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState('');
  const receipts = useSyncExternalStore(runtime.receipts.subscribe, runtime.receipts.getSnapshot);
  useSyncExternalStore(runtime.store.subscribe, runtime.store.getState);
  const service = useSyncExternalStore(runtime.service.subscribe, runtime.service.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const [hiddenReceipt, setHiddenReceipt] = useState<string | null>(null);
  useEffect(() => { setDialogTopic(null); setExpanded(false); setHiddenReceipt(null); }, [topicId]);
  useEffect(() => { setExpanded(false); }, [receipts.receipt?.id]);
  const current = snapshot.topicId === topicId ? snapshot : null;
  const connections = current?.connections ?? [];
  const operation = current?.operation;
  const busy = operation && ['reading', 'running', 'cancelling'].includes(operation.phase);
  const receipt = receipts.topicId === topicId ? receipts.receipt : null;
  const showReceipt = !!receipt && hiddenReceipt !== receipt.id && !busy;
  const blocked = service.phase !== 'connected' ? tr('请等本地服务恢复连接。') : runtime.receipts.rollbackBlocked() || receipt?.rollbackBlockedReason;
  const changes = receipt?.changes;
  const changedNodes = changes?.nodes || [];
  const hasChanges = !!changes && (!!changedNodes.length || !!changes.chapters.length || !!changes.edges.added.length || !!changes.edges.removed.length || !!changes.edges.modified?.length || !!changes.doc || !!changes.name);
  const summary = changes ? [
    changedNodes.length ? tr('节点：新增 {added} · 修改 {modified} · 移除 {removed}', {added:changedNodes.filter(node=>node.kind==='added').length,modified:changedNodes.filter(node=>node.kind==='modified').length,removed:changedNodes.filter(node=>node.kind==='removed').length}) : '',
    changes.chapters.length ? tr('正文 {count} 处', {count:changes.chapters.length}) : '',
    changes.edges.added.length + changes.edges.removed.length ? tr('承接 {count} 处', {count:changes.edges.added.length + changes.edges.removed.length}) : '',
  ].filter(Boolean).join(' · ') || tr(hasChanges ? '图文已修改' : '本次图文没有变化') : '';
  return <>
    <span className="gft-local-connection-chips" role="group" aria-label={tr('已连接的会话，可横向滚动')} tabIndex={0}>
      {connections.map(connection => <span className="gft-local-connection-chip" key={connection.id}>
        <button aria-haspopup="dialog" title={`${providerName(connection.source.provider)} · ${connection.source.title}\n${tr('管理连接')}`} onClick={() => setDialogTopic(topicId)}>
          <span>{providerName(connection.source.provider)} · {connection.source.title}</span>
        </button>
        <button aria-label={`${tr('断开')} ${connection.source.title}`} onClick={() => { setDisconnectError(''); void runtime.connections.disconnect(connection.id).catch(error => setDisconnectError(messageOf(error))); }}>×</button>
      </span>)}
      {receipt && hiddenReceipt === receipt.id && <button className="gft-local-connection-trigger" onClick={() => { setHiddenReceipt(null); setExpanded(true); }}>{tr('上次改动')}</button>}
      {!current?.connections.length && <button className="gft-local-connection-trigger" aria-haspopup="dialog" disabled={!topicId} onClick={() => { if (topicId) { setDialogTopic(topicId); void runtime.connections.refresh(topicId).catch(() => {}); } }}>{tr(current?.status === 'loading' ? '读取连接…' : '＋连接')}</button>}
    </span>
    {disconnectError && <div className="gft-local-banner" role="alert">{tr(disconnectError)}<button aria-label={tr('关闭提示')} onClick={() => setDisconnectError('')}>×</button></div>}
    {(operation || showReceipt || receipts.topicId === topicId && receipts.error) && <div className={`gft-local-update-status gft-local-receipt${expanded && showReceipt ? ' gft-local-receipt-expanded' : ''}`}>
      {operation && <div className={`gft-local-receipt-bar${operation.phase === 'failed' ? ' gft-local-error' : ''}`} role={operation.phase === 'failed' ? 'alert' : 'status'}><span>{tr(operation.message)}</span>{busy ? <button disabled={operation.phase === 'cancelling'} onClick={runtime.connections.cancel}>{tr('取消')}</button> : !showReceipt && operation.phase !== 'choosing' && <button aria-label={tr('关闭更新提示')} onClick={runtime.connections.dismiss}>×</button>}</div>}
      {showReceipt && receipt && <>
        <div className="gft-local-receipt-bar"><span>{tr(receipt.rolledBackAt ? '上次更新已退回' : '上次完成的更新')} · {new Date(receipt.createdAt).toLocaleString()}</span><button disabled={receipts.rollingBack} aria-label={tr('关闭更新提示')} onClick={() => { setHiddenReceipt(receipt.id); setExpanded(false); runtime.connections.dismiss(); }}>×</button></div>
        <div className="gft-local-receipt-bar"><span>{summary}</span><div className="gft-local-receipt-actions">{hasChanges && <button aria-expanded={expanded} onClick={() => setExpanded(value=>!value)}>{tr(expanded ? '收起改动' : '查看改动')}</button>}{!receipt.rolledBackAt && hasChanges && <button disabled={!!blocked || !receipt.canRollback || receipts.rollingBack} title={blocked || tr('恢复本次更新前的图文，保留已接收的材料。')} onClick={() => { void runtime.receipts.rollback(); }}>{tr(receipts.rollingBack ? '正在退回…' : '退回本次更新')}</button>}</div></div>
        {expanded && <><ReceiptDetails receipt={receipt} runtime={runtime} onNavigate={() => setExpanded(false)}/>{blocked && !receipt.rolledBackAt && <p className="gft-local-receipt-source">{tr(blocked)}</p>}</>}
      </>}
      {receipts.topicId === topicId && receipts.error && <p className="gft-local-error" role="alert">{tr(receipts.error)} <button onClick={() => { void runtime.receipts.refresh(); }}>{tr('重新读取改动')}</button></p>}
    </div>}
    {dialogTopic && dialogTopic === topicId && <ConnectionManager key={dialogTopic} runtime={runtime} topicId={dialogTopic} projects={projects} onClose={() => setDialogTopic(null)} />}
  </>;
}
