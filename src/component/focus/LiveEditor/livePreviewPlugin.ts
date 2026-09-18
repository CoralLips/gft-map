import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { Range, StateField, Text } from '@codemirror/state';
import katex from 'katex';
import 'katex/dist/katex.min.css';

class HiddenMarkerWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-hidden-marker';
    return span;
  }
}

class LatexWidget extends WidgetType {
  constructor(readonly latex: string, readonly displayMode: boolean) {
    super();
  }

  eq(other: LatexWidget) {
    return other.latex === this.latex && other.displayMode === this.displayMode;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = this.displayMode ? 'cm-latex-block' : 'cm-latex-inline';
    try {
      katex.render(this.latex, span, {
        displayMode: this.displayMode,
        throwOnError: false,
      });
    } catch {
      span.textContent = this.latex;
      span.className = 'cm-latex-error';
    }
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

// Get set of line numbers where cursor/selection is active
function getCursorLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  // 没聚焦时不露原文：刚切进来光标默认在第 1 行，不该把标题的 ## 摊开（2026-09-06 用户反馈）
  if (!view.hasFocus) return lines;
  const { doc } = view.state;
  for (const range of view.state.selection.ranges) {
    const startLine = doc.lineAt(range.from).number;
    const endLine = doc.lineAt(range.to).number;
    for (let l = startLine; l <= endLine; l++) {
      lines.add(l);
    }
  }
  return lines;
}

// Check if a range overlaps with any cursor line
function overlapsWithCursorLines(view: EditorView, cursorLines: Set<number>, from: number, to: number): boolean {
  const { doc } = view.state;
  const startLine = doc.lineAt(from).number;
  const endLine = doc.lineAt(to).number;
  for (let l = startLine; l <= endLine; l++) {
    if (cursorLines.has(l)) return true;
  }
  return false;
}

// Get visible range with padding (extra lines above/below for smooth scrolling)
function getVisibleRange(view: EditorView, padding: number = 50): { from: number; to: number } {
  const { visibleRanges } = view;
  if (visibleRanges.length === 0) {
    return { from: 0, to: view.state.doc.length };
  }
  const from = Math.max(0, visibleRanges[0].from - padding);
  const to = Math.min(view.state.doc.length, visibleRanges[visibleRanges.length - 1].to + padding);
  return { from, to };
}

function findLatexMatches(text: string, offset: number): Array<{ from: number; to: number; latex: string; displayMode: boolean }> {
  const matches: Array<{ from: number; to: number; latex: string; displayMode: boolean }> = [];

  const blockRegex = /\$\$([^$]+)\$\$/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    matches.push({
      from: offset + match.index,
      to: offset + match.index + match[0].length,
      latex: match[1],
      displayMode: true,
    });
  }

  const inlineRegex = /\$([^$\n]+)\$/g;
  while ((match = inlineRegex.exec(text)) !== null) {
    const from = offset + match.index;
    const to = offset + match.index + match[0].length;
    const overlaps = matches.some(m => (from >= m.from && from < m.to) || (to > m.from && to <= m.to));
    if (!overlaps) {
      matches.push({ from, to, latex: match[1], displayMode: false });
    }
  }

  return matches;
}

const docNodeLine = /^( {0,3}>\s+)([◆◇？✗⏸])\s+.+?\s+\^j\d+\s*$/;

// 右栏 Doc 的块级字阶独立于光标和预览：编辑标题时仍保持相同字号、行高和留白。
// 直接从整份文本建立行装饰，滚到后文前已知块高，不因可视区变化再跳动。
function compactDocDecorations(doc: Text): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const node = docNodeLine.exec(line.text);
    if (node) {
      const startsGroup = number === 1 || !docNodeLine.test(doc.line(number - 1).text);
      const endsGroup = number === doc.lines || !docNodeLine.test(doc.line(number + 1).text);
      const className = ['cm-doc-node', startsGroup && 'cm-doc-node-start', endsGroup && 'cm-doc-node-end'].filter(Boolean).join(' ');
      decorations.push(Decoration.line({ class: className }).range(line.from));
      const markFrom = line.from + node[1].length;
      decorations.push(Decoration.mark({ class: 'cm-doc-node-mark' }).range(markFrom, markFrom + node[2].length));
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:\s|$)/.exec(line.text);
    const className = heading
      ? `cm-doc-heading cm-doc-heading-${heading[1].length}`
      : !line.text.trim() ? 'cm-doc-paragraph-break' : null;
    if (className) decorations.push(Decoration.line({ class: className }).range(line.from));
  }
  return Decoration.set(decorations);
}

export const compactDocLayout = StateField.define<DecorationSet>({
  create: state => compactDocDecorations(state.doc),
  update: (decorations, transaction) => transaction.docChanged ? compactDocDecorations(transaction.newDoc) : decorations,
  provide: field => EditorView.decorations.from(field),
});

function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const cursorLines = getCursorLines(view);
  const visible = getVisibleRange(view);
  const compactNodeLines = new Set<number>();
  view.state.field(compactDocLayout, false)?.between(doc.lineAt(visible.from).from, visible.to, (from, _to, decoration) => {
    if (decoration.spec.class?.split(' ').includes('cm-doc-node')) compactNodeLines.add(from);
  });

  // LaTeX: only scan visible range
  const visibleText = doc.sliceString(visible.from, visible.to);
  const latexMatches = findLatexMatches(visibleText, visible.from);

  for (const match of latexMatches) {
    if (overlapsWithCursorLines(view, cursorLines, match.from, match.to)) continue;
    decorations.push(
      Decoration.replace({
        widget: new LatexWidget(match.latex, match.displayMode),
      }).range(match.from, match.to)
    );
  }

  // 白盒机器记号（2026-08-27 用户拍：记号不裸露给人）——存储一字不动，只在渲染层收起：
  //  ^jN 锚（图文互连外键）→ 整个隐藏；留痕行 `> ◇→✗ 日期：理由` → 柔化成小字灰。
  //  光标进本行即还原原文（沿本插件既有的"编辑时显源码"定式），改得动、看不见。
  {
    const fromLine = doc.lineAt(visible.from).number;
    const toLine = doc.lineAt(visible.to).number;
    for (let ln = fromLine; ln <= toLine; ln++) {
      const line = doc.line(ln);
      if (cursorLines.has(ln)) continue;
      // 只收起 compact Doc 节点组的引用符；普通引用、非 compact 编辑器保持原样。
      const node = compactNodeLines.has(line.from) && docNodeLine.exec(line.text);
      if (node) {
        decorations.push(
          Decoration.replace({ widget: new HiddenMarkerWidget() })
            .range(line.from, line.from + node[1].length)
        );
      }
      // 锚：条目头尾部的 ` ^jN`
      const am = /\s\^j\d+\s*$/.exec(line.text);
      if (am) {
        decorations.push(
          Decoration.replace({ widget: new HiddenMarkerWidget() })
            .range(line.from + am.index, line.from + am.index + am[0].length)
        );
      }
      // 留痕行：`> {档}→{档} 日期：理由`
      if (/^>\s*[◆◇？✗⏸]→[◆◇？✗⏸]\s/.test(line.text)) {
        decorations.push(Decoration.line({ class: 'cm-whitebox-trail' }).range(line.from));
      }
    }
  }

  // Syntax tree: only iterate visible range
  syntaxTree(view.state).iterate({
    from: visible.from,
    to: visible.to,
    enter: (node) => {
      const { from, to } = node;
      const nodeType = node.name;

      // Line-level cursor check: if any line of this node has cursor, show source
      if (overlapsWithCursorLines(view, cursorLines, from, to)) return;

      // Headings
      if (nodeType.startsWith('ATXHeading')) {
        const level = parseInt(nodeType.replace('ATXHeading', '')) || 1;
        const text = doc.sliceString(from, to);
        const hashMatch = text.match(/^(#{1,6})\s*/);
        if (hashMatch) {
          const hashEnd = from + hashMatch[0].length;
          decorations.push(
            Decoration.replace({ widget: new HiddenMarkerWidget() }).range(from, hashEnd)
          );
          decorations.push(
            Decoration.mark({ class: `cm-heading cm-heading-${level}` }).range(hashEnd, to)
          );
        }
      }

      // Bold
      if (nodeType === 'StrongEmphasis') {
        const markerLen = 2;
        if (to - from > markerLen * 2) {
          decorations.push(Decoration.replace({ widget: new HiddenMarkerWidget() }).range(from, from + markerLen));
          decorations.push(Decoration.replace({ widget: new HiddenMarkerWidget() }).range(to - markerLen, to));
          decorations.push(Decoration.mark({ class: 'cm-strong' }).range(from + markerLen, to - markerLen));
        }
      }

      // Italic
      if (nodeType === 'Emphasis') {
        const markerLen = 1;
        if (to - from > markerLen * 2) {
          decorations.push(Decoration.replace({ widget: new HiddenMarkerWidget() }).range(from, from + markerLen));
          decorations.push(Decoration.replace({ widget: new HiddenMarkerWidget() }).range(to - markerLen, to));
          decorations.push(Decoration.mark({ class: 'cm-emphasis' }).range(from + markerLen, to - markerLen));
        }
      }

      // Inline code
      if (nodeType === 'InlineCode') {
        const text = doc.sliceString(from, to);
        if (text.startsWith('`') && text.endsWith('`') && to - from > 2) {
          decorations.push(Decoration.replace({ widget: new HiddenMarkerWidget() }).range(from, from + 1));
          decorations.push(Decoration.replace({ widget: new HiddenMarkerWidget() }).range(to - 1, to));
          decorations.push(Decoration.mark({ class: 'cm-inline-code' }).range(from + 1, to - 1));
        }
      }

      // Links
      if (nodeType === 'Link') {
        decorations.push(Decoration.mark({ class: 'cm-link' }).range(from, to));
      }

      // Horizontal rule
      if (nodeType === 'HorizontalRule') {
        decorations.push(Decoration.mark({ class: 'cm-hr' }).range(from, to));
      }
    },
  });

  // Fallback regex for CJK bold (**text**) — only scan visible lines
  const coveredRanges = decorations
    .filter(d => {
      const spec = (d as any).value?.spec;
      return spec?.class === 'cm-strong';
    })
    .map(d => ({ from: d.from - 2, to: d.to + 2 }));

  let inCodeBlock = false;
  const startLine = doc.lineAt(visible.from).number;
  const endLine = doc.lineAt(visible.to).number;

  for (let i = startLine; i <= endLine; i++) {
    const line = doc.line(i);
    const lineText = line.text;

    if (lineText.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const boldRegex = /\*\*(.+?)\*\*/g;
    let m;
    while ((m = boldRegex.exec(lineText)) !== null) {
      const matchFrom = line.from + m.index;
      const matchTo = line.from + m.index + m[0].length;
      const innerFrom = matchFrom + 2;
      const innerTo = matchTo - 2;

      if (coveredRanges.some(r => matchFrom >= r.from && matchTo <= r.to)) continue;
      if (cursorLines.has(i)) continue;
      if (lineText.lastIndexOf('`', m.index) >= 0) {
        const before = lineText.substring(0, m.index);
        const after = lineText.substring(m.index + m[0].length);
        if ((before.split('`').length - 1) % 2 === 1 && after.includes('`')) continue;
      }

      decorations.push(Decoration.replace({ widget: new HiddenMarkerWidget() }).range(matchFrom, innerFrom));
      decorations.push(Decoration.replace({ widget: new HiddenMarkerWidget() }).range(innerTo, matchTo));
      decorations.push(Decoration.mark({ class: 'cm-strong' }).range(innerFrom, innerTo));
    }
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations, true);
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
