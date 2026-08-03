#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { isPackageInputRelativePath, packageInputFingerprint } from './package-input-fingerprint.mjs';

const root = process.cwd();
const distDir = path.resolve(root, process.env.GSM_DIST_DIR ?? 'dist');
const artifactsDir = path.resolve(root, process.env.GSM_ARTIFACTS_DIR ?? 'artifacts');

if (process.env.GSM_SKIP_PACKAGE_BUILD !== 'true') {
  const pnpmExecPath = process.env.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const args = pnpmExecPath ? [pnpmExecPath, 'build'] : ['pnpm', 'build'];
  execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, GSM_RELEASE: 'true', GSM_DEV: 'false' },
    stdio: 'inherit',
  });
}

if (!existsSync(path.join(distDir, 'manifest.json'))) {
  console.error(`❌ No dist/manifest.json found at ${distDir}. Run "pnpm build" first.`);
  process.exit(1);
}

const sourceOnlyDistEntries = ['.codex', 'docs', 'poster', 'store-assets'];
const leakedSourceOnlyEntries = sourceOnlyDistEntries.filter((entry) =>
  existsSync(path.join(distDir, entry)),
);
if (leakedSourceOnlyEntries.length > 0) {
  console.error(`❌ dist contains source-only files: ${leakedSourceOnlyEntries.join(', ')}`);
  console.error('Keep documentation, skills, and store-listing assets outside public/.');
  process.exit(1);
}

mkdirSync(artifactsDir, { recursive: true });

for (const entry of readdirSync(artifactsDir)) {
  if (
    /^better-github-stars-manager-.*\.zip(?:\.sha256)?$/.test(entry) ||
    /^release-evidence-.*\.json$/.test(entry)
  ) {
    rmSync(path.join(artifactsDir, entry), { force: true });
  }
}

const baseName = `better-github-stars-manager-${pkg.version}`;
const zipPath = path.join(artifactsDir, `${baseName}.zip`);
const checksumPath = path.join(artifactsDir, `${baseName}.zip.sha256`);
const evidencePath = path.join(artifactsDir, `release-evidence-${pkg.version}.json`);
const stageDir = mkdtempSync(path.join(os.tmpdir(), 'bgsm-package-'));
let packagedInput;

rmSync(zipPath, { force: true });
rmSync(checksumPath, { force: true });

try {
  cpSync(distDir, stageDir, {
    recursive: true,
    filter(src) {
      if (src === distDir) return true;
      return isPackageInputRelativePath(path.relative(distDir, src));
    },
  });
  packagedInput = packageInputFingerprint(stageDir);

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

const zipEntries = execFileSync('unzip', ['-Z1', zipPath], {
  cwd: root,
  encoding: 'utf8',
}).split(/\r?\n/).filter(Boolean);
if (!zipEntries.includes('manifest.json') || zipEntries.some((entry) => entry.startsWith('store/'))) {
  rmSync(zipPath, { force: true });
  rmSync(checksumPath, { force: true });
  console.error('❌ Extension ZIP must contain manifest.json at root and exclude store-listing assets.');
  process.exit(1);
}

const versionHashPattern = /\b(?:[0-9a-f]{8}|unknown)-(?:clean|[0-9a-f]{6})-[0-9a-f]{6}\b/g;
const assetDir = path.join(distDir, 'assets');
const versionHashCandidates = new Set();
for (const entry of existsSync(assetDir) ? readdirSync(assetDir) : []) {
  if (!entry.endsWith('.js')) continue;
  for (const match of readFileSync(path.join(assetDir, entry), 'utf8').matchAll(versionHashPattern)) {
    versionHashCandidates.add(match[0]);
  }
}
if (versionHashCandidates.size > 0) {
  rmSync(zipPath, { force: true });
  rmSync(checksumPath, { force: true });
  console.error(`❌ Release package contains development build hash: ${Array.from(versionHashCandidates).join(', ')}`);
  console.error('Run pnpm package:extension without GSM_SKIP_PACKAGE_BUILD, or rebuild with GSM_RELEASE=true.');
  process.exit(1);
}

const bundledJavaScript = existsSync(assetDir)
  ? readdirSync(assetDir)
      .filter((entry) => entry.endsWith('.js'))
      .map((entry) => readFileSync(path.join(assetDir, entry), 'utf8'))
      .join('\n')
  : '';
const disclosureBundleMarkers = [
  'prompt_or_bounded_task_instruction',
  'selected_or_frozen_scope_public_repository_metadata',
  'selected_or_frozen_scope_public_repository_code_snippets',
  'selected_or_frozen_scope_private_notes',
  'visible_bounded_tag_taxonomy',
  'protocol_observations',
  'credentials_or_secrets',
  'github_token',
  'unrelated_or_out_of_scope_stars',
];
const missingDisclosureMarkers = disclosureBundleMarkers.filter((marker) =>
  !bundledJavaScript.includes(marker),
);
if (missingDisclosureMarkers.length > 0) {
  rmSync(zipPath, { force: true });
  rmSync(checksumPath, { force: true });
  console.error(`❌ Production bundle is missing disclosure markers: ${missingDisclosureMarkers.join(', ')}`);
  process.exit(1);
}

const packagedManifest = JSON.parse(readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  cwd: root,
  encoding: 'utf8',
}).trim().length > 0;
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packageVersion: pkg.version,
  source: {
    commit: sourceCommit,
    dirty: sourceDirty,
  },
  package: {
    releaseReady: false,
    releaseReadinessReason: sourceDirty
      ? 'dirty_source_tree'
      : 'phase5_integrated_verification_required',
    dashboardSubmissionClaimed: false,
    zipRootManifest: true,
    storeListingAssetsExcluded: true,
    productionDisclosureMarkers: disclosureBundleMarkers,
  },
  packagedPermissions: {
    permissions: sortedStrings(packagedManifest.permissions),
    hostPermissions: sortedStrings(packagedManifest.host_permissions),
    optionalHostPermissions: sortedStrings(packagedManifest.optional_host_permissions),
  },
  packageInput: packagedInput,
  generatedFiles: [
    fileEvidence(root, zipPath),
    fileEvidence(root, checksumPath),
  ],
  packagedManifest: {
    relativePath: 'manifest.json',
    sha256: hashBuffer(readFileSync(path.join(distDir, 'manifest.json'))),
  },
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

console.log(`✅ Packaged ${path.relative(root, zipPath)}`);
console.log(`✅ Wrote ${path.relative(root, checksumPath)}`);
console.log(`✅ Wrote ${path.relative(root, evidencePath)}`);
console.log('✅ Release package contains no source-only files');
console.log('✅ Release package contains no development build hash');
console.log(`✅ Source state recorded as ${sourceDirty ? 'dirty (not release-ready)' : 'clean'}`);

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fileEvidence(baseDir, filePath) {
  return {
    relativePath: path.relative(baseDir, filePath).split(path.sep).join('/'),
    sha256: hashBuffer(readFileSync(filePath)),
  };
}

function sortedStrings(value) {
  return Array.isArray(value) ? [...value].sort() : [];
}
