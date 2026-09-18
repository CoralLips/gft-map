/**
 * 旧正本 → 判断账（一次性迁移，纯函数）：nodes + edges + doc → 账文本。
 * 原则：文档逐行原样进账（走向段＋条目）；节点 id 改用锚（jN）；边转 ← 行；
 *       无锚节点分配新号并标〔仅图〕；节点时间用 @ 后缀保留（带毫秒，往返无损）。
 */
import type { FocusCard } from '../../type/focusCard';
import type { ThinkingEdge } from '../../type/thinkingMap';
import { sessionLine, isoLocal } from './write';
import { bodyLines, markdownLines } from './text';

const MARK_RE = /^###\s*(◆|◇|？|\?|✗|⏸)\s*(.+?)\s*\^(j\d+)\s*$/;
const DOM_RE = /^##\s+(.+?)\s*$/;

export interface LegacyMap {
  nodes: FocusCard[];
  edges: ThinkingEdge[];
  doc: string;
}

export interface LegacyConversion {
  ledger: string;
  /** 旧节点 id → 账 id（锚） */
  idMap: Map<string, string>;
  warnings: string[];
}

export function legacyToLedger(m: LegacyMap, at: number = Date.now(), source = '迁移'): LegacyConversion {
  const warnings: string[] = [];
  const idMap = new Map<string, string>();
  let maxNum = 0;
  for (const n of m.nodes) {
    if (n.anchor && /^j\d+$/.test(n.anchor)) { idMap.set(n.id, n.anchor); maxNum = Math.max(maxNum, Number(n.anchor.slice(1))); }
  }
  for (const { line, code } of markdownLines(m.doc.split('\n'))) { const em = !code && MARK_RE.exec(line); if (em) maxNum = Math.max(maxNum, Number(em[3].slice(1))); }
  let nextNum = maxNum + 1;
  for (const n of m.nodes) if (!idMap.has(n.id)) { idMap.set(n.id, `j${nextNum++}`); warnings.push(`节点「${n.title}」无锚，分配 ${idMap.get(n.id)}（仅图）`); }
  const byAnchor = new Map<string, FocusCard>();
  for (const n of m.nodes) byAnchor.set(idMap.get(n.id)!, n);

  const out: string[] = [sessionLine(at, source, '自 nodes+edges+doc 一次性转换')];
  // 文档逐行：域头 → 走向段（带号）；条目头 → 判断行（带节点时间）；其余行原样
  let domain = '';
  let opened = false; // 当前是否已经开了一个 sink（走向或判断）
  const seen = new Set<string>();
  for (const { line, code } of markdownLines(m.doc.split('\n'))) {
    const dm = !code && DOM_RE.exec(line);
    if (dm && !line.startsWith('###')) { domain = dm[1]; out.push(`走向 p${nextNum++} [${domain}]`); opened = true; continue; }
    const em = !code && MARK_RE.exec(line);
    if (em) {
      const anchor = em[3];
      const n = byAnchor.get(anchor);
      const mark = em[1] === '?' ? '？' : em[1];
      out.push(`${mark} ${anchor} [${domain}] ${em[2]}${n ? ` @${isoLocal(n.createdAt, true)}` : ''}`);
      seen.add(anchor);
      if (!n) warnings.push(`文档条目 ${anchor}「${em[2]}」图上无对应节点`);
      opened = true;
      continue;
    }
    if (!opened) { out.push(`走向 p${nextNum++} []`); opened = true; }
    out.push(...bodyLines(line));
  }
  // 图上有、文档没有的节点
  for (const n of m.nodes) {
    const id = idMap.get(n.id)!;
    if (seen.has(id)) continue;
    const mark = n.superseded ? '✗' : (/[?？]\s*$/.test(n.title) ? '？' : '◇');
    out.push(`${mark} ${id} [${n.group ?? ''}] ${n.title.replace(/[?？]\s*$/, mark === '？' ? '' : '')} @${isoLocal(n.createdAt, true)}`);
    if (n.body?.trim()) out.push(...bodyLines(n.body.trim()));
    warnings.push(`节点 ${id}「${n.title}」仅在图上，已补进账`);
  }
  // 边
  for (const e of m.edges) {
    const from = idMap.get(e.from), to = idMap.get(e.to);
    if (!from || !to) { warnings.push(`边 ${e.id} 端点不存在，丢弃`); continue; }
    out.push(`← ${to} ${from}`);
  }
  return { ledger: out.join('\n'), idMap, warnings };
}
