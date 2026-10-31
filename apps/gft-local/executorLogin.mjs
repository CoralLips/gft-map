import { launch, stopTree } from './childProcess.mjs';
import { childEnvironment } from './claudeRunner.mjs';

/** Vendor-owned browser login. Never copy credentials or retain process output. */
export function createExecutorLogin(resolveCommand, timeoutMs = 180000) {
  let current = { status: 'idle' },
    child,
    timer,
    generation = 0;
  const snapshot = () => ({ ...current });
  const close = async (status = 'cancelled') => {
    generation++;
    clearTimeout(timer);
    const running = child;
    child = undefined;
    if (current.status === 'running') current = { ...current, status };
    if (running) await stopTree(running);
  };
  async function begin(agent) {
    if (current.status === 'running') return snapshot();
    if (!['claude-acp', 'codex-acp'].includes(agent)) throw new Error('未知 Agent');
    const attempt = ++generation;
    current = { agent, status: 'running' };
    try {
      const { binary, prefixArgs = [], authArgs = [] } = await resolveCommand(agent);
      if (generation !== attempt) return snapshot();
      const process = launch(
        { name: agent === 'claude-acp' ? 'Claude Code' : 'Codex' },
        binary,
        [...prefixArgs, ...authArgs, ...(agent === 'claude-acp' ? ['auth', 'login'] : ['login'])],
        { env: childEnvironment() },
      );
      child = process;
      // Both vendors open the browser themselves. Drain output (which may contain
      // authorization URLs); do not write it to logs or send credentials to the UI.
      process.stdout.resume();
      process.stderr.resume();
      process.stdin.on('error', () => {});
      const finish = status => {
        if (child !== process) return;
        clearTimeout(timer);
        child = undefined;
        current = { agent, status };
      };
      process.once('error', () => finish('failed'));
      process.once('close', code => finish(code === 0 ? 'completed' : 'failed'));
      timer = setTimeout(() => {
        void close('timeout');
      }, timeoutMs);
      timer.unref?.();
    } catch (error) {
      if (generation === attempt) current = { agent, status: 'failed' };
      throw error;
    }
    return snapshot();
  }
  return { begin, snapshot, close };
}
