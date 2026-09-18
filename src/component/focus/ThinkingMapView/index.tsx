/**
 * ThinkingMapView — 思维导航的 reactflow 图视图（阶段1 demo）
 * 与 ExploreTreeView（单父树）刻意分离：这里是多对多的时序 DAG（边永远从早指向晚）。
 *  - 布局：dagre TB——拓扑=时序承接，往下=更晚；acyclicer=greedy 仅作渲染兜底（数据层已保证无环）
 *  - 节点皮复用 ExploreTreeNode：optional 回调 = 能力裁剪，不传的按钮自动消失
 *  - 边=朴素连线+箭头（不分类型）；点边出工具条（删除）
 *  - 取代/分组只在数据层默默积累（收拢时作为整理建议），图上不渲染——"给不出便宜纠错动作的 AI 提议不展示"
 */

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import ReactFlow, { Background, BaseEdge, getSmoothStepPath, getRectOfNodes } from 'reactflow';
import type { Node, Edge, NodeChange, ReactFlowInstance, EdgeProps, Position } from 'reactflow';
import { layoutGraph, estimateNodeHeight, NODE_WIDTH, type MeasuredSizes } from './layout';
import { confirmDialog } from '../../common/ConfirmDialog';
import { useThinkingMapRuntime } from '../ThinkingMapRuntime';
import { wouldCycle } from '../../../type/thinkingMap';
import { ExploreTreeNode, type ExploreNodeData } from '../ExploreTreeNode';
import { EDGE_TYPE_META } from '../../../type/thinkingMap';
import { timelineEdges } from '../../../service/ledger';
import { isOpen } from '../../../util/mapGroups';
import { t as tGlobal } from '../../../i18n';
import 'reactflow/dist/style.css';
import styles from './ThinkingMapView.module.css';

const MAP_NODE_TYPES = Object.freeze({ exploreNode: ExploreTreeNode });

/** 连线预览的鼠标跟随幽灵节点 id(1×1 隐形,default 类型自带 handle) */
const LINK_GHOST_ID = '__link_ghost__';
const LINK_PREVIEW_ID = '__link_preview__';

/** 线段与(外扩后的)节点矩形相交——slab 法。跨层直连线穿过中间节点=看不见的病灶 */
function segmentHitsRect(
  x1: number, y1: number, x2: number, y2: number,
  rx: number, ry: number, rw: number, rh: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tMin = 0;
  let tMax = 1;
  for (const [p, d, lo, hi] of [[x1, dx, rx, rx + rw], [y1, dy, ry, ry + rh]] as const) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false;
    } else {
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
  }
  return true;
}

/** 折点序列 → 小圆角直角 path(拐角 Q 弧,段太短时圆角自动收缩) */
function roundedOrthPath(points: Array<[number, number]>, radius = 8): string {
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    d += ` L ${cx - ((cx - px) / inLen) * r} ${cy - ((cy - py) / inLen) * r}`
      + ` Q ${cx} ${cy} ${cx + ((nx - cx) / outLen) * r} ${cy + ((ny - cy) / outLen) * r}`;
  }
  const [lx, ly] = points[points.length - 1];
  d += ` L ${lx} ${ly}`;
  return d;
}

/** 边几何共享:节点盒(布局位/拖动位 + 实测尺寸)在 View 层一份共算,版本号驱动各边路径缓存。
 *  此前每条边各自 useNodes() 订阅全量节点、每次渲染重建障碍矩形+重跑避障——开关面板这类
 *  "几何没变"的重渲染也全量重算(实测 4×降速下面板开关 44.7fps、最长 178ms 长任务的构成之一)。
 *  提升后:版本没变=各边路径 memo 直接命中零几何计算;拖动等真几何变化照常逐帧重算,输出一字不变。 */
interface EdgeGeomBox { x: number; y: number; w: number; h: number; measured: boolean }
interface EdgeGeomValue { version: number; boxes: Map<string, EdgeGeomBox> }
const EdgeGeomContext = createContext<EdgeGeomValue>({ version: 0, boxes: new Map() });

/** 避障走线纯函数(逻辑自组件体原样搬出,输入源从 useNodes 换成共享盒)。
 *  与原实现严格对齐:未实测(RF 未回报宽高)的节点不进障碍集、也不当两端矩形(视同直连)。 */
function computeRoutedPath(
  sourceId: string, targetId: string,
  sourceX: number, sourceY: number, targetX: number, targetY: number,
  sourcePosition: Position, targetPosition: Position,
  boxes: Map<string, EdgeGeomBox>,
): string {
  // 实体节点包围盒(外扩 8px 余量;排除两端与幽灵),顺便抓两端节点自身矩形
  const rects: Array<{ x: number; y: number; w: number; h: number; right: number }> = [];
  let srcRect: { right: number; midY: number } | null = null;
  let tgtRect: { right: number; midY: number } | null = null;
  for (const [id, b] of boxes) {
    if (!b.measured) continue;
    if (id === sourceId) {
      srcRect = { right: b.x + b.w, midY: b.y + b.h / 2 };
      continue;
    }
    if (id === targetId) {
      tgtRect = { right: b.x + b.w, midY: b.y + b.h / 2 };
      continue;
    }
    rects.push({ x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16, right: b.x + b.w });
  }

  // 直连挡路判定;绕行只对"向下走"的边有意义(时序边永远向下;预览跟鼠标向上时直连即可)
  let blockRight = -Infinity;
  if (targetY > sourceY + 40) {
    for (const r of rects) {
      if (segmentHitsRect(sourceX, sourceY, targetX, targetY, r.x, r.y, r.w, r.h)) {
        blockRight = Math.max(blockRight, r.right);
      }
    }
  }

  let path: string;
  if (blockRight > -Infinity && srcRect) {
    const hitsAny = (x1: number, y1: number, x2: number, y2: number) =>
      rects.some(r => segmentHitsRect(x1, y1, x2, y2, r.x, r.y, r.w, r.h));

    // 出口:默认 source 右缘中点;入口:target 右缘中点(预览幽灵=鼠标点,无缘可言)
    let exit: [number, number] = [srcRect.right, srcRect.midY];
    let exitViaBottom = false;
    const isGhostTarget = !tgtRect;
    let enter: [number, number] = tgtRect ? [tgtRect.right, tgtRect.midY] : [targetX, targetY];
    let enterViaTop = false;

    // 竖干起步:出入口与挡路者的右缘最大值 + 32
    let bx = Math.max(blockRight, exit[0], isGhostTarget ? -Infinity : enter[0]) + 32;

    // 两轮定型:竖干右推会拉长水平段 → 重判端点退化 → y 变了再推一次竖干
    for (let round = 0; round < 2; round++) {
      for (let push = 0; push < 6; push++) {
        let pushed = false;
        const vy1 = Math.min(exit[1], enter[1]);
        const vy2 = Math.max(exit[1], enter[1]);
        for (const r of rects) {
          if (segmentHitsRect(bx, vy1, bx, vy2, r.x, r.y, r.w, r.h) && r.right + 32 > bx) {
            bx = r.right + 32;
            pushed = true;
          }
        }
        if (!pushed) break;
      }
      // 侧出水平段撞同层右邻 → 该端退化走底部通道(直落 20px 到层间空隙再右拐)
      if (!exitViaBottom && hitsAny(exit[0], exit[1], bx, exit[1])) {
        exit = [sourceX, sourceY + 20];
        exitViaBottom = true;
      }
      if (!isGhostTarget && !enterViaTop && hitsAny(bx, enter[1], enter[0], enter[1])) {
        enter = [targetX, targetY - 20];
        enterViaTop = true;
      }
    }

    const pts: Array<[number, number]> = [];
    if (exitViaBottom) pts.push([sourceX, sourceY]);
    pts.push(exit, [bx, exit[1]], [bx, enter[1]], enter);
    if (enterViaTop) pts.push([targetX, targetY]);
    path = roundedOrthPath(pts);
  } else {
    [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }
  return path;
}

/** 白描边 + 避障走线(07-07 用户手绘定式:侧到侧)。
 *  跨层直连撞到中间节点时 → 从 source 右侧边出、右侧竖干直落、进 target 右侧边——
 *  出入口离开节点上下沿,与主干时序线(底出顶进)彻底分开。直角小圆角,不用曲线
 *  (曲线峰值到不了控制点会与节点相切,且曲线路径没法做可靠碰撞检测)。
 *  两层保护:①竖干撞到右侧节点(同层新邻居)→ 迭代右推到它外侧;
 *  ②侧出/侧进的水平段撞到同层右邻 → 该端独立退化回底/顶通道出入(层间空隙,ranksep 80)。
 *  连线预览(虚线)与真实边共用本组件——预览看到的走向=坐实后的走向。
 *  性能:路径按「端点 + 几何版本」memo——几何没变的重渲染(开关面板/选中等)零计算。 */
function RoutedOutlinedEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  const geom = useContext(EdgeGeomContext);
  const path = useMemo(
    () => computeRoutedPath(props.source, props.target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, geom.boxes),
    // geom.boxes 的内容变化由 version 表达(boxes 本身随 version 一起换新引用)
    [props.source, props.target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, geom.version],
  );

  const coloredWidth = Number(props.style?.strokeWidth) || 2;
  const isPreview = props.id === LINK_PREVIEW_ID;
  // 转折边机制 2026-09-01 退役（用户拍：测试阶段只留一种朴素连线）——turn 数据字段忽略，一律画普通边
  return (
    <g className={isPreview ? styles.previewEdge : undefined}>
      {/* 预览虚线不垫白底(白底会把虚线缝隙填成实线感);真实实线边照垫 */}
      {!isPreview && <path d={path} fill="none" stroke="var(--poe-surface)" strokeWidth={coloredWidth + 4} />}
      <BaseEdge id={props.id} path={path} style={props.style} interactionWidth={isPreview ? 0 : props.interactionWidth} />
    </g>
  );
}
const MAP_EDGE_TYPES = Object.freeze({ outlined: RoutedOutlinedEdge });

function ThinkingMapViewImpl(): JSX.Element {
  const { store: useThinkingMapStore, host } = useThinkingMapRuntime();
  const allNodes = useThinkingMapStore(s => s.nodes);
  const allEdges = useThinkingMapStore(s => s.edges);
  const generation = useThinkingMapStore(s => s.generation);
  const editingNodeId = useThinkingMapStore(s => s.editingNodeId);
  const lastDeleted = useThinkingMapStore(s => s.lastDeleted);
  const updateNode = useThinkingMapStore(s => s.updateNode);
  const deleteNode = useThinkingMapStore(s => s.deleteNode);
  const deleteNodes = useThinkingMapStore(s => s.deleteNodes);
  const deleteEdge = useThinkingMapStore(s => s.deleteEdge);
  const setEditingNode = useThinkingMapStore(s => s.setEditingNode);
  const addNodeAction = useThinkingMapStore(s => s.addNode);
  const addEdgeManual = useThinkingMapStore(s => s.addEdgeManual);
  const reattachAfter = useThinkingMapStore(s => s.reattachAfter);
  const alignAsSibling = useThinkingMapStore(s => s.alignAsSibling);
  const lastCondensedL2Ids = useThinkingMapStore(s => s.lastCondensedL2Ids);
  const undo = useThinkingMapStore(s => s.undo);
  const redo = useThinkingMapStore(s => s.redo);
  const dissolveGroup = useThinkingMapStore(s => s.dissolveGroup);
  const markNodeRead = useThinkingMapStore(s => s.markNodeRead);
  const refineNodeAction = useThinkingMapStore(s => s.refineNode);
  const jumpToDoc = useThinkingMapStore(s => s.jumpToDoc);
  const focusNodeId = useThinkingMapStore(s => s.focusNodeId);
  const clearMapFocus = useThinkingMapStore(s => s.clearMapFocus);
  const refiningNodeId = useThinkingMapStore(s => s.refiningNodeId);
  const acceptProposal = useThinkingMapStore(s => s.acceptProposal);
  const dismissProposal = useThinkingMapStore(s => s.dismissProposal);
  const setSelectedNodes = useThinkingMapStore(s => s.setSelectedNodes);
  const selectedNodeIds = useThinkingMapStore(s => s.selectedNodeIds);
  const tidyWhitebox = useThinkingMapStore(s => s.tidyWhitebox);
  const isTidying = useThinkingMapStore(s => s.isTidying);
  const isGenerating = useThinkingMapStore(s => s.isGenerating);
  const isRefining = useThinkingMapStore(s => s.isRefining);
  const tidyRound = useThinkingMapStore(s => s.tidyRound);
  const cancelTidy = useThinkingMapStore(s => s.cancelTidy);

  // 压缩塔展示过滤：被收拢的成员与被折叠的边不渲染——数据无损全在 store，拆开即回
  const mapNodes = useMemo(() => allNodes.filter(n => !n.condensedInto), [allNodes]);

  // 节点详情读判断正本；Doc 可以把多个判断组织成共同正文，不必逐节点重复。
  const ledgerState = useThinkingMapStore(s => s.ledgerState);
  const docContentByAnchor = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of ledgerState.judgments.values()) if (!j.deleted && j.content.trim()) m.set(j.id, j.content.trim());
    return m;
  }, [ledgerState]);
  // 完整承接（缓存里一条不少）→ 画出来的：时间线画法，每条判断只挂最近的一条来路，线只从早指向晚
  const fullEdges = useMemo(() => allEdges.filter(e => !e.hiddenBy), [allEdges]);
  const mapEdges = useMemo(() => timelineEdges(mapNodes, fullEdges), [mapNodes, fullEdges]);

  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // hover 线的高亮加粗（纯视觉提示，不带操作）
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  // 悬停/点开的节点：它的线高亮，其余压淡——只做视觉，不选中线
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  // hover 线浮出的 🗑（就在鼠标进入位置旁——零行程；离开走 250ms 延迟收起）
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 手势定式（07-05 调整）：hover=出操作（节点工具条/线删除钮）；单击=直接展开详情；
  // 「选中」中间态退役——想删一个节点从两步（点选中→点🗑）变一步（hover→点🗑）
  const [linkingFromId, setLinkingFromId] = useState<string | null>(null);
  // 连线预览（07-07 用户拍板）：进入连线态后虚线跟手——hover 空白=跟鼠标（幽灵节点），
  // hover 节点=吸附该节点（走真实 handle+避障路由，预览走向=坐实走向）；不可连时虚线变红+提示条说明原因
  const [linkMouse, setLinkMouse] = useState<{ x: number; y: number } | null>(null);
  const [linkHoverId, setLinkHoverId] = useState<string | null>(null);
  // 屏幕坐标→flow 坐标转换要用 instance,而 mousemove 回调声明早于 rfInstance state → 走 ref
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  // 删除后的 3 秒撤销窗口
  const [undoVisible, setUndoVisible] = useState(false);
  // 三区拖放状态（旧探索树同款）
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<'before' | 'after' | 'inside' | null>(null);
  const [isValidDrop, setIsValidDrop] = useState(false);
  // 无效拖放弹回：bump 触发布局重算（受控 nodes 覆盖 ReactFlow 内部拖动位置）
  const [nudge, setNudge] = useState(0);
  const bumpLayout = useCallback(() => setNudge(n => n + 1), []);

  // 节点实测尺寸回填：ReactFlow 渲染后报 dimensions → 用真实宽高重排一次（修估算误差导致的超框/遮挡）
  const [measured, setMeasured] = useState<MeasuredSizes>(new Map());
  // 拖动跟手：受控模式下 ReactFlow 把拖动位置报给我们，必须回填节点才会动
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  // 本次拖动是否真发生过位移——RF(d3-drag)对「纯点击」也发 dragstart/dragstop,
  // 零位移时布局位置根本没动过,松手无需 bumpLayout(否则每次点击都全图 dagre 重排,profile 实锤)
  const dragMovedRef = useRef(false);
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    // 框选/加选（Shift 拖、Ctrl 点）：ReactFlow 报增量 select changes → 同步进 store（Panel 的「整理」按它分流）
    const selChanges = changes.filter((c): c is Extract<NodeChange, { type: 'select' }> => c.type === 'select');
    if (selChanges.length > 0) {
      const cur = new Set(useThinkingMapStore.getState().selectedNodeIds);
      selChanges.forEach(c => { if (c.selected) cur.add(c.id); else cur.delete(c.id); });
      setSelectedNodes([...cur]);
    }
    for (const c of changes) {
      if (c.type === 'position' && c.dragging && c.position) {
        dragMovedRef.current = true;
        setDragPos({ id: c.id, x: c.position.x, y: c.position.y });
      }
    }
    setMeasured(prev => {
      let next: MeasuredSizes | null = null;
      for (const c of changes) {
        if (c.type !== 'dimensions' || !c.dimensions) continue;
        const { width, height } = c.dimensions;
        if (!width || !height) continue;
        const old = (next ?? prev).get(c.id);
        // 1.5px 阈值挡浮点抖动，防"重排→再报→再重排"循环
        if (old && Math.abs(old.w - width) < 1.5 && Math.abs(old.h - height) < 1.5) continue;
        if (!next) next = new Map(prev);
        next.set(c.id, { w: width, h: height });
      }
      return next ?? prev;
    });
  }, []);

  // 节点本体点击：直接展开/收起详情（hover 已承担操作入口）；连线态下=选定连线目标
  const handleNodeBodyClick = useCallback((id: string) => {
    setSelectedEdgeId(null);
    setEdgeMenu(null);
    const linking = linkingFromId;
    if (linking) {
      if (linking === id) {
        setLinkingFromId(null); // 再点源节点=收回连线
        return;
      }
      const ok = addEdgeManual(linking, id);
      // 坐实才退出连线态；被拒（重复/成环）保持连线态——提示条已在解释原因，用户可直接换目标
      if (ok) setLinkingFromId(null);
      return;
    }
    markNodeRead(id); // 单击=已读，清红点（微信未读点同款）
    setOpenPanelId(prev => (prev === id ? null : id));
  }, [linkingFromId, addEdgeManual, markNodeRead]);

  const handleTogglePanel = useCallback((id: string) => {
    setOpenPanelId(prev => (prev === id ? null : id));
  }, []);

  const handleTitleChange = useCallback((id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    const isEditingFlow = useThinkingMapStore.getState().editingNodeId === id;
    if (isEditingFlow) {
      setEditingNode(null);
      // 手动加节点流程：提交空 title = 放弃种植
      if (!trimmed) {
        deleteNode(id);
        return;
      }
    }
    updateNode(id, { title: trimmed || newTitle });
  }, [updateNode, deleteNode, setEditingNode]);

  const handleCancelEdit = useCallback((id: string) => {
    if (useThinkingMapStore.getState().editingNodeId !== id) return;
    setEditingNode(null);
    // 新种的节点还没有 title → 取消即移除
    const node = useThinkingMapStore.getState().nodes.find(n => n.id === id);
    if (node && !node.title.trim()) deleteNode(id);
  }, [deleteNode, setEditingNode]);


  // handleBodyChange 已撤（08-28）：正文改由文档承载，图上只读——改正文去 Doc 页签

  const handleDelete = useCallback(async ({ id, title }: { id: string; title: string }) => {
    const ok = await confirmDialog({
      title: '删除节点',
      message: `确定删除「${title || '未命名'}」？触及它的关系线会一并删除。`,
      danger: true,
    });
    if (ok) {
      deleteNode(id);
      setOpenPanelId(prev => (prev === id ? null : prev));
    }
  }, [deleteNode]);

  // ===== hover 工具条动作（挂在 hover 节点下方；无弹窗，删除给 3 秒撤销）=====
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleToolbarDelete = useCallback((id: string) => {
    deleteNode(id);
    setOpenPanelId(prev => (prev === id ? null : prev));
    setUndoVisible(true);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoVisible(false), 3000);
  }, [deleteNode]);

  const handleUndoDelete = useCallback(() => {
    undo(); // 统一撤销栈（toast 按钮=Ctrl+Z 的鼠标入口）
    setUndoVisible(false);
  }, [undo]);

  const handleContinueFrom = useCallback((id: string) => {
    const newId = addNodeAction({ afterId: id });
    setEditingNode(newId);
  }, [addNodeAction, setEditingNode]);

  // 手动种独立节点(无 AI 路径的图上直接建:空态按钮 + 画布空白右键共用)
  const handleSeedNode = useCallback(() => {
    const newId = addNodeAction({});
    setEditingNode(newId);
  }, [addNodeAction, setEditingNode]);

  const handlePaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault(); // 空白画布右键=新建节点(不出浏览器菜单)
    handleSeedNode();
  }, [handleSeedNode]);

  const handleStartLinking = useCallback((id: string) => {
    setLinkingFromId(id);
    setLinkMouse(null); // 清上一轮残留,防预览线闪到旧位置
    setLinkHoverId(null);
  }, []);

  // ===== 连线预览:合法性即时判定 + 鼠标/hover 跟踪 =====
  // hover 到目标节点时预判 addEdgeManual 会不会拒——拒因直接写进提示条,虚线同步变红
  const linkVerdict = useMemo<string | null>(() => {
    if (!linkingFromId || !linkHoverId) return null;
    if (linkHoverId === linkingFromId) return '不能连到自己(再点一下收回连线)';
    const dup = mapEdges.some(e =>
      (e.from === linkingFromId && e.to === linkHoverId) ||
      (e.from === linkHoverId && e.to === linkingFromId));
    if (dup) return '这两个节点已有连线(两点之间最多一条)';
    if (wouldCycle(mapEdges, linkingFromId, linkHoverId)) return '不能这样连:会绕成一个圈';
    return null;
  }, [linkingFromId, linkHoverId, mapEdges]);

  const handlePaneMouseMove = useCallback((e: React.MouseEvent) => {
    if (!linkingFromId || !rfInstanceRef.current) return;
    setLinkMouse(rfInstanceRef.current.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }, [linkingFromId]);

  const handleNodeMouseEnter = useCallback((_e: React.MouseEvent, node: Node) => {
    if (node.id === LINK_GHOST_ID) return;
    setHoverNodeId(node.id);
    if (!linkingFromId) return;
    setLinkHoverId(node.id);
  }, [linkingFromId]);

  const handleNodeMouseLeave = useCallback(() => {
    setHoverNodeId(null);
    setLinkHoverId(null);
  }, []);

  // ===== 三区拖放（旧探索树同款移植：左30%=排前 / 右30%=排后 / 中40%=接到后面）=====
  const detectDropZone = useCallback((mouseX: number, rect: DOMRect): 'before' | 'after' | 'inside' => {
    const ratio = (mouseX - rect.left) / rect.width;
    if (ratio < 0.3) return 'before';
    if (ratio > 0.7) return 'after';
    return 'inside';
  }, []);

  const validateDrop = useCallback((sourceId: string, targetId: string, zone: 'before' | 'after' | 'inside'): boolean => {
    if (sourceId === targetId) return false;
    const edges = useThinkingMapStore.getState().edges;
    const rest = edges.filter(e => e.to !== sourceId);
    if (zone === 'inside') {
      // 接到 target 后面：target 不能在 source 的下游（成环）
      return !wouldCycle(rest, targetId, sourceId);
    }
    // 并列：复制 target 的承接来源——每个来源都不能在 source 的下游
    const targetIncoming = edges.filter(e => e.to === targetId);
    return !targetIncoming.some(e => wouldCycle(rest, e.from, sourceId));
  }, []);

  const handleNodeDragStart = useCallback((_e: React.MouseEvent, node: Node) => {
    dragMovedRef.current = false;
    setDraggingNodeId(node.id);
  }, []);

  const handleNodeDrag = useCallback((event: React.MouseEvent) => {
    if (!draggingNodeId) return;
    const elements = document.elementsFromPoint(event.clientX, event.clientY);
    let hoveredId: string | null = null;
    let hoveredRect: DOMRect | null = null;
    for (const el of elements) {
      const nodeEl = (el as HTMLElement).closest?.('[data-id]') as HTMLElement | null;
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-id');
        if (id && id !== draggingNodeId) {
          hoveredId = id;
          hoveredRect = nodeEl.getBoundingClientRect();
          break;
        }
      }
    }
    if (hoveredId && hoveredRect) {
      const zone = detectDropZone(event.clientX, hoveredRect);
      setDropTargetId(hoveredId);
      setDropZone(zone);
      setIsValidDrop(validateDrop(draggingNodeId, hoveredId, zone));
    } else if (dropTargetId) {
      setDropTargetId(null);
      setDropZone(null);
      setIsValidDrop(false);
    }
  }, [draggingNodeId, dropTargetId, detectDropZone, validateDrop]);

  const handleNodeDragStop = useCallback(() => {
    if (draggingNodeId && dropTargetId && dropZone && isValidDrop) {
      if (dropZone === 'inside') {
        reattachAfter(draggingNodeId, dropTargetId);
      } else {
        alignAsSibling(draggingNodeId, dropTargetId, dropZone === 'before');
      }
    }
    setDraggingNodeId(null);
    setDropTargetId(null);
    setDropZone(null);
    setIsValidDrop(false);
    setDragPos(null); // 位置自动固定：拖动位仅在拖动中有效，松手即回布局位
    // 只有真位移过才需要弹回布局位;纯点击(d3-drag 零位移也发 start/stop)不 bump——
    // 否则每次单击节点都触发全图 dagre 重排(见 dragMovedRef 注释)
    if (dragMovedRef.current) bumpLayout();
  }, [draggingNodeId, dropTargetId, dropZone, isValidDrop, reattachAfter, alignAsSibling, bumpLayout]);

  // ⤵ 存入项目已随归一下岗：图本身就是 project 的资产，无需搬运（旧树接收端已退役）

  // ===== 布局（贵：dagre）——只依赖结构与尺寸；拖动/选中等瞬态不打扰它 =====
  // 内容指纹:布局的真实输入只有 id/order/生效尺寸(实测或标题估算)/结构边/nudge。
  // 引用级依赖(mapNodes 每次 store 变更都换新数组)会让"标已读/挂建议/改 body"这类
  // 与布局无关的变化也全图重跑 dagre(profile 实测:面板首点触发 dagre 占样本 ~5%)——
  // 签名相同直接复用上次坐标:同输入同输出,零行为差。
  const layoutSig = useMemo(() => {
    const parts: string[] = [`n${nudge}`];
    for (const n of mapNodes) {
      const m = measured.get(n.id);
      parts.push(m
        ? `${n.id}|${n.order}|${m.w},${m.h}`
        : `${n.id}|${n.order}|e${estimateNodeHeight({ title: n.title } as ExploreNodeData)}`);
    }
    for (const e of mapEdges) parts.push(`${e.from}>${e.to}`);
    return parts.join(';');
  }, [mapNodes, mapEdges, measured, nudge]);
  const layoutCacheRef = useRef<{ sig: string; pos: Map<string, { x: number; y: number }> } | null>(null);
  const layoutPositions = useMemo(() => {
    if (layoutCacheRef.current && layoutCacheRef.current.sig === layoutSig) return layoutCacheRef.current.pos;
    const rawNodes: Node[] = mapNodes.map(n => ({
      id: n.id,
      position: { x: 0, y: 0 },
      data: { title: n.title, body: n.body } as unknown as ExploreNodeData,
    }));
    // 转折边退役（09-01）：一切边同等入结构布局，turn 字段一律忽略
    const structEdges: Edge[] = mapEdges.map(e => ({ id: e.id, source: e.from, target: e.to }));
    const orderMap = new Map(mapNodes.map(n => [n.id, n.order] as const));
    const laid = layoutGraph(rawNodes, structEdges, measured, orderMap);
    const pos = new Map(laid.map(n => [n.id, n.position] as const));
    layoutCacheRef.current = { sig: layoutSig, pos };
    return pos;
    // 签名已覆盖 mapNodes/mapEdges/measured/nudge 的全部布局相关内容(见上);sig 变才重算
  }, [layoutSig]);

  // 结构出边集合——isOpen 签名保留该参数（口径收在 util/mapGroups；08-05 起实现已不看出边）
  const hasOutEdge = useMemo(() => new Set(fullEdges.map(e => e.from)), [fullEdges]); // 悬着与否按完整承接算，不受画法影响

  // 焦点视觉（时序渐变+视野圈）已连根删（2026-07-12 用户判"没啥用"）——
  // 07-11 上、07-12 卒；与 07-04 状态圈同款结局：常驻视觉花活在真机前活不过两天

  // ===== 聚焦跟随（「◎ 聚焦」开关的新语义，2026-07-12 用户定）=====
  // 开着时：点开哪个节点，视野就 1:1 居中到「节点+右侧详情面板」的组合体（节点略偏左，
  // 面板不出屏）；关着=现状（点开节点不动视野）。默认关——遵守视野保持定则，跟随主动开。
  const [focusFollowOn, setFocusFollowOn] = useState(() => {
    try { return localStorage.getItem('gft_map_focus_follow') === 'on'; } catch { return false; }
  });
  const toggleFocusFollow = useCallback(() => {
    setFocusFollowOn(v => {
      try { localStorage.setItem('gft_map_focus_follow', v ? 'off' : 'on'); } catch { /* ignore */ }
      return !v;
    });
  }, []);
  /** 视野 1:1 对准「节点+详情面板」组合体（detailPanel: left=100%+14px、width 340px、
   *  顶对齐节点、可向下伸至 420px）——横向组合体居中=节点略偏左；
   *  纵向居中点下移 100（面板重心偏下）=节点视觉偏上，面板整体在屏内 */
  const centerOnOpenNode = useCallback((id: string) => {
    const pos = layoutPositions.get(id);
    if (!pos) return;
    const size = measured.get(id);
    const nodeW = size?.w ?? NODE_WIDTH;
    rfInstanceRef.current?.setCenter(
      pos.x + (nodeW + 14 + 340) / 2,
      pos.y + (size?.h ?? 80) / 2 + 100,
      { zoom: 1, duration: 200 },
    );
  }, [layoutPositions, measured]);
  // 只在「新展开」那一刻居中一次——面板开着期间的布局变化（撤回/重做/整理重排）
  // 不再拉视角（视野保持定则管辖：跟随是点开动作的伴随，不是持续锁定）
  const lastCenteredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusFollowOn || !openPanelId) { lastCenteredRef.current = openPanelId; return; }
    if (lastCenteredRef.current === openPanelId) return;
    lastCenteredRef.current = openPanelId;
    centerOnOpenNode(openPanelId);
  }, [focusFollowOn, openPanelId, centerOnOpenNode]);

  // ===== reactflow 节点（ExploreTreeNode 皮 + demo 能力裁剪）=====
  // 常驻状态圈（新节点亮蓝/分叉蓝/汇合黄）已全撤——用户判定过度设计：
  // 没有说明的视觉状态都是困惑源；新增感知由按钮「新 N 条」承担，分叉汇合由线的形状自现
  //
  // 两段式(2026-07 帧率修):底座只装内容/回调,瞬态字段一律填「静息值」;覆盖层把
  // 开面板/拖动/选中/整理等瞬态 patch 到被触及的那几个节点,其余节点【引用原样返回】——
  // ReactFlow 的 per-node wrapper 引用相等直接跳过,React 不再为 30+ 个没变的节点重建子树。
  // (profile 实测:开关面板的 44.7fps/178ms 长任务主构成=全量 createElement+校验的千刀凌迟。)
  // 语义与旧单段实现一字不变:被触及节点的 patch 值=旧实现现算值,静息值=旧实现未触及时的值。
  const flowNodesBase = useMemo<Node[]>(() => {
    return mapNodes.map(n => {
      const data: ExploreNodeData = {
        id: n.id,
        title: n.title,
        // 详情正文取自白盒文档（按锚），不再用节点自存的 body——v1.2 起 AI 走 <doc> 块、
        // 完整表述只写进文档，node.body 一律为空；图是投影，内容回文档取（2026-08-28 修）。
        // 无锚的老节点退回 body（不主动把老图点成空壳）。
        body: docContentByAnchor.get(n.anchor ?? '') ?? n.body,
        inlineBody: true,
        notes: [],
        commits: [],
        headCommitId: null,
        suggestion: null,
        isPanelOpen: false,
        isCandidate: false,
        hasChildren: false,
        isExpanded: true,
        // 紫框标「正在展开的节点」（选中态退役后唯一常驻高亮：你在看谁）；
        // 工具条改 hover 浮现（节点组件内部按 isHovered && !isDragging 控制）
        isHighlighted: false,
        onContinueFrom: handleContinueFrom,
        onStartLinking: handleStartLinking,
        onDeleteSelf: handleToolbarDelete,
        onRefine: (nid: string) => void refineNodeAction(nid),
        onViewDoc: jumpToDoc,
        refining: false, // 节点级：只有整理中的那个节点显示加载态（覆盖层 patch）
        isDragging: false,
        isDropTarget: false,
        dropZone: null,
        isValidDropTarget: false,
        isInvalidDropTarget: false,
        isEditing: false,
        onNodeClick: handleNodeBodyClick,
        onTogglePanel: handleTogglePanel,
        onTitleChange: handleTitleChange,
        onCancelEdit: handleCancelEdit,
        // 正文只读（08-28）：它显示的是文档里的完整表述，在图上改它＝开了"图→文档"反向通道
        // （用户已否：图文各改各的，到更新/整理才汇合）。要改正文去 Doc 页签。
        onDelete: handleDelete,
        // 单选视觉隐形（size≥2 才亮虚线框）：单击=纯展开语义，RF 内部排他选中照常运转，
        // 但不给「已选 1」任何视觉/工具条存在感——紫虚线框=批量操作候选专属（一色一义）
        isMultiSelected: false,
        unread: !!n.unread,
        // viaAgent ⚡ 角标已退役（08-7 用户拍：同权不留血统）；source 字段仍随数据走
        // 已确认的永久态（灰显/挂?）——完全态，落库
        superseded: !!n.superseded,
        // ? 两个来源：落库 unresolved（校对确认）| 结构推断（标题是问句即算——
        // 2026-08-05 用户拍板去掉"无出边"限制：问号节点不必是叶子，接了下游不代表问题解决。
        // 熄灭走显式路径：改标题/删节点/落库型点「已解决」）
        unresolved: isOpen(n, hasOutEdge),   // 单一口径 util/mapGroups —— 与注入/一页纸同源（F7）
        // 面板解除行只给落库型（推断型接上答案自动灭）
        // AI 推进提议（落库、默认保留）——低调角标形态：challenge=左上角虚化? / add=虚线节点；
        // hover 出 ✓（收下）×（撤掉），理由挂 tooltip
        ...(n.proposal ? {
          proposalKind: n.proposal.kind,
          proposalReason: n.proposal.reason,
          onProposalAccept: () => acceptProposal(n.id),
          onProposalDismiss: () => dismissProposal(n.id),
        } : {}),
        // L2 判断（收拢产物）：×N 角标 + 面板成员列表 + 拆开。
        // 仅当成员实体仍存活（hiddenBy 折叠制）才算 L2——整理 merge 的 constituents 是溯源记录，
        // 成员已融毁不可拆，绝不能挂 onDissolve（拆开会把合并节点白删=数据丢失）
        ...(() => {
          if (!n.constituents?.length) return {};
          const members = n.constituents
            .map(id => allNodes.find(m => m.id === id))
            .filter((m): m is typeof n => !!m)
            .map(m => ({ id: m.id, title: m.title, body: m.body }));
          return members.length > 0
            ? { memberCount: members.length, members, onDissolve: dissolveGroup }
            : {};
        })(),
      };
      return {
        id: n.id,
        type: 'exploreNode',
        data,
        position: layoutPositions.get(n.id) ?? { x: 0, y: 0 },
        draggable: true,
        // 受控模式必须回填 selected，否则框选高亮/再次框选的 deselect 都不生效（覆盖层 patch）
        selected: false,
        zIndex: 1,
        style: {},
      };
    });
  }, [mapNodes, allNodes, layoutPositions, docContentByAnchor, acceptProposal, dismissProposal, handleNodeBodyClick, handleTogglePanel, handleTitleChange, handleCancelEdit, handleDelete, handleContinueFrom, handleStartLinking, handleToolbarDelete, dissolveGroup, refineNodeAction, jumpToDoc, hasOutEdge]);

  // 瞬态覆盖:只 clone 被触及的节点,其余引用原样(无任何瞬态时直接返回底座数组本身)
  const flowNodes = useMemo<Node[]>(() => {
    const hasTransient = openPanelId !== null || dragPos !== null || draggingNodeId !== null
      || dropTargetId !== null || selectedNodeIds.size > 0 || refiningNodeId !== null
      || editingNodeId !== null || isTidying;
    if (!hasTransient) return flowNodesBase;
    return flowNodesBase.map(n => {
      const id = n.id;
      const isOpen = openPanelId === id;
      const isSel = selectedNodeIds.has(id);
      const isDropT = dropTargetId === id;
      const isRefining = refiningNodeId === id;
      const touched = isOpen || isSel || isDropT || isRefining
        || draggingNodeId === id || editingNodeId === id || (dragPos !== null && dragPos.id === id);
      if (!touched) return n;
      const dimmed = isRefining || (isTidying && isSel);
      return {
        ...n,
        // 位置：布局位为基底；拖动中的节点用 ReactFlow 回报的实时位置（跟手）
        position: dragPos && dragPos.id === id ? { x: dragPos.x, y: dragPos.y } : n.position,
        selected: isSel,
        zIndex: isOpen ? 9999 : 1,
        style: {
          ...(isOpen ? { zIndex: 9999 } : {}),
          // 整理中：目标节点半透明呼吸感（点击即时反馈——不依赖会消失的 hover 工具条）
          ...(dimmed ? { opacity: 0.45, transition: 'opacity 0.25s ease' } : {}),
        },
        data: {
          ...n.data,
          isPanelOpen: isOpen,
          isHighlighted: isOpen,
          refining: isRefining,
          isDragging: draggingNodeId === id,
          isDropTarget: isDropT,
          dropZone: isDropT ? dropZone : null,
          isValidDropTarget: isDropT && isValidDrop,
          isInvalidDropTarget: isDropT && !isValidDrop,
          isEditing: editingNodeId === id,
          isMultiSelected: selectedNodeIds.size >= 2 && isSel,
        },
      };
    });
  }, [flowNodesBase, openPanelId, dragPos, draggingNodeId, dropTargetId, dropZone, isValidDrop, selectedNodeIds, refiningNodeId, editingNodeId, isTidying]);

  // ===== 边几何共享值:节点盒一份共算(见 EdgeGeomContext 注释)=====
  // 幽灵节点(连线预览)不进盒:原实现就把它排除在障碍集外;预览边端点走 props 直传不受影响
  const geomVersionRef = useRef(0);
  const edgeGeom = useMemo<EdgeGeomValue>(() => {
    const boxes = new Map<string, EdgeGeomBox>();
    for (const n of mapNodes) {
      const base = layoutPositions.get(n.id) ?? { x: 0, y: 0 };
      const p = dragPos && dragPos.id === n.id ? dragPos : base;
      const m = measured.get(n.id);
      // measured=false 的节点(RF 尚未回报宽高)不参与避障——对齐原实现的 !w||!h 跳过
      boxes.set(n.id, { x: p.x, y: p.y, w: m?.w ?? NODE_WIDTH, h: m?.h ?? 0, measured: !!m });
    }
    geomVersionRef.current += 1;
    return { version: geomVersionRef.current, boxes };
  }, [mapNodes, layoutPositions, measured, dragPos]);

  // ===== reactflow 边（朴素连线 + 箭头，单一中性色，无标签）=====
  const flowEdges = useMemo<Edge[]>(() => {
    // 聚焦节点（悬停优先，其次点开面板的）：它的线高亮（全实线），其余压淡——线多重合时一眼看清连到哪
    const focusId = hoverNodeId ?? openPanelId;
    const built = mapEdges.map(e => {
      const meta = EDGE_TYPE_META[e.type];
      // 加粗两来源：hover（纯视觉提示）或 点击选中（删除钮开着）
      const isSelected = e.id === selectedEdgeId || e.id === hoveredEdgeId;
      const incoming = focusId !== null && e.to === focusId;
      const outgoing = focusId !== null && e.from === focusId;
      const dim = focusId !== null && !incoming && !outgoing;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'outlined',
        // 视觉 2px 不变，隐形点击热区 24px——看着细、点着粗
        interactionWidth: 24,
        // 素线无箭头（旧树同款）：时序图方向永远向下，箭头是冗余的视觉重量
        // 转折边机制 09-01 退役：turn 字段一律忽略，所有边同一画法
        // 不抬 zIndex：抬了线会画到节点和工具条上面（9-6 实测）；高亮靠颜色和粗细就够
        style: {
          stroke: incoming || outgoing ? 'var(--poe-purple)' : meta.color,
          strokeWidth: isSelected || incoming || outgoing ? 3.5 : 2,
          opacity: dim ? 0.2 : 1,
          transition: 'opacity 0.15s, stroke 0.15s',
        },
        data: { lit: incoming || outgoing },
      };
    });
    // 高亮的线排到最后：SVG 后画的在上面，共用同一段轨道时不被压淡的线盖住（9-6 实测：只剩节点间独占段是紫的）
    return focusId === null ? built : [...built.filter(e => !e.data?.lit), ...built.filter(e => e.data?.lit)];
  }, [mapEdges, selectedEdgeId, hoveredEdgeId, hoverNodeId, openPanelId]);

  // 线的手势（07-05 二次调）：hover=只做高亮加粗的视觉提示；🗑 删除走点击（删除是重操作，
  // hover 直出误触代价高——与节点工具条的轻操作区别对待）
  const onEdgeMouseEnter = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setHoveredEdgeId(edge.id);
  }, []);
  const onEdgeMouseLeave = useCallback(() => {
    setHoveredEdgeId(null);
  }, []);
  // 点线：🗑 浮在点击位置旁（零行程）
  const onEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setEdgeMenu({ id: edge.id, x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
    setSelectedEdgeId(edge.id);
  }, []);

  const handlePaneClick = useCallback(() => {
    setOpenPanelId(null);
    setSelectedEdgeId(null);
    setEdgeMenu(null);
    setLinkingFromId(null); // 点空白取消连线态
    setSelectedNodes([]); // 点空白清选区（手势定式「点空白=全取消」；顺带兜掉任何存量幽灵 id）
  }, [setSelectedNodes]);

  // ===== 连线预览的幽灵节点与虚线(独立于主 nodes/edges memo:mousemove 高频更新只动它俩) =====
  const ghostNode = useMemo<Node | null>(() => {
    if (!linkingFromId || !linkMouse || linkHoverId) return null;
    return {
      id: LINK_GHOST_ID,
      position: linkMouse,
      data: { label: '' },
      style: { width: 1, height: 1, opacity: 0, pointerEvents: 'none' as const, border: 'none', padding: 0 },
      draggable: false,
      selectable: false,
      connectable: false,
      zIndex: 0,
    };
  }, [linkingFromId, linkMouse, linkHoverId]);

  const previewEdge = useMemo<Edge | null>(() => {
    if (!linkingFromId) return null;
    const target = linkHoverId ?? (linkMouse ? LINK_GHOST_ID : null);
    if (!target || target === linkingFromId) return null;
    return {
      id: LINK_PREVIEW_ID,
      source: linkingFromId,
      target,
      type: 'outlined', // 同款避障路由:预览走向=坐实走向
      focusable: false,
      style: {
        stroke: linkVerdict ? 'var(--poe-red-dark)' : 'var(--poe-purple)',
        strokeWidth: 2,
        strokeDasharray: '7 5',
        opacity: 0.8,
      },
    };
  }, [linkingFromId, linkHoverId, linkMouse, linkVerdict]);

  // 手动加节点后：视口平移到新节点（它在时序尾部，多半在视口外）
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  // 「⊙ 视野」两态循环指针：下一次点击去哪（fit=全局总览 / origin=左上角 1:1）
  const nextViewRef = useRef<'fit' | 'origin'>('fit');
  const handleInit = useCallback((inst: ReactFlowInstance) => {
    rfInstanceRef.current = inst;
    setRfInstance(inst);
  }, []);
  useEffect(() => {
    if (!editingNodeId || !rfInstance) return;
    const t = setTimeout(() => {
      const node = rfInstance.getNode(editingNodeId);
      if (node) {
        rfInstance.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + 60, { zoom: 1, duration: 300 });
      }
    }, 80);
    return () => clearTimeout(t);
  }, [editingNodeId, rfInstance]);

  // 文档 ^id 跳过来：打开面板 + 居中（布局可能还没算好，每 100ms 试一次，最多 2s）
  useEffect(() => {
    if (!focusNodeId) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (layoutPositions.has(focusNodeId) && rfInstanceRef.current) {
        setOpenPanelId(focusNodeId);
        centerOnOpenNode(focusNodeId);
        markNodeRead(focusNodeId);
        clearInterval(timer);
        clearMapFocus();
      } else if (tries >= 20) { clearInterval(timer); clearMapFocus(); }
    }, 100);
    return () => clearInterval(timer);
  }, [focusNodeId, layoutPositions, centerOnOpenNode, markNodeRead, clearMapFocus]);

  // 分享图（一图流）已删（2026-08-05 用户拍：假设了不存在的行为）——html-to-image 捕获+品牌框整段撤；
  // 需要时从 git 历史取回

  // 收拢完成 toast（10 秒撤销窗口）：只在"新一批收拢产生"时弹；拆开/撤销引起的数组变化不弹
  const [condenseToastVisible, setCondenseToastVisible] = useState(false);
  const condenseToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCondensedRef = useRef<string[] | null>(null);
  useEffect(() => {
    const prev = prevCondensedRef.current;
    prevCondensedRef.current = lastCondensedL2Ids;
    if (lastCondensedL2Ids?.length && (!prev?.length || prev[0] !== lastCondensedL2Ids[0])) {
      setCondenseToastVisible(true);
      if (condenseToastTimer.current) clearTimeout(condenseToastTimer.current);
      condenseToastTimer.current = setTimeout(() => setCondenseToastVisible(false), 10000);
    }
    if (!lastCondensedL2Ids) setCondenseToastVisible(false);
  }, [lastCondensedL2Ids]);

  // Ctrl+Z 撤销 / Ctrl+Y（或 Ctrl+Shift+Z）重做（输入框内不拦——那里归浏览器原生撤销/重做）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
      const isUndo = key === 'z' && !e.shiftKey;
      if (!isRedo && !isUndo) return;
      e.preventDefault();
      if (isRedo) redo(); else undo();
      setUndoVisible(false);
      setCondenseToastVisible(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  if (mapNodes.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyTitle}>还没有脉络</p>
        <p className={styles.emptyDesc}>{host.requestUpdate ? '点「更新」粘贴对话或材料，思考会在这里长成脉络' : '在左边聊你想弄清的事，点「更新」，思考会在这里长成脉络'}</p>
        <button type="button" className={styles.emptySeedBtn} onClick={handleSeedNode}>
          ＋ 手动种下第一个节点
        </button>
      </div>
    );
  }

  return (
    <div className={isTidying ? `${styles.container} ${styles.tidyingAnim}` : styles.container} ref={containerRef}>
      {/* 视野两态循环（2026-07-12 用户拆分「恢复视图」的模糊语义）：
          按一下=全局总览（fitView 看全部节点）；再按=原始视角（内容左上角贴屏 + 1:1，节点大小合适） */}
      <button
        className={styles.resetViewBtn}
        onClick={() => {
          const inst = rfInstance;
          if (!inst) return;
          if (nextViewRef.current === 'fit') {
            inst.fitView({ maxZoom: 1, duration: 200 });
            nextViewRef.current = 'origin';
          } else {
            // 原始视角分流：聚焦开着且有展开节点 → 1:1 居中到它（与点开跟随同款）；否则左上角
            if (focusFollowOn && openPanelId) {
              centerOnOpenNode(openPanelId);
            } else {
              const rect = getRectOfNodes(inst.getNodes());
              inst.setViewport({ x: -rect.x + 24, y: -rect.y + 24, zoom: 1 }, { duration: 200 });
            }
            nextViewRef.current = 'fit';
          }
        }}
        title={tGlobal('切换视野：按一下=全局总览（看全部节点），再按=原始大小（回到左上角、节点 1:1）')}
      >⊙ {tGlobal('切换视野')}</button>
      {/* 聚焦跟随开关：开=点开节点时视野 1:1 居中到它（后续聚焦体验的第一块） */}
      <button
        className={styles.resetViewBtn}
        style={{ top: 44 }}
        onClick={toggleFocusFollow}
        title={focusFollowOn
          ? tGlobal('聚焦：开——点开节点时，视野自动切到原始大小并居中到它。点击关闭')
          : tGlobal('聚焦：关——点开节点不动视野。点击开启')}
      >{focusFollowOn ? `◎ ${tGlobal('聚焦')}` : `○ ${tGlobal('聚焦')}`}</button>

      {/* 连线态提示条:hover 到不可连目标时就地解释拒因(虚线同步变红) */}
      {linkingFromId && (
        <div className={`${styles.linkingHint} ${linkVerdict ? styles.linkingHintBad : ''}`}>
          {linkVerdict ?? '点击另一个节点完成连线（点空白取消）'}
        </div>
      )}

      {/* 多选工具条（Shift 拖框选 / Ctrl 点加选出来的）——选够 2 个才有批量语义 */}
      {selectedNodeIds.size >= 2 && !linkingFromId && (
        <div className={styles.multiSelectBar}>
          已选 {selectedNodeIds.size} 个节点
          <button
            className={`${styles.multiSelectTidyBtn} ${isTidying ? styles.stopOnHover : ''}`}
            onClick={() => { if (isTidying) { cancelTidy(); } else { void tidyWhitebox([...selectedNodeIds]); } }}
            disabled={!isTidying && (isGenerating || isRefining)}
            title={isTidying
              ? '点击中止整理：这次整理全部作废，不保存任何改动'
              : '整理选中范围：合并连续且重复的判断、去掉废话、写清走向；原始记录留在 Log 里。中止整次不保存，Ctrl+Z 整次退回'}
          >{isTidying
            ? <>
                <span className={styles.runLabel}>🧹 整理中…{tidyRound ? `第 ${tidyRound} 轮` : ''}</span>
                <span className={styles.stopLabel}>■ 中止</span>
              </>
            : '🧹 整理选中'}</button>
          <button
            className={styles.multiSelectBtn}
            onClick={() => deleteNodes([...selectedNodeIds])}
            title="删除选中的节点（脉络自动续链；Ctrl+Z 一次全回）"
          >🗑 删除</button>
          <button
            className={styles.multiSelectCancel}
            onClick={() => setSelectedNodes([])}
            title="取消选择"
          >✕</button>
        </div>
      )}

      {/* 收拢完成 toast（10 秒撤销窗口；逐组的拆开走面板「拆开这组」） */}
      {condenseToastVisible && lastCondensedL2Ids && lastCondensedL2Ids.length > 0 && (
        <div className={styles.undoToast}>
          已收成 {lastCondensedL2Ids.length} 个判断——点开可看成员、可拆开
          <button className={styles.undoBtn} onClick={() => { undo(); setCondenseToastVisible(false); }}>全部撤销</button>
        </div>
      )}

      {/* 删除撤销 toast（3 秒窗口） */}
      {undoVisible && lastDeleted && (
        <div className={styles.undoToast}>
          已删除「{lastDeleted.node.title || '未命名'}」
          <button className={styles.undoBtn} onClick={handleUndoDelete}>撤销</button>
        </div>
      )}

      {/* 点线浮出的删除钮：就在点击位置旁（零行程），点空白或删除后消失 */}
      {edgeMenu && (
        <button
          className={styles.edgeDeleteFloat}
          style={{ left: edgeMenu.x, top: edgeMenu.y - 38 }}
          onClick={() => { deleteEdge(edgeMenu.id); setEdgeMenu(null); setSelectedEdgeId(null); }}
          title="删除这条承接线"
        >🗑 删除</button>
      )}

      <EdgeGeomContext.Provider value={edgeGeom}>
      <ReactFlow
        key={generation}
        style={{ width: '100%', height: '100%' }}
        nodes={ghostNode ? [...flowNodes, ghostNode] : flowNodes}
        edges={previewEdge ? [...flowEdges, previewEdge] : flowEdges}
        nodeTypes={MAP_NODE_TYPES}
        edgeTypes={MAP_EDGE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        onPaneMouseMove={handlePaneMouseMove}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onInit={handleInit}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        // 框选手势：拖=平移（1:1 设计下平移是核心导航，保持零键直拖）；Shift+拖=框选；Ctrl/Cmd+点=逐个加减选
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Control', 'Meta']}
        selectNodesOnDrag={false}
        zoomOnScroll={true}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        minZoom={0.1}
        maxZoom={1.5}
        // 旧树同款：固定 1:1 原始大小从头读起（字永远清晰），不整图缩放；回正靠「⊙ 恢复视图」
        defaultViewport={{ x: 40, y: 24, zoom: 1.0 }}
        fitView={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--poe-gray-200)" gap={16} />
      </ReactFlow>
      </EdgeGeomContext.Provider>
    </div>
  );
}

// memo 边界(工程审计批1):本组件无 props,数据全走自订阅——父面板(订阅 chatHistory)
// 在 AI 流式期间每 chunk 重渲染,此前把整张 ReactFlow 地图子树拖着每秒 ~10 次空转
// (图数据流式期间不变)。memo 后父的重渲染被直接挡掉,图更新照常走自己的 store 订阅。
export const ThinkingMapView = memo(ThinkingMapViewImpl);
