import { useRef, useState, type ReactNode } from 'react';
import { ProjectDropdown } from '../../page/FocusLab/ProjectDropdown';
import { ThinkingMapPanel } from './ThinkingMapPanel';
import { WhiteboxDocPanel } from './WhiteboxDocPanel';
import { LedgerSourcePanel } from './LedgerSourcePanel';
import { useThinkingMapHost, useThinkingMapRuntime } from './ThinkingMapRuntime';
import styles from '../../page/FocusLab.module.css';
import { useT } from '../../i18n';

/** The original FocusLab right pane, shared without changing its markup or styles. */
export function ThinkingMapWorkspace({ showLogTab = true, secondaryActions }: { showLogTab?: boolean; secondaryActions?: ReactNode }) {
  const tr = useT();
  const { store: useThinkingMapStore, host } = useThinkingMapRuntime();
  const projects = useThinkingMapHost(s => s.projects);
  const currentProjectId = useThinkingMapHost(s => s.currentProjectId);
  const fallbackName = useThinkingMapHost(s => s.projectNameFallback);
  const selectedView = useThinkingMapStore(s => s.rightView);
  const rightView = selectedView === 'source' && !showLogTab ? 'doc' : selectedView;
  const setRightView = useThinkingMapStore(s => s.setRightView);
  const importRef = useRef<HTMLInputElement>(null);
  const [importState, setImportState] = useState('');
  const importBusy = useRef(false);

  return <div className={styles.networkPanel}>
    <div className={styles.networkHeader}>
      <div className={styles.networkHeaderLeft}>
        <ProjectDropdown
          projects={projects}
          currentProjectId={currentProjectId}
          fallbackName={fallbackName}
          onSwitchProject={id => { void host.switchProject(id); }}
          onCreateProject={name => { void host.createProject(name); }}
          onDeleteProject={id => { void host.deleteProject(id); }}
          onRenameProject={(id, name) => { void host.renameProject(id, name); }}
          onImport={host.importBundle ? () => { if (!importBusy.current) importRef.current?.click(); } : undefined}
        />
        <span className={styles.nodeCount}>{tr('{count} 条', {count: projects.filter(p => p.status === 'active').length})}</span>
        <div className={styles.mapDocTabs}>
          <button className={`${styles.mapDocTab} ${rightView === 'map' ? styles.mapDocTabActive : ''}`} onClick={() => setRightView('map')} title={tr('思维脉络：判断的导航图')}>Map</button>
          <button className={`${styles.mapDocTab} ${rightView === 'doc' ? styles.mapDocTabActive : ''}`} onClick={() => setRightView('doc')} title={tr('白盒文档：每条判断的完整表述（可编辑、可带走）；图是它的目录')}>Doc</button>
          {showLogTab && <button className={`${styles.mapDocTab} ${rightView === 'source' ? styles.mapDocTabActive : ''}`} onClick={() => setRightView('source')} title={tr('Log：已接收的来源材料')}>Log</button>}
        </div>
      </div>
      {secondaryActions && <div className={styles.networkHeaderRight}>{secondaryActions}</div>}
    </div>
    {host.importBundle && <input hidden ref={importRef} type="file" accept=".json" aria-label={tr('导入脉络包')} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file || importBusy.current) return;
      if (file.size > 4 * 1024 * 1024) { setImportState('脉络包过大（上限 4 MB）'); return; }
      importBusy.current = true; setImportState('正在导入脉络…');
      void file.text().then(text => host.importBundle!(JSON.parse(text))).then(() => setImportState('已导入为新脉络。'), error => setImportState(error instanceof Error ? error.message : '导入失败')).finally(() => { importBusy.current = false; });
    }} />}
    {importState && <div role="status" style={{ padding: '8px 16px', fontSize: 12 }}>{tr(importState)}<button onClick={() => setImportState('')} aria-label={tr('关闭导入提示')}> × </button></div>}
    <div className={styles.networkContent}>
      <div className={styles.networkContentInner}>
        {rightView === 'doc' ? <WhiteboxDocPanel /> : rightView === 'source' ? <LedgerSourcePanel /> : <ThinkingMapPanel />}
      </div>
    </div>
  </div>;
}
