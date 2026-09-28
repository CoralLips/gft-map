import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { homeDir } from './store.mjs';

const agents = new Set(['codex', 'codex-acp', 'claude-acp']);
const file = () => path.join(homeDir(), 'executor.json');

function options(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  if (typeof value.binary === 'string' && value.binary) result.binary = value.binary;
  if (Array.isArray(value.prefixArgs) && value.prefixArgs.every(item => typeof item === 'string' && !item.includes('\0'))) result.prefixArgs = [...value.prefixArgs];
  if (typeof value.model === 'string' && value.model) result.model = value.model;
  if (Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) result.timeoutMs = value.timeoutMs;
  return result;
}

function valid(value) {
  if (!value || typeof value !== 'object' || !agents.has(value.agent)) return null;
  return { agent: value.agent, runnerOptions: options(value.runnerOptions), updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined };
}

export async function loadExecutorConfig() {
  try { return valid(JSON.parse(await readFile(file(), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; return null; }
}

export async function saveExecutorConfig({ agent, runnerOptions } = {}) {
  if (!agents.has(agent)) throw new Error('执行器配置无效');
  const target = file();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ agent, runnerOptions: options(runnerOptions), updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }
  return loadExecutorConfig();
}

export { agents };
