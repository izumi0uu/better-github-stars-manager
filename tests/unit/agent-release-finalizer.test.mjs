import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { RUNTIME_EVIDENCE_CONTRACTS } from '../../scripts/agent-runtime-release-evidence.mjs';
import {
  cleanupOwnedPublicationTemps,
  finalizeAgentRelease,
  listReleaseArtifactFiles,
  publishFinalEvidence,
  validatePackageArtifacts,
} from '../../scripts/verify-agent-release-gates.mjs';

const VERSION = '1.0.9';
const COMMIT = 'a'.repeat(40);
const SHA = 'b'.repeat(64);
const FINGERPRINT = Object.freeze({ algorithm: 'sha256', fileCount: 3, sha256: SHA });
const RELEASE_DIST = Object.freeze({ packageInput: FINGERPRINT });

function approval() {
  return JSON.stringify({
    approvedCandidateVersion: VERSION,
    observedCurrentPublicVersion: '1.0.8',
    observedPriorUploadVersion: '1.0.8',
  });
}

function publicationPlan(finalBytes = 'final\n', gateBytes = 'gate\n', transactionId = 'fixture-transaction') {
  const finalTemp = `release-evidence-${VERSION}.json.${transactionId}.tmp`;
  const gateTemp = `agent-release-gate-evidence.json.${transactionId}.tmp`;
  return {
    status: 'publish_required',
    actions: [
      { operation: 'writeExclusive', kind: 'final', path: finalTemp, mode: 0o600, bytes: finalBytes },
      { operation: 'writeExclusive', kind: 'gate', path: gateTemp, mode: 0o600, bytes: gateBytes },
      { operation: 'rename', kind: 'final', from: finalTemp, to: `release-evidence-${VERSION}.json` },
      { operation: 'rename', kind: 'gate', from: gateTemp, to: 'agent-release-gate-evidence.json' },
    ],
    cleanup: [finalTemp, gateTemp],
  };
}

function recoveryPlan(gateBytes = 'gate\n', transactionId = 'recovery-transaction') {
  const gateTemp = `agent-release-gate-evidence.json.${transactionId}.tmp`;
  return {
    status: 'recover_gate',
    actions: [
      { operation: 'writeExclusive', kind: 'gate', path: gateTemp, mode: 0o600, bytes: gateBytes },
      { operation: 'rename', kind: 'gate', from: gateTemp, to: 'agent-release-gate-evidence.json' },
    ],
    cleanup: [gateTemp],
  };
}
function publicationPaths(artifactsDir) {
  return {
    provisional: path.join(artifactsDir, `release-evidence-${VERSION}.provisional.json`),
    runtime: path.join(artifactsDir, 'agent-runtime-verification.json'),
    final: path.join(artifactsDir, `release-evidence-${VERSION}.json`),
    gate: path.join(artifactsDir, 'agent-release-gate-evidence.json'),
  };
}


test('publishes the distinct final first and the readiness gate last with mode 0600', () => {
  const artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'bgsm-final-publish-'));
  try {
    publishFinalEvidence({ artifactsDir, paths: publicationPaths(artifactsDir), plan: publicationPlan() });
    const finalPath = path.join(artifactsDir, `release-evidence-${VERSION}.json`);
    const gatePath = path.join(artifactsDir, 'agent-release-gate-evidence.json');
    assert.equal(readFileSync(finalPath, 'utf8'), 'final\n');
    assert.equal(readFileSync(gatePath, 'utf8'), 'gate\n');
    assert.equal(statSync(finalPath).mode & 0o777, 0o600);
    assert.equal(statSync(gatePath).mode & 0o777, 0o600);
    assert.equal(statSync(finalPath).mtimeMs <= statSync(gatePath).mtimeMs, true);
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});
test('rejects a malformed transaction before it can overwrite immutable provisional evidence', () => {
  const artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'bgsm-final-publish-plan-'));
  const paths = publicationPaths(artifactsDir);
  const provisionalRaw = 'immutable provisional\n';
  writeFileSync(paths.provisional, provisionalRaw, { mode: 0o600 });
  const plan = publicationPlan();
  plan.actions[2] = { ...plan.actions[2], to: path.basename(paths.provisional) };
  try {
    assert.throws(
      () => publishFinalEvidence({ artifactsDir, paths, plan }),
      /final path binding is invalid/,
    );
    assert.equal(readFileSync(paths.provisional, 'utf8'), provisionalRaw);
    assert.equal(existsSync(paths.final), false);
    assert.equal(existsSync(paths.gate), false);
    assert.deepEqual(readdirSync(artifactsDir).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});


test('recovers a real final-only crash with a new transaction and removes the old gate temp', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-finalizer-crash-'));
  const artifactsDir = path.join(root, 'evidence');
  const runtimeEvidenceDir = path.join(artifactsDir, 'runtime-evidence');
  mkdirSync(runtimeEvidenceDir, { recursive: true });
  const provisionalPath = path.join(artifactsDir, `release-evidence-${VERSION}.provisional.json`);
  const runtimePath = path.join(artifactsDir, 'agent-runtime-verification.json');
  writeFileSync(provisionalPath, '{}\n', { mode: 0o600 });
  writeFileSync(runtimePath, '{\n  "generatedAt": "2026-01-01T00:00:00.000Z"\n}\n', { mode: 0o600 });
  for (const { filename } of Object.values(RUNTIME_EVIDENCE_CONTRACTS)) {
    writeFileSync(path.join(runtimeEvidenceDir, filename), '{}\n', { mode: 0o600 });
  }
  const finalBytes = 'final\n';
  const gateBytes = 'gate\n';
  const crashedPlan = publicationPlan(finalBytes, gateBytes, 'old-transaction');
  for (const action of crashedPlan.actions.slice(0, 3)) {
    if (action.operation === 'writeExclusive') {
      writeFileSync(path.join(artifactsDir, action.path), action.bytes, { flag: 'wx', mode: action.mode });
    } else {
      renameSync(path.join(artifactsDir, action.from), path.join(artifactsDir, action.to));
    }
  }
  const oldGateTemp = path.join(artifactsDir, crashedPlan.actions[1].path);
  assert.equal(existsSync(oldGateTemp), true);
  assert.equal(existsSync(path.join(artifactsDir, 'agent-release-gate-evidence.json')), false);

  try {
    const result = finalizeAgentRelease({
      root,
      packageVersion: VERSION,
      env: {
        GSM_ARTIFACTS_DIR: artifactsDir,
        GSM_RUNTIME_EVIDENCE_DIR: runtimeEvidenceDir,
        GSM_VERSION_APPROVAL: approval(),
      },
      operations: {
        git: (args) => args[0] === 'status' ? '' : COMMIT,
        transactionId: () => 'new-transaction',
        fingerprint: () => FINGERPRINT,
        readReleaseDist: () => RELEASE_DIST,
        validatePackageArtifacts: () => ({ packagedManifestVersion: VERSION, zipManifestVersion: VERSION }),
        validateArtifactInventory: () => true,
        prepareFinalization: () => ({
          final: { bytes: Buffer.from(finalBytes) },
          gate: { bytes: Buffer.from(gateBytes) },
        }),
        planPublication: () => recoveryPlan(gateBytes, 'new-transaction'),
        validatePublishedGate: () => true,
      },
    });
    assert.equal(result.status, 'recover_gate');
    assert.equal(readFileSync(path.join(artifactsDir, `release-evidence-${VERSION}.json`), 'utf8'), finalBytes);
    assert.equal(readFileSync(path.join(artifactsDir, 'agent-release-gate-evidence.json'), 'utf8'), gateBytes);
    assert.equal(existsSync(oldGateTemp), false);
    assert.deepEqual(readdirSync(artifactsDir).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects foreign or symlinked temps without deleting any candidate', () => {
  const artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'bgsm-finalizer-temp-safety-'));
  const finalPath = path.join(artifactsDir, `release-evidence-${VERSION}.json`);
  const gatePath = path.join(artifactsDir, 'agent-release-gate-evidence.json');
  const validTemp = path.join(artifactsDir, 'agent-release-gate-evidence.json.old-transaction.tmp');
  const foreignTemp = path.join(artifactsDir, 'private-capture.old-transaction.tmp');
  const finalBytes = Buffer.from('final\n');
  const gateBytes = Buffer.from('gate\n');
  writeFileSync(finalPath, finalBytes, { mode: 0o600 });
  writeFileSync(validTemp, gateBytes, { mode: 0o600 });
  writeFileSync(foreignTemp, 'private', { mode: 0o600 });
  const input = {
    artifactsDir,
    paths: { final: finalPath, gate: gatePath },
    prepared: { final: { bytes: finalBytes }, gate: { bytes: gateBytes } },
    existing: { final: finalBytes },
  };
  try {
    assert.throws(() => cleanupOwnedPublicationTemps(input), /Foreign publication temp file/);
    assert.equal(readFileSync(validTemp, 'utf8'), 'gate\n');
    assert.equal(readFileSync(foreignTemp, 'utf8'), 'private');

    rmSync(foreignTemp);
    rmSync(validTemp);
    symlinkSync(finalPath, validTemp);
    assert.throws(() => cleanupOwnedPublicationTemps(input), /Publication temp must be a regular file/);
    assert.equal(lstatSync(validTemp).isSymbolicLink(), true);
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('finalizer validates before mutation, preserves provisional bytes, and checks clean source at both boundaries', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-finalizer-'));
  const artifactsDir = path.join(root, 'evidence');
  const runtimeEvidenceDir = path.join(artifactsDir, 'runtime-evidence');
  mkdirSync(runtimeEvidenceDir, { recursive: true });
  const provisionalPath = path.join(artifactsDir, `release-evidence-${VERSION}.provisional.json`);
  const runtimePath = path.join(artifactsDir, 'agent-runtime-verification.json');
  const provisionalRaw = '{}\n';
  const runtimeGeneratedAt = '2026-01-01T00:00:00.000Z';
  const runtimeRaw = `${JSON.stringify({ generatedAt: runtimeGeneratedAt }, null, 2)}\n`;
  writeFileSync(provisionalPath, provisionalRaw, { mode: 0o600 });
  writeFileSync(runtimePath, runtimeRaw, { mode: 0o600 });
  for (const { filename } of Object.values(RUNTIME_EVIDENCE_CONTRACTS)) {
    writeFileSync(path.join(runtimeEvidenceDir, filename), '{}\n', { mode: 0o600 });
  }
  const events = [];
  let statusChecks = 0;
  try {
    const result = finalizeAgentRelease({
      root,
      packageVersion: VERSION,
      env: {
        GSM_ARTIFACTS_DIR: artifactsDir,
        GSM_RUNTIME_EVIDENCE_DIR: runtimeEvidenceDir,
        GSM_VERSION_APPROVAL: approval(),
      },
      operations: {
        git: (args) => {
          if (args[0] === 'status') { statusChecks += 1; events.push(`clean:${statusChecks}`); return ''; }
          return COMMIT;
        },
        now: () => { throw new Error('Finalizer must not derive publication bytes from the wall clock.'); },
        transactionId: () => 'fixture-transaction',
        fingerprint: () => FINGERPRINT,
        readReleaseDist: () => RELEASE_DIST,
        validatePackageArtifacts: () => {
          events.push('package-validated');
          return { packagedManifestVersion: VERSION, zipManifestVersion: VERSION };
        },
        validateArtifactInventory: () => events.push('inventory-validated'),
        prepareFinalization: (input) => {
          events.push('all-inputs-validated');
          assert.deepEqual(input.versionApproval, JSON.parse(approval()));
          assert.equal(input.provisionalRelativePath, `release-evidence-${VERSION}.provisional.json`);
          assert.equal(Object.keys(input.runtimeEvidenceRaw).length, 7);
          assert.equal(Object.hasOwn(input.runtimeEvidenceRaw, 'runtimeComposition'), true);
          assert.equal(Object.hasOwn(input.runtimeEvidenceRaw, 'composition'), false);
          assert.equal(input.publicationTimestamp, runtimeGeneratedAt);
          return {};
        },
        planPublication: () => {
          events.push('publication-planned');
          return publicationPlan('{"ready":true}\n', '{"gate":true}\n');
        },
        validatePublishedGate: () => events.push('published-gate-validated'),
      },
    });

    assert.equal(result.status, 'publish_required');
    assert.equal(readFileSync(provisionalPath, 'utf8'), provisionalRaw);
    assert.deepEqual(events, [
      'clean:1',
      'package-validated',
      'all-inputs-validated',
      'publication-planned',
      'published-gate-validated',
      'inventory-validated',
      'clean:2',
    ]);
    assert.equal(statSync(path.join(artifactsDir, `release-evidence-${VERSION}.json`)).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(artifactsDir, 'agent-release-gate-evidence.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['dirty-source', 'package-input'])('post-validation %s failure leaves the readiness gate absent', (fault) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-finalizer-fault-'));
  const artifactsDir = path.join(root, 'evidence');
  const runtimeEvidenceDir = path.join(artifactsDir, 'runtime-evidence');
  mkdirSync(runtimeEvidenceDir, { recursive: true });
  const provisionalPath = path.join(artifactsDir, `release-evidence-${VERSION}.provisional.json`);
  const runtimePath = path.join(artifactsDir, 'agent-runtime-verification.json');
  writeFileSync(provisionalPath, '{}\n', { mode: 0o600 });
  writeFileSync(runtimePath, '{\n  "generatedAt": "2026-01-01T00:00:00.000Z"\n}\n', { mode: 0o600 });
  for (const { filename } of Object.values(RUNTIME_EVIDENCE_CONTRACTS)) {
    writeFileSync(path.join(runtimeEvidenceDir, filename), '{}\n', { mode: 0o600 });
  }
  let statusChecks = 0;
  let fingerprintReads = 0;
  try {
    assert.throws(() => finalizeAgentRelease({
      root,
      packageVersion: VERSION,
      env: {
        GSM_ARTIFACTS_DIR: artifactsDir,
        GSM_RUNTIME_EVIDENCE_DIR: runtimeEvidenceDir,
        GSM_VERSION_APPROVAL: approval(),
      },
      operations: {
        git: (args) => {
          if (args[0] === 'status') {
            statusChecks += 1;
            return statusChecks === 1 || fault !== 'dirty-source' ? '' : ' M tracked-source.ts';
          }
          return COMMIT;
        },
        transactionId: () => 'fault-transaction',
        fingerprint: () => {
          fingerprintReads += 1;
          return fingerprintReads === 1 || fault !== 'package-input'
            ? FINGERPRINT
            : { ...FINGERPRINT, sha256: 'c'.repeat(64) };
        },
        readReleaseDist: () => RELEASE_DIST,
        validatePackageArtifacts: () => ({ packagedManifestVersion: VERSION, zipManifestVersion: VERSION }),
        validateArtifactInventory: () => true,
        prepareFinalization: () => ({ final: { bytes: Buffer.from('final\n') }, gate: { bytes: Buffer.from('gate\n') } }),
        planPublication: () => publicationPlan(),
        validatePublishedGate: () => true,
      },
    }), fault === 'dirty-source' ? /did not end from a clean source tree/ : /Package input changed during release finalization/);
    assert.equal(existsSync(path.join(artifactsDir, `release-evidence-${VERSION}.json`)), false);
    assert.equal(existsSync(path.join(artifactsDir, 'agent-release-gate-evidence.json')), false);
    assert.deepEqual(
      statSync(artifactsDir).isDirectory(),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct finalizer rejects an extra runtime evidence record before final or gate mutation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-finalizer-extra-record-'));
  const artifactsDir = path.join(root, 'artifacts');
  const runtimeEvidenceDir = path.join(artifactsDir, 'runtime-evidence');
  mkdirSync(runtimeEvidenceDir, { recursive: true });
  writeFileSync(path.join(artifactsDir, `release-evidence-${VERSION}.provisional.json`), '{}\n', { mode: 0o600 });
  writeFileSync(path.join(artifactsDir, 'agent-runtime-verification.json'), '{\n  "generatedAt": "2026-01-01T00:00:00.000Z"\n}\n', { mode: 0o600 });
  writeFileSync(path.join(artifactsDir, `better-github-stars-manager-${VERSION}.zip`), 'zip');
  writeFileSync(path.join(artifactsDir, `better-github-stars-manager-${VERSION}.zip.sha256`), 'checksum');
  for (const { filename } of Object.values(RUNTIME_EVIDENCE_CONTRACTS)) {
    writeFileSync(path.join(runtimeEvidenceDir, filename), '{}\n', { mode: 0o600 });
  }
  writeFileSync(path.join(runtimeEvidenceDir, 'stale-extra.schema-v1.json'), '{}\n', { mode: 0o600 });
  try {
    assert.throws(() => finalizeAgentRelease({
      root,
      packageVersion: VERSION,
      env: {
        GSM_ARTIFACTS_DIR: artifactsDir,
        GSM_RUNTIME_EVIDENCE_DIR: runtimeEvidenceDir,
        GSM_VERSION_APPROVAL: approval(),
      },
      operations: {
        git: (args) => args[0] === 'status' ? '' : COMMIT,
        transactionId: () => 'extra-record-transaction',
        fingerprint: () => FINGERPRINT,
        readReleaseDist: () => RELEASE_DIST,
        validatePackageArtifacts: () => ({ packagedManifestVersion: VERSION, zipManifestVersion: VERSION }),
        prepareFinalization: () => ({ final: { bytes: Buffer.from('final\n') }, gate: { bytes: Buffer.from('gate\n') } }),
        planPublication: () => publicationPlan(),
        validatePublishedGate: () => true,
      },
    }), /inventory contains missing, extra, private, temporary, or nested files/);
    assert.equal(existsSync(path.join(artifactsDir, `release-evidence-${VERSION}.json`)), false);
    assert.equal(existsSync(path.join(artifactsDir, 'agent-release-gate-evidence.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('rejects a noncanonical runtime evidence root before reading release inputs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-finalizer-runtime-root-'));
  const artifactsDir = path.join(root, 'artifacts');
  const externalRuntimeEvidenceDir = path.join(root, 'external-runtime-evidence');
  mkdirSync(artifactsDir);
  mkdirSync(externalRuntimeEvidenceDir);
  let sourceRead = false;
  try {
    assert.throws(() => finalizeAgentRelease({
      root,
      packageVersion: VERSION,
      env: {
        GSM_ARTIFACTS_DIR: artifactsDir,
        GSM_RUNTIME_EVIDENCE_DIR: externalRuntimeEvidenceDir,
        GSM_VERSION_APPROVAL: approval(),
      },
      operations: { git: () => { sourceRead = true; return ''; } },
    }), /must be the canonical runtime-evidence directory/);
    assert.equal(sourceRead, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires provisional generated files to be the canonical ZIP and checksum pair', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-finalizer-generated-files-'));
  const artifactsDir = path.join(root, 'artifacts');
  const distDir = path.join(root, 'dist');
  mkdirSync(artifactsDir);
  mkdirSync(distDir);
  try {
    assert.throws(() => validatePackageArtifacts({
      root,
      artifactsDir,
      distDir,
      packageVersion: VERSION,
      provisional: {
        generatedFiles: [
          { relativePath: `better-github-stars-manager-${VERSION}.zip` },
          { relativePath: `better-github-stars-manager-${VERSION}.zip.sha256` },
          { relativePath: 'private-capture.json' },
        ],
      },
    }), /exact canonical ZIP and checksum inventory/);
    assert.deepEqual(readdirSync(artifactsDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('enumerates only canonical regular release files and rejects extras or symlinks', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-release-list-'));
  const artifactsDir = path.join(root, 'artifacts');
  const runtimeEvidenceDir = path.join(artifactsDir, 'runtime-evidence');
  mkdirSync(runtimeEvidenceDir, { recursive: true });
  const topLevel = [
    'agent-release-gate-evidence.json',
    'agent-runtime-verification.json',
    `better-github-stars-manager-${VERSION}.zip`,
    `better-github-stars-manager-${VERSION}.zip.sha256`,
    `release-evidence-${VERSION}.json`,
    `release-evidence-${VERSION}.provisional.json`,
  ];
  for (const filename of topLevel) {
    const privateEvidence = filename === `release-evidence-${VERSION}.json`
      || filename === 'agent-release-gate-evidence.json';
    writeFileSync(path.join(artifactsDir, filename), filename, privateEvidence ? { mode: 0o600 } : undefined);
  }
  for (const { filename } of Object.values(RUNTIME_EVIDENCE_CONTRACTS)) {
    writeFileSync(path.join(runtimeEvidenceDir, filename), filename);
  }
  try {
    const listed = listReleaseArtifactFiles({ root, artifactsDir, packageVersion: VERSION });
    assert.equal(listed.length, topLevel.length + Object.keys(RUNTIME_EVIDENCE_CONTRACTS).length);
    assert.equal(listed.every((relativePath) => statSync(path.join(root, relativePath)).isFile()), true);
    assert.equal(listed.some((relativePath) => relativePath.endsWith('runtime-evidence')), false);
    chmodSync(path.join(artifactsDir, 'agent-release-gate-evidence.json'), 0o644);
    assert.throws(
      () => listReleaseArtifactFiles({ root, artifactsDir, packageVersion: VERSION }),
      /release gate evidence must use mode 0600/,
    );
    chmodSync(path.join(artifactsDir, 'agent-release-gate-evidence.json'), 0o600);

    const temporary = path.join(artifactsDir, 'private-capture.tmp');
    rmSync(path.join(artifactsDir, 'agent-release-gate-evidence.json'));
    assert.equal(listReleaseArtifactFiles({ root, artifactsDir, packageVersion: VERSION, publicationState: 'final_only' }).length, listed.length - 1);
    rmSync(path.join(artifactsDir, `release-evidence-${VERSION}.json`));
    assert.equal(listReleaseArtifactFiles({ root, artifactsDir, packageVersion: VERSION, publicationState: 'unpublished' }).length, listed.length - 2);
    writeFileSync(path.join(artifactsDir, `release-evidence-${VERSION}.json`), 'final', { mode: 0o600 });
    writeFileSync(path.join(artifactsDir, 'agent-release-gate-evidence.json'), 'gate', { mode: 0o600 });

    writeFileSync(temporary, 'private');
    assert.throws(() => listReleaseArtifactFiles({ root, artifactsDir, packageVersion: VERSION }), /inventory contains missing, extra, private, temporary, or nested files/);
    rmSync(temporary);
    const unexpectedDirectory = path.join(artifactsDir, 'private');
    mkdirSync(unexpectedDirectory);
    assert.throws(() => listReleaseArtifactFiles({ root, artifactsDir, packageVersion: VERSION }), /Unexpected release artifact directory/);
    rmSync(unexpectedDirectory, { recursive: true });


    const runtimeFile = path.join(runtimeEvidenceDir, Object.values(RUNTIME_EVIDENCE_CONTRACTS)[0].filename);
    rmSync(runtimeFile);
    symlinkSync(path.join(artifactsDir, 'agent-runtime-verification.json'), runtimeFile);
    assert.throws(() => listReleaseArtifactFiles({ root, artifactsDir, packageVersion: VERSION }), /must not be a symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finalizer blocks without explicit approval before reading or writing the run root', () => {
  let touched = false;
  assert.throws(
    () => finalizeAgentRelease({
      root: '/does/not/matter',
      packageVersion: VERSION,
      env: {},
      operations: { git: () => { touched = true; return ''; } },
    }),
    /GSM_VERSION_APPROVAL/,
  );
  assert.equal(touched, false);
});
