#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { packageInputFingerprint } from './package-input-fingerprint.mjs';

const root = process.cwd();
const distDir = path.resolve(root, process.env.GSM_DIST_DIR ?? 'dist');
const artifactsDir = path.resolve(root, process.env.GSM_ARTIFACTS_DIR ?? 'artifacts');
const releaseEvidencePath = path.join(artifactsDir, `release-evidence-${pkg.version}.json`);
const outputPath = path.join(artifactsDir, 'agent-phase5-verification.json');
const sourceCommit = git(['rev-parse', 'HEAD']);
const artifactEnvironment = {
  GSM_DIST_DIR: distDir,
  GSM_ARTIFACTS_DIR: artifactsDir,
};

assertCleanSource('Phase 5 verification must start from a clean source tree.');

const checks = {};
runStep('typecheck', 'typecheck', artifactEnvironment);
runStep('fullVitest', 'test:vitest', artifactEnvironment);
runStep('productionBuild', 'build', {
  ...artifactEnvironment,
  GSM_RELEASE: 'true',
  GSM_DEV: 'false',
});
const testedPackageInput = packageInputFingerprint(distDir);
runStep('runtime', 'test:runtime', artifactEnvironment);
runStep('extensionSmoke', 'test:smoke', artifactEnvironment);
runStep('organizeJobExtensionHost', 'test:runtime:organize-job-host', artifactEnvironment);
runStep('organizeJobRecovery', 'test:runtime:organize-job-recovery', artifactEnvironment);
runStep('agentDiagnosticsReleaseIsolation', 'test:runtime:agent-diagnostics', artifactEnvironment);
runStep('agentScenariosExtensionHost', 'test:runtime:agent-scenarios', artifactEnvironment);
const packageInputAfterTests = packageInputFingerprint(distDir);
if (!sameFingerprint(testedPackageInput, packageInputAfterTests)) {
  throw new Error('Runtime verification changed the production package input.');
}
runStep('packageExtension', 'package:extension', {
  ...artifactEnvironment,
  GSM_SKIP_PACKAGE_BUILD: 'true',
});

assertCleanSource('Phase 5 verification changed tracked source files.');
const releaseEvidence = JSON.parse(readFileSync(releaseEvidencePath, 'utf8'));
if (releaseEvidence.source.commit !== sourceCommit || releaseEvidence.source.dirty !== false) {
  throw new Error('Provisional package evidence is not bound to this clean source commit.');
}
if (!sameFingerprint(releaseEvidence.packageInput, testedPackageInput)) {
  throw new Error('Packaged extension input differs from the production files exercised by Phase 5.');
}

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  executionAuthority: 'prd_test_spec_direct_plan',
  source: { commit: sourceCommit, dirty: false },
  packageVersion: pkg.version,
  checks,
  testedPackageInput,
  provisionalReleaseEvidence: {
    relativePath: path.relative(root, releaseEvidencePath),
    sha256: hash(readFileSync(releaseEvidencePath)),
  },
  status: 'phase5_integrated_verification_passed',
};
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Verified Agent Phase 5 and wrote ${path.relative(root, outputPath)}`);

function runStep(name, script, envOverrides = {}) {
  runPnpm(script, envOverrides);
  checks[name] = 'passed';
}

function runPnpm(script, envOverrides = {}) {
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

function sameFingerprint(left, right) {
  return left?.algorithm === 'sha256'
    && left.algorithm === right?.algorithm
    && left.fileCount === right.fileCount
    && left.sha256 === right.sha256;
}

function assertCleanSource(message) {
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error(message);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
