import type { LedgerState } from './types';
import { liveJudgments, renderGraph } from './render';

/** 只合并当前时间序里连续的一段；外部承接不能因合并倒向过去。 */
export function canMergeJudgments(st: LedgerState, ids: string[]): boolean {
  const nodes = liveJudgments(st);
  const wanted = new Set(ids);
  if (wanted.size < 2) return false;
  const indices = nodes.flatMap((n, i) => wanted.has(n.id) ? [i] : []);
  if (indices.length !== wanted.size || indices[indices.length - 1] - indices[0] + 1 !== indices.length) return false;
  const selected = nodes.filter(n => wanted.has(n.id));
  if (selected.some(n => (n.mark === '？' || n.mark === '⏸') !== (selected[0].mark === '？' || selected[0].mark === '⏸'))) return false;
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  return renderGraph(st).edges.every(e => {
    if (wanted.has(e.from) === wanted.has(e.to)) return true;
    if (order.get(e.from)! >= order.get(e.to)!) return true; // 既有逆向关系不由此次合并造成
    const from = wanted.has(e.from) ? indices[0] : order.get(e.from)!;
    const to = wanted.has(e.to) ? indices[0] : order.get(e.to)!;
    return from < to;
  });
}
