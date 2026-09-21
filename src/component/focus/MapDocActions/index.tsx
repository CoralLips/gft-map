import { hasSourceLog } from '../../../service/sourceLog';
import { mapToBundle } from '../../../service/topicBundle';
/**
 * MapDocActions — Map/Doc 两视图共享的本体级动作（08-25 用户拍：动作作用于本体，
 * 不该跟着视图走——更新=双写文档+图、AI 记忆=注入开关、导出=图文一体带走）。
 *
 * 三个独立小组件（各自自取 store，两个面板按各自布局摆放）+ 喂图数据流 hook：
 *  - UpdateMapButton  「🧭 更新」：对话→AI 抽判断→文档条目+图节点双写
 *  - AiMemoryToggle   「AI 记忆」：contextInjectEnabled 开关
 *  - ExportMenu       「⇪ 导出」：复制当前 Doc / 下载完整脉络
 *  - useMapFeed       水位切片/生成参数（ThinkingMapPanel 的「重画」也用它）
 *
 * 整理、重画也作用于同一份判断账；整理有选区时限定范围，无选区时处理全图。
 * 按钮样式复用 ThinkingMapPanel.module.css——两个面板视觉一致。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { confirmDialog } from '../../common/ConfirmDialog';
import { useThinkingMapHost, useThinkingMapRuntime } from '../ThinkingMapRuntime';
import type { MapFeedMessage } from '../../../store/thinkingMap/runtime';
import type { GenerateSource } from '../../../store/thinkingMap/createStore';
import { liveJudgments, docChars } from '../../../service/ledger';
import { buildChatText, buildUserSpeechList, isFeedableMessage } from '../../../util/chatHistory';
import { copyToClipboard } from '../../../util/clipboard';
import { useT, t } from '../../../i18n';
import styles from '../ThinkingMapPanel/ThinkingMapPanel.module.css';
import ownStyles from './MapDocActions.module.css';

/** 喂图数据流：完整消息切片、水位后的新段、生成参数组装、更新入口 */
export function useMapFeed() {
  const { store: useThinkingMapStore, host } = useThinkingMapRuntime();
  const chatHistory = useThinkingMapHost(s => s.chatHistory);
  const currentSessionId = useThinkingMapHost(s => s.currentSession?.id);
  const currentSessionTitle = useThinkingMapHost(s => s.currentSession?.title);
  const currentProjectId = useThinkingMapHost(s => s.currentProjectId);
  const createNewProject = host.createProject;
  const sourceWatermarks = useThinkingMapStore(s => s.sourceWatermarks);
  const hasMap = useThinkingMapStore(s => s.nodes.length > 0);
  const generate = useThinkingMapStore(s => s.generate);
  const hydrateForProject = useThinkingMapStore(s => s.hydrateForProject);

  // 完整消息（正在流式生成的半截回复不算——防下次更新漏掉它的后半段）
  const settledHistory = useMemo(
    () => chatHistory.filter(m => m.status !== 'streaming'),
    [chatHistory],
  );

  // 水位之后的新段：没吃过这个对话 → 整段都是新素材；水位消息被删 → findIndex=-1+1=0，退回全量（宁重复不丢失）
  const freshSlice = useMemo(() => {
    const wm = currentSessionId ? sourceWatermarks.get(currentSessionId) : undefined;
    const start = wm ? settledHistory.findIndex(m => m.id === wm) + 1 : 0;
    return settledHistory.slice(start);
  }, [settledHistory, sourceWatermarks, currentSessionId]);

  const freshCount = useMemo(() => freshSlice.filter(isFeedableMessage).length, [freshSlice]);
  const hasChat = chatHistory.some(m => m.content?.trim());
  const noFresh = freshCount === 0;

  /** 本次要吃的切片 → 生成参数（文本 + 用户发言数 + 水位锚点 + 塔基快照） */
  const buildGenerateArgs = useCallback((slice: MapFeedMessage[]): { text: string; userMsgCount: number; source?: GenerateSource } | null => {
    const chatText = buildChatText(slice);
    if (!chatText) return null;
    // 末尾附用户发言清单：用户原话直陈眼前当抽取主线（治重画漏抽核心提问）
    const speechList = buildUserSpeechList(slice);
    const text = speechList ? `${chatText}\n\n${speechList}` : chatText;
    const userMsgCount = slice.filter(m => m.role === 'user' && isFeedableMessage(m)).length;
    const last = slice[slice.length - 1];
    const snapshot = slice.filter(isFeedableMessage).map(m => ({
      id: m.id, role: m.role, name: m.userName ?? null, content: m.content, ts: m.timestamp,
    }));
    return {
      text,
      userMsgCount,
      ...(currentSessionId && last
        ? { source: { sessionId: currentSessionId, lastMessageId: last.id, sessionTitle: currentSessionTitle ?? '', snapshot } }
        : {}),
    };
  }, [currentSessionId, currentSessionTitle]);

  // 有图 = 增量更新（只吃水位后的新段）；无图 = 从整个对话全新生成
  // 未挂靠任何脉络时：自动新建一条「新脉络」挂上再生成——零摩擦、零丢失
  const handleGenerate = useCallback(async () => {
    // 匿名:AI 生成被服务端拒(403)、云端脉络也不给建(孤儿防线)——点了别静默,引导注册
    if (!host.ensureCanGenerate()) return;
    if (host.requestUpdate) { await host.requestUpdate(); return; }
    const args = buildGenerateArgs(freshSlice);
    if (!args) return;
    if (!currentProjectId) {
      const pid = await createNewProject('新脉络');
      if (!pid) return;
      await hydrateForProject(pid); // 立即绑定（空图），生成结果才会落库
    }
    void generate(args.text, { userMsgCount: args.userMsgCount, ...(args.source ? { source: args.source } : {}) });
  }, [host, buildGenerateArgs, hasMap, freshSlice, settledHistory, currentProjectId, createNewProject, hydrateForProject, generate]);

  return { settledHistory, freshSlice, freshCount, hasChat, noFresh, buildGenerateArgs, handleGenerate };
}

/** 「🧭 更新」——本体级：对话内容→白盒文档条目+图节点双写（生成中点击=中止） */
export function UpdateMapButton(): JSX.Element {
  const { store: useThinkingMapStore, host } = useThinkingMapRuntime();
  const pendingTaskLabel = useThinkingMapHost(s => s.pendingTaskLabel);
  const isGenerating = useThinkingMapStore(s => s.isGenerating);
  const streamingCount = useThinkingMapStore(s => s.streamingCount);
  const isHydrating = useThinkingMapStore(s => s.isHydrating);
  const isTidying = useThinkingMapStore(s => s.isTidying);
  const hasMap = useThinkingMapStore(s => s.nodes.length > 0);
  const cancelGeneration = useThinkingMapStore(s => s.cancelGeneration);
  const generateMode = useThinkingMapStore(s => s.generateMode);
  const { freshCount, hasChat, noFresh, handleGenerate } = useMapFeed();
  const tr = useT();
  const running = isGenerating && generateMode === 'update'; // 重画在跑时中止在重画钮上

  return (
    <button
      className={`${styles.generateBtn} ${running ? styles.stopOnHover : ''}`}
      onClick={() => { if (running) { cancelGeneration(); } else if (!isGenerating) { void handleGenerate(); } }}
      disabled={!running && (isGenerating || isHydrating || (!host.requestUpdate && (!hasChat || noFresh)) || isTidying)}
      title={running
        ? tr('点击中止本次生成——图会回到生成前的样子')
        : host.requestUpdate
          ? tr('读取已连接会话的新材料，保存到 Log 并更新图文')
          : !hasChat
          ? tr('左边还没有对话内容')
          : noFresh
            ? tr('没有新对话——聊几句再来更新')
            : (hasMap ? tr('把左边新聊的内容记进 Log，Map 和 Doc 跟着更新（已有部分一字不动）') : tr('把左边对话里的想法记进 Log，长成 Map 和 Doc'))}
    >
      {running
        ? <>
            <span className={styles.runLabel}>{pendingTaskLabel ?? (streamingCount ? `${tr('生成中…已长出')} ${streamingCount} ${tr('个节点')}` : tr('通读对话中…'))}</span>
            <span className={styles.stopLabel}>■ {tr('中止')}</span>
          </>
        : host.requestUpdate
          ? `🧭 ${tr('更新')}`
          : hasMap
          ? (freshCount > 0 ? `🧭 ${tr('更新')} · ${tr('新')} ${freshCount} ${tr('条')}` : `🧭 ${tr('更新')}`)
          : `🧭 ${tr('从当前对话生成')}`}
    </button>
  );
}

/**
 * 「↺ 重画」——本体级（2026-09-06 用户拍：重画不读对话）。
 * 原料＝Log 里现有的判断、走向、承接；AI 重写图文，系统按来源保留已有承接与先后顺序，
 * 不发明、不丢判断；手改的内容在账里，自然带过去；条目记「改写自」。破坏面大 → 弹窗确认；可 Ctrl+Z 退回。
 */
export function RedrawButton(): JSX.Element | null {
  const { store: useThinkingMapStore } = useThinkingMapRuntime();
  const pendingTaskLabel = useThinkingMapHost(s => s.pendingTaskLabel);
  const hasSourceMaterial = useThinkingMapHost(s => s.hasSourceMaterial);
  const redrawDescription = useThinkingMapHost(s => s.redrawDescription);
  const hasRaw = useThinkingMapStore(s => hasSourceLog(s.raw)); // Log 里有原料就能重画，Doc 删空了也能
  const isGenerating = useThinkingMapStore(s => s.isGenerating);
  const isTidying = useThinkingMapStore(s => s.isTidying);
  const redrawFromLedger = useThinkingMapStore(s => s.redrawFromLedger);
  const generateMode = useThinkingMapStore(s => s.generateMode);
  const cancelGeneration = useThinkingMapStore(s => s.cancelGeneration);
  const streamingCount = useThinkingMapStore(s => s.streamingCount);
  const running = isGenerating && generateMode === 'redraw';
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(timer);
  }, [note]);

  const handleRedraw = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('重画'),
      message: t(redrawDescription ?? '保留当前主题，基于 Log 中已接收的来源重新生成图文。不读取原聊天，更新进度不变；完成后可 Ctrl+Z 撤销。'),
      confirmText: t('重画'),
      danger: true,
    });
    if (!ok) return;
    setNote(null);
    const result = await redrawFromLedger();
    if (result) setNote(result.sourceIncomplete ? '✓ 已重画 · 部分来源未对应' : '✓ 已重画');
  }, [redrawFromLedger, redrawDescription]);

  const tr = useT();
  if (!hasRaw && !hasSourceMaterial && !running) return null;
  if (running) {
    return (
      <button
        className={`${styles.freshBtn} ${styles.stopOnHover}`}
        onClick={cancelGeneration}
        title={tr('点击中止重画——图和文档回到重画前的样子')}
      >
        <span className={styles.runLabel}>{pendingTaskLabel ? tr(pendingTaskLabel) : (streamingCount ? tr('↺ 重写中…已长出 {count} 条', {count:streamingCount}) : tr('↺ 通读账中…'))}</span>
        <span className={styles.stopLabel}>■ {tr('中止')}</span>
      </button>
    );
  }
  return (
    <button
      className={styles.freshBtn}
      onClick={() => void handleRedraw()}
      disabled={isGenerating || isTidying}
      title={tr(note ? '原始记录保留在 Log；可 Ctrl+Z 撤销。来源未对应不影响查看和继续整理。' : '根据 Log 重写文档和图；可 Ctrl+Z 撤销')}
    >{note ? tr(note) : `↺ ${tr('重画')}`}</button>
  );
}

/**
 * 「🧹 整理」——本体级：图文一起整理（2026-08-28 定案）。
 * AI 重组白盒文档并给出配套的边，图靠锚跟随（节点不重建、合并的并入主锚）。
 * 只动组织不新增判断；做完出回执；Ctrl+Z 整体退回。
 */
export function TidyButton(): JSX.Element | null {
  const { store: useThinkingMapStore } = useThinkingMapRuntime();
  const pendingTaskLabel = useThinkingMapHost(s => s.pendingTaskLabel);
  const hasDoc = useThinkingMapStore(s => s.doc.trim().length > 0);
  const isTidying = useThinkingMapStore(s => s.isTidying);
  const isGenerating = useThinkingMapStore(s => s.isGenerating);
  const isRefining = useThinkingMapStore(s => s.isRefining);
  const selectedNodeIds = useThinkingMapStore(s => s.selectedNodeIds);
  const tidyWhitebox = useThinkingMapStore(s => s.tidyWhitebox);
  const cancelTidy = useThinkingMapStore(s => s.cancelTidy);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tidyRound = useThinkingMapStore(s => s.tidyRound);
  const handleTidy = useCallback(async () => {
    if (isTidying) return;
    const selection = [...selectedNodeIds];
    const isScoped = selection.length > 0;
    setNote(null);
    const report = await tidyWhitebox(isScoped ? selection : undefined);
    if (!report) return; // 失败：错误横幅已由 store 显示
    const bits = [report.before !== undefined && report.after !== undefined ? t('{before}→{after} 条', {before:report.before,after:report.after}) : t('{count} 个节点', {count:report.entries})];
    if (report.mergedGroups) bits.push(t('合并 {count} 组', {count:report.mergedGroups}));
    if (report.dropped) bits.push(t('去掉 {count} 条', {count:report.dropped}));
    if (!isScoped && report.textBefore && report.textAfter !== undefined && report.textAfter < report.textBefore) bits.push(t('字数 −{percent}%', {percent:Math.round((1 - report.textAfter / report.textBefore) * 100)}));
    const reduced = report.before !== undefined && report.after !== undefined && report.after < report.before;
    setNote(reduced ? t('✓ {scope}已收拢 · {details}（Ctrl+Z 整次退回）', {scope:t(isScoped ? '选区' : '全图'),details:bits.join(' · ')}) : report.changed ? t('已调整图文，节点未减少 · {details}（Ctrl+Z 整次退回）', {details:bits.join(' · ')}) : t('本次未找到可合并的判断，原图文保留'));
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 8000);
  }, [isTidying, selectedNodeIds, tidyWhitebox]);

  const tr = useT();
  if (!hasDoc && !isTidying) return null;
  if (isTidying) {
    return (
      <button
        className={`${styles.addNodeBtn} ${styles.stopOnHover}`}
        onClick={cancelTidy}
        title={tr('点击中止整理：这次整理全部作废，不保存任何改动')}
      >
        <span className={styles.runLabel}>{pendingTaskLabel ? tr(pendingTaskLabel) : <>🧹 {tr('整理中…')}{tidyRound ? tr('第 {round} 轮', {round:tidyRound}) : ''}</>}</span>
        <span className={styles.stopLabel}>■ {tr('中止')}</span>
      </button>
    );
  }
  return (
    <button
      className={styles.addNodeBtn}
      onClick={() => void handleTidy()}
      disabled={isGenerating || isRefining}
      title={tr(selectedNodeIds.size > 0 ? '整理选中判断与关联正文；不改选区外内容。中止整次不保存，Ctrl+Z 整次退回' : '整理主题表述、当前文稿和节点：保留收录范围，归并重复，提炼文稿中的新判断。来源保留在 Log；Ctrl+Z 整次退回')}
    >{selectedNodeIds.size > 0 ? `🧹 ${tr('整理选中')} ${tr('{count} 个节点', {count:selectedNodeIds.size})}${note ? ` · ${note}` : ''}` : note ?? `🧹 ${tr('整理')}`}</button>
  );
}

/** 顶栏灰字：节点数 · 字数（不设上限，什么时候整理由人自己判断） */
export function MapStats(): JSX.Element | null {
  const { store: useThinkingMapStore } = useThinkingMapRuntime();
  const count = useThinkingMapStore(s => liveJudgments(s.ledgerState).length);
  const chars = useThinkingMapStore(s => docChars(s.ledgerState));
  const tr = useT();
  if (count === 0) return null;
  return <span className={ownStyles.stats} title={tr('判断条数 · 白盒文档字数')}>{tr('{count} 条 · {chars} 字', {count,chars})}</span>;
}

/** 「AI 记忆」开关——状态指示而非动作按钮：绿点=左边 AI 正在读、灰点=关闭 */
export function AiMemoryToggle(): JSX.Element | null {
  const { store: useThinkingMapStore, memoryControl } = useThinkingMapRuntime();
  const showMemoryToggle = useThinkingMapHost(s => s.showMemoryToggle);
  const contextInjectEnabled = useThinkingMapStore(s => s.contextInjectEnabled);
  const setContextInjectEnabled = useThinkingMapStore(s => s.setContextInjectEnabled);
  const tr = useT();
  if (memoryControl) return <>{memoryControl}</>;
  if (showMemoryToggle === false) return null;
  return (
    <button
      onClick={() => setContextInjectEnabled(!contextInjectEnabled)}
      title={contextInjectEnabled
        ? tr('左边的 AI 正在读这份思考资产（作为记忆上下文）。点击关闭')
        : tr('AI 读不到这份资产。点击开启，把它作为记忆给左边')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 9px', borderRadius: 999, fontSize: 12, lineHeight: 1.5,
        border: '1px solid var(--poe-gray-200)',
        background: contextInjectEnabled ? 'var(--poe-gray-100)' : 'transparent',
        color: contextInjectEnabled ? 'var(--poe-gray-500)' : 'var(--poe-gray-400)',
        cursor: 'pointer', marginRight: 6,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: contextInjectEnabled ? 'var(--tone-green)' : 'var(--poe-gray-300)',
      }} />
      {contextInjectEnabled ? tr('AI 记忆') : tr('AI 记忆 · 关')}
    </button>
  );
}

/** 文稿用于阅读分享；完整 GFT 文件用于迁移当前脉络。 */
export function ExportMenu(): JSX.Element {
  const { store: useThinkingMapStore, host } = useThinkingMapRuntime();
  const currentProjectId = useThinkingMapHost(s => s.currentProjectId);
  const hasDoc = useThinkingMapStore(s => (s.docDraft ?? s.doc).trim().length > 0);
  const isHydrating = useThinkingMapStore(s => s.isHydrating);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 点外面关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => () => { if (noteTimerRef.current) clearTimeout(noteTimerRef.current); }, []);

  const flash = useCallback((text: string) => {
    setNote(text);
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => setNote(null), 4500);
  }, []);

  const download = useCallback((name: string, content: string) => {
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.gft.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  // Include current drafts and any rename made while the menu was open.
  const capture = useCallback(() => {
    const before = useThinkingMapStore.getState();
    const snapshot = host.getSnapshot();
    if (before.isHydrating || before.boundProjectId !== snapshot.currentProjectId) throw new Error(t('请等待当前脉络加载完成后再导出'));
    before.flushDocEdits();
    const current = useThinkingMapStore.getState();
    const name = snapshot.projects.find(p => p.id === snapshot.currentProjectId)?.name || snapshot.projectNameFallback || t('新脉络');
    return { current, name, doc: `# ${name}\n\n${current.doc}` };
  }, [host, useThinkingMapStore]);

  const run = useCallback(async (action: () => string | Promise<string>) => {
    setOpen(false); setBusy(true);
    try { flash(await action()); }
    catch (error) { flash(`${t('导出失败')}：${error instanceof Error ? t(error.message) : String(error)}`); }
    finally { setBusy(false); }
  }, [flash]);
  const copyDoc = () => run(async () => {
    const snapshot = capture();
    return await copyToClipboard(snapshot.doc) ? t('✓ 已复制') : t('复制失败');
  });
  const exportBundle = () => run(async () => {
    const { current, name } = capture();
    if(host.downloadBundle){await host.downloadBundle();return t('已开始下载');}
    const data = mapToBundle(name, { nodes: current.nodes, edges: current.edges, doc: current.doc, ledger: current.ledger, raw: current.raw, watermarks: {} });
    download(name, JSON.stringify(data, null, 2));
    return t('✓ 已下载');
  });
  const tr = useT();
  const disabled = busy || isHydrating;

  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className={styles.addNodeBtn}
        disabled={busy}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        title={note ?? tr('导出当前脉络的文稿或完整 GFT 文件')}
      >{busy ? tr('正在导出…') : note ?? `⇪ ${tr('导出')}`}</button>
      {open && (
        <span className={ownStyles.menu}>
          <button className={ownStyles.menuItem} disabled={disabled || !hasDoc} title={tr('复制当前 Doc，包含主题和正文')} onClick={() => void copyDoc()}>{tr('复制')}</button>
          <button className={ownStyles.menuItem} disabled={disabled || !currentProjectId} title={tr('包含当前脉络的主题、Doc／Map 和 Log，可导入另一端继续使用')} onClick={() => void exportBundle()}>{tr('下载')}</button>
        </span>
      )}
    </span>
  );
}
