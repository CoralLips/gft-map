import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Ordinary regressions use fake executors. Never inherit a developer's login,
// custom executor command, or API credentials into their child processes.
export function createTestEnvironment(parent = process.env) {
  const root = mkdtempSync(path.join(tmpdir(), 'gft-test-home-'));
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|AZURE_OPENAI_|GFT_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    CODEX_HOME: path.join(root, '.codex'),
    GFT_LOCAL_HOME: path.join(root, 'gft'),
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(root, '.config'),
    XDG_DATA_HOME: path.join(root, '.local', 'share'),
    XDG_CACHE_HOME: path.join(root, '.cache'),
  });
  if (process.platform === 'win32') {
    env.HOMEDRIVE = path.parse(root).root.slice(0, -1);
    env.HOMEPATH = root.slice(env.HOMEDRIVE.length);
  }
  for (const key of [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GFT_LOCAL_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
  ])
    mkdirSync(env[key], { recursive: true });
  return {
    env,
    dispose() {
      const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
      if (
        !relative ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !path.basename(root).startsWith('gft-test-home-')
      )
        throw new Error('Refusing to remove a directory outside the test home');
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}
