/**
 * Diff 标记插件
 * 解析 AI 输出中的差异标记，并渲染成视觉样式
 *
 * 标记格式：
 * - {{+新增内容+}} → 绿色背景
 * - {{-删除内容-}} → 红色删除线
 * - {{~原内容~>新内容~}} → 黄色背景（修改）
 */

import { ViewPlugin, ViewUpdate, Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// 标记正则表达式（使用否定前瞻，支持内容中包含 + - ~ 等字符）
const DIFF_PATTERNS = {
  // {{+新增内容+}} - 匹配 {{+ 和 +}} 之间的任意内容
  add: /\{\{\+([\s\S]*?)\+\}\}/g,
  // {{-删除内容-}} - 匹配 {{- 和 -}} 之间的任意内容
  delete: /\{\{-([\s\S]*?)-\}\}/g,
  // {{~原内容~>新内容~}} - 匹配修改格式
  modify: /\{\{~([\s\S]*?)~>([\s\S]*?)~\}\}/g,
};

// 装饰器：隐藏标记符号
const hideMarker = Decoration.mark({ class: 'cm-diff-marker-hidden' });

// 装饰器：新增内容样式
const addedContent = Decoration.mark({ class: 'cm-diff-added' });

// 装饰器：删除内容样式
const deletedContent = Decoration.mark({ class: 'cm-diff-deleted' });

// 装饰器：修改内容 - 旧内容
const modifyOld = Decoration.mark({ class: 'cm-diff-modify-old' });

// 装饰器：修改内容 - 新内容
const modifyNew = Decoration.mark({ class: 'cm-diff-modify-new' });

// 解析文档并生成装饰
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc.toString();
  const decorations: Array<{ from: number; to: number; decoration: Decoration }> = [];

  // 解析新增标记 {{+...+}}
  let match;
  const addPattern = new RegExp(DIFF_PATTERNS.add.source, 'g');
  while ((match = addPattern.exec(doc)) !== null) {
    const fullStart = match.index;
    const fullEnd = match.index + match[0].length;
    const contentStart = fullStart + 3; // 跳过 {{+
    const contentEnd = fullEnd - 3; // 跳过 +}}

    // 隐藏开始标记 {{+
    decorations.push({ from: fullStart, to: contentStart, decoration: hideMarker });
    // 内容区域加绿色背景
    if (contentStart < contentEnd) {
      decorations.push({ from: contentStart, to: contentEnd, decoration: addedContent });
    }
    // 隐藏结束标记 +}}
    decorations.push({ from: contentEnd, to: fullEnd, decoration: hideMarker });
  }

  // 解析删除标记 {{-...-}}
  const deletePattern = new RegExp(DIFF_PATTERNS.delete.source, 'g');
  while ((match = deletePattern.exec(doc)) !== null) {
    const fullStart = match.index;
    const fullEnd = match.index + match[0].length;
    const contentStart = fullStart + 3; // 跳过 {{-
    const contentEnd = fullEnd - 3; // 跳过 -}}

    // 隐藏开始标记 {{-
    decorations.push({ from: fullStart, to: contentStart, decoration: hideMarker });
    // 内容区域加红色删除线
    if (contentStart < contentEnd) {
      decorations.push({ from: contentStart, to: contentEnd, decoration: deletedContent });
    }
    // 隐藏结束标记 -}}
    decorations.push({ from: contentEnd, to: fullEnd, decoration: hideMarker });
  }

  // 解析修改标记 {{~旧~>新~}}
  const modifyPattern = new RegExp(DIFF_PATTERNS.modify.source, 'g');
  while ((match = modifyPattern.exec(doc)) !== null) {
    const fullStart = match.index;
    const fullEnd = match.index + match[0].length;
    const oldContent = match[1];
    const newContent = match[2];

    // 计算位置
    const oldStart = fullStart + 3; // 跳过 {{~
    const oldEnd = oldStart + oldContent.length;
    const arrowStart = oldEnd; // ~>
    const arrowEnd = arrowStart + 2;
    const newStart = arrowEnd;
    const newEnd = newStart + newContent.length;
    const closeStart = newEnd; // ~}}
    const closeEnd = fullEnd;

    // 隐藏开始标记 {{~
    decorations.push({ from: fullStart, to: oldStart, decoration: hideMarker });
    // 旧内容加删除线
    if (oldStart < oldEnd) {
      decorations.push({ from: oldStart, to: oldEnd, decoration: modifyOld });
    }
    // 隐藏箭头 ~>
    decorations.push({ from: arrowStart, to: arrowEnd, decoration: hideMarker });
    // 新内容加绿色背景
    if (newStart < newEnd) {
      decorations.push({ from: newStart, to: newEnd, decoration: modifyNew });
    }
    // 隐藏结束标记 ~}}
    decorations.push({ from: closeStart, to: closeEnd, decoration: hideMarker });
  }

  // 按位置排序并添加到 builder
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const { from, to, decoration } of decorations) {
    builder.add(from, to, decoration);
  }

  return builder.finish();
}

// ViewPlugin
export const diffMarkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// cleanDiffMarks / hasDiffMarks 已抽到纯文件 diffMarks.ts(无 codemirror 依赖,防首屏拽入)。
// 此处 re-export 保持既有 import 路径(从本插件文件引的地方不变)。
export { cleanDiffMarks, hasDiffMarks } from './diffMarks';
