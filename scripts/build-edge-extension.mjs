#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EDGE_DIST_DIR = 'dist-edge';

export function edgeBuildEnvironment(environment = process.env, distDir = EDGE_DIST_DIR) {
  return Object.freeze({
    ...environment,
    GSM_DEV: 'false',
    GSM_RELEASE: 'true',
    GSM_STORE_TARGET: 'edge',
    GSM_PACKAGE_TARGET: 'edge',
    GSM_DIST_DIR: distDir,
  });
}

export function buildEdgeExtension(options = {}) {
  const environment = options.environment ?? process.env;
  const root = path.resolve(options.root ?? process.cwd());
  const edgeDistDir = path.resolve(root, options.edgeDistDir ?? EDGE_DIST_DIR);
  if (edgeDistDir === path.resolve(root, 'dist')) {
    throw new Error('Edge output directory must be isolated from the Chrome dist directory');
  }
  const buildEnvironment = edgeBuildEnvironment(environment, edgeDistDir);
  const runner = options.runner ?? runPnpmCommand;

  runner({ root, environment: buildEnvironment, args: ['exec', 'tsc', '--noEmit'] });
  runner({ root, environment: buildEnvironment, args: ['exec', 'vite', 'build'] });

  return Object.freeze({ edgeDistDir });
}

function runPnpmCommand({ root, environment, args }) {
  const pnpmExecPath = environment.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const commandArgs = pnpmExecPath ? [pnpmExecPath, ...args] : ['pnpm', ...args];
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Edge build command exited on signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`Edge build command failed with status ${result.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildEdgeExtension();
    console.log(`Edge build written: ${path.relative(process.cwd(), result.edgeDistDir)}`);
  } catch (error) {
    console.error(`Edge build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
