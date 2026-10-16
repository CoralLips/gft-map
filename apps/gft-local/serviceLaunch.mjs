// Windows detached children may still belong to the caller's kill-on-close Job.
// WMI starts a short-lived broker outside that Job. A one-use local pipe carries
// the environment, so credentials never enter command lines or temporary files.
import { spawn, execFile } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const self = fileURLToPath(import.meta.url);
const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
const psString = value => `'${value.replaceAll("'", "''")}'`;

export async function launchBackground(args, { cwd, env, logDirectory }) {
  if (process.platform !== 'win32') return launch(args, { cwd, env, logDirectory });
  const pipe = `\\\\.\\pipe\\gft-launch-${randomUUID()}`;
  const secret = randomUUID();
  const server = createServer();
  let socket, timer;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, resolve);
    });
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Windows 后台启动超时，请查看系统 WMI 服务。')),
        20000,
      );
      server.once('connection', peer => {
        socket = peer;
        let received = '';
        peer.setEncoding('utf8');
        peer.on('error', reject);
        peer.on('data', chunk => {
          received += chunk;
          if (!received.includes('\n')) return;
          const line = received.slice(0, received.indexOf('\n'));
          received = received.slice(received.indexOf('\n') + 1);
          try {
            const message = JSON.parse(line);
            if (message.secret === secret) {
              peer.write(JSON.stringify({ args, cwd, env, logDirectory }) + '\n');
            } else if (Number.isSafeInteger(message.pid) && message.pid > 0) {
              resolve({ pid: message.pid, exitCode: null, signalCode: null });
            } else reject(new Error('Windows 后台启动失败。'));
          } catch (error) {
            reject(error);
          }
        });
      });
      const command = [process.execPath, self, '--broker', pipe, secret].map(quote).join(' ');
      const script = `$ErrorActionPreference='Stop'; $s=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psString(command)};CurrentDirectory=${psString(cwd)};ProcessStartupInformation=$s}; if($r.ReturnValue -ne 0){throw 'Windows background broker failed'};`;
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, timeout: 20000 },
        error => {
          if (error) reject(new Error('Windows 无法启动独立后台进程，请确认 WMI 服务可用。'));
        },
      );
    });
    return await result;
  } finally {
    clearTimeout(timer);
    socket?.destroy();
    server.close();
  }
}

async function launch(args, { cwd, env, logDirectory }) {
  const stdout = await open(path.join(logDirectory, 'stdout.log'), 'a', 0o600);
  const stderr = await open(path.join(logDirectory, 'stderr.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', stdout.fd, stderr.fd],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return child;
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

if (process.argv[2] === '--broker') {
  const peer = connect(process.argv[3]);
  peer.setEncoding('utf8');
  peer.setTimeout(20000, () => peer.destroy());
  peer.on('error', () => {
    process.exitCode = 1;
  });
  peer.on('connect', () => peer.write(JSON.stringify({ secret: process.argv[4] }) + '\n'));
  let text = '';
  peer.on('data', async chunk => {
    text += chunk;
    if (!text.includes('\n')) return;
    peer.removeAllListeners('data');
    try {
      const request = JSON.parse(text.trim());
      const child = await launch(request.args, request);
      peer.end(JSON.stringify({ pid: child.pid }) + '\n');
    } catch {
      peer.end('{}\n');
      process.exitCode = 1;
    }
  });
}
