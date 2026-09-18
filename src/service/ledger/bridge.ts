/**
 * ledgerBridge — 判断账 ↔ store 缓存 / AI 产出之间的纯函数桥（2026-09-05 GFT-fix 线；9-6 最简版）
 *
 * 账是唯一正本；nodes / edges / doc / groupMap 全是从账折算出来的缓存，形状保持 FocusCard/ThinkingEdge，
 * 现有画布、文档面板、注入、导出一个字不改照样工作。所有写入＝先造账行，再折算。
 */
import type { FocusCard } from '../../type/focusCard';
import type { ThinkingEdge } from '../../type/thinkingMap';
import type { DocSegment, WhiteboxMark } from '../whiteboxDoc';
import type { TidyAiOp, TidyInput } from '../tidyCore';
import { assertTidyScopeIds, validTidyRelation, tidyDomain } from '../tidyCore';
import { canMergeJudgments } from './topology';
import { markdownLines } from './text';
import {
  parseLedger, renderDoc, renderSourceDoc, renderGraph, liveJudgments, liveProse, themeOf, judgmentLines, proseLines, relationLine, sessionLine,
  aiDecision, legacyToLedger, appendLines, upgradeLedger, type LedgerState, type LedgerMark,
} from './index';

const BARE_ENTRY_RE = /^###\s*(◆|◇|？|\?|✗|⏸)\s*(.+?)\s*$/;
const ANCHORED_ENTRY_RE = /^###\s*(◆|◇|？|\?|✗|⏸)\s*(.+?)\s*\^(j\d+)\s*$/;
const DOM_RE = /^##\s+(.+?)\s*$/;

export interface DerivedCaches {
  nodes: FocusCard[];
  edges: ThinkingEdge[];
  doc: string;
  groupMap: Map<string, string>;
}

/** 账 → 缓存（FocusCard 形状；unread 来自 store 的未读集合，是视图态不是账的内容） */
export function deriveCaches(st: LedgerState, projectId: string, unreadIds: Set<string>): DerivedCaches {
  const g = renderGraph(st);
  const nodes: FocusCard[] = g.nodes.map(n => ({
    id: n.id,
    projectId,
    title: n.title,
    body: '',
    isDone: false,
    order: n.order,
    relatedIds: [],
    notes: [],
    commits: [],
    headCommitId: null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    anchor: n.id,
    ...(n.domain ? { group: n.domain } : {}),
    ...(n.superseded ? { superseded: true } : {}),
    ...(unreadIds.has(n.id) ? { unread: true } : {}),
  }));
  const edges: ThinkingEdge[] = g.edges.map(e => ({ id: e.id, from: e.from, to: e.to, type: 'relates' as const }));
  const groupMap = new Map(nodes.flatMap(n => (n.group ? [[n.id, n.group] as const] : [])));
  return { nodes, edges, doc: renderDoc(st), groupMap };
}

/** 编号分配器：j 与 p 共用一个计数 */
function allocator(st: LedgerState) {
  let n = st.nextNum;
  return (kind: 'j' | 'p') => `${kind}${n++}`;
}

/** 一段 AI 写的文档增量（自由论述 + 无锚条目头）→ 账行；返回条目 id 按出现序 */
function segmentToLines(st: LedgerState, seg: DocSegment, alloc: (k: 'j' | 'p') => string, isUpdate: boolean, provenance: boolean, source?: LedgerState): { lines: string[]; entryIds: string[] } {
  const domain = seg.domain.trim() || '其他';
  const lines: string[] = [];
  const entryIds: string[] = [];
  if (domain === '主题') {
    // 主题＝这张脉络记什么，一句话，只在还没有主题时收 AI 写的；有了就是人的，AI 不许改（改主题去 Doc）
    const text = seg.text.replace(/^#+.*$/gm, '').replace(/\s+/g, ' ').trim();
    if (!text || themeOf(st)) return { lines, entryIds };
    const emptyTheme = liveProse(st).find(p => p.domain === '主题');
    if (emptyTheme && isUpdate) lines.push(...aiDecision.rewrite(emptyTheme.id, text));
    else lines.push(...proseLines(alloc('p'), '主题', text));
    return { lines, entryIds };
  }
  if (domain === '主线') {
    // 主线＝状态叙述，不承载条目：误写的条目头降为加粗行；已有主线段就改它（替换语义），没有才新开
    const text = markdownLines(seg.text.split('\n')).map(({ line, code }) => {
      const m = !code && BARE_ENTRY_RE.exec(line.replace(/\s*\^j\d+\s*$/, ''));
      return m ? `**${m[1] === '?' ? '？' : m[1]} ${m[2].trim()}**` : line;
    }).join('\n').trim();
    if (!text) return { lines, entryIds };
    const main = isUpdate ? liveProse(st).find(p => p.domain === '主线' && /^p\d+$/.test(p.id)) : undefined;
    if (main) lines.push(aiDecision.remove(main.id));
    lines.push(...proseLines(alloc('p'), '主线', text));
    return { lines, entryIds };
  }
  let prose: string[] = [];
  let cur: { id: string; mark: WhiteboxMark; title: string; content: string[]; from?: string; rawFrom?: string[]; at?: number } | null = null;
  const flushProse = () => {
    const text = prose.join('\n').trim();
    if (text) lines.push(...proseLines(alloc('p'), domain, text));
    prose = [];
  };
  const flushEntry = () => {
    if (!cur) return;
    lines.push(...judgmentLines(cur.id, cur.mark, domain, cur.title, cur.content.join('\n').trim(), { ...(cur.from ? { mergedFrom: [cur.from] } : {}), rawFrom: cur.rawFrom, at: cur.at }));
    cur = null;
  };
  for (const { line: raw, code } of markdownLines(seg.text.split('\n'))) {
    const anchor = /\^(j\d+)\s*$/.exec(raw)?.[1];
    const stripped = raw.replace(/(?:\s*\^j\d+)+\s*$/, '');
    const m = !code && BARE_ENTRY_RE.exec(stripped);
    if (m) {
      flushEntry();
      flushProse();
      const id = alloc('j');
      const from = !source && provenance && anchor && st.judgments.has(anchor) ? anchor : undefined;
      const refs = [...new Set([...raw.slice(stripped.length).matchAll(/\^(j\d+)/g)].map(m => m[1]))];
      // 来源是辅助定位：缺失或不能安全对应时仍收下图文，只不据此继承时间和连线。
      const rawFrom = source && refs.length && refs.every(id => source.judgments.has(id) && !source.judgments.get(id)!.deleted)
        && (refs.length === 1 || canMergeJudgments(source, refs)) ? refs : undefined;
      cur = { id, mark: (m[1] === '?' ? '？' : m[1]) as WhiteboxMark, title: m[2].trim(), content: [], from, rawFrom, at: source && rawFrom ? Math.min(...rawFrom.map(id => source.judgments.get(id)!.createdAt)) : undefined };
      entryIds.push(id);
      continue;
    }
    if (cur) cur.content.push(raw);
    else prose.push(raw);
  }
  flushEntry();
  flushProse();
  return { lines, entryIds };
}

export interface GenerateLike {
  nodes: FocusCard[];
  edges: ThinkingEdge[];
  newIds: string[];
  docSegments?: DocSegment[];
  docEntryNodeIds?: string[];
  docMarks?: Array<{ anchor: string; to: WhiteboxMark; reason: string }>;
}

/** 生成/更新结果 → 账行。重画＝先写「重画」行（旧判断与走向整代作废），再写新内容；
 *  provenanceSource＝按 Log 重画：独立记录原始来源锚，保留来源顺序与连接 */
export function linesFromGenerate(
  st: LedgerState,
  result: GenerateLike,
  opts: { isUpdate: boolean; source: string; note: string; at: number; provenance?: boolean; provenanceSource?: LedgerState },
): { lines: string[]; rawLines: string[]; idMap: Map<string, string>; newIds: string[]; sourceIncomplete: boolean } {
  const lines: string[] = [sessionLine(opts.at, opts.source, opts.note)];
  const alloc = allocator(st);
  if (!opts.isUpdate) {
    lines.push('重画');
    // 主题是人定的基调，重画不动它：整代作废后原样再写一段
    const theme = themeOf(st);
    if (theme) lines.push(...proseLines(alloc('p'), '主题', theme));
  }
  const idMap = new Map<string, string>(); // AI 节点 id → 账 id
  const allEntryIds: string[] = [];
  for (const seg of result.docSegments ?? []) {
    if (seg.refs !== undefined) continue; // 共同正文等本轮编号全部落定再处理。
    const { lines: segLines, entryIds } = segmentToLines(st, seg, alloc, opts.isUpdate, !!opts.provenance, opts.provenanceSource);
    lines.push(...segLines);
    allEntryIds.push(...entryIds);
  }
  // 条目头出现序 ⇔ docEntryNodeIds 同序前缀对齐（与旧 applyDocIncrement 的 zip 规则一致）
  const count = Math.min(allEntryIds.length, result.docEntryNodeIds?.length ?? 0);
  for (let i = 0; i < count; i++) idMap.set(result.docEntryNodeIds![i], allEntryIds[i]);
  if (!opts.isUpdate && allEntryIds.length === 0 && !result.docSegments?.some(seg => seg.domain !== '主题' && seg.text.trim())) {
    throw new Error('未生成可用的图文，已保留原图，请重试。');
  }
  let sourceIncomplete = false;
  if (opts.provenanceSource && liveJudgments(opts.provenanceSource).length) {
    const source = opts.provenanceSource;
    const entries = liveJudgments(parseLedger(lines.join('\n')));
    const bySource = new Map<string, string | null>();
    for (const entry of entries) for (const from of entry.rawFrom ?? []) {
      bySource.set(from, bySource.has(from) ? null : entry.id);
    }
    sourceIncomplete = entries.some(j => !j.rawFrom?.length) || liveJudgments(source).some(j => !bySource.get(j.id));
    const order = new Map(liveJudgments(source).map((j, i) => [j.id, i]));
    // 都有来源时按原始顺序；否则沿本次明确承接排序，无关判断保持叙述顺序。
    if (entries.every(j => j.rawFrom?.length)) {
      entries.sort((a, b) => Math.min(...a.rawFrom!.map(id => order.get(id)!)) - Math.min(...b.rawFrom!.map(id => order.get(id)!)));
    } else {
      const generatedOrder = new Map(result.nodes.map((n, i) => [idMap.get(n.id), i]));
      entries.sort((a, b) => (generatedOrder.get(a.id) ?? 0) - (generatedOrder.get(b.id) ?? 0));
    }
    for (const entry of entries) lines.push(aiDecision.reorder(entry.id, '末'));
    // 只继承端点能唯一对应的原始连接；其余连接采用本次重画明确给出的关系。
    for (const e of renderGraph(source).edges) {
      const from = bySource.get(e.from), to = bySource.get(e.to);
      if (from && to && from !== to) lines.push(relationLine(to, from));
    }
  }
  // 边：新节点走 idMap；旧节点 id 已经是账 id；重画时所有节点都是新的
  const known = new Set<string>([...liveJudgments(st).map(j => j.id), ...allEntryIds]);
  const existing = new Set((opts.isUpdate ? st.relations : parseLedger(lines.join('\n')).relations).map(r => `${r.from}→${r.to}`));
  for (const e of result.edges) {
    const from = idMap.get(e.from) ?? e.from;
    const to = idMap.get(e.to) ?? e.to;
    if (from === to || !known.has(from) || !known.has(to)) continue;
    if (!opts.isUpdate && !(allEntryIds.includes(from) && allEntryIds.includes(to))) continue; // 重画只连新代
    const key = `${from}→${to}`;
    if (existing.has(key)) continue;
    existing.add(key);
    lines.push(relationLine(to, from));
  }
  // AI 改档（轻量整理：改档+留痕）
  for (const m of result.docMarks ?? []) {
    const j = st.judgments.get(m.anchor);
    if (j && !j.deleted) lines.push(`${aiDecision.remark(m.anchor, m.to as LedgerMark)}${m.reason ? ` ${m.reason.trim()}` : ''}`);
  }
  const rawLines = lines.filter(line => line !== '重画' && !/^AI 删 p\d+$/.test(line));
  // 同一次响应给出判断与共同正文；正文替换该章节说明，原始 Log 留新快照，不执行工作层删除。
  const generated = parseLedger(lines.join('\n'));
  const chapterEntries = [...(opts.isUpdate ? liveJudgments(st) : []), ...liveJudgments(generated)];
  const chapterProse = [...(opts.isUpdate ? liveProse(st) : []), ...liveProse(generated)];
  const chapters = new Map((result.docSegments ?? []).filter(seg => seg.refs !== undefined).map(seg => [seg.domain, seg]));
  for (const [domain, seg] of chapters) {
    if (domain === '主题' || !seg.text.trim()) continue;
    const refs = [...new Set(seg.refs!.map(ref => /^d\d+$/.test(ref) ? allEntryIds[Number(ref.slice(1)) - 1] : ref))]
      .filter(id => chapterEntries.some(j => j.id === id && j.domain === domain));
    const text = narrativeText(seg.text, refs);
    for (const p of chapterProse) if (p.domain === domain && /^p\d+$/.test(p.id)) lines.push(aiDecision.remove(p.id));
    const id = alloc('p');
    const newProse = proseLines(id, domain, text);
    lines.push(...newProse);
    rawLines.push(...newProse);
    const first = chapterEntries.find(j => j.domain === domain);
    if (first) lines.push(aiDecision.reorder(id, first.id));
  }
  const newIds = opts.isUpdate ? allEntryIds : [];
  return { lines, rawLines, idMap, newIds, sourceIncomplete };
}

const narrativeText = (text: string, refs: string[]): string => refs.length
  ? `${refs.map(id => `> ^${id}`).join('\n')}\n\n${text.trim()}` : text.trim();

/** 整理的输入：全部活着的判断、边、各域走向 */
export function tidyInput(st: LedgerState, unreadIds: Set<string>, raw?: LedgerState): Omit<TidyInput, 'target'> {
  const sourcesOf = (id: string, seen = new Set<string>()): string[] => {
    if (!raw || seen.has(id)) return [];
    seen.add(id);
    const j = st.judgments.get(id);
    if (!j) return [];
    if (j.rawFrom?.length) return j.rawFrom.filter(source => raw.judgments.has(source));
    if (j.mergedFrom.length) return [...new Set(j.mergedFrom.flatMap(source => sourcesOf(source, seen)))];
    const original = raw.judgments.get(id);
    return original?.source === j.source && original.createdAt === j.createdAt ? [id] : [];
  };
  const judgments = liveJudgments(st).map(j => ({
    id: j.id, title: j.title, body: j.content, mark: j.mark, domain: j.domain,
    question: j.mark === '？' || j.mark === '⏸', unread: unreadIds.has(j.id),
    sourceIds: sourcesOf(j.id),
  }));
  const edges = renderGraph(st).edges.map(e => [e.from, e.to] as [string, string]);
  const byDomain = new Map<string, string[]>();
  for (const p of liveProse(st)) {
    const text = p.lines.join('\n').trim();
    if (!text) continue;
    if (!byDomain.has(p.domain)) byDomain.set(p.domain, []);
    byDomain.get(p.domain)!.push(text);
  }
  const prose = [...byDomain.entries()].filter(([domain]) => domain !== '主题').map(([domain, texts]) => ({ domain, text: texts.join('\n\n') }));
  return { judgments, edges, prose, theme: themeOf(st), ...(raw ? { sourceDoc: renderSourceDoc(raw) } : {}) };
}

/** 新整理的操作流 → 账行：合并＝新判断「合并自」；去掉＝删；改锐利＝改；走向＝改该域第一段、删其余段 */
export function tidyOpsToLines(st: LedgerState, ops: TidyAiOp[], raw?: LedgerState, scopeIds?: ReadonlySet<string>): { lines: string[]; newIds: string[]; merged: number; dropped: number; linked: number; unlinked: number } {
  if (scopeIds?.size === 0) return { lines: [], newIds: [], merged: 0, dropped: 0, linked: 0, unlinked: 0 };
  for (const op of ops) {
    assertTidyScopeIds(op.kind === 'merge' ? op.memberIds : op.kind === 'revise' || op.kind === 'drop' ? [op.id] : op.kind === 'prose' || op.kind === 'add' ? [] : [op.from, op.to], scopeIds);
    if (scopeIds && op.kind === 'add') throw new Error('局部整理不新增判断。');
    {
      // 正文由写入层统一转义；标题仍须符合单行判断头，不能夹带元数据或另起操作。
      if ((op.kind === 'merge' || op.kind === 'revise' || op.kind === 'add') && op.title) {
        const probe = parseLedger(judgmentLines('j0', '◇', '正文', op.title).join('\n'));
        const j = probe.judgments.get('j0');
        if (probe.judgments.size !== 1 || !j || j.deleted || j.title !== op.title.trim() || j.content || j.mergedFrom.length || j.rawFrom?.length || probe.prose.length || probe.relations.length || probe.cuts.size || probe.sessions.length || probe.warnings.length) {
          throw new Error('整理标题包含账本指令，已保留原图文。');
        }
      }
    }
  }
  // 局部整理任何节点操作失败都整批拒绝，避免依赖它的章节正文单独落账。
  const invalid = (condition: boolean): boolean => {
    if (condition && scopeIds) throw new Error('局部整理包含不可执行的判断或关系，已保留原图文。');
    return condition;
  };
  const alloc = allocator(st);
  const lines: string[] = [];
  const newIds: string[] = [];
  let merged = 0, dropped = 0;
  let linked = 0, unlinked = 0;
  const used = new Set<string>();
  // 仅用于放置章节导语；判断本身的顺序仍由原有合并/改域动作维护。
  let chapterEntries = liveJudgments(st).map(j => ({ id: j.id, domain: j.domain }));
  const allowedChapters = new Set(chapterEntries.filter(j => scopeIds?.has(j.id)).map(j => j.domain));
  const changedChapters = new Set<string>();
  const mergedRefs = new Map<string, string>();
  // 先改关系再合并；拓扑校验看修正后的边，落账仍只追加原有「接/断」动作。
  const input = tidyInput(st, new Set(), raw);
  const evidenceContext = [input.sourceDoc ?? '', ...input.prose.map(p => p.text)].join('\n\n');
  st = { ...st, relations: [...st.relations], cuts: new Set(st.cuts) };
  const handledPairs = new Set<string>();
  for (const op of ops) {
    if (op.kind !== 'link' && op.kind !== 'unlink') continue;
    const key = `${op.from}→${op.to}`;
    if (handledPairs.has(key) || invalid(!validTidyRelation(op, input.judgments, evidenceContext))) continue;
    handledPairs.add(key);
    const exists = renderGraph(st).edges.some(e => e.from === op.from && e.to === op.to);
    if ((op.kind === 'link') === exists) continue;
    changedChapters.add(st.judgments.get(op.from)!.domain);
    changedChapters.add(st.judgments.get(op.to)!.domain);
    // 原句保存在动作行中，重放/同步时可审计；不能改写成新的用户判断。
    lines.push(`${op.kind === 'link' ? aiDecision.link(op.to, op.from) : aiDecision.unlink(op.to, op.from)} # ${JSON.stringify({ reason: op.reason, evidence: op.evidence })}`);
    if (op.kind === 'link') {
      st.cuts.delete(key);
      st.relations.push({ from: op.from, to: op.to, seq: st.lineCount + lines.length });
      linked++;
    } else {
      st.relations = st.relations.filter(r => r.from !== op.from || r.to !== op.to);
      st.cuts.add(key);
      unlinked++;
    }
  }
  for (const op of ops) {
    if (op.kind === 'add') {
      const draft = input.prose.map(p=>p.text).join('\n').replace(/\s+/g,' ');
      if (!op.evidence.trim() || !draft.includes(op.evidence.trim().replace(/\s+/g,' ')) || mergedRefs.has(op.id)) continue;
      const domain = tidyDomain(op.domain);
      if (!domain || !['◆','◇','？','✗','⏸'].includes(op.mark)) continue;
      if (chapterEntries.some(j=>st.judgments.get(j.id)?.title === op.title) || ops.some(other=>other !== op && other.kind === 'add' && other.title === op.title && mergedRefs.has(other.id))) continue;
      const id = alloc('j'); newIds.push(id); mergedRefs.set(op.id,id);
      lines.push(...judgmentLines(id,op.mark,domain,op.title,op.body));
      chapterEntries.push({id,domain}); changedChapters.add(domain);
    } else if (op.kind === 'merge') {
      const ids = op.memberIds.filter(id => { const j = st.judgments.get(id); return !!j && !j.deleted; });
      if (invalid((!!scopeIds && ids.length !== op.memberIds.length) || ids.some(id => used.has(id)) || !canMergeJudgments(st, ids))) continue;
      ids.forEach(id => used.add(id));
      const id = alloc('j');
      newIds.push(id);
      ids.forEach(member => mergedRefs.set(member, id));
      const domain = tidyDomain(op.domain) ?? st.judgments.get(ids[0])!.domain;
      ids.forEach(id => changedChapters.add(st.judgments.get(id)!.domain));
      changedChapters.add(domain);
      allowedChapters.add(domain);
      lines.push(...judgmentLines(id, op.mark, domain, op.title, op.body, { mergedFrom: ids }));
      const position = chapterEntries.findIndex(j => ids.includes(j.id));
      chapterEntries = chapterEntries.filter(j => !ids.includes(j.id));
      chapterEntries.splice(position, 0, { id, domain });
      merged += 1;
    } else if (op.kind === 'drop') {
      const j = st.judgments.get(op.id);
      if (invalid(!j || j.deleted || used.has(op.id) || j.mark === '？' || j.mark === '⏸')) continue;
      const edges = renderGraph(st).edges;
      if (invalid(edges.some(e => e.to === op.id) && edges.some(e => e.from === op.id))) continue;
      used.add(op.id);
      lines.push(aiDecision.remove(op.id));
      chapterEntries = chapterEntries.filter(j => j.id !== op.id);
      changedChapters.add(j!.domain);
      dropped += 1;
    } else if (op.kind === 'revise') {
      const j = st.judgments.get(op.id);
      if (invalid(!j || j.deleted || used.has(op.id))) continue;
      if (!j) continue;
      used.add(op.id);
      const before = lines.length;
      if (op.title && op.title !== j.title) lines.push(aiDecision.retitle(op.id, op.title));
      if (op.body && op.body !== j.content) lines.push(...aiDecision.rewrite(op.id, op.body));
      const domain = tidyDomain(op.domain);
      if (domain && domain !== j.domain) {
        lines.push(aiDecision.redomain(op.id, domain));
        chapterEntries.find(entry => entry.id === op.id)!.domain = domain;
        allowedChapters.add(domain);
      }
      if (lines.length !== before) {
        changedChapters.add(j.domain);
        changedChapters.add(domain ?? j.domain);
      }
    }
  }
  // 先确定最终章节再写导语；同章最后一份说明生效，始终位于首条判断前。
  const prose = new Map(ops.filter(op => op.kind === 'prose').map(op => [op.domain, op]));
  if (scopeIds) {
    for (const [domain, op] of prose) {
      if (domain === '主题' || domain === '主线' || !allowedChapters.has(domain)) throw new Error('局部整理包含选区外的章节，已保留原图文。');
      const refs = new Set((op.refs ?? []).map(id => mergedRefs.get(id) ?? id));
      const entries = chapterEntries.filter(j => j.domain === domain);
      if (!op.text.trim() || [...refs].some(id => !entries.some(j => j.id === id)) || entries.some(j => !refs.has(j.id))) {
        throw new Error('局部整理的章节正文未覆盖本章全部判断，已保留原图文。');
      }
    }
    for (const domain of changedChapters) {
      if (chapterEntries.some(j => j.domain === domain) && !prose.has(domain)) throw new Error('局部整理缺少受影响章节的同步正文，已保留原图文。');
    }
  }
  const explained = new Set<string>();
  for (const [domain, op] of prose) {
    if (!op.text.trim()) continue;
    const refs = [...new Set((op.refs ?? []).map(id => mergedRefs.get(id) ?? id))]
      .filter(id => chapterEntries.some(j => j.id === id && j.domain === domain));
    refs.forEach(id => explained.add(id));
    const text = narrativeText(op.text, refs);
    const blocks = liveProse(st).filter(p => p.domain === domain && /^p\d+$/.test(p.id));
    const first = chapterEntries.find(j => j.domain === domain);
    if (scopeIds && !first && !blocks.length && domain !== '主线') continue;
    const id = blocks[0]?.id ?? alloc('p');
    if (!blocks.length) lines.push(...proseLines(id, domain, text));
    else if (blocks[0].lines.join('\n').trim() !== text) lines.push(...aiDecision.rewrite(id, text));
    for (const b of blocks.slice(1)) lines.push(aiDecision.remove(b.id));
    if (first && (!blocks.length || !st.order.includes(first.id) || st.order.indexOf(id) > st.order.indexOf(first.id))) {
      lines.push(aiDecision.reorder(id, first.id));
    }
  }
  // 整章迁出且新正文已经承接全部判断时，收掉旧章导语，避免新正文后又重复旧版。
  for (const domain of new Set(liveJudgments(st).map(j => j.domain))) {
    if (chapterEntries.some(j => j.domain === domain) || prose.has(domain)) continue;
    const moved = liveJudgments(st).filter(j => j.domain === domain).map(j => mergedRefs.get(j.id) ?? j.id)
      .filter(id => chapterEntries.some(j => j.id === id));
    if ((scopeIds && changedChapters.has(domain)) || (moved.length && moved.every(id => explained.has(id)))) {
      for (const p of liveProse(st)) if (p.domain === domain && /^p\d+$/.test(p.id)) lines.push(aiDecision.remove(p.id));
    }
  }
  return { lines, newIds, merged, dropped, linked, unlinked };
}

/** 外部旧路写入并入：远端 nodes/doc 里账没有的条目（另一端还在写旧字段）→ 账行 */
export function linesFromLegacyDelta(
  st: LedgerState,
  remote: { nodes: FocusCard[]; edges: ThinkingEdge[]; doc: string },
  at: number,
): { lines: string[]; newIds: string[] } {
  const lines: string[] = [];
  const newIds: string[] = [];
  let domain = '';
  let cur: { id: string; mark: WhiteboxMark; title: string; content: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    lines.push(...judgmentLines(cur.id, cur.mark, domain, cur.title, cur.content.join('\n').trim()));
    newIds.push(cur.id);
    cur = null;
  };
  for (const { line, code } of markdownLines(remote.doc.split('\n'))) {
    if (code) { if (cur) cur.content.push(line); continue; }
    const dm = DOM_RE.exec(line);
    if (dm && !line.startsWith('###')) { flush(); domain = dm[1]; continue; }
    const em = ANCHORED_ENTRY_RE.exec(line);
    if (em) {
      flush();
      if (!st.judgments.has(em[3])) cur = { id: em[3], mark: (em[1] === '?' ? '？' : em[1]) as WhiteboxMark, title: em[2].trim(), content: [] };
      continue;
    }
    if (cur) cur.content.push(line);
  }
  flush();
  if (lines.length === 0) return { lines, newIds };
  const toLedgerId = new Map<string, string>();
  for (const n of remote.nodes) if (n.anchor) toLedgerId.set(n.id, n.anchor);
  const known = new Set<string>([...st.judgments.keys(), ...newIds]);
  const existing = new Set(st.relations.map(r => `${r.from}→${r.to}`));
  for (const e of remote.edges) {
    const from = toLedgerId.get(e.from) ?? e.from;
    const to = toLedgerId.get(e.to) ?? e.to;
    if (from === to || !known.has(from) || !known.has(to)) continue;
    if (!newIds.includes(from) && !newIds.includes(to)) continue;
    const key = `${from}→${to}`;
    if (existing.has(key)) continue;
    existing.add(key);
    lines.push(relationLine(to, from));
  }
  return { lines: [sessionLine(at, 'mcp', '外部写入并入'), ...lines], newIds };
}

/**
 * 一行库记录 → 账（网页端加载/同步与 MCP 端点共用同一规则）：
 *   有账读账（旧格式就地升级：走向段补号）；无账但有旧数据（迁移前的行）→ 当场一次性转账；
 *   另一端仍写旧字段（过渡期）→ 账里没有的条目并入。
 * `ledger` 是起点（远端同步时先与本地合并再传进来）。
 */
export function absorbLegacyRow(
  ledger: string,
  row: { nodes?: FocusCard[]; edges?: ThinkingEdge[]; doc?: string },
  at = Date.now(),
): { ledger: string; newIds: string[]; migrated: boolean; warnings: string[] } {
  const nodes = row.nodes ?? [];
  const edges = row.edges ?? [];
  const doc = row.doc ?? '';
  const warnings: string[] = [];
  let migrated = false;
  if (!ledger && (nodes.length > 0 || doc.trim())) {
    const conv = legacyToLedger({ nodes, edges, doc }, at);
    ledger = conv.ledger;
    migrated = true;
    warnings.push(...conv.warnings);
  }
  const up = upgradeLedger(ledger);
  if (up.changed) { ledger = up.text; migrated = true; }
  let newIds: string[] = [];
  if (ledger) {
    const delta = linesFromLegacyDelta(parseLedger(ledger), { nodes, edges, doc }, at);
    if (delta.lines.length) { ledger = appendLines(ledger, delta.lines); newIds = delta.newIds; migrated = true; }
  }
  return { ledger, newIds, migrated, warnings };
}

/** 便捷：文本 → 状态 + 缓存 */
export function foldLedger(ledger: string, projectId: string, unreadIds: Set<string>): { state: LedgerState; caches: DerivedCaches } {
  const state = parseLedger(ledger);
  return { state, caches: deriveCaches(state, projectId, unreadIds) };
}
