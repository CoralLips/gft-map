import { useEffect, useState } from 'react';
import { LocalDialog } from './ConnectionManager';
import { localRequest } from './localRuntime';
import { useT } from '../../../src/i18n';

type Account = { connected: boolean; account: { id: string; email: string } | null; pending: boolean; error: string; webUrl: string; sync?: {status:string;error:string;lastSyncedAt:string|null;conflicts:number} };
export function AccountDialog({ onClose }: { onClose(): void }) {
  const tr = useT();
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { const value = await localRequest<Account>('/api/account', undefined, controller.signal); if (!controller.signal.aborted) setAccount(value); }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '无法读取账号'); }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 2500);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const login = async () => {
    setBusy(true); setError('');
    const tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null;
    try {
      const result = await localRequest<{ url: string }>('/api/account/login', {});
      setUrl(result.url); setAccount(current => current ? { ...current, pending: true, error: '' } : current);
      if (tab) tab.location.href = result.url;
    } catch (e) { tab?.close(); setError(e instanceof Error ? e.message : '无法开始登录'); }
    finally { setBusy(false); }
  };
  const act = async (action: 'logout' | 'cancel') => {
    setBusy(true); setError('');
    try { setAccount(await localRequest<Account>(`/api/account/${action}`, {})); setUrl(''); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <LocalDialog title={tr('GFT 账号')} onClose={onClose}>
    <p>{!account ? tr('正在读取账号…') : account.connected ? `${tr('已登录')} · ${account.account?.email}` : account.pending ? tr('请在 GFT 授权页完成登录。') : tr('连接你的 GFT 账号')}</p>
    <p className="gft-local-note">{tr('无需登录也能使用。登录后，脉络自动与 GFT 双向同步；一端删除，另一端也会删除。')}</p>
    {account?.connected && <p className="gft-local-note" role="status">{tr(!account.sync ? '重启本地服务后启用同步' : account.sync.status === 'synced' ? '已同步' : account.sync.status === 'pending' ? '等待同步，已保留本地修改' : '正在同步…')}{account.sync?.conflicts ? ` · ${tr('并发修改已保留为冲突副本')}` : ''}</p>}
    {account?.connected && account.sync?.error && <p role="alert" className="gft-local-error">{tr(account.sync.error)}</p>}
    {(error || account?.error) && <p role="alert" className="gft-local-error">{tr(error || account?.error || '')}</p>}
    <div className="gft-local-dialog-actions">
      {account?.pending ? <>{url && <a href={url} target="_blank" rel="noreferrer">{tr('打开授权页')}</a>}<button disabled={busy} onClick={() => void act('cancel')}>{tr('取消登录')}</button></> : account?.connected ? <button disabled={busy} onClick={() => void act('logout')}>{tr('退出本地账号')}</button> : <button className="gft-local-primary" disabled={busy || !account} onClick={() => void login()}>{tr(busy ? '正在打开…' : '在 GFT 中登录')}</button>}
    </div>
  </LocalDialog>;
}
