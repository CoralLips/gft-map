/**
 * i18n — 轻量中英切换（D48，2026-09-01 用户拍）
 *
 * 设计：中文原文直接当 key（本站以中文为源语言开发，零 key 发明成本）；
 * 英文查 EN 词典，查不到原样返回中文（漏翻可见、不崩）。
 * 范围铁律：只翻界面（按钮/菜单/提示/弹窗）；Map/Doc 等缩写不翻（用户拍）；
 * AI 产出与用户数据（doc/节点/消息）是数据不是界面，永不进词典。
 */
import { create } from 'zustand';
import { EN } from './en';

export type Lang = 'zh' | 'en';

const KEY = 'gft_lang';

function readPref(): Lang {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
}

export const useLangStore = create<LangState>((set) => ({
  lang: readPref(),
  setLang: (l) => {
    try { localStorage.setItem(KEY, l); } catch { /* 隐私模式等存不了就只活当次 */ }
    set({ lang: l });
  },
}));

/** 组件内取翻译函数（订阅语言变化，切换即重渲染） */
export function useT(): (zh: string) => string {
  const lang = useLangStore((s) => s.lang);
  return lang === 'en' ? (zh) => EN[zh] ?? zh : (zh) => zh;
}

/** 非组件场景（confirmDialog 文案等）：读当前语言直翻，不订阅 */
export function t(zh: string): string {
  return useLangStore.getState().lang === 'en' ? (EN[zh] ?? zh) : zh;
}
