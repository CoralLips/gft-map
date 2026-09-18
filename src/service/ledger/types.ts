/**
 * 判断账（ledger）——右栏的底层数据（2026-09-05 GFT-fix 线；9-6 用户拍：最简版）
 *
 * 一本按时间只追加的纯文本。图和白盒文档都是从它算出来的视图，不再各自存正本。
 * 只有四种行：场次头、判断、走向段、行为；其余任何行都是自由文本、原样进出。
 *
 *   [场次 2026-09-05T14:02:11+08:00 · chat:abc · 更新脉络]   场次头：之后的行都算这一场、这个来源
 *   走向 p12 [域]                                          走向段（叙述），后续行原样归它
 *   ◆ j8 [域] 标题                                         判断行（◆◇？✗⏸ 五档），后续行＝完整表述
 *   ◆ j50 [域] 标题 = j1 j2                                合并自 j1 j2：它们退休，边自动改接到 j50
 *   ◆ j51 [域] 标题 ^j8 ^j9 @时间                          重画自 Log 的 j8/j9；独立来源编号，不退休同号工作判断
 *   ← j9 j8                                               承接：j9 顺着 j8
 *   本人|AI 改|删|接|断|序 …                                行为：人的或 AI 的动作，一行一条
 *   重画                                                  世代更替：此前判断与走向全部作废（账里仍在）
 *
 * 行为行：
 *   改 j8 标题：新标题      改 j8 表述：（后续行＝新表述）     改 j8 档：✗      改 j8 域：新域
 *   改 p12 表述：（后续行＝新走向）   改 p12 域：新域
 *   删 j8 / 删 p12          删掉的判断被短路：上游×下游自动接上（渲染规则，不写行）
 *   接 j9 j8 / 断 j9 j8     断一条自动接上的边也用 断（记成排除）
 *   序 j9 j3 / 序 j9 末     j9 排到 j3 前面 / 排到最后（视图顺序默认＝写入先后）
 *
 * 显示规则三条：同一条以最后一行为准；删了的不显示、边自动接续；顺序按写入先后、序 过的优先。
 * 兼容只读（不再写）：⊃ 上层判断行、并/拆/拍/否/标/域 旧动词、判断行末尾的 @时间（迁移时保住旧节点创建时间）。
 * id：判断 jN、走向 pN（旧账里的 cN 是上层判断），账内唯一、共用一个计数、只增不复用；图节点 id＝账 id。
 */

export type LedgerMark = '◆' | '◇' | '？' | '✗' | '⏸';
export const LEDGER_MARKS: readonly LedgerMark[] = ['◆', '◇', '？', '✗', '⏸'];

export interface LedgerJudgment {
  id: string;
  mark: LedgerMark;
  domain: string;
  title: string;
  /** 完整表述（多行原样） */
  content: string;
  createdAt: number;
  updatedAt: number;
  /** 场次来源（chat:sessionId / mcp:agent / 本地 / 迁移） */
  source: string;
  /** 合并自哪些判断（它们已退休） */
  mergedFrom: string[];
  /** 重画来源：原始 Log 的编号，与工作账的合并编号分开。 */
  rawFrom?: string[];
  /** 被合并进了谁 */
  mergedInto?: string;
  /** 被删／被合并／被重画作废后为 true——视图不再显示，账里仍在 */
  deleted: boolean;
  /** 旧账里的 ⊃ 上层判断：只读兼容，视图不显示 */
  legacyCover?: boolean;
  /** 账内首次出现的序号 */
  seq: number;
}

export interface LedgerRelation {
  /** to 承接 from */
  from: string;
  to: string;
  seq: number;
}

export interface LedgerProse {
  /** pN；旧账里没编号的段落在加载时补号，解析时临时给 p_行号 */
  id: string;
  domain: string;
  /** 原样行（含空行） */
  lines: string[];
  at: number;
  source: string;
  seq: number;
  deleted: boolean;
}

export interface LedgerSession {
  at: number;
  source: string;
  /** 场次头里 · 之后的备注（自由） */
  note: string;
  seq: number;
}

export interface LedgerState {
  judgments: Map<string, LedgerJudgment>;
  relations: LedgerRelation[];
  /** 被人断掉的自动接续边（`from→to`） */
  cuts: Set<string>;
  prose: LedgerProse[];
  sessions: LedgerSession[];
  /** 域按首次出现序 */
  domains: string[];
  /** 显示顺序：判断与走向段的 id 序列（默认写入先后，序 行会挪动） */
  order: string[];
  /** 下一个可用编号（j / p / 旧 c 共用一个计数，避免撞号） */
  nextNum: number;
  /** 解析时的告警（写坏的行；不吞，标出来） */
  warnings: string[];
  /** 总行数（追加写入时校验） */
  lineCount: number;
}

export interface LedgerNode {
  id: string;
  title: string;
  domain: string;
  mark: LedgerMark;
  unresolved: boolean;
  superseded: boolean;
  createdAt: number;
  updatedAt: number;
  seq: number;
  /** 显示顺序（order 里的下标） */
  order: number;
}

export interface LedgerEdge {
  id: string;
  from: string;
  to: string;
}
