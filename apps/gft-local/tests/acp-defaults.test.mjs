import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultExecutor } from '../executor-config.mjs';
import { ensureAdapter, adapterReleases, adapterCacheStamp } from '../acpAdapters.mjs';

test('failed locked install preserves useful diagnostics without credentials and permits retry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-adapter-error-'));
  const previous = process.env.GFT_LOCAL_HOME,
    npm = process.env.npm_execpath;
  process.env.GFT_LOCAL_HOME = directory;
  process.env.npm_execpath = path.join(directory, 'npm-cli.js');
  try {
    await writeFile(
      process.env.npm_execpath,
      `if(!process.argv.includes('ci')||!process.argv.includes('--ignore-scripts'))process.exit(19);console.error('npm error ENOTFOUND registry lookup failed\\nAuthorization: synthetic-private-value\\nhttps://private:password@example.invalid');process.exit(7);`,
    );
    await assert.rejects(ensureAdapter('codex-acp'), /网络连接失败.*install-errors.log/);
    const log = await readFile(path.join(directory, 'adapters/install-errors.log'), 'utf8');
    assert.match(log, /code=7/);
    assert.match(log, /ENOTFOUND/);
    assert.doesNotMatch(log, /synthetic-private-value|private:password/);
    assert.equal(
      (await readdir(path.join(directory, 'adapters'))).some(name => name.includes('-preparing-')),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previous;
    if (npm === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = npm;
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a damaged adapter cache is replaced only after a complete staging install', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-adapter-repair-'));
  const previous = process.env.GFT_LOCAL_HOME,
    npm = process.env.npm_execpath;
  process.env.GFT_LOCAL_HOME = directory;
  process.env.npm_execpath = path.join(directory, 'npm-cli.js');
  try {
    await writeFile(
      process.env.npm_execpath,
      `const fs=require('node:fs'),p=require('node:path');const d=p.join(process.argv[process.argv.indexOf('--prefix')+1],'node_modules/@agentclientprotocol/codex-acp');fs.mkdirSync(p.join(d,'dist'),{recursive:true});fs.writeFileSync(p.join(d,'package.json'),JSON.stringify({version:'1.12.0'}));fs.writeFileSync(p.join(d,'dist/index.js'),'// complete');`,
    );
    const root = path.join(directory, 'adapters');
    await mkdir(path.join(root, 'codex-acp-1.12.0'), { recursive: true });
    await writeFile(path.join(root, 'codex-acp-1.12.0', 'broken'), 'old cache');
    const result = await ensureAdapter('codex-acp');
    assert.ok(
      result.prefixArgs[0].endsWith('dist/index.js') ||
        result.prefixArgs[0].endsWith('dist\\index.js'),
    );
    assert.ok((await readdir(root)).some(name => name.includes('-damaged-')));
    assert.deepEqual(await ensureAdapter('codex-acp'), result);
  } finally {
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previous;
    if (npm === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = npm;
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('default selection migrates the provider without pinning a model, never a native executable', () => {
  assert.equal(defaultExecutor(null).agent, 'codex-acp');
  for (const provider of ['codex', 'claude']) {
    assert.deepEqual(
      defaultExecutor({
        agent: provider,
        runnerOptions: {
          binary: 'native.exe',
          prefixArgs: ['native-argument'],
          model: 'chosen',
          timeoutMs: 5000,
        },
      }),
      {
        agent: `${provider}-acp`,
        runnerOptions: { timeoutMs: 5000 },
      },
    );
    const runnerOptions = {
      binary: 'node.exe',
      prefixArgs: ['adapter.js'],
      model: 'adapter-model',
    };
    assert.deepEqual(
      defaultExecutor({ agent: provider, profiles: { [`${provider}-acp`]: runnerOptions } })
        .runnerOptions,
      { binary: 'node.exe', prefixArgs: ['adapter.js'] },
    );
    assert.deepEqual(defaultExecutor({ agent: `${provider}-acp`, runnerOptions }).runnerOptions, {
      binary: 'node.exe',
      prefixArgs: ['adapter.js'],
    });
  }
});

test('a complete pinned adapter cache is reused without npm or network, including concurrent checks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gft-adapter-cache-'));
  const previous = process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME = directory;
  try {
    for (const [agent, release] of Object.entries(adapterReleases)) {
      const base = path.join(
        directory,
        'adapters',
        `${agent}-${release.version}`,
        'node_modules',
        release.name,
      );
      await mkdir(path.join(base, 'dist'), { recursive: true });
      await writeFile(path.join(base, 'package.json'), JSON.stringify(release));
      await writeFile(path.join(base, 'dist/index.js'), '// cached test adapter');
      await writeFile(
        path.resolve(base, '../../..', 'gft-lock.sha256'),
        await adapterCacheStamp(agent),
      );
      const first = ensureAdapter(agent),
        second = ensureAdapter(agent);
      assert.equal(first, second);
      assert.deepEqual(await first, {
        binary: process.execPath,
        prefixArgs: [path.join(base, 'dist/index.js')],
      });
    }
  } finally {
    if (previous === undefined) delete process.env.GFT_LOCAL_HOME;
    else process.env.GFT_LOCAL_HOME = previous;
    const relative = path.relative(tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  }
});
