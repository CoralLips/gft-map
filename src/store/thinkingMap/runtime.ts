import type { StoreApi, UseBoundStore } from 'zustand';
import type { FocusCard } from '../../type/focusCard';
import type { ThinkingEdge, PersistedThinkingMap } from '../../type/thinkingMap';
import type { CondensationEvent, SourceBatch } from '../../type/sourceSnapshot';
import type { GenerateOptions, ThinkingMapResult, RefineResult } from '../../service/thinkingMapCore';
import type { TidyInput, TidyAiOp } from '../../service/tidyCore';
import type { ThinkingMapState, ThinkingMapActions } from './createStore';
export type { GenerateSource, TidyReport, ThinkingMapState, ThinkingMapActions } from './createStore';

export type ThinkingMapStore = UseBoundStore<StoreApi<ThinkingMapState & ThinkingMapActions>>;
export interface MapProject { id: string; name: string; status: 'active' | 'archived' }
export interface MapFeedMessage {
  id: string;
  role: 'user' | 'assistant';
  userName?: string | null;
  content: string;
  timestamp: number;
  status?: string;
}
export interface MapHostSnapshot {
  projects: MapProject[];
  currentProjectId: string | null;
  currentSession: { id: string; title: string; modelId?: string } | null;
  chatHistory: MapFeedMessage[];
  sourceLabel: string;
  pendingTaskLabel?: string;
  projectNameFallback?: string;
  showMemoryToggle?: boolean;
  hasSourceMaterial?: boolean;
  redrawDescription?: string;
}
/** Application ownership and input sources; graph interactions stay in the store. */
export interface ThinkingMapHost {
  getSnapshot(): MapHostSnapshot;
  subscribe(listener: () => void): () => void;
  createProject(name: string): Promise<string | null>;
  switchProject(id: string): void | Promise<void>;
  renameProject(id: string, name: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  ensureCanGenerate(): boolean;
  fetchSourceBatches(id: string, alive: Set<string>): Promise<SourceBatch[]>;
  requestUpdate?(): Promise<void>;
  importBundle?(bundle: unknown): Promise<void>;
  downloadBundle?(): Promise<void>;
}
export interface MapComputeContext {
  projectId: string | null;
  signal: AbortSignal;
}
export interface ThinkingMapRuntime {
  host: ThinkingMapHost;
  persistence: {
    migrateLegacySources?: boolean;
    load(projectId: string): Promise<PersistedThinkingMap | null>;
    loadCached(projectId: string): PersistedThinkingMap | null;
    save(projectId: string, map: PersistedThinkingMap): Promise<PersistedThinkingMap | null>;
    cachePending(projectId: string, map: PersistedThinkingMap): unknown;
    hasPending(projectId: string): boolean;
    hasRemoteChanges(projectId: string, map: PersistedThinkingMap): boolean;
    accept(projectId: string, remote: PersistedThinkingMap, applied?: PersistedThinkingMap): void;
    insertCondensation(projectId: string, event: CondensationEvent): Promise<void>;
    clearCondensations(projectId: string): Promise<void>;
    fetchSourceSnapshots(projectId: string, nodeIds: string[]): Promise<string>;
  };
  ai: {
    generate(input: string, options: GenerateOptions | undefined, onPreview: (preview: { nodes: FocusCard[]; edges: ThinkingEdge[] }) => void, context: MapComputeContext): Promise<ThinkingMapResult>;
    tidy(input: TidyInput, options: { modelId?: string } | undefined, context: MapComputeContext): Promise<TidyAiOp[]>;
    refine(target: FocusCard, neighbors: { up: FocusCard[]; down: FocusCard[] }, birth: string, chat: string, options: { modelId?: string } | undefined, context: MapComputeContext): Promise<RefineResult>;
  };
  preferences?: {
    loadInjectEnabled(): boolean;
    saveInjectEnabled(enabled: boolean): void;
  };
}
