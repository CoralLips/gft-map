import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { editSourceLog, mergeSourceLogs, renderSourceLog } from '../../service/sourceLog';
import { copyToClipboard } from '../../util/clipboard';
import { useT } from '../../i18n';
import { useThinkingMapRuntime } from './ThinkingMapRuntime';
import { confirmDialog } from '../common/ConfirmDialog';
import './SourceLogEditor.css';

export interface SourceLogEditorHandle { save(): boolean }

/** The visible text is editable; source identities stay in raw for incremental deduplication. */
export const SourceLogEditor = forwardRef<SourceLogEditorHandle, { projectId: string }>(function SourceLogEditor({ projectId }, ref) {
  const { store } = useThinkingMapRuntime();
  const raw = store(s => s.raw);
  const hydrating = store(s => s.isHydrating);
  const persistenceError = store(s => s.error);
  const tr = useT();
  const [draft, setDraft] = useState(() => renderSourceLog(raw));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef({ base: raw, text: draft, dirty: false });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    // A background refresh must never replace an unfinished draft.
    if (!current.current.dirty) {
      const text = renderSourceLog(raw);
      current.current = { base: raw, text, dirty: false };
      setDraft(text);
    }
  }, [raw, dirty]);
  const save = useCallback(() => {
    const state = store.getState();
    if (state.boundProjectId !== projectId || state.isHydrating) return false;
    if (!current.current.dirty) {
      // Retry a failed file save from the still-preserved local copy.
      if (state.error) state.updateRaw(state.raw);
      state.flushDoc(); return true;
    }
    try {
      const edited = editSourceLog(current.current.base, current.current.text);
      const next = mergeSourceLogs(edited, state.raw);
      state.updateRaw(next);
      store.setState({sourceDraftActive:false});
      state.flushDoc();
      const text = renderSourceLog(next);
      current.current = { base: next, text, dirty: false };
      setDraft(text); setDirty(false); setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  }, [projectId, store]);
  useImperativeHandle(ref, () => ({ save }), [save]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') save(); };
    const leaving = (event: BeforeUnloadEvent) => {
      if (!save() && current.current.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('blur', save);
    window.addEventListener('beforeunload', leaving);
    // Capture runs before the host tears down its runtime on actual navigation.
    window.addEventListener('pagehide', save, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      if (store.getState().boundProjectId === projectId) store.setState({sourceDraftActive:false});
      window.removeEventListener('blur', save);
      window.removeEventListener('beforeunload', leaving);
      window.removeEventListener('pagehide', save, true);
      document.removeEventListener('visibilitychange', hidden);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [save, store, projectId]);
  const copy = async () => {
    const ok = await copyToClipboard(current.current.text);
    setNotice(ok ? '✓ 已复制全部' : '复制失败');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(''), 2200);
  };
  const discardDraft = async () => {
    if (!await confirmDialog({title:tr('重新读取 Log'),message:tr('放弃尚未保存的 Log 草稿，重新读取当前内容？'),confirmText:tr('重新读取'),danger:true})) return;
    const base = store.getState().raw, text = renderSourceLog(base);
    current.current = { base, text, dirty:false };
    store.setState({sourceDraftActive:false});
    setDraft(text); setDirty(false); setError('');
  };
  return <section className="gft-source-editor" aria-label="Log">
    <div className="gft-source-editor-actions">
      <span role="status">{notice ? tr(notice) : dirty ? tr('有未保存的修改') : ''}</span>
      <button type="button" disabled={hydrating} onClick={() => { void copy(); }}>{tr('复制全部')}</button>
      <button type="button" disabled={hydrating || (!dirty && !persistenceError)} onClick={() => save()}>{tr('保存')}</button>
    </div>
    <p className="gft-source-editor-note">{tr('可自由编辑已接收的材料，失焦或 Ctrl+S 保存。保存不改变 Doc／Map；点「重画」按当前 Log 重新生成。')}</p>
    <textarea className="gft-source-editor-input" aria-label={tr('Log 内容')} value={draft} disabled={hydrating} spellCheck={false}
      placeholder={tr('在这里编辑或补充来源材料…')}
      onChange={event => {
        const text = event.target.value;
        const changed = text !== renderSourceLog(current.current.base);
        current.current.text = text; current.current.dirty = changed;
        store.setState({sourceDraftActive:changed});
        setDraft(text); setDirty(changed); setNotice('');
      }}
      onBlur={() => save()}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
      }} />
    {(error || persistenceError) && <p role="alert" className="gft-source-editor-error">{tr(error || persistenceError || '')}</p>}
    {error && <div className="gft-source-editor-actions"><button onClick={() => void discardDraft()}>{tr('重新读取 Log')}</button></div>}
  </section>;
});
