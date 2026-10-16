import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createTestEnvironment } from '../release/test-environment.mjs';

test('regression children write only to an isolated Agent home and inherit no provider credentials', () => {
  const parent = {
    ...process.env,
    ANTHROPIC_API_KEY: 'synthetic-secret',
    OPENAI_API_KEY: 'synthetic-secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-secret',
    GFT_CODEX_BIN: 'not-a-test-executor',
  };
  const isolated = createTestEnvironment(parent);
  const home = isolated.env.HOME;
  try {
    assert.notEqual(home, parent.HOME);
    assert.notEqual(home, parent.USERPROFILE);
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { writeFileSync } from 'node:fs';
      import { homedir } from 'node:os';
      import path from 'node:path';
      writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'synthetic-only');
      console.log(JSON.stringify({ home: homedir(), secret: process.env.ANTHROPIC_API_KEY, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, openai: process.env.OPENAI_API_KEY, command: process.env.GFT_CODEX_BIN }));
    `,
        ],
        { env: isolated.env, encoding: 'utf8' },
      ),
    );
    assert.deepEqual(result, { home });
    assert.equal(
      readFileSync(path.join(isolated.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'),
      'synthetic-only',
    );
    assert.equal(parent.ANTHROPIC_API_KEY, 'synthetic-secret');
  } finally {
    isolated.dispose();
  }
  assert.equal(existsSync(home), false);
});
