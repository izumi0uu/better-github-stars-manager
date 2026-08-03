#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { packageInputFingerprint } from './package-input-fingerprint.mjs';

const root = process.cwd();
const distDir = path.resolve(root, process.env.GSM_DIST_DIR ?? 'dist');
const artifactsDir = path.resolve(root, process.env.GSM_ARTIFACTS_DIR ?? 'artifacts');
const releaseEvidencePath = path.join(artifactsDir, `release-evidence-${pkg.version}.json`);
const phase5EvidencePath = path.join(artifactsDir, 'agent-phase5-verification.json');
const outputPath = path.join(artifactsDir, 'agent-release-gate-evidence.json');
const sourceCommit = git(['rev-parse', 'HEAD']);

assert.equal(git(['status', '--porcelain', '--untracked-files=normal']), '',
  'Release evidence can be finalized only from a clean source tree.');
assert.ok(existsSync(releaseEvidencePath), 'Missing provisional release evidence.');
assert.ok(existsSync(phase5EvidencePath), 'Missing Phase 5 integrated verification evidence.');

const releaseEvidence = JSON.parse(readFileSync(releaseEvidencePath, 'utf8'));
const phase5Evidence = JSON.parse(readFileSync(phase5EvidencePath, 'utf8'));
assert.equal(releaseEvidence.schemaVersion, 1);
assert.equal(phase5Evidence.schemaVersion, 1);
assert.equal(releaseEvidence.packageVersion, pkg.version);
assert.equal(phase5Evidence.packageVersion, pkg.version);
assert.deepEqual(releaseEvidence.source, { commit: sourceCommit, dirty: false });
assert.deepEqual(phase5Evidence.source, { commit: sourceCommit, dirty: false });
assert.equal(releaseEvidence.package.releaseReady, false);
assert.equal(releaseEvidence.package.releaseReadinessReason, 'phase5_integrated_verification_required');
assert.equal(releaseEvidence.package.dashboardSubmissionClaimed, false);
assert.equal(phase5Evidence.status, 'phase5_integrated_verification_passed');
assert.ok(Date.parse(releaseEvidence.generatedAt) < Date.parse(phase5Evidence.generatedAt));
assert.deepEqual(
  releaseEvidence.packageInput,
  phase5Evidence.testedPackageInput,
  'Packaged files differ from the production package input exercised by Phase 5.',
);
assert.deepEqual(
  packageInputFingerprint(distDir),
  releaseEvidence.packageInput,
  'Current production package input differs from the finalized package evidence.',
);

for (const check of [
  'typecheck',
  'fullVitest',
  'runtime',
  'extensionSmoke',
  'organizeJobExtensionHost',
  'organizeJobRecovery',
  'agentDiagnosticsReleaseIsolation',
  'agentScenariosExtensionHost',
  'productionBuild',
  'packageExtension',
]) {
  assert.equal(phase5Evidence.checks?.[check], 'passed', `Missing Phase 5 check: ${check}`);
}
assert.equal(
  phase5Evidence.provisionalReleaseEvidence.sha256,
  hash(readFileSync(releaseEvidencePath)),
  'Phase 5 evidence must bind the exact provisional release evidence.',
);

for (const file of releaseEvidence.generatedFiles) {
  const absolutePath = path.join(root, file.relativePath);
  assert.ok(existsSync(absolutePath), `Missing packaged artifact: ${file.relativePath}`);
  assert.equal(hash(readFileSync(absolutePath)), file.sha256, file.relativePath);
}
const zip = releaseEvidence.generatedFiles.find((file) => file.relativePath.endsWith('.zip'));
const checksum = releaseEvidence.generatedFiles.find((file) => file.relativePath.endsWith('.sha256'));
assert.ok(zip && checksum, 'Release evidence must include ZIP and checksum files.');
assert.match(readFileSync(path.join(root, checksum.relativePath), 'utf8'), new RegExp(`^${zip.sha256}\\s`));
assert.equal(
  hash(readFileSync(path.join(distDir, releaseEvidence.packagedManifest.relativePath))),
  releaseEvidence.packagedManifest.sha256,
  'Packaged manifest hash is stale.',
);

const finalizedAt = new Date().toISOString();
releaseEvidence.package = {
  ...releaseEvidence.package,
  releaseReady: true,
  releaseReadinessReason: 'phase5_integrated_verification_passed',
  finalizedAt,
};
const temporaryReleasePath = `${releaseEvidencePath}.tmp`;
writeFileSync(temporaryReleasePath, `${JSON.stringify(releaseEvidence, null, 2)}\n`);
renameSync(temporaryReleasePath, releaseEvidencePath);

const gateEvidence = {
  schemaVersion: 1,
  generatedAt: finalizedAt,
  executionAuthority: 'prd_test_spec_direct_plan',
  source: { commit: sourceCommit, dirty: false },
  phase5Evidence: {
    relativePath: path.relative(root, phase5EvidencePath),
    sha256: hash(readFileSync(phase5EvidencePath)),
  },
  releaseEvidence: {
    relativePath: path.relative(root, releaseEvidencePath),
    sha256: hash(readFileSync(releaseEvidencePath)),
    releaseReady: true,
    dashboardSubmissionClaimed: false,
  },
  status: 'release_ready_verified',
};
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(gateEvidence, null, 2)}\n`);
console.log(`Finalized Agent release evidence and wrote ${path.relative(root, outputPath)}`);

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
