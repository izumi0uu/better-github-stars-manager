#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import {
  FIREFOX_RELEASE_MANUAL_EXCLUSIONS,
  normalizeReleaseBrowserTarget,
  planEvidencePublication,
  prepareReleaseFinalization,
  RELEASE_MANUAL_EXCLUSIONS,
  RUNTIME_EVIDENCE_CONTRACTS,
  validatePublishedReleaseGate,
  validateReleaseVersionApproval,
} from './agent-runtime-release-evidence.mjs';
import { readRuntimeReleaseDistIdentity } from './agent-runtime-evidence-contract.mjs';
import { packageInputFingerprint } from './package-input-fingerprint.mjs';
import { readZipInventory } from './package-extension.mjs';
import {
  classifyForbiddenPackageEntry,
  validateManifestResourceClosure,
} from './package-manifest-closure.mjs';
import { assertFirefoxManifestContract } from './check-firefox-output-contracts.mjs';
import { validateFirefoxReviewerSourceArtifact } from './package-firefox-review-source.mjs';

const EXPECTED_SCENARIO_IDS = Object.freeze([
  'small-window-multiple-tools',
  'overflow-then-success',
  'malformed-summary-fallback',
  'cancel-during-compaction',
  'agent-port-disconnect',
  'organize-cross-batch-recovery',
  'organize-cancel-during-apply',
  'organize-port-reconnect',
  'cubby-artifact-continuation-coverage',
]);

export function finalizeAgentRelease({
  root = process.cwd(),
  env = process.env,
  packageVersion = pkg.version,
  operations = {},
} = {}) {
  const resolvedRoot = path.resolve(root);
  const browserTarget = resolveRequestedBrowserTarget(env);
  const distDir = path.resolve(resolvedRoot, env.GSM_DIST_DIR ?? (browserTarget === 'firefox' ? 'dist-firefox' : 'dist'));
  const artifactsDir = path.resolve(resolvedRoot, env.GSM_ARTIFACTS_DIR ?? (browserTarget === 'firefox' ? 'artifacts/firefox' : 'artifacts'));
  const runtimeEvidenceDir = path.resolve(resolvedRoot, env.GSM_RUNTIME_EVIDENCE_DIR ?? path.join(artifactsDir, 'runtime-evidence'));
  const versionApproval = parseVersionApproval(env.GSM_VERSION_APPROVAL);
  validateReleaseVersionApproval(versionApproval, packageVersion);
  const defaults = createDefaultOperations(resolvedRoot);
  const ops = { ...defaults, ...operations };
  assertFreshFinalizationRoot(resolvedRoot, artifactsDir, runtimeEvidenceDir);
  assertCleanSource(ops.git, 'Release evidence can be finalized only from a clean source tree.');
  const sourceCommit = ops.git(['rev-parse', 'HEAD']);
  const paths = {
    provisional: path.join(artifactsDir, `release-evidence-${packageVersion}.provisional.json`),
    runtime: path.join(artifactsDir, 'agent-runtime-verification.json'),
    final: path.join(artifactsDir, `release-evidence-${packageVersion}.json`),
    gate: path.join(artifactsDir, 'agent-release-gate-evidence.json'),
  };
  assert.notEqual(paths.provisional, paths.final, 'Provisional and final release evidence must be distinct files.');

  const provisionalRaw = readRequired(paths.provisional, 'Missing immutable provisional release evidence.');
  const runtimeVerificationRaw = readRequired(paths.runtime, 'Missing Agent runtime verification evidence.');
  assertMode0600(paths.provisional, 'provisional release evidence');
  assertMode0600(paths.runtime, 'runtime verification evidence');
  const provisional = parseCanonical(provisionalRaw, 'provisional release evidence');
  const runtimeVerification = parseCanonical(runtimeVerificationRaw, 'runtime verification evidence');
  const releaseDist = ops.readReleaseDist(distDir);
  const sharedRuntimeReleaseDist = browserTarget === 'firefox'
    ? ops.readReleaseDist(path.resolve(resolvedRoot, 'dist'))
    : undefined;
  const packageInput = ops.fingerprint(distDir);
  const packageArtifacts = ops.validatePackageArtifacts({
    root: resolvedRoot,
    artifactsDir,
    distDir,
    provisional,
    packageVersion,
    browserTarget,
  });
  const runtimeEvidenceRaw = {};
  for (const [key, contract] of Object.entries(RUNTIME_EVIDENCE_CONTRACTS)) {
    const evidencePath = path.join(runtimeEvidenceDir, contract.filename);
    runtimeEvidenceRaw[key] = readRequired(evidencePath, `Missing runtime evidence: ${contract.filename}`);
    assertMode0600(evidencePath, `runtime evidence ${contract.filename}`);
  }

  const relativePaths = {
    provisional: path.basename(paths.provisional),
    runtime: path.basename(paths.runtime),
    final: path.basename(paths.final),
    gate: path.basename(paths.gate),
  };
  const prepared = ops.prepareFinalization({
    provisionalRaw,
    provisionalRelativePath: relativePaths.provisional,
    runtimeVerificationRaw,
    runtimeVerificationRelativePath: relativePaths.runtime,
    runtimeEvidenceRaw,
    releaseDist,
    sharedRuntimeReleaseDist,
    sourceCommit,
    packageVersion,
    packageInput,
    browserTarget,
    versionApproval,
    expectedScenarioIds: EXPECTED_SCENARIO_IDS,
    packagedManifestVersion: packageArtifacts.packagedManifestVersion,
    zipManifestVersion: packageArtifacts.zipManifestVersion,
    publicationTimestamp: runtimeVerification.generatedAt,
    finalRelativePath: relativePaths.final,
    gateRelativePath: relativePaths.gate,
    manualExclusions: browserTarget === 'firefox' ? FIREFOX_RELEASE_MANUAL_EXCLUSIONS : RELEASE_MANUAL_EXCLUSIONS,
  });
  const existing = {};
  if (existsSync(paths.final)) {
    assertMode0600(paths.final, 'existing final release evidence');
    existing.final = readFileSync(paths.final);
  }
  if (existsSync(paths.gate)) {
    assertMode0600(paths.gate, 'existing release gate evidence');
    existing.gate = readFileSync(paths.gate);
  }
  const plan = ops.planPublication(prepared, relativePaths, ops.transactionId(), existing);

  ops.validatePublishedGate({
    finalRaw: prepared.final?.bytes,
    gateRaw: prepared.gate?.bytes,
    finalRelativePath: relativePaths.final,
    packageVersion,
    releaseDist,
    packagedManifestVersion: packageArtifacts.packagedManifestVersion,
    zipManifestVersion: packageArtifacts.zipManifestVersion,
    browserTarget,
  });
  assert.deepEqual(readFileSync(paths.provisional), provisionalRaw, 'Finalization must not mutate provisional evidence.');
  cleanupOwnedPublicationTemps({ artifactsDir, paths, prepared, existing });
  ops.validateArtifactInventory({
    root: resolvedRoot,
    artifactsDir,
    packageVersion,
    publicationState: existing.gate ? 'published' : existing.final ? 'final_only' : 'unpublished',
    browserTarget,
  });
  assertCleanSource(ops.git, 'Release finalization did not end from a clean source tree.');
  assert.equal(ops.git(['rev-parse', 'HEAD']), sourceCommit, 'Source commit changed during release finalization.');
  assert.deepEqual(ops.fingerprint(distDir), packageInput, 'Package input changed during release finalization.');

  const result = Object.freeze({ artifactsDir, paths: Object.freeze(paths), status: plan.status });
  publishFinalEvidence({ artifactsDir, paths, plan });
  return result;
}

export function publishFinalEvidence({ artifactsDir, paths, plan }) {
  const resolvedArtifacts = path.resolve(artifactsDir);
  const publicationPaths = {};
  for (const key of ['provisional', 'runtime', 'final', 'gate']) {
    const candidate = paths?.[key];
    if (typeof candidate !== 'string') throw new Error(`Missing ${key} evidence publication path.`);
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== resolvedArtifacts) throw new Error(`The ${key} evidence path must be a direct child of the run root.`);
    publicationPaths[key] = resolved;
  }
  if (new Set(Object.values(publicationPaths)).size !== 4) {
    throw new Error('Evidence publication paths must be distinct.');
  }

  const expectedSequences = {
    already_published: [],
    publish_required: ['writeExclusive:final', 'writeExclusive:gate', 'rename:final', 'rename:gate'],
    recover_gate: ['writeExclusive:gate', 'rename:gate'],
  };
  const expectedSequence = expectedSequences[plan?.status];
  if (!expectedSequence || !Array.isArray(plan.actions) || !Array.isArray(plan.cleanup)) {
    throw new Error('Evidence publication plan is invalid.');
  }
  const actualSequence = plan.actions.map((action) => `${action?.operation}:${action?.kind}`);
  if (actualSequence.length !== expectedSequence.length
    || actualSequence.some((value, index) => value !== expectedSequence[index])) {
    throw new Error('Evidence publication action sequence is invalid.');
  }

  const resolveActionPath = (candidate) => {
    if (typeof candidate !== 'string') throw new Error('Evidence publication action path is invalid.');
    const resolved = path.resolve(resolvedArtifacts, candidate);
    if (path.dirname(resolved) !== resolvedArtifacts) throw new Error('Evidence publication escaped the run root.');
    return resolved;
  };
  const actions = plan.actions.map((action) => {
    if (action.operation === 'writeExclusive') {
      if (action.mode !== 0o600 || typeof action.bytes !== 'string' || Buffer.byteLength(action.bytes) === 0) {
        throw new Error('Evidence publication write must contain non-empty mode-0600 bytes.');
      }
      return { ...action, path: resolveActionPath(action.path) };
    }
    return { ...action, from: resolveActionPath(action.from), to: resolveActionPath(action.to) };
  });
  const writes = new Map(actions
    .filter(({ operation }) => operation === 'writeExclusive')
    .map((action) => [action.kind, action]));
  const renames = new Map(actions
    .filter(({ operation }) => operation === 'rename')
    .map((action) => [action.kind, action]));
  if (writes.size * 2 !== actions.length || renames.size !== writes.size) {
    throw new Error('Evidence publication actions must contain one write and rename per output.');
  }
  for (const [kind, write] of writes) {
    const rename = renames.get(kind);
    if (!rename || rename.from !== write.path || rename.to !== publicationPaths[kind]) {
      throw new Error(`Evidence publication ${kind} path binding is invalid.`);
    }
    if (!write.path.endsWith('.tmp') || Object.values(publicationPaths).includes(write.path)) {
      throw new Error(`Evidence publication ${kind} temporary path is invalid.`);
    }
  }
  const cleanup = plan.cleanup.map(resolveActionPath);
  if (cleanup.length !== writes.size
    || new Set(cleanup).size !== cleanup.length
    || cleanup.some((temporary) => ![...writes.values()].some((write) => write.path === temporary))) {
    throw new Error('Evidence publication cleanup identity is invalid.');
  }
  if (actions.length === 0) return;

  const gateRename = actions.at(-1);
  try {
    for (const action of actions.slice(0, -1)) {
      if (action.operation === 'writeExclusive') {
        writeFileSync(action.path, action.bytes, { flag: 'wx', mode: action.mode });
        chmodSync(action.path, 0o600);
        assertMode0600(action.path, `${action.kind} publication temp`);
      } else {
        renameSync(action.from, action.to);
      }
    }
  } catch (error) {
    for (const temporary of cleanup) rmSync(temporary, { force: true });
    throw error;
  }
  try {
    renameSync(gateRename.from, gateRename.to);
  } catch (error) {
    rmSync(gateRename.from, { force: true });
    throw error;
  }
}

export function cleanupOwnedPublicationTemps({ artifactsDir, paths, prepared, existing }) {
  const entries = readdirSync(artifactsDir, { withFileTypes: true })
    .filter(({ name }) => name.endsWith('.tmp'));
  if (entries.length === 0) return Object.freeze([]);
  const destinations = new Map([
    [path.basename(paths.final), 'final'],
    [path.basename(paths.gate), 'gate'],
  ]);
  const candidates = [];
  for (const entry of entries) {
    const match = /^(.*\.json)\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.tmp$/u.exec(entry.name);
    const kind = match ? destinations.get(match[1]) : undefined;
    if (!match || !kind) throw new Error(`Foreign publication temp file: ${entry.name}`);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Publication temp must be a regular file: ${entry.name}`);
    const absolutePath = path.join(artifactsDir, entry.name);
    const stats = lstatSync(absolutePath);
    if ((stats.mode & 0o777) !== 0o600) throw new Error(`Publication temp must use mode 0600: ${entry.name}`);
    const expected = Buffer.from(prepared[kind]?.bytes ?? '');
    const actual = readFileSync(absolutePath);
    if (expected.byteLength === 0 || !actual.equals(expected)) {
      throw new Error(`Publication temp identity mismatch: ${entry.name}`);
    }
    candidates.push({ name: entry.name, path: absolutePath, kind, transactionId: match[2] });
  }
  if (new Set(candidates.map(({ transactionId }) => transactionId)).size !== 1) {
    throw new Error('Publication temp transaction is ambiguous.');
  }
  if (new Set(candidates.map(({ kind }) => kind)).size !== candidates.length) {
    throw new Error('Publication temp kind is ambiguous.');
  }
  if (existing.gate) throw new Error('Published gate must not coexist with publication temps.');
  const kinds = new Set(candidates.map(({ kind }) => kind));
  if (existing.final && kinds.has('final')) throw new Error('Published final must not coexist with a final temp.');
  if (!existing.final && kinds.has('gate') && !kinds.has('final')) {
    throw new Error('Gate temp without a final publication identity is ambiguous.');
  }
  for (const candidate of candidates) rmSync(candidate.path);
  const remaining = readdirSync(artifactsDir).filter((name) => name.endsWith('.tmp'));
  if (remaining.length > 0) throw new Error('Publication temp cleanup was incomplete.');
  return Object.freeze(candidates.map(({ name }) => name).sort(bytewiseCompare));
}

export function listReleaseArtifactFiles({
  root = process.cwd(),
  artifactsDir,
  packageVersion = pkg.version,
  publicationState = 'published',
  browserTarget = 'chrome',
} = {}) {
  const target = normalizeReleaseBrowserTarget(browserTarget);
  const resolvedRoot = path.resolve(root);
  const resolvedArtifacts = path.resolve(artifactsDir ?? path.join(resolvedRoot, target === 'firefox' ? 'artifacts/firefox' : 'artifacts'));
  if (resolvedArtifacts !== resolvedRoot && !resolvedArtifacts.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Release artifact root must stay inside the repository.');
  }
  const artifactsStats = lstatSync(resolvedArtifacts);
  if (artifactsStats.isSymbolicLink() || !artifactsStats.isDirectory()) {
    throw new Error('Release artifact root must be a real directory.');
  }
  if (!['unpublished', 'final_only', 'published'].includes(publicationState)) {
    throw new Error('Release artifact publication state is invalid.');
  }
  const baseName = target === 'firefox'
    ? `better-github-stars-manager-firefox-${packageVersion}`
    : `better-github-stars-manager-${packageVersion}`;
  const expected = [
    'agent-runtime-verification.json',
    `${baseName}.zip`,
    `${baseName}.zip.sha256`,
    ...(target === 'firefox' ? [`${baseName}-source.zip`, `${baseName}-source.zip.sha256`] : []),
    `release-evidence-${packageVersion}.provisional.json`,
    ...(publicationState === 'final_only' || publicationState === 'published'
      ? [`release-evidence-${packageVersion}.json`]
      : []),
    ...(publicationState === 'published' ? ['agent-release-gate-evidence.json'] : []),
    ...Object.values(RUNTIME_EVIDENCE_CONTRACTS).map(({ filename }) => `runtime-evidence/${filename}`),
  ].sort(bytewiseCompare);
  const actual = [];
  const visit = (relativeDirectory) => {
    const directory = path.join(resolvedArtifacts, ...relativeDirectory.split('/').filter(Boolean));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Release artifact must not be a symlink: ${relativePath}`);
      if (entry.isDirectory()) {
        if (relativePath !== 'runtime-evidence') throw new Error(`Unexpected release artifact directory: ${relativePath}`);
        visit(relativePath);
      } else if (entry.isFile()) {
        actual.push(relativePath);
      } else {
        throw new Error(`Release artifact must be a regular file: ${relativePath}`);
      }
    }
  };
  visit('');
  actual.sort(bytewiseCompare);
  assert.deepEqual(actual, expected, 'Release artifact inventory contains missing, extra, private, temporary, or nested files.');
  if (publicationState === 'final_only' || publicationState === 'published') {
    assertMode0600(path.join(resolvedArtifacts, `release-evidence-${packageVersion}.json`), 'final release evidence');
  }
  if (publicationState === 'published') {
    assertMode0600(path.join(resolvedArtifacts, 'agent-release-gate-evidence.json'), 'release gate evidence');
  }
  return Object.freeze(actual.map((relativePath) => path.relative(
    resolvedRoot,
    path.join(resolvedArtifacts, ...relativePath.split('/')),
  ).split(path.sep).join('/')));
}

export function listPublicReleaseAssetFiles({
  root = process.cwd(),
  artifactsDir,
  packageVersion = pkg.version,
  browserTarget = 'chrome',
} = {}) {
  const target = normalizeReleaseBrowserTarget(browserTarget);
  const resolvedRoot = path.resolve(root);
  const resolvedArtifacts = path.resolve(
    artifactsDir ?? path.join(resolvedRoot, target === 'firefox' ? 'artifacts/firefox' : 'artifacts'),
  );
  assertDirectoryInsideRoot(resolvedRoot, resolvedArtifacts, 'Public release artifact root');
  const names = publicReleaseAssetNames(packageVersion, target);
  const files = names.map((name) => resolveEvidenceFile(resolvedArtifacts, name));
  assertPublicReleaseChecksums(resolvedArtifacts, names);
  return Object.freeze(files.map((filePath) => path.relative(resolvedRoot, filePath).split(path.sep).join('/')));
}

export function verifyPublicReleaseAssetDirectory({
  root = process.cwd(),
  directory = 'release-files',
  packageVersion = pkg.version,
  browserTarget = 'all',
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(resolvedRoot, directory);
  assertDirectoryInsideRoot(resolvedRoot, resolvedDirectory, 'Combined public release directory');
  const directoryStats = lstatSync(resolvedDirectory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error('Combined public release directory must be a real directory.');
  }
  const expected = publicReleaseTargets(browserTarget)
    .flatMap((target) => publicReleaseAssetNames(packageVersion, target))
    .sort(bytewiseCompare);
  const actual = readdirSync(resolvedDirectory, { withFileTypes: true }).map((entry) => {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Public release asset must be a regular file: ${entry.name}`);
    }
    return entry.name;
  }).sort(bytewiseCompare);
  assert.deepEqual(actual, expected, 'Public release asset directory contains missing, extra, or nested files.');
  assertPublicReleaseChecksums(resolvedDirectory, expected);
  return Object.freeze(expected.map((name) => path.relative(
    resolvedRoot,
    path.join(resolvedDirectory, name),
  ).split(path.sep).join('/')));
}

function publicReleaseAssetNames(packageVersion, browserTarget) {
  const target = normalizeReleaseBrowserTarget(browserTarget);
  const baseName = target === 'firefox'
    ? `better-github-stars-manager-firefox-${packageVersion}`
    : `better-github-stars-manager-${packageVersion}`;
  return [
    `${baseName}.zip`,
    `${baseName}.zip.sha256`,
    ...(target === 'firefox' ? [`${baseName}-source.zip`, `${baseName}-source.zip.sha256`] : []),
  ].sort(bytewiseCompare);
}

function publicReleaseTargets(browserTarget) {
  if (browserTarget === 'all') return Object.freeze(['chrome', 'firefox']);
  return Object.freeze([normalizeReleaseBrowserTarget(browserTarget)]);
}

function assertDirectoryInsideRoot(root, directory, label) {
  if (directory === root || !directory.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must stay inside the repository.`);
  }
}

function assertPublicReleaseChecksums(directory, names) {
  for (const checksumName of names.filter((name) => name.endsWith('.zip.sha256'))) {
    const zipName = checksumName.slice(0, -'.sha256'.length);
    const zipPath = resolveEvidenceFile(directory, zipName);
    const checksumPath = resolveEvidenceFile(directory, checksumName);
    const zipBytes = readFileSync(zipPath);
    assert.ok(zipBytes.byteLength > 0, `Public release ZIP is empty: ${zipName}`);
    assert.equal(
      readFileSync(checksumPath, 'utf8'),
      `${hash(zipBytes)}  ${zipName}\n`,
      `Public release checksum is stale: ${checksumName}`,
    );
  }
}

export function validatePackageArtifacts({ root, artifactsDir, distDir, provisional, packageVersion, browserTarget = 'chrome' }) {
  const target = normalizeReleaseBrowserTarget(browserTarget);
  if ((target === 'firefox') !== (provisional?.schemaVersion === 3 && provisional?.browserTarget === 'firefox')) {
    throw new Error('Provisional evidence browser target/schema does not match the requested release target.');
  }
  const generated = provisional.generatedFiles;
  if (!Array.isArray(generated)) throw new Error('Provisional evidence has no generated file inventory.');
  const baseName = target === 'firefox'
    ? `better-github-stars-manager-firefox-${packageVersion}`
    : `better-github-stars-manager-${packageVersion}`;
  const expectedGeneratedFiles = [
    `${baseName}.zip`,
    `${baseName}.zip.sha256`,
    ...(target === 'firefox' ? [`${baseName}-source.zip`, `${baseName}-source.zip.sha256`] : []),
  ].sort(bytewiseCompare);
  assert.deepEqual(
    generated.map((file) => file?.relativePath),
    expectedGeneratedFiles,
    'Provisional evidence must name the exact canonical ZIP and checksum inventory.',
  );
  for (const file of generated) {
    const absolutePath = resolveEvidenceFile(artifactsDir, file.relativePath);
    const bytes = readFileSync(absolutePath);
    assert.equal(bytes.byteLength, file.bytes, `Packaged artifact size is stale: ${file.relativePath}`);
    assert.equal(hash(bytes), file.sha256, `Packaged artifact digest is stale: ${file.relativePath}`);
  }
  const zipEvidence = generated.find((file) => file.relativePath === `${baseName}.zip`);
  const checksumEvidence = generated.find((file) => file.relativePath === `${baseName}.zip.sha256`);
  assert.ok(zipEvidence && checksumEvidence, 'Release evidence must include the exact extension ZIP and checksum pair.');
  const zipPath = resolveEvidenceFile(artifactsDir, zipEvidence.relativePath);
  const checksumPath = resolveEvidenceFile(artifactsDir, checksumEvidence.relativePath);
  assert.equal(readFileSync(checksumPath, 'utf8'), `${zipEvidence.sha256}  ${path.basename(zipPath)}\n`, 'ZIP checksum contents are stale.');

  if (target === 'firefox') {
    const sourceZipPath = resolveEvidenceFile(artifactsDir, `${baseName}-source.zip`);
    const sourceChecksumPath = resolveEvidenceFile(artifactsDir, `${baseName}-source.zip.sha256`);
    validateFirefoxReviewerSourceArtifact({
      zipPath: sourceZipPath,
      checksumPath: sourceChecksumPath,
      evidence: provisional.reviewerSource,
    });
  }

  const packageEntries = readZipInventory(zipPath);
  for (const entry of packageEntries) {
    assert.equal(classifyForbiddenPackageEntry(entry.relativePath), null, `Forbidden packaged entry: ${entry.relativePath}`);
  }
  const manifestEntry = packageEntries.find((entry) => entry.relativePath === 'manifest.json');
  assert.ok(manifestEntry, 'ZIP must contain manifest.json at its root.');
  const zipManifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
  const distManifestBytes = readFileSync(path.join(distDir, 'manifest.json'));
  const distManifest = JSON.parse(distManifestBytes.toString('utf8'));
  if (target === 'firefox') assertFirefoxManifestContract(distManifest);
  assert.equal(zipManifest.version, packageVersion, 'ZIP manifest version differs from the approved package version.');
  assert.deepEqual(zipManifest, distManifest, 'ZIP manifest differs from the exercised production manifest.');
  assert.deepEqual(manifestEntry.bytes, distManifestBytes, 'ZIP manifest bytes differ from the exercised production manifest.');
  assert.equal(provisional.packagedManifest.relativePath, 'manifest.json');
  assert.equal(provisional.packagedManifest.bytes, distManifestBytes.byteLength, 'Packaged manifest size is stale.');
  assert.equal(provisional.packagedManifest.sha256, hash(distManifestBytes), 'Packaged manifest digest is stale.');

  const closure = validateManifestResourceClosure({ manifest: distManifest, packageEntries });
  const expectedResources = [...closure.resources]
    .sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath));
  assert.deepEqual(provisional.manifestResources, expectedResources, 'Manifest resource evidence is stale or incomplete.');
  assert.equal(provisional.package.zipRootManifest, true);
  assert.equal(provisional.package.manifestResourcesClosed, true);
  assert.equal(provisional.package.sourceOnlyEntriesExcluded, true);
  if (target === 'firefox') {
    assert.equal(provisional.package.remoteExecutableCodeExcluded, true);
    assert.equal(provisional.package.publicationClaimed, false);
  } else {
    assert.equal(provisional.package.dashboardSubmissionClaimed, false);
  }
  const expectedPermissions = {
    permissions: sortedStrings(distManifest.permissions),
    optionalPermissions: sortedStrings(distManifest.optional_permissions),
    hostPermissions: sortedStrings(distManifest.host_permissions),
    optionalHostPermissions: sortedStrings(distManifest.optional_host_permissions),
    ...(target === 'firefox' ? {
      dataCollectionPermissions: {
        required: sortedStrings(
          distManifest.browser_specific_settings.gecko.data_collection_permissions.required,
        ),
        optional: sortedStrings(
          distManifest.browser_specific_settings.gecko.data_collection_permissions.optional,
        ),
      },
    } : {}),
  };
  assert.deepEqual(provisional.packagedPermissions, expectedPermissions);
  return Object.freeze({ packagedManifestVersion: distManifest.version, zipManifestVersion: zipManifest.version });
}

function createDefaultOperations(root) {
  return {
    git: (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(),
    now: () => new Date().toISOString(),
    transactionId: () => `${process.pid}-${randomBytes(6).toString('hex')}`,
    fingerprint: packageInputFingerprint,
    readReleaseDist: readRuntimeReleaseDistIdentity,
    validatePackageArtifacts,
    validateArtifactInventory: listReleaseArtifactFiles,
    prepareFinalization: prepareReleaseFinalization,
    planPublication: planEvidencePublication,
    validatePublishedGate: validatePublishedReleaseGate,
  };
}

function resolveRequestedBrowserTarget(env) {
  const packageTarget = env.GSM_PACKAGE_TARGET === undefined
    ? undefined
    : normalizeReleaseBrowserTarget(env.GSM_PACKAGE_TARGET);
  const runtimeTarget = env.GSM_BROWSER_TARGET === undefined
    ? undefined
    : normalizeReleaseBrowserTarget(env.GSM_BROWSER_TARGET);
  if (packageTarget && runtimeTarget && packageTarget !== runtimeTarget) {
    throw new Error('GSM_PACKAGE_TARGET and GSM_BROWSER_TARGET must identify the same browser.');
  }
  return packageTarget ?? runtimeTarget ?? 'chrome';
}


function assertFreshFinalizationRoot(root, artifactsDir, runtimeEvidenceDir) {
  if (artifactsDir === root || !artifactsDir.startsWith(`${root}${path.sep}`)) {
    throw new Error('GSM_ARTIFACTS_DIR must be a run-scoped directory inside the repository.');
  }
  if (runtimeEvidenceDir !== path.join(artifactsDir, 'runtime-evidence')) {
    throw new Error('GSM_RUNTIME_EVIDENCE_DIR must be the canonical runtime-evidence directory inside GSM_ARTIFACTS_DIR.');
  }
  for (const [label, directory] of [['GSM_ARTIFACTS_DIR', artifactsDir], ['GSM_RUNTIME_EVIDENCE_DIR', runtimeEvidenceDir]]) {
    if (!existsSync(directory)) throw new Error(`${label} does not exist.`);
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  }
}

function resolveEvidenceFile(artifactsDir, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new Error('Evidence file path must be relative.');
  const resolved = path.resolve(artifactsDir, relativePath);
  if (path.dirname(resolved) !== artifactsDir) throw new Error(`Evidence path escaped the run root: ${relativePath}`);
  const entry = lstatSync(resolved);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Evidence path is not a regular file: ${relativePath}`);
  return resolved;
}

function readRequired(filePath, message) {
  if (!existsSync(filePath)) throw new Error(message);
  const entry = lstatSync(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Evidence input must be a regular file: ${path.basename(filePath)}`);
  }
  return readFileSync(filePath);
}

function parseCanonical(raw, label) {
  const text = raw.toString('utf8');
  const value = JSON.parse(text);
  if (`${JSON.stringify(value, null, 2)}\n` !== text) throw new Error(`${label} must use canonical JSON bytes.`);
  return value;
}

function parseVersionApproval(serialized) {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new Error('GSM_VERSION_APPROVAL must contain the explicit approved candidate version decision.');
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error('GSM_VERSION_APPROVAL must be valid JSON.');
  }
}

function assertCleanSource(git, message) {
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error(message);
}

function assertMode0600(filePath, label) {
  const entry = lstatSync(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  if ((entry.mode & 0o777) !== 0o600) throw new Error(`${label} must use mode 0600.`);
}

function sortedStrings(value) {
  return Array.isArray(value) ? [...new Set(value)].sort(bytewiseCompare) : [];
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, firstArgument, secondArgument, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0) throw new Error('Too many release artifact arguments.');
  if (command === '--list-release-artifacts' && secondArgument === undefined) {
    const browserTarget = firstArgument ?? 'chrome';
    process.stdout.write(`${listReleaseArtifactFiles({ browserTarget }).join('\n')}\n`);
  } else if (command === '--list-public-release-assets' && secondArgument === undefined) {
    const browserTarget = firstArgument ?? 'chrome';
    process.stdout.write(`${listPublicReleaseAssetFiles({ browserTarget }).join('\n')}\n`);
  } else if (command === '--verify-public-release-directory' && firstArgument) {
    const browserTarget = secondArgument ?? 'all';
    process.stdout.write(`${verifyPublicReleaseAssetDirectory({
      directory: firstArgument,
      browserTarget,
    }).join('\n')}\n`);
  } else if (command === undefined) {
    finalizeAgentRelease();
  } else {
    throw new Error(
      'Usage: verify-agent-release-gates.mjs [--list-release-artifacts [chrome|firefox] | --list-public-release-assets [chrome|firefox] | --verify-public-release-directory <directory> [chrome|firefox|all]]',
    );
  }
}
