import type { Node, Edge } from 'reactflow';
import dagre from 'dagre';

export const NODE_WIDTH = 180;

/** 渲染后收集的节点实测尺寸（id → 宽高）——布局与包围盒的第一真相；没测到之前用估算兜底 */
export type MeasuredSizes = Map<string, { w: number; h: number }>;

/** 首帧兜底估算（实测回填前用）：内容宽 ~126px ≈ 9 中文字/行，加 padding/border */
export function estimateNodeHeight(data: { title: string }): number {
  const titleLines = Math.max(1, Math.ceil((data.title || '(未命名)').length / 9));
  return 20 + titleLines * 19;
}

function nodeSize(n: Node, measured: MeasuredSizes): { width: number; height: number } {
  const m = measured.get(n.id);
  return {
    width: m?.w ?? NODE_WIDTH,
    height: m?.h ?? estimateNodeHeight(n.data as { title: string }),
  };
}

/** 单个连通分量的 dagre 布局（原单图逻辑原样抽出），返回各节点左上角坐标 */
function dagreOne(nodes: Node[], edges: Edge[], measured: MeasuredSizes, orderMap: Map<string, number>): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // 布局参数对齐旧探索树（用户调校过的手感）：紧凑树 + 左上对齐 + 60/80 间距
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80, align: 'UL', ranker: 'tight-tree', acyclicer: 'greedy' });
  nodes.forEach(n => g.setNode(n.id, nodeSize(n, measured)));
  edges.forEach(e => g.setEdge(e.source, e.target));
  dagre.layout(g);

  // dagre 不认 order——同层（同中心 y）内按 order 重新分配 x 槽位，
  // 三区拖放的「排前/排后」靠这一步真正生效（拖左落左、拖右落右）
  const xOf = new Map(nodes.map(n => [n.id, g.node(n.id).x] as const));
  const ranks = new Map<number, string[]>();
  nodes.forEach(n => {
    const cy = Math.round(g.node(n.id).y);
    ranks.set(cy, [...(ranks.get(cy) ?? []), n.id]);
  });
  ranks.forEach(ids => {
    if (ids.length < 2) return;
    const slots = ids.map(id => xOf.get(id)!).sort((a, b) => a - b);
    const sorted = [...ids].sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));
    sorted.forEach((id, i) => xOf.set(id, slots[i]));
  });

  return new Map(nodes.map(n => {
    const pos = g.node(n.id);
    return [n.id, { x: xOf.get(n.id)! - pos.width / 2, y: pos.y - pos.height / 2 }] as const;
  }));
}

/**
 * 多链布局：位置在讲故事——
 *  - 横向保留分支的拓扑位置，不为独立根另开无限多列。
 *  - 纵向统一按判断出现序排列；两条分支交替推进也不会把早期判断排到晚期下方。
 *  - 位置不添加关系；单链图沿用原来的节点尺寸与层间距。
 *  （转折边机制 2026-09-01 退役：turn 边不再特殊布局，与普通边同等入链）
 */
export function layoutGraph(
  nodes: Node[],
  structEdges: Edge[],
  measured: MeasuredSizes,
  orderMap: Map<string, number>,
): Node[] {
  if (nodes.length === 0) return [];
  // 认链（无向连通）
  const adj = new Map<string, string[]>();
  nodes.forEach(n => adj.set(n.id, []));
  structEdges.forEach(e => {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  });
  const compOf = new Map<string, number>();
  let compCount = 0;
  for (const n of nodes) {
    if (compOf.has(n.id)) continue;
    const stack = [n.id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (compOf.has(cur)) continue;
      compOf.set(cur, compCount);
      (adj.get(cur) ?? []).forEach(x => { if (!compOf.has(x)) stack.push(x); });
    }
    compCount++;
  }

  const groups = Array.from({ length: compCount }, () => ({ nodes: [] as Node[], edges: [] as Edge[] }));
  nodes.forEach(n => {
    const gi = compOf.get(n.id)!;
    groups[gi].nodes.push(n);
  });
  structEdges.forEach(e => {
    const gi = compOf.get(e.source);
    if (gi !== undefined && gi === compOf.get(e.target)) groups[gi].edges.push(e);
  });
  // 横向按真实分叉布局，纵向使用全图的时间序。
  const final = new Map<string, { x: number; y: number }>();
  for (const grp of groups) {
    const local = dagreOne(grp.nodes, grp.edges, measured, orderMap);
    let minX = Infinity;
    grp.nodes.forEach(n => {
      const p = local.get(n.id)!;
      minX = Math.min(minX, p.x);
    });
    grp.nodes.forEach(n => {
      const p = local.get(n.id)!;
      final.set(n.id, { x: p.x - minX, y: 0 });
    });
  }
  let yCursor = 0;
  [...nodes].sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0)).forEach(n => {
    final.get(n.id)!.y = yCursor;
    yCursor += nodeSize(n, measured).height + 80;
  });
  return nodes.map(n => ({ ...n, position: final.get(n.id)! }));
}
