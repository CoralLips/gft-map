import { t } from '../../../../src/i18n';

export class LocalApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export class LocalConnectionError extends Error {
  constructor() {
    super(t('本地服务连接中断，当前内容和未保存修改已保留。'));
  }
}
/** `localRequest`, plus reporting a lost connection to the page's reconnect monitor. */
export type Request = <T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
  keepalive?: boolean,
) => Promise<T>;
export async function localRequest<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
  keepalive = false,
): Promise<T> {
  // Bound reads so a stalled socket cannot block reconnect checks indefinitely.
  const controller =
    body === undefined || url.endsWith('/cancel') ? new AbortController() : undefined;
  const abort = () => controller?.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  // Adapter discovery can include CLI authentication checks with their own timeouts.
  const timeout = controller
    ? setTimeout(
        abort,
        url.startsWith('/api/runtime/executor') ? 240000 : 10000,
      )
    : undefined;
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal || signal,
      keepalive,
    });
    const data = await response.json().catch(error => {
      if (controller?.signal.aborted || signal?.aborted) throw error;
      if (response.ok) throw new LocalConnectionError();
      return {};
    });
    if (!response.ok)
      throw new LocalApiError(
        data.error ? t(data.error) : t('请求失败（{status}）', { status: response.status }),
        response.status,
      );
    return data as T;
  } catch (error) {
    if (!signal?.aborted && (error instanceof TypeError || controller?.signal.aborted))
      throw new LocalConnectionError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
export const messageOf = (error: unknown) =>
  t(error instanceof Error ? error.message : String(error));
export const abortError = () => new DOMException(t('任务已取消，当前内容保留。'), 'AbortError');
export const keyOf = (id: string) => `gft-local:panel:${id}`;
export const storage = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* The in-memory pending copy remains available. */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Optional browser mirror. */
    }
  },
};
export function pause(signal: AbortSignal, delay = 500) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const done = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, delay);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
