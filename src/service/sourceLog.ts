/** Portable, append-only received materials. Topic filters belong to Doc/Map, never this log.
 * Stored in the existing raw column; legacy extracted ledgers remain intact alongside v1 records.
 * JSON on one physical line prevents material containing ledger syntax from becoming operations.
 */
export interface SourceRecord {
  v: 1;
  provider: string;
  sessionId: string;
  id: string;
  role: string;
  content: string;
  title?: string;
  ts?: number;
  name?: string;
  phase?: string;
  turnStatus?: string;
}
const PREFIX = '来源原文 ';
export function sourceRecord(line: string): SourceRecord | undefined {
  if (!line.startsWith(PREFIX)) return;
  try {
    const value = JSON.parse(line.slice(PREFIX.length));
    if (value?.v === 1 && ['provider', 'sessionId', 'id', 'role', 'content'].every(key => typeof value[key] === 'string')
      && (value.title === undefined || typeof value.title === 'string')
      && ['name','phase','turnStatus'].every(key => value[key] === undefined || typeof value[key] === 'string')
      && (value.ts === undefined || (typeof value.ts === 'number' && Number.isFinite(new Date(value.ts).getTime())))) return value;
  } catch { /* Legacy free text stays legacy text. */ }
}
const identity = (r: SourceRecord) => JSON.stringify([r.provider, r.sessionId, r.id, r.content, r.phase, r.turnStatus]);
// Stable header for ledger merging. Content is part of identity so revised messages retain both versions.
function fingerprint(text: string): string {
  let n = 14695981039346656037n;
  for (const char of text) n = BigInt.asUintN(64, (n ^ BigInt(char.codePointAt(0)!)) * 1099511628211n);
  return n.toString(16);
}
export function readSourceLog(raw: string): SourceRecord[] {
  const seen = new Set<string>();
  return raw.split('\n').flatMap(line => {
    const record = sourceRecord(line);
    if (!record || seen.has(identity(record))) return [];
    seen.add(identity(record)); return [record];
  });
}
export function appendSourceLog(raw: string, records: SourceRecord[]): string {
  const seen = new Set(readSourceLog(raw).map(identity));
  const lines: string[] = [];
  for (const record of records) {
    if (!record.content.trim() || seen.has(identity(record))) continue;
    const key = identity(record); seen.add(key);
    const stamp = new Date(Number.isFinite(new Date(record.ts ?? 0).getTime()) ? record.ts ?? 0 : 0).toISOString();
    lines.push(`[场次 ${stamp} · 来源 · ${fingerprint(key)}]`, PREFIX + JSON.stringify(record));
  }
  return lines.length ? [raw.trimEnd(), ...lines].filter(Boolean).join('\n') : raw;
}
export interface SourceEvent {
  layer?: string;
  sourceMeta?: { provider?: string; sessionId?: string; sessionTitle?: string } | null;
  inputs?: unknown;
}
export function sourceRecordsFromEvents(events: SourceEvent[]): SourceRecord[] {
  return events.flatMap(event => event.layer === 'L0->L1' && Array.isArray(event.inputs)
    ? event.inputs.flatMap((m: { id?: string; role?: string; content?: string; ts?: number; name?: string; phase?: string; turnStatus?: string }) => typeof m?.content === 'string' && m.content.trim() ? [{
      v: 1 as const, provider: event.sourceMeta?.provider || (event.sourceMeta?.sessionId === 'manual' ? 'human' : 'chat'), sessionId: event.sourceMeta?.sessionId || 'manual',
      id: m.id || fingerprint(m.content), role: m.role || 'user', content: m.content,
      title: event.sourceMeta?.sessionTitle || '', ts: m.ts,
      ...(m.name ? {name:m.name} : {}), ...(m.phase ? {phase:m.phase} : {}), ...(m.turnStatus ? {turnStatus:m.turnStatus} : {}),
    }] : []) : []);
}
export function hasSourceLog(raw: string): boolean {
  return readSourceLog(raw).length > 0 || /^[◆◇？?✗⏸] j\d+ /m.test(raw);
}
export function renderSourceLog(raw: string): string {
  const records = readSourceLog(raw);
  const legacy = raw.split('\n').filter(line => !sourceRecord(line) && !/^\[场次 .* · 来源 · [a-f0-9]+\]$/.test(line)).join('\n').trim();
  const parts = records.map(r => {
    const notes = [r.phase === 'commentary' ? '过程说明' : '',r.turnStatus && r.turnStatus !== 'completed' ? '本轮未完成：' + r.turnStatus : ''].filter(Boolean);
    return `## ${r.title || r.sessionId || '材料'} · ${r.name || r.role}${notes.length ? '（'+notes.join('；')+'）' : ''}\n${r.ts ? new Date(r.ts).toISOString() + '\n' : ''}\n${r.content}`;
  });
  if (legacy) parts.unshift(`## 旧版提取记录（不是完整原文）\n\n${legacy}`);
  return parts.join('\n\n');
}
