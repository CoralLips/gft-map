/** 多轮整理：浏览器与本地服务共用的同一套循环；模型调用由调用方注入。 */
import { parseLedger, appendLines, liveJudgments, themeOf, type LedgerState } from './ledger';
import { tidyInput, tidyOpsToLines, ChapterCoverageError } from './ledger/bridge';
import { renderSourceLog } from './sourceLog';
import { tidyTarget, TIDY_MAX_ROUNDS, type TidyAiOp, type TidyInput } from './tidyCore';

export interface TidyRoundsOptions {
  ledger: string;
  raw: string;
  unreadIds: Set<string>;
  /** Judgments a selection tidy may change; undefined tidies the whole topic. */
  scopeIds?: Iterable<string>;
  /** First ledger line of this tidy session. */
  header: string;
  /** One model call: the round's input in, parsed operations out. */
  tidy(input: TidyInput): Promise<TidyAiOp[]>;
  /** Checked after every model call; false discards the whole tidy. */
  stillCurrent?(): boolean;
  onRound?(round: number): void | Promise<void>;
}

export interface TidyRoundsResult {
  /** Header plus every applied line, ready to append to `ledger`. */
  lines: string[];
  state: LedgerState;
  newIds: string[];
  merged: number;
  dropped: number;
  applied: number;
  rounds: number;
  /** Judgments in scope before tidying. */
  before: number;
}

/**
 * Tidies toward tidyTarget in one round. Only when that round merged nothing while
 * the map is still above the target does it ask once more, for consolidation
 * (9-6 rule: tidying includes merging). Otherwise the person tidies again if needed.
 * Returns null when stillCurrent() turned false.
 */
export async function runTidyRounds(options: TidyRoundsOptions): Promise<TidyRoundsResult | null> {
  const source = options.raw.trim() ? parseLedger(options.raw) : undefined;
  const scope = options.scopeIds === undefined ? undefined : new Set(options.scopeIds);
  const countInScope = (state: LedgerState) =>
    liveJudgments(state).filter(j => !scope || scope.has(j.id)).length;
  const keepAlive = (state: LedgerState) => {
    if (!scope) return;
    const alive = new Set(liveJudgments(state).map(j => j.id));
    for (const id of scope) if (!alive.has(id)) scope.delete(id);
  };
  const start = parseLedger(options.ledger);
  const before = countInScope(start);
  keepAlive(start);
  const target = tidyTarget(before);
  const lines = [options.header];
  let text = appendLines(options.ledger, lines);
  let cur = parseLedger(text);
  const newIds: string[] = [];
  let merged = 0, dropped = 0, applied = 0, rounds = 0;
  let correctionUsed = false;
  let consolidationRetry = false;
  let retriedConsolidation = false;
  for (let round = 1; round <= TIDY_MAX_ROUNDS; round++) {
    const count = countInScope(cur);
    if (round > 1 && count <= target) break;
    await options.onRound?.(round);
    rounds = round;
    const input: TidyInput = {
      ...tidyInput(cur, options.unreadIds, source),
      sourceDoc: renderSourceLog(options.raw),
      target,
      consolidationRetry,
      ...(scope ? { scopeIds: [...scope] } : {}),
    };
    let ops = await options.tidy(input);
    if (options.stillCurrent && !options.stillCurrent()) return null;
    let r;
    try {
      r = tidyOpsToLines(cur, ops, source, scope, { requireChapterDoc: true });
    } catch (error) {
      if (!(error instanceof ChapterCoverageError) || correctionUsed) throw error;
      correctionUsed = true;
      ops = await options.tidy({ ...input, validationFeedback: error.message });
      if (options.stillCurrent && !options.stillCurrent()) return null;
      r = tidyOpsToLines(cur, ops, source, scope, { requireChapterDoc: true });
    }
    // A theme proposal is ignored by the shared writer: no retry, no empty session.
    if (!r.lines.length && themeOf(cur) && ops.length && ops.every(op => op.kind === 'prose' && op.domain === '主题')) break;
    lines.push(...r.lines);
    newIds.push(...r.newIds);
    merged += r.merged;
    dropped += r.dropped;
    applied += r.lines.length;
    text = appendLines(text, r.lines);
    cur = parseLedger(text);
    if (scope) {
      r.newIds.forEach(id => scope.add(id));
      keepAlive(cur);
    }
    if (ops.some(op => op.kind === 'add')) break;
    if (countInScope(cur) >= count) {
      if (count <= target || retriedConsolidation) break;
      consolidationRetry = true;
      retriedConsolidation = true;
    } else break;
  }
  return { lines, state: cur, newIds, merged, dropped, applied, rounds, before };
}
