/**
 * ThinkingMapPanel — focus 页右侧的思维导航视图（阶段1 demo）
 * 数据源 = 左边当前对话（chatHistory 拼接后交给 AI 提取），不是手动粘贴。
 * 由 FocusLab 在右侧 Map 页签中渲染。
 */

import type { JSX } from 'react';
import { useThinkingMapRuntime } from '../ThinkingMapRuntime';
import { ThinkingMapView } from '../ThinkingMapView';
import styles from './ThinkingMapPanel.module.css';
// 本体级动作（更新/AI记忆/导出）08-25 抽至共享组件——Map/Doc 两视图同款；
// 喂图数据流（useMapFeed）一并共享，本组件的「重画」也从它取参
import { UpdateMapButton, AiMemoryToggle, ExportMenu, RedrawButton, TidyButton, MapStats } from '../MapDocActions';
import { themeOf } from '../../../service/ledger';
import { useT } from '../../../i18n';

export function ThinkingMapPanel(): JSX.Element {
  const tr = useT();
  const { store: useThinkingMapStore } = useThinkingMapRuntime();
  const error = useThinkingMapStore(s => s.error);
  const theme = useThinkingMapStore(s => themeOf(s.ledgerState));
  // 注:外部 agent 对接已改为 session 侧单向发起(/gft:* 命令),网页不再有反向触发/在线指示——
  // 信号层(broadcast/presence/耳朵)2026-08-06 整层撤除;防覆盖合并仍在数据层(saveThinkingMap)兜着。

  // 重画已上共享顶栏（08-27：它现在是图文一起推倒重来的本体级动作 → MapDocActions.RedrawButton）。
  // 导出/AI记忆/更新同样在共享组件里（08-25）——Doc 视图同款

  // 全局与框选整理共用图文机制；TidyButton 传选区，未选择时整理全图。

  // ⚡ 推进入口已撤（2026-08-27 用户拍：体验循环读数=不重要，不占右栏固化位；
  //  applyProposals/CUE_BATCH_PROMPT 等底层保留，需要时从 git 取回按钮与 handlePush）。

  // 分享长图已删（2026-08-05 用户拍：假设了不存在的行为——谁会分享一张自己没想清楚的图）。
  // 导出只剩「思考轨迹 .md」一项 → 下拉菜单撤掉，⇪ 按钮直接下载。


  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.btnGroup}>
          <UpdateMapButton />
          <TidyButton />
          <RedrawButton />
        </span>
        <MapStats />
        {/* 右区=拿走成品（与左侧"改图"操作拉开——改 vs 拿走两种心态）。共享组件（Doc 视图同款） */}
        <span className={styles.btnGroup} style={{ position: 'relative' }}>
          <AiMemoryToggle />
          <ExportMenu />
        </span>
      </div>
      {error && (
        <div className={styles.error}>
          ⚠ {tr(error)}
          <button
            className={styles.errorClose}
            onClick={() => useThinkingMapStore.setState({ error: null })}
            title={tr('关闭')} aria-label={tr('关闭提示')}
          >×</button>
        </div>
      )}
      {theme && (
        <details className={styles.theme} key={theme}>
          <summary className={styles.themeSummary} title={tr('展开或收起完整主题范围')}>
            <span className={styles.themeText}>{tr('主题：')}{theme}</span>
            <span className={styles.themeToggle} aria-hidden="true" data-expand={tr('展开')} data-collapse={tr('收起')} />
          </summary>
        </details>
      )}
      <div className={styles.mapArea}>
        <ThinkingMapView />
      </div>
    </div>
  );
}
