/**
 * 一张图最多多少节点（D63，2026-10-29 用户拍）：整理、更新、Doc 编辑、手动加节点、
 * 其他 Agent 写入共守的硬上限，可在设置里调。节点只当骨架，细节进概述和 Doc 正文。
 */
export const NODE_CAP_DEFAULT = 12;
export const NODE_CAP_MIN = 5;
export const NODE_CAP_MAX = 30;

export function normalizeNodeCap(value: unknown): number {
  const n = typeof value === 'number' ? Math.round(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(NODE_CAP_MAX, Math.max(NODE_CAP_MIN, n)) : NODE_CAP_DEFAULT;
}

/** 本轮最多新增几条判断：上限减去现有条数。 */
export function newNodeBudget(existing: number, cap: number): number {
  return Math.max(0, cap - existing);
}

/**
 * 写入后节点数不能超过上限（D63）。已经超出的图（旧图、导入或调低上限）照常可改，
 * 只是节点不许再变多，整理负责把它收拢到上限以内。违反时返回给人看的说明，否则 undefined。
 */
export function nodeCapViolation(before: number, after: number, cap: number): string | undefined {
  if (after <= cap || after <= before) return undefined;
  if (before > cap) return `这张图有 ${before} 个节点，已超过上限 ${cap} 个，这次写入会变成 ${after} 个，没有保存。先点整理把它收拢到 ${cap} 个以内，或在设置里调高上限。`;
  return `这张图最多 ${cap} 个节点，这次写入会变成 ${after} 个，没有保存。可以先合并或删除节点，或在设置里调高上限。`;
}
