import { spawnSync } from 'node:child_process';

const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const commands = [
  ['test:vitest'],
  ['test:runtime'],
];

for (const args of commands) {
  const result = spawnSync(pnpmBin, args, {
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
