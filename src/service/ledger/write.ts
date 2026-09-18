/**
 * 判断账写入助手（纯函数）：造行、追加、编号。写入永远是"在文本末尾追加若干行"。
 */
import type { LedgerMark, LedgerState } from './types';
import { parseLedger } from './parse';
import { bodyLines } from './text';

/** 本地时区 ISO（秒；withMs=true 带毫秒——迁移时保住旧节点创建时间用） */
export const isoLocal = (t: number, withMs = false): string => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60)), om = pad(Math.abs(off) % 60);
  const ms = withMs ? `.${String(d.getMilliseconds()).padStart(3, '0')}` : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms}${sign}${oh}:${om}`;
};

/** 场次头 */
export function sessionLine(at: number, source: string, note?: string): string {
  return `[场次 ${isoLocal(at, true)} · ${source}${note ? ` · ${note}` : ''}]`;
}

/** 走向段 */
export function proseLines(id: string, domain: string, text: string): string[] {
  const body = text.replace(/\n+$/, '');
  return body ? [`走向 ${id} [${domain}]`, ...bodyLines(body)] : [`走向 ${id} [${domain}]`];
}

/** 判断行＋表述；mergedFrom＝合并自哪些（它们退休、边改接）；at 只在迁移时写（保住旧创建时间） */
export function judgmentLines(id: string, mark: LedgerMark, domain: string, title: string, content = '', opts: { mergedFrom?: string[]; rawFrom?: string[]; at?: number } = {}): string[] {
  const merged = opts.mergedFrom?.length ? ` = ${opts.mergedFrom.join(' ')}` : '';
  const rawFrom = opts.rawFrom?.length ? ` ${opts.rawFrom.map(id => `^${id}`).join(' ')}` : '';
  const head = `${mark} ${id} [${domain}] ${title.trim()}${merged}${rawFrom}${opts.at ? ` @${isoLocal(opts.at, true)}` : ''}`;
  const body = content.replace(/\n+$/, '');
  return body ? [head, ...bodyLines(body)] : [head];
}

/** 承接：to 顺着 from */
export const relationLine = (to: string, from: string): string => `← ${to} ${from}`;

/** 行为行（actor＝本人｜AI） */
export function actions(actor: '本人' | 'AI') {
  return {
    retitle: (id: string, title: string) => `${actor} 改 ${id} 标题：${title.trim()}`,
    rewrite: (id: string, content: string) => [`${actor} 改 ${id} 表述：`, ...bodyLines(content)],
    remark: (id: string, mark: LedgerMark) => `${actor} 改 ${id} 档：${mark}`,
    redomain: (id: string, domain: string) => `${actor} 改 ${id} 域：${domain.trim()}`,
    remove: (id: string) => `${actor} 删 ${id}`,
    link: (to: string, from: string) => `${actor} 接 ${to} ${from}`,
    unlink: (to: string, from: string) => `${actor} 断 ${to} ${from}`,
    reorder: (id: string, before: string | '末') => `${actor} 序 ${id} ${before}`,
  };
}
export const decision = actions('本人');
export const aiDecision = actions('AI');

/** 分配编号：j 与 p 共用计数（不撞号） */
export function allocId(st: LedgerState, kind: 'j' | 'p', offset = 0): string {
  return `${kind}${st.nextNum + offset}`;
}

/** 追加若干行（末尾保证单个换行分隔；空账不带前导空行） */
export function appendLines(ledger: string, lines: string[]): string {
  if (lines.length === 0) return ledger;
  const base = ledger.replace(/\n+$/, '');
  return base ? `${base}\n${lines.join('\n')}` : lines.join('\n');
}

/** 追加并折算（便于调用方一步拿到新状态） */
export function appendAndParse(ledger: string, lines: string[]): { ledger: string; state: LedgerState } {
  const next = appendLines(ledger, lines);
  return { ledger: next, state: parseLedger(next) };
}
