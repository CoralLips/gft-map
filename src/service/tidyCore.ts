/** 共享整理核心：完整提示词、操作解析与范围校验；不调用模型。 */
import type { LedgerMark } from './ledger/types';
import { THEME_SCOPE_RULE } from './thinkingMapCore';
import { MAP_DOC_RULES, readTagAttributes, validateMapDocOutput } from './mapDocContract';
import { mapReferenceLines } from './ledger/text';

/** 旧写法章节每轮交给模型的上限（D61）。 */
export const TIDY_CONVERT_BATCH = 6;

export interface TidyItem {
  id: string;
  title: string;
  body: string;
  domain?: string;
  mark: LedgerMark;
  question: boolean;
  unread: boolean;
}

export interface TidyInput {
  judgments: TidyItem[];
  /** 未传＝全局；传入（包括空数组）时，只允许修改这些判断，输入仍保留全图。 */
  scopeIds?: string[];
  /** [from, to, optional current explanation]，兼容旧的二元端点。 */
  edges: Array<[string, string, string?]>;
  prose: Array<{ domain: string; text: string }>;
  /** 这张脉络记什么（主题）；偏题的判断整理时可以去掉 */
  theme?: string;
  /** 这张图最多多少节点（D63）：超出时本次要合并到上限以内，未超出时只理关联与正文。 */
  cap: number;
  /** 还是 D61 之前写法的章节：整理时一并转成「节点＝标题＋概述、引用写在正文中」。 */
  legacyChapters?: string[];
}

export type TidyAiOp =
  | { kind: 'merge'; title: string; body: string; memberIds: string[]; mark: LedgerMark; domain?: string }
  | { kind: 'add'; id: string; title: string; body: string; mark: LedgerMark; domain: string; evidence: string }
  | { kind: 'drop'; id: string }
  | { kind: 'revise'; id: string; title?: string; body?: string; domain?: string }
  | { kind: 'prose'; domain: string; text: string; refs?: string[] }
  | { kind: 'link' | 'unlink'; from: string; to: string; reason: string; evidence: string };

const stripQuotes = (s: string): string => s.trim().replace(/^[「“"']+|[」”"']+$/g, '').trim();
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** 判断不能归入只承载叙述的主题/主线；域名保持单行，避免破坏账格式。 */
export const tidyDomain = (s?: string): string | undefined => {
  const domain = s && oneLine(s).replace(/[[\]]/g, '').trim();
  return domain && domain !== '主题' && domain !== '主线' ? domain : undefined;
};

/** 解析前后共用同一选区边界，不能先过滤越界成员再执行剩余合并。 */
export function assertTidyScopeIds(ids: readonly string[], scopeIds?: ReadonlySet<string>): void {
  if (scopeIds && ids.some(id => !scopeIds.has(id))) throw new Error('局部整理包含选区外的判断或关系，已保留原图文。');
}

function serialize(input: TidyInput): { text: string; alias: Map<string, string> } {
  const alias = new Map<string, string>();
  const idToAlias = new Map<string, string>();
  const lines = input.judgments.map((j, i) => {
    const a = `n${i + 1}`;
    alias.set(a, j.id);
    idToAlias.set(j.id, a);
    const body = j.body.trim() ? `\n${j.body.trim()}` : '';
    return `${a} [${j.mark}] ${stripQuotes(j.title)}〔现有章节：${j.domain || '未分组'}〕${j.question ? '〔悬着〕' : ''}${j.unread ? '〔未读〕' : ''}${body}`;
  });
  const edges = input.edges
    .map(([f, t, reason]) => (idToAlias.has(f) && idToAlias.has(t) ? `${idToAlias.get(f)}→${idToAlias.get(t)}${reason !== undefined ? ` — ${JSON.stringify(reason)}` : ''}` : null))
    .filter((x): x is string => !!x);
  // 文稿里的引用行换成本轮 n 编号，与判断列表、输出的引用行同一套编号。
  const prose = input.prose.map(p => `【${p.domain}】\n${mapReferenceLines(p.text, id => idToAlias.get(id) ?? id)}`);
  const theme = input.theme?.trim() ? `# 主题（这张脉络记什么）\n${oneLine(input.theme)}\n\n` : '';
  const text = `${theme}# 判断（按思考先后编号；[五档]：◆定了 ◇推断 ？悬着 ✗已推翻 ⏸搁置）\n${lines.join('\n') || '（无）'}\n\n# 承接（前→后）\n${edges.join('\n') || '（无）'}\n\n# 当前文稿（人的新输入也是有效依据；不要求已存在节点）\n${prose.join('\n') || '（无）'}`;
  return { text, alias };
}

/** 节点数与上限（D63）：超出就必须收拢，未超出只合并真正重复的。 */
function mapGoal(count: number, cap: number): string {
  return count > cap
    ? `当前 ${count} 条，超过这张图的上限 ${cap} 条：本次至少要减少 ${count - cap} 条，输出后总数必须 ≤${cap}，这是硬规则。做法：一个节点对应一个要回答的问题——同一问题下的决定、理由、验证办法、待定细节用一个 merge 合成一条（members 可以 3 条以上，也可以跨时间），标题与概述保留关键决定，展开细节、数字、例子、转折经过写进章节正文，信息不丢。超上限时不要 add。输出前自己核算：${count} − Σ(每个 merge 的成员数 − 1) − drop 数 ≤ ${cap}。`
    : `当前 ${count} 条，这张图的上限是 ${cap} 条。不必为减少条数而合并，只合并真正重复的判断；add 后总数不能超过 ${cap} 条，超出的不会写入。`;
}

function buildPrompt(count: number, cap: number): string {
  return `一次整理要同时交付两个结果，两者同样重要：
1. Map：校正真实承接，保留独立决定、转折和未决问题。${mapGoal(count, cap)}body 是这条判断一两句的概述（约 40–80 字），展开细节、数字、例子和共同背景放进章节正文，不必各占一个节点。
2. Doc：按读者要弄懂的具体问题组织章节，把相关判断连接成能独立读懂的当前理解说明。节点更少、文字更短，不能代替讲清楚；为补足解释，正文可以比整理前更长。

# Doc 怎样讲清楚

先看现有判断和文稿，再决定哪些判断共同回答一个问题。现有章节和正文是可调整的草稿，不是必须沿用的提纲或结论；把不同问题挤在一个大章时，用 revise 的 domain 重新分组，以具体问题命名章节。${count > cap ? '节点数超上限时，同一问题下的目标、路线选择、验证办法合成一个节点，联系与细节由正文讲清。' : '归为同章不等于合成一个节点：例如目标、路线选择、验证办法相互关联，却回答不同问题，应分别保留判断，由正文解释联系。'}章节已经清楚就沿用，不强行拆分，也不改变 Map 的时间与连线。
每章围绕一个具体问题，用节点与文稿里的依据解释为什么这样选、怎样验证、还有什么没定；不要用几句总括包住几个不同问题，也不要逐节点换句话说。合并、删除节点时，被压掉但仍影响当前理解的背景、验证步骤和条件挪进正文。在正文讲到某判断的位置单独一行写 \`> ^n编号\`，系统在那里显示它的标题、档位和概述；正文不复述标题和概述里的结论，只写依据、条件和判断之间的过渡。章节开头直接提出问题，不写“本章／这一章……”。用自然短段落，确实并列的事项才列点。
主线简短说明当前理解，其余章节各讲自己的问题，不重复主线。保留仍有解释作用的愿景、定位与关键历史；过去诊断标明阶段，不能未经依据就当成今天仍然成立。保留确定程度、适用范围和条件中的“或/且”，不能把暂定方案写成铁律、删掉例外来让结论更整齐。原文前后条件不同，只有明确替代才按新条件叙述；否则交代阶段差异或仍待澄清，不擅自选择最严的一条。现有说明与依据冲突时按依据纠正，不自行补出结论。

已有主题原文必须保持不变：普通整理不润色、不精简，也不扩大或缩小收录边界，不输出 <prose domain="主题">。只有用户明确编辑主题才能改变边界。收录与排除条件同时约束 Map 与 Doc；无关内容不进入节点、主线、章节正文或“已忽略”说明。混合段落只取相关部分，不能因为同一项目或同一场聊天就全收录。
仅当尚无主题时，才通过 <prose domain="主题"> 初始化主题。${THEME_SCOPE_RULE} 固定标题由界面维护。

当前 Doc 中主题范围内的新段落也是一等输入。独立的新判断或未决问题可以 add 成节点；解释、例子、背景并入正文或已有判断，不把每段变成节点。新增时引用当前文稿的原句作为 evidence，并占用上限内剩下的名额。先合并重复，再补必要新判断。正文、节点一次共同交付，即使原先没有节点也能整理；已有主题仍保持原文。

# 输出操作

只输出下面标签，无标签外的解释或代码块；操作各起一行，prose 内可分段。先输出关系修正，再输出判断操作和章节正文。仅当 Map 与 Doc 都无需改善时输出 <noop/>。

<link from="n1" to="n2" reason="后者怎样沿前者推进或转向" evidence="材料中能说明这次承接的连续原句，至少8字"/>
<unlink from="n1" to="n3" reason="原连接为什么不成立" evidence="材料中能说明误接的连续原句，至少8字"/>
（遍历当前判断，结合完整表述和文稿回查：从哪里出发、什么理由促成推进或转向。补漏接、断误接；已有关系及说明都准确时不重复输出；关系正确但说明缺失或需澄清时，也用 link 输出同一对端点与新的 reason，系统只修订说明。reason 是下游节点前的一句可编辑引入，不重复两端标题、不另加标签。from/to 只能用当前判断的 n 编号。只按真实推导、反驳或问题回答连接，不能因为时间相邻、同域或用词相似就连；不确定就保留独立。link 只许早→晚，不能颠倒时间来强接。）

<merge title="≤16字的判断" body="一两句概述：为什么、在什么条件下成立" members="n2,n3" domain="实际章节名"/>
（合并编号连续、表达同一判断或补充该判断的理由、示例、展开说明的 ≥2 条。不是只能合并同义句。例如“先验证再开发”“先找三人访谈”“访谈要记录拒绝原因”若后两条仅是前一决定的执行与验证说明，可合为“先访谈三人验证需求”：人数这类决定写进标题或 body，记录要求等执行细节写进章节正文。${count > cap ? '超上限时同一问题的判断可以跨时间合并，合并后排在最早一条的位置；若中间某条承接到被合并的较晚成员，这组合并会被系统拒绝。转折与分叉写进合并后的正文。' : '若验证步骤本身是独立取舍，或包含新的决定、反驳和转向，则分开保留。主题相近本身不是合并理由；不得跳过中间节点跨段打包，或合掉明确的转折与分叉。'}）

<add id="new1" title="新判断的短句" body="依据和条件" mark="◇" domain="实际章节名" evidence="当前文稿支持这项判断的原句"/>
（仅全局整理可用，id 为本轮唯一 new 编号；refs 可引用 new1。没有明确确认就用 ◇，问题用 ？；已有判断不要重复 add。）

<drop id="n4"/>
（只删没有独有信息的重复、无关或已失效内容；“不是核心结论”不等于可删。说明如何验证、获得反馈和修正判断的步骤有独立价值。已被推翻的 ✗ 若仍解释当前取舍，须保留其否定缘由；删节点不能让仍重要的依据、步骤或条件从 Doc 一起消失。）

<revise id="n3" title="更清楚的短句" body="一两句概述：为什么、在什么条件下成立" domain="实际章节名"/>
（title、body、domain 均可单独给。重组章节时给相关判断新的 domain；不需要为了改章节而改写判断。）

<prose domain="主线">当前在解决什么、为何走到这里、现在定了什么、还悬着什么。</prose>
<prose domain="实际章节名" refs="n1,n2">直接提出本章的问题或共同背景。

> ^n1

围绕这一判断写依据、数字、来源、例子与边界，再写怎样走到下一点。

> ^n2

围绕这一判断写依据与条件，可分段。</prose>
（refs 列出本章解释到的判断，与整理后的 domain 一致。每个保留判断都应在所属章节的 refs 中出现，并在正文讲到它的位置单独一行写引用；合并时仍引用原成员编号，系统会转到合并结果。引用处显示的就是节点的标题与 body，正文围绕它们展开依据、例子和过渡，不再复述，也不要输出节点清单或“### 节点名”。改动 body 后，同章正文仍要和它一致。）
（只为需要改的章节输出 prose：本次有合并、增删、迁入迁出判断的章节，以及现有正文确实讲不清、需要重写的章节。只改了连线或节点概述、正文仍然讲得通的章节不要输出，系统原样保留；主线只在当前理解变化时输出。改了哪章就完整重写哪章，不输出半章。漏写的章节由系统沿用原正文，正文没讲到的判断补在章末。）

# 纪律

- A→B→C：可以把重复的 B、C 合成 BC，保留 A→BC；不能把 A、C 跨过 B 打包。系统会拒绝跨段合并
- 先输出关系修正，再合并重复判断；关系修正与合并可以引用同一节点，系统会把边转接到合并结果。转折前后不是重复判断，不能合掉转折或删掉推理桥梁
- 有主题时，跟主题无关的判断可以去掉（drop）——这张脉络只记主题范围内的事
- 标了〔悬着〕的是没解决的问题：只能和别的〔悬着〕合成一条更大的问题，绝不能和结论混进同一条
- 〔未读〕可以合，人会在合出来的判断上看到红点
- 合出来的必须仍是一个具体判断，不能变成「关于某问题的讨论」这样的分类名
- body 不是短句的复述：一两句讲为什么、在什么条件下成立，写不出就留空；细节放进章节正文
- 不发明：title、body、正文只能依据当前文稿与现有判断；一条判断最多进一个 merge/drop/revise 操作，prose 引用不受此限制。关系操作必须附 reason 与可回查的 evidence，引用内容本身必须支持这对判断的关系
- reason 独立保存在关系上，不把同一句复制进节点 body；正文因新承接讲不通时才重写该章
- 顺序上更早、已经定了的先合；最近的一两条允许留着

${MAP_DOC_RULES}`;
}

/** 确定性解析：别名映射回真实 id；问号只和问号合（混了按多数一边，少数留下）；一条判断只进一个操作 */
export function parseTidyOps(text: string, alias: Map<string, string>, items: TidyItem[], domains: Set<string>, evidence = '', scopeIds?: ReadonlySet<string>, draftText = '', options?: { requireChapterDoc?: boolean }): TidyAiOp[] {
  if (options?.requireChapterDoc) validateMapDocOutput(text);
  const byId = new Map(items.map(i => [i.id, i]));
  const used = new Set<string>();
  const ops: TidyAiOp[] = [];
  const idsOf = (raw: string | undefined): string[] =>
    [...new Set((raw ?? '').split(',').map(s => alias.get(s.trim())).filter((v): v is string => !!v))].filter(id => !used.has(id));
  const tagRe = /<(merge|add|drop|revise|link|unlink|noop)\s*([^>]*?)\/?>|<prose\s+([^>]*?)>([\s\S]*?)<\/prose\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    if (m[3] !== undefined) {
      const attrs = readTagAttributes(m[3]);
      const domain = attrs.domain && oneLine(attrs.domain).replace(/[[\]]/g, '').trim();
      // 正文里的引用行与 refs 同用 n 编号（D61）；new 编号留到落账时换。
      const body = mapReferenceLines(m[4].trim(), ref => alias.get(ref) ?? ref);
      if (scopeIds && (domain === '主题' || (domain === '主线' && !items.some(item => item.domain === '主线' && scopeIds.has(item.id))))) throw new Error('局部整理不能改主题或选区外的主线，已保留原图文。');
      const refs = attrs.refs === undefined ? undefined : [...new Set(attrs.refs.split(/[\s,，]+/).filter(Boolean).map(ref => alias.get(ref) ?? ref))];
      // 空正文只在整图整理里保留：收掉已无节点的章节；局部整理不动选区外章节。
      if (domain && (body || !scopeIds)) ops.push({ kind: 'prose', domain, text: body, ...(refs !== undefined ? { refs } : {}) });
      continue;
    }
    const kind = m[1];
    if (kind === 'noop') continue;
    const attrs = readTagAttributes(m[2]);
    if (scopeIds && kind === 'add') throw new Error('局部整理不新增判断，请使用全局整理。');
    if (scopeIds) {
      const refs = kind === 'merge' ? (attrs.members ?? '').split(',') : kind === 'link' || kind === 'unlink' ? [attrs.from, attrs.to] : [attrs.id];
      const ids = refs.map(ref => alias.get(ref?.trim()) ?? '');
      assertTidyScopeIds(ids, scopeIds);
      if (kind !== 'link' && kind !== 'unlink' && ids.some(id => used.has(id))) throw new Error('局部整理重复修改同一判断，已保留原图文。');
    }
    if (kind === 'add') {
      const title = stripQuotes(attrs.title || ''), evidence = (attrs.evidence || '').trim();
      const domain = tidyDomain(attrs.domain), id = attrs.id || '';
      if (!title || !domain || !/^new\d+$/.test(id) || used.has(id) || !evidence || !oneLine(draftText).includes(oneLine(evidence))) continue;
      if (!['◆','◇','？','✗','⏸'].includes(attrs.mark)) continue;
      used.add(id);
      ops.push({kind:'add',id,title,domain,evidence,mark:attrs.mark as LedgerMark,body:attrs.body || ''});
    } else if (kind === 'link' || kind === 'unlink') {
      const op: Extract<TidyAiOp, { from: string }> = { kind, from: alias.get(attrs.from) ?? '', to: alias.get(attrs.to) ?? '', reason: (attrs.reason ?? '').trim(), evidence: (attrs.evidence ?? '').trim() };
      if (validTidyRelation(op, items, evidence)) ops.push(op);
      else if (scopeIds) throw new Error('局部整理的关系缺少有效依据，已保留原图文。');
    } else if (kind === 'merge') {
      const all = idsOf(attrs.members);
      const qs = all.filter(id => byId.get(id)?.question);
      const js = all.filter(id => !byId.get(id)?.question);
      const question = qs.length > js.length;
      const memberIds = question ? qs : js;
      const title = stripQuotes(attrs.title ?? '');
      if (scopeIds && (!title || memberIds.length < 2 || memberIds.length !== all.length)) throw new Error('局部整理包含不可执行的合并，已保留原图文。');
      if (!title || memberIds.length < 2) continue;
      memberIds.forEach(id => used.add(id));
      const mark: LedgerMark = question ? '？' : memberIds.every(id => byId.get(id)?.mark === '◆') ? '◆' : '◇';
      ops.push({ kind: 'merge', title, body: (attrs.body ?? '').trim(), memberIds, mark, domain: tidyDomain(attrs.domain) });
    } else if (kind === 'drop') {
      const [id] = idsOf(attrs.id);
      if (!id) continue;
      used.add(id);
      ops.push({ kind: 'drop', id });
    } else {
      const [id] = idsOf(attrs.id);
      const title = attrs.title ? stripQuotes(attrs.title) : undefined;
      const body = attrs.body?.trim();
      const domain = tidyDomain(attrs.domain);
      if (!id || (!title && !body && !domain)) continue;
      used.add(id);
      ops.push({ kind: 'revise', id, ...(title ? { title } : {}), ...(body ? { body } : {}), ...(domain ? { domain } : {}) });
    }
  }
  // refs 可以先于 add 出现；完成全部操作解析后再核验，不能把未知引用悄悄过滤成部分正文。
  const availableRefs = new Set([...byId.keys(), ...ops.flatMap(op => op.kind === 'add' ? [op.id] : [])]);
  if (ops.some(op => op.kind === 'prose' && op.refs?.some(id => !availableRefs.has(id)))) {
    throw new Error(`${scopeIds ? '局部整理' : '整理'}的章节正文引用了不存在或未成功新增的判断，已保留原图文。`);
  }
  // 等文字操作解析完再认章节，允许模型先写新章节说明、后写改域操作。
  const available = new Set([...domains, '主线', '主题', ...items.map(j => j.domain)]);
  for (const op of ops) if ((op.kind === 'merge' || op.kind === 'revise' || op.kind === 'add') && op.domain) available.add(op.domain);
  if (scopeIds && ops.some(op => op.kind === 'prose' && !available.has(op.domain))) throw new Error('局部整理包含无对应判断的章节，已保留原图文。');
  return ops.filter(op => !scopeIds || op.kind !== 'prose' || available.has(op.domain));
}

/** 只验证可确定的边界与引用存在性；语义是否支持承接仍由模型判断、实际材料回放验收。 */
export function validTidyRelation(op: Extract<TidyAiOp, { from: string }>, items: TidyItem[], evidence = ''): boolean {
  const from = items.findIndex(j => j.id === op.from), to = items.findIndex(j => j.id === op.to);
  if (from < 0 || to < 0 || from === to || (op.kind === 'link' && from >= to) || !op.reason.trim()) return false;
  const quote = oneLine(op.evidence);
  return quote.length >= 8 && [evidence, ...items.map(j => j.body)].some(text => oneLine(text).includes(quote));
}

/** One tidy model call: the prompt to send and the parser for its answer. */
export function tidyCall(input: TidyInput) {
  const request = buildTidyRequest(input);
  const draft = input.prose.map(prose => prose.text).join('\n\n');
  const scope = input.scopeIds === undefined ? undefined : new Set(input.scopeIds);
  return {
    system: request.systemPrompt,
    user: request.text,
    /** Short judgment names in this call (n1…) → judgment ids, for showing progress. */
    aliases: Object.fromEntries(request.alias),
    parse: (raw: string) =>
      parseTidyOps(raw, request.alias, input.judgments, new Set(input.prose.map(prose => prose.domain)), draft, scope, draft, { requireChapterDoc: true }),
  };
}

/** 与实际模型入口共用，离线回放可以核验完整输入而无需外发。 */
export function buildTidyRequest(input: TidyInput) {
  const serialized = serialize(input);
  // 旧写法的图：整理时一并转成新写法（D61），没转完的下次整理继续。
  if (input.legacyChapters?.length && input.scopeIds === undefined) serialized.text = `# 本次一并转换为新写法\n以下章节还是旧写法：${input.legacyChapters.slice(0, TIDY_CONVERT_BATCH).map(domain => `「${domain}」`).join('、')}。除了正常整理，这些章节每条判断的 body 若超过两句，就用 revise 改成一两句概述（详细依据、数字、例子挪进正文，不丢信息）；并为这些章节完整输出 prose，把每条判断的引用行写在正文讲到它的位置。\n\n${serialized.text}`;
  if (input.scopeIds === undefined) return { ...serialized, systemPrompt: buildPrompt(input.judgments.length, input.cap) };
  const scope = new Set(input.scopeIds);
  const selected = [...serialized.alias].filter(([, id]) => scope.has(id)).map(([alias]) => alias);
  return {
    ...serialized,
    text: `# 本次局部整理范围\n可修改判断：${selected.join(',') || '（无）'}\n其余判断、连线和文稿仅作上下文。\n\n${serialized.text}`,
    systemPrompt: buildPrompt(input.judgments.length, input.cap) + `

# 本次为局部整理（优先遵守）

不允许 add 新判断。只有“可修改判断”中的编号可以 revise、drop 或作为 merge 成员；不得把选区外判断混入合并。link/unlink 的两个端点都必须在选区内；外部已有承接由系统在合并后续接。全图超过上限时，选区内能合并的都合并。
Doc 只可改选区原有章节和本轮成功迁入的章节；主题及其他章节保持不变，不输出它们的 prose。合并或迁移判断时，重写受影响的原章和目标章正文；没写的章由系统保留原文并补上引用，整章迁空时由系统收掉旧正文。
章节 prose 要解释该章整理后的全部判断，包含同章未选中的判断；这些未选判断的表述和解释仍须保留。合并仍引用原成员编号。选区为空时输出 <noop/>。`,
  };
}
