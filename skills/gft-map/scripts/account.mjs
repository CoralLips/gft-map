import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Login is optional. It never reads/uploads topics or borrows another app's refresh token. */
export function createAccount({ home, webUrl = process.env.GFT_WEB_URL || 'https://gitforthought.com', fetchImpl = fetch, timeoutMs = 180000 } = {}) {
  const base = new URL(webUrl);
  if (base.username || base.password || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))) throw new Error('GFT 登录地址必须是 HTTPS，或本机开发地址');
  const file = path.join(home, 'account.json');
  let pending = null, error = '', refresh = null, generation = 0;
  let writes = Promise.resolve();
  const serialize = work => { const next = writes.then(work, work); writes = next.catch(() => {}); return next; };
  async function read() { try { const value = JSON.parse(await readFile(file, 'utf8')); return value.webUrl === base.origin ? value : null; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async function save(session, config, epoch) {
    return serialize(async () => {
    if (epoch !== generation) throw new Error('登录已取消');
    if (!session?.refresh_token || !session.user?.id || !session.user?.email) throw new Error('登录服务没有返回有效账号');
    const record = { webUrl: base.origin, config, refreshToken: session.refresh_token, account: { id: session.user.id, email: session.user.email }, expiresAt: session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600) };
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
  function cancel() { generation++; if (pending) { clearTimeout(pending.timer); pending.server.close(); pending = null; } }
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
    attempt.url = `${base.origin}/connect-agent?port=${server.address().port}&state=${state}&client=gft-map`;
    attempt.timer = setTimeout(() => { if (pending === attempt) { error = '登录等待超时，请重新发起'; cancel(); } }, timeoutMs);
    attempt.timer.unref(); pending = attempt;
    return { url: attempt.url };
  }
  async function logout() { cancel(); if (refresh) await refresh.catch(() => {}); await serialize(() => unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; })); error = ''; return { connected: false, account: null, pending: false, error: '', webUrl: base.origin }; }
  return { status, begin, cancel: async () => { cancel(); return status(); }, logout, close: cancel };
}
