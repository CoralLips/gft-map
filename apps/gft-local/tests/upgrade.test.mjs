import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {upgradeSkill} from '../upgrade.mjs';

test('升级整目录替换、留下回退包、数据不变；损坏包和错误端口不会改旧安装',async()=>{
  const workspace= fileURLToPath(new URL('../.data/',import.meta.url));await mkdir(workspace,{recursive:true});
  const root=await mkdtemp(path.join(workspace,'gft-upgrade-test-'));
  const directory=path.join(root,'installed'),dataDirectory=path.join(root,'data');
  const service=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');});
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
  const port=service.address().port;
  try {
    await mkdir(path.join(directory,'scripts'),{recursive:true});await mkdir(dataDirectory);
    await writeFile(path.join(directory,'SKILL.md'),'---\nname: gft-map\n---\nold');
    await writeFile(path.join(directory,'scripts/cli.mjs'),'old');await writeFile(path.join(directory,'obsolete.js'),'stale');
    await writeFile(path.join(dataDirectory,'private.json'),'keep all my edits');
    const source=path.join(root,'source/gft-map');await mkdir(path.join(source,'scripts/dist'),{recursive:true});
    await writeFile(path.join(source,'SKILL.md'),'---\nname: gft-map\n---\nnew');
    await writeFile(path.join(source,'scripts/cli.mjs'),'console.log(JSON.stringify({version:"0.2.1"}))');
    await writeFile(path.join(source,'scripts/dist/version.json'),JSON.stringify({product:'gft-map',version:'0.2.1'}));
    const archivePath=path.join(root,'release.tar.gz');execFileSync('tar',['-czf',archivePath,'-C',path.dirname(source),'gft-map']);
    const archive=await readFile(archivePath),release={version:'0.2.1',archive,checksum:createHash('sha256').update(archive).digest('hex')};
    const options={directory,dataDirectory,url:`http://127.0.0.1:${port}`,loadRelease:async()=>release};
    await assert.rejects(upgradeSkill({...options,loadRelease:async()=>({...release,checksum:'0'.repeat(64)})}),/校验失败/);
    await assert.rejects(upgradeSkill(options),/停止旧版服务/);
    assert.equal(await readFile(path.join(directory,'obsolete.js'),'utf8'),'stale');
    await new Promise(resolve=>service.close(resolve));
    const result=await upgradeSkill(options);
    assert.equal(result.version,'0.2.1');assert.equal(result.restartRequired,true);
    await assert.rejects(access(path.join(directory,'obsolete.js')),{code:'ENOENT'});
    assert.equal(await readFile(path.join(result.backup,'obsolete.js'),'utf8'),'stale');
    assert.equal(await readFile(path.join(dataDirectory,'private.json'),'utf8'),'keep all my edits');
    assert.equal((await upgradeSkill(options)).updated,false);
    await assert.rejects(upgradeSkill({...options,dataDirectory:path.join(directory,'data')}),/数据目录/);
  } finally {
    service.close();
    assert.equal(path.dirname(root),path.resolve(workspace));assert.ok(path.basename(root).startsWith('gft-upgrade-test-'));
    await rm(root,{recursive:true,force:true});
  }
});
