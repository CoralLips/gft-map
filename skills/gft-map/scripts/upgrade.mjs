import {readFile,writeFile,mkdir,mkdtemp,rename,lstat,realpath,readdir,rm,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (parent,child) => {const relative=path.relative(parent,child);return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));};
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function move(from,to) {
  for(let attempt=0;;attempt++) {
    try {await rename(from,to);return;}
    catch(error) {if(attempt>=3 || !['EPERM','EACCES','EBUSY'].includes(error.code)) throw error;await delay(200);}
  }
}

async function download(url,limit) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:' || !['api.github.com','github.com'].includes(parsed.hostname)) throw new Error('更新地址必须来自官方 GitHub Release。');
  const response=await fetch(url,{headers:{'User-Agent':'gft-map-updater'},signal:AbortSignal.timeout(90000)});
  if(!response.ok) throw new Error(`下载更新失败（HTTP ${response.status}），旧版本未改动。`);
  let length=0;const chunks=[];
  for await(const chunk of response.body) {length+=chunk.length;if(length>limit) throw new Error('更新包大小异常，旧版本未改动。');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function officialRelease() {
  const release=JSON.parse(await download('https://api.github.com/repos/CoralLips/gft-map/releases/latest',1024*1024));
  const version=release.tag_name?.replace(/^v/,'');
  if(!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('最新正式版本号无效。');
  const name=`gft-map-${version}.tar.gz`;
  const asset=release.assets?.find(a=>a.name===name), sums=release.assets?.find(a=>a.name==='SHA256SUMS');
  if(!asset || !sums) throw new Error('该版本尚无完整安装包，请稍后重试。');
  const checksum=(await download(sums.browser_download_url,65536)).toString('utf8').split(/\r?\n/).find(line=>line.trim().endsWith(`  ${name}`))?.split(/\s+/)[0];
  if(!/^[a-f0-9]{64}$/i.test(checksum || '')) throw new Error('更新包缺少有效校验值。');
  return {version,checksum,archive:await download(asset.browser_download_url,128*1024*1024)};
}

async function validateTree(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('更新包含不支持的文件类型。');
    if(entry.isDirectory()) await validateTree(path.join(directory,entry.name));
  }
}

async function replaceContents(directory,source,backup) {
  // Windows hosts can keep the Skill directory itself open. The service is
  // already stopped; block new launches until the entire replacement finishes.
  const marker=path.join(directory,'.gft-updating');
  await writeFile(marker,JSON.stringify({backup}));
  for(const name of await readdir(directory)) {
    if(name==='.gft-updating') continue;
    const target=path.resolve(directory,name);
    if(path.dirname(target)!==directory) throw new Error('非法程序路径。');
    await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
  await cp(source,directory,{recursive:true});
  await rm(marker);
}

/** Only installed Skill directories are replaced. User data and source checkouts are never overlaid. */
export async function upgradeSkill({directory,dataDirectory,url='http://127.0.0.1:4317',loadRelease=officialRelease}={}) {
  directory=path.resolve(directory);
  const stat=await lstat(directory);
  if(stat.isSymbolicLink() || !stat.isDirectory() || path.relative(directory,await realpath(directory))) throw new Error('安装目录是链接；请在实际安装目录执行更新。');
  if(inside(directory,path.resolve(dataDirectory))) throw new Error('数据目录位于程序目录内，请先移出并设置 GFT_LOCAL_HOME，再更新。');
  const skill=await readFile(path.join(directory,'SKILL.md'),'utf8');
  if(!/^name:\s*gft-map\s*$/m.test(skill)) throw new Error('这不是 GFT Map Skill 安装目录；源码请通过 Git 更新。');
  await lstat(path.join(directory,'scripts/cli.mjs'));
  const lock=path.join(path.dirname(directory),`.${path.basename(directory)}-upgrade-lock`);
  try {await mkdir(lock);} catch(error) {if(error.code==='EEXIST') throw new Error('另一项更新正在进行，或上次更新被中断；请让 Agent 核对恢复后再更新。');throw error;}
  try {
  const release=await loadRelease();
  if(!/^\d+\.\d+\.\d+$/.test(release.version) || digest(release.archive)!==release.checksum) throw new Error('更新包校验失败，旧版本未改动。');
  const installed=await readFile(path.join(directory,'scripts/dist/version.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(installed?.version===release.version) return {updated:false,version:release.version,message:'已是最新正式版。'};
  if(installed?.version?.split('.').map(Number).some((n,i,a)=>n>Number(release.version.split('.')[i]) && a.slice(0,i).every((v,j)=>v===Number(release.version.split('.')[j])))) throw new Error('已安装版本比最新正式版更新，未降级。');
  const parent=path.dirname(directory), work=await mkdtemp(path.join(parent,'.gft-map-upgrade-'));
  const backup=path.join(work,'previous'), next=path.join(work,'gft-map');
  let moved=false,committed=false;
  try {
    const archive=path.join(work,'release.tar.gz');await writeFile(archive,release.archive);
    const {stdout:listing}=await exec('tar',['-tzf',archive],{maxBuffer:8*1024*1024,windowsHide:true});
    const entries=listing.trim().split(/\r?\n/);
    if(!entries.length || entries.some(name=>!/^gft-map(?:\/|$)/.test(name) || name.includes('\\') || name.includes(':') || name.split('/').includes('..'))) throw new Error('更新包目录结构不正确。');
    const {stdout:types}=await exec('tar',['-tvzf',archive],{maxBuffer:8*1024*1024,windowsHide:true});
    if(types.trim().split(/\r?\n/).some(line=>!['-','d'].includes(line[0]))) throw new Error('更新包不能包含链接或特殊文件。');
    await exec('tar',['-xzf',archive,'-C',work],{windowsHide:true});await validateTree(next);
    const info=JSON.parse(await readFile(path.join(next,'scripts/dist/version.json'),'utf8'));
    if(info.product!=='gft-map' || info.version!==release.version) throw new Error('更新包版本不一致。');
    const probe=await exec(process.execPath,[path.join(next,'scripts/cli.mjs'),'version'],{windowsHide:true,timeout:15000});
    if(JSON.parse(probe.stdout).version!==release.version) throw new Error('新版程序启动检查失败。');
    // Stop only a service that proves it was started from this installation.
    const base=new URL(url);
    if(!['127.0.0.1','localhost'].includes(base.hostname) || base.protocol!=='http:') throw new Error('只可更新本机服务。');
    let runtime;
    try {const response=await fetch(new URL('/api/runtime',base),{signal:AbortSignal.timeout(2500)});if(!response.ok) throw new Error('本地端口正被其他服务使用。');runtime=await response.json();}
    catch(error) {if(error.cause?.code!=='ECONNREFUSED') throw error;}
    if(runtime) {
      const scripts=path.join(directory,'scripts'),id=digest(process.platform==='win32'?scripts.toLowerCase():scripts);
      if(runtime.product!=='gft-map' || runtime.installationId!==id) throw new Error('请先让 Agent 确认并停止旧版服务，再更新；不会停止其他安装或未知进程。');
      const response=await fetch(new URL('/api/upgrade/prepare',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({installationId:id}),signal:AbortSignal.timeout(10000)});
      if(!response.ok) throw new Error((await response.json()).error || '旧服务尚未停止。');
      for(let i=0;i<40;i++) {
        try {await fetch(new URL('/api/runtime',base),{signal:AbortSignal.timeout(1000)});}
        catch(error) {if(error.cause?.code==='ECONNREFUSED') break;throw error;}
        if(i===39) throw new Error('旧服务尚未退出，未替换程序。');await delay(100);
      }
    }
    try {await move(directory,backup);moved=true;}
    catch(error) {
      if(!['EPERM','EACCES','EBUSY'].includes(error.code)) throw error;
      await cp(directory,backup,{recursive:true,errorOnExist:true,force:false});moved=true;
      try {await replaceContents(directory,next,backup);}
      catch(failure) {await replaceContents(directory,backup,backup);moved=false;throw failure;}
      committed=true;
    }
    if(!committed) try {await move(next,directory);} catch(error) {await move(backup,directory);moved=false;throw error;}
    committed=true;
    return {updated:true,version:release.version,backup,dataDirectory,restartRequired:true,agent:runtime?.agent ?? null,
      message:'程序已整目录更新，数据未改动。用原执行器参数重新启动面板，并核对 /api/runtime 的版本。'};
  } finally {
    // Retain the previous complete installation for rollback. Only our own
    // staging directory is removed on failure, after verifying its parent.
    if(!committed && !moved && path.dirname(work)===parent && path.basename(work).startsWith('.gft-map-upgrade-')) await rm(work,{recursive:true,force:true});
  }
  } finally {await rm(lock,{recursive:true,force:true});}
}
