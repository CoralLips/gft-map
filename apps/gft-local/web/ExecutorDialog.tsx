import { useEffect, useState } from 'react';
import { useT } from '../../../src/i18n';
import { LocalDialog } from './ConnectionManager';
import type { createLocalRuntime } from './localRuntime';

type Candidate = {
  agent: string;
  status: string;
  model?: string;
  effort?: string;
  modelSource?: string;
  error?: string;
};
const names: Record<string, string> = {
  'codex-acp': 'Codex',
  'claude-acp': 'Claude Code',
};
const available = (item?: Candidate) => item?.status === 'ready' || item?.status === 'running';

export function ExecutorDialog({
  runtime,
  current,
  busy,
  onChanged,
  onClose,
}: {
  runtime: ReturnType<typeof createLocalRuntime>;
  current: string | null;
  busy: boolean;
  onChanged(): Promise<void>;
  onClose(): void;
}) {
  const tr = useT();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const currentChoice = current?.endsWith('-acp') ? current : `${current || 'codex'}-acp`;
  const [selected, setSelected] = useState(currentChoice);
  const [checking, setChecking] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setError('');
    void runtime
      .request<Candidate[]>('/api/runtime/executors', undefined, controller.signal)
      .then(items => {
        if (!controller.signal.aborted) setCandidates(items);
      })
      .catch(error => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [runtime, refresh]);
  const choose = async () => {
    setApplying(true);
    setError('');
    try {
      await runtime.request('/api/runtime/executor', { agent: selected });
      await onChanged();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };
  return (
    <LocalDialog title={tr('AI 处理')} onClose={onClose} closeDisabled={applying}>
      <p className="gft-local-note">
        {tr(
          '页面中的更新、整理和重画交给所选 Agent，使用它在本机登录的账号或 API 配置所对应的额度。聊天来源不会改变这个选择。',
        )}
      </p>
      <div
        className="gft-local-executor-options"
        role="radiogroup"
        aria-label={tr('处理 Agent')}
        aria-busy={checking}
      >
        {Object.entries(names).map(([agent, name]) => {
          const candidate = candidates.find(item => item.agent === agent);
          const ready = !checking && available(candidate);
          return (
            <label key={agent} className="gft-local-executor-option">
              <input
                type="radio"
                name="executor"
                value={agent}
                checked={selected === agent}
                disabled={applying || busy || !ready}
                onChange={() => setSelected(agent)}
              />
              <span>
                <strong>
                  {name}
                  {agent === currentChoice ? ` · ${tr('当前')}` : ''}
                </strong>
                <small>
                  {checking ? tr('正在检查…') : ready ? tr('连接检查通过') : tr('暂不可用')}
                  {ready && candidate?.model
                    ? ` · ${candidate.model === 'default' ? tr('默认模型') : candidate.model}`
                    : ''}
                  {ready && candidate?.effort
                    ? ` · ${candidate.effort === 'auto' ? tr('默认强度') : candidate.effort}`
                    : ''}
                </small>
                {!checking && candidate?.error && (
                  <small className="gft-local-error">{tr(candidate.error)}</small>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <p className="gft-local-note">
        {tr('采用厂商推荐的默认模型和默认强度，不沿用个人调高的配置。')}
        {tr('只列出当前支持的执行器。连接检查不运行模型；实际调用失败会提示，不会自动换用另一家。')}
      </p>
      <p className="gft-local-note">
        {tr(
          '在聊天中直接让 Agent 使用 Skill，则由那场聊天的 Agent 完成推理；这里控制的是页面按钮。',
        )}
      </p>
      {busy && (
        <p role="status" className="gft-local-note">
          {tr('有任务正在处理，完成或停止后可切换。')}
        </p>
      )}
      {error && (
        <p role="alert" className="gft-local-error">
          {tr(error)}
        </p>
      )}
      <div className="gft-local-dialog-actions">
        <button disabled={checking || applying} onClick={() => setRefresh(value => value + 1)}>
          {tr('重新检查')}
        </button>
        <button
          className="gft-local-primary"
          disabled={
            checking ||
            applying ||
            busy ||
            !available(candidates.find(item => item.agent === selected))
          }
          onClick={() => void choose()}
        >
          {tr(applying ? '正在切换…' : '使用此 Agent')}
        </button>
      </div>
    </LocalDialog>
  );
}
