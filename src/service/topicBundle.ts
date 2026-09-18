import { parseLedger, themeOf, liveProse } from './ledger';
import { deriveCaches, absorbLegacyRow } from './ledger/bridge';
import { appendSourceLog, sourceRecordsFromEvents } from './sourceLog';
import type { PersistedThinkingMap } from '../type/thinkingMap';

/** Content only: no credentials, active connections or import cursors. */
export interface TopicBundle {
  format: 'gft-theme';
  version: 2;
  topic: { name: string; scope: string; ledger: string; raw: string };
}

export function createTopicBundle(name: string, map: Pick<PersistedThinkingMap, 'ledger' | 'raw'>): TopicBundle {
  return parseTopicBundle({ format: 'gft-theme', version: 2, topic: { name, ledger: map.ledger ?? '', raw: map.raw ?? '' } });
}

export function parseTopicBundle(input: unknown): TopicBundle {
  if (!input || typeof input !== 'object') throw new Error('不是受支持的 GFT 脉络包');
  const value = input as Record<string, unknown>;
  if (value.format !== 'gft-theme' || (value.version !== 1 && value.version !== 2)) throw new Error('不支持此脉络包版本');
  const topic = value.topic as Record<string, unknown> | undefined;
  if (!topic || typeof topic.name !== 'string' || !topic.name.trim() || topic.name.length > 200
    || typeof topic.ledger !== 'string' || typeof topic.raw !== 'string') throw new Error('脉络包缺少有效名称、图文记录或 Log');
  const maxBytes = 4 * 1024 * 1024;
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes) throw new Error('脉络包过大（上限 4 MB）');
  if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.some(event => !event || !['L0->L1', 'L1->L2'].includes(event.layer) || !Array.isArray(event.outputs)))) throw new Error('脉络包的来源记录无效');
  const ledger = topic.ledger;
  const raw = appendSourceLog(topic.raw, sourceRecordsFromEvents((value.sources || []) as Parameters<typeof sourceRecordsFromEvents>[0]));
  const bundle: TopicBundle = { format: 'gft-theme', version: 2, topic: { name: topic.name.trim(), scope: themeOf(parseLedger(ledger)), ledger, raw } };
  // Check the exact formatted export, so an accepted export fits both importers.
  if (new TextEncoder().encode(JSON.stringify(bundle, null, 2)).byteLength > maxBytes) throw new Error('脉络包过大（上限 4 MB）');
  return bundle;
}

export function bundleToMap(input: unknown, projectId: string): PersistedThinkingMap {
  const { ledger, raw } = parseTopicBundle(input).topic;
  const { nodes, edges, doc } = deriveCaches(parseLedger(ledger), projectId, new Set());
  return { nodes, edges, doc, ledger, raw, watermarks: {} };
}

export function mapToBundle(name: string, map: PersistedThinkingMap): TopicBundle {
  return createTopicBundle(name, { ledger: absorbLegacyRow(map.ledger ?? '', map).ledger, raw: map.raw ?? '' });
}

/** Read the current mainline; no extra model call or independent summary cache. */
export function topicSummary(ledger: string): string {
  const text = liveProse(parseLedger(ledger)).filter(p => p.domain === '主线').flatMap(p => p.lines).join(' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > 240 ? chars.slice(0, 240).join('') + '…' : text;
}
