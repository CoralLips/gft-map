export interface ServiceConnectionSnapshot {
  phase: 'connecting' | 'connected' | 'disconnected';
  checking: boolean;
  hasConnected: boolean;
}

/** Only retries the read supplied by the caller. Mutations never enter this loop. */
export function createReconnectMonitor(check: () => Promise<void>) {
  const listeners = new Set<() => void>();
  let snapshot: ServiceConnectionSnapshot = { phase: 'connecting', checking: false, hasConnected: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let started = false, stopped = false, failures = 0, failureEpoch = 0;
  const publish = (change: Partial<ServiceConnectionSnapshot>) => {
    const next = { ...snapshot, ...change };
    if (Object.keys(next).every(key => next[key as keyof typeof next] === snapshot[key as keyof typeof next])) return;
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!started || stopped) return;
    const delay = snapshot.phase === 'connected' ? 3000 : Math.min(30000, 1000 * 2 ** Math.min(Math.max(0, failures - 1), 5));
    timer = setTimeout(() => { void retry(); }, delay);
  };
  function retry(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (active) return active;
    clearTimeout(timer);
    publish({ checking: true });
    const epoch = failureEpoch;
    // Start in a microtask so concurrent wake-up events share this exact promise.
    active = Promise.resolve().then(check).then(() => {
      if (stopped) return;
      if (epoch !== failureEpoch) { failures++; publish({ phase: 'disconnected' }); return; }
      failures = 0;
      publish({ phase: 'connected', hasConnected: true });
    }, () => {
      if (!stopped) { failures++; publish({ phase: 'disconnected' }); }
    }).finally(() => {
      active = undefined;
      if (!stopped) { publish({ checking: false }); schedule(); }
    });
    return active;
  }
  const wake = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void retry(); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (!started) {
        started = true;
        if (typeof window !== 'undefined') { window.addEventListener('focus', wake); window.addEventListener('online', wake); }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
      }
      return retry();
    },
    retry,
    disconnected() {
      if (stopped) return;
      failureEpoch++;
      publish({ phase: 'disconnected' });
      if (!active) schedule();
    },
    dispose() {
      stopped = true;
      clearTimeout(timer);
      if (typeof window !== 'undefined') { window.removeEventListener('focus', wake); window.removeEventListener('online', wake); }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
      listeners.clear();
    },
  };
}
