/** Portable received materials. An explicit full-text edit replaces the effective source.
 * Stored in the existing raw column; legacy extracted ledgers remain intact until edited.
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
const EDIT_PREFIX = '来源正文 ';
interface EditedSourceLog {
  v: 2;
  text: string;
  seen: string[];
  editId: string;
  ancestors: string[];
  legacyHash: string;
}

/** A single JSON line keeps user-authored ledger-looking text inert. */
function editedSourceLog(raw: string): EditedSourceLog | undefined {
  const line = raw.split('\n', 1)[0];
  if (!line.startsWith(EDIT_PREFIX)) return;
  let value: EditedSourceLog;
  try { value = JSON.parse(line.slice(EDIT_PREFIX.length)); }
  catch { throw new Error('Log 数据格式损坏，已保留原内容。'); }
  if (value?.v !== 2 || typeof value.text !== 'string' || typeof value.editId !== 'string' || typeof value.legacyHash !== 'string'
    || !Array.isArray(value.seen) || !value.seen.every(key => typeof key === 'string')
    || !Array.isArray(value.ancestors) || !value.ancestors.every(key => typeof key === 'string')) {
    throw new Error('不支持此 Log 数据版本，请升级后再读取。');
  }
  return value;
}
export const isEditedSourceLog = (raw: string): boolean => !!editedSourceLog(raw);
export const isSourceLogControlLine = (line: string): boolean => !!sourceRecord(line) || !!editedSourceLog(line);
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
function legacySourceText(raw: string): string {
  return raw.split('\n').filter(line => !sourceRecord(line) && !/^\[场次 .* · 来源 · [a-f0-9]+\]$/.test(line)).join('\n').trim();
}
export function readSourceLog(raw: string): SourceRecord[] {
  // Validate the envelope even when a caller only needs newly received records.
  editedSourceLog(raw);
  const seen = new Set<string>();
  return raw.split('\n').flatMap(line => {
    const record = sourceRecord(line);
    if (!record || seen.has(identity(record))) return [];
    seen.add(identity(record)); return [record];
  });
}
export function appendSourceLog(raw: string, records: SourceRecord[]): string {
  const seen = new Set([...(editedSourceLog(raw)?.seen ?? []), ...readSourceLog(raw).map(r => fingerprint(identity(r)))]);
  const lines: string[] = [];
  for (const record of records) {
    const key = identity(record), sourceKey = fingerprint(key);
    if (!record.content.length || seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    const stamp = new Date(Number.isFinite(new Date(record.ts ?? 0).getTime()) ? record.ts ?? 0 : 0).toISOString();
    lines.push(`[场次 ${stamp} · 来源 · ${fingerprint(key)}]`, PREFIX + JSON.stringify(record));
  }
  return lines.length ? [raw.trimEnd(), ...lines].filter(Boolean).join('\n') : raw;
}

/** Save the complete readable Log, including an intentional empty document.
 * Only non-reversible hashes of receipt identities survive an edit, never erased source text. */
export function editSourceLog(raw: string, text: string): string {
  if (text === renderSourceLog(raw)) return raw;
  const previous = editedSourceLog(raw);
  const seen = [...new Set([...(previous?.seen ?? []), ...readSourceLog(raw).map(r => fingerprint(identity(r)))])];
  const ancestors = previous ? [...new Set([...previous.ancestors, previous.editId])] : [];
  const editId = fingerprint(JSON.stringify([previous?.editId ?? fingerprint(raw), text, seen]));
  const legacyHash = previous?.legacyHash ?? fingerprint(legacySourceText(raw));
  return EDIT_PREFIX + JSON.stringify({v: 2, text, seen, editId, ancestors, legacyHash} satisfies EditedSourceLog);
}

/** Merge receipts around the latest known full-text edit. Independent full-text edits conflict;
 * an old snapshot must never resurrect material removed by a later edit. */
export function mergeSourceLogs(local: string, remote: string): string {
  if (local === remote) return local;
  const a = editedSourceLog(local), b = editedSourceLog(remote);
  if (!a && !b) throw new Error('普通 Log 应使用场次合并。');
  if (!a || !b) {
    const legacy = legacySourceText(a ? remote : local);
    if (legacy && fingerprint(legacy) !== (a ?? b)!.legacyHash) {
      throw new Error('旧版 Log 有不同修改，已保留当前编辑，请核对后再保存。');
    }
  }
  if (a && b && a.editId !== b.editId) {
    if (a.ancestors.includes(b.editId)) return appendSourceLog(local, readSourceLog(remote));
    if (b.ancestors.includes(a.editId)) return appendSourceLog(remote, readSourceLog(local));
    throw new Error('Log 在两处有不同修改，已保留本地内容，请核对后再保存。');
  }
  if (a) return appendSourceLog(local, readSourceLog(remote));
  return appendSourceLog(remote, readSourceLog(local));
}
export interface SourceEvent {
  layer?: string;
  sourceMeta?: { provider?: string; sessionId?: string; sessionTitle?: string } | null;
  inputs?: unknown;
}
export function sourceRecordsFromEvents(events: SourceEvent[]): SourceRecord[] {
  return events.flatMap(event => event.layer === 'L0->L1' && Array.isArray(event.inputs)
    ? event.inputs.flatMap((m: { id?: string; role?: string; content?: string; ts?: number; name?: string; phase?: string; turnStatus?: string }) => typeof m?.content === 'string' && m.content.length ? [{
      v: 1 as const, provider: event.sourceMeta?.provider || (event.sourceMeta?.sessionId === 'manual' ? 'human' : 'chat'), sessionId: event.sourceMeta?.sessionId || 'manual',
      id: m.id || fingerprint(m.content), role: m.role || 'user', content: m.content,
      title: event.sourceMeta?.sessionTitle || '', ts: m.ts,
      ...(m.name ? {name:m.name} : {}), ...(m.phase ? {phase:m.phase} : {}), ...(m.turnStatus ? {turnStatus:m.turnStatus} : {}),
    }] : []) : []);
}
export function hasSourceLog(raw: string): boolean {
  if (editedSourceLog(raw)) return !!renderSourceLog(raw).trim();
  return readSourceLog(raw).length > 0 || /^[◆◇？?✗⏸] j\d+ /m.test(raw);
}
export function renderSourceLog(raw: string): string {
  const edited = editedSourceLog(raw);
  const records = readSourceLog(raw);
  const legacy = edited ? '' : legacySourceText(raw);
  const parts = records.map(r => {
    const notes = [r.phase === 'commentary' ? '过程说明' : '',r.turnStatus && r.turnStatus !== 'completed' ? '本轮未完成：' + r.turnStatus : ''].filter(Boolean);
    return `## ${r.title || r.sessionId || '材料'} · ${r.name || r.role}${notes.length ? '（'+notes.join('；')+'）' : ''}\n${r.ts ? new Date(r.ts).toISOString() + '\n' : ''}\n${r.content}`;
  });
  if (edited) return parts.length ? [edited.text, ...parts].filter(Boolean).join('\n\n') : edited.text;
  if (legacy) parts.unshift(`## 旧版提取记录（不是完整原文）\n\n${legacy}`);
  return parts.join('\n\n');
}
