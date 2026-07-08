#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

function isCliEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function main() {
  const root = process.cwd();
  const distDir = path.resolve(root, 'dist-firefox');
  const artifactsDir = path.resolve(root, 'artifacts/firefox');

  if (process.env.GSM_SKIP_FIREFOX_BUILD !== 'true') {
    execFileSync('pnpm', ['build:firefox'], {
      cwd: root,
      stdio: 'inherit',
    });
  }

  if (!existsSync(path.join(distDir, 'manifest.json'))) {
    console.error(`No dist-firefox/manifest.json found at ${distDir}. Run "pnpm build:firefox" first.`);
    process.exit(1);
  }

  mkdirSync(artifactsDir, { recursive: true });

  const baseName = `better-github-stars-manager-firefox-${pkg.version}`;
  const zipPath = path.join(artifactsDir, `${baseName}.zip`);
  const checksumPath = path.join(artifactsDir, `${baseName}.zip.sha256`);

  rmSync(zipPath, { force: true });
  rmSync(checksumPath, { force: true });

  execFileSync('pnpm', [
    'dlx',
    'web-ext',
    'build',
    '--source-dir',
    distDir,
    '--artifacts-dir',
    artifactsDir,
    '--filename',
    path.basename(zipPath),
    '--overwrite-dest',
    '--ignore-files',
    'poster',
    'poster/**',
    'store',
    'store/**',
    '.DS_Store',
    '**/.DS_Store',
  ], {
    cwd: root,
    stdio: 'inherit',
  });

  const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  writeFileSync(checksumPath, `${digest}  ${path.basename(zipPath)}\n`);

  console.log(`Packaged ${path.relative(root, zipPath)}`);
  console.log(`Wrote ${path.relative(root, checksumPath)}`);
}

if (isCliEntry()) {
  main();
}
