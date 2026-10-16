import { useEffect, useState } from 'react';
import { useT } from '../../../src/i18n';
import { copyToClipboard } from '../../../src/util/clipboard';
import { LocalDialog } from './ConnectionManager';
import type { createLocalRuntime } from './localRuntime';
type Runtime = ReturnType<typeof createLocalRuntime>;
type Location = {
  topicId: string;
  name: string;
  path: string;
  directory: string;
  dataDirectory: string;
};
export function LocalFilesDialog({
  runtime,
  topicId,
  onClose,
}: {
  runtime: Runtime;
  topicId: string;
  onClose(): void;
}) {
  const tr = useT(),
    [location, setLocation] = useState<Location | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [opening, setOpening] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void runtime
      .request<Location>(
        `/api/topics/${encodeURIComponent(topicId)}/local-file`,
        undefined,
        controller.signal,
      )
      .then(setLocation)
      .catch(e => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [runtime, topicId]);
  return (
    <LocalDialog title={tr('本地文件')} onClose={onClose}>
      {error && (
        <p role="alert" className="gft-local-error">
          {tr(error)}
        </p>
      )}
      {location ? (
        <>
          <strong>{location.name}</strong>
          <label className="gft-local-file-location">
            {tr('当前主题保存路径')}
            <textarea
              rows={3}
              readOnly
              value={location.path}
              aria-label={tr('当前主题保存路径')}
              onFocus={event => event.currentTarget.select()}
            />
          </label>
          <p className="gft-local-note">{tr('Map、Doc 和已收录原文保存在这份主题数据里。')}</p>
          <div className="gft-local-dialog-actions">
            <button
              onClick={() => {
                void copyToClipboard(location.path)
                  .then(ok => {
                    if (!ok) throw new Error(tr('复制失败，请选中路径手动复制。'));
                    setMessage(tr('路径已复制'));
                  })
                  .catch(e => setError(e.message));
              }}
            >
              {tr('复制路径')}
            </button>
            <button
              disabled={opening}
              onClick={() => {
                setOpening(true);
                setError('');
                setMessage('');
                void runtime
                  .request(`/api/topics/${encodeURIComponent(topicId)}/reveal-file`, {})
                  .then(() => setMessage(tr('已在文件管理器中打开')))
                  .catch(e => setError(e.message))
                  .finally(() => setOpening(false));
              }}
            >
              {tr(opening ? '正在打开…' : '打开所在文件夹')}
            </button>
          </div>
          <p role="status" className="gft-local-note">
            {message}
          </p>
          <details className="gft-local-file-root">
            <summary>{tr('全部本地数据')}</summary>
            <code>{location.dataDirectory}</code>
          </details>
        </>
      ) : (
        !error && <p>{tr('正在读取…')}</p>
      )}
    </LocalDialog>
  );
}
