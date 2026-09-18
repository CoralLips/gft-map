import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { EditorState, StateField, StateEffect, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder, Decoration } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { compactDocLayout, livePreviewPlugin } from './livePreviewPlugin';
import { diffMarkPlugin } from './diffMarkPlugin';
import { editorTheme, highlightStyle, compactHighlightStyle } from './theme';
import styles from './LiveEditor.module.css';

// AI 操作区域
interface AiRegion {
  id: string;
  from: number;
  to: number;
}

// 选区信息
interface SelectionInfo {
  text: string;
  from: number;
  to: number;
}

// 暴露给外部的方法
export interface LiveEditorHandle {
  // 在指定位置插入内容
  insertAt: (position: number, content: string) => void;
  /** 找到第一行匹配的行：选中并滚到视野中央；编辑器没就绪或没找到返回 false */
  revealLine: (pattern: RegExp) => boolean;
  // 替换指定范围
  replaceRange: (from: number, to: number, content: string) => void;
  // 添加 AI 操作区域（锁定）
  addAiRegion: (from: number, to: number) => string;
  // 移除 AI 操作区域
  removeAiRegion: (id: string) => void;
  // 获取当前文档内容
  getContent: () => string;
  // 获取 AI 区域的当前位置
  getAiRegionPosition: (id: string) => { from: number; to: number } | null;
}

// AI 操作模式
export type AiOperationMode = 'expand' | 'rewrite' | 'simplify' | 'diverge' | 'deepen' | 'custom';

interface LiveEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  isGenerating?: boolean;
  onAiOperation?: (mode: AiOperationMode, selection: SelectionInfo, customPrompt?: string) => void;
  onSubmit?: () => void; // Ctrl+Enter 触发
  /** 文档身份键（如 projectId）。键变化=换了一份文档→重建编辑器（撤销栈按文档隔离）；
   *  键不变时的外部 value 变化=同一文档在演化（AI 追加/远端合并）→最小差异增量应用，
   *  光标/选区/撤销栈/滚动由 CodeMirror 自动映射穿过变更——编辑中的人不被打断。
   *  不传则保持旧行为（任何外部变化都重建）。 */
  docKey?: string;
  /** 行失焦回调（08-25 用户拍：持久化时机与 live preview 的行级渲染粒度一致）——
   *  编辑过内容后光标离开该行（换行/点击别处）触发一次；纯光标移动不触发。 */
  onLineBlur?: () => void;
  /** 右栏 Doc 主题：平面面板、正文留白与稳定的章节/判断字阶 */
  compact?: boolean;
  /** Ctrl/⌘+点到文中的 ^jN 锚时回调（白盒文档 → 图上那个节点）；普通点击只放光标 */
  onAnchorClick?: (id: string) => void;
}

// StateEffect 用于添加/移除 AI 区域
const addAiRegionEffect = StateEffect.define<AiRegion>();
const removeAiRegionEffect = StateEffect.define<string>();

// StateField 追踪 AI 区域
const aiRegionsField = StateField.define<AiRegion[]>({
  create: () => [],
  update(regions, tr) {
    // 处理 effects
    for (const effect of tr.effects) {
      if (effect.is(addAiRegionEffect)) {
        regions = [...regions, effect.value];
      } else if (effect.is(removeAiRegionEffect)) {
        regions = regions.filter(r => r.id !== effect.value);
      }
    }

    // 映射位置（当文档变化时）
    if (tr.docChanged) {
      regions = regions.map(region => ({
        ...region,
        // from 使用 assoc=-1，保持在插入内容之前
        // to 使用 assoc=1，跟随到插入内容之后
        from: tr.changes.mapPos(region.from, -1),
        to: tr.changes.mapPos(region.to, 1),
      }));
    }

    return regions;
  },
});

// AI 区域装饰（视觉提示）
const aiRegionDecoration = Decoration.mark({
  class: 'cm-ai-region',
});

const aiRegionDecorations = EditorView.decorations.compute([aiRegionsField], (state) => {
  const regions = state.field(aiRegionsField);
  // 过滤掉空区域（from === to），CM6 不允许空的 Mark Decoration
  const decorations = regions
    .filter(region => region.from < region.to)
    .map(region => aiRegionDecoration.range(region.from, region.to));
  return Decoration.set(decorations, true);
});

// Transaction Filter：阻止用户编辑 AI 区域
const aiRegionFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;

  const regions = tr.startState.field(aiRegionsField);
  if (regions.length === 0) return tr;

  // 检查变化是否在 AI 区域内
  let blocked = false;
  tr.changes.iterChanges((fromA, toA) => {
    for (const region of regions) {
      // 如果变化范围与 AI 区域有交集，阻止
      if (fromA < region.to && toA > region.from) {
        // 检查是否是内部操作（通过 annotation 标记）
        if (!tr.annotation(Transaction.userEvent)?.startsWith('ai.')) {
          blocked = true;
        }
      }
    }
  });

  return blocked ? [] : tr;
});

const LiveEditor = forwardRef<LiveEditorHandle, LiveEditorProps>(({
  value,
  onChange,
  placeholder = '开始写下你想探索的问题...',
  isGenerating = false,
  onAiOperation,
  onSubmit,
  docKey,
  onLineBlur,
  compact = false,
  onAnchorClick,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const extensionsRef = useRef<any[]>([]);
  const isInternalUpdate = useRef(false);
  const onSubmitRef = useRef(onSubmit);
  const onChangeRef = useRef(onChange);

  // 保持回调 ref 最新
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const onAnchorClickRef = useRef(onAnchorClick);
  useEffect(() => {
    onAnchorClickRef.current = onAnchorClick;
  }, [onAnchorClick]);

  const onLineBlurRef = useRef(onLineBlur);
  useEffect(() => {
    onLineBlurRef.current = onLineBlur;
  }, [onLineBlur]);
  // 行失焦检测状态：当前光标行号 + 该行是否有过编辑
  const cursorLineRef = useRef<number | null>(null);
  const lineDirtyRef = useRef(false);

  // 选区状态
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [toolbarPos, setToolbarPos] = useState<{ top: number; left: number } | null>(null);

  // 自定义 prompt 输入
  const [showCustomPrompt, setShowCustomPrompt] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');

  // 暴露方法给外部
  useImperativeHandle(ref, () => ({
    insertAt: (position: number, content: string) => {
      if (!viewRef.current) return;
      viewRef.current.dispatch({
        changes: { from: position, insert: content },
        annotations: Transaction.userEvent.of('ai.insert'),
      });
    },

    revealLine: (pattern: RegExp) => {
      const view = viewRef.current;
      if (!view) return false;
      const doc = view.state.doc;
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (!pattern.test(line.text)) continue;
        view.dispatch({
          selection: { anchor: line.from, head: line.to },
          effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
        });
        view.focus();
        return true;
      }
      return false;
    },

    replaceRange: (from: number, to: number, content: string) => {
      if (!viewRef.current) return;
      viewRef.current.dispatch({
        changes: { from, to, insert: content },
        annotations: Transaction.userEvent.of('ai.replace'),
      });
    },

    addAiRegion: (from: number, to: number) => {
      if (!viewRef.current) return '';
      const id = `ai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      viewRef.current.dispatch({
        effects: addAiRegionEffect.of({ id, from, to }),
      });
      return id;
    },

    removeAiRegion: (id: string) => {
      if (!viewRef.current) return;
      viewRef.current.dispatch({
        effects: removeAiRegionEffect.of(id),
      });
    },

    getContent: () => {
      return viewRef.current?.state.doc.toString() || '';
    },

    getAiRegionPosition: (id: string) => {
      if (!viewRef.current) return null;
      const regions = viewRef.current.state.field(aiRegionsField);
      const region = regions.find(r => r.id === id);
      return region ? { from: region.from, to: region.to } : null;
    },
  }));

  // Sync external value to editor.
  // 换文档（docKey 变化）→ setState 重建（撤销栈按文档隔离、干净起步）；
  // 同文档外部演化（AI 追加/远端合并）→ 最小差异 dispatch——CodeMirror 把光标/
  // 选区/撤销栈/滚动自动映射穿过变更，正在编辑的人不被打断（08-25 白盒轮：
  // 此前任何外部变化都整体重建，AI 一追加就把编辑者甩回文档顶部）。
  const docKeyRef = useRef(docKey);
  useEffect(() => {
    if (!viewRef.current) return;
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    const view = viewRef.current;
    const keyChanged = docKey !== docKeyRef.current;
    docKeyRef.current = docKey;
    const currentContent = view.state.doc.toString();
    if (keyChanged) {
      // 换文档：内容相同也重建（撤销栈不许跨文档）
      view.setState(EditorState.create({ doc: value, extensions: extensionsRef.current }));
      return;
    }
    if (currentContent === value) return;
    if (docKey === undefined) {
      // 未声明文档身份的旧用法：保持原行为（整体重建）
      view.setState(EditorState.create({ doc: value, extensions: extensionsRef.current }));
      return;
    }
    // 同文档增量：前后缀剥离出最小差异区间，只应用差异
    let start = 0;
    const minLen = Math.min(currentContent.length, value.length);
    while (start < minLen && currentContent.charCodeAt(start) === value.charCodeAt(start)) start++;
    let endOld = currentContent.length;
    let endNew = value.length;
    while (endOld > start && endNew > start && currentContent.charCodeAt(endOld - 1) === value.charCodeAt(endNew - 1)) {
      endOld--;
      endNew--;
    }
    view.dispatch({
      changes: { from: start, to: endOld, insert: value.slice(start, endNew) },
      annotations: Transaction.userEvent.of('external.sync'),
    });
    // dispatch 同步触发 updateListener→onChange(同值字符串)，其间 isInternalUpdate 被置 true；
    // 同值 set 可能不引发下一次 value effect，这里复位防其遗留吞掉未来真正的外部同步
    isInternalUpdate.current = false;
  }, [value, docKey]);

  // 处理选区变化
  const handleSelectionChange = useCallback((view: EditorView) => {
    const { from, to } = view.state.selection.main;

    if (from !== to) {
      const text = view.state.doc.sliceString(from, to);
      setSelection({ text, from, to });

      // 计算工具栏位置
      const coords = view.coordsAtPos(from);
      if (coords) {
        setToolbarPos({
          top: coords.top - 50,
          left: coords.left,
        });
      }
    } else {
      setSelection(null);
      setToolbarPos(null);
      setShowCustomPrompt(false);
    }
  }, []);

  // 初始化编辑器
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        isInternalUpdate.current = true;
        onChangeRef.current(update.state.doc.toString());
        lineDirtyRef.current = true;
      }

      // 行失焦（与 live preview 行级渲染同粒度）：编辑过后光标行号变化 → 触发一次；
      // 纯光标移动（没编辑）不触发。Enter 换行 = docChanged+行号变同帧发生，同样命中。
      if (update.selectionSet || update.docChanged) {
        const line = update.state.doc.lineAt(update.state.selection.main.head).number;
        if (cursorLineRef.current !== null && line !== cursorLineRef.current && lineDirtyRef.current) {
          lineDirtyRef.current = false;
          onLineBlurRef.current?.();
        }
        cursorLineRef.current = line;
      }

      // 选区变化
      if (update.selectionSet) {
        handleSelectionChange(update.view);
      }
    });

    // 自定义快捷键：Ctrl+Enter 触发提交，阻止默认换行
    const submitKeymap = keymap.of([
      {
        key: 'Ctrl-Enter',
        run: () => {
          onSubmitRef.current?.();
          return true; // 返回 true 阻止默认行为
        },
      },
      {
        key: 'Mod-Enter', // Mac 上的 Cmd+Enter
        run: () => {
          onSubmitRef.current?.();
          return true;
        },
      },
    ]);

    // 点 ^jN 锚 → 回调（不吞其它点击）
    const anchorClick = EditorView.domEventHandlers({
      click: (event, view) => {
        const cb = onAnchorClickRef.current;
        if (!cb || !(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        const line = view.state.doc.lineAt(pos);
        const re = /\^(j\d+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line.text)) !== null) {
          const from = line.from + m.index;
          if (pos >= from && pos <= from + m[0].length) { cb(m[1]); return true; }
        }
        return false;
      },
    });

    const extensions = [
      history(),
      anchorClick,
      submitKeymap, // 放在 defaultKeymap 之前，优先级更高
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      editorTheme,
      compact ? compactHighlightStyle : highlightStyle,
      ...(compact ? [compactDocLayout] : []),
      livePreviewPlugin,
      diffMarkPlugin,
      updateListener,
      EditorView.lineWrapping,
      cmPlaceholder(placeholder),
      aiRegionsField,
      aiRegionDecorations,
      aiRegionFilter,
    ];
    extensionsRef.current = extensions;

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 处理 AI 操作
  const handleAiOperation = useCallback((mode: AiOperationMode) => {
    if (!selection || !onAiOperation) return;

    if (mode === 'custom') {
      setShowCustomPrompt(true);
    } else {
      onAiOperation(mode, selection);
      setSelection(null);
      setToolbarPos(null);
    }
  }, [selection, onAiOperation]);

  // 提交自定义 prompt
  const handleCustomPromptSubmit = useCallback(() => {
    if (!selection || !onAiOperation || !customPrompt.trim()) return;

    onAiOperation('custom', selection, customPrompt);
    setSelection(null);
    setToolbarPos(null);
    setShowCustomPrompt(false);
    setCustomPrompt('');
  }, [selection, onAiOperation, customPrompt]);

  return (
    <div className={`${styles.container} ${compact ? styles.compact : ''}`}>
      <div
        ref={containerRef}
        className={`${styles.editor} ${isGenerating ? styles.generating : ''}`}
      />

      {/* 选中文本工具栏 */}
      {/* AI 写作工具条只在宿主真给了 onAiOperation 时出现（与 title/body 同定式）——
          右边白盒 Doc 不传：那里是判断正本，不是 AI 写作工具（2026-08-29 用户拍） */}
      {selection && toolbarPos && !isGenerating && onAiOperation && (
        <div
          className={styles.selectionToolbar}
          style={{
            position: 'fixed',
            top: toolbarPos.top,
            left: toolbarPos.left,
          }}
        >
          {showCustomPrompt ? (
            <div className={styles.customPromptInput} onMouseDown={(e) => e.preventDefault()}>
              <input
                type="text"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCustomPromptSubmit()}
                placeholder="输入自定义指令..."
                autoFocus
              />
              <button onMouseDown={(e) => e.preventDefault()} onClick={handleCustomPromptSubmit}>确定</button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => setShowCustomPrompt(false)}>取消</button>
            </div>
          ) : (
            <>
              <button
                className={styles.toolbarBtn}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleAiOperation('expand')}
                title="展开这段内容"
              >
                展开
              </button>
              <button
                className={styles.toolbarBtn}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleAiOperation('rewrite')}
                title="改写这段内容"
              >
                改写
              </button>
              <button
                className={styles.toolbarBtn}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleAiOperation('simplify')}
                title="精简这段内容"
              >
                简洁
              </button>
              <button
                className={styles.toolbarBtn}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleAiOperation('diverge')}
                title="发散思考"
              >
                发散
              </button>
              <button
                className={styles.toolbarBtn}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleAiOperation('custom')}
                title="自定义指令"
              >
                自定义
              </button>
            </>
          )}
        </div>
      )}

      {isGenerating && (
        <div className={styles.generatingBadge}>
          <span className={styles.dot}></span>
          <span className={styles.dot}></span>
          <span className={styles.dot}></span>
          <span>AI 思考中</span>
        </div>
      )}
    </div>
  );
});

LiveEditor.displayName = 'LiveEditor';

export default LiveEditor;
