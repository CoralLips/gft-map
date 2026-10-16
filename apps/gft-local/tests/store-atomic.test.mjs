import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../store.mjs';

test(
  'Windows：目标文件被读取方占用时，原子替换持续退避重试而不是让保存失败',
  { skip: process.platform !== 'win32' && 'retry applies to Windows file locking only' },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gft-atomic-'));
    const target = path.join(directory, 'topic.json');
    const original = fs.promises.rename;
    let refusals = 0;
    fs.promises.rename = async (from, to) => {
      // Longer than the old 20 × 25 ms budget: a busy machine holds readers this long.
      if (to === target && refusals < 25) {
        refusals++;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return original(from, to);
    };
    syncBuiltinESMExports();
    try {
      await writeJsonAtomic(target, { saved: true });
      assert.equal(refusals, 25);
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { saved: true });
    } finally {
      fs.promises.rename = original;
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
