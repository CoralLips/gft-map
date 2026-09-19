/**
 * WhiteboxDocPanel — 「Doc」视图：白盒文档（LiveEditor 打字即存，体验与账之前一样）
 *
 * 2026-09-05 账模型：判断账（源）是唯一正本，文档是从账折算出来的视图。
 * 2026-09-06 用户拍：Doc 随便改，打字只进缓冲；切走视图/窗口失焦/关页/换图/AI 动作前把改动按锚算成账行写进账，
 *   每条判断最多一行（改标题/表述/档/域、删、新条目、走向段、顺序），账里原来的行一个字不动。
 * 顶栏＝本体级共享动作（更新/整理/重画/AI记忆/导出，与 Map 视图同款——MapDocActions）。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useThinkingMapHost, useThinkingMapRuntime } from '../ThinkingMapRuntime';
import { UpdateMapButton, RedrawButton, TidyButton, MapStats, AiMemoryToggle, ExportMenu } from '../MapDocActions';
import type { LiveEditorHandle } from '../LiveEditor';
import { splitDocTheme, joinDocTheme } from '../../../service/ledger/docEdit';
import styles from './WhiteboxDocPanel.module.css';
import { useT } from '../../../i18n';

// 与 FocusLab 同款懒加载：codemirror 478KB 不进首屏
const LiveEditor = React.lazy(() => import('../LiveEditor'));

export function WhiteboxDocPanel(): JSX.Element {
  const tr = useT();
  const { store: useThinkingMapStore, host } = useThinkingMapRuntime();
  const currentProjectId = useThinkingMapHost(s => s.currentProjectId);
  const doc = useThinkingMapStore(s => s.doc);
  const docDraft = useThinkingMapStore(s => s.docDraft);
  const isGenerating = useThinkingMapStore(s => s.isGenerating);
  const warningCount = useThinkingMapStore(s => s.ledgerState.warnings.length);
  const setDocDraft = useThinkingMapStore(s => s.setDocDraft);
  const flushDocEdits = useThinkingMapStore(s => s.flushDocEdits);
  const flushDoc = useThinkingMapStore(s => s.flushDoc);
  const focusOnMap = useThinkingMapStore(s => s.focusOnMap);
  const docJumpId = useThinkingMapStore(s => s.docJumpId);
  const clearDocJump = useThinkingMapStore(s => s.clearDocJump);
  const editorRef = useRef<LiveEditorHandle>(null);
  const themeInputRef = useRef<HTMLTextAreaElement>(null);
  const [themeEdit, setThemeEdit] = useState<{projectId: string; text: string; original: string} | null>(null);
  const [bodyEdit, setBodyEdit] = useState<{projectId: string; text: string} | null>(null);
  const parts = splitDocTheme(docDraft ?? doc);
  const activeTheme = themeEdit?.projectId === currentProjectId ? themeEdit : null;
  const activeBody = bodyEdit?.projectId === currentProjectId ? bodyEdit : null;
  const beginThemeEdit = () => {
    if (!currentProjectId) return;
    const state = useThinkingMapStore.getState();
    const text = splitDocTheme(state.docDraft ?? state.doc).theme;
    setThemeEdit({projectId: currentProjectId, text, original: text});
  };
  const saveEdits = () => { flushDocEdits(); flushDoc(); };
  useEffect(() => { if (activeTheme) themeInputRef.current?.focus(); }, [activeTheme?.projectId]);
  useLayoutEffect(() => {
    const input = themeInputRef.current;
    if (!input) return;
    const resize = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(input);
    return () => observer.disconnect();
  }, [activeTheme?.text, activeTheme?.projectId]);

  // 图上节点 → 文档条目：编辑器是懒加载的，就绪前每 100ms 试一次，最多 3s
  useEffect(() => {
    if (!docJumpId) return;
    if (docJumpId === '主题') { beginThemeEdit(); clearDocJump(); return; }
    const re = /^j\d+$/.test(docJumpId) ? new RegExp(`\\^${docJumpId}\\s*$`) : new RegExp(`^## ${docJumpId}\\s*$`); // 条目按锚；主题/域按标题
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (editorRef.current?.revealLine(re) || tries >= 30) { clearInterval(timer); clearDocJump(); }
    }, 100);
    return () => clearInterval(timer);
  }, [docJumpId, clearDocJump]);

  // 落账时机（2026-09-06 用户拍：放大颗粒）：窗口失焦 / 切标签页 / 关页 / 卸载（切走视图）
  useEffect(() => {
    // 先把缓冲算成账行，再立刻落库（挂起的防抖 1.2s 等不到关页）
    const flush = () => { flushDocEdits(); flushDoc(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('blur', flush);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('blur', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', flush);
      flushDocEdits();
    };
  }, [flushDocEdits, flushDoc]);

  if (!currentProjectId) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyGuide}>
          {tr('先在左上角选择或创建一个脉络，它的白盒文档就在这里。')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.btnGroup}>
          <UpdateMapButton />
          <TidyButton />
          <RedrawButton />
        </span>
        <MapStats />
        <span className={styles.btnGroup}>
          <AiMemoryToggle />
          <ExportMenu />
        </span>
      </div>

      {warningCount > 0 && (
        <div className={styles.warn}>
          {tr('工作账里有 {count} 行没被认出来（已按自由文本保留）', {count:warningCount})}
        </div>
      )}

      <div className={styles.body}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { flushDocEdits(); flushDoc(); }
        }}
        onKeyDownCapture={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.stopPropagation(); flushDocEdits(); flushDoc(); setThemeEdit(null); setBodyEdit(null);
          }
        }}>
        <section className={styles.themeSection} aria-label={tr('主题范围')}>
          <div className={styles.themeHeading}><h2>{tr('主题')}</h2><span>{tr('收录范围')}</span></div>
          {activeTheme ?
            <textarea ref={themeInputRef} className={styles.themeInput} aria-label={tr('编辑主题范围')} rows={1}
              title={tr('失焦或 Ctrl+S 保存；修改范围后，点重画重新筛选已保存的材料。')}
              value={activeTheme.text}
              onChange={event => {
                const state = useThinkingMapStore.getState();
                if (state.boundProjectId !== currentProjectId) return;
                const text = event.target.value;
                setThemeEdit({...activeTheme, text});
                setDocDraft(joinDocTheme(text, splitDocTheme(state.docDraft ?? state.doc).body));
              }}
              onBlur={() => { saveEdits(); setThemeEdit(null); }}
              onKeyDown={event => {
                if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                  const state = useThinkingMapStore.getState();
                  setDocDraft(joinDocTheme(activeTheme.original, splitDocTheme(state.docDraft ?? state.doc).body));
                  saveEdits(); setThemeEdit(null);
                }
              }} />
          : <button className={styles.themeText} aria-label={tr('编辑主题')} onClick={beginThemeEdit}>
            {parts.theme || <span className={styles.themePlaceholder}>{tr('首次更新时自动生成，也可以在这里填写。')}</span>}
          </button>}
        </section>
        <div className={styles.editorArea} onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { saveEdits(); setBodyEdit(null); }
        }}>
        <React.Suspense fallback={<div className={styles.loading}>{tr('加载编辑器…')}</div>}>
          <LiveEditor
            key={currentProjectId}
            ref={editorRef}
            value={activeBody?.text ?? parts.body}
            onChange={text => {
              const state = useThinkingMapStore.getState();
              if (state.boundProjectId === currentProjectId) {
                setBodyEdit({projectId: currentProjectId, text});
                setDocDraft(joinDocTheme(splitDocTheme(state.docDraft ?? state.doc).theme, text));
              }
            }}
            onAnchorClick={focusOnMap}
            isGenerating={isGenerating}
            docKey={currentProjectId}
            compact
            placeholder={tr(host.requestUpdate
              ? '点「更新」从聊天或材料生成文档，也可以在这里直接书写。'
              : '点「更新」从左边对话生成文档，也可以在这里直接书写。')}
          />
        </React.Suspense>
        </div>
      </div>
    </div>
  );
}
