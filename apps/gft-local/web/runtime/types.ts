import type { PersistedThinkingMap } from '../../../../src/type/thinkingMap';

export interface LocalTopic {
  undo?: Array<{ id: string; ledger?: string; ledgerLength?: number }>;
  id: string;
  name: string;
  scope: string;
  revision: number;
  ledger: string;
  raw: string;
  panel?: PersistedThinkingMap;
  /** Revision of the latest commit that only appended a background writer's lines. */
  appendRevision?: number;
}
export interface TopicSnapshot {
  topic: LocalTopic;
}
export interface CachedMap {
  revision: number;
  serial: number;
  pending: boolean;
  map: PersistedThinkingMap;
  base?: { ledger: string; raw: string };
}
export type ChatProvider = 'codex' | 'claude';
export interface ChatSession {
  provider: ChatProvider;
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
}
export interface ChatConnection {
  id: string;
  topicId: string;
  source: ChatSession;
  history: 'now' | 'all';
  loadedRevision: number | null;
}
export type UpdateSource = { connectionId: string } | { manual: true } | null;
export interface ReceiptNode {
  id: string;
  title: string;
  content: string;
  mark: string;
  domain: string;
  superseded: boolean;
}
export interface UpdateReceipt {
  id: string;
  action: string;
  baseRevision: number;
  resultRevision: number;
  createdAt: string;
  source: { provider: string; sessionTitle: string; messageCount: number } | null;
  changes: {
    name?: { before: string; after: string } | null;
    nodes: Array<{
      id: string;
      kind: 'added' | 'modified' | 'removed';
      before: ReceiptNode | null;
      after: ReceiptNode | null;
    }>;
    edges: {
      modified?: Array<{ from: string; to: string; before: string; after: string }>;
      added: Array<{ from: string; to: string }>;
      removed: Array<{ from: string; to: string }>;
    };
    chapters: Array<{ domain: string; before: string | null; after: string | null }>;
    doc: { before: string; after: string } | null;
  };
  canRollback: boolean;
  rollbackBlockedReason: string | null;
  rolledBackAt?: string;
  rollbackRevision?: number;
}
export interface ReceiptSnapshot {
  topicId: string | null;
  currentRevision: number | null;
  receipt: UpdateReceipt | null;
  loading: boolean;
  rollingBack: boolean;
  error: string;
}
export interface ConnectionSnapshot {
  topicId: string | null;
  revision: number | null;
  connections: ChatConnection[];
  status: 'loading' | 'ready' | 'error';
  error: string;
  operation: {
    phase: 'choosing' | 'reading' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
    message: string;
    taskId?: string;
    hasMore?: boolean;
    undoGroup?: string;
  } | null;
}
export interface LocalRuntimeOptions {
  onRequestUpdate(): Promise<string | null>;
  onRequestSource?(topicId: string, connections: ChatConnection[]): Promise<UpdateSource>;
  onError(message: string): void;
}
