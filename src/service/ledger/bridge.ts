/**
 * ledgerBridge — 判断账 ↔ store 缓存 / AI 产出之间的纯函数桥（2026-09-05 GFT-fix 线；9-6 最简版）
 *
 * 账是唯一正本；nodes / edges / doc / groupMap 全是从账折算出来的缓存，形状保持 FocusCard/ThinkingEdge，
 * 现有画布、文档面板、注入、导出一个字不改照样工作。所有写入＝先造账行，再折算。
 */
import {checkedRelationReason} from '../relationReason';
import type { FocusCard } from '../../type/focusCard';
import type { ThinkingEdge } from '../../type/thinkingMap';
import type { DocSegment, WhiteboxMark } from '../whiteboxDoc';
import type { TidyAiOp, TidyInput } from '../tidyCore';
import { assertTidyScopeIds, validTidyRelation, tidyDomain } from '../tidyCore';
import { canMergeJudgments } from './topology';
import { mapReferenceLines, markdownLines } from './text';
import {
  parseLedger, renderDoc, renderGraph, liveJudgments, liveProse, themeOf, judgmentLines, proseLines, relationLine, sessionLine,
  aiDecision, type LedgerState, type LedgerMark,
} from './index';

const BARE_ENTRY_RE = /^###\s*(◆|◇|？|\?|✗|⏸)\s*(.+?)\s*$/;

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
  const edges: ThinkingEdge[] = g.edges.map(e => ({ id: e.id, from: e.from, to: e.to, type: 'relates' as const, ...(e.reason ? {reason:e.reason} : {}) }));
  const groupMap = new Map(nodes.flatMap(n => (n.group ? [[n.id, n.group] as const] : [])));
  return { nodes, edges, doc: renderDoc(st), groupMap };
}

/** 编号分配器：j 与 p 共用一个计数 */
function allocator(st: LedgerState) {
  let n = st.nextNum;
  return (kind: 'j' | 'p') => `${kind}${n++}`;
}

/** 一段 AI 写的文档增量（自由论述 + 无锚条目头）→ 账行；返回条目 id 按出现序 */
function segmentToLines(st: LedgerState, seg: DocSegment, alloc: (k: 'j' | 'p') => string): { lines: string[]; entryIds: string[] } {
  const domain = seg.domain.trim() || '其他';
  const lines: string[] = [];
  const entryIds: string[] = [];
  if (domain === '主题') {
    // 主题＝这张脉络记什么，一句话，只在还没有主题时收 AI 写的；有了就是人的，AI 不许改（改主题去 Doc）
    const text = seg.text.replace(/^#+.*$/gm, '').replace(/\s+/g, ' ').trim();
    if (!text || themeOf(st)) return { lines, entryIds };
    const emptyTheme = liveProse(st).find(p => p.domain === '主题');
    if (emptyTheme) lines.push(...aiDecision.rewrite(emptyTheme.id, text));
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
    const main = liveProse(st).find(p => p.domain === '主线' && /^p\d+$/.test(p.id));
    if (main) lines.push(aiDecision.remove(main.id));
    lines.push(...proseLines(alloc('p'), '主线', text));
    return { lines, entryIds };
  }
  let prose: string[] = [];
  let cur: { id: string; mark: WhiteboxMark; title: string; content: string[] } | null = null;
  const flushProse = () => {
    const text = prose.join('\n').trim();
    if (text) lines.push(...proseLines(alloc('p'), domain, text));
    prose = [];
  };
  const flushEntry = () => {
    if (!cur) return;
    lines.push(...judgmentLines(cur.id, cur.mark, domain, cur.title, cur.content.join('\n').trim()));
    cur = null;
  };
  for (const { line: raw, code } of markdownLines(seg.text.split('\n'))) {
    const stripped = raw.replace(/(?:\s*\^j\d+)+\s*$/, '');
    const m = !code && BARE_ENTRY_RE.exec(stripped);
    if (m) {
      flushEntry();
      flushProse();
      const id = alloc('j');
      cur = { id, mark: (m[1] === '?' ? '？' : m[1]) as WhiteboxMark, title: m[2].trim(), content: [] };
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
  docRevisions?: Array<{ anchor: string; title?: string; body: string }>;
}

/** 生成/更新结果 → 接在现有账之后的账行（空账即首次生成）。 */
export function linesFromGenerate(
  st: LedgerState,
  result: GenerateLike,
  opts: { source: string; note: string; at: number; requireChapterDoc?: boolean },
): { lines: string[]; idMap: Map<string, string>; newIds: string[] } {
  const lines: string[] = [sessionLine(opts.at, opts.source, opts.note)];
  const alloc = allocator(st);
  const idMap = new Map<string, string>(); // AI 节点 id → 账 id
  const allEntryIds: string[] = [];
  for (const seg of result.docSegments ?? []) {
    if (seg.refs !== undefined) continue; // 共同正文等本轮编号全部落定再处理。
    const { lines: segLines, entryIds } = segmentToLines(st, seg, alloc);
    lines.push(...segLines);
    allEntryIds.push(...entryIds);
  }
  // 条目头出现序 ⇔ docEntryNodeIds 同序前缀对齐（与旧 applyDocIncrement 的 zip 规则一致）
  const count = Math.min(allEntryIds.length, result.docEntryNodeIds?.length ?? 0);
  for (let i = 0; i < count; i++) idMap.set(result.docEntryNodeIds![i], allEntryIds[i]);
  // 边：新节点走 idMap；旧节点 id 已经是账 id
  const known = new Set<string>([...liveJudgments(st).map(j => j.id), ...allEntryIds]);
  const existing = new Set(st.relations.map(r => `${r.from}→${r.to}`));
  const currentReasons = new Map(renderGraph(st).edges.map(e => [`${e.from}→${e.to}`,e.reason ?? '']));
  for (const e of result.edges) {
    const from = idMap.get(e.from) ?? e.from;
    const to = idMap.get(e.to) ?? e.to;
    if (from === to || !known.has(from) || !known.has(to)) continue;
    const key = `${from}→${to}`;
    if (!existing.has(key)) {
      existing.add(key);
      lines.push(relationLine(to, from));
    }
    const currentReason = currentReasons.get(key);
    if (e.reason !== undefined && e.reason.trim() !== (currentReason ?? '')) {
      lines.push(aiDecision.edgeNote(to,from,checkedRelationReason(e.reason)));
      currentReasons.set(key,e.reason.trim());
    }
  }
  // 原位补充同一判断，不分配新编号、不改关系；与受影响章节一起校验后原子保存。
  const revised = new Set<string>();
  for (const revision of result.docRevisions ?? []) {
    const j = st.judgments.get(revision.anchor);
    if (!j || j.deleted || revised.has(revision.anchor) || !revision.body.trim()) {
      throw new Error('节点修订引用不存在、重复或不适用，已保留原图文。');
    }
    if (revision.title !== undefined) {
      const title = revision.title.trim();
      const probe = parseLedger(judgmentLines('j0', '◇', '正文', title).join('\n'));
      const check = probe.judgments.get('j0');
      if (!title || probe.judgments.size !== 1 || !check || check.title !== title || check.deleted
        || check.content || check.mergedFrom.length || probe.prose.length
        || probe.relations.length || probe.cuts.size || probe.sessions.length || probe.warnings.length) {
        throw new Error('节点修订标题包含无效指令，已保留原图文。');
      }
      if (title !== j.title) lines.push(aiDecision.retitle(j.id, title));
    }
    if (revision.body.trim() !== j.content.trim()) lines.push(...aiDecision.rewrite(j.id, revision.body));
    revised.add(j.id);
  }
  // AI 改档（轻量整理：改档+留痕）
  for (const m of result.docMarks ?? []) {
    const j = st.judgments.get(m.anchor);
    if (j && !j.deleted) lines.push(`${aiDecision.remark(m.anchor, m.to as LedgerMark)}${m.reason ? ` ${m.reason.trim()}` : ''}`);
  }
  // 同一次响应给出判断与章节正文；正文替换该章节原有说明。
  const generated = parseLedger(lines.join('\n'));
  const chapterEntries = [...liveJudgments(st), ...liveJudgments(generated)];
  const chapterProse = [...liveProse(st), ...liveProse(generated)];
  const resolve = (ref: string) => /^d\d+$/.test(ref) ? allEntryIds[Number(ref.slice(1)) - 1] : ref;
  const chapters = new Map((result.docSegments ?? []).filter(seg => seg.refs !== undefined && seg.text.trim()).map(seg => [seg.domain, seg.text]));
  // 本轮新增判断所在的章没给正文时，沿用原正文、把新判断补在章末（D63），不因漏写整次作废。
  const pending = opts.requireChapterDoc ? liveJudgments(generated).map(j => j.domain) : [];
  for (const domain of new Set([...chapters.keys(), ...pending])) {
    if (domain === '主题') continue;
    const blocks = chapterProse.filter(p => p.domain === domain && /^p\d+$/.test(p.id));
    const members = chapterEntries.filter(j => j.domain === domain).map(j => j.id);
    const base = chapters.get(domain) ?? blocks.map(p => p.lines.join('\n')).join('\n\n');
    if (!base.trim()) continue; // 没有底稿：判断按原样完整显示，不写只有引用的空正文
    const text = narrativeText(base, members, resolve);
    for (const p of blocks) lines.push(aiDecision.remove(p.id));
    const id = alloc('p');
    lines.push(...proseLines(id, domain, text));
    const first = chapterEntries.find(j => j.domain === domain);
    if (first) lines.push(aiDecision.reorder(id, first.id));
  }
  return { lines, idMap, newIds: allEntryIds };
}

/**
 * 章节正文落账：正文里写在讲到它位置的引用行原位保留（D61），每条判断只引用一次；
 * 本章判断没在正文里出现引用的补在章末，保证每条判断都在 Doc 里看得到（D63）。
 */
function narrativeText(text: string, refs: string[], resolve: (token: string) => string | undefined = token => token): string {
  const placed = new Set<string>();
  const marker = '\u0000ref:';
  const body = mapReferenceLines(text.trim(), token => {
    const id = resolve(token);
    if (!id || !refs.includes(id) || placed.has(id)) return undefined;
    placed.add(id);
    return `${marker}${id}`;
  }).split('\n');
  // 引用自成一段：与前后行文之间各留一个空行，连续的引用保持成组。
  const out: string[] = [];
  body.forEach((line, i) => {
    const isRef = line.startsWith(`> ^${marker}`), previousRef = i > 0 && body[i - 1].startsWith(`> ^${marker}`);
    if (isRef !== previousRef && out.length && out[out.length - 1].trim() && line.trim()) out.push('');
    out.push(isRef ? line.replace(marker, '') : line);
  });
  const rest = refs.filter(id => !placed.has(id));
  const prose = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return rest.length ? `${prose}\n\n${rest.map(id => `> ^${id}`).join('\n')}`.trim() : prose;
}

/** 整理的输入：全部活着的判断、边、各域走向 */
export function tidyInput(st: LedgerState, unreadIds: Set<string>): Omit<TidyInput, 'cap'> {
  const judgments = liveJudgments(st).map(j => ({
    id: j.id, title: j.title, body: j.content, mark: j.mark, domain: j.domain,
    question: j.mark === '？' || j.mark === '⏸', unread: unreadIds.has(j.id),
  }));
  const edges = renderGraph(st).edges.map(e => [e.from, e.to, e.reason] as [string, string, string?]);
  const byDomain = new Map<string, string[]>();
  for (const p of liveProse(st)) {
    const text = p.lines.join('\n').trim();
    if (!text) continue;
    if (!byDomain.has(p.domain)) byDomain.set(p.domain, []);
    byDomain.get(p.domain)!.push(text);
  }
  const prose = [...byDomain.entries()].filter(([domain]) => domain !== '主题').map(([domain, texts]) => ({ domain, text: texts.join('\n\n') }));
  const legacy = legacyChapters(st);
  return { judgments, edges, prose, theme: themeOf(st), ...(legacy.length ? { legacyChapters: legacy } : {}) };
}

/**
 * 还是 D61 之前排法的章节：有判断却没有章节正文、有判断没被正文引用（更早的导语＋小标题），
 * 或正文第一行就是引用（D52 把引用组放在章首；新写法先提出本章问题）。只看排法、不看字数。
 * 整理时一并转换；没转完的章节下次整理仍会列出，不需要额外的转换入口或标记。
 */
export function legacyChapters(st: LedgerState): string[] {
  const out: string[] = [];
  const prose = liveProse(st);
  for (const domain of new Set(liveJudgments(st).map(j => j.domain))) {
    const lines = prose.filter(p => p.domain === domain).flatMap(p => markdownLines(p.lines));
    const refs = new Set(lines.flatMap(({ line, code }) => code ? [] : [/^>\s*\^(j\d+)\s*$/.exec(line)?.[1] ?? '']));
    const first = lines.find(({ line, code }) => code || line.trim());
    const startsWithRef = !!first && !first.code && /^>\s*\^j\d+\s*$/.test(first.line);
    if (!first || startsWithRef || liveJudgments(st).some(j => j.domain === domain && !refs.has(j.id))) out.push(domain);
  }
  return out;
}

/** 新整理的操作流 → 账行：合并＝新判断「合并自」；去掉＝删；改锐利＝改；走向＝改该域第一段、删其余段 */
export function tidyOpsToLines(st: LedgerState, ops: TidyAiOp[], scopeIds?: ReadonlySet<string>, options?: { cap?: number; forced?: boolean }): { lines: string[]; newIds: string[]; merged: number; dropped: number; linked: number; unlinked: number } {
  if (scopeIds?.size === 0) return { lines: [], newIds: [], merged: 0, dropped: 0, linked: 0, unlinked: 0 };
  // 超上限时同一问题可跨时间合并；系统兜底合并（forced）还允许待定与已定混合（D63）。
  const mergeRule = { crossTime: options?.cap !== undefined && liveJudgments(st).length > options.cap, mixMarks: !!options?.forced };
  for (const op of ops) {
    if(op.kind==='link')checkedRelationReason(op.reason);
    assertTidyScopeIds(op.kind === 'merge' ? op.memberIds : op.kind === 'revise' || op.kind === 'drop' ? [op.id] : op.kind === 'prose' || op.kind === 'add' ? [] : [op.from, op.to], scopeIds);
    if (scopeIds && op.kind === 'add') throw new Error('局部整理不新增判断。');
    {
      // 正文由写入层统一转义；标题仍须符合单行判断头，不能夹带元数据或另起操作。
      if ((op.kind === 'merge' || op.kind === 'revise' || op.kind === 'add') && op.title) {
        const probe = parseLedger(judgmentLines('j0', '◇', '正文', op.title).join('\n'));
        const j = probe.judgments.get('j0');
        if (probe.judgments.size !== 1 || !j || j.deleted || j.title !== op.title.trim() || j.content || j.mergedFrom.length || probe.prose.length || probe.relations.length || probe.cuts.size || probe.sessions.length || probe.warnings.length) {
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
  const mergedRefs = new Map<string, string>();
  // 先改关系再合并；拓扑校验看修正后的边，落账仍只追加原有「接/断」动作。
  const input = tidyInput(st, new Set());
  const evidenceContext = input.prose.map(p => p.text).join('\n\n');
  st = { ...st, relations: [...st.relations], cuts: new Set(st.cuts) };
  const handledPairs = new Set<string>();
  for (const op of ops) {
    if (op.kind !== 'link' && op.kind !== 'unlink') continue;
    const key = `${op.from}→${op.to}`;
    if (handledPairs.has(key) || invalid(!validTidyRelation(op, input.judgments, evidenceContext))) continue;
    handledPairs.add(key);
    const exists = renderGraph(st).edges.some(e => e.from === op.from && e.to === op.to);
    if (op.kind === 'link' && exists) {
      if ((renderGraph(st).edges.find(e => e.from === op.from && e.to === op.to)?.reason ?? '') === op.reason.trim()) continue;
      lines.push(aiDecision.edgeNote(op.to,op.from,op.reason.trim()));
      continue;
    }
    if (op.kind === 'unlink' && !exists) continue;
    // 原句保存在动作行中，重放/同步时可审计；不能改写成新的用户判断。
    lines.push(`${op.kind === 'link' ? aiDecision.link(op.to, op.from) : aiDecision.unlink(op.to, op.from)} # ${JSON.stringify({ reason: op.reason, evidence: op.evidence })}`);
    if (op.kind === 'link') {
      lines.push(aiDecision.edgeNote(op.to,op.from,op.reason.trim()));
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
      // 节点上限（D63）：新增只用剩下的名额，超出的不写；它的原句仍在文稿里。
      if (options?.cap !== undefined && chapterEntries.length >= options.cap) continue;
      const id = alloc('j'); newIds.push(id); mergedRefs.set(op.id,id);
      lines.push(...judgmentLines(id,op.mark,domain,op.title,op.body));
      chapterEntries.push({id,domain});
    } else if (op.kind === 'merge') {
      const ids = op.memberIds.filter(id => { const j = st.judgments.get(id); return !!j && !j.deleted; });
      if (invalid((!!scopeIds && ids.length !== op.memberIds.length) || ids.some(id => used.has(id)) || !canMergeJudgments(st, ids, mergeRule))) continue;
      ids.forEach(id => used.add(id));
      const id = alloc('j');
      newIds.push(id);
      ids.forEach(member => mergedRefs.set(member, id));
      const domain = tidyDomain(op.domain) ?? st.judgments.get(ids[0])!.domain;
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
      dropped += 1;
    } else if (op.kind === 'revise') {
      const j = st.judgments.get(op.id);
      if (invalid(!j || j.deleted || used.has(op.id))) continue;
      if (!j) continue;
      used.add(op.id);
      if (op.title && op.title !== j.title) lines.push(aiDecision.retitle(op.id, op.title));
      if (op.body && op.body !== j.content) lines.push(...aiDecision.rewrite(op.id, op.body));
      const domain = tidyDomain(op.domain);
      if (domain && domain !== j.domain) {
        lines.push(aiDecision.redomain(op.id, domain));
        chapterEntries.find(entry => entry.id === op.id)!.domain = domain;
        allowedChapters.add(domain);
      }
    }
  }
  // 章节正文（D63）：模型给了就用；没给而本章判断有增减的，沿用原正文并换上合并后的编号。
  // 正文没讲到的判断补在章末，模型漏写一章不再让整次整理作废。同章最后一份说明生效。
  const prose = new Map(ops.flatMap(op => op.kind === 'prose' && op.text.trim() ? [[op.domain, op.text] as const] : []));
  if (scopeIds) {
    for (const domain of prose.keys())
      if (domain === '主题' || !allowedChapters.has(domain)) throw new Error('局部整理包含选区外的章节，已保留原图文。');
  }
  const original = liveJudgments(st).map(j => ({ id: j.id, domain: j.domain }));
  const membersOf = (entries: Array<{ id: string; domain: string }>, domain: string) => entries.filter(j => j.domain === domain).map(j => j.id);
  const resolve = (id: string) => mergedRefs.get(id) ?? id;
  const proseOf = (domain: string) => liveProse(st).filter(p => p.domain === domain && /^p\d+$/.test(p.id));
  // 空正文收掉原本就没有节点的章节（D68）；仍有节点的章当作没写，原文保留；
  // 本次节点全部迁出的章由下面的整章迁出处理。
  const emptied = new Set(ops.flatMap(op => op.kind === 'prose' && !op.text.trim() ? [op.domain] : []));
  for (const domain of emptied) {
    if (prose.has(domain) || domain === '主题' || domain === '主线') continue;
    if (membersOf(chapterEntries, domain).length || membersOf(original, domain).length) continue;
    for (const b of proseOf(domain)) lines.push(aiDecision.remove(b.id));
  }
  // 整章迁出且两章都没给新正文（如系统兜底合并）：旧正文接到判断去的那章，不随章节消失（D65）。
  const carried = new Map<string, string[]>();
  for (const domain of new Set(original.map(j => j.domain))) {
    if (prose.has(domain) || membersOf(chapterEntries, domain).length) continue;
    const text = proseOf(domain).map(b => b.lines.join('\n')).join('\n\n').trim();
    const moved = original.find(j => j.domain === domain && mergedRefs.has(j.id));
    const target = moved && chapterEntries.find(j => j.id === resolve(moved.id))?.domain;
    if (text && target && target !== domain && !prose.has(target)) carried.set(target, [...(carried.get(target) ?? []), text]);
  }
  for (const domain of new Set([...prose.keys(), ...chapterEntries.map(j => j.domain), ...original.map(j => j.domain)])) {
    // 已有主题属于用户的收录边界，普通整理不能改写；空主题仍可初始化。历史数据里放在主题下的判断也不牵动它。
    if (domain === '主题' && (themeOf(st) || !prose.has(domain))) continue;
    const members = membersOf(chapterEntries, domain);
    const before = membersOf(original, domain);
    const changed = members.length !== before.length || members.some(id => !before.includes(id));
    const blocks = proseOf(domain);
    const provided = prose.get(domain);
    if (provided === undefined && !changed) continue;
    if (provided === undefined && !members.length) {
      // 整章迁出：判断都去了别的章并在那里引用，旧导语随之收掉。
      for (const b of blocks) lines.push(aiDecision.remove(b.id));
      continue;
    }
    const first = chapterEntries.find(j => j.domain === domain);
    if (scopeIds && !first && !blocks.length && domain !== '主线') continue;
    const base = provided ?? [...blocks.map(b => b.lines.join('\n')), ...(carried.get(domain) ?? [])].join('\n\n');
    if (!base.trim() && !blocks.length) continue; // 没有底稿：判断按原样完整显示，不写只有引用的空正文
    const text = narrativeText(base, members, resolve);
    const id = blocks[0]?.id ?? alloc('p');
    if (!blocks.length) lines.push(...proseLines(id, domain, text));
    else if (blocks[0].lines.join('\n').trim() !== text) lines.push(...aiDecision.rewrite(id, text));
    for (const b of blocks.slice(1)) lines.push(aiDecision.remove(b.id));
    if (first && (!blocks.length || !st.order.includes(first.id) || st.order.indexOf(id) > st.order.indexOf(first.id))) {
      lines.push(aiDecision.reorder(id, first.id));
    }
  }
  return { lines, newIds, merged, dropped, linked, unlinked };
}

/** 便捷：文本 → 状态 + 缓存 */
export function foldLedger(ledger: string, projectId: string, unreadIds: Set<string>): { state: LedgerState; caches: DerivedCaches } {
  const state = parseLedger(ledger);
  return { state, caches: deriveCaches(state, projectId, unreadIds) };
}
