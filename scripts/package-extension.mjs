#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const root = process.cwd();
const distDir = path.resolve(root, 'dist');
const artifactsDir = path.resolve(root, 'artifacts');
const chromeArtifactsDir = path.join(artifactsDir, 'chrome');

if (process.env.GSM_SKIP_PACKAGE_BUILD !== 'true') {
  execFileSync('pnpm', ['build'], {
    cwd: root,
    stdio: 'inherit',
  });
}

if (!existsSync(path.join(distDir, 'manifest.json'))) {
  console.error(`❌ No dist/manifest.json found at ${distDir}. Run "pnpm build" first.`);
  process.exit(1);
}

mkdirSync(artifactsDir, { recursive: true });
mkdirSync(chromeArtifactsDir, { recursive: true });

const baseName = `better-github-stars-manager-${pkg.version}`;
const zipPath = path.join(artifactsDir, `${baseName}.zip`);
const checksumPath = path.join(artifactsDir, `${baseName}.zip.sha256`);
const chromeZipPath = path.join(chromeArtifactsDir, `${baseName}.zip`);
const chromeChecksumPath = path.join(chromeArtifactsDir, `${baseName}.zip.sha256`);
const stageDir = mkdtempSync(path.join(os.tmpdir(), 'bgsm-package-'));

rmSync(zipPath, { force: true });
rmSync(checksumPath, { force: true });
rmSync(chromeZipPath, { force: true });
rmSync(chromeChecksumPath, { force: true });

try {
  cpSync(distDir, stageDir, {
    recursive: true,
    filter(src) {
      if (src === distDir) return true;

      const rel = path.relative(distDir, src).split(path.sep).join('/');
      if (rel === '.DS_Store' || rel.endsWith('/.DS_Store')) return false;
      if (rel === 'poster' || rel.startsWith('poster/')) return false;
      if (rel === 'store' || rel.startsWith('store/')) return false;

      return true;
    },
  });

  execFileSync('zip', ['-qr', zipPath, '.'], {
    cwd: stageDir,
    stdio: 'inherit',
  });
} catch (error) {
  console.error('❌ Failed to create extension zip. Ensure the "zip" command is available.');
  throw error;
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}

const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(checksumPath, `${digest}  ${path.basename(zipPath)}\n`);
cpSync(zipPath, chromeZipPath);
writeFileSync(chromeChecksumPath, `${digest}  ${path.basename(chromeZipPath)}\n`);

const versionHashPattern = /\b(?:[0-9a-f]{8}|unknown)-(?:clean|[0-9a-f]{6})-[0-9a-f]{6}\b/;
const assetDir = path.join(distDir, 'assets');
const versionHashCandidates = new Set();
for (const entry of existsSync(assetDir) ? readdirSync(assetDir) : []) {
  if (!entry.endsWith('.js')) continue;
  for (const match of readFileSync(path.join(assetDir, entry), 'utf8').matchAll(versionHashPattern)) {
    versionHashCandidates.add(match[0]);
  }
}
const [versionHash] = versionHashCandidates.size === 1 ? versionHashCandidates : [];

console.log(`✅ Packaged ${path.relative(root, zipPath)}`);
console.log(`✅ Wrote ${path.relative(root, checksumPath)}`);
console.log(`✅ Packaged ${path.relative(root, chromeZipPath)}`);
console.log(`✅ Wrote ${path.relative(root, chromeChecksumPath)}`);
if (versionHash) console.log(`✅ DEV ${versionHash}`);
