import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

const source = path.resolve(process.argv[2] || 'skills/gft-map');
const sandbox = await mkdtemp(path.join(tmpdir(), 'gft-map-install-'));
const installed = path.join(sandbox, 'gft-map');
let child;
try {
  await cp(source, installed, { recursive: true });
  const skill = await readFile(path.join(installed, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: gft-map\r?\n/);
  for (const file of ['scripts/cli.mjs', 'scripts/dist/core.mjs', 'scripts/dist/web/app.js', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    assert.ok((await stat(path.join(installed, file))).size > 0, file);
  }
  const env = { ...process.env, GFT_LOCAL_HOME: path.join(sandbox, 'data'), GFT_SMOKE_SKILL: installed };
  // Run outside either source checkout, without npm install or a model call.
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {pathToFileURL} from 'node:url';
    import path from 'node:path';
    const {startServer} = await import(pathToFileURL(path.join(process.env.GFT_SMOKE_SKILL, 'scripts/server.mjs')));
    const server = await startServer({port:0});
    console.log('READY http://127.0.0.1:' + server.address().port);
    for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => server.shutdown().then(() => process.exit(0)));
  `], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Skill startup timed out: ${output}`)), 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Skill exited (${code}): ${output}`)); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  async function request(endpoint, data) {
    const response = await fetch(url + endpoint, {
      ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, `${endpoint}: ${await response.clone().text().then(text => text.slice(0, 200))}`);
    return response;
  }
  assert.match(await (await request('/')).text(), /app\.js/);
  assert.ok((await (await request('/app.js')).text()).length > 1000);
  const css = await (await request('/app.css')).text();
  const asset = css.match(/url\(["']?(?:\.\/)?(assets\/[^)"']+)/)?.[1];
  assert.ok(asset, 'A bundled font is available');
  assert.ok((await (await request('/' + asset)).arrayBuffer()).byteLength > 0);
  const topic = await (await request('/api/topics', { name: 'Installation smoke test', scope: 'Synthetic installation check' })).json();
  await request(`/api/topics/${topic.id}/doc`, { baseRevision: topic.revision, doc: '## Notes\n\nManual content survives installation.' });
  const exported = await (await request(`/api/topics/${topic.id}/export`)).json();
  assert.match(JSON.stringify(exported), /Manual content survives installation/);
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(installed, 'scripts/cli.mjs'), 'list', '--remote'], {
    cwd: sandbox, env: { ...env, GFT_LOCAL_URL: url }, timeout: 10000,
  });
  assert.match(stdout, /Installation smoke test/);
  console.log('Skill passed: standalone start, page/assets, topic save/export and Agent CLI read. No model calls.');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'exit');
    child.kill('SIGTERM');
    await closed;
  }
  assert.equal(path.dirname(sandbox), path.resolve(tmpdir()));
  assert.ok(path.basename(sandbox).startsWith('gft-map-install-'));
  await rm(sandbox, { recursive: true, force: true });
}
