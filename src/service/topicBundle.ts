import { parseLedger, themeOf, liveProse } from './ledger';
import { deriveCaches } from './ledger/bridge';
import { isMainThread } from './mapDocContract';
import type { PersistedThinkingMap } from '../type/thinkingMap';

/** Content only: no credentials, active connections or import cursors. */
export interface TopicBundle {
  format: 'gft-theme';
  version: 4;
  topic: { name: string; scope: string; ledger: string };
}

export function createTopicBundle(name: string, map: Pick<PersistedThinkingMap, 'ledger'>): TopicBundle {
  return parseTopicBundle({ format: 'gft-theme', version: 4, topic: { name, ledger: map.ledger ?? '' } });
}

export function parseTopicBundle(input: unknown): TopicBundle {
  if (!input || typeof input !== 'object') throw new Error('不是受支持的 GFT 脉络包');
  const value = input as Record<string, unknown>;
  if (value.format !== 'gft-theme' || value.version !== 4) throw new Error('不支持此脉络包版本');
  const topic = value.topic as Record<string, unknown> | undefined;
  if (!topic || typeof topic.name !== 'string' || !topic.name.trim() || topic.name.length > 200
    || typeof topic.ledger !== 'string') throw new Error('脉络包缺少有效名称或图文记录');
  const maxBytes = 4 * 1024 * 1024;
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes) throw new Error('脉络包过大（上限 4 MB）');
  const ledger = topic.ledger;
  return { format: 'gft-theme', version: 4, topic: { name: topic.name.trim(), scope: themeOf(parseLedger(ledger)), ledger } };
}

export function bundleToMap(input: unknown, projectId: string): PersistedThinkingMap {
  const { ledger } = parseTopicBundle(input).topic;
  const { nodes, edges, doc } = deriveCaches(parseLedger(ledger), projectId, new Set());
  return { nodes, edges, doc, ledger, watermarks: {} };
}

export function mapToBundle(name: string, map: PersistedThinkingMap): TopicBundle {
  return createTopicBundle(name, { ledger: map.ledger ?? '' });
}

/** Read the current mainline; no extra model call or independent summary cache. */
export function topicSummary(ledger: string): string {
  const text = liveProse(parseLedger(ledger)).filter(p => isMainThread(p.domain)).flatMap(p => p.lines).join(' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > 240 ? chars.slice(0, 240).join('') + '…' : text;
}
