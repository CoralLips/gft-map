/**
 * 视觉主题（2026-08 暗色模式）
 *
 * 机制：偏好存 localStorage（'gft_theme'），生效 = <html data-theme="dark">。
 * 亮色是 :root 默认，暗色由 [data-theme='dark'] 整套 token 覆盖（src/style/index.css）。
 * 首帧即终态：index.html <head> 有同逻辑内联脚本先行，React 挂载前主题已定，无闪白/闪黑。
 * 'system' = 跟随操作系统，且运行中系统切换实时跟随（matchMedia 监听）。
 */

export type ThemePref = 'light' | 'dark' | 'system';

const KEY = 'gft_theme';
const mq = () => window.matchMedia('(prefers-color-scheme: dark)');

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* ignore */ }
  return 'system';
}

function resolveDark(pref: ThemePref): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return mq().matches;
}

function apply(pref: ThemePref): void {
  const el = document.documentElement;
  if (resolveDark(pref)) el.dataset.theme = 'dark';
  else delete el.dataset.theme;
}

export function setThemePref(pref: ThemePref): void {
  try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  apply(pref);
}

/** 应用当前偏好并挂系统主题监听（system 模式下实时跟随）。入口调用一次。 */
export function initTheme(): void {
  apply(getThemePref());
  mq().addEventListener('change', () => {
    if (getThemePref() === 'system') apply('system');
  });
}
