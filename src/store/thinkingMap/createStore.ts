import { recordDocumentInput } from '../../service/ledger/docEdit';
import { appendSourceLog, renderSourceLog, hasSourceLog, sourceRecordsFromEvents } from '../../service/sourceLog';
/**
 * 思维导航 demo 的内存态 store（阶段1 不入库）
 * 编辑是根本：用户改完即定，AI 不自动重算（自动重算 = 阶段2）。
 * 防跳变：有图时 generate 走更新模式（喂上一版图），用户编辑受双保险保护。
 */

import { create } from 'zustand';
import type { ThinkingMapRuntime, ThinkingMapStore } from './runtime';
import type { FocusCard } from '../../type/focusCard';
import { THINKING_MAP_PROJECT_ID, DEFAULT_PROJECT_NAME } from '../../service/thinkingMapCore';
import { tidyTarget, TIDY_MAX_ROUNDS } from '../../service/tidyCore';
import { parseLedger, emptyLedgerState, appendLines, judgmentLines, relationLine, sessionLine, decision, liveJudgments, docChars, themeOf, stripToRaw, renderSourceDoc, type LedgerState } from '../../service/ledger';
import { foldLedger, linesFromGenerate, absorbLegacyRow, tidyInput, tidyOpsToLines } from '../../service/ledger/bridge';
import { docEditLines } from '../../service/ledger/docEdit';
import { buildChatText } from '../../util/chatHistory';
import { mergeLedgerPair } from '../../service/ledger/merge';
import type { PersistedThinkingMap } from '../../type/thinkingMap';
import type { SnapshotMessage } from '../../type/sourceSnapshot';
import { wouldCycle, type ThinkingEdge } from '../../type/thinkingMap';

export interface ThinkingMapState {
  nodes: FocusCard[];
  edges: ThinkingEdge[];
  /** 最近一次成功提交生成的输入（重新生成参照） */
  sourceText: string;
  /** 全新生成的代数——视图用它做 key 触发 remount+fitView（更新模式不变，保视口=伴随感） */
  generation: number;
  /** 用户手工编辑过的节点 id（增量模式下旧节点全保留，此标记仅记录事实） */
  userEditedIds: Set<string>;
  /** 已存入项目的节点 id（防重复存 + 按钮态） */
  savedIds: Set<string>;
  /** 最近一次更新模式新增的节点 id（视图高亮"哪里长了新东西"） */
  newIds: string[];
  /** 节点分组（叠加层）：nodeId → 组名，视图按组画虚框 */
  groupMap: Map<string, string>;
  /** 来源水位：对话 id → 这张图从该对话吃到的最后一条完整消息 id（更新只吃水位之后的新段） */
  sourceWatermarks: Map<string, string>;
  /** 正在图上就地编辑 title 的节点（手动加节点流程用） */
  editingNodeId: string | null;
  /** 框选/加选的节点集（Shift 拖框选、Ctrl 点加选；跨组件共享：View 写、Panel 读） */
  selectedNodeIds: Set<string>;
  /** 最近一次删除的信息（toast 文案用；撤销走统一栈 undo()） */
  lastDeleted: { node: FocusCard; edges: ThinkingEdge[]; bridges?: ThinkingEdge[] } | null;
  /** 当前图归属的 project（hydrate 设置；防抖落库用它做键） */
  boundProjectId: string | null;
  isHydrating: boolean;
  isGenerating: boolean;
  /** 收拢初审进行中（与 isGenerating 互斥使用） */
  isCondensing: boolean;
  /** 图文整理进行中；全部结果一次提交 */
  isTidying: boolean;
  /** 单节点整理（✨）进行中；refiningNodeId=正在整理哪个节点（节点本体显示加载态——反馈不挂 hover 浮层） */
  isRefining: boolean;
  refiningNodeId: string | null;
  /** 流式生成中已长出的新节点数（按钮实时文案用）；非生成期 = null */
  streamingCount: number | null;
  /** 最近一次收拢产出的 L2 ids——「撤销本次收拢」窗口用 */
  lastCondensedL2Ids: string[] | null;
  /** 思考进度是否注入左边对话（E1 回流总开关）。关 = 这轮 AI 裸跑不带图——
   *  隐形注入违反白盒本体：用户必须既看得见带了什么、也能一键不带 */
  contextInjectEnabled: boolean;
  /** 白盒文档（源码层：文档为源码、图为投影/目录）——每次更新双写追加（08-25 全模式）；
   *  AI 只追加不改写（appendToWhiteboxDoc 窄门）；人有全权直改（updateDoc） */
  doc: string;
  /** 右侧看哪个视图（2026-09-06 用户拍：Map／Doc／源 三个并列；源＝判断账本身） */
  rightView: 'map' | 'doc' | 'source';
  /** 「到 Log 看这一行」要定位的账 id（Log 面板消费后清空） */
  sourceJumpId: string | null;
  /** 从文档 ^id 跳到图上：要打开/居中的节点 id（画布消费后清空） */
  focusNodeId: string | null;
  /** 从图上跳到文档：要定位的条目 id（Doc 面板消费后清空） */
  docJumpId: string | null;
  /** Doc 编辑缓冲：null＝没有未落账的改动；切走视图/失焦/关页/换图/AI 动作前 flushDocEdits 算一遍写进账 */
  docDraft: string | null;
  /** 整理进行到第几轮（按钮文案用）；非整理期 null */
  tidyRound: number | null;
  /** 正在跑的生成是「更新」还是「重画」：各自的按钮显示自己的中止 */
  generateMode: 'update' | 'redraw' | null;
  /** 工作账：Doc/Map 从它算；人改、整理、重画都写这里（按时间只追加）；nodes/edges/doc/groupMap 全是它的折算缓存 */
  ledger: string;
  /** 原始记录（Log 页签）：只有「更新」写，视图改动/整理/重画一律不碰；重画从它重建工作账 */
  raw: string;
  ledgerState: LedgerState;
  /** 未读红点集合（视图态，不进账；随 nodes 缓存落库） */
  unreadIds: Set<string>;
  error: string | null;
}

/** 本次生成吃到了哪个对话的哪条消息（成功后推进水位；失败不动） */
export interface GenerateSource {
  sessionId: string;
  lastMessageId: string;
  /** 对话标题（收拢事件的来源元数据快照） */
  sessionTitle?: string;
  /** 本次吃的消息段快照——只入 map_condensations 存证，不参与生成 */
  snapshot?: SnapshotMessage[];
}

/** 整理回执——全部由锚的前后映射确定性算出，不采信 AI 的自述 */
export interface TidyReport {
  /** 实际修改了图文（也包括只修关系或表述） */
  changed: boolean;
  /** 整理后的判断条数 */
  entries: number;
  /** 发生合并的组数（一条吸收了别的锚） */
  mergedGroups: number;
  /** 消失的判断数（既没保留也没被并入——AI 判它没信息量） */
  dropped: number;
  /** 整理中新写出来的条目数（正常应为 0——整理不该创作） */
  added: number;
  /** 整理后的边数 */
  edges: number;
  /** 整理前后范围内的判断条数；局部按选区计，全局按全图计 */
  before?: number;
  after?: number;
  /** 全图文档字数与轮数；局部整理不展示全图字数降幅 */
  textBefore?: number;
  textAfter?: number;
  rounds?: number;
}

export interface ThinkingMapActions {
  /** 开关思考进度注入（白盒可控：看得见 + 关得掉） */
  setContextInjectEnabled: (on: boolean) => void;
  /** 切换/进入 project 时加载该项目的图（整图替换内存态；含切换前落盘当前图） */
  hydrateForProject: (projectId: string) => Promise<void>;
  /** 远端变更 → 本地全量对齐（MCP agent 从会话外写库、或多端另一头改动后的感知入口）。
   *  本地忙或有未落库改动时跳过（last-write-wins：本地随后落库、以本地版本收尾）。
   *  返回是否真的替换了。 */
  syncFromRemote: () => Promise<boolean>;
  /** 纯内存重置（不落库）——当前项目被删除/退出时清屏用 */
  resetLocal: () => void;
  /** 人工编辑白盒文档（人有全权直改全文；AI 只走 append 窄门）——打字即存（1.2s 防抖落库） */
  updateDoc: (text: string) => void;
  /** 立即落库挂起的文档改动（行失焦/窗口失焦/关页时机调用）——幂等，无挂起也直接写一次 */
  flushDoc: () => void;
  /** 统一图文整理；省略选区=全图，显式空选区不执行。整次提交、整次撤销。 */
  tidyWhitebox: (selectionIds?: string[]) => Promise<TidyReport | null>;
  /** 生成/更新。有图默认走更新模式（防跳变）；fresh=true 推倒重画；live=现场模式（口语流+白盒双写）。
   *  live 模式下若产出纪要稿，随返回值带回（调用方插进 chat history） */
  generate: (input: string, opts?: { fresh?: boolean; source?: GenerateSource; userMsgCount?: number; live?: boolean; rewrite?: boolean }) => Promise<{ digest?: string; sourceIncomplete?: boolean } | undefined | void>;
  /** 重画（2026-09-06 用户拍）：不读对话，按 Log 里现有的判断、走向、承接整份重写文档与图；条目记「改写自」 */
  redrawFromLedger: () => Promise<{ sourceIncomplete?: boolean } | undefined | void>;
  updateNode: (id: string, updates: { title?: string; body?: string }) => void;
  /** 手动种一个判断；afterId 传入时新节点承接它（「↳ 接一条」）；返回新节点 id */
  addNode: (opts?: { title?: string; afterId?: string }) => string;
  setEditingNode: (id: string | null) => void;
  /** 手动牵一条承接线（🔗 连线）：方向=用户操作顺序；拒绝自环/重复/成环 */
  addEdgeManual: (from: string, to: string) => boolean;
  /** 三区拖放 · 中间：node 改为承接 target（替换全部入边；出边一根不动） */
  reattachAfter: (nodeId: string, targetId: string) => void;
  /** 三区拖放 · 上下沿：node 与 target 并列（复制 target 的承接来源），排它前/后 */
  alignAsSibling: (nodeId: string, targetId: string, before: boolean) => void;
  /** 收拢（L1→L2）：AI 初审提组 → 直接执行（AI 是初审法官，用户是上诉法院） */
  condense: () => Promise<void>;
  /** 拆开一个 L2 组（上诉动作）：删上层判断、成员回图面、边全量重算还原 */
  dissolveGroup: (l2Id: string) => void;
  /** 中止进行中的生成/更新：回滚到生成前的图（半批预览=废稿）；残流后台自弃 */
  cancelGeneration: () => void;
  /** 中止进行中的整理：整次丢弃；迟到结果不能影响下一次整理 */
  cancelTidy: () => void;
  /** 统一撤销（Ctrl+Z / toast 撤销按钮共用）：回退最近一步改图操作 */
  undo: () => void;
  redo: () => void;
  /** 同步框选/加选状态（View 的 selection changes 写入；Panel 的「整理」按它分流） */
  setSelectedNodes: (ids: string[]) => void;
  /** 批量删除（多选工具条）：一次入栈=一次 Ctrl+Z 全回；逐个桥接续链；L2=拆开 */
  deleteNodes: (ids: string[]) => void;
  /** 删节点同时删掉所有触及它的边（快照存入 lastDeleted 供撤销） */
  deleteNode: (id: string) => void;
  deleteEdge: (edgeId: string) => void;
  /** 标记节点已存入项目（P0③ 沉淀探针） */
  markSaved: (id: string) => void;
  /** 清除节点的未读红点（单击展开时调；已读的从视觉消失，跟 nodes 落库） */
  markNodeRead: (id: string) => void;
  /** 单节点整理（hover ✨）：问句→上下文找答案接上（?自动灭=结构性解决）；陈述→润色锐利 */
  refineNode: (id: string) => Promise<void>;
  // ===== AI 推进提议（2026-08-05）——与上面瞬态建议层语义相反：落库、默认保留、手动撤 =====
  /** 把一批推进建议落到图上（challenge→已有节点挂虚化? / add→虚线新节点+连边）。返回落图条数 */
  applyProposals: (items: Array<{ type: 'challenge' | 'supplement'; text: string; target?: string | null; newNode?: string | null }>) => number;
  /** 收下提议：challenge→标题补「？」转悬着 + 理由落 body / add→转正为常规节点 */
  acceptProposal: (nodeId: string) => void;
  /** 撤掉提议（×）：challenge→清标记恢复原状 / add→删除该节点 */
  dismissProposal: (nodeId: string) => void;
  clear: () => void;
  /** 直接编辑工作账全文（折算后视图立刻跟随）——打字即存（防抖落库） */
  updateLedger: (text: string) => void;
  /** 直接编辑原始记录（Log 页签）——只影响下次重画，不动视图 */
  updateRaw: (text: string) => void;
  // ===== 视图与收拢（2026-09-05/06 GFT-fix 线）=====
  setRightView: (view: 'map' | 'doc' | 'source') => void;
  /** 到 Log 看这一行：切到 Log 视图并定位到该 id 的行 */
  jumpToSource: (id: string) => void;
  clearSourceJump: () => void;
  /** 文档 ^id → 图上：切到 Map、打开并居中该节点 */
  focusOnMap: (id: string) => void;
  clearMapFocus: () => void;
  /** 图上节点 → 文档：切到 Doc、定位到该条目 */
  jumpToDoc: (id: string) => void;
  clearDocJump: () => void;
  /** Doc 编辑缓冲（打字只进缓冲，不落账） */
  setDocDraft: (text: string) => void;
  /** 把 Doc 缓冲里的改动按锚算成账行写进账，每条判断最多一行（切走视图/窗口失焦/关页/换图/任何 AI 动作前调） */
  flushDocEdits: () => void;
}

/** 当前内存态 → 落库载荷 */
function toPersisted(s: ThinkingMapState): PersistedThinkingMap {
  return {
    nodes: s.nodes,
    edges: s.edges,
    watermarks: Object.fromEntries(s.sourceWatermarks),
    doc: s.doc,
    ledger: s.ledger,
    raw: s.raw,
  };
}


// 首次图文同次返回名称；只替换默认名，不单独启动命名请求。
export { DEFAULT_PROJECT_NAME };

export { wouldCycle };

/** Each instance owns its timers, undo history, request epochs and cancellation. */
export function createThinkingMapStore(runtime: ThinkingMapRuntime): ThinkingMapStore {
  const {
    load: loadThinkingMap, loadCached: loadThinkingMapCached, save: saveThinkingMap,
    cachePending: cacheThinkingMapPending, hasPending: hasPendingThinkingMap,
    hasRemoteChanges: hasRemoteThinkingMapChanges, accept: acceptThinkingMap,
    insertCondensation, fetchSourceSnapshots,
  } = runtime.persistence;
  const loadInjectEnabled = () => runtime.preferences?.loadInjectEnabled() ?? true;
  const saveInjectEnabled = (on: boolean) => runtime.preferences?.saveInjectEnabled(on);
  let generationAbort: AbortController | null = null;
  let tidyAbort: AbortController | null = null;
  let refineAbort: AbortController | null = null;
  async function applySuggestedName(projectId: string | null, name?: string): Promise<void> {
    if (!projectId || !name) return;
    const project = runtime.host.getSnapshot().projects.find(p => p.id === projectId);
    if (project?.name !== DEFAULT_PROJECT_NAME) return;
    try {
      await runtime.host.renameProject(projectId, name);
    } catch (err) {
      // 失败不打扰用户——名字保持默认，下次生成再试；日志留给排查
      console.debug('🧭 脉络自动命名失败（下次生成再试）:', err instanceof Error ? err.message : err);
    }
  }

  // wouldCycle 已迁至公共类型层（type/thinkingMap.ts）——service 收拢边聚合也要用；re-export 保持既有 import 不变


  // ===== 统一撤销/重做栈（Ctrl+Z / Ctrl+Y / toast 撤销共用——多套撤销系统会打架）=====
  // 会话级内存栈：撤销管"当场反悔"，数据安全由 防抖落库+本地镜像+事件存证 三层兜底（刷新即清=业界惯例）。
  // zustand 不可变更新 ⟹ 快照=存旧数组引用，零拷贝成本。
  // doc 同帧入栈（08-27）：重画/整理会重写文档，Ctrl+Z 必须连文档一起退——
  // 否则退回旧图却留着新文档 = 锚对不上。字符串零拷贝，成本同 nodes/edges。
  interface UndoSnapshot { ledger: string; unreadIds: Set<string> }
  const UNDO_DEPTH = 20;
  let undoStack: UndoSnapshot[] = [];
  let redoStack: UndoSnapshot[] = [];

  /** 压显式快照（流式生成用：生成期间图已被预览污染，get() 取不到"生成前"——调用方自存快照） */
  function pushUndoSnapshot(snap: UndoSnapshot): void {
    undoStack.push(snap);
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    redoStack = []; // 新操作 → 旧的「重做」分支作废（标准编辑器语义）
  }

  /** 切换/重置图时清栈（跨图撤销=灾难）；手动节点挂账集合一并清（跨图不残留） */
  function clearUndo(): void {
    undoStack = [];
    redoStack = [];
    manualUnnotarized.clear();
  }

  // ===== 手动节点出生存证（2026-07-12 用户拍）=====
  // 手打节点=全系统唯一无备份的人类手笔（「你的话不可再生」——重画冲掉/整理覆盖后无处找回），
  // 与 AI 节点同等待遇：首次实质提交 title 时写一行 L0->L1 记账（inputs=你打的原文）。
  // 集合=内存态，跟踪"已创建但还没提交 title"的手动节点；刷新丢集合的边缘场景（加空节点
  // 就刷新、回来再补字→漏记一次）接受——比零备份强一个量级。
  const manualUnnotarized = new Set<string>();

  function notarizeManualNode(get: () => ThinkingMapState, id: string): void {
    const s = get();
    const node = s.nodes.find(n => n.id === id);
    const bound = s.boundProjectId;
    if (!node || !bound || !node.title.trim()) return;
    const content = node.body?.trim() ? `${node.title.trim()}\n${node.body.trim()}` : node.title.trim();
    store.setState({raw:appendSourceLog(s.raw,[{v:1,provider:'human',sessionId:'manual',id:`manual_${id}`,role:'user',content,title:'手动添加',ts:Date.now()}])});
    schedulePersist(get);
    void insertCondensation(bound, {
      layer: 'L0->L1',
      inputs: [{
        id: `manual_${id}`,
        role: 'user',
        name: null,
        content: node.body?.trim() ? `${node.title.trim()}\n${node.body.trim()}` : node.title.trim(),
        ts: Date.now(),
      }],
      outputs: [id],
      sourceMeta: { sessionId: 'manual', sessionTitle: '手动添加', fromId: `manual_${id}`, toId: `manual_${id}`, count: 1 },
    });
  }

  // ===== 软中断（2026-07-12 用户要求：进行中的按钮 hover 出提示、点击即中止）=====
  // 标志位丢弃后续流回调，残流后台自然结束——一次残流的 token 是零头，
  // 不值得为省它穿透三层 fetch 链做真 abort。中止语义按动作分流：
  // 生成中止=回滚到生成前（一锅蒸的半锅=废）；整理中止=停在当前步（每步独立成立，可 Ctrl+Z）。
  let generationRun = 0;
  // 身份每次激活都换代；A → B → A 时，第一轮 A 的迟到响应也没有写入权。
  let projectEpoch = 0;
  let activeGenSnapshot: UndoSnapshot | null = null;
  let activeGenBoundId: string | null = null; // 快照归属的项目(归属印章):切项目后中止/失败不许跨项目回滚
  let tidyRun = 0;

  // 防抖落库：变更密集时只写最后一笔（个人草稿，后写胜）
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** 保存时若发现外部写入（MCP agent），persist 层已合并写库——这里把合并结果反哺内存 */
  function absorbMerged(projectId: string, merged: PersistedThinkingMap | null, epoch: number): void {
    if (!merged || epoch !== projectEpoch) return;
    const st = store.getState();
    if (st.boundProjectId !== projectId) return; // 已切图,别把别的项目的数据灌进来
    ingestRemoteMap(merged);
  }

  function schedulePersist(get: () => ThinkingMapState): void {
    const current = get();
    if (current.boundProjectId) cacheThinkingMapPending(current.boundProjectId, toPersisted(current));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const s = get();
      if (!s.boundProjectId) return;
      const pid = s.boundProjectId;
      const epoch = projectEpoch;
      void saveThinkingMap(pid, toPersisted(s)).then(m => absorbMerged(pid, m, epoch)).catch(err => {
        if (projectEpoch === epoch) store.setState({ error: err instanceof Error ? err.message : '保存失败，本地修改已保留。' });
      });
    }, 1200);
  }

  /** 立刻把挂起的防抖写盘（切 project 前防丢最后一笔） */
  function flushPersist(s: ThinkingMapState): void {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (s.boundProjectId) {
      const pid = s.boundProjectId;
      const epoch = projectEpoch;
      void saveThinkingMap(pid, toPersisted(s)).then(m => absorbMerged(pid, m, epoch)).catch(err => {
        if (projectEpoch === epoch) store.setState({ error: err instanceof Error ? err.message : '保存失败，本地修改已保留。' });
      });
    }
  }


  // ===== 判断账（2026-09-05）：账是唯一正本，图/文档/分组全是折算缓存 =====

  /** 账文本 → 内存态（缓存一并折算）；extra 同帧写入 */
  function applyLedgerText(ledger: string, extra: Partial<ThinkingMapState> = {}): void {
    const s = store.getState();
    const { state, caches } = foldLedger(ledger, THINKING_MAP_PROJECT_ID, extra.unreadIds ?? s.unreadIds);
    store.setState({
      ledger,
      ledgerState: state,
      nodes: caches.nodes,
      edges: caches.edges,
      doc: caches.doc,
      groupMap: caches.groupMap,
      ...extra,
    });
  }

  /** 把 node 排到 target 前/后的「序」行（已经在那个位置就不写） */
  function placeLines(st: LedgerState, nodeId: string, targetId: string, where: 'before' | 'after'): string[] {
    const order = st.order;
    const ni = order.indexOf(nodeId);
    const ti = order.indexOf(targetId);
    if (ni === -1 || ti === -1) return [];
    if (where === 'before') return ni < ti ? [] : [decision.reorder(nodeId, targetId)];
    if (ni > ti) return [];
    const next = order.slice(ti + 1).find(id => id !== nodeId);
    return [decision.reorder(nodeId, next ?? '末')];
  }

  /** 追加账行 → 折算 → 落库；默认一次提交＝一帧撤销 */
  function commitLines(lines: string[], opts: { undo?: boolean; extra?: Partial<ThinkingMapState> } = {}): void {
    if (lines.length === 0) { if (opts.extra) store.setState(opts.extra); return; }
    const s = store.getState();
    if (opts.undo !== false) pushUndoSnapshot({ ledger: s.ledger, unreadIds: new Set(s.unreadIds) });
    applyLedgerText(appendLines(s.ledger, lines), opts.extra);
    schedulePersist(() => store.getState());
  }

  /** 远端来的一份图并入本地：账按只追加合并；远端仍走旧路写的节点/文档条目（MCP 服务端过渡期）转成账行并入。返回是否变了 */
  function ingestRemoteMap(remote: PersistedThinkingMap): boolean | null {
    const s = store.getState();
    // Remote refresh/save echoes must never submit or normalize an active draft.
    // The next refresh merges it after an explicit editing boundary.
    if (s.docDraft !== null) return null;
    let absorbed: ReturnType<typeof absorbLegacyRow>;
    let raw: string;
    try {
      const merged = mergeLedgerPair(s, remote);
      absorbed = absorbLegacyRow(merged.ledger, remote);
      raw = merged.raw;
    } catch (err) {
      store.setState({ error: err instanceof Error ? err.message : '同步发生冲突，已保留本地内容。' });
      return null;
    }
    // 远端（MCP 端点）新写的判断带未读：并进本地红点集合（端点把 unread 记在 nodes 缓存上，账本身不记视图态）
    const unreadIds = new Set(s.unreadIds);
    absorbed.newIds.forEach(id => unreadIds.add(id));
    for (const n of remote.nodes ?? []) if (n.unread) unreadIds.add(n.anchor ?? n.id);
    const sourceWatermarks = new Map(Object.entries(remote.watermarks));
    for (const [key, value] of s.sourceWatermarks) if (!key.startsWith('ext:')) sourceWatermarks.set(key, value);
    const watermarkChanged = sourceWatermarks.size !== s.sourceWatermarks.size || [...sourceWatermarks].some(([key, value]) => s.sourceWatermarks.get(key) !== value);
    const changed = absorbed.ledger !== s.ledger || raw !== s.raw || watermarkChanged || unreadIds.size !== s.unreadIds.size;
    if (changed) applyLedgerText(absorbed.ledger, { raw, sourceWatermarks, unreadIds });
    if (s.boundProjectId) acceptThinkingMap(s.boundProjectId, remote, toPersisted(store.getState()));
    return changed;
  }

  const store = create<ThinkingMapState & ThinkingMapActions>((set, get) => ({
    nodes: [],
    edges: [],
    sourceText: '',
    generation: 0,
    userEditedIds: new Set<string>(),
    savedIds: new Set<string>(),
    newIds: [],
    groupMap: new Map<string, string>(),
    sourceWatermarks: new Map<string, string>(),
    editingNodeId: null,
    selectedNodeIds: new Set<string>(),
    lastDeleted: null,
    boundProjectId: null,
    isHydrating: false,
    isGenerating: false,
    isCondensing: false,
    isTidying: false,
    isRefining: false,
    refiningNodeId: null,
    streamingCount: null,
    lastCondensedL2Ids: null,
    contextInjectEnabled: loadInjectEnabled(),
    doc: '',
    rightView: 'map',
    sourceJumpId: null,
    focusNodeId: null,
    docJumpId: null,
    docDraft: null,
    tidyRound: null,
    generateMode: null,
    ledger: '',
    raw: '',
    ledgerState: emptyLedgerState(),
    unreadIds: new Set<string>(),
    error: null,

    setContextInjectEnabled: (on: boolean) => {
      saveInjectEnabled(on);
      set({ contextInjectEnabled: on });
    },

    syncFromRemote: async () => {
      const pid = get().boundProjectId;
      const epoch = projectEpoch;
      if (!pid) return false;
      // 在途保存和待上传修改均算脏；保存时会检查远端版本并合入这次通知。
      const busy = (s: ThinkingMapState) => s.docDraft !== null || s.isGenerating || s.isTidying || s.isHydrating || saveTimer !== null || hasPendingThinkingMap(pid);
      if (busy(get())) return false;
      const remote = await loadThinkingMap(pid); // 读取不确认版本，实际接受之后才记。
      if (!remote) return false;
      const st = get();
      if (epoch !== projectEpoch || st.boundProjectId !== pid || busy(st)) return false;
      // 账只追加：合并后与本地相同＝回声，不动；不同＝远端有新行（含旧路写入并入）→ 折算替换
      const before = st.ledger;
      const changed = ingestRemoteMap(remote);
      if (!changed) return false;
      clearUndo(); // 跨版本撤销＝灾难（同"切换脉络清栈"定式）
      set({ newIds: [], editingNodeId: null, selectedNodeIds: new Set<string>(), lastDeleted: null, lastCondensedL2Ids: null });
      console.debug(`🧭 远端变更已同步：账 ${before.length} → ${get().ledger.length} 字`);
      return true;
    },

    hydrateForProject: async (projectId: string) => {
      if (!projectId || get().boundProjectId === projectId) return;
      get().cancelTidy();
      get().cancelGeneration();
      refineAbort?.abort();
      refineAbort = null;
      get().flushDocEdits();
      flushPersist(get()); // 旧图的最后一笔先落盘
      const epoch = ++projectEpoch;

      // 加载一份图：有账读账；没账但有旧数据（迁移前的行）→ 当场一次性转成账并回写；两者皆无＝空图
      const applyLoaded = (m: PersistedThinkingMap | null, hydrating: boolean) => {
        clearUndo(); // 换图清撤销栈（跨图撤销=灾难）
        const unreadIds = new Set((m?.nodes ?? []).filter(n => n.unread).map(n => n.anchor ?? n.id));
        const absorbed = absorbLegacyRow(m?.ledger ?? '', m ?? {});
        const { ledger, newIds: absorbedIds, warnings } = absorbed;
        let migrated = absorbed.migrated;
        if (warnings.length) console.warn('🧭 旧图转账告警：', warnings);
        absorbedIds.forEach(id => unreadIds.add(id));
        // 原始记录为空（070 之前的行）→ 从工作账剥出一次并回写
        let raw = m?.raw ?? '';
        if (!raw && ledger) { raw = stripToRaw(ledger); migrated = true; }
        applyLedgerText(ledger, {
          boundProjectId: projectId,
          unreadIds,
          raw,
          sourceWatermarks: new Map(Object.entries(m?.watermarks ?? {})),
          newIds: [],
          userEditedIds: new Set<string>(),
          savedIds: new Set<string>(),
          sourceText: '',
          selectedNodeIds: new Set<string>(),
          editingNodeId: null,
          lastDeleted: null,
          lastCondensedL2Ids: null,
          docDraft: null,
          sourceJumpId: null,
          focusNodeId: null,
          docJumpId: null,
          isRefining: false,
          refiningNodeId: null,
          isCondensing: false,
          error: null,
          isHydrating: hydrating,
          generation: get().generation + 1, // 换图 → remount + fitView
        });
        if (migrated && !hydrating) {
          console.info(`🧭 旧图已转成判断账（${ledger.split('\n').length} 行），回写落库`);
          schedulePersist(get);
        }
      };

      // SWR：本地镜像先瞬间上屏（刷新无空窗），网络真相回来再校正
      const cached = loadThinkingMapCached(projectId);
      const recovering = hasPendingThinkingMap(projectId);
      applyLoaded(cached, true); // 无镜像也是确定的空态，绝不把旧项目内容绑定到新 ID。
      const initialLedger = get().ledger;
      const initialRaw = get().raw;
      try {
        const loaded = await loadThinkingMap(projectId);
        if (epoch !== projectEpoch) return;
        const edited = recovering || get().ledger !== initialLedger || get().raw !== initialRaw || get().docDraft !== null;
        if (edited) {
          get().flushDocEdits();
          if (loaded) {
            if (hasRemoteThinkingMapChanges(projectId, loaded)) ingestRemoteMap(loaded);
            else acceptThinkingMap(projectId, loaded, toPersisted(get())); // 基准未变，本地撤销/Log 改字直接保留。
          }
          set({ isHydrating: false });
          schedulePersist(get);
        } else if (loaded && cached && JSON.stringify(loaded) === JSON.stringify(cached)) {
          set({ isHydrating: false }); // 镜像已是终态，不重建视图/撤销栈。
          acceptThinkingMap(projectId, loaded, toPersisted(get()));
        } else if (loaded || !cached) {
          applyLoaded(loaded, false);
          if (loaded) acceptThinkingMap(projectId, loaded, toPersisted(get()));
        } else {
          set({ isHydrating: false });
        }
      } catch (error) {
        if (epoch === projectEpoch) set({ isHydrating: false, error: error instanceof Error ? error.message : '加载失败，本地内容已保留。' });
      }
    },

    updateDoc: (_text: string) => {
      // 文档已是账的折算视图，不再直接编辑；改底层走 updateLedger（Doc 面板「源」模式）
      console.warn('🧭 updateDoc 已退役：白盒文档由判断账折算，请编辑账（updateLedger）');
    },

    updateRaw: (text: string) => {
      if (!get().boundProjectId || get().raw === text) return;
      set({ raw: text });
      schedulePersist(get);
    },

    updateLedger: (text: string) => {
      if (!get().boundProjectId) return;
      applyLedgerText(text);
      schedulePersist(get); // 打字每键触发——防抖落库（行失焦/窗口失焦经 flushDoc 提前收账）
    },

    flushDoc: () => {
      if (!saveTimer) return; // 没有挂起的防抖=没有未落库的改动，不空写
      flushPersist(get());
    },

    tidyWhitebox: async (selectionIds) => {
      // 整理含收拢：参考 tidyTarget，承接与转折优先；有安全的进展才继续，最多 TIDY_MAX_ROUNDS 轮；
      // 合并＝新判断「合并自」成员（成员退休、边自动改接），去掉、改锐利、走向重写；全部一次提交＝一帧撤销
      get().flushDocEdits();
      const s = get();
      if (!s.boundProjectId || s.isTidying || s.isGenerating || s.isRefining) return null;
      const bound = s.boundProjectId;
      const base = s.ledger;
      const rawBase = s.raw;
      const source = rawBase.trim() ? parseLedger(rawBase) : undefined;
      const scope = selectionIds === undefined ? undefined : new Set(selectionIds);
      const countInScope = (state: LedgerState) => liveJudgments(state).filter(j => !scope || scope.has(j.id)).length;
      const before = countInScope(s.ledgerState);
      if (before === 0 && (scope || !s.doc.trim())) return null;
      if (scope) {
        const alive = new Set(liveJudgments(s.ledgerState).map(j => j.id));
        for (const id of scope) if (!alive.has(id)) scope.delete(id);
      }
      const textBefore = docChars(s.ledgerState);
      const target = tidyTarget(before);
      const run = ++tidyRun;
      const controller = new AbortController();
      tidyAbort = controller;
      const context = { projectId: bound, signal: controller.signal };
      set({ isTidying: true, tidyRound: 0, error: null });
      const lines: string[] = [sessionLine(Date.now(), '本地', scope ? '整理选中' : '整理')];
      let text = appendLines(base, lines);
      let cur = parseLedger(text);
      const newIds: string[] = [];
      let merged = 0, dropped = 0, applied = 0, rounds = 0;
      let consolidationRetry = false;
      let retriedConsolidation = false;
      try {
        const modelId = runtime.host.getSnapshot().currentSession?.modelId;
        for (let round = 1; round <= TIDY_MAX_ROUNDS; round++) {
          const count = countInScope(cur);
          if (round > 1 && count <= target) break;
          set({ tidyRound: round });
          rounds = round;
          const ops = await runtime.ai.tidy({ ...tidyInput(cur, get().unreadIds, source), sourceDoc: renderSourceLog(rawBase), target, consolidationRetry, ...(scope ? { scopeIds: [...scope] } : {}) }, modelId ? { modelId } : undefined, context);
          if (run !== tidyRun) return null; // 取消、切图或重新开始后，旧结果不再有权落账
          if (get().boundProjectId !== bound) { set({ isTidying: false, tidyRound: null }); return null; } // 期间切图 → 丢弃
          const r = tidyOpsToLines(cur, ops, source, scope);
          lines.push(...r.lines);
          newIds.push(...r.newIds);
          merged += r.merged;
          dropped += r.dropped;
          applied += ops.length;
          text = appendLines(text, r.lines);
          cur = parseLedger(text);
          if (scope) {
            r.newIds.forEach(id => scope.add(id));
            const alive = new Set(liveJudgments(cur).map(j => j.id));
            for (const id of scope) if (!alive.has(id)) scope.delete(id);
          }
          if (ops.some(op => op.kind === 'add')) break;
          if (countInScope(cur) >= count) {
            if (count <= target || retriedConsolidation) break;
            consolidationRetry = true;
            retriedConsolidation = true;
          } else consolidationRetry = false;
        }
        get().flushDocEdits(); // 正在输入、尚未失焦的 Doc 草稿也先纳入并发检查
        if (get().ledger !== base || get().raw !== rawBase) {
          set({ isTidying: false, tidyRound: null, error: '整理期间账被改动，这次作废——再点一次「整理」' });
          return null;
        }
        const edgesNow = get().edges.length;
        if (applied === 0) {
          set({ isTidying: false, tidyRound: null, selectedNodeIds: new Set<string>() });
          return { changed: false, entries: liveJudgments(s.ledgerState).length, mergedGroups: 0, dropped: 0, added: 0, edges: edgesNow, before, after: before, textBefore, textAfter: textBefore, rounds };
        }
        // 合出来的判断：成员有未读的就带红点；退休的成员不再算未读
        const unreadIds = new Set(get().unreadIds);
        for (const id of newIds) {
          const j = cur.judgments.get(id);
          if (j?.mergedFrom.some(m => unreadIds.has(m))) unreadIds.add(id);
          j?.mergedFrom.forEach(m => unreadIds.delete(m));
        }
        commitLines(lines, { extra: { isTidying: false, tidyRound: null, unreadIds, selectedNodeIds: new Set<string>() } });
        const after = countInScope(get().ledgerState);
        const textAfter = docChars(get().ledgerState);
        console.debug(`🧹 整理完成: ${before}→${after} 条，${textBefore}→${textAfter} 字，${rounds} 轮`);
        return { changed: true, entries: liveJudgments(cur).length, mergedGroups: merged, dropped, added: newIds.length, edges: get().edges.length, before, after, textBefore, textAfter, rounds };
      } catch (err) {
        if (run !== tidyRun) return null; // 旧任务的报错也不能清掉新任务的状态
        console.error('❌ 整理失败:', err);
        set({ isTidying: false, tidyRound: null, error: err instanceof Error ? err.message : '整理失败' });
        return null;
      } finally {
        if (tidyAbort === controller) tidyAbort = null;
      }
    },

    resetLocal: () => {
      get().cancelTidy();
      get().cancelGeneration();
      refineAbort?.abort();
      refineAbort = null;
      projectEpoch++;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } // 丢弃挂起的落库（项目已删/已退出）
      set({ docDraft: null, raw: '' });
      clearUndo();
      set(s => ({
        nodes: [],
        edges: [],
        ledger: '',
        ledgerState: emptyLedgerState(),
        unreadIds: new Set<string>(),
        sourceText: '',
        newIds: [],
        userEditedIds: new Set<string>(),
        savedIds: new Set<string>(),
        groupMap: new Map<string, string>(),
        sourceWatermarks: new Map<string, string>(),
        doc: '',
        editingNodeId: null,
        selectedNodeIds: new Set<string>(),
        lastDeleted: null,
          boundProjectId: null,
          isHydrating: false,
          isRefining: false,
          refiningNodeId: null,
          isCondensing: false,
          sourceJumpId: null,
          focusNodeId: null,
          docJumpId: null,
        error: null,
        generation: s.generation + 1,
      }));
    },

    generate: async (input: string, opts?: { fresh?: boolean; source?: GenerateSource; userMsgCount?: number; live?: boolean; rewrite?: boolean }) => {
      const trimmed = input.trim();
      // 互斥补齐(2026-07-18 猎捕确认项):tidy/refine 的入口都拦 isGenerating,唯独 generate
      // 不拦它们——整理流式进行中仍可点「更新脉络」,两路 AI 交错写图,节点/边/撤销栈错乱。
      const st0 = get();
      if (!trimmed || st0.isGenerating || st0.isTidying || st0.isRefining || st0.isCondensing) return;
      get().flushDocEdits();
      const state = get();
      const isUpdate = !opts?.fresh && state.nodes.length > 0;
      set({ isGenerating: true, generateMode: opts?.rewrite ? 'redraw' : 'update', error: null, streamingCount: 0 });
      // 生成前快照：流式预览会实时改图，失败恢复/成功入撤销栈/用户中止回滚都以它为准
      const prevSnapshot: UndoSnapshot = { ledger: state.ledger, unreadIds: new Set(state.unreadIds) };
      const run = ++generationRun;
      const controller = new AbortController();
      generationAbort = controller;
      const context = { projectId: state.boundProjectId, signal: controller.signal };
      activeGenSnapshot = prevSnapshot;
      const boundAtStart = state.boundProjectId;
      activeGenBoundId = boundAtStart;
      let previewedFirstFrame = false;
      // 重画=推倒重来，无锚（2026-07-12 用户拍：重画就是重画；保守改进用「整理」）
      try {
        // 模型跟随当前 session（dogfood 时可 @ 换模型对比蒸馏质量）
        const modelId = runtime.host.getSnapshot().currentSession?.modelId;
        const result = await runtime.ai.generate(trimmed, {
          suggestName: runtime.host.getSnapshot().projects.find(p => p.id === boundAtStart)?.name === DEFAULT_PROJECT_NAME,
          ...(isUpdate
            ? { previousMap: { nodes: state.nodes, edges: state.edges } }
            : {}),
          ...(modelId ? { modelId } : {}),
          ...(opts?.userMsgCount ? { userMsgCount: opts.userMsgCount } : {}),
          ...(opts?.live ? { live: true } : {}),
          ...(opts?.rewrite ? { rewrite: true } : {}),
          ...(themeOf(state.ledgerState) ? { theme: themeOf(state.ledgerState) } : {}),
          // 白盒文档全文进 AI 上下文（08-27 用户拍：文档+图都参考，信息量越多越好；
          // 手写内容进视野、已有判断不重复产；文档侧输出以它为操作对象）。按 Log 重画时文档就是 input 本身，不再重复喂
          ...(state.doc.trim() && !opts?.rewrite ? { whiteboxDoc: renderSourceDoc(state.ledgerState) } : {}),
        }, (preview) => {
          // 流式预览上图（纯视觉：不 persist、不动水位；权威收尾同 ctx 同 id，无缝接管）
          if (run !== generationRun) return;
          if (get().boundProjectId !== boundAtStart) return; // 期间切了图 → 丢弃
          const newCount = isUpdate
            ? Math.max(0, preview.nodes.length - state.nodes.length)
            : preview.nodes.length;
          // 重画整份图文完成后一次替换，避免半成品先闪到画布再回滚。
          if (opts?.rewrite) { set({ streamingCount: newCount }); return; }
          set(s => ({
            nodes: preview.nodes,
            edges: preview.edges,
            streamingCount: newCount,
            // 重画/首次的第一帧 remount+fitView 一次（旧图已被新图预览替换，视口对到新图）；后续帧不动视口
            generation: !isUpdate && !previewedFirstFrame ? s.generation + 1 : s.generation,
          }));
          previewedFirstFrame = true;
        }, context);
        if (run !== generationRun) return;
        // 期间切图 → 结果作废（图归属已变，别把别人图覆盖掉）
        if (get().boundProjectId !== boundAtStart) {
          activeGenSnapshot = null; // 悬挂快照一并清(防此后误用)
          activeGenBoundId = null;
          set({ isGenerating: false, streamingCount: null });
          return;
        }
        activeGenSnapshot = null;
        activeGenBoundId = null;
        let sourceIncomplete = false;
        // ===== 账为正本：AI 产出 → 账行（场次头 / 走向 / 判断 / 承接 / 改标；重画先写「重画」行）→ 折算成图与文档 =====
        {
          const st = get();
          const at = Date.now();
          const sourceTag = opts?.source ? `chat:${opts.source.sessionId}` : '本地';
          const note = opts?.live ? '现场' : isUpdate ? '更新' : opts?.rewrite ? '重画（按 Log 重写）' : '重画';
          if (st.ledger !== state.ledger || (opts?.rewrite && st.raw !== state.raw)) throw new Error('生成期间内容已变化，已保留当前图，请重新生成。');
          const generated = linesFromGenerate(st.ledgerState, result, { isUpdate: !opts?.rewrite, source: sourceTag, note, at, ...(opts?.rewrite ? { provenanceSource: parseLedger(state.raw) } : {}) });
          const { lines } = generated;
          const newIds = isUpdate ? generated.newIds : [];
          sourceIncomplete = generated.sourceIncomplete;
          // 未读红点：只标增量更新新长出来的（首次/重画整图皆新，标了=满屏红点无意义）
          const unreadIds = new Set(isUpdate ? st.unreadIds : []);
          newIds.forEach(id => unreadIds.add(id));
          // 水位只推进本批来源；空图不重置其他来源，重画不碰水位。
          const sourceWatermarks = new Map(st.sourceWatermarks);
          if (opts?.source) sourceWatermarks.set(opts.source.sessionId, opts.source.lastMessageId);
          set({ unreadIds });
          // 原文独立保存，不受模型是否输出判断或主题过滤影响；重画只写工作账。
          const raw = opts?.rewrite ? st.raw : appendSourceLog(st.raw, opts?.source?.snapshot?.length
            ? sourceRecordsFromEvents([{layer:'L0->L1', inputs:opts.source.snapshot, sourceMeta:opts.source}])
            : [{v:1,provider:'manual',sessionId:'submitted',id:`input:${at}`,role:'user',content:input,title:'导入材料',ts:at}]);
          pushUndoSnapshot(prevSnapshot);
          applyLedgerText(appendLines(st.ledger, lines), {
            raw,
            sourceWatermarks,
            sourceText: trimmed,
            newIds,
            generation: opts?.rewrite ? st.generation + 1 : st.generation,
            ...(isUpdate ? {} : { userEditedIds: new Set<string>(), savedIds: new Set<string>() }),
            isGenerating: false,
            streamingCount: null,
          });
        }
        schedulePersist(get);
        void applySuggestedName(boundAtStart, result.suggestedName);
        // 塔基存证：这批节点 ← 这段消息（跨域快照，chat 删除后塔基仍完整）。
        // 即使主题过滤后零产出，也保留本次已接收来源。
        const bound = get().boundProjectId;
        const src = opts?.source;
        const outputs = isUpdate ? get().newIds : get().nodes.map(n => n.id);
        // 来源存证只追加；重画不删除或再次导入来源。
        if (bound) {
          const ev = src?.snapshot?.length && !opts?.rewrite ? {
            layer: 'L0->L1' as const,
            inputs: src.snapshot,
            outputs,
            sourceMeta: {
              sessionId: src.sessionId,
              sessionTitle: src.sessionTitle ?? '',
              fromId: src.snapshot[0].id,
              toId: src.lastMessageId,
              count: src.snapshot.length,
            },
          } : null;
          if (ev) {
            void insertCondensation(bound, ev);
          }
        }
        console.debug(`🧭 ${isUpdate ? '增量更新' : '生成'}: ${result.nodes.length} 节点 / ${result.edges.length} 边 / 新 ${result.newIds.length}`);
            // 建议不再自动跑（2026-07-10 用户拍板：效果未稳定，改手动按钮 requestSuggestions 触发；稳定后再回异步）
        return { ...(result.digest ? { digest: result.digest } : {}), ...(opts?.rewrite ? { sourceIncomplete } : {}) };
      } catch (err) {
        if (run !== generationRun) return;
        console.error('❌ 思维导航生成失败:', err);
        // 归属印章(2026-07-18 猎捕确认项):成功路径两处都校验 boundProjectId(预览/收尾),
        // 失败恢复却没有——生成期间切了项目,这里会把 A 的旧图整张写进 B 的内存态,随后
        // B 上任意编辑落库=B 的真实脉络被 A 静默覆盖。切走=只复位状态不写图(A 的图在库里原样)。
        if (get().boundProjectId !== boundAtStart) {
          set({ isGenerating: false, streamingCount: null });
          return;
        }
        // 失败恢复生成前快照（流式预览可能已上图半截）——用户已有的图一根毫毛不少
        if (get().ledger !== prevSnapshot.ledger) {
          set({ isGenerating: false, streamingCount: null, error: err instanceof Error ? err.message : '生成失败，当前修改已保留。' });
          return;
        }
        applyLedgerText(prevSnapshot.ledger, {
          isGenerating: false,
          streamingCount: null,
          error: err instanceof Error ? err.message : '生成失败',
        });
      } finally {
        if (generationAbort === controller) generationAbort = null;
      }
    },

    cancelGeneration: () => {
      if (!get().isGenerating) return;
      generationRun++;
      generationAbort?.abort();
      generationAbort = null;
      const snap = activeGenSnapshot;
      const snapBound = activeGenBoundId;
      activeGenSnapshot = null;
      activeGenBoundId = null;
      // 立即回滚+复位（残流回调全被 genCancelled 挡掉）；视野不动（用户定则）
      // 归属印章(2026-07-18 猎捕确认项):快照属于生成【启动时】的项目;切过项目后按「中止」,
      // 只复位状态、绝不把 A 的旧图写进当前(B)的内存态。
      const sameProject = snapBound != null && snapBound === get().boundProjectId;
      if (snap && sameProject) applyLedgerText(snap.ledger);
      set({ isGenerating: false, streamingCount: null });
    },

    cancelTidy: () => {
      if (!get().isTidying) return;
      tidyRun++;
      tidyAbort?.abort();
      tidyAbort = null;
      set({ isTidying: false, tidyRound: null, selectedNodeIds: new Set<string>() });
    },

    updateNode: (id, updates) => {
      const before = get();
      const j = before.ledgerState.judgments.get(id);
      if (!j) return;
      const lines: string[] = [];
      if (updates.title !== undefined && updates.title.trim() && updates.title.trim() !== j.title) lines.push(decision.retitle(id, updates.title));
      if (updates.body !== undefined && updates.body.trim() !== j.content.trim()) lines.push(...decision.rewrite(id, updates.body));
      const raw = manualUnnotarized.has(id) ? before.raw : recordDocumentInput(before.raw, before.ledgerState, parseLedger(appendLines(before.ledger, lines)));
      commitLines(lines, { extra: { raw, userEditedIds: new Set(get().userEditedIds).add(id) } }); // 提交级入栈
      // 手动节点的首次实质提交 → 补出生存证
      if (manualUnnotarized.has(id) && get().nodes.find(n => n.id === id)?.title.trim()) {
        manualUnnotarized.delete(id);
        notarizeManualNode(get, id);
      }
    },

    addNode: (opts?: { title?: string; afterId?: string }) => {
      const st = get().ledgerState;
      const id = `j${st.nextNum}`;
      const after = opts?.afterId && st.judgments.has(opts.afterId) ? opts.afterId : undefined;
      const domain = after ? st.judgments.get(after)!.domain : '';
      const lines = [
        sessionLine(Date.now(), '本地', '手动'),
        ...judgmentLines(id, '◇', domain, opts?.title?.trim() || '未命名', ''),
        ...(after ? [relationLine(id, after)] : []), // 「↳ 接一条」：新节点承接指定节点
      ];
      commitLines(lines, { extra: { userEditedIds: new Set(get().userEditedIds).add(id) } }); // 手动种的天然算"我的"
      // 带 title 创建=当场记账；空 title（图上就地编辑）=挂账，首次提交时补（updateNode 钩子）
      if (opts?.title?.trim()) notarizeManualNode(get, id);
      else manualUnnotarized.add(id);
      return id;
    },

    setEditingNode: (id) => set({ editingNodeId: id }),

    addEdgeManual: (a, b) => {
      const s = get();
      if (a === b) return false;
      const na = s.nodes.find(n => n.id === a);
      const nb = s.nodes.find(n => n.id === b);
      if (!na || !nb) return false;
      // 图是时间线：承接只从早指向晚，方向由两端的时间定，不由拖的顺序定
      const [from, to] = na.order <= nb.order ? [a, b] : [b, a];
      if (s.edges.some(e => e.from === from && e.to === to)) return false; // 重复
      if (wouldCycle(s.edges, from, to)) return false; // 真循环
      commitLines([decision.link(to, from)]);
      return true;
    },

    reattachAfter: (nodeId, targetId) => {
      const s = get();
      if (nodeId === targetId) return;
      if (wouldCycle(s.edges.filter(e => e.to !== nodeId), targetId, nodeId)) return; // 防循环
      // 图是时间线：接到 target 后面＝顺着它来，也就排到它后面（序），线才画得出来
      const lines = [
        ...s.edges.filter(e => e.to === nodeId).map(e => decision.unlink(nodeId, e.from)), // 替换全部入边
        decision.link(nodeId, targetId),
        ...placeLines(s.ledgerState, nodeId, targetId, 'after'),
      ];
      commitLines(lines, { extra: { userEditedIds: new Set(get().userEditedIds).add(nodeId) } });
    },

    alignAsSibling: (nodeId, targetId, before) => {
      const s = get();
      if (nodeId === targetId) return;
      if (!s.nodes.some(n => n.id === targetId)) return;
      const targetIncoming = s.edges.filter(e => e.to === targetId);
      const rest = s.edges.filter(e => e.to !== nodeId);
      if (targetIncoming.some(e => wouldCycle(rest, e.from, nodeId))) return; // 来源不能在 node 的下游
      // 复制 target 的承接来源（target 是起点则 node 也变起点），并排到 target 前/后（序）
      const lines = [
        ...s.edges.filter(e => e.to === nodeId).map(e => decision.unlink(nodeId, e.from)),
        ...targetIncoming.map(e => decision.link(nodeId, e.from)),
        ...placeLines(s.ledgerState, nodeId, targetId, before ? 'before' : 'after'),
      ];
      commitLines(lines, { extra: { userEditedIds: new Set(get().userEditedIds).add(nodeId) } });
    },

    condense: async () => {
      // 旧 L2 收拢（塔基快照制）在账模型下退役：核心层的收拢走 condenseCore（⊃ 行）
      set({ error: '旧版收拢已退役，请用「整理」' });
    },

    dissolveGroup: (l2Id) => {
      const j = get().ledgerState.judgments.get(l2Id);
      if (!j || j.deleted) return;
      commitLines([decision.remove(l2Id)], { extra: { selectedNodeIds: new Set<string>() } });
    },

    undo: () => {
      get().flushDocEdits();
      const snap = undoStack.pop();
      if (!snap) return;
      const cur = get();
      redoStack.push({ ledger: cur.ledger, unreadIds: new Set(cur.unreadIds) }); // 当前态存起来，可被 Ctrl+Y 拉回
      if (redoStack.length > UNDO_DEPTH) redoStack.shift();
      // 不 bump generation：撤回不改变用户当前视野（2026-07-12 用户定则）
      set({ unreadIds: new Set(snap.unreadIds) });
      applyLedgerText(snap.ledger, { lastDeleted: null, lastCondensedL2Ids: null, editingNodeId: null, selectedNodeIds: new Set<string>() });
      schedulePersist(get);
    },

    redo: () => {
      get().flushDocEdits();
      const snap = redoStack.pop();
      if (!snap) return;
      const cur = get();
      undoStack.push({ ledger: cur.ledger, unreadIds: new Set(cur.unreadIds) }); // 当前态回撤销栈（不走 pushUndo：那会清空 redo）
      if (undoStack.length > UNDO_DEPTH) undoStack.shift();
      set({ unreadIds: new Set(snap.unreadIds) });
      applyLedgerText(snap.ledger, { lastDeleted: null, lastCondensedL2Ids: null, editingNodeId: null, selectedNodeIds: new Set<string>() });
      schedulePersist(get);
    },

    setSelectedNodes: (ids) => {
      set(state => {
        // 引用稳定：集合内容没变就不换对象（selection change 每帧可能触发）
        if (ids.length === state.selectedNodeIds.size && ids.every(id => state.selectedNodeIds.has(id))) return state;
        return { selectedNodeIds: new Set(ids) };
      });
    },

    deleteNodes: (ids) => {
      const st = get().ledgerState;
      const valid = ids.filter(id => st.judgments.has(id) && !st.judgments.get(id)!.deleted);
      if (valid.length === 0) return;
      // 删掉的节点由渲染自动短路（上游×下游接上），账里只记删
      const lines = valid.map(id => decision.remove(id));
      commitLines(lines, { extra: { lastDeleted: null, selectedNodeIds: new Set<string>() } });
    },

    deleteNode: (id) => {
      const st = get().ledgerState;
      const j = st.judgments.get(id);
      if (!j || j.deleted) return;
      // 选中集合同步清空——被删 id 残留=幽灵（2026-07-11 dogfood 实测抓获）；短路由渲染做
      commitLines([decision.remove(id)], { extra: { selectedNodeIds: new Set<string>() } });
    },

    deleteEdge: (edgeId) => {
      const e = get().edges.find(x => x.id === edgeId);
      if (!e) return;
      commitLines([decision.unlink(e.to, e.from)]);
    },

    markSaved: (id) => {
      set(state => ({ savedIds: new Set(state.savedIds).add(id) }));
    },

    markNodeRead: (id) => {
      const s = get();
      if (!s.unreadIds.has(id)) return; // 没红点=不用改，省一次 set + 落库
      const unreadIds = new Set(s.unreadIds);
      unreadIds.delete(id);
      set({ unreadIds, nodes: s.nodes.map(n => (n.id === id ? { ...n, unread: undefined } : n)) });
      schedulePersist(get);
    },

    refineNode: async (id) => {
      get().flushDocEdits();
      const state = get();
      if (state.isRefining || state.isGenerating || state.isTidying) return;
      const target = state.nodes.find(n => n.id === id);
      if (!target) return;
      const bound = state.boundProjectId;
      const epoch = projectEpoch;
      const controller = new AbortController();
      refineAbort = controller;
      const context = { projectId: bound, signal: controller.signal };
      set({ isRefining: true, refiningNodeId: id, error: null }); // 节点级加载态：反馈在节点本体，不挂 hover 浮层
      try {
        // 语境：图上邻居（1 跳）+ 出生快照（手动节点=空）+ 最近对话（粗记时通常刚聊过）
        const visEdges = state.edges;
        const up = visEdges.filter(e => e.to === id).map(e => state.nodes.find(n => n.id === e.from)).filter((n): n is FocusCard => !!n);
        const down = visEdges.filter(e => e.from === id).map(e => state.nodes.find(n => n.id === e.to)).filter((n): n is FocusCard => !!n);
        const birth = bound ? await fetchSourceSnapshots(bound, [id]).catch(() => '') : '';
        if (epoch !== projectEpoch || get().boundProjectId !== bound) return;
        const settled = runtime.host.getSnapshot().chatHistory.filter(m => m.status !== 'streaming');
        const chatTail = buildChatText(settled.slice(-12));
        const modelId = runtime.host.getSnapshot().currentSession?.modelId;
        const result = await runtime.ai.refine(target, { up, down }, birth, chatTail, modelId ? { modelId } : undefined, context);
        if (epoch !== projectEpoch || get().boundProjectId !== bound) return;
        if (result.kind === 'revise' && result.title) {
          commitLines([`AI 改 ${id} 标题：${result.title.trim()}`], { extra: { isRefining: false, refiningNodeId: null } });
          console.debug('✨ 整理: 节点已润色');
        } else {
          console.debug('✨ 整理: AI 认为节点已足够好（noop）');
          set({ isRefining: false, refiningNodeId: null });
        }
      } catch (err) {
        if (epoch !== projectEpoch) return;
        console.error('❌ 整理失败:', err);
        set({ isRefining: false, refiningNodeId: null, error: err instanceof Error ? err.message : '整理失败' });
      } finally {
        if (refineAbort === controller) refineAbort = null;
      }
    },


    // 校对瞬态建议层（requestSuggestions/confirmSuggestion/rejectSuggestion）已删（2026-08-06 用户拍）：
    // 入口 07-12 已撤、与推进提议层语义相反（沉默即否决 vs 沉默即接受）。需要时从 git 历史取回。

    applyProposals: (items) => {
      // AI 推进提议落账：质疑→「AI 标 ？」（挂问号，理由进表述）；补充→新判断（◇）承接锚点。
      // 孤立节点没有意义——找不到锚点就丢弃（2026-08-05 用户拍板）
      const st = get().ledgerState;
      const visible = get().nodes;
      const byTitle = new Map(visible.map(n => [n.title.trim(), n] as const));
      const findAnchor = (raw?: string | null): FocusCard | undefined => {
        const t = raw?.trim();
        if (!t) return undefined;
        return byTitle.get(t) ?? visible.find(n => n.title.trim().includes(t) || t.includes(n.title.trim()));
      };
      const lines: string[] = [];
      const newIds: string[] = [];
      let n = st.nextNum;
      const challenged = new Set<string>();
      for (const it of items) {
        if (it.type === 'challenge') {
          const target = findAnchor(it.target);
          if (!target || target.unresolved || target.superseded || challenged.has(target.id)) continue;
          challenged.add(target.id);
          lines.push(`AI 标 ${target.id} ？ ${it.text.trim()}`);
        } else if (it.newNode?.trim()) {
          const title = it.newNode.trim();
          if (byTitle.has(title)) continue;
          const anchor = findAnchor(it.target);
          if (!anchor) continue;
          const id = `j${n++}`;
          newIds.push(id);
          lines.push(...judgmentLines(id, '◇', st.judgments.get(anchor.id)?.domain ?? '', title, it.text.trim()), relationLine(id, anchor.id));
        }
      }
      if (lines.length === 0) return 0;
      const unreadIds = new Set(get().unreadIds);
      newIds.forEach(id => unreadIds.add(id));
      commitLines([sessionLine(Date.now(), '本地', '推进提议'), ...lines], { extra: { unreadIds } });
      return challenged.size + newIds.length;
    },

    acceptProposal: (nodeId) => {
      const j = get().ledgerState.judgments.get(nodeId);
      if (!j || j.deleted) return;
      commitLines([decision.remark(nodeId, '◆')]); // 收下＝转正，同权不留血统
    },

    dismissProposal: (nodeId) => {
      const j = get().ledgerState.judgments.get(nodeId);
      if (!j || j.deleted) return;
      // 质疑（挂了问号）撤掉＝恢复推断档；补充的新判断撤掉＝删
      commitLines([j.mark === '？' ? decision.remark(nodeId, '◇') : decision.remove(nodeId)]);
    },

    redrawFromLedger: async () => {
      get().flushDocEdits();
      const s = get();
      if (!s.boundProjectId || s.isGenerating || s.isTidying) return;
      // 原料＝原始记录（Log），不是工作账：Doc 删空了也能重画
      if (!hasSourceLog(s.raw)) return;
      const input = renderSourceLog(s.raw);
      return get().generate(input, { fresh: true, rewrite: true });
    },

    setDocDraft: (text) => { if (get().boundProjectId && get().docDraft !== text) set({ docDraft: text }); },

    flushDocEdits: () => {
      const s = get();
      if (s.docDraft === null) return;
      const draft = s.docDraft;
      set({ docDraft: null });
      if (!s.boundProjectId) return;
      const { lines, newIds } = docEditLines(s.ledgerState, draft);
      if (lines.length === 0) return;
      const raw = recordDocumentInput(s.raw, s.ledgerState, parseLedger(appendLines(s.ledger, lines)));
      commitLines(lines, {extra:{raw}}); // Only committed human input enters Log.
      console.debug(`📝 文档编辑落账：${lines.length} 行，新条目 ${newIds.length}`);
    },

    setRightView: (view) => {
      const s = get();
      if (s.rightView === view) return;
      if (s.rightView === 'doc') s.flushDocEdits(); // 切走 Doc＝这一段编辑落账
      set({ rightView: view });
    },

    jumpToSource: (id) => {
      if (get().rightView === 'doc') get().flushDocEdits();
      set({ rightView: 'source', sourceJumpId: id });
    },

    clearSourceJump: () => { if (get().sourceJumpId) set({ sourceJumpId: null }); },

    focusOnMap: (id) => {
      if (get().rightView === 'doc') get().flushDocEdits();
      set({ rightView: 'map', focusNodeId: id });
    },

    clearMapFocus: () => { if (get().focusNodeId) set({ focusNodeId: null }); },

    jumpToDoc: (id) => set({ rightView: 'doc', docJumpId: id }),

    clearDocJump: () => { if (get().docJumpId) set({ docJumpId: null }); },

    clear: () => {
      clearUndo();
      applyLedgerText('', {
        unreadIds: new Set<string>(),
        sourceText: '',
        newIds: [],
        userEditedIds: new Set<string>(),
        savedIds: new Set<string>(),
        sourceWatermarks: new Map<string, string>(),
        selectedNodeIds: new Set<string>(),
        error: null,
      });
      schedulePersist(get);
    },

  }));

  return store;
}
