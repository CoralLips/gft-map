import { isEditedSourceLog, readSourceLog, renderSourceLog } from '../../../service/sourceLog';
/**
 * Log 展示已接收原文与人工输入，不受主题过滤，整理/重画不写回模型结果。
 * 新来源只读；旧版提取账保留原编辑器作为兼容入口，不冒充完整原文。
 * 顶栏＝本体级共享动作（与 Map/Doc 同款）。样式复用 WhiteboxDocPanel 的。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { useThinkingMapHost, useThinkingMapRuntime } from '../ThinkingMapRuntime';
import { UpdateMapButton, RedrawButton, TidyButton, MapStats, AiMemoryToggle, ExportMenu } from '../MapDocActions';
import { parseLedger } from '../../../service/ledger';
import type { LiveEditorHandle } from '../LiveEditor';
import styles from '../WhiteboxDocPanel/WhiteboxDocPanel.module.css';

// 与 FocusLab 同款懒加载：codemirror 478KB 不进首屏
const LiveEditor = React.lazy(() => import('../LiveEditor'));

/** 账里定位某条判断/走向段的行：行首五档、⊃ 或「走向」，紧跟 id */
const lineOf = (id: string): RegExp => new RegExp(`^(?:[◆◇？?✗⏸]|⊃|走向)\\s*${id}(?![0-9])`);

export function LedgerSourcePanel(): JSX.Element {
  const { store: useThinkingMapStore } = useThinkingMapRuntime();
  const currentProjectId = useThinkingMapHost(s => s.currentProjectId);
  const raw = useThinkingMapStore(s => s.raw);
  const hasReceivedSources = useMemo(() => isEditedSourceLog(raw) || readSourceLog(raw).length > 0, [raw]);
  const sourceText = useMemo(() => renderSourceLog(raw), [raw]);
  const warnings = useMemo(() => parseLedger(raw).warnings, [raw]);
  const isGenerating = useThinkingMapStore(s => s.isGenerating);
  const sourceJumpId = useThinkingMapStore(s => s.sourceJumpId);
  const clearSourceJump = useThinkingMapStore(s => s.clearSourceJump);
  const updateRaw = useThinkingMapStore(s => s.updateRaw);
  const flushDoc = useThinkingMapStore(s => s.flushDoc);
  const editorRef = useRef<LiveEditorHandle>(null);

  // 窗口失焦/切标签页/锁屏/关页 → 立即收账（挂起的防抖不等 1.2s）
  useEffect(() => {
    const flush = () => flushDoc();
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushDoc(); };
    window.addEventListener('blur', flush);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('blur', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', flush);
      flushDoc(); // 卸载（切走源视图）也收账
    };
  }, [flushDoc]);

  // 跳行：编辑器是懒加载的，就绪前每 100ms 试一次，最多 3s
  useEffect(() => {
    if (!sourceJumpId) return;
    const re = lineOf(sourceJumpId);
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (editorRef.current?.revealLine(re) || tries >= 30) {
        clearInterval(timer);
        clearSourceJump();
      }
    }, 100);
    return () => clearInterval(timer);
  }, [sourceJumpId, clearSourceJump]);

  if (!currentProjectId) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyGuide}>
          先在左上角选择或创建一个脉络，<br />它的原始记录就在这里。
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

      {warnings.length > 0 && (
        <div className={styles.warn} title={warnings.join('\n')}>
          有 {warnings.length} 行没被认出来（已按自由文本保留）：{warnings[0]}
        </div>
      )}

      <div className={styles.body}>
        {hasReceivedSources ? <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'inherit'}}>{sourceText}</pre> : <React.Suspense fallback={<div className={styles.loading}>加载编辑器…</div>}>
          <LiveEditor
            key={currentProjectId}
            ref={editorRef}
            value={raw}
            onChange={text => {
              if (useThinkingMapStore.getState().boundProjectId === currentProjectId) updateRaw(text);
            }}
            isGenerating={isGenerating}
            docKey={`${currentProjectId}:raw`}
            onLineBlur={flushDoc}
            compact
            placeholder={'判断账——本脉络的底层正本。\n每行一条：◆ j1 [域] 判断 / 走向 p2 [域] 叙述 / ← j3 j1 承接 / 本人 改 j1 标题：… / ◆ j9 [域] 合并后的判断 = j1 j3'}
          />
        </React.Suspense>}
      </div>
    </div>
  );
}
