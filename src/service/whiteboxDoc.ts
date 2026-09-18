/**
 * 白盒文档（whitebox doc）——项目的源码层（2026-08-22 用户拍板：文档为源码、图为投影）
 *
 * 99/1 原则的落点：AI 只产条目（内容 100% 自由），文档的结构操作全部由本模块
 * 确定性完成（追加、插域、编锚、记日志）——AI 永远不碰整份文档，
 * 「只追加不改写」由工程保证，不靠模型自觉。
 *
 * 1% harness 语法（机器要解析的部分，仅此四条）：
 *  1. 域 = `## 域名` 二级标题（「主线」「死路」「场次日志」为保留槽位）
 *  2. 条目 = `### {◆|◇|？|✗|⏸} 塔尖短句 ^jN`，正文到下一个标题为止、不限长度
 *  3. 锚 ^jN 全文档唯一——node.anchor 经它锚定文档条目（投影外键）
 *  4. 修改判断 = 状态改标＋追加留痕行，不删旧文（本模块暂只实现追加；改标后续步）
 */

/** 判断五档标记（◆结论/◇假设/？悬案/✗已否决/⏸暂缓） */
export type WhiteboxMark = '◆' | '◇' | '？' | '✗' | '⏸';

export const WHITEBOX_MARKS: readonly WhiteboxMark[] = ['◆', '◇', '？', '✗', '⏸'];

/** 保留槽位（不算自由域） */
const RESERVED = ['主线', '死路', '场次日志'];

export interface WhiteboxEntry {
  /** 锚（不带 ^ 前缀，如 "j3"）——node.anchor 与之对应 */
  anchor: string;
  mark: WhiteboxMark;
  /** 塔尖短句（展示铁律只管这一行 ≤16 字；图上 title 与之同源） */
  title: string;
  /** 完整表述——判断的全部内容、论证、语境；不限长度（完整性优先） */
  content: string;
  /** 所属域（章节名）；死路条目 domain='死路' */
  domain: string;
}

export interface ParsedWhiteboxDoc {
  topic: string;
  /** > 定位：一句话 */
  positioning: string;
  /** 「主线」槽位的自由文字 */
  mainline: string;
  /** 自由域（按文档出现序），含各域条目 */
  domains: Array<{ name: string; entries: WhiteboxEntry[] }>;
  /** 死路槽位的条目 */
  deadEnds: WhiteboxEntry[];
  /** 场次日志行（不含 "- " 前缀） */
  logs: string[];
}

/** 新骨架（首次生成时用）。9-1 标题单源：doc 不存 # 标题（project 名由顶栏渲染、
 * 导出时装配），定位占位行一并退役——parse 的 topic/positioning 字段保留兼容人手写文档 */
export function emptyWhiteboxDoc(): string {
  return `## 主线

（当前核心问题、追到哪了——每场可重写，这一节是活的）

## 死路

## 场次日志
`;
}

const ENTRY_HEAD_RE = /^###\s*(◆|◇|？|\?|✗|⏸)\s*(.+?)\s*\^(j\d+)\s*$/;

/** 解析（投影/lint/组装共用；宽松容错：识别不了的行归入所在段落正文） */
export function parseWhiteboxDoc(doc: string): ParsedWhiteboxDoc {
  const lines = doc.split('\n');
  const out: ParsedWhiteboxDoc = { topic: '', positioning: '', mainline: '', domains: [], deadEnds: [], logs: [] };

  let section: string | null = null; // 当前 ## 章节名
  let entry: WhiteboxEntry | null = null;
  const contentBuf: string[] = [];
  const mainlineBuf: string[] = [];

  const flushEntry = () => {
    if (!entry) return;
    entry.content = contentBuf.join('\n').trim();
    if (entry.domain === '死路') out.deadEnds.push(entry);
    else {
      let d = out.domains.find(x => x.name === entry!.domain);
      if (!d) { d = { name: entry.domain, entries: [] }; out.domains.push(d); }
      d.entries.push(entry);
    }
    entry = null;
    contentBuf.length = 0;
  };

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1 && !out.topic) { out.topic = h1[1].trim(); continue; }
    const pos = line.match(/^>\s*定位[:：]\s*(.*)$/);
    if (pos) { out.positioning = pos[1].trim(); continue; }

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flushEntry();
      section = h2[1].trim();
      // 域登记（保空域也可见——新建域先于条目存在的情况）
      if (!RESERVED.includes(section) && !out.domains.find(d => d.name === section)) {
        out.domains.push({ name: section, entries: [] });
      }
      continue;
    }

    const head = line.match(ENTRY_HEAD_RE);
    if (head && section) {
      flushEntry();
      const mark = (head[1] === '?' ? '？' : head[1]) as WhiteboxMark;
      entry = { anchor: head[3], mark, title: head[2].trim(), content: '', domain: section };
      continue;
    }

    if (entry) { contentBuf.push(line); continue; }
    if (section === '主线') { mainlineBuf.push(line); continue; }
    if (section === '场次日志') {
      const log = line.match(/^-\s+(.+)$/);
      if (log) out.logs.push(log[1].trim());
    }
  }
  flushEntry();
  out.mainline = mainlineBuf.join('\n').trim();
  return out;
}

/** 全文档扫最大锚号，返回下一个可用编号（追加条目编锚用） */
export function nextAnchorNum(doc: string): number {
  let max = 0;
  const re = /\^j(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return max + 1;
}

export interface NewWhiteboxEntry {
  mark: WhiteboxMark;
  title: string;
  content: string;
  domain: string;
}

/**
 * 确定性追加（本模块的心脏，全部结构操作在此）：
 * - 条目插进对应域章节尾部；域不存在 → 在「死路」节前新建
 * - ✗ 条目归入「死路」节
 * - 场次日志 append 一行
 * - 锚由此处统一分配（AI 不编锚）
 * 返回新文档 + 分配的锚（与 entries 同序，供 node.anchor 回填）。
 */
export function appendToWhiteboxDoc(
  doc: string,
  entries: NewWhiteboxEntry[],
  logLine?: string,
): { doc: string; anchors: string[] } {
  let lines = doc.split('\n');
  let n = nextAnchorNum(doc);
  const anchors: string[] = [];

  /** 找 `## name` 行号；无返回 -1 */
  const sectionIdx = (ls: string[], name: string) =>
    ls.findIndex(l => l.trim() === `## ${name}`);
  /** 章节内容的末尾插入点（下一个 ## 前，跳过尾部空行） */
  const sectionEnd = (ls: string[], start: number) => {
    let end = ls.length;
    for (let i = start + 1; i < ls.length; i++) {
      if (/^##\s/.test(ls[i])) { end = i; break; }
    }
    while (end > start + 1 && ls[end - 1].trim() === '') end--;
    return end;
  };

  for (const e of entries) {
    const anchor = `j${n++}`;
    anchors.push(anchor);
    const domain = e.mark === '✗' ? '死路' : (e.domain.trim() || '其他');
    let idx = sectionIdx(lines, domain);
    if (idx === -1) {
      // 新建域：插在「死路」节前（保持保留槽位在尾部）
      const deadIdx = sectionIdx(lines, '死路');
      const at = deadIdx === -1 ? lines.length : deadIdx;
      lines = [...lines.slice(0, at), `## ${domain}`, '', ...lines.slice(at)];
      idx = at;
    }
    const end = sectionEnd(lines, idx);
    const block = ['', `### ${e.mark} ${e.title} ^${anchor}`, '', e.content.trim()];
    lines = [...lines.slice(0, end), ...block, ...lines.slice(end)];
  }

  if (logLine) {
    const logIdx = sectionIdx(lines, '场次日志');
    if (logIdx === -1) {
      lines.push('## 场次日志', `- ${logLine}`);
    } else {
      const end = sectionEnd(lines, logIdx);
      lines = [...lines.slice(0, end), `- ${logLine}`, ...lines.slice(end)];
    }
  }

  return { doc: lines.join('\n'), anchors };
}

/**
 * 追加自由论述段到指定域尾部（doc-note——文档独有内容，08-27 用户拍：
 * 文档和图各自被允许有另一边没有的独特数据）。
 * 无锚、不产图节点；域不存在则新建（沿 appendToWhiteboxDoc 同规则：插「死路」节前）。
 */
export function appendNoteToDoc(doc: string, domain: string, text: string): string {
  const body = text.trim();
  if (!body) return doc;
  let lines = doc.split('\n');
  const name = domain.trim() || '其他';
  const sectionIdx = (ls: string[], n: string) => ls.findIndex(l => l.trim() === `## ${n}`);
  const sectionEnd = (ls: string[], start: number) => {
    let end = ls.length;
    for (let i = start + 1; i < ls.length; i++) {
      if (/^##\s/.test(ls[i])) { end = i; break; }
    }
    while (end > start + 1 && ls[end - 1].trim() === '') end--;
    return end;
  };
  let idx = sectionIdx(lines, name);
  if (idx === -1) {
    const deadIdx = sectionIdx(lines, '死路');
    const at = deadIdx === -1 ? lines.length : deadIdx;
    lines = [...lines.slice(0, at), `## ${name}`, '', ...lines.slice(at)];
    idx = at;
  }
  const end = sectionEnd(lines, idx);
  return [...lines.slice(0, end), '', body, ...lines.slice(end)].join('\n');
}

/** 重写「主线」节内容（活节——8-22 设计即"每场可重写"；AI 仅在实质推进时产出） */
export function setMainline(doc: string, text: string): string {
  const body = text.trim();
  if (!body) return doc;
  const lines = doc.split('\n');
  const idx = lines.findIndex(l => l.trim() === '## 主线');
  if (idx === -1) {
    // 骨架缺主线节（人手写的文档可能没有）——插在一级标题/定位行之后
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^#\s/.test(lines[i]) || /^>\s*定位/.test(lines[i])) at = i + 1;
      if (/^##\s/.test(lines[i])) break;
    }
    return [...lines.slice(0, at), '', '## 主线', '', body, ...lines.slice(at)].join('\n');
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  while (end > idx + 1 && lines[end - 1].trim() === '') end--;
  return [...lines.slice(0, idx + 1), '', body, '', ...lines.slice(end)].join('\n');
}

/**
 * 改判断标记＋追加留痕行（轻量整理的唯一存量操作——只改条目头一个标记字符、
 * 条目尾加一行留痕，正文一字不动）。锚不存在返回 ok:false（调用方丢弃该指令）。
 */
export function markEntry(
  doc: string,
  anchor: string,
  newMark: WhiteboxMark,
  reason: string,
  dateStr: string,
): { doc: string; ok: boolean; oldMark: WhiteboxMark | null } {
  const lines = doc.split('\n');
  const headIdx = lines.findIndex(l => {
    const m = ENTRY_HEAD_RE.exec(l);
    return m !== null && m[3] === anchor;
  });
  if (headIdx === -1) return { doc, ok: false, oldMark: null };
  const m = ENTRY_HEAD_RE.exec(lines[headIdx])!;
  const oldMark = (m[1] === '?' ? '？' : m[1]) as WhiteboxMark;
  if (oldMark === newMark) return { doc, ok: false, oldMark };
  lines[headIdx] = `### ${newMark} ${m[2]} ^${anchor}`;
  // 留痕行插在该条目内容末尾（下一个标题前）
  let end = lines.length;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (/^##/.test(lines[i])) { end = i; break; }
  }
  while (end > headIdx + 1 && lines[end - 1].trim() === '') end--;
  const trail = `> ${oldMark}→${newMark} ${dateStr}：${reason.trim()}`;
  return {
    doc: [...lines.slice(0, end), '', trail, ...lines.slice(end)].join('\n'),
    ok: true,
    oldMark,
  };
}

/** AI 写的文档增量段（v1.2 输出反转：AI 直接写 markdown，图从中抽取） */
export interface DocSegment {
  /** 共同正文对应的判断：dN 为本轮条目，jN 为已有判断。缺省是旧式文档段。 */
  refs?: string[];
  domain: string;
  /** 段内容：自由论述 + `### {五档} 短句` 条目头（无锚——锚由本函数补） */
  text: string;
}

/** 条目头（无锚版——AI 写的）；带锚版由 ENTRY_HEAD_RE 匹配 */
const BARE_ENTRY_RE = /^###\s*(◆|◇|？|\?|✗|⏸)\s*(.+?)\s*$/;

/**
 * 应用文档增量（v1.2 的心脏——替代"条目组装"：AI 像人一样写文档，工程只做三件）：
 * 1. 普通域段 → 追加到对应域尾（域不存在建在「死路」节前）；「主线」段 → 替换（活节语义）
 * 2. 段内条目头逐个补锚（AI 永远不写锚；若幻觉写了锚先剥掉重编，防撞号）
 * 3. 场次日志 append 一行
 * 返回新文档 + 按出现序的条目清单（供图侧产节点/锚回填）。
 */
export function applyDocIncrement(
  doc: string,
  segments: DocSegment[],
  logLine?: string,
): { doc: string; entries: Array<{ anchor: string; mark: WhiteboxMark; title: string; domain: string }> } {
  let out = doc;
  let n = nextAnchorNum(doc);
  const entries: Array<{ anchor: string; mark: WhiteboxMark; title: string; domain: string }> = [];

  for (const seg of segments) {
    const domain = seg.domain.trim() || '其他';
    // 主线段=替换语义的活节：不补锚不产条目（下次替换会让锚悬空）；
    // AI 误写的条目头降级为加粗行（主线是状态叙述，不承载条目——防 lint 报非法条目头）
    if (domain === '主线') {
      const mlText = seg.text.split('\n').map(line => {
        const m = BARE_ENTRY_RE.exec(line.replace(/\s*\^j\d+\s*$/, ''));
        return m ? `**${m[1] === '?' ? '？' : m[1]} ${m[2].trim()}**` : line;
      }).join('\n').trim();
      out = setMainline(out, mlText);
      continue;
    }
    // 条目头补锚（逐行；已带锚的先剥——AI 幻觉锚不可信）
    const lines = seg.text.split('\n').map(line => {
      const stripped = line.replace(/\s*\^j\d+\s*$/, '');
      const m = BARE_ENTRY_RE.exec(stripped);
      if (!m) return line;
      const mark = (m[1] === '?' ? '？' : m[1]) as WhiteboxMark;
      const title = m[2].trim();
      const anchor = `j${n++}`;
      entries.push({ anchor, mark, title, domain });
      return `### ${mark} ${title} ^${anchor}`;
    });
    const text = lines.join('\n').trim();
    if (!text) continue;
    // 追加到域尾（无域建域——沿 appendToWhiteboxDoc 同规则）
    out = appendNoteToDoc(out, domain, text);
  }

  if (logLine) {
    const ls = out.split('\n');
    const logIdx = ls.findIndex(l => l.trim() === '## 场次日志');
    if (logIdx === -1) {
      out = [...ls, '## 场次日志', `- ${logLine}`].join('\n');
    } else {
      let end = ls.length;
      for (let i = logIdx + 1; i < ls.length; i++) {
        if (/^##\s/.test(ls[i])) { end = i; break; }
      }
      while (end > logIdx + 1 && ls[end - 1].trim() === '') end--;
      out = [...ls.slice(0, end), `- ${logLine}`, ...ls.slice(end)].join('\n');
    }
  }

  return { doc: out, entries };
}

/** 整理产出的条目（工程回填给图侧：谁保留、谁被并入、谁是新的） */
export interface RewriteEntry {
  /** 主锚——继承自 AI 写的第一个锚；AI 没给锚（新条目）则新分配 */
  anchor: string;
  /** 被并入本条的旧锚（AI 在条目头写了多个锚时，第一个之外的） */
  mergedFrom: string[];
  mark: WhiteboxMark;
  title: string;
  domain: string;
  /** 没继承任何旧锚＝整理中新写出来的条目 */
  isNew: boolean;
}

/** 条目头（整理形态：可带多个锚 `### ◆ 短句 ^j3 ^j1 ^j5`，第一个是主锚） */
const REWRITE_HEAD_RE = /^###\s*(◆|◇|？|\?|✗|⏸)\s*(.+?)\s*$/;

/**
 * 整理重写（2026-08-28 整理轮的心脏）——AI 交回整理后的完整文档，工程做三件：
 * 1. **保锚**：条目头继承的锚原样留下（图节点因此不重建、位置不丢）；AI 写多个锚＝
 *    合并，主锚留在文档、其余转成一行留痕（AI 的书写形态 ≠ 存储形态，格式归工程）
 * 2. 没锚的条目＝整理中新写的，分新锚（从旧文档的下一号起，不撞历史）
 * 3. **场次日志不由 AI 重写**：旧日志原样保留 + 追加整理一行（历史不因整理蒸发）
 */
export function applyDocRewrite(
  prevDoc: string,
  segments: DocSegment[],
  dateStr: string,
): { doc: string; entries: RewriteEntry[] } {
  let n = nextAnchorNum(prevDoc);
  const entries: RewriteEntry[] = [];
  let out = emptyWhiteboxDoc();

  for (const seg of segments) {
    const domain = seg.domain.trim() || '其他';
    if (domain === '场次日志') continue; // 日志归工程，AI 写的丢弃

    // 主线段：替换语义，条目头降级加粗（同 applyDocIncrement）
    if (domain === '主线') {
      const ml = seg.text.split('\n').map(line => {
        const m = REWRITE_HEAD_RE.exec(line.replace(/(\s*\^j\d+)+\s*$/, ''));
        return m ? `**${m[1] === '?' ? '？' : m[1]} ${m[2].trim()}**` : line;
      }).join('\n').trim();
      out = setMainline(out, ml);
      continue;
    }

    // 段内按条目头切块，逐块补锚 + 合并留痕
    const lines = seg.text.split('\n');
    const rebuilt: string[] = [];
    let pending: RewriteEntry | null = null;
    const flushTrail = () => {
      if (pending && pending.mergedFrom.length) {
        // 留痕插在该条目内容末尾（跳过尾部空行）
        while (rebuilt.length && rebuilt[rebuilt.length - 1].trim() === '') rebuilt.pop();
        rebuilt.push('', `> 整理 ${dateStr}：并入 ${pending.mergedFrom.map(a => `^${a}`).join('、')}`);
      }
      pending = null;
    };

    for (const line of lines) {
      const anchors = [...line.matchAll(/\^(j\d+)/g)].map(m => m[1]);
      const head = REWRITE_HEAD_RE.exec(line.replace(/(\s*\^j\d+)+\s*$/, ''));
      if (!head) { rebuilt.push(line); continue; }
      flushTrail();
      const mark = (head[1] === '?' ? '？' : head[1]) as WhiteboxMark;
      const title = head[2].trim();
      const anchor = anchors[0] ?? `j${n++}`;
      const entry: RewriteEntry = {
        anchor, mergedFrom: anchors.slice(1), mark, title, domain, isNew: anchors.length === 0,
      };
      entries.push(entry);
      pending = entry;
      rebuilt.push(`### ${mark} ${title} ^${anchor}`);
    }
    flushTrail();

    const text = rebuilt.join('\n').trim();
    if (text) out = appendNoteToDoc(out, domain, text);
  }

  // 场次日志：旧的原样保留 + 整理一行
  const oldLogs = parseWhiteboxDoc(prevDoc).logs;
  const merged = entries.filter(e => e.mergedFrom.length).length;
  const logLine = `${dateStr} 整理：${entries.length} 条判断${merged ? `（合并 ${merged} 组）` : ''}`;
  const ls = out.split('\n');
  const logIdx = ls.findIndex(l => l.trim() === '## 场次日志');
  const allLogs = [...oldLogs, logLine].map(l => `- ${l}`);
  out = logIdx === -1
    ? [...ls, '## 场次日志', ...allLogs].join('\n')
    : [...ls.slice(0, logIdx + 1), '', ...allLogs].join('\n');

  return { doc: out, entries };
}

/** L1 结构 lint（沿 check.mjs 思路：只查结构不查内容）；返回问题清单，空=通过 */
export function lintWhiteboxDoc(doc: string): string[] {
  const problems: string[] = [];
  if (!/^#\s+.+/m.test(doc)) problems.push('缺一级标题（# 主题）');
  for (const s of RESERVED) {
    if (!doc.includes(`## ${s}`)) problems.push(`缺保留槽位「## ${s}」`);
  }
  const seen = new Set<string>();
  const re = /\^(j\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    if (seen.has(m[1])) problems.push(`锚 ^${m[1]} 重复`);
    seen.add(m[1]);
  }
  // 条目头没有合法标记/锚的（### 开头但匹配不上语法）
  doc.split('\n').forEach((l, i) => {
    if (/^###\s/.test(l) && !ENTRY_HEAD_RE.test(l)) {
      problems.push(`第 ${i + 1} 行条目头不合语法（需「### {◆◇？✗⏸} 短句 ^jN」）: ${l.slice(0, 40)}`);
    }
  });
  return problems;
}
