import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { MapHostSnapshot, ThinkingMapHost, ThinkingMapStore } from '../../store/thinkingMap/runtime';

interface ThinkingMapContextValue {
  store: ThinkingMapStore;
  host: ThinkingMapHost;
  memoryControl?: ReactNode;
  exportExtras?: ReactNode;
}

const ThinkingMapContext = createContext<ThinkingMapContextValue | null>(null);

export function ThinkingMapRuntimeProvider({ store, host, memoryControl, exportExtras, children }: ThinkingMapContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ store, host, memoryControl, exportExtras }), [store, host, memoryControl, exportExtras]);
  return <ThinkingMapContext.Provider value={value}>{children}</ThinkingMapContext.Provider>;
}

export function useThinkingMapRuntime(): ThinkingMapContextValue {
  const runtime = useContext(ThinkingMapContext);
  if (!runtime) throw new Error('ThinkingMapRuntimeProvider is required');
  return runtime;
}

/** Select only the host fields a component uses; chat streaming must not refresh the entire right pane. */
export function useThinkingMapHost<T>(selector: (snapshot: MapHostSnapshot) => T): T {
  const { host } = useThinkingMapRuntime();
  return useSyncExternalStore(host.subscribe, () => selector(host.getSnapshot()), () => selector(host.getSnapshot()));
}
