/**
 * ProjectDropdown — 左上角项目下拉
 *
 * 显示当前用户所有 projects（按 owner_user_id 过滤），点击切换。
 * 底部有"+ 新建脉络"入口。
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { confirmDialog } from '../../component/common/ConfirmDialog';
import type { MapProject } from '../../store/thinkingMap/runtime';
import styles from '../FocusLab.module.css';

interface ProjectDropdownProps {
  projects: MapProject[];
  fallbackName?: string;
  currentProjectId: string | null;
  onSwitchProject: (projectId: string) => void;
  onCreateProject: (seed: string) => void;
  onDeleteProject: (projectId: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onImport?: () => void;
}

export function ProjectDropdown({
  projects,
  fallbackName,
  currentProjectId,
  onSwitchProject,
  onCreateProject,
  onDeleteProject,
  onRenameProject,
  onImport,
}: ProjectDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  // 行内改名：哪条脉络正在改名 + 草稿
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setRenamingId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // 改名模式自动聚焦
  useEffect(() => {
    if (renamingId) inputRef.current?.focus();
  }, [renamingId]);

  const handleDelete = useCallback(async (e: React.MouseEvent, project: MapProject) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: '删除脉络',
      message: `确定要删除「${project.name || '未命名脉络'}」吗？\n\n这条脉络下所有节点会一起删除`,
      danger: true,
    });
    if (ok) {
      onDeleteProject(project.id);
      setIsOpen(false);
    }
  }, [onDeleteProject]);

  const currentProject = projects.find(p => p.id === currentProjectId) || null;
  const activeProjects = projects.filter(p => p.status === 'active');
  // 刷新首帧：列表未到但已有选中 id → 用缓存名占位，不闪"选择项目"
  const displayName = currentProject?.name
    ?? (currentProjectId ? (fallbackName ?? '…') : null)
    ?? '选择脉络';

  return (
    <div className={styles.projectDropdown} ref={dropdownRef}>
      <button
        className={styles.projectDropdownBtn}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className={styles.projectDropdownTitle}>
          {displayName}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {isOpen && (
        <div className={styles.projectDropdownMenu}>
          {activeProjects.map(p => (
            <div
              key={p.id}
              className={`${styles.projectDropdownItem} ${p.id === currentProjectId ? styles.active : ''}`}
            >
              {renamingId === p.id ? (
                <input
                  ref={inputRef}
                  className={styles.projectDropdownInput}
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && renameDraft.trim()) {
                      onRenameProject(p.id, renameDraft.trim());
                      setRenamingId(null);
                    } else if (e.key === 'Escape') {
                      setRenamingId(null);
                    }
                  }}
                  onBlur={() => setRenamingId(null)}
                />
              ) : (
                <>
                  <button
                    className={styles.projectDropdownItemBtn}
                    onClick={() => {
                      onSwitchProject(p.id);
                      setIsOpen(false);
                    }}
                  >
                    {p.name || '未命名脉络'}
                  </button>
                  <button
                    className={styles.projectDropdownDeleteBtn}
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameDraft(p.name || '');
                      setRenamingId(p.id);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className={styles.projectDropdownDeleteBtn}
                    onClick={(e) => void handleDelete(e, p)}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
          {activeProjects.length > 0 && <div className={styles.projectDropdownDivider} />}
          <button
            className={styles.projectDropdownCreate}
            onClick={() => {
              // 一键新建（默认名）——首次生成脉络后 AI 自动起名；手动改名（✎）则不覆盖
              onCreateProject('新脉络');
              setIsOpen(false);
            }}
          >
            + 新建脉络
          </button>
          {onImport && <button className={styles.projectDropdownCreate} onClick={() => { setIsOpen(false); onImport(); }}>导入脉络包…</button>}
        </div>
      )}
    </div>
  );
}
