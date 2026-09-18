import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

/** Explicit project installation only; preserve all unrelated permissions and hooks. */
export async function installChangeHook({provider,project,script = fileURLToPath(new URL('./change-hook.mjs',import.meta.url))}) {
  if (!['codex','claude'].includes(provider) || !project) throw new Error('请指定 --provider codex|claude 和 --project 工作目录');
  const root = path.resolve(project);
  const hookPath = path.resolve(script).replaceAll('\\','/');
  // Keep command quoting predictable in both POSIX shells and Windows shells.
  if (/["`$%!\r\n]/.test(hookPath)) throw new Error('安装路径含 shell 特殊字符，请使用不含这些字符的安装目录');
  const destination = path.join(root,provider === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json');
  let before;
  try { before = await readFile(destination,'utf8'); } catch(error) { if(error.code !== 'ENOENT') throw error; }
  const config = before ? JSON.parse(before) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.hooks && (typeof config.hooks !== 'object' || Array.isArray(config.hooks)))) throw new Error('现有 Hook 配置格式无效，未覆盖');
  const command = `node "${hookPath}" --provider ${provider}`;
  const groups = config.hooks?.UserPromptSubmit || [];
  if (!Array.isArray(groups)) throw new Error('现有 UserPromptSubmit 配置格式无效，未覆盖');
  if (groups.some(group=>group.hooks?.some(hook=>hook.command === command))) return {path:destination,changed:false};
  config.hooks = {...config.hooks,UserPromptSubmit:[...groups,{hooks:[{type:'command',command,timeout:3,...(provider === 'codex' ? {additionalContextLimit:10000} : {})}]}]};
  await mkdir(path.dirname(destination),{recursive:true});
  // A one-time sibling backup is created before the reviewed replacement.
  if (before) await writeFile(destination+'.gft-map-backup',before,{flag:'wx'}).catch(error=>{if(error.code !== 'EEXIST') throw error;});
  const temporary = destination+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,JSON.stringify(config,null,2)+'\n','utf8');
  await rename(temporary,destination);
  return {path:destination,changed:true,note:provider === 'codex' ? '需在 Codex /hooks 审阅并信任此 Hook；未信任不会执行。原会话可能需重载配置。' : '在 Claude Code 中重载配置后生效；可在 /hooks 检查。'};
}
