import { useEffect, useRef, useState } from 'react';
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
  errorCode?: string;
  authenticated?: boolean | null;
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
    return live ? { ...remembered, [currentChoice]: live } : { ...remembered };
  });
  const [selected, setSelected] = useState(currentChoice);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const pickOf = (agent: string) =>
    picks[agent] ??
    (candidates[agent]?.modelSource === 'chosen' ? candidates[agent]?.model || '' : '');
  const [refresh, setRefresh] = useState(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [login, setLogin] = useState<{ agent?: string; status: string }>({ status: 'idle' });
  const lastLoginStatus = useRef('idle');
  const loginMutation = useRef(0);
  const changingLogin = useRef(false);
  useEffect(() => {
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling || changingLogin.current) return;
      polling = true;
      const generation = loginMutation.current;
      try {
        const next = await runtime.request<{ agent?: string; status: string }>(
          '/api/runtime/executor-login',
        );
        if (!alive || generation !== loginMutation.current) return;
        if (lastLoginStatus.current === 'running' && next.status === 'completed')
          setRefresh(value => value + 1);
        lastLoginStatus.current = next.status;
        setLogin(next);
      } catch {
        /* A temporary disconnect is handled by the normal connection state. */
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runtime]);
  const authorize = async (agent: string) => {
    loginMutation.current++;
    changingLogin.current = true;
    setLogin({ agent, status: 'running' });
    lastLoginStatus.current = 'running';
    setError('');
    try {
      setLogin(await runtime.request('/api/runtime/executor-login', { agent }));
    } catch (error) {
      setLogin({ agent, status: 'failed' });
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      changingLogin.current = false;
    }
  };
  const cancelLogin = async () => {
    loginMutation.current++;
    changingLogin.current = true;
    setLogin(value => ({ ...value, status: 'cancelled' }));
    try {
      setLogin(await runtime.request('/api/runtime/executor-login', { cancel: true }));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      changingLogin.current = false;
    }
  };
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
          '页面中的更新和整理交给所选 Agent，使用它在本机登录的账号或 API 配置所对应的额度。聊天来源不会改变这个选择。',
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
                  {!candidate
                    ? tr('正在检查…')
                    : ready
                      ? tr(
                          candidate.authenticated === true
                            ? '已检测到登录'
                            : '组件已连接，授权待确认',
                        )
                      : candidate.authenticated === false
                        ? tr('需要授权登录')
                        : tr('暂不可用')}
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
                {candidate?.authenticated === false && (
                  <button
                    type="button"
                    disabled={busy || login.status === 'running'}
                    onClick={event => {
                      event.preventDefault();
                      void authorize(agent);
                    }}
                  >
                    {tr('授权登录')}
                  </button>
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
      {login.status === 'running' && (
        <p role="status" className="gft-local-note">
          {tr('已启动 Agent 登录，请在浏览器完成授权。若浏览器没有打开，可在终端运行下方命令。')}
          <code>{login.agent === 'claude-acp' ? 'claude auth login' : 'codex login'}</code>
          <button onClick={() => void cancelLogin()}>{tr('取消登录')}</button>
        </p>
      )}
      {['failed', 'timeout'].includes(login.status) && (
        <p role="alert" className="gft-local-error">
          {tr('授权未完成。请重试，或在终端运行下方命令后重新检查。')}
          <code>{login.agent === 'claude-acp' ? 'claude auth login' : 'codex login'}</code>
        </p>
      )}
      {login.status === 'completed' && (
        <p role="status">{tr('授权流程已结束，请以重新检查的登录状态为准。')}</p>
      )}
      <p className="gft-local-note">
        {tr(
          '默认采用厂商推荐的模型，也可以选别的；思考强度始终用该模型的默认值，不沿用个人调高的配置。',
        )}
        {tr(
          '检查本机执行器及登录状态，不调用模型；额度、网络和模型权限仍以实际任务结果为准。失败不会自动换用另一家。',
        )}
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
            applying || busy || login.status === 'running' || !available(candidates[selected])
          }
          onClick={() => void choose()}
        >
          {tr(applying ? '正在切换…' : '使用此 Agent')}
        </button>
      </div>
    </LocalDialog>
  );
}
