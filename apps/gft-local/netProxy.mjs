// Node's fetch reads neither the system proxy nor HTTPS_PROXY, so behind a VPN that sets a
// system proxy direct connections get reset ("fetch failed"). Find the proxy at start-up and
// send outgoing requests through it; local addresses and NO_PROXY hosts stay direct.
import { execFileSync } from 'node:child_process';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';

const httpUrl = value => {
  if (!value) return undefined;
  const url = /^[a-z][\w+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  return /^https?:\/\//i.test(url) ? url : undefined; // SOCKS is not supported; left alone
};

/** The Windows / macOS system proxy, where VPN clients usually set it; undefined when none. */
function systemProxy() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      );
      if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(out)) return undefined;
      const server = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
      if (!server) return undefined;
      // "host:port", or per protocol "http=host:port;https=host:port;socks=host:port"
      const parts = Object.fromEntries(server.split(';').map(p => (p.includes('=') ? p.split('=') : ['all', p])));
      return httpUrl(parts.https || parts.http || parts.all);
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
      const value = key => out.match(new RegExp(`\\b${key} : (\\S+)`))?.[1];
      for (const kind of ['HTTPS', 'HTTP'])
        if (value(`${kind}Enable`) === '1' && value(`${kind}Proxy`))
          return `http://${value(`${kind}Proxy`)}:${value(`${kind}Port`) || 80}`;
    }
  } catch {
    // Nothing readable: connect directly as before
  }
  return undefined;
}

/** Routes by target host: local and NO_PROXY hosts direct, everything else via the proxy. */
class ProxyRoute extends Dispatcher {
  constructor(proxy, bypass) {
    super();
    this.direct = new Agent();
    this.proxied = new ProxyAgent(proxy);
    this.bypass = bypass;
  }
  dispatch(options, handler) {
    const host = new URL(options.origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (this.bypass(host) ? this.direct : this.proxied).dispatch(options, handler);
  }
  async close() {
    await Promise.all([this.direct.close(), this.proxied.close()]);
  }
  async destroy(error) {
    await Promise.all([this.direct.destroy(error), this.proxied.destroy(error)]);
  }
}

/** Environment variables first, then the system proxy; returns the proxy used, or null. */
export function useProxy(env = process.env) {
  const configured = httpUrl(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
  const proxy = configured || systemProxy();
  if (!proxy) return null;
  if (!configured) {
    // A proxy found in system settings is exported too, so child processes (npm, Agent CLIs) use it
    env.HTTPS_PROXY = env.HTTP_PROXY = proxy;
    env.NO_PROXY ||= 'localhost,127.0.0.1,::1';
  }
  const skip = (env.NO_PROXY || env.no_proxy || '').split(',').map(s => s.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
  const bypass = host =>
    ['localhost', '127.0.0.1', '::1'].includes(host) ||
    skip.some(rule => rule === '*' || host === rule || host.endsWith(`.${rule}`));
  setGlobalDispatcher(new ProxyRoute(proxy, bypass));
  return proxy;
}
