import { spawnSync } from 'node:child_process';

const pnpmExecPath = process.env.npm_execpath;
const pnpmBin = pnpmExecPath
  ? process.execPath
  : process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const commands = [
  ['test:vitest'],
  ['test:runtime'],
];

for (const args of commands) {
  const commandArgs = pnpmExecPath ? [pnpmExecPath, ...args] : ['pnpm', ...args];
  const result = spawnSync(pnpmBin, commandArgs, {
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
