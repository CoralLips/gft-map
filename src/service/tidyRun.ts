/**
 * 整理与生成落账：浏览器、本地服务与 MCP 端点共用；模型调用由调用方注入。
 * 节点上限（D63/D65）在这里兜底：模型一次调用之后仍超上限，由系统把相邻判断合并到上限以内。
 */
import { parseLedger, appendLines, liveJudgments, type LedgerJudgment, type LedgerState } from './ledger';
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

/**
 * One tidy: a single model call (D65). An invalid answer fails the tidy with its
 * reason. A whole-map tidy always ends within the cap. Returns null when
 * stillCurrent() turned false.
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
  const cur = parseLedger(appendLines(options.ledger, lines));
  const input: TidyInput = {
    ...tidyInput(cur, options.unreadIds),
    cap: options.cap,
    ...(scope ? { scopeIds: [...scope] } : {}),
  };
  const ops = await options.tidy(input);
  if (options.stillCurrent && !options.stillCurrent()) return null;
  const r = tidyOpsToLines(cur, ops, scope, { cap: options.cap });
  lines.push(...r.lines);
  const fit = scope ? { lines: [], newIds: [], merged: 0 } : fitCap(parseLedger(appendLines(options.ledger, lines)), options.cap);
  lines.push(...fit.lines);
  const state = parseLedger(appendLines(options.ledger, lines));
  return {
    lines,
    state,
    newIds: [...r.newIds, ...fit.newIds],
    merged: r.merged + fit.merged,
    dropped: r.dropped,
    applied: lines.length - 1,
    forced: fit.merged,
    before,
  };
}

/**
 * Generate/update result → ledger lines (D65): new judgments, in-place revisions and
 * the model's merges, drops and unlinks of existing judgments are written together;
 * the result always ends within the cap, including a map that was above it.
 * `touchedIds` are existing judgments this write rewrote, re-marked or merged into,
 * so hosts can show them as unread next to `newIds`.
 */
export function linesFromGenerateCapped(
  ledger: string,
  result: GenerateLike & { reorganize?: string },
  opts: Parameters<typeof linesFromGenerate>[2] & { cap: number },
): { lines: string[]; newIds: string[]; touchedIds: string[]; forced: number } {
  const generated = linesFromGenerate(parseLedger(ledger), result, opts);
  const lines = [...generated.lines];
  const touched = new Set([...(result.docRevisions ?? []).map(r => r.anchor), ...(result.docMarks ?? []).map(m => m.anchor)]);
  let cur = parseLedger(appendLines(ledger, lines));
  if (result.reorganize) {
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
    cur = parseLedger(appendLines(ledger, lines));
  }
  const fit = fitCap(cur, opts.cap);
  lines.push(...fit.lines);
  fit.newIds.forEach(id => touched.add(id));
  const live = new Set(liveJudgments(parseLedger(appendLines(ledger, lines))).map(j => j.id));
  const newIds = generated.newIds.filter(id => live.has(id));
  return {
    lines,
    newIds,
    touchedIds: [...touched].filter(id => live.has(id) && !newIds.includes(id)),
    forced: fit.merged,
  };
}
