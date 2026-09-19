import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const accountKey = record => `${record.webUrl}|${record.account.id}`;
/** Read identity without networking, including while the device is offline. */
export async function localAccountIdentity(home) {
  try {
    const record = JSON.parse(await readFile(path.join(home, 'account.json'), 'utf8'));
    return record.account?.id && record.webUrl ? { key: accountKey(record), id: record.account.id, webUrl: record.webUrl } : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** Optional, independent login session; tokens stay behind this server-side API. */
export function createAccount({ home, webUrl = process.env.GFT_WEB_URL || 'https://gitforthought.com', fetchImpl = fetch, timeoutMs = 180000 } = {}) {
  const base = new URL(webUrl);
  if (base.username || base.password || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))) throw new Error('GFT 登录地址必须是 HTTPS，或本机开发地址');
  const file = path.join(home, 'account.json');
  let pending = null, error = '', refresh = null, generation = 0;
  let requests = new AbortController();
  let writes = Promise.resolve();
  const serialize = work => { const next = writes.then(work, work); writes = next.catch(() => {}); return next; };
  async function read() { try { const value = JSON.parse(await readFile(file, 'utf8')); return value.webUrl === base.origin ? value : null; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async function save(session, config, epoch) {
    return serialize(async () => {
    if (epoch !== generation) throw new Error('登录已取消');
    if (!session?.refresh_token || !session.user?.id || !session.user?.email) throw new Error('登录服务没有返回有效账号');
    const record = { webUrl: base.origin, config, accessToken: session.access_token, refreshToken: session.refresh_token, account: { id: session.user.id, email: session.user.email }, expiresAt: session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600) };
    await mkdir(home, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    // No await between the last generation check and starting the atomic replacement.
    if (epoch !== generation) { await unlink(temporary); throw new Error('登录已取消'); }
    await rename(temporary, file);
    if (epoch !== generation) { await unlink(file).catch(() => {}); throw new Error('登录已取消'); }
    error = ''; return record;
    });
  }
  async function request(url, options) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`账号服务暂不可用（${response.status}），请重试登录`);
    return response.json();
  }
  async function auth(config, route, payload) {
    const target = new URL(config.url);
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.supabase.co') || target.pathname !== '/' || !config.anonKey) throw new Error('GFT 登录配置无效');
    return request(`${target.origin}/auth/v1/${route}`, { method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }
  async function status() {
    let record = await read();
    if (record && record.expiresAt < Date.now() / 1000 + 30) {
      const epoch = generation;
      try {
        refresh ||= auth(record.config, 'token?grant_type=refresh_token', { refresh_token: record.refreshToken }).then(session => save(session, record.config, epoch)).finally(() => { refresh = null; });
        record = await refresh;
      } catch (e) { error = e.message; record = null; }
    }
    return { connected: !!record, account: record?.account || null, pending: !!pending, error, webUrl: base.origin };
  }
  function cancel() { generation++; requests.abort(); requests = new AbortController(); if (pending) { clearTimeout(pending.timer); pending.server.close(); pending = null; } }
  async function session() {
    if (pending) return null;
    const epoch = generation;
    let record = await read();
    if (!record || epoch !== generation) return null;
    if (!record.accessToken || record.expiresAt < Date.now() / 1000 + 60) {
      refresh ||= auth(record.config, 'token?grant_type=refresh_token', { refresh_token: record.refreshToken }).then(value => save(value, record.config, epoch)).finally(() => { refresh = null; });
      record = await refresh;
    }
    if (epoch !== generation || !record.accessToken) throw new Error('登录已变化，请稍后重试同步');
    const target = new URL(record.config.url);
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.supabase.co') || target.pathname !== '/') throw new Error('GFT 登录配置无效');
    const alive = () => epoch === generation;
    const signal = requests.signal;
    return { key: accountKey(record), id: record.account.id, alive,
      async rpc(name, body, query = '') {
        if (!alive()) throw new Error('登录已变化，已停止同步');
        if (!['gft_sync_index','gft_sync_read','gft_sync_write'].includes(name)) throw new Error('未知同步接口');
        const response = await fetchImpl(`${target.origin}/rest/v1/rpc/${name}${query}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          headers: { apikey: record.config.anonKey, Authorization: `Bearer ${record.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!alive()) throw new Error('登录已变化，已停止同步');
        if (!response.ok) throw new Error(response.status === 404 ? '云端同步接口尚未部署，本地内容已保留。' : `同步暂未完成（${response.status}），本地内容已保留，将自动重试。`);
        return response.json();
      },
    };
  }
  async function begin() {
    cancel(); error = '';
    const epoch = generation, state = randomBytes(32).toString('hex');
    const attempt = { server: null, timer: null, used: false, url: '' };
    const server = http.createServer(async (req, res) => {
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
      const port = server.address()?.port;
      if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== base.origin) return send(403, { error: '不允许此来源' });
      res.setHeader('Access-Control-Allow-Origin', base.origin);
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST' || req.url !== '/callback') return send(404, { error: '不存在' });
      try {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('回调过大'); }
        const payload = JSON.parse(raw);
        if (payload.state !== state || pending !== attempt || attempt.used || epoch !== generation) return send(403, { error: '登录请求已失效，请从 GFT Map 重新发起' });
        if (typeof payload.token_hash !== 'string' || !payload.token_hash) throw new Error('缺少登录凭证');
        attempt.used = true;
        const config = await request(`${base.origin}/api/agent-config`);
        const session = await auth(config, 'verify', { token_hash: payload.token_hash, type: 'email' });
        await save(session, config, epoch);
        send(200, { ok: true });
        clearTimeout(attempt.timer); server.close(); if (pending === attempt) pending = null;
      } catch (e) { error = e.message; send(400, { error }); clearTimeout(attempt.timer); server.close(); if (pending === attempt) pending = null; }
    });
    attempt.server = server;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (epoch !== generation) { server.close(); throw new Error('登录已取消'); }
    attempt.url = `${base.origin}/connect-agent?port=${server.address().port}&state=${state}&client=gft-map&sync=1`;
    attempt.timer = setTimeout(() => { if (pending === attempt) { error = '登录等待超时，请重新发起'; cancel(); } }, timeoutMs);
    attempt.timer.unref(); pending = attempt;
    return { url: attempt.url };
  }
  async function logout() { cancel(); if (refresh) await refresh.catch(() => {}); await serialize(() => unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; })); error = ''; return { connected: false, account: null, pending: false, error: '', webUrl: base.origin }; }
  return { status, session, begin, cancel: async () => { cancel(); return status(); }, logout, close: cancel };
}
