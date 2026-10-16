import { spawn } from 'node:child_process';
import path from 'node:path';

/** An Error carrying a RUNNER_* code and, when known, the execution metrics so far. */
export const errorOf = (code, message, execution) =>
  Object.assign(new Error(message), { code, ...(execution ? { execution } : {}) });

/** The tail of a process message, without terminal colors or credentials. */
export const brief = value =>
  String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]+/g, '[redacted]')
    .trim()
    .slice(-1200);

/** Stops the owned process tree, including wrappers and descendants holding pipes. */
export async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    // The child leads its own process group; descendants may outlive it.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGKILL');
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const killer = spawn(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    const timer = setTimeout(() => {
      killer.kill();
      child.kill();
      resolve();
    }, 4000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    killer.once('error', () => {
      child.kill();
      done();
    });
    // A successful taskkill can finish before Node receives the child's exit
    // event. Killing that already-terminated Windows process again emits EPERM.
    killer.once('close', code => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
      done();
    });
  });
}

/**
 * Starts a native CLI. `cli` names it in messages: { name, binaryEnv, executable }.
 * Shell scripts (.cmd/.bat/.ps1) are refused: they cannot be spawned safely without a shell.
 */
export function launch(cli, binary, args, { cwd, env } = {}) {
  if (/\.(?:cmd|bat|ps1)$/i.test(binary))
    throw errorOf(
      'RUNNER_START',
      `请把 ${cli.binaryEnv} 指向 ${cli.name} 的原生可执行文件（Windows 使用 ${cli.executable}），不要使用 shell 脚本。`,
    );
  return spawn(binary, args, {
    cwd,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Runs a short CLI command (version, help, login status) and collects its output. */
export async function inspect(cli, binary, args, { env, timeoutMs = 10000 } = {}) {
  const child = launch(cli, binary, args, { env });
  let stdout = '';
  let stderr = '';
  let stopping;
  const timer = setTimeout(() => {
    stopping = stopTree(child);
  }, timeoutMs);
  child.stdout.on('data', chunk => {
    stdout = (stdout + chunk).slice(-200000);
  });
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdin.on('error', () => {});
  child.stdin.end();
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (stopping) {
      await stopping;
      throw errorOf('RUNNER_CHECK', `${cli.name} 启动检查超时，请确认命令可以正常运行。`);
    }
    return { code, stdout, stderr };
  } catch (error) {
    if (error.code?.startsWith('RUNNER_')) throw error;
    throw errorOf(
      'RUNNER_START',
      `无法启动 ${cli.name}（${error.code || '未知错误'}）。请安装 CLI，或设置 ${cli.binaryEnv} 指向 ${cli.executable}。`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves with the exit code once the process and its pipes have closed. */
export const exitCodeOf = child =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

/**
 * Stops `child` on cancellation, service shutdown or timeout, keeping the first
 * reason. `settle()` waits for the tree to stop and throws that reason.
 */
export function supervise(child, { signal, timeoutMs, label }) {
  let interrupted = null;
  let stopping = null;
  const stop = (code, message) => {
    if (interrupted) return;
    interrupted = { code, message };
    stopping = stopTree(child);
  };
  const abort = () =>
    signal?.reason === 'shutdown'
      ? stop('RUNNER_SHUTDOWN', '本地服务已停止，当前内容保留。')
      : stop('RUNNER_CANCELLED', '任务已取消，当前内容保留。');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const seconds = Math.ceil(timeoutMs / 1000);
  const timer = setTimeout(
    () => stop('RUNNER_TIMEOUT', `${label} 执行超过 ${seconds} 秒，已停止，当前内容保留。`),
    timeoutMs,
  );
  return {
    stop,
    stopped: () => !!interrupted,
    async settle() {
      if (stopping) await stopping;
      if (interrupted) throw errorOf(interrupted.code, interrupted.message);
    },
    release() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

/** The error a run reports: RUNNER_* failures as they are, anything else as an unfinished run. */
export function runnerFailure(error, execution, child, label) {
  const known = error.code?.startsWith('RUNNER_');
  execution.exitCode = child.exitCode;
  execution.errorCode = known ? error.code : 'RUNNER_START';
  return errorOf(
    execution.errorCode,
    known
      ? error.message
      : `${label} 执行未完成（${error.code || '未知错误'}）：${brief(error.message)}`,
    execution,
  );
}
