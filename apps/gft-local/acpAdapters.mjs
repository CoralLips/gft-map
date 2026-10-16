import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  copyFile,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { homeDir, withRecordLock } from './store.mjs';

// Tested adapter releases. Upgrades are explicit, never an unpinned npx on each task.
export const adapterReleases = {
  'codex-acp': { name: '@agentclientprotocol/codex-acp', version: '1.12.0' },
  'claude-acp': { name: '@agentclientprotocol/claude-agent-acp', version: '0.78.0' },
};
const execute = promisify(execFile);
const pending = new Map();
const exists = file =>
  access(file).then(
    () => true,
    () => false,
  );

export async function adapterCacheStamp(agent) {
  return createHash('sha256')
    .update(await readFile(new URL(`./adapter-locks/${agent}/package-lock.json`, import.meta.url)))
    .digest('hex');
}
async function installed(directory, release, stamp) {
  const base = path.join(directory, 'node_modules', release.name);
  const manifest = await readFile(path.join(base, 'package.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const entry = path.join(base, 'dist/index.js');
  const actual = await readFile(path.join(directory, 'gft-lock.sha256'), 'utf8').catch(() => '');
  return manifest?.version === release.version && actual === stamp && (await exists(entry))
    ? entry
    : null;
}

async function npmEntry() {
  const directories = [
    path.dirname(process.execPath),
    ...(process.env.PATH || process.env.Path || '').split(path.delimiter),
  ];
  const candidates = directories.flatMap(directory => [
    path.resolve(directory, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ]);
  if (process.env.npm_execpath) candidates.unshift(process.env.npm_execpath);
  for (const candidate of candidates)
    if (candidate.endsWith('npm-cli.js') && (await exists(candidate))) return candidate;
  throw new Error(
    '自动准备 Agent 连接需要 Node.js 22 或更新版本及 npm，请安装后重新打开 GFT Map。',
  );
}

/** Install beside the data, in a new directory; only a complete install becomes active. */
export function ensureAdapter(agent) {
  const release = adapterReleases[agent];
  if (!release) throw new Error('未知 Agent 连接');
  const target = path.resolve(homeDir(), 'adapters', `${agent}-${release.version}`);
  if (pending.has(target)) return pending.get(target);
  const promise = (async () => {
    if (Number(process.versions.node.split('.')[0]) < 22)
      throw new Error('Agent 连接需要 Node.js 22 或更新版本，请升级后重新打开 GFT Map。');
    const stamp = await adapterCacheStamp(agent);
    let entry = await installed(target, release, stamp);
    if (!entry) {
      const npm = await npmEntry();
      await mkdir(path.dirname(target), { recursive: true });
      const staging = await mkdtemp(`${target}-preparing-`);
      try {
        for (const name of ['package.json', 'package-lock.json'])
          await copyFile(
            new URL(`./adapter-locks/${agent}/${name}`, import.meta.url),
            path.join(staging, name),
          );
        await execute(
          process.execPath,
          [
            npm,
            'ci',
            '--ignore-scripts',
            '--prefix',
            staging,
            '--omit=dev',
            '--no-audit',
            '--no-fund',
          ],
          {
            windowsHide: true,
            timeout: 180000,
            maxBuffer: 1024 * 1024,
          },
        );
        await writeFile(path.join(staging, 'gft-lock.sha256'), stamp);
        if (!(await installed(staging, release, stamp))) throw new Error('安装结果不完整');
        await withRecordLock(
          'adapters',
          `${agent}-${release.version.replaceAll('.', '-')}`,
          async () => {
            if (await installed(target, release, stamp)) return;
            const damaged = `${target}-damaged-${randomUUID()}`;
            const root = path.resolve(homeDir(), 'adapters');
            if ([target, staging, damaged].some(p => path.dirname(p) !== root))
              throw new Error('连接组件目录无效');
            const previous = await exists(target);
            if (previous) await rename(target, damaged);
            try {
              await rename(staging, target);
            } catch (error) {
              if (previous) await rename(damaged, target);
              throw error;
            }
          },
        );
        entry = await installed(target, release, stamp);
      } catch (error) {
        const category = /EACCES|EPERM/.test(String(error.stderr || error.code))
          ? '权限不足'
          : /ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/.test(
                String(error.stderr || error.code),
              )
            ? '网络连接失败'
            : '安装未完成';
        const logfile = path.join(homeDir(), 'adapters', 'install-errors.log');
        // Keep npm codes and ordinary diagnostics, never credentials or URL userinfo.
        const detail = String(error.stderr || error.message)
          .slice(-6000)
          .replace(/(?:https?:\/\/)[^\s]+/g, '[URL omitted]')
          .replace(/(?:token|password|authorization|secret|_auth)[^\n]*/gi, '[credential omitted]')
          .replace(/\b(?:npm_|gh[pousr]_|sk-)[A-Za-z0-9_-]+/g, '[credential omitted]');
        if ((await readFile(logfile).catch(() => Buffer.alloc(0))).length > 1024 * 1024)
          await rename(logfile, `${logfile}.previous`).catch(() => {});
        await appendFile(
          logfile,
          `${new Date().toISOString()} ${agent} code=${error.code || 'unknown'}\n${detail}\n`,
          { mode: 0o600 },
        );
        throw new Error(
          `Agent 连接组件${category}。诊断日志：${logfile}。现有数据与 Agent 选择已保留。`,
        );
      } finally {
        // mkdtemp is rooted immediately next to the checked cache target.
        if (
          path.dirname(staging) === path.dirname(target) &&
          staging.startsWith(`${target}-preparing-`)
        )
          await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    }
    return { binary: process.execPath, prefixArgs: [entry] };
  })().finally(() => pending.delete(target));
  pending.set(target, promise);
  return promise;
}
