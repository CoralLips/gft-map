/**
 * Doc 编辑 → 账行（2026-09-06 用户拍：Doc 随便改，切走/失焦时算一遍，每条判断最多记一行）
 *
 * 把编辑后的白盒文档和账里的现状比对，只写「事实」，账里原来的行一个字不动：
 *   条目（按锚 ^jN 认）：标题/表述/档/域变了各记一行；锚没了记删；没锚的新条目头分新号
 *   走向段：在编辑稿里一字不差找得到的就是没动；找不到的，域首的按顺序改/删/新，条目后面的并进表述、原段记删（内容不丢）
 *   顺序：域内条目的先后变了记 序（挪动最少的那几条）
 */
import type { LedgerMark, LedgerProse, LedgerState } from './types';
import { renderDoc, liveJudgments, liveProse } from './render';
import { judgmentLines, proseLines, decision, sessionLine } from './write';
import { markdownLines } from './text';
import { appendSourceLog, type SourceRecord } from '../sourceLog';

/** Called only for a committed human edit, never for model output or polling. */
export function recordDocumentInput(raw: string, before: LedgerState, after: LedgerState, at = Date.now()): string {
  const records: SourceRecord[] = [];
  const add = (id: string, content: string, changed: boolean) => {
    if (changed && content.trim()) records.push({v:1,provider:'human',sessionId:'document',id:`${at}:${id}`,role:'user',title:'文稿中的人工输入',content,ts:at});
  };
  for (const p of liveProse(after)) {
    if (p.domain === '主题') continue; // Changing a filter is not changing its source materials.
    const text = p.lines.filter(line => !/^>\s*\^j\d+\s*$/.test(line)).join('\n').trim();
    const old = liveProse(before).find(old => old.id === p.id)?.lines.filter(line => !/^>\s*\^j\d+\s*$/.test(line)).join('\n').trim();
    add(p.id, `人工输入／修订 · ${p.domain || '正文'}\n${text}`, !!text && old !== text);
  }
  for (const j of liveJudgments(after)) {
    const old = before.judgments.get(j.id);
    add(j.id, `${j.mark} ${j.title}\n${j.content}`, !old || old.title !== j.title || old.content !== j.content || old.mark !== j.mark);
  }
  return appendSourceLog(raw, records);
}

/** The theme has its own editor, while remaining one record in the same ledger. */
export function splitDocTheme(doc: string): { theme: string; body: string } {
  const body: string[] = [], theme: string[] = [];
  let inTheme = false;
  for (const {line, code} of markdownLines(doc.split('\n'))) {
    if (!code && /^##\s+/.test(line)) {
      inTheme = /^##\s+主题\s*$/.test(line);
      if (inTheme) continue;
    }
    (inTheme ? theme : body).push(line);
  }
  return {theme: theme.join('\n').trim(), body: body.join('\n').replace(/^\n+/, '')};
}

/** The body editor cannot replace the separately maintained theme. */
export function joinDocTheme(theme: string, body: string): string {
  // A manually typed '主题' heading in the body is ordinary prose, not settings.
  const content = markdownLines(body.split('\n')).map(({line, code}) =>
    !code && /^##\s+主题\s*$/.test(line) ? '## 关于主题' : line,
  ).join('\n');
  const sectioned = content.trim() && !/^\s*##\s+/.test(content) ? `## 主线\n\n${content}` : content;
  const scope = theme.replace(/\s+/g, ' ').trim();
  return scope ? `## 主题\n\n${scope}\n\n${sectioned}` : sectioned;
}

const DOM_RE = /^##\s+(.+?)\s*$/;
const ENTRY_RE = /^###\s*(◆|◇|？|\?|✗|⏸)\s*(.*?)\s*(?:\^(j\d+))?\s*$/;
const REFERENCE_RE = /^>\s*(?:(◆|◇|？|\?|✗|⏸)\s*(.*?)\s*)?\^(j\d+)\s*$/;

interface DocEntry { id?: string; mark?: LedgerMark; title: string; tail: string; reference?: boolean }
interface DocDomain { name: string; lead: string; entries: DocEntry[]; hasReferences: boolean }

const trimBlank = (s: string): string => s.replace(/^\n+|\n+$/g, '');
const canWrite = (id: string): boolean => /^p\d+$/.test(id);

/** 编辑后的文档 → 域 / 共同叙述 / 条目；旧 H3 后的正文保留在 tail，引用后的正文归叙述。 */
function parseEditedDoc(text: string): DocDomain[] {
  const domains: DocDomain[] = [];
  type DraftDomain = { name: string; lead: string[]; entries: Array<Omit<DocEntry, 'tail'> & { tail: string[] }>; hasReferences: boolean };
  let cur: DraftDomain = { name: '', lead: [], entries: [], hasReferences: false };
  let entry: { tail: string[] } | null = null;
  const closeDomain = () => {
    if (cur.name || cur.lead.some(l => l.trim()) || cur.entries.length) {
      domains.push({ name: cur.name, lead: trimBlank(cur.lead.join('\n')), entries: cur.entries.map(e => ({ ...e, tail: trimBlank(e.tail.join('\n')) })), hasReferences: cur.hasReferences });
    }
  };
  for (const { line, code } of markdownLines(text.split('\n'))) {
    if (code) { if (entry) entry.tail.push(line); else cur.lead.push(line); continue; }
    const dm = DOM_RE.exec(line);
    if (dm && !line.startsWith('###')) { entry = null; closeDomain(); cur = { name: dm[1].trim(), lead: [], entries: [], hasReferences: false }; continue; }
    const ref = REFERENCE_RE.exec(line);
    if (ref) {
      cur.entries.push({ id: ref[3], mark: ref[1] ? (ref[1] === '?' ? '？' : ref[1]) as LedgerMark : undefined, title: ref[2]?.trim() ?? '', tail: [], reference: true });
      // 引用组是节点在 Doc 中的可见行：删除它仍表示删除判断，不是取消关联。
      // 后续解释属于整组 prose，绝不能成为最后一个节点的 canonical body。
      cur.lead.push(`> ^${ref[3]}`);
      cur.hasReferences = true;
      entry = null;
      continue;
    }
    const em = ENTRY_RE.exec(line);
    if (em) {
      const e = { id: em[3], mark: (em[1] === '?' ? '？' : em[1]) as LedgerMark, title: em[2].trim(), tail: [] as string[] };
      cur.entries.push(e);
      entry = e;
      continue;
    }
    if (entry) entry.tail.push(line); else cur.lead.push(line);
  }
  closeDomain();
  return domains;
}

/** 在一段文本里一字不差地抠掉一个走向段；抠不到返回 null */
function carveOne(text: string, p: LedgerProse): string | null {
  const t = trimBlank(p.lines.join('\n'));
  if (!t) return null;
  const pos = text.lastIndexOf(t);
  if (pos === -1) return null;
  // 只认完整段落；给首句添几个字不能被误判成“原段未变＋新增零散文字”。
  if ((pos > 0 && text[pos - 1] !== '\n') || (pos + t.length < text.length && text[pos + t.length] !== '\n')) return null;
  return trimBlank(text.slice(0, pos).replace(/\n+$/, '') + '\n' + text.slice(pos + t.length));
}

/** 最少挪动：不在最长递增子序列里的就是被挪过的 */
function movedItems(newOrder: string[], curOrder: string[]): string[] {
  const pos = new Map(curOrder.map((id, i) => [id, i]));
  const seq = newOrder.filter(id => pos.has(id));
  const idxs = seq.map(id => pos.get(id)!);
  const len = new Array<number>(idxs.length).fill(1);
  const prev = new Array<number>(idxs.length).fill(-1);
  let best = 0;
  for (let i = 0; i < idxs.length; i++) {
    for (let k = 0; k < i; k++) if (idxs[k] < idxs[i] && len[k] + 1 > len[i]) { len[i] = len[k] + 1; prev[i] = k; }
    if (len[i] > len[best]) best = i;
  }
  const keep = new Set<string>();
  for (let i = idxs.length ? best : -1; i !== -1; i = prev[i]) keep.add(seq[i]);
  return seq.filter(id => !keep.has(id));
}

/** 编辑后的文档 → 要追加的账行（空数组＝没变） */
export function docEditLines(st: LedgerState, edited: string, at = Date.now()): { lines: string[]; newIds: string[] } {
  if (edited === renderDoc(st)) return { lines: [], newIds: [] };
  const lines: string[] = [];
  const newIds: string[] = [];
  let n = st.nextNum;
  const alloc = (kind: 'j' | 'p') => `${kind}${n++}`;
  const live = liveJudgments(st);
  const liveById = new Map(live.map(j => [j.id, j]));
  const prose = liveProse(st);
  const proseById = new Map(prose.map(p => [p.id, p]));
  const docDomains = parseEditedDoc(edited);
  const previousDocDomains = parseEditedDoc(renderDoc(st));

  // 现状的域序 → 域改名按位置认（数量相同、名字不同、新名字现状里没有）
  const curDomainOrder: string[] = [];
  for (const id of st.order) {
    const j = liveById.get(id);
    const p = proseById.get(id);
    const d = j ? j.domain : p ? p.domain : undefined;
    if (d !== undefined && !curDomainOrder.includes(d)) curDomainOrder.push(d);
  }
  const rename = new Map<string, string>();
  if (docDomains.length === curDomainOrder.length) {
    docDomains.forEach((d, i) => { if (d.name !== curDomainOrder[i] && !curDomainOrder.includes(d.name)) rename.set(curDomainOrder[i], d.name); });
  }
  const shownName = (domain: string) => rename.get(domain) ?? domain;
  const renamedFrom = (name: string) => [...rename.entries()].find(([, to]) => to === name)?.[0];

  const seenIds = new Set<string>();
  for (const d of docDomains) {
    // 该域在账里的显示序列（活着的判断与走向段）
    const seqIds = st.order.filter(id => {
      const j = liveById.get(id);
      if (j) return shownName(j.domain) === d.name;
      const p = proseById.get(id);
      return !!p && shownName(p.domain) === d.name;
    });
    const posOf = (id: string) => seqIds.indexOf(id);
    const existing = d.entries.filter(e => e.id && liveById.has(e.id));
    const existingIds = existing.map(e => e.id!);
    const firstPos = existingIds.length ? Math.min(...existingIds.map(posOf).filter(x => x >= 0)) : seqIds.length;

    const tails = new Map<string, string>(existing.filter(e => !e.reference).map(e => [e.id!, e.tail]));
    const domainProse = prose.filter(p => shownName(p.domain) === d.name);
    const hasReferences = (p: LedgerProse) => markdownLines(p.lines).some(({ line, code }) => !code && REFERENCE_RE.test(line));
    const narrative = d.hasReferences || domainProse.some(hasReferences);
    if (narrative) {
      // 一个章节的引用组与共同解释仍使用现有 prose。旧 H3 后未改动的独立段落
      // 保持原位置；同章其余正文合并回同一段，存储只留编号、不复制标题和档位。
      const trailing = new Set<string>();
      for (const p of domainProse) {
        if (hasReferences(p)) continue;
        for (const [id, tail] of tails) {
          const rest = carveOne(tail, p);
          if (rest !== null) { tails.set(id, rest); trailing.add(p.id); break; }
        }
      }
      const blocks = domainProse.filter(p => !trailing.has(p.id) && canWrite(p.id));
      const text = d.lead.trim();
      const first = blocks[0];
      let proseId = first?.id;
      if (text) {
        if (first) {
          if (first.lines.join('\n').trim() !== text) lines.push(...decision.rewrite(first.id, text));
          if (first.domain !== d.name) lines.push(decision.redomain(first.id, d.name));
        } else {
          proseId = alloc('p');
          lines.push(...proseLines(proseId, d.name, text));
        }
        const before = existingIds[0];
        if (before && (!first || st.order.indexOf(proseId!) > st.order.indexOf(before))) lines.push(decision.reorder(proseId!, before));
      } else if (first) lines.push(decision.remove(first.id));
      for (const p of blocks.slice(1)) lines.push(decision.remove(p.id));
      for (const p of domainProse) if (trailing.has(p.id) && p.domain !== d.name && canWrite(p.id)) lines.push(decision.redomain(p.id, d.name));
    } else {
      // ① 域首导语作为连续正文原位编辑；不能抠出旧句后把新段落追加到判断后面。
      const leadBlocks = seqIds.slice(0, firstPos).flatMap(id => proseById.has(id) ? [proseById.get(id)!] : []);
      const previousLead = previousDocDomains.find(previous => shownName(previous.name) === d.name)?.lead ?? '';
      if (d.lead !== previousLead) {
        const writable = leadBlocks.filter(p => canWrite(p.id));
        const [first, ...others] = writable;
        if (d.lead) {
          if (first) lines.push(...decision.rewrite(first.id, d.lead));
          else {
            const id = alloc('p');
            lines.push(...proseLines(id, d.name, d.lead));
            if (existingIds[0]) lines.push(decision.reorder(id, existingIds[0]));
          }
        } else if (first) lines.push(decision.remove(first.id));
        for (const p of others) lines.push(decision.remove(p.id));
      }
      if (renamedFrom(d.name)) for (const id of seqIds.slice(0, firstPos)) if (proseById.has(id) && canWrite(id)) lines.push(decision.redomain(id, d.name));

      // ② 条目后面的走向段：先看谁的 tail 里一字不差地有它（先问按位置该归的那条，再问其他条），抠出来；谁都没有 → 删（内容已并进表述）
      for (const pid of seqIds.slice(firstPos + 1)) {
        const p = proseById.get(pid);
        if (!p) continue;
        const ppos = posOf(pid);
        const owner = existingIds.filter(id => posOf(id) < ppos).sort((a, b) => posOf(b) - posOf(a))[0];
        const candidates = [...(owner ? [owner] : []), ...existingIds.filter(id => id !== owner)];
        let carved = false;
        for (const id of candidates) {
          const rest = carveOne(tails.get(id)!, p);
          if (rest !== null) { tails.set(id, rest); carved = true; break; }
        }
        if (!carved && canWrite(pid)) lines.push(decision.remove(pid));
      }
    }

    // ③ 条目
    for (const e of d.entries) {
      const cur = e.id ? liveById.get(e.id) : undefined;
      if (!cur) {
        if (e.reference) continue;
        const id = alloc('j');
        newIds.push(id);
        lines.push(...judgmentLines(id, e.mark ?? '◇', d.name, e.title || '未命名', e.tail));
        continue;
      }
      seenIds.add(cur.id);
      if (e.title && e.title !== cur.title) lines.push(decision.retitle(cur.id, e.title));
      if (e.mark && e.mark !== cur.mark) lines.push(decision.remark(cur.id, e.mark));
      if (d.name !== cur.domain) lines.push(decision.redomain(cur.id, d.name));
      const content = tails.get(cur.id) ?? '';
      if (!e.reference && content !== trimBlank(cur.content)) lines.push(...decision.rewrite(cur.id, content));
    }

    // ④ 顺序：域内条目先后变了 → 序（只挪最少的那几条）
    const curOrder = live.filter(j => shownName(j.domain) === d.name).map(j => j.id);
    const afterDomain = narrative ? live[live.findIndex(j => j.id === curOrder[curOrder.length - 1]) + 1]?.id : undefined;
    const shownOrder = previousDocDomains.find(previous => shownName(previous.name) === d.name)?.entries
      .flatMap(e => e.id && liveById.has(e.id) ? [e.id] : []) ?? [];
    // 引用组可能跨过一个仍以 H3 显示的节点；阅读顺序不同不意味着用户重排了时间线。
    const reordered = !narrative || movedItems(existingIds, shownOrder).length > 0;
    for (const id of reordered ? movedItems(existingIds, curOrder) : []) {
      const after = existingIds[existingIds.indexOf(id) + 1];
      lines.push(decision.reorder(id, after ?? afterDomain ?? '末'));
    }
  }
  // ⑤ 锚没了 → 删
  for (const j of live) if (!seenIds.has(j.id)) lines.push(decision.remove(j.id));
  // 整章从编辑稿移除时，正文也随之删除，不能留下只有旧说明的幽灵章节。
  const shownDomains = new Set(docDomains.map(d => d.name));
  for (const p of prose) if (!shownDomains.has(shownName(p.domain)) && canWrite(p.id)) lines.push(decision.remove(p.id));
  if (lines.length === 0) return { lines: [], newIds: [] };
  return { lines: [sessionLine(at, '本地', '编辑文档'), ...lines], newIds };
}
