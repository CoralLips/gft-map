import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail, homeDir, writeJsonAtomic } from './store.mjs';

const agents = new Set(['codex', 'claude', 'codex-acp', 'claude-acp']);
const file = () => path.join(homeDir(), 'executor.json');

function options(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  if (typeof value.binary === 'string' && value.binary) result.binary = value.binary;
  if (
    Array.isArray(value.prefixArgs) &&
    value.prefixArgs.every(item => typeof item === 'string' && !item.includes('\0'))
  )
    result.prefixArgs = [...value.prefixArgs];
  if (typeof value.model === 'string' && value.model) result.model = value.model;
  if (Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) result.timeoutMs = value.timeoutMs;
  return result;
}

function valid(value) {
  if (!value || typeof value !== 'object' || !agents.has(value.agent)) return null;
  const profiles = Object.fromEntries(
    [...agents]
      .filter(agent => value.profiles?.[agent])
      .map(agent => [agent, options(value.profiles[agent])]),
  );
  return {
    agent: value.agent,
    runnerOptions: options(value.runnerOptions),
    profiles,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
  };
}

export async function loadExecutorConfig() {
  try {
    return valid(JSON.parse(await readFile(file(), 'utf8')));
  } catch {
    return null;
  }
}

/** Saves the chosen executor and remembers each executor's options for later switches. */
export async function saveExecutorConfig({ agent, runnerOptions } = {}) {
  if (!agents.has(agent)) throw new Error('执行器配置无效');
  const previous = await loadExecutorConfig();
  const profiles = {
    ...previous?.profiles,
    ...(previous ? { [previous.agent]: previous.runnerOptions } : {}),
    [agent]: options(runnerOptions),
  };
  await writeJsonAtomic(file(), {
    agent,
    runnerOptions: options(runnerOptions),
    profiles,
    updatedAt: new Date().toISOString(),
  });
  return loadExecutorConfig();
}

const acpPrefix = agent => (agent === 'claude-acp' ? 'GFT_CLAUDE_ACP' : 'GFT_CODEX_ACP');

/** ACP adapter executable from GFT_CODEX_ACP_BIN / GFT_CLAUDE_ACP_BIN. */
export const acpBinary = agent => process.env[`${acpPrefix(agent)}_BIN`];

/** ACP adapter arguments from GFT_CODEX_ACP_ARGS / GFT_CLAUDE_ACP_ARGS (a JSON array). */
export function acpArguments(agent) {
  const name = `${acpPrefix(agent)}_ARGS`;
  if (!process.env[name]) return undefined;
  try {
    return JSON.parse(process.env[name]);
  } catch {
    throw fail(`${name} 必须是 JSON 字符串数组`);
  }
}

export { agents };

/**
 * An ACP executor keeps the model chosen for it in "AI 处理". A CLI selection keeps its
 * provider but becomes ACP without its old model override, and never reuses a CLI binary.
 */
export function defaultExecutor(saved) {
  const agent = saved?.agent?.endsWith('-acp') ? saved.agent : `${saved?.agent || 'codex'}-acp`;
  if (saved?.agent === agent) return { agent, runnerOptions: saved.runnerOptions || {} };
  const { timeoutMs } = saved?.runnerOptions || {};
  const profile = saved?.profiles?.[agent] || {};
  return {
    agent,
    runnerOptions: {
      ...(timeoutMs ? { timeoutMs } : {}),
      ...profile,
    },
  };
}
