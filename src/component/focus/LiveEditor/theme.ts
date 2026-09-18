import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// 编辑器基础主题
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '15px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  '.cm-content': {
    padding: '20px 24px',
    lineHeight: '1.8',
    caretColor: 'var(--poe-purple)',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--poe-purple)',
    borderLeftWidth: '2px',
  },
  // 选区样式
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(123, 31, 162, 0.15)',
  },
  // 隐藏的标记
  '.cm-hidden-marker': {
    display: 'none',
  },
  // 标题样式
  '.cm-heading': {
    fontWeight: '600',
    color: 'var(--poe-gray-900)',
  },
  '.cm-heading-1': {
    fontSize: '1.6em',
    borderBottom: '2px solid var(--poe-purple)',
    paddingBottom: '4px',
    display: 'inline-block',
  },
  '.cm-heading-2': {
    fontSize: '1.3em',
  },
  '.cm-heading-3': {
    fontSize: '1.1em',
  },
  '.cm-heading-4, .cm-heading-5, .cm-heading-6': {
    fontSize: '1em',
  },
  // 粗体
  '.cm-strong': {
    fontWeight: '600',
    color: '#222',
  },
  // 斜体
  '.cm-emphasis': {
    fontStyle: 'italic',
    color: '#555',
  },
  // 行内代码
  '.cm-inline-code': {
    backgroundColor: 'rgba(123, 31, 162, 0.08)',
    padding: '2px 6px',
    borderRadius: '4px',
    fontFamily: '"Consolas", "Monaco", "Menlo", monospace',
    fontSize: '14px',
    color: 'var(--poe-purple)',
  },
  // 链接
  '.cm-link': {
    color: 'var(--poe-purple)',
    textDecoration: 'underline',
  },
  // 水平线
  '.cm-hr': {
    color: '#ccc',
  },
  // Placeholder 样式
  '.cm-placeholder': {
    color: '#bbb',
    fontStyle: 'normal',
  },
  // AI 操作区域样式（锁定 + 视觉提示）
  '.cm-ai-region': {
    backgroundColor: 'rgba(123, 31, 162, 0.08)',
    borderRadius: '2px',
    position: 'relative',
  },
  // Diff 标记样式 - 隐藏标记符号
  '.cm-diff-marker-hidden': {
    display: 'none',
  },
  // Diff 标记样式 - 新增内容（绿色背景）
  '.cm-diff-added': {
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
    borderRadius: '2px',
    padding: '0 2px',
  },
  // Diff 标记样式 - 删除内容（红色删除线）
  '.cm-diff-deleted': {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    textDecoration: 'line-through',
    color: '#999',
    borderRadius: '2px',
    padding: '0 2px',
  },
  // Diff 标记样式 - 修改内容（旧）
  '.cm-diff-modify-old': {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    textDecoration: 'line-through',
    color: '#999',
    borderRadius: '2px',
    padding: '0 2px',
  },
  // Diff 标记样式 - 修改内容（新）
  '.cm-diff-modify-new': {
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
    borderRadius: '2px',
    padding: '0 2px',
  },
  // LaTeX 公式样式
  '.cm-latex-inline': {
    display: 'inline-block',
    verticalAlign: 'middle',
  },
  '.cm-latex-block': {
    display: 'block',
    textAlign: 'center',
    margin: '8px 0',
  },
  '.cm-latex-error': {
    color: 'var(--poe-red)',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    padding: '2px 4px',
    borderRadius: '2px',
  },
});

// 语法高亮样式（光标在元素内时的颜色）
export const highlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, fontWeight: '700', color: 'var(--poe-purple)' },
    { tag: tags.heading2, fontWeight: '600', color: 'var(--poe-purple)' },
    { tag: tags.heading3, fontWeight: '600', color: 'var(--poe-purple)' },
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, color: 'var(--poe-purple)' },
    { tag: tags.url, color: '#888' },
    { tag: tags.monospace, fontFamily: 'monospace', color: 'var(--poe-purple)' },
    { tag: tags.processingInstruction, color: '#888' }, // markdown 标记符号
  ])
);

// 紧凑模式高亮（右栏 Doc 视图，08-27 用户拍：标题不用紫、正常 md 渲染观感）——
// 标题继承正文色只留字重；紫色是左边"写作纸"的品牌装饰，放进文档正本里喧宾夺主
export const compactHighlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, fontWeight: '700' },
    { tag: tags.heading2, fontWeight: '600' },
    { tag: tags.heading3, fontWeight: '600' },
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, color: 'var(--poe-purple)' },
    { tag: tags.url, color: '#888' },
    { tag: tags.monospace, fontFamily: 'monospace' },
    { tag: tags.processingInstruction, color: '#888' },
  ])
);
