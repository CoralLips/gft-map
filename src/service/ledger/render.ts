/**
 * 判断账 → 视图（纯函数）：白盒文档文本 / 图。
 * 显示规则三条：同一条以最后一行为准（解析时已折算）；删了的不显示、边自动接续；顺序按写入先后、序 过的优先。
 */
import type { LedgerEdge, LedgerJudgment, LedgerNode, LedgerProse, LedgerState } from './types';
import { projectTitle } from './parse';
import { markdownLines } from './text';

/** 显示顺序下标（不在 order 里的按 seq 排在最后） */
function orderIndex(st: LedgerState): Map<string, number> {
  const m = new Map<string, number>();
  st.order.forEach((id, i) => m.set(id, i));
  return m;
}

/** 活着的判断（不含旧上层判断），按显示顺序 */
export function liveJudgments(st: LedgerState): LedgerJudgment[] {
  const idx = orderIndex(st);
  return [...st.judgments.values()]
    .filter(j => !j.deleted && !j.legacyCover)
    .sort((a, b) => (idx.get(a.id) ?? Infinity) - (idx.get(b.id) ?? Infinity) || a.seq - b.seq);
}

/** 主题（这张脉络记什么）：域为「主题」的那段走向，一句话；没有则空串 */
export function themeOf(st: LedgerState): string {
  return liveProse(st).find(p => p.domain === '主题')?.lines.join(' ').replace(/\s+/g, ' ').trim() ?? '';
}

/** 活着的走向段，按显示顺序 */
export function liveProse(st: LedgerState): LedgerProse[] {
  const idx = orderIndex(st);
  return st.prose.filter(p => !p.deleted).sort((a, b) => (idx.get(a.id) ?? Infinity) - (idx.get(b.id) ?? Infinity) || a.seq - b.seq);
}

/** 图：节点＝活着的判断；边＝承接经过合并改接、删除短路之后，只留两头都活着的 */
export function renderGraph(st: LedgerState): { nodes: LedgerNode[]; edges: LedgerEdge[] } {
  const idx = orderIndex(st);
  const nodes: LedgerNode[] = liveJudgments(st).map(j => ({
    id: j.id,
    title: projectTitle(j.mark, j.title),
    domain: j.domain,
    mark: j.mark,
    unresolved: j.mark === '？' || j.mark === '⏸',
    superseded: j.mark === '✗',
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    seq: j.seq,
    order: idx.get(j.id) ?? Number.MAX_SAFE_INTEGER,
  }));
  const alive = new Set(nodes.map(n => n.id));
  // 合并改接：端点沿 mergedInto 走到头
  const resolveMerged = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (!seen.has(cur)) {
      seen.add(cur);
      const next = st.judgments.get(cur)?.mergedInto;
      if (!next) break;
      cur = next;
    }
    return cur;
  };
  // 较晚同步进来的原始连接可能还指向重画前的来源编号。
  const rewritten = new Map<string, string | null>();
  for (const j of st.judgments.values()) {
    const target = resolveMerged(j.id);
    if (alive.has(target)) for (const source of j.rawFrom ?? []) {
      // 一份来源被拆成多个判断时，没有唯一落点；不能用最后一个覆盖前面那个。
      rewritten.set(source, !rewritten.has(source) || rewritten.get(source) === target ? target : null);
    }
  }
  const resolve = (id: string): string => {
    const merged = resolveMerged(id);
    return alive.has(merged) ? merged : rewritten.get(id) ?? merged;
  };
  let edges: Array<[string, string]> = st.relations.map(r => [resolve(r.from), resolve(r.to)]);
  // 删除短路：不活着的端点（删了的、旧上层判断、不存在的）用上游×下游接上
  const dead = new Set<string>();
  for (const [a, b] of edges) { if (!alive.has(a)) dead.add(a); if (!alive.has(b)) dead.add(b); }
  for (const d of dead) {
    const preds = edges.filter(e => e[1] === d && e[0] !== d).map(e => e[0]);
    const succs = edges.filter(e => e[0] === d && e[1] !== d).map(e => e[1]);
    edges = edges.filter(e => e[0] !== d && e[1] !== d);
    for (const p of preds) for (const s of succs) edges.push([p, s]);
  }
  const seen = new Set<string>();
  const out: LedgerEdge[] = [];
  for (const [from, to] of edges) {
    if (from === to || !alive.has(from) || !alive.has(to)) continue;
    const key = `${from}→${to}`;
    if (seen.has(key) || st.cuts.has(key)) continue;
    seen.add(key);
    out.push({ id: `le_${key}`, from, to });
  }
  return { nodes, edges: out };
}

const docMemo = new WeakMap<LedgerState, string>();

/** 白盒文档：## 域（首次出现序）→ 域内按显示顺序的走向段与条目；条目头 ### {五档} 标题 ^id。
 *  按状态对象记忆（状态由 parseLedger 整体新建、之后不改），同一份状态多处读只算一次 */
export function renderDoc(st: LedgerState): string {
  const hit = docMemo.get(st);
  if (hit !== undefined) return hit;
  const out = renderDocRaw(st);
  docMemo.set(st, out);
  return out;
}

/** 模型与回查使用完整判断表述，不能从阅读视图反推资料。 */
export function renderSourceDoc(st: LedgerState): string {
  return renderDocRaw(st, true);
}

function renderDocRaw(st: LedgerState, source = false): string {
  type Block = { key: number; domain: string; lines: string[] };
  const idx = orderIndex(st);
  const key = (id: string, seq: number) => (idx.get(id) ?? Number.MAX_SAFE_INTEGER / 2 + seq);
  const blocks: Block[] = [];
  const covered = new Set<string>();
  for (const p of liveProse(st)) {
    // 引用只保存编号，节点名和档位始终从同一份判断派生。旧导语没有引用，不会隐藏节点正文。
    const hasExplanation = p.lines.some(line => line.trim() && !/^>\s*\^j\d+\s*$/.test(line));
    const lines = markdownLines(p.lines).flatMap(({ line, code }) => {
      const ref = !code && /^>\s*\^(j\d+)\s*$/.exec(line);
      if (!ref) return [line];
      const j = st.judgments.get(ref[1]);
      if (!j || j.deleted || j.legacyCover || j.domain !== p.domain || !hasExplanation) return [];
      if (!source && covered.has(j.id)) return [];
      covered.add(j.id);
      return [`> ${j.mark} ${j.title} ^${j.id}`];
    });
    blocks.push({ key: key(p.id, p.seq), domain: p.domain, lines });
  }
  for (const j of st.judgments.values()) if (!j.deleted && !j.legacyCover && (source || !covered.has(j.id))) blocks.push({ key: key(j.id, j.seq), domain: j.domain, lines: [`### ${j.mark} ${j.title} ^${j.id}`, ...(j.content ? j.content.split('\n') : [])] });
  blocks.sort((a, b) => a.key - b.key);
  const seen: string[] = [];
  const byDomain = new Map<string, Block[]>();
  for (const b of blocks) {
    if (!byDomain.has(b.domain)) { byDomain.set(b.domain, []); seen.push(b.domain); }
    byDomain.get(b.domain)!.push(b);
  }
  // 主题第一、主线第二（这张脉络记什么、现在到哪了），其余按首次出现
  const pinned = ['主题', '主线'].filter(d => byDomain.has(d));
  const order = [...pinned, ...seen.filter(d => !pinned.includes(d))];
  const out: string[] = [];
  for (const d of order) {
    if (d) out.push(`## ${d}`);
    for (const b of byDomain.get(d)!) out.push(b.lines.join('\n').trim());
  }
  return out.filter(Boolean).join('\n\n');
}

/** 文档字数（整理回执与顶栏灰字用） */
export function docChars(st: LedgerState): number {
  return renderDoc(st).replace(/\s+/g, '').length;
}

/**
 * D53 时间主干：每条判断只画最近的一条正向来路；完整关系留在账和缓存中。
 * 这里仅投影已有承接，不能根据时间相邻生成关系。
 */
export function timelineEdges<E extends { from: string; to: string }>(nodes: Array<{ id: string; order: number }>, edges: E[]): E[] {
  const orderOf = new Map(nodes.map(n => [n.id, n.order]));
  const best = new Map<string, E>();
  for (const e of edges) {
    const fo = orderOf.get(e.from);
    const to = orderOf.get(e.to);
    if (fo === undefined || to === undefined || fo >= to) continue;
    const cur = best.get(e.to);
    if (!cur || orderOf.get(cur.from)! < fo) best.set(e.to, e);
  }
  return edges.filter(e => best.get(e.to) === e);
}
