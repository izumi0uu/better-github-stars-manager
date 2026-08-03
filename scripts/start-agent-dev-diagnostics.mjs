#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const extensionDir = path.join(root, 'dist');

runPnpm(['build']);

console.log('');
console.log('BGSM Agent diagnostics is ready.');
console.log(`Load or reload this stable unpacked extension directory:\n  ${extensionDir}`);
console.log('Keep this process running while Provider monitoring is active.');
console.log('');

runPnpm(['exec', 'vite', '--host', '127.0.0.1'], {
  GSM_DIST_DIR: 'artifacts/agent-diagnostics-vite-runtime',
});

function runPnpm(args, envOverrides = {}) {
  const pnpmExecPath = process.env.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const commandArgs = pnpmExecPath ? [pnpmExecPath, ...args] : ['pnpm', ...args];
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: { ...process.env, ...envOverrides },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
