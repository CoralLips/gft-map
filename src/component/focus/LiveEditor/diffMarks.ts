/**
 * Diff 标记的纯函数(无 codemirror 依赖)——从 diffMarkPlugin.ts 抽出。
 *
 * 动机(包体积):cleanDiffMarks/hasDiffMarks 是纯正则,却被首屏代码
 * (useFocusChat / FocusLab)引用;若从 diffMarkPlugin 引,会连带把 478KB 的
 * codemirror 拽进首屏。抽到本文件后,首屏只引这里、不碰 codemirror。
 * 编辑器插件(diffMarkPlugin)自身仍从这里复用,单一实现。
 *
 * 标记格式:{{+新增+}} / {{-删除-}} / {{~旧~>新~}}
 */

/** 清理 diff 标记:{{+内容+}}→内容;{{-内容-}}→删除;{{~旧~>新~}}→新 */
export function cleanDiffMarks(content: string): string {
  return content
    .replace(/\{\{\+([\s\S]*?)\+\}\}/g, '$1')  // 保留新增内容
    .replace(/\{\{-([\s\S]*?)-\}\}/g, '')       // 删除被删除的内容
    .replace(/\{\{~([\s\S]*?)~>([\s\S]*?)~\}\}/g, '$2');  // 保留新内容
}

/** 检查内容是否包含 diff 标记 */
export function hasDiffMarks(content: string): boolean {
  return (
    /\{\{\+[\s\S]*?\+\}\}/.test(content) ||
    /\{\{-[\s\S]*?-\}\}/.test(content) ||
    /\{\{~[\s\S]*?~>[\s\S]*?~\}\}/.test(content)
  );
}
