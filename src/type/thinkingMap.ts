import type { FocusCard } from './focusCard';

/**
 * 思维导航（Thinking Map）类型
 * 节点直接复用 FocusCard 形状（service/focus/types.ts）——阶段1 内存态不入库，
 * 阶段2 持久化 / 转正进树时零迁移。
 * 边独立成第一类数据，不塞 relatedIds：树边（relatedIds[0]=父子）与逻辑边（关系）
 * 是同一节点集上的两个正交层。
 */

export type ThinkingEdgeType = 'relates';

export interface ThinkingEdge {
  id: string;
  from: string;
  to: string;
  type: ThinkingEdgeType;
  /** 被哪个 L2 判断的收拢隐藏（组内部边/被重接的原边）——非空不渲染；拆开清标记即回，边数据无损 */
  hiddenBy?: string;
  /** 收拢时工程聚合出的重接边（属于哪个 L2）——拆开该组时删除 */
  bridgeOf?: string;
  /** 转折边：新话头是从旧路"拐过来"的（叙事引用，非结构承接）——
   *  渲染=虚线+「⤴ 转向」标注；布局时不算连通（否则两链并成一列，"换列拐弯"消失） */
  turn?: boolean;
}

/** 单一朴素连线：不分类型，只表示"A 接 B（方向）"——中性色、无标签 */
export const EDGE_TYPE_META: Record<ThinkingEdgeType, { label: string; color: string }> = {
  relates: { label: '', color: '#94a3b8' },
};

/** to 的下游（沿出边可达的所有节点）里有没有 from——有则加 from→to 会成环
 *（纯图函数，store/service/收拢边聚合共用） */
export function wouldCycle(edges: Pick<ThinkingEdge, 'from' | 'to'>[], from: string, to: string): boolean {
  const out = new Map<string, string[]>();
  edges.forEach(e => out.set(e.from, [...(out.get(e.from) ?? []), e.to]));
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(out.get(cur) ?? []));
  }
  return false;
}

export interface PersistedThinkingMap {
  nodes: FocusCard[];
  edges: ThinkingEdge[];
  /** sessionId → lastMessageId */
  watermarks: Record<string, string>;
  /** 白盒文档的折算缓存；工作账是正本，旧行无此列时为空串。 */
  doc?: string;
  /** 判断账（2026-09-05 起的唯一正本）：按时间只追加的纯文本；nodes/edges/doc 是它的缓存。旧行为空串 */
  ledger?: string;
  /** 原始记录：更新时追加，也允许在 Log 页签人工编辑；重画从它重建工作账。 */
  raw?: string;
}
