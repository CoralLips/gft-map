import { useEffect, useState } from 'react';
import { useT } from '../../../src/i18n';
import { LocalDialog } from './ConnectionManager';
import type { createLocalRuntime } from './localRuntime';

type Candidate = {
  agent: string;
  status: string;
  model?: string;
  effort?: string;
  modelName?: string;
  modelSource?: string;
  /** Models this agent offers; empty choice means the vendor's recommended one. */
  models?: Array<{ value: string; name: string; description?: string }>;
  error?: string;
};
const names: Record<string, string> = {
  'codex-acp': 'Codex',
  'claude-acp': 'Claude Code',
};
const available = (item?: Candidate) => item?.status === 'ready' || item?.status === 'running';
// Results outlive the dialog, so reopening it shows them in the first frame.
const remembered: Record<string, Candidate> = {};

export function ExecutorDialog({
  runtime,
  current,
  currentStatus,
  busy,
  onChanged,
  onClose,
}: {
  runtime: ReturnType<typeof createLocalRuntime>;
  current: string | null;
  /** The running executor's own check, known before the dialog opens. */
  currentStatus?: Omit<Candidate, 'agent'>;
  busy: boolean;
  onChanged(): Promise<void>;
  onClose(): void;
}) {
  const tr = useT();
  const currentChoice = current?.endsWith('-acp') ? current : `${current || 'codex'}-acp`;
  // Start from what is already known; each agent's fresh answer replaces it on arrival.
  const [candidates, setCandidates] = useState<Record<string, Candidate>>(() => {
    const live = currentStatus && { ...currentStatus, agent: currentChoice };
    return live && available(live) ? { ...remembered, [currentChoice]: live } : { ...remembered };
  });
  const [selected, setSelected] = useState(currentChoice);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const pickOf = (agent: string) =>
    picks[agent] ??
    (candidates[agent]?.modelSource === 'chosen' ? candidates[agent]?.model || '' : '');
  const [refresh, setRefresh] = useState(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const checking = Object.keys(names).some(agent => !candidates[agent]);
  useEffect(() => {
    const controller = new AbortController();
    const settle = (agent: string, item: Candidate) => {
      if (controller.signal.aborted) return;
      remembered[agent] = item;
      setCandidates(items => ({ ...items, [agent]: item }));
    };
    if (refresh) setCandidates({});
    setError('');
    for (const agent of Object.keys(names))
      void runtime
        .request<Candidate>(
          `/api/runtime/executors?agent=${agent}${refresh ? '&refresh=1' : ''}`,
          undefined,
          controller.signal,
        )
        .then(item => settle(agent, item))
        .catch(error => settle(agent, { agent, status: 'unavailable', error: error.message }));
    return () => controller.abort();
  }, [runtime, refresh]);
  const choose = async () => {
    setApplying(true);
    setError('');
    try {
      await runtime.request('/api/runtime/executor', {
        agent: selected,
        model: pickOf(selected) || null,
      });
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
          const candidate = candidates[agent];
          const ready = available(candidate);
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
                  {!candidate ? tr('正在检查…') : ready ? tr('连接检查通过') : tr('暂不可用')}
                  {ready && candidate?.model
                    ? ` · ${candidate.modelName || (candidate.model === 'default' ? tr('默认模型') : candidate.model)}`
                    : ''}
                  {ready && candidate?.effort
                    ? ` · ${candidate.effort === 'auto' ? tr('默认强度') : candidate.effort}`
                    : ''}
                </small>
                {candidate?.error && (
                  <small className="gft-local-error">{tr(candidate.error)}</small>
                )}
                {agent === selected && ready && !!candidate.models?.length && (
                  <select
                    aria-label={tr('模型')}
                    value={pickOf(agent)}
                    disabled={applying || busy}
                    onChange={event =>
                      setPicks(items => ({ ...items, [agent]: event.target.value }))
                    }
                  >
                    <option value="">{tr('推荐模型')}</option>
                    {candidate.models
                      .filter(item => item.value !== 'default')
                      .map(item => (
                        <option key={item.value} value={item.value}>
                          {item.value === item.name ? item.name : `${item.name}（${item.value}）`}
                        </option>
                      ))}
                  </select>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <p className="gft-local-note">
        {tr(
          '默认采用厂商推荐的模型，也可以选别的；思考强度始终用该模型的默认值，不沿用个人调高的配置。',
        )}
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
          disabled={applying || busy || !available(candidates[selected])}
          onClick={() => void choose()}
        >
          {tr(applying ? '正在切换…' : '使用此 Agent')}
        </button>
      </div>
    </LocalDialog>
  );
}
