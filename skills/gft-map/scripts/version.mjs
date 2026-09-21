import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const programDirectory = path.dirname(fileURLToPath(import.meta.url));
try {
  const marker=await readFile(path.join(programDirectory,'../.gft-updating'),'utf8');
  throw new Error(`GFT Map 更新尚未完成，请让 Agent 恢复完整安装后启动。备份：${JSON.parse(marker).backup}`);
} catch(error) {if(error.code!=='ENOENT') throw error;}
export const installationId = createHash('sha256').update(process.platform === 'win32' ? programDirectory.toLowerCase() : programDirectory).digest('hex');
export async function programVersion() {
  try { return JSON.parse(await readFile(path.join(programDirectory,'dist/version.json'),'utf8')).version; }
  catch { return 'development'; }
}
