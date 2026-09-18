/**
 * 思维脉络三分组的**单一口径** —— 画布 / 注入 / 白盒条 / 一页纸全部走这里。
 *
 * 为什么必须收口（F7）：画布判"悬着"是「落库标志 ‖ 结构推断（问句且无出边）」，
 * 而注入/一页纸曾只认落库标志 `unresolved`——该标志只有走过「校对→确认」才写，
 * AI 新生成的图一律不带。结果是：**画布上一片 `?`，喂给 AI 的「还悬着」组却是空的**。
 * 人格把"还悬着"列为一号选材源，那组是空的 → 模型只能从对话里造一个像悬置的名字。
 * 已实测的编造（引用了图上不存在的节点）就是这么来的。
 *
 * ∴ 口径分裂不是洁癖问题，是编造的病根。四处共用一份判定，才谈得上白盒。
 */

import type { FocusCard } from '../type/focusCard';
import type { ThinkingEdge } from '../type/thinkingMap';

/** 有出边的节点集合（问号的正当熄灭 = 答案接上去，结构变化自动生灭） */
export function buildOutEdgeSet(edges: ThinkingEdge[]): Set<string> {
  return new Set(edges.map(e => e.from));
}

/**
 * 是否"还悬着"。**单一来源＝标题是问句**（2026-09-01 用户拍：清算双源——
 * 原第二来源"落库 unresolved 字段"造出'标题无问号却挂?'的预期分裂，退役；
 * doc 条目 ？/⏸ 在投影成图节点时直接给标题补问号，之后规则只看标题。
 * 熄灭=改标题删问号（编辑即认账）；2026-08-05 已拍问号节点不必是叶子）
 */
export function isOpen(n: FocusCard, _hasOutEdge: Set<string>): boolean {
  if (n.superseded) return false;
  return /[?？]\s*$/.test(n.title ?? '');
}

export interface MapGroups {
  /** 未被收拢的全部节点（收拢的由上层判断代表） */
  visible: FocusCard[];
  /** 已想通：既没悬着也没被推翻 */
  settled: FocusCard[];
  /** 还悬着：欠自己的问题 */
  open: FocusCard[];
  /** 已否决：走过的死路 */
  rejected: FocusCard[];
}

/** 三分组（互斥且穷尽 visible） */
export function groupNodes(nodes: FocusCard[], edges: ThinkingEdge[]): MapGroups {
  const hasOutEdge = buildOutEdgeSet(edges);
  const visible = nodes.filter(n => !n.condensedInto);
  const rejected = visible.filter(n => n.superseded);
  const open = visible.filter(n => isOpen(n, hasOutEdge));
  const settled = visible.filter(n => !n.superseded && !isOpen(n, hasOutEdge));
  return { visible, settled, open, rejected };
}
