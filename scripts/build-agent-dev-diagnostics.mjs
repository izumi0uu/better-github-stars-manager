#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'artifacts', 'agent-diagnostics-dev-dist');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
runPnpm('build', {
  GSM_DEV: 'true',
  GSM_RELEASE: 'false',
  GSM_DIST_DIR: path.relative(root, outDir),
});

function runPnpm(script, envOverrides) {
  const pnpmExecPath = process.env.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const args = pnpmExecPath ? [pnpmExecPath, script] : ['pnpm', script];
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...envOverrides },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
