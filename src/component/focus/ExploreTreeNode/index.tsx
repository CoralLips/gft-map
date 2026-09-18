/**
 * ExploreTreeNode — 探索模式的 reactflow 节点
 *  - 数据源 FocusCard + CandidateItem（虚框候选：isCandidate=true 时虚线 + ✓✕ 按钮）
 *  - 锚定小卡：title/body 编辑、commit 历史、notes；回调全部 optional（不传=按钮不显示）
 */

import { memo, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { fmtDateTime } from '../../../util/datetime';
import type { JSX } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { diffArrays } from 'diff';
import { copyToClipboard } from '../../../util/clipboard';
import styles from './ExploreTreeNode.module.css';

// 把中文长文本切分成句子数组（按 。！？\n 等分隔）
function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  // 分隔符保留：[句子][分隔符] 一起作为一个 chunk
  const re = /[^。！？!?\n]*[。！？!?\n]?/g;
  const matches = text.match(re);
  if (!matches) return [text];
  return matches.filter(s => s.length > 0);
}

interface DiffChunk {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

function computeBodyDiff(oldBody: string, newBody: string): DiffChunk[] {
  const oldSentences = splitIntoSentences(oldBody);
  const newSentences = splitIntoSentences(newBody);
  const diff = diffArrays(oldSentences, newSentences);
  const chunks: DiffChunk[] = [];
  for (const part of diff) {
    const text = (part.value as string[]).join('');
    if (!text) continue;
    if (part.added) chunks.push({ type: 'added', text });
    else if (part.removed) chunks.push({ type: 'removed', text });
    else chunks.push({ type: 'unchanged', text });
  }
  return chunks;
}

export interface ExploreCommit {
  id: string;
  message: string;
  body: string;
  timestamp: number;
  parentCommitId: string | null;
  author: 'user' | 'ai';
}

export interface ExploreSuggestion {
  message: string;
  body: string;
  isGenerating: boolean;
  source: 'auto' | 'manual';
}

export interface ExploreNodeData {
  // 共用字段
  id: string;
  title: string;
  body: string;
  notes: { id: string; text: string; createdAt: number }[];
  commits: ExploreCommit[];
  headCommitId: string | null;
  suggestion: ExploreSuggestion | null;

  // 锚定小卡是否打开（受控状态，由 ExploreTreeView 维护，确保同时只有一个开）
  isPanelOpen: boolean;

  // 候选 vs 实节点
  isCandidate: boolean;

  // 视觉状态
  hasChildren: boolean;
  isExpanded: boolean;

  // 当前查看的节点高亮（不改变对话上下文）
  isHighlighted: boolean;

  // 拖拽状态
  isDragging: boolean;
  isDropTarget: boolean;
  dropZone: 'before' | 'after' | 'inside' | null;
  isValidDropTarget: boolean;
  isInvalidDropTarget: boolean;

  // 编辑
  isEditing: boolean;

  // 只读模式（Plaza 预览专用）：禁所有写入入口
  readonly?: boolean;

  /** 思维导航专用：title 完整显示不截断（一句锐利判断=图上唯一可见内容；body 留给 hover/详情面板） */
  inlineBody?: boolean;


  // 思维脉络选中工具条（挂在选中节点正下方；不传不显示——树/Plaza 零影响）
  onContinueFrom?: (id: string) => void;
  onStartLinking?: (id: string) => void;
  onDeleteSelf?: (id: string) => void;
  /** 单节点整理（✨）：AI 按上下文完善——粗记润色 / 问题找答案 */
  onRefine?: (id: string) => void;
  /** 到白盒文档看这一条 */
  onViewDoc?: (id: string) => void;
  /** 整理进行中（全局，防并发）——按钮转「整理中…」 */
  refining?: boolean;

  // 收拢产物（L2 判断）专属：×N 角标 + 面板成员列表 + 拆开（不传 = 普通 L1 节点）
  memberCount?: number;
  members?: Array<{ id: string; title: string; body: string }>;
  onDissolve?: (id: string) => void;

  /** 框选/加选态（多选工具条的视觉对应；与单击展开的紫框区分：虚线描边） */
  isMultiSelected?: boolean;

  /** 未读红点（增量新增、未点开）——右上角小红点，单击即清（思维脉络专用） */
  unread?: boolean;
  /** 来源=外部 agent（Claude Code 经 MCP 写入）——左下角 ⚡ 角标，与站内 chat 长出的节点区分 */
  viaAgent?: boolean;

  // ===== 瞬态层：AI 建议 + 已确认永久态（思维脉络专用）=====
  /** 已确认"被推翻"——灰显留痕（完全态） */
  superseded?: boolean;
  /** 已确认"未解"——挂?（完全态；口径=isOpen 标题问号单源） */
  unresolved?: boolean;
  // ===== AI 推进提议（2026-08-05，落库；低调角标形态——用户拍：别浮夸，左上角一个问号就够）=====
  /** challenge=质疑此节点（左上角虚化?角标）/ add=AI 补充的新节点（整节点虚线） */
  proposalKind?: 'challenge' | 'add';
  /** 质疑/补充的理由——challenge 的理由与操作收在详情面板（图上只剩 ? 角标），没有理由的质疑零信息量 */
  proposalReason?: string;
  /** 收下：challenge→节点变悬着 / add→转正为常规节点 */
  onProposalAccept?: () => void;
  /** 撤掉（×）：challenge→恢复原状 / add→删除节点。默认保留，撤必须显式 */
  onProposalDismiss?: () => void;

  // 回调
  onNodeClick: (id: string) => void;
  onToggleExpand?: () => void;
  onAddChild?: (parentId: string) => void;
  onDelete?: (item: { id: string; title: string }) => void;
  onEdit?: (id: string) => void;
  onTitleChange?: (id: string, newTitle: string) => void;
  onCancelEdit?: (id: string) => void;
  // 手动新增子节点（带类型选择）
  onAddChildWithType?: (parentId: string) => void;
  // 候选专用
  onConfirm?: (candidateId: string) => void;
  onReject?: (candidateId: string) => void;
  // 锚定小卡
  onTogglePanel?: (id: string) => void;
  /** 思维导航专用：把节点存入当前项目（不传=按钮不显示，树/Plaza 模式零影响） */
  onSaveToProject?: (id: string) => void;
  /** 是否已存入项目（按钮变 ✓ 防重复） */
  isSaved?: boolean;
  onBodyChange?: (id: string, newBody: string) => void;
  onRemoveNote?: (id: string, noteId: string) => void;
  onCommit?: (id: string, message: string) => void;
  onRestoreCommit?: (id: string, commitId: string) => void;
  onDropCommit?: (id: string, commitId: string) => void;
  onRewordCommit?: (id: string, commitId: string, newMessage: string) => void;
  // AI Suggested commit
  onGenerateSuggestion?: (id: string) => void;
  onAcceptSuggestion?: (id: string, overrides?: { message?: string; body?: string }) => void;
  onDismissSuggestion?: (id: string) => void;
  onEditSuggestion?: (id: string, updates: { message?: string; body?: string }) => void;
}

// ⋯ hover 角标开关：07-05 手势调整（hover=出操作/单击=直接展开）后 ⋯ 冗余，暂时隐藏；
// 三轮迭代调好的样式与过道机制保留（hover 轻读容器将来可复用），置 true 即恢复
const SHOW_HOVER_BADGE = false;

// 比较 commits 数组：仅看影响 UI 的字段（id / message / body）
// 不能只看 length — reword/drop 都会改但 length 不变
function commitsEqual(a: ExploreCommit[], b: ExploreCommit[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.message !== y.message || x.body !== y.body) return false;
  }
  return true;
}

const arePropsEqual = (prev: NodeProps<ExploreNodeData>, next: NodeProps<ExploreNodeData>) => {
  const p = prev.data;
  const n = next.data;
  return (
    p.id === n.id &&
    p.title === n.title &&
    p.body === n.body &&
    p.notes.length === n.notes.length &&
    (p.notes.length === 0 || p.notes[p.notes.length - 1].id === n.notes[n.notes.length - 1].id) &&
    commitsEqual(p.commits, n.commits) &&
    p.headCommitId === n.headCommitId &&
    p.suggestion?.message === n.suggestion?.message &&
    p.suggestion?.body === n.suggestion?.body &&
    p.suggestion?.isGenerating === n.suggestion?.isGenerating &&
    p.isPanelOpen === n.isPanelOpen &&
    p.isCandidate === n.isCandidate &&
    p.isHighlighted === n.isHighlighted &&
    p.hasChildren === n.hasChildren &&
    p.isExpanded === n.isExpanded &&
    p.isDragging === n.isDragging &&
    p.isDropTarget === n.isDropTarget &&
    p.dropZone === n.dropZone &&
    p.isValidDropTarget === n.isValidDropTarget &&
    p.isInvalidDropTarget === n.isInvalidDropTarget &&
    p.isEditing === n.isEditing &&
    !!p.readonly === !!n.readonly &&
    !!p.inlineBody === !!n.inlineBody &&
    p.memberCount === n.memberCount &&
    !!p.isMultiSelected === !!n.isMultiSelected &&
    !!p.unread === !!n.unread &&
    !!p.superseded === !!n.superseded &&
    !!p.unresolved === !!n.unresolved &&
    p.proposalKind === n.proposalKind &&
    p.proposalReason === n.proposalReason &&
    !!p.isSaved === !!n.isSaved
  );
};

export const ExploreTreeNode = memo(({ data }: NodeProps<ExploreNodeData>): JSX.Element => {
  const {
    id, title, body, notes, commits, headCommitId, isCandidate, isPanelOpen,
    isHighlighted,
    hasChildren, isExpanded,
    isDragging, dropZone, isValidDropTarget, isInvalidDropTarget,
    isEditing, readonly, inlineBody,
    onNodeClick, onToggleExpand, onDelete,
    onTitleChange, onCancelEdit, onConfirm, onReject,
    onAddChildWithType,
    onTogglePanel, onSaveToProject, isSaved, onBodyChange, onRemoveNote, onCommit, onRestoreCommit,
    onContinueFrom, onStartLinking, onDeleteSelf, onRefine, onViewDoc, refining,
    memberCount, members, onDissolve, isMultiSelected, unread,
    unresolved, // superseded 仍在 props/memo 比较里，图上不再消费（9-5 删灰显）
    proposalKind, proposalReason, onProposalAccept, onProposalDismiss,
    onDropCommit, onRewordCommit,
    suggestion, onGenerateSuggestion, onAcceptSuggestion, onDismissSuggestion, onEditSuggestion,
  } = data;
  const isReadonly = !!readonly;

  const [isHovered, setIsHovered] = useState(false);
  // hover 时间缓冲：离开后延迟收起（角标/按钮组不会因路径抖动闪没）
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleHoverEnter = useCallback(() => {
    if (hoverLeaveTimer.current) { clearTimeout(hoverLeaveTimer.current); hoverLeaveTimer.current = null; }
    setIsHovered(true);
  }, []);
  const handleHoverLeave = useCallback(() => {
    if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current);
    hoverLeaveTimer.current = setTimeout(() => setIsHovered(false), 250);
  }, []);
  useEffect(() => () => { if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current); }, []);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // 锚定小卡：body 内联编辑
  const [isEditingBody, setIsEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(body);
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);

  // commit 弹窗状态
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const commitInputRef = useRef<HTMLInputElement>(null);

  // 复制反馈（点完显示 ✓ 1.5s）
  const [copyJustClicked, setCopyJustClicked] = useState(false);

  // 锚定小卡里 title 编辑（与节点上的 isEditing 不同，专属锚定小卡内部）
  const [isEditingPanelTitle, setIsEditingPanelTitle] = useState(false);
  const [panelTitleDraft, setPanelTitleDraft] = useState(title);
  const panelTitleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isEditingPanelTitle) setPanelTitleDraft(title);
  }, [title, isEditingPanelTitle]);
  useEffect(() => {
    if (isEditingPanelTitle && panelTitleInputRef.current) {
      panelTitleInputRef.current.focus();
      panelTitleInputRef.current.select();
    }
  }, [isEditingPanelTitle]);
  const commitPanelTitle = () => {
    const trimmed = panelTitleDraft.trim();
    if (trimmed && trimmed !== title) {
      onTitleChange?.(id, trimmed);
    }
    setIsEditingPanelTitle(false);
  };

  // Viewing past 状态：null = 在 HEAD（可编辑当前 body）；非 null = 查看某个历史 commit（read-only）
  const [viewingCommitId, setViewingCommitId] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // Reword 状态：哪条 commit 在改 message，draft 是当前 input 值
  const [rewordingCommitId, setRewordingCommitId] = useState<string | null>(null);
  const [rewordDraft, setRewordDraft] = useState('');
  const rewordInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (rewordingCommitId && rewordInputRef.current) {
      rewordInputRef.current.focus();
      rewordInputRef.current.select();
    }
  }, [rewordingCommitId]);
  const viewingCommit = viewingCommitId ? commits.find(c => c.id === viewingCommitId) : null;
  const isViewingPast = !!viewingCommit;
  const displayBody = isViewingPast ? viewingCommit!.body : body;

  // 复制当前显示的 body（如果在 viewing past 则复制历史版本）到剪贴板
  const handleCopySnippet = useCallback(async () => {
    const titleStr = title.trim() || '(未命名)';
    const md = `## ${titleStr}\n\n${displayBody.trim()}\n`;
    const ok = await copyToClipboard(md);
    if (ok) {
      setCopyJustClicked(true);
      setTimeout(() => setCopyJustClicked(false), 1500);
    }
  }, [title, displayBody]);

  // diff 计算（仅在需要时算）：对比 viewing commit 和 HEAD
  const diffChunks = useMemo(() => {
    if (!isViewingPast || !showDiff) return null;
    return computeBodyDiff(viewingCommit!.body, body);
  }, [isViewingPast, showDiff, viewingCommit, body]);

  // Modified state：body 是否和最新 commit 不一致
  const headCommit = headCommitId ? commits.find(c => c.id === headCommitId) : null;
  const isModified = !isViewingPast && (!headCommit ? !!body?.trim() : body !== headCommit.body);

  const handleDiscardChanges = () => {
    if (!headCommit) return;
    onBodyChange?.(id, headCommit.body);
  };

  // 关闭面板/退出 viewing 时重置 diff
  useEffect(() => {
    if (!isPanelOpen) {
      setViewingCommitId(null);
      setShowDiff(false);
    }
  }, [isPanelOpen]);
  useEffect(() => {
    if (!isViewingPast) setShowDiff(false);
  }, [isViewingPast]);

  useEffect(() => {
    if (!isEditingBody) setBodyDraft(body);
  }, [body, isEditingBody]);

  useEffect(() => {
    if (isEditingBody && bodyTextareaRef.current) {
      const ta = bodyTextareaRef.current;
      ta.focus();
      // 自适应高度：贴合内容（与 read-only 渲染视觉一致）
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(ta.scrollHeight + 4, 40)}px`;
    }
  }, [isEditingBody]);

  useEffect(() => {
    if (isCommitDialogOpen && commitInputRef.current) {
      commitInputRef.current.focus();
    }
  }, [isCommitDialogOpen]);

  const commitBody = () => {
    const trimmed = bodyDraft.trim();
    if (trimmed !== (body || '').trim()) {
      onBodyChange?.(id, trimmed);
    }
    setIsEditingBody(false);
  };

  const openCommitDialog = () => {
    setCommitMessage('');
    setIsCommitDialogOpen(true);
  };

  const submitCommit = () => {
    const msg = commitMessage.trim();
    if (!msg) return;
    onCommit?.(id, msg);
    setCommitMessage('');
    setIsCommitDialogOpen(false);
  };

  // formatCommitTime 收口 util/datetime 的 fmtDateTime(批4,与设置页 fmtTime 逐字重复)

  const hasTitle = !!title.trim();
  const displayTitle = title || '(未命名)';
  // inlineBody 模式（思维导航）：完整显示不截断——图的价值=扫一眼看全局
  const truncatedTitle = !inlineBody && displayTitle.length > 14
    ? displayTitle.slice(0, 14) + '…'
    : displayTitle;

  useLayoutEffect(() => {
    if (isEditing && inputRef.current) {
      const input = inputRef.current;
      let attempts = 0;
      const tryFocus = () => {
        attempts++;
        if (window.getComputedStyle(input).visibility !== 'visible' && attempts < 50) {
          requestAnimationFrame(tryFocus);
          return;
        }
        input.focus();
        input.select();
      };
      tryFocus();
    }
  }, [isEditing, id]);

  useEffect(() => {
    setEditValue(title);
  }, [title]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onTitleChange?.(id, editValue.trim() || '未命名');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancelEdit?.(id);
    }
  };

  const handleBlur = () => {
    onTitleChange?.(id, editValue.trim() || '未命名');
  };

  const nodeClassName = [
    styles.node,
    isCandidate ? styles.candidate : '',
    isHighlighted ? styles.highlighted : '',
    isMultiSelected ? styles.multiSelected : '',
    // 2026-09-05 用户拍：✗ 已否决不再灰显/虚线——图上只留三态（未读红点／问号／普通），标记只住文档
    proposalKind === 'add' ? styles.proposedNode : '', // AI 补充的提议节点：虚线+半透明（收下✓/撤×/编辑即转正）
    isDragging ? styles.dragging : '',
    isValidDropTarget && dropZone === 'before' ? styles.dropBefore : '',
    isValidDropTarget && dropZone === 'after' ? styles.dropAfter : '',
    isValidDropTarget && dropZone === 'inside' ? styles.dropInside : '',
    isInvalidDropTarget ? styles.invalidDropTarget : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />

      <div
        className={styles.wrapper}
        data-id={id}
        onMouseEnter={handleHoverEnter}
        onMouseLeave={handleHoverLeave}
      >
        <div
          className={nodeClassName}
          onClick={() => { if (!isEditing) onNodeClick(id); }}
        >
          {/* 未读红点（增量新增未点开）：右上角外挂小圆点，单击节点即清——微信未读点同款 */}
          {inlineBody && unread && !isEditing && <span className={styles.unreadDot} />}

          {/* ⚡来源角标已删（2026-8-7 用户拍：agent 写入与站内长出同权，不留视觉血统——
              与 proposal 转正"不留血统"同一哲学；知情靠 submit 回执+未读红点，不靠常驻标。
              数据层 source 字段保留（按终态设计，将来要按来源过滤数据还在） */}

          {/* 已确认"未解"永久态：左上角常驻问号（完全态，落库） */}
          {inlineBody && unresolved && !isEditing && (
            <span className={styles.unresolvedMark} title="悬着——标题以问号结尾即悬案；想通了就编辑标题删掉问号">?</span>
          )}

          {/* AI 建议虚化层（瞬态）：点它=确认（stopPropagation 防触发节点本体的"否决"）；
              点节点实体=否决（走 onNodeClick）。虚化层本身即"待确认"的视觉提示，无需额外标记 */}
          {/* AI 推进提议的低调角标：challenge=左上角一个虚化?，仅此而已——理由与操作
              收进详情面板（2026-08-07 用户拍：图上别浮夸，点开才看质疑内容）；
              add=保留 hover ✓×（「收下/删掉」语义直觉、无歧义） */}
          {proposalKind && !isEditing && (
            <span className={`${styles.proposalCorner} nodrag nopan`}>
              {proposalKind === 'challenge' && (
                <span className={styles.proposalQ} title="AI 质疑这条判断——点开详情看理由">?</span>
              )}
              {proposalKind === 'add' && onProposalAccept && (
                <button
                  className={styles.proposalBtn}
                  onClick={(e) => { e.stopPropagation(); onProposalAccept(); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title="收下 → 转正为你的节点"
                >✓</button>
              )}
              {proposalKind === 'add' && onProposalDismiss && (
                <button
                  className={`${styles.proposalBtn} ${styles.proposalBtnDanger}`}
                  onClick={(e) => { e.stopPropagation(); onProposalDismiss(); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title="不要这个节点，删掉"
                >×</button>
              )}
            </span>
          )}
          <div className={styles.content}>
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className={styles.editInput}
              />
            ) : (
              <>
                <span
                  className={`${styles.title} ${inlineBody ? styles.titleFull : ''} ${!hasTitle ? styles.placeholder : ''}`}
                  title={inlineBody ? undefined : body ? `${title}\n\n${body}` : title}
                >
                  {truncatedTitle}
                </span>
                {/* L2 判断角标：收了几条（数字自解释，不违"没有说明的视觉状态"铁律） */}
                {inlineBody && !!memberCount && (
                  <span className={styles.memberBadge} title={`由 ${memberCount} 条收成——点开看成员`}>×{memberCount}</span>
                )}
                {hasChildren && onToggleExpand && !isCandidate && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleExpand();
                    }}
                    className={styles.toggleButton}
                    title={isExpanded ? '折叠' : '展开'}
                  >
                    <span className={styles.toggleIcon}>{isExpanded ? '▼' : '▶'}</span>
                  </button>
                )}
                {/* ⋯ 详情按钮（树/Plaza 行内常驻）；思维脉络（inlineBody）改走节点外右上角标（见下方 hoverBadge） */}
                {!isCandidate && onTogglePanel && !inlineBody && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePanel(id);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={`${styles.detailToggleBtn} ${inlineBody ? styles.detailToggleBtnBoxed : ''} ${isPanelOpen ? styles.detailToggleBtnActive : ''}`}
                    title={isPanelOpen ? '关闭详情' : '查看详情'}
                  >⋯</button>
                )}
              </>
            )}
          </div>
        </div>

        {/* 思维脉络 hover 工具条：浮在 hover 节点正下方（零行程；07-05 从"单击选中"改 hover 直出——删节点从两步变一步）；拖动中压制 */}
        {inlineBody && isHovered && !isDragging && !isEditing && (onContinueFrom || onStartLinking || onDeleteSelf) && (
          <div
            className={`${styles.selectedToolbar} nodrag nopan`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {onContinueFrom && (
              <button className={styles.selectedToolbarBtn} onClick={() => onContinueFrom(id)} title="在这个判断后面添加一个新节点（承接它）">＋ 添加</button>
            )}
            {onStartLinking && (
              <button className={styles.selectedToolbarBtn} onClick={() => onStartLinking(id)} title="牵一条承接线到另一个节点">🔗 连线</button>
            )}
            {onRefine && (
              <button
                className={styles.selectedToolbarBtn}
                onClick={() => onRefine(id)}
                disabled={refining}
                title="让 AI 根据上下文完善这个节点：粗记→改锐利补支撑；未解的问题→尝试找答案接上（找到答案问号自动熄灭）"
              >{refining ? '✨ 整理中…' : '✨ 整理'}</button>
            )}
            {onViewDoc && (
              <button className={styles.selectedToolbarBtn} onClick={() => onViewDoc(id)} title="到白盒文档看这一条的完整表述">📄 Doc</button>
            )}
            {/* L2 判断的"删除"=拆开（成员回图面，数据无损）；普通节点=删除（3 秒撤销） */}
            {memberCount && onDissolve ? (
              <button className={`${styles.selectedToolbarBtn} ${styles.selectedToolbarBtnDanger}`} onClick={() => onDissolve(id)} title="拆开这组：上层判断移除，成员节点回到图面">⊗ 拆开</button>
            ) : onDeleteSelf ? (
              <button className={`${styles.selectedToolbarBtn} ${styles.selectedToolbarBtnDanger}`} onClick={() => onDeleteSelf(id)} title="删除（3 秒内可撤销）">🗑 删除</button>
            ) : null}
          </div>
        )}

        {/* 思维脉络的 hover 角标（节点右侧外挂，垂直居中）：读入口容器——
            容器从节点右边缘连续延伸（透明过道=空间缓冲），鼠标横滑全程不掉线；
            将来更多轻读操作加进容器。面板开着时不显示（关闭走面板的 ×，避免与右侧面板重叠）。
            ⏸ 07-05 暂时隐藏（单击直接展开面板后 ⋯ 冗余）——样式已调好，保留待复用（勿删） */}
        {SHOW_HOVER_BADGE && inlineBody && !isCandidate && !isEditing && onTogglePanel && isHovered && !isPanelOpen && (
          <div className={`${styles.hoverBadge} nodrag nopan`} onMouseDown={(e) => e.stopPropagation()}>
            <button
              className={styles.hoverBadgeBtn}
              onClick={(e) => { e.stopPropagation(); onTogglePanel(id); }}
              title="查看详情"
            >⋯</button>
          </div>
        )}

        {/* 虚框候选的确认/拒绝按钮（常显） */}
        {isCandidate && !isEditing && !isReadonly && (
          <div
            className={styles.candidateActions}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className={`${styles.candidateBtn} ${styles.confirmBtn}`}
              title="Accept (加入树)"
              onClick={(e) => { e.stopPropagation(); onConfirm?.(id); }}
            >✓</button>
            <button
              className={`${styles.candidateBtn} ${styles.rejectBtn}`}
              title="Reject (丢弃)"
              onClick={(e) => { e.stopPropagation(); onReject?.(id); }}
            >✕</button>
          </div>
        )}

        {/* 锚定详情小卡：点击 ⋯ 打开 / 再点击关闭 / 点空白关闭（由父组件管理） */}
        {isPanelOpen && !isEditing && !isCandidate && (
          <div
            className={`${styles.detailPanel} nopan nodrag nowheel`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.detailHeader}>
              {isEditingPanelTitle ? (
                <input
                  ref={panelTitleInputRef}
                  type="text"
                  className={styles.detailHeaderTitleEdit}
                  value={panelTitleDraft}
                  onChange={(e) => setPanelTitleDraft(e.target.value)}
                  onBlur={commitPanelTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitPanelTitle();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setPanelTitleDraft(title);
                      setIsEditingPanelTitle(false);
                    }
                  }}
                />
              ) : (
                <span
                  className={styles.detailHeaderTitle}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isViewingPast && !isReadonly && onTitleChange) setIsEditingPanelTitle(true);
                  }}
                  title={isReadonly ? '只读模式' : isViewingPast ? '历史版本下不能改名' : '点击改名'}
                >
                  {displayTitle}
                </span>
              )}
              {onSaveToProject && (
                <button
                  className={styles.detailCopyBtn}
                  onClick={(e) => { e.stopPropagation(); if (!isSaved) onSaveToProject(id); }}
                  disabled={isSaved}
                  style={isSaved ? { opacity: 0.55 } : undefined}
                  title={isSaved ? '已存入项目' : '存入项目（成为长期资产）'}
                >{isSaved ? '✓' : '⤵'}</button>
              )}
              <button
                className={styles.detailCopyBtn}
                onClick={(e) => { e.stopPropagation(); void handleCopySnippet(); }}
                title="复制为 Markdown 到剪贴板"
              >{copyJustClicked ? '✓' : '📋'}</button>
              <button
                className={styles.detailCloseBtn}
                onClick={(e) => { e.stopPropagation(); onTogglePanel?.(id); }}
                title="关闭"
              >×</button>
            </div>

            {/* ⚔ AI 质疑块：理由 + 认账操作只在详情态出现——图上仅剩 ? 角标。
                操作=小 ✓×，与图上 add 型提议同一套视觉（08-07 用户拍：别搞两种语言）；
                语义靠语境+title 兜底：理由就在旁边，✓ 读作"认下质疑"。
                点 ✓ 理由固化进 body（acceptProposal），不蒸发 */}
            {proposalKind === 'challenge' && proposalReason && (
              <div className={styles.proposalDetail}>
                <div className={styles.proposalDetailReason}>⚔ {proposalReason}</div>
                <span className={styles.proposalDetailBtns}>
                  {onProposalAccept && (
                    <button
                      className={`${styles.proposalBtn} ${styles.proposalBtnShow}`}
                      onClick={(e) => { e.stopPropagation(); onProposalAccept(); }}
                      title="认下这个质疑 → 标题变问句挂?，理由留进 body"
                    >✓</button>
                  )}
                  {onProposalDismiss && (
                    <button
                      className={`${styles.proposalBtn} ${styles.proposalBtnShow} ${styles.proposalBtnDanger}`}
                      onClick={(e) => { e.stopPropagation(); onProposalDismiss(); }}
                      title="质疑不成立 → 撤掉，恢复原状"
                    >×</button>
                  )}
                </span>
              </div>
            )}

            {/* Viewing past banner */}
            {isViewingPast && (
              <div className={styles.viewingBanner}>
                <div className={styles.viewingBannerText}>
                  {showDiff ? 'Diff vs HEAD' : 'Viewing past'} · <span className={styles.viewingBannerMsg}>{viewingCommit!.message}</span>
                </div>
                <div className={styles.viewingBannerActions}>
                  <button
                    className={styles.viewingBannerBackBtn}
                    onClick={(e) => { e.stopPropagation(); setShowDiff(s => !s); }}
                    title={showDiff ? '回到查看模式' : '对比当前版本和 HEAD'}
                  >{showDiff ? 'Hide Diff' : 'Show Diff'}</button>
                  <button
                    className={styles.viewingBannerBackBtn}
                    onClick={(e) => { e.stopPropagation(); setViewingCommitId(null); }}
                    title="回到 HEAD"
                  >Back to HEAD</button>
                  {onRestoreCommit && (
                    <button
                      className={styles.viewingBannerRestoreBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRestoreCommit(id, viewingCommit!.id);
                        setViewingCommitId(null); // restore 后回到 HEAD
                      }}
                      title="把这个版本作为新 commit 入链"
                    >Restore</button>
                  )}
                </div>
              </div>
            )}

            {/* 「未解」紫栏已删（2026-9-1 用户拍：零信息量）——悬案唯一表达=标题问号，
                想通=编辑标题删问号（编辑即认账），不设第二把手 */}

            {/* body 段：可编辑（仅 HEAD 时） */}
            <div className={styles.detailSection}>
              {/* 脉络场景（无 onBodyChange 且非历史态）整行标签不渲染——「完整表述」四个字零信息量（2026-9-1 用户拍），正文直接开始 */}
              {(onBodyChange || isViewingPast || showDiff) && (
                <div className={styles.detailSectionLabel}>
                  {onBodyChange ? 'Body' : null}
                  {isViewingPast && !showDiff && <span className={styles.detailReadOnlyTag}>read-only</span>}
                  {showDiff && <span className={styles.detailDiffTag}>diff</span>}
                </div>
              )}
              {showDiff && diffChunks ? (
                <div className={`${styles.detailBody} ${styles.detailBodyDiff}`}>
                  {diffChunks.length === 0 ? (
                    <span className={styles.diffEmpty}>(no changes)</span>
                  ) : (
                    diffChunks.map((chunk, i) => (
                      <span
                        key={i}
                        className={
                          chunk.type === 'added' ? styles.diffAdded
                          : chunk.type === 'removed' ? styles.diffRemoved
                          : styles.diffUnchanged
                        }
                      >{chunk.text}</span>
                    ))
                  )}
                </div>
              ) : isEditingBody && !isViewingPast ? (
                <textarea
                  ref={bodyTextareaRef}
                  className={styles.detailBodyEdit}
                  value={bodyDraft}
                  onChange={(e) => {
                    setBodyDraft(e.target.value);
                    // 输入时贴合内容
                    const ta = e.currentTarget;
                    ta.style.height = 'auto';
                    ta.style.height = `${Math.max(ta.scrollHeight + 4, 40)}px`;
                  }}
                  onBlur={commitBody}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setBodyDraft(body);
                      setIsEditingBody(false);
                    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      commitBody();
                    }
                  }}
                  placeholder="还没沉淀，focus 之后会自动填入"
                />
              ) : (
                <div
                  className={`${styles.detailBody} ${!displayBody?.trim() ? styles.detailBodyEmpty : ''} ${(isViewingPast || isReadonly) ? styles.detailBodyReadonly : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    // 无 onBodyChange = 正文只读（与 title 同定式；思维脉络走这条：
                    // 正文来自白盒文档，改它要去 Doc 页签，图上不开反向通道）
                    if (!isViewingPast && !isReadonly && onBodyChange) setIsEditingBody(true);
                  }}
                  title={!onBodyChange ? '正文来自白盒文档——改它请到 Doc 页签' : isReadonly ? '只读模式' : isViewingPast ? '历史版本（read-only）' : '点击编辑'}
                >
                  {displayBody?.trim() || (!onBodyChange || isReadonly ? '（空）' : '（空，点击编辑）')}
                </div>
              )}
              {/* Commit / Discard / AI suggest 按钮（仅 HEAD 模式下，且非编辑态）*/}
              {onCommit && !isEditingBody && !isViewingPast && (
                <div className={styles.detailBodyActions}>
                  {onGenerateSuggestion && (
                    <button
                      className={styles.aiSuggestBtn}
                      onClick={(e) => { e.stopPropagation(); onGenerateSuggestion(id); }}
                      disabled={!!suggestion?.isGenerating}
                      title="让 AI 基于对话生成 commit 建议"
                    >{suggestion?.isGenerating ? 'Generating…' : 'AI suggest'}</button>
                  )}
                  {isModified && headCommit && (
                    <button
                      className={styles.discardBtn}
                      onClick={(e) => { e.stopPropagation(); handleDiscardChanges(); }}
                      title="撤销未提交的改动，body 回到最新 commit"
                    >Discard</button>
                  )}
                  <button
                    className={`${styles.commitBtn} ${isModified ? styles.commitBtnHighlighted : ''}`}
                    onClick={(e) => { e.stopPropagation(); openCommitDialog(); }}
                    disabled={!isModified && commits.length > 0}
                    title={
                      !isModified && commits.length > 0
                        ? '没有未提交的改动'
                        : '提交一个 commit（保存当前 body 为新版本）'
                    }
                  >Commit</button>
                </div>
              )}
            </div>

            {/* L2 判断：成员列表（由哪几条收成——下钻的第一层）+ 拆开（收拢的上诉动作） */}
            {members && members.length > 0 && (
              <div className={styles.detailSection}>
                <div className={styles.detailSectionLabel}>
                  由 {members.length} 条收成
                  {onDissolve && (
                    <button
                      className={styles.dissolveBtn}
                      onClick={(e) => { e.stopPropagation(); onDissolve(id); }}
                      title="拆开这组：上层判断移除，成员节点回到图面"
                    >⊗ 拆开这组</button>
                  )}
                </div>
                <ul className={styles.memberList}>
                  {members.map(m => (
                    <li key={m.id} className={styles.memberItem}>
                      <span className={styles.memberItemTitle}>{m.title}</span>
                      {m.body?.trim() && <span className={styles.memberItemBody}> — {m.body}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* AI Suggested commit 卡片（如果有的话）*/}
            {suggestion && !isViewingPast && (
              <SuggestionCard
                suggestion={suggestion}
                currentBody={body}
                onAccept={(overrides) => onAcceptSuggestion?.(id, overrides)}
                onDismiss={() => onDismissSuggestion?.(id)}
                onEdit={(updates) => onEditSuggestion?.(id, updates)}
              />
            )}

            {/* Log 段：commit 历史（新→旧）——无版本链能力且无历史（思维导航）时整段不渲染 */}
            {(onCommit || commits.length > 0) && (
            <div className={styles.detailSection}>
              <div className={styles.detailSectionLabel}>
                Log ({commits.length})
              </div>
              {commits.length === 0 ? (
                <div className={styles.detailLogEmpty}>No commits yet. Click [Commit] to save the first version.</div>
              ) : (
                <ul className={styles.detailLogList}>
                  {[...commits].reverse().map(c => {
                    const isHead = c.id === headCommitId;
                    const isViewing = c.id === viewingCommitId;
                    const isRewording = c.id === rewordingCommitId;
                    return (
                      <li
                        key={c.id}
                        className={`${styles.detailLogItem} ${isHead ? styles.detailLogItemHead : ''} ${isViewing ? styles.detailLogItemViewing : ''}`}
                        title={isRewording ? '' : `${fmtDateTime(c.timestamp)} · ${c.author}\n\n点击查看此版本`}
                        onClick={(e) => {
                          if (isRewording) return;
                          e.stopPropagation();
                          if (isHead) {
                            setViewingCommitId(null);
                          } else {
                            setViewingCommitId(isViewing ? null : c.id);
                          }
                        }}
                      >
                        <span className={styles.detailLogDot}>{isHead ? '●' : '○'}</span>
                        <span className={styles.detailLogTime}>{fmtDateTime(c.timestamp)}</span>
                        {isRewording ? (
                          <input
                            ref={rewordInputRef}
                            type="text"
                            className={styles.detailLogRewordInput}
                            value={rewordDraft}
                            onChange={(e) => setRewordDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onBlur={() => {
                              const trimmed = rewordDraft.trim();
                              if (trimmed && trimmed !== c.message) {
                                onRewordCommit?.(id, c.id, trimmed);
                              }
                              setRewordingCommitId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                const trimmed = rewordDraft.trim();
                                if (trimmed && trimmed !== c.message) {
                                  onRewordCommit?.(id, c.id, trimmed);
                                }
                                setRewordingCommitId(null);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setRewordingCommitId(null);
                              }
                            }}
                            maxLength={200}
                          />
                        ) : (
                          <span className={styles.detailLogMsg}>{c.message}</span>
                        )}
                        {!isRewording && (
                          <span
                            className={styles.detailLogActions}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            {onRewordCommit && (
                              <button
                                className={styles.detailLogActionBtn}
                                title="改 message"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRewordDraft(c.message);
                                  setRewordingCommitId(c.id);
                                }}
                              >✎</button>
                            )}
                            {onDropCommit && (
                              <button
                                className={`${styles.detailLogActionBtn} ${isHead ? styles.detailLogActionBtnDisabled : ''}`}
                                title={isHead ? '不能删 HEAD（要删 HEAD 应该 Restore 别的版本）' : '删除这条 commit'}
                                disabled={isHead}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!isHead) onDropCommit(id, c.id);
                                }}
                              >🗑</button>
                            )}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            )}

            {/* notes 段：可删 */}
            {notes.length > 0 && (
              <div className={styles.detailSection}>
                <div className={styles.detailSectionLabel}>
                  notes ({notes.length})
                </div>
                <ul className={styles.detailNotesList}>
                  {notes.map(n => (
                    <li key={n.id} className={styles.detailNoteItem}>
                      <span className={styles.detailNoteText}>{n.text}</span>
                      {!isReadonly && (
                        <button
                          className={styles.detailNoteDelBtn}
                          onClick={(e) => { e.stopPropagation(); onRemoveNote?.(id, n.id); }}
                          title="删除这条 note"
                        >🗑</button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Commit 弹窗：嵌入在 detailPanel 内部 */}
            {isCommitDialogOpen && (
              <div
                className={styles.commitDialogOverlay}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setIsCommitDialogOpen(false); }}
              >
                <div
                  className={styles.commitDialog}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className={styles.commitDialogTitle}>New Commit</div>
                  <input
                    ref={commitInputRef}
                    type="text"
                    className={styles.commitInput}
                    placeholder="一句话说明这次 commit 改了什么..."
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submitCommit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setIsCommitDialogOpen(false);
                      }
                    }}
                    maxLength={200}
                  />
                  <div className={styles.commitDialogActions}>
                    <button
                      className={styles.commitDialogCancel}
                      onClick={() => setIsCommitDialogOpen(false)}
                    >Cancel</button>
                    <button
                      className={styles.commitDialogSubmit}
                      onClick={submitCommit}
                      disabled={!commitMessage.trim()}
                    >Commit</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 普通节点 Hover 操作：3 种类型 + 删除 */}
        {/* hover 快捷按钮组：思维脉络（inlineBody）不渲染——删除/编辑统一走选中工具条与详情面板，避免入口冗余 */}
        {isHovered && !isEditing && !isCandidate && !inlineBody && (
          <div
            className={styles.hoverActions}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {onAddChildWithType && (
              <button
                className={`${styles.actionButton} ${styles.addFocusCardBtn}`}
                title="Add FocusCard"
                onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                onClick={(e) => { e.stopPropagation(); onAddChildWithType(id); }}
              >+</button>
            )}
            {onDelete && (
              <button
                className={`${styles.actionButton} ${styles.deleteButton}`}
                title="删除"
                onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                onClick={(e) => { e.stopPropagation(); onDelete({ id, title }); }}
              >✕</button>
            )}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </>
  );
}, arePropsEqual);

ExploreTreeNode.displayName = 'ExploreTreeNode';

// ===== Suggestion 卡片子组件 =====
interface SuggestionCardProps {
  suggestion: ExploreSuggestion;
  currentBody: string;
  onAccept: (overrides?: { message?: string; body?: string }) => void;
  onDismiss: () => void;
  onEdit: (updates: { message?: string; body?: string }) => void;
}

function SuggestionCard({ suggestion, currentBody, onAccept, onDismiss, onEdit }: SuggestionCardProps): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [messageDraft, setMessageDraft] = useState(suggestion.message);
  const [bodyDraft, setBodyDraft] = useState(suggestion.body);

  // 当 suggestion 变化时（AI 重新生成）同步 draft
  useEffect(() => {
    setMessageDraft(suggestion.message);
    setBodyDraft(suggestion.body);
  }, [suggestion.message, suggestion.body]);

  const handleSaveEdit = () => {
    onEdit({ message: messageDraft, body: bodyDraft });
    setIsEditing(false);
  };

  if (suggestion.isGenerating) {
    return (
      <div className={`${styles.suggestionCard} ${styles.suggestionCardLoading}`}>
        <div className={styles.suggestionCardHeader}>
          <span className={styles.suggestionCardTitle}>Generating…</span>
        </div>
        <div className={styles.suggestionCardBody}>
          <span className={styles.suggestionCardLoadingText}>Generating commit suggestion...</span>
        </div>
      </div>
    );
  }

  // diff 预览：suggestion.body vs currentBody
  const diffPreview = computeBodyDiff(currentBody, suggestion.body);

  return (
    <div className={styles.suggestionCard}>
      <div className={styles.suggestionCardHeader}>
        <span className={styles.suggestionCardTitle}>
          AI Suggested{suggestion.source === 'auto' ? ' · auto' : ''}
        </span>
        <button
          className={styles.suggestionCardCloseBtn}
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          title="Dismiss"
        >×</button>
      </div>

      {isEditing ? (
        <div className={styles.suggestionCardEdit}>
          <div className={styles.suggestionCardField}>
            <div className={styles.suggestionCardFieldLabel}>Message</div>
            <input
              type="text"
              className={styles.suggestionCardMessageInput}
              value={messageDraft}
              onChange={(e) => setMessageDraft(e.target.value)}
              maxLength={100}
            />
          </div>
          <div className={styles.suggestionCardField}>
            <div className={styles.suggestionCardFieldLabel}>Body</div>
            <textarea
              className={styles.suggestionCardBodyEdit}
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
              rows={6}
            />
          </div>
          <div className={styles.suggestionCardActions}>
            <button
              className={styles.suggestionCardCancelBtn}
              onClick={(e) => {
                e.stopPropagation();
                setMessageDraft(suggestion.message);
                setBodyDraft(suggestion.body);
                setIsEditing(false);
              }}
            >Cancel</button>
            <button
              className={styles.suggestionCardAcceptBtn}
              onClick={(e) => { e.stopPropagation(); handleSaveEdit(); onAccept({ message: messageDraft, body: bodyDraft }); }}
              disabled={!messageDraft.trim() || !bodyDraft.trim()}
            >Save & Accept</button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.suggestionCardField}>
            <div className={styles.suggestionCardFieldLabel}>Message</div>
            <div className={styles.suggestionCardMessage}>{suggestion.message}</div>
          </div>
          <div className={styles.suggestionCardField}>
            <div className={styles.suggestionCardFieldLabel}>Body diff</div>
            <div className={styles.suggestionCardDiff}>
              {diffPreview.length === 0 ? (
                <span className={styles.diffEmpty}>(no changes)</span>
              ) : (
                diffPreview.map((chunk, i) => (
                  <span
                    key={i}
                    className={
                      chunk.type === 'added' ? styles.diffAdded
                      : chunk.type === 'removed' ? styles.diffRemoved
                      : styles.diffUnchanged
                    }
                  >{chunk.text}</span>
                ))
              )}
            </div>
          </div>
          <div className={styles.suggestionCardActions}>
            <button
              className={styles.suggestionCardDismissBtn}
              onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            >✕ Dismiss</button>
            <button
              className={styles.suggestionCardEditBtn}
              onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
            >✎ Edit</button>
            <button
              className={styles.suggestionCardAcceptBtn}
              onClick={(e) => { e.stopPropagation(); onAccept(); }}
            >✓ Accept</button>
          </div>
        </>
      )}
    </div>
  );
}
