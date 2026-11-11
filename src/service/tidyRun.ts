/**
 * 整理与生成落账：浏览器、本地服务与 MCP 端点共用；模型调用由调用方注入。
 * 节点上限（D63/D65）在这里兜底：模型一次调用之后仍超上限，由系统把相邻判断合并到上限以内。
 * 更新例外（D71）：更新后超上限，先让模型把新旧判断一起整理一遍，机械合并只补整理后仍超出的部分。
 * 整图整理（含更新后的整理）没减够时，把没能执行的操作和原因告诉模型接着整理，最多三轮（D63）。
 */
import { parseLedger, appendLines, liveJudgments, renderGraph, type LedgerJudgment, type LedgerState } from './ledger';
import { tidyInput, tidyOpsToLines, linesFromGenerate, type GenerateLike } from './ledger/bridge';
import { parseTidyOps, type TidyAiOp, type TidyInput } from './tidyCore';

export interface TidyOptions {
  ledger: string;
  unreadIds: Set<string>;
  /** Judgments a selection tidy may change; undefined tidies the whole topic. */
  scopeIds?: Iterable<string>;
  /** The node cap (D63). */
  cap: number;
  /** First ledger line of this tidy session. */
  header: string;
  /** The model call: the tidy input in, parsed operations out. */
  tidy(input: TidyInput): Promise<TidyAiOp[]>;
  /** Checked after the model call; false discards the tidy. */
  stillCurrent?(): boolean;
}

export interface TidyResult {
  /** Header plus every applied line, ready to append to `ledger`. */
  lines: string[];
  state: LedgerState;
  newIds: string[];
  merged: number;
  dropped: number;
  applied: number;
  /** Merges the system made itself because the model left the map above its cap. */
  forced: number;
  /** Judgments in scope before tidying. */
  before: number;
}

/**
 * The system's own merges for a map above its cap: neighbouring judgments,
 * preferring the same chapter and the shortest text, until the count fits.
 * Members stay adjacent in time, so the merge never reorders a relation; every
 * member's text is kept in the merged body. The most recently changed member leads
 * (title, mark and chapter), so a fresh decision is never filed under an old question.
 */
function capMerges(state: LedgerState, cap: number): TidyAiOp[] {
  const groups: LedgerJudgment[][] = liveJudgments(state).map(j => [j]);
  const size = (g: LedgerJudgment[]) => g.reduce((n, j) => n + j.title.length + j.content.length, 0);
  while (groups.length > cap && groups.length > 1) {
    let best = 0, bestCost = Infinity;
    for (let i = 0; i + 1 < groups.length; i++) {
      const cost = (groups[i][0].domain === groups[i + 1][0].domain ? 0 : 1e6) + size(groups[i]) + size(groups[i + 1]);
      if (cost < bestCost) [best, bestCost] = [i, cost];
    }
    groups.splice(best, 2, [...groups[best], ...groups[best + 1]]);
  }
  return groups.filter(g => g.length > 1).map(g => {
    const lead = g.reduce((a, b) => (b.updatedAt > a.updatedAt || (b.updatedAt === a.updatedAt && b.seq > a.seq) ? b : a));
    const rest = g.filter(j => j !== lead);
    return {
      kind: 'merge',
      memberIds: g.map(j => j.id),
      title: lead.title,
      body: [lead.content, ...rest.map(j => `${j.title}：${j.content}`)].map(s => s.trim()).filter(Boolean).join('\n'),
      mark: lead.mark,
      domain: lead.domain,
    };
  });
}

/** Lines that bring a map above its cap back within it; nothing when it already fits. */
export function fitCap(state: LedgerState, cap: number) {
  if (liveJudgments(state).length <= cap) return { lines: [] as string[], newIds: [] as string[], merged: 0 };
  return tidyOpsToLines(state, capMerges(state, cap), undefined, { cap, forced: true });
}

/** Model rounds a whole-map tidy may take to get within the cap (D63); each later round is told what the last could not do. */
const TIDY_ROUNDS = 3;

/**
 * For the next round: the merges and drops of `ops` the system could not carry out
 * in `st` (the map after them), named by title with the reason.
 */
function notDone(st: LedgerState, ops: TidyAiOp[]): string {
  const live = liveJudgments(st);
  const order = new Map(live.map((j, i) => [j.id, i]));
  const edges = renderGraph(st).edges;
  const name = (id: string) => `「${st.judgments.get(id)?.title ?? id}」`;
  const lines: string[] = [];
  for (const op of ops) {
    if (op.kind === 'merge' && op.memberIds.every(id => order.has(id))) {
      const ids = [...op.memberIds].sort((a, b) => order.get(a)! - order.get(b)!);
      const members = new Set(ids);
      const between = live
        .slice(order.get(ids[0])! + 1, order.get(ids[ids.length - 1])!)
        .filter(j => !members.has(j.id) && edges.some(e => e.from === j.id && members.has(e.to)));
      lines.push(`- 合并 ${ids.map(name).join('、')} 没执行：${between.length ? `${between.map(j => name(j.id)).join('、')}排在它们中间又承接到后面的成员，合并会让承接倒流` : '成员之间的承接不允许这样合并'}`);
    } else if (op.kind === 'drop' && order.has(op.id)) {
      const mark = st.judgments.get(op.id)?.mark;
      lines.push(`- 删除 ${name(op.id)} 没执行：${mark === '？' || mark === '⏸' ? '悬着的问题不能删，只能和别的悬着问题合并' : '它在承接链中间，删掉会断开前后'}`);
    }
  }
  return `${lines.length ? `上一轮这些操作没能执行：\n${lines.join('\n')}` : '上一轮减少得不够。'}\n这一轮针对现在这张图，换能执行的合并或删除，把总数降到上限以内。`;
}

/**
 * One tidy (D65): a model call, and while a whole map stays above its cap further
 * rounds that are told what the last could not do. An invalid first answer fails the
 * tidy with its reason; a failed later round keeps the rounds before it. A whole-map
 * tidy always ends within the cap. Returns null when stillCurrent() turned false.
 */
export async function runTidy(options: TidyOptions): Promise<TidyResult | null> {
  const scope = options.scopeIds === undefined ? undefined : new Set(options.scopeIds);
  const start = parseLedger(options.ledger);
  if (scope) {
    const alive = new Set(liveJudgments(start).map(j => j.id));
    for (const id of scope) if (!alive.has(id)) scope.delete(id);
  }
  const before = liveJudgments(start).filter(j => !scope || scope.has(j.id)).length;
  const lines = [options.header];
  const newIds: string[] = [];
  let merged = 0, dropped = 0, note: string | undefined;
  for (let round = 0; round < (scope ? 1 : TIDY_ROUNDS); round++) {
    const cur = parseLedger(appendLines(options.ledger, lines));
    if (round > 0 && liveJudgments(cur).length <= options.cap) break;
    const input: TidyInput = {
      ...tidyInput(cur, new Set([...options.unreadIds, ...newIds])),
      cap: options.cap,
      ...(scope ? { scopeIds: [...scope] } : {}),
      ...(note ? { note } : {}),
    };
    let r: ReturnType<typeof tidyOpsToLines>, ops: TidyAiOp[];
    try {
      ops = await options.tidy(input);
      if (options.stillCurrent && !options.stillCurrent()) return null;
      r = tidyOpsToLines(cur, ops, scope, { cap: options.cap });
    } catch (e) {
      if (round === 0) throw e;
      break;
    }
    lines.push(...r.lines);
    newIds.push(...r.newIds);
    merged += r.merged;
    dropped += r.dropped;
    note = notDone(parseLedger(appendLines(options.ledger, lines)), ops);
  }
  const fit = scope ? { lines: [], newIds: [], merged: 0 } : fitCap(parseLedger(appendLines(options.ledger, lines)), options.cap);
  lines.push(...fit.lines);
  const state = parseLedger(appendLines(options.ledger, lines));
  const live = new Set(liveJudgments(state).map(j => j.id));
  return {
    lines,
    state,
    newIds: [...newIds, ...fit.newIds].filter(id => live.has(id)),
    merged: merged + fit.merged,
    dropped,
    applied: lines.length - 1,
    forced: fit.merged,
    before,
  };
}

/** The update's own lines: new judgments, revisions, marks and the model's reorganizing. */
function generatedLines(
  ledger: string,
  result: GenerateLike & { reorganize?: string },
  opts: Parameters<typeof linesFromGenerate>[2] & { cap: number },
) {
  const generated = linesFromGenerate(parseLedger(ledger), result, opts);
  const lines = [...generated.lines];
  const touched = new Set([...(result.docRevisions ?? []).map(r => r.anchor), ...(result.docMarks ?? []).map(m => m.anchor)]);
  if (result.reorganize) {
    const cur = parseLedger(appendLines(ledger, lines));
    const input = tidyInput(cur, new Set());
    const ops = parseTidyOps(
      result.reorganize,
      new Map(input.judgments.map(j => [j.id, j.id])),
      input.judgments,
      new Set(input.prose.map(p => p.domain)),
      input.prose.map(p => p.text).join('\n\n'),
    );
    const r = tidyOpsToLines(cur, ops, undefined, { cap: opts.cap });
    lines.push(...r.lines);
    r.newIds.forEach(id => touched.add(id));
  }
  return { lines, newIds: generated.newIds, touched };
}

/** What one write changed, judged by the map before and after it. */
export interface MapChanges {
  /** Judgments carrying new material; `absorbed` names old judgments merged into them. */
  added: Array<{ id: string; title: string; absorbed: string[] }>;
  /** Judgments made only by merging old ones, with the old titles. */
  merged: Array<{ id: string; title: string; from: string[] }>;
  /** Old judgments dropped without being merged anywhere. */
  removed: string[];
  /** Old judgments rewritten or re-marked in place. */
  revised: string[];
  /** Chapters whose text changed. */
  chapters: number;
}

export function mapChanges(before: LedgerState, after: LedgerState, touchedIds: Iterable<string> = []): MapChanges {
  const old = new Set(liveJudgments(before).map(j => j.id));
  const live = liveJudgments(after);
  const liveIds = new Set(live.map(j => j.id));
  const oldMembers = (id: string, seen = new Set<string>()): string[] => {
    if (old.has(id)) return [id];
    if (seen.has(id)) return [];
    seen.add(id);
    return (after.judgments.get(id)?.mergedFrom ?? []).flatMap(m => oldMembers(m, seen));
  };
  const onlyOld = (id: string, seen = new Set<string>()): boolean => {
    if (old.has(id)) return true;
    const from = after.judgments.get(id)?.mergedFrom ?? [];
    if (!from.length || seen.has(id)) return false;
    seen.add(id);
    return from.every(m => onlyOld(m, seen));
  };
  const titleOf = (id: string) => before.judgments.get(id)?.title ?? after.judgments.get(id)?.title ?? id;
  const fresh = live.filter(j => !old.has(j.id));
  const landsLive = (id: string, seen = new Set<string>()): boolean => {
    if (liveIds.has(id)) return true;
    const into = after.judgments.get(id)?.mergedInto;
    if (!into || seen.has(id)) return false;
    seen.add(id);
    return landsLive(into, seen);
  };
  const proseOf = (st: LedgerState) => {
    const byDomain = new Map<string, string>();
    for (const p of st.prose) if (!p.deleted) byDomain.set(p.domain, `${byDomain.get(p.domain) ?? ''}\n${p.lines.join('\n')}`);
    return byDomain;
  };
  const prose0 = proseOf(before), prose1 = proseOf(after);
  return {
    added: fresh.filter(j => !onlyOld(j.id)).map(j => ({ id: j.id, title: j.title, absorbed: oldMembers(j.id).map(titleOf) })),
    merged: fresh.filter(j => onlyOld(j.id)).map(j => ({ id: j.id, title: j.title, from: oldMembers(j.id).map(titleOf) })),
    removed: [...old].filter(id => !liveIds.has(id) && !landsLive(id)).map(titleOf),
    revised: [...new Set(touchedIds)].filter(id => old.has(id) && liveIds.has(id)).map(titleOf),
    chapters: [...new Set([...prose0.keys(), ...prose1.keys()])].filter(d => prose0.get(d) !== prose1.get(d)).length,
  };
}

type UpdateOptions = Parameters<typeof linesFromGenerate>[2] & {
  cap: number;
  /** First ledger line of the tidy an over-cap update runs. */
  tidyHeader: string;
};

export interface UpdateLines {
  lines: string[];
  /** Judgments to show as unread: new material and merges of old judgments. */
  newIds: string[];
  /** Old judgments this update rewrote or re-marked in place. */
  touchedIds: string[];
  changes: MapChanges;
  /** The model's tidy brought the map back within its cap. */
  tidied: boolean;
  /** Merges the system made itself because the map was still above its cap. */
  forced: number;
  tidyError?: string;
}

/**
 * The update's own lines, then the given tidy rounds applied in order while the map
 * stays above its cap. `tidyLines` starts with the tidy header; `note` tells the
 * next round what the last one could not do.
 */
function updateDraft(ledger: string, result: GenerateLike & { reorganize?: string }, opts: UpdateOptions, rounds: TidyAiOp[][]) {
  const { lines, newIds, touched } = generatedLines(ledger, result, opts);
  const unread = new Set([...newIds, ...touched]);
  const tidyLines = [opts.tidyHeader];
  const stateNow = () => parseLedger(appendLines(ledger, [...lines, ...tidyLines]));
  let note: string | undefined, tidyError: string | undefined;
  for (const ops of rounds) {
    const cur = stateNow();
    if (liveJudgments(cur).length <= opts.cap) break;
    try {
      const r = tidyOpsToLines(cur, ops, undefined, { cap: opts.cap });
      tidyLines.push(...r.lines);
      r.newIds.forEach(id => unread.add(id));
    } catch (e) {
      tidyError = e instanceof Error ? e.message : String(e);
      break;
    }
    note = notDone(stateNow(), ops);
  }
  return { lines, touched, unread, tidyLines, stateNow, note, tidyError };
}

/**
 * Updates keep the map within its cap (D65, amended 2026-11-09 as D71): when the
 * update's own answer leaves the map above the cap, the model tidies the whole map,
 * old and new judgments together, and keeps what matters most; while it is still
 * above, another round is told what could not be done. This is the next
 * round's input after `rounds` — the update's new and rewritten judgments show as
 * 〔未读〕 — or null when the map fits or no round is left.
 */
export function updateTidyInput(
  ledger: string,
  result: GenerateLike & { reorganize?: string },
  opts: UpdateOptions,
  rounds: TidyAiOp[][] = [],
): TidyInput | null {
  if (rounds.length >= TIDY_ROUNDS) return null;
  const draft = updateDraft(ledger, result, opts, rounds);
  const cur = draft.stateNow();
  if (draft.tidyError || liveJudgments(cur).length <= opts.cap) return null;
  return { ...tidyInput(cur, draft.unread), cap: opts.cap, ...(draft.note ? { note: draft.note } : {}) };
}

/**
 * The model's tidy rounds for an update that leaves the map above its cap. The first
 * round's failure is thrown; a later round's failure keeps the rounds before it.
 */
export async function updateTidyRounds(
  ledger: string,
  result: GenerateLike & { reorganize?: string },
  opts: UpdateOptions & { tidy: TidyOptions['tidy'] },
): Promise<TidyAiOp[][]> {
  const rounds: TidyAiOp[][] = [];
  for (let input = updateTidyInput(ledger, result, opts); input; input = updateTidyInput(ledger, result, opts, rounds)) {
    try {
      rounds.push(await opts.tidy(input));
    } catch (e) {
      if (!rounds.length) throw e;
      break;
    }
  }
  return rounds;
}

/**
 * The update's ledger lines: its own answer, then the model's tidy rounds when given
 * (from updateTidyRounds), then the system's neighbour merge for whatever still
 * exceeds the cap.
 */
export function linesFromUpdate(
  ledger: string,
  result: GenerateLike & { reorganize?: string },
  opts: UpdateOptions & { tidyRounds?: TidyAiOp[][] },
): UpdateLines {
  const draft = updateDraft(ledger, result, opts, opts.tidyRounds ?? []);
  const { touched, tidyError } = draft;
  const tidied = draft.tidyLines.length > 1;
  const lines = [...draft.lines, ...(tidied ? draft.tidyLines : [])];
  const fit = fitCap(parseLedger(appendLines(ledger, lines)), opts.cap);
  lines.push(...fit.lines);
  const forced = fit.merged;
  const before = parseLedger(ledger);
  const after = parseLedger(appendLines(ledger, lines));
  const changes = mapChanges(before, after, touched);
  const oldLive = new Set(liveJudgments(before).map(j => j.id));
  const liveNow = new Set(liveJudgments(after).map(j => j.id));
  return {
    lines,
    newIds: [...changes.added, ...changes.merged].map(j => j.id),
    touchedIds: [...touched].filter(id => oldLive.has(id) && liveNow.has(id)),
    changes,
    tidied,
    forced,
    ...(tidyError ? { tidyError } : {}),
  };
}

/** An update whose over-cap tidy runs through `tidy`; a failed tidy falls back to the system's merge. */
export async function linesFromUpdateWithinCap(
  ledger: string,
  result: GenerateLike & { reorganize?: string },
  opts: UpdateOptions & { tidy: TidyOptions['tidy'] },
): Promise<UpdateLines> {
  let tidyRounds: TidyAiOp[][] = [], tidyError: string | undefined;
  try {
    tidyRounds = await updateTidyRounds(ledger, result, opts);
  } catch (e) {
    tidyError = e instanceof Error ? e.message : String(e);
  }
  const out = linesFromUpdate(ledger, result, { ...opts, tidyRounds });
  return tidyError ? { ...out, tidyError } : out;
}
