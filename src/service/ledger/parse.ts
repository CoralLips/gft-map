/**
 * 判断账解析＝折算（一遍过）：文本 → LedgerState。
 * 宽容：认不出的标记样行不吞、不报错，当自由文本归当前块；写坏的行为行只进 warnings。
 */
import type { LedgerMark, LedgerProse, LedgerState } from './types';
import { LEDGER_MARKS } from './types';
import { literalLine } from './text';

const SESSION_RE = /^\[场次\s+(\S+)(?:\s*·\s*([^\]·]*?))?(?:\s*·\s*([^\]]*?))?\s*\]\s*$/;
const PROSE_RE = /^走向(?:\s+(p\d+))?\s*\[([^\]]*)\]\s*$/;
const JUDGMENT_RE = /^(◆|◇|？|\?|✗|⏸)\s+(j\d+)\s+\[([^\]]*)\]\s+(.+?)(?:\s+=\s+((?:j\d+\s*)+?))?(?:\s+@(\S+))?\s*$/;
const COVER_RE = /^⊃\s+(c\d+)\s+\[([^\]]*)\]\s+(.+?)\s+=\s+((?:[jc]\d+\s*)+)(?:@(\S+))?\s*$/;
const REL_RE = /^←\s+([jc]\d+)\s+([jc]\d+)\s*$/;
const DECISION_RE = /^(本人|AI)\s+(改|删|接|断|序|拍|否|标|域|拆|并)\s+(.*)$/;
const ID_RE = /^([jcp]\d+)\b/;

/** 与折算器一致的正文边界；转义行不是操作，非法语法仍按原规则作为自由文字。 */
export function isLedgerBoundary(line: string): boolean {
  return SESSION_RE.test(line) || PROSE_RE.test(line) || JUDGMENT_RE.test(line) || COVER_RE.test(line)
    || REL_RE.test(line) || DECISION_RE.test(line);
}

const parseTime = (s: string | undefined, fallback: number): number => {
  if (!s) return fallback;
  const t = Date.parse(s);
  return Number.isNaN(t) ? fallback : t;
};

const normMark = (m: string): LedgerMark => (m === '?' ? '？' : (m as LedgerMark));

export function emptyLedgerState(): LedgerState {
  return { judgments: new Map(), relations: [], cuts: new Set(), relationNotes: new Map(), prose: [], sessions: [], domains: [], order: [], nextNum: 1, warnings: [], lineCount: 0 };
}

/** 一遍折算 */
export function parseLedger(text: string): LedgerState {
  const st = emptyLedgerState();
  const lines = text.split('\n');
  st.lineCount = lines.length;
  let seq = 0;
  let at = 0;
  let source = '未知';
  const proseById = new Map<string, LedgerProse>();
  /** 当前吸收后续自由行的块：判断表述 / 走向 / 改表述 */
  let sink: { kind: 'judgment'; id: string } | { kind: 'prose'; block: LedgerProse } | { kind: 'rewrite'; id: string; buf: string[] } | null = null;
  const touchDomain = (d: string) => { if (d && !st.domains.includes(d)) st.domains.push(d); };
  const bumpNum = (id: string) => { const n = Number(id.slice(1)); if (Number.isFinite(n) && n >= st.nextNum) st.nextNum = n + 1; };
  const flushRewrite = () => {
    if (sink?.kind !== 'rewrite') return;
    const text = sink.buf.join('\n').replace(/\n+$/, '');
    const j = st.judgments.get(sink.id);
    if (j) { j.content = text; j.updatedAt = at; return; }
    const p = proseById.get(sink.id);
    if (p) { p.lines = text ? text.split('\n') : []; p.at = at; }
  };
  const moveBefore = (id: string, target: string | '末') => {
    const i = st.order.indexOf(id);
    if (i === -1) return false;
    st.order.splice(i, 1);
    if (target === '末') { st.order.push(id); return true; }
    const k = st.order.indexOf(target);
    if (k === -1) { st.order.splice(i, 0, id); return false; }
    st.order.splice(k, 0, id);
    return true;
  };
  const appendBody = (line: string, i: number) => {
    // 没有块的散行→开一个「（无域）」走向块，绝不丢。
    if (!sink) {
      const block: LedgerProse = { id: `p_${i + 1}`, domain: '', lines: [], at, source, seq, deleted: false };
      st.prose.push(block);
      proseById.set(block.id, block);
      st.order.push(block.id);
      sink = { kind: 'prose', block };
    }
    if (sink.kind === 'prose') sink.block.lines.push(line);
    else if (sink.kind === 'judgment') { const j = st.judgments.get(sink.id)!; j.content = j.content ? `${j.content}\n${line}` : line; }
    else sink.buf.push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    seq++;
    const literal = literalLine(line);
    if (literal !== undefined) { appendBody(literal, i); continue; }

    const note=/^(?:本人|AI) 改 ([jc]\d+) 承接 ([jc]\d+)：(.+)$/.exec(line);
    if (note) {
      flushRewrite();sink=null;
      try { const value=JSON.parse(note[3]);if(typeof value!=='string')throw new Error();st.relationNotes!.set(`${note[2]}→${note[1]}`,value); }
      catch { st.warnings.push(`无效承接说明：${line}`); }
      continue;
    }
    const sm = SESSION_RE.exec(line);
    if (sm) {
      flushRewrite();
      at = parseTime(sm[1], at || Date.now());
      source = (sm[2] ?? '').trim() || source;
      st.sessions.push({ at, source, note: (sm[3] ?? '').trim(), seq });
      sink = null;
      continue;
    }
    const pm = PROSE_RE.exec(line);
    if (pm) {
      flushRewrite();
      const id = pm[1] ?? `p_${i + 1}`;
      const block: LedgerProse = { id, domain: pm[2].trim(), lines: [], at, source, seq, deleted: false };
      if (pm[1]) bumpNum(id);
      touchDomain(block.domain);
      st.prose.push(block);
      proseById.set(id, block);
      st.order.push(id);
      sink = { kind: 'prose', block };
      continue;
    }
    const jm = JUDGMENT_RE.exec(line);
    if (jm) {
      flushRewrite();
      const id = jm[2];
      if (st.judgments.has(id)) { st.warnings.push(`第 ${i + 1} 行：重复 id ${id}，后者忽略`); sink = null; continue; }
      const t = parseTime(jm[6], at);
      const mergedFrom = (jm[5] ?? '').trim().split(/\s+/).filter(Boolean);
      // 一条判断的时间＝它第一次出现的时间：合并出的判断取最早成员的时间，排在最早成员的位置（图是时间线，2026-09-06 用户拍）
      let createdAt = t;
      let slot = -1;
      for (const m of mergedFrom) {
        const x = st.judgments.get(m);
        if (!x) continue;
        createdAt = Math.min(createdAt, x.createdAt);
        const k = st.order.indexOf(m);
        if (k !== -1 && (slot === -1 || k < slot)) slot = k;
      }
      st.judgments.set(id, { id, mark: normMark(jm[1]), domain: jm[3].trim(), title: jm[4].trim(), content: '', createdAt, updatedAt: t, source, mergedFrom, deleted: false, seq });
      touchDomain(jm[3].trim());
      bumpNum(id);
      if (slot === -1) st.order.push(id); else st.order.splice(slot, 0, id);
      // 合并自：成员退休，边在渲染时改接到本条
      for (const m of mergedFrom) {
        const x = st.judgments.get(m);
        if (!x) { st.warnings.push(`第 ${i + 1} 行：合并来源 ${m} 不存在`); continue; }
        if (!x.deleted) { x.deleted = true; x.mergedInto = id; x.updatedAt = t; }
      }
      if (mergedFrom.length) {
        // 断开的关系跟随成员退休，否则合并会把刚纠正的误接复活。
        const moved = (ref: string) => st.judgments.get(ref)?.mergedInto === id ? id : ref;
        st.cuts = new Set([...st.cuts].map(key => key.split('→').map(moved).join('→')));
      }
      sink = { kind: 'judgment', id };
      continue;
    }
    const cm = COVER_RE.exec(line);
    if (cm) {
      // 旧账的上层判断：只读兼容，不显示、不盖任何东西
      flushRewrite();
      const id = cm[1];
      if (st.judgments.has(id)) { st.warnings.push(`第 ${i + 1} 行：重复 id ${id}，后者忽略`); sink = null; continue; }
      const t = parseTime(cm[5], at);
      st.judgments.set(id, { id, mark: '◇', domain: cm[2].trim(), title: cm[3].trim(), content: '', createdAt: t, updatedAt: t, source, mergedFrom: [], deleted: false, legacyCover: true, seq });
      bumpNum(id);
      sink = { kind: 'judgment', id };
      continue;
    }
    const rm = REL_RE.exec(line);
    if (rm) {
      flushRewrite();
      st.relations.push({ to: rm[1], from: rm[2], seq });
      sink = null;
      continue;
    }
    const dm = DECISION_RE.exec(line);
    if (dm) {
      flushRewrite();
      sink = null;
      const actor = dm[1];
      const verb = dm[2];
      const rest = dm[3].trim();
      const id = ID_RE.exec(rest)?.[1];
      const j = id ? st.judgments.get(id) : undefined;
      const p = id ? proseById.get(id) : undefined;
      const after = rest.replace(/^[jcp]\d+\s*/, '');
      if (verb === '接' || verb === '断') {
        const m2 = /^([jc]\d+)\s+([jc]\d+)/.exec(rest);
        if (!m2) { st.warnings.push(`第 ${i + 1} 行：${verb} 要两个 id`); continue; }
        if (verb === '接') {
          st.cuts.delete(`${m2[2]}→${m2[1]}`);
          st.relations.push({ to: m2[1], from: m2[2], seq });
        }
        else {
          st.relations = st.relations.filter(r => !(r.to === m2[1] && r.from === m2[2]));
          st.cuts.add(`${m2[2]}→${m2[1]}`); // 同时排除合并改接/删除短路产生的同一条边
        }
        continue;
      }
      if (!j && !p) { st.warnings.push(`第 ${i + 1} 行：${actor} ${verb} 指向不存在的 ${id ?? '?'}`); continue; }
      switch (verb) {
        case '改': {
          const field = /^(标题|表述|档|域)[：:]\s*(.*)$/.exec(after);
          if (!field) { st.warnings.push(`第 ${i + 1} 行：改 只认 标题／表述／档／域`); break; }
          const [, what, val] = field;
          if (what === '表述') { sink = { kind: 'rewrite', id: id!, buf: [] }; break; }
          if (what === '域') { const d = val.trim(); if (d) { if (j) j.domain = d; if (p) p.domain = d; touchDomain(d); } break; }
          if (!j) { st.warnings.push(`第 ${i + 1} 行：走向段只能改表述或域`); break; }
          if (what === '标题') { j.title = val.trim(); j.updatedAt = at; break; }
          const mk = val.trim().split(/\s+/)[0] ?? ''; // 档后面可以跟理由（AI 改 j9 档：✗ 被甲推翻）
          if (mk === '?' || (LEDGER_MARKS as readonly string[]).includes(mk)) { j.mark = normMark(mk); j.updatedAt = at; } else st.warnings.push(`第 ${i + 1} 行：档 只认 ◆◇？✗⏸`);
          break;
        }
        case '删': if (j) { j.deleted = true; j.updatedAt = at; } if (p) p.deleted = true; break;
        case '序': {
          const target = after.trim();
          if (target === '末') { moveBefore(id!, '末'); break; }
          const tm = ID_RE.exec(target);
          if (!tm || !moveBefore(id!, tm[1])) st.warnings.push(`第 ${i + 1} 行：序 的目标不存在`);
          break;
        }
        // ——旧动词，只读兼容——
        case '拍': if (j) { j.mark = '◆'; j.updatedAt = at; } break;
        case '否': if (j) { j.mark = '✗'; j.updatedAt = at; } break;
        case '标': { const mk = /^(◆|◇|？|\?|✗|⏸)/.exec(after); if (j && mk) { j.mark = normMark(mk[1]); j.updatedAt = at; } break; }
        case '域': { const d = after.trim(); if (d) { if (j) j.domain = d; if (p) p.domain = d; touchDomain(d); } break; }
        case '拆': if (j) { j.deleted = true; j.updatedAt = at; } break;
        case '并': break;
      }
      continue;
    }

    appendBody(line, i);
  }
  flushRewrite();
  return st;
}

/** 把一行判断标题投影成图节点标题：？/⏸ 档补问号 */
export function projectTitle(mark: LedgerMark, title: string): string {
  return (mark === '？' || mark === '⏸') && !/[?？]\s*$/.test(title) ? `${title}？` : title;
}

export function isMark(s: string): s is LedgerMark {
  return (LEDGER_MARKS as readonly string[]).includes(s);
}
