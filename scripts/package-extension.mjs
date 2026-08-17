#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import {
  createPackageInputInventory,
  fingerprintPackageInventory,
} from './package-input-fingerprint.mjs';
import {
  readDeterministicZip,
  writeDeterministicZip,
} from './deterministic-zip.mjs';
import {
  compareChromeExtensionVersions,
  discoverMermaidArtifacts,
  EDGE_RELEASE_WORKER_BASELINE,
  enforceWorkerReleaseBaseline,
  measureBundleArtifact,
  normalizePackageRelativePath,
  parseChromeExtensionVersion,
  validateManifestResourceClosure,
  RELEASE_WORKER_BASELINE,
} from './package-manifest-closure.mjs';
import {
  FIREFOX_DIST_DIR,
  FIREFOX_GECKO_ID,
  FIREFOX_MIN_VERSION,
  FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS,
  FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS,
} from './build-firefox-extension.mjs';
import { assertFirefoxManifestContract } from './check-firefox-output-contracts.mjs';
import {
  assertEdgeManifestContract,
} from './check-edge-output-contracts.mjs';
import { EDGE_DIST_DIR } from './build-edge-extension.mjs';
import { normalizeProductStoreTarget } from '../product-target.config.ts';
import {
  parseViteChunkAdvisories,
  validateProvisionalReleaseEvidence,
} from './agent-runtime-release-evidence.mjs';
import { packageFirefoxReviewerSource } from './package-firefox-review-source.mjs';

const PUBLIC_EXTENSION_VERSION = '1.0.8';
const ZIP_EPOCH = new Date('1980-01-01T00:00:00.000Z');
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const versionHashPattern = /\b(?:[0-9a-f]{8}|unknown)-(?:clean|[0-9a-f]{6})-[0-9a-f]{6}\b/g;
const disclosureBundleMarkers = Object.freeze([
  'prompt_or_bounded_task_instruction',
  'selected_or_frozen_scope_public_repository_metadata',
  'selected_or_frozen_scope_public_repository_code_snippets',
  'selected_or_frozen_scope_private_notes',
  'visible_bounded_tag_taxonomy',
  'protocol_observations',
  'credentials_or_secrets',
  'github_token',
  'unrelated_or_out_of_scope_stars',
]);
const reviewedPermissions = Object.freeze({
  permissions: Object.freeze(['alarms', 'storage']),
  optionalPermissions: Object.freeze([]),
  hostPermissions: Object.freeze([
    'https://api.anthropic.com/*',
    'https://api.github.com/*',
    'https://api.openai.com/*',
    'https://github.com/*',
    'https://openrouter.ai/*',
  ]),
  optionalHostPermissions: Object.freeze([
    'http://127.0.0.1/*',
    'http://localhost/*',
    'https://*/*',
  ]),
});

export class PackageExtensionError extends Error {
  constructor(code, label = 'extension package') {
    super(`${code}: ${label}`);
    this.name = 'PackageExtensionError';
    this.code = code;
    this.label = label;
  }
}

export function packageExtension(options = {}) {
  const environment = options.environment ?? process.env;
  const root = path.resolve(options.root ?? process.cwd());
  const target = resolvePackageTarget(options.target, environment.GSM_PACKAGE_TARGET);
  assertMatchingStoreTarget(target, options.storeTarget ?? environment.GSM_STORE_TARGET);
  const distDir = path.resolve(root, options.distDir ?? environment.GSM_DIST_DIR ?? (
    target === 'firefox' ? FIREFOX_DIST_DIR : target === 'edge' ? EDGE_DIST_DIR : 'dist'
  ));
  const artifactsDir = path.resolve(root, options.artifactsDir ?? environment.GSM_ARTIFACTS_DIR ?? (
    target === 'firefox' ? path.join('artifacts', 'firefox') : target === 'edge' ? path.join('artifacts', 'edge') : 'artifacts'
  ));
  if (target === 'edge' && distDir === path.resolve(root, 'dist')) {
    throw new PackageExtensionError('edge_dist_directory_not_isolated');
  }
  if (target === 'edge' && artifactsDir === path.resolve(root, 'artifacts')) {
    throw new PackageExtensionError('edge_artifact_directory_not_isolated');
  }
  const packageVersion = options.packageVersion ?? pkg.version;
  const approvedVersion = options.approvedVersion ?? environment.GSM_APPROVED_RELEASE_VERSION;
  const workerBaseline = options.workerBaseline ?? (target === 'edge' ? EDGE_RELEASE_WORKER_BASELINE : RELEASE_WORKER_BASELINE);
  assertApprovedCandidateVersion(packageVersion, approvedVersion);

  const source = options.source ?? readCleanSource(root);
  assertCleanSource(source);
  const skipBuild = resolveSkipBuild(options.skipBuild, environment.GSM_SKIP_PACKAGE_BUILD);
  if (!skipBuild && (
    options.testedPackageInput !== undefined
    || environment.GSM_TESTED_PACKAGE_INPUT !== undefined
    || options.buildEvidence !== undefined
    || environment.GSM_RELEASE_BUILD_EVIDENCE !== undefined
  )) throw new PackageExtensionError('fresh_build_external_evidence_forbidden');
  let capturedBuildEvidence = null;
  if (!skipBuild) capturedBuildEvidence = runProductionBuild({ root, environment, target, runner: options.buildRunner });

  const inventory = createPackageInputInventory(distDir);
  const packageInput = fingerprintPackageInventory(inventory);
  const testedPackageInput = options.testedPackageInput
    ?? parseJsonInput(environment.GSM_TESTED_PACKAGE_INPUT, 'GSM_TESTED_PACKAGE_INPUT');
  if (skipBuild) assertTestedPackageInput(testedPackageInput, packageInput);

  const sourceManifest = parseRootManifest(inventory, 'source manifest');
  assertVersionIdentity(packageVersion, sourceManifest.version, approvedVersion);
  if (target === 'firefox') {
    assertFirefoxManifestContract(sourceManifest, { expectedVersion: packageVersion });
  }
  if (target === 'edge') {
    assertEdgeManifestContract(sourceManifest, { expectedVersion: packageVersion });
  }
  const permissions = readAndValidatePermissions(sourceManifest, target);
  assertProductionDisclosure(inventory);
  if (target === 'firefox' || target === 'edge') assertRemoteExecutableCodeExcluded(inventory);

  ensureArtifactDirectory(artifactsDir);
  const baseName = target === 'firefox'
    ? `better-github-stars-manager-firefox-${packageVersion}`
    : target === 'edge'
      ? `better-github-stars-manager-edge-${packageVersion}`
      : `better-github-stars-manager-${packageVersion}`;
  const zipPath = path.join(artifactsDir, `${baseName}.zip`);
  const finalEvidencePath = path.join(artifactsDir, `release-evidence-${packageVersion}.json`);
  const gatePath = path.join(artifactsDir, 'agent-release-gate-evidence.json');
  const checksumPath = path.join(artifactsDir, `${baseName}.zip.sha256`);
  const evidencePath = path.join(artifactsDir, `release-evidence-${packageVersion}.provisional.json`);
  assertFreshTargets([zipPath, checksumPath, evidencePath]);
  assertNoStaleTrustArtifacts([finalEvidencePath, gatePath]);

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'bgsm-package-'));
  const stageDir = path.join(workDir, 'stage');
  mkdirSync(stageDir);
  const zipTempPath = path.join(workDir, `${baseName}.zip`);
  const createdPaths = new Set();
  let reviewerSource = null;
  try {
    stagePackageInventory(inventory, stageDir);
    const stagedInventory = createPackageInputInventory(stageDir);
    assertSameInventory(inventory, stagedInventory, 'staged package');
    const stagedManifest = parseRootManifest(stagedInventory, 'staged manifest');
    assertExactManifestBytes(inventory, stagedInventory, 'staged manifest');
    const stagedClosure = validateManifestResourceClosure({
      manifest: stagedManifest,
      packageEntries: stagedInventory,
    });

    createZipFromInventory({ zipPath: zipTempPath, inventory: stagedInventory });
    const zipInventory = readZipInventory(zipTempPath);
    assertSameInventory(inventory, zipInventory, 'ZIP package');
    const zipManifest = parseRootManifest(zipInventory, 'ZIP manifest');
    assertExactManifestBytes(inventory, zipInventory, 'ZIP manifest');
    const zipClosure = validateManifestResourceClosure({
      manifest: zipManifest,
      packageEntries: zipInventory,
    });
    if (!isDeepStrictEqual(stagedClosure, zipClosure)) throw new PackageExtensionError('manifest_closure_mismatch');
    assertVersionIdentity(packageVersion, zipManifest.version, approvedVersion);
    readAndValidatePermissions(zipManifest, target);
    if (target === 'edge') assertEdgeManifestContract(zipManifest, { expectedVersion: packageVersion });

    const suppliedBuildEvidence = options.buildEvidence
      ?? parseJsonInput(environment.GSM_RELEASE_BUILD_EVIDENCE, 'GSM_RELEASE_BUILD_EVIDENCE');
    const measuredBuildEvidence = skipBuild
      ? suppliedBuildEvidence
      : completeCapturedBuildEvidence(capturedBuildEvidence, zipInventory, zipClosure.workerRelativePath);
    const build = validateBuildEvidence(measuredBuildEvidence, zipInventory, zipClosure.workerRelativePath, workerBaseline, target);

    const zipBytes = readFileSync(zipTempPath);
    writeOwnedFile(zipPath, zipBytes, createdPaths, 0o600);
    const zipDigest = hash(zipBytes);
    const checksumBytes = Buffer.from(`${zipDigest}  ${path.basename(zipPath)}\n`);
    writeOwnedFile(checksumPath, checksumBytes, createdPaths, 0o600);
    assertChecksum(checksumPath, zipPath);

    if (target === 'firefox') {
      reviewerSource = packageFirefoxReviewerSource({
        ...options.reviewerSourceOptions,
        root,
        artifactsDir,
        packageVersion,
        source,
        extensionZipPath: zipPath,
        reuseExisting: options.reuseReviewerSource === true,
      });
    }
    const generatedAt = options.generatedAt ?? new Date().toISOString();
    const evidence = createProvisionalReleaseEvidence({
      generatedAt,
      packageVersion,
      target,
      source,
      permissions,
      packageInput,
      build,
      zipPath,
      checksumPath,
      artifactsDir,
      manifestEntry: zipInventory.find(({ relativePath }) => relativePath === 'manifest.json'),
      manifestResources: zipClosure.resources,
      reviewerSource,
      manifest: zipManifest,
    });
    validateProvisionalReleaseEvidence(evidence, {
      sourceCommit: source.commit,
      packageVersion,
      packageInput,
      build,
      workerBaseline,
      packagedManifestVersion: zipManifest.version,
      zipManifestVersion: zipManifest.version,
      browserTarget: target,
    });
    writeOwnedFile(evidencePath, canonicalJson(evidence), createdPaths, 0o600);

    return Object.freeze({ zipPath, checksumPath, evidencePath, packageInput, build, evidence, reviewerSource });
  } catch (error) {
    for (const createdPath of createdPaths) rmSync(createdPath, { force: true });
    if (reviewerSource?.ownedPaths) {
      for (const createdPath of reviewerSource.ownedPaths) rmSync(createdPath, { force: true });
    }
    throw error;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function stagePackageInventory(inventory, stageDir) {
  fingerprintPackageInventory(inventory);
  for (const entry of inventory) {
    const absolutePath = path.join(stageDir, ...entry.relativePath.split('/'));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, entry.bytes, { flag: 'wx', mode: 0o644 });
    chmodSync(absolutePath, 0o644);
    utimesSync(absolutePath, ZIP_EPOCH, ZIP_EPOCH);
  }
}

export function validateZipEntryNames(entryNames) {
  if (!Array.isArray(entryNames) || entryNames.length === 0) {
    throw new PackageExtensionError('zip_entries_invalid');
  }
  const seen = new Set();
  const normalized = [];
  for (const [index, entryName] of entryNames.entries()) {
    if (typeof entryName !== 'string' || /[\u0000-\u001f\u007f]/u.test(entryName)) {
      throw new PackageExtensionError('zip_entry_path_invalid', String(entryName));
    }
    if (entryName.startsWith('-') || /[*?\[\]]/u.test(entryName)) {
      throw new PackageExtensionError('zip_entry_path_invalid', entryName);
    }
    let relativePath;
    try {
      relativePath = normalizePackageRelativePath(entryName, `zip entry ${index}`);
    } catch {
      throw new PackageExtensionError('zip_entry_path_invalid', String(entryName));
    }
    if (seen.has(relativePath)) throw new PackageExtensionError('zip_entry_duplicate', relativePath);
    seen.add(relativePath);
    normalized.push(relativePath);
  }
  if (!seen.has('manifest.json')) throw new PackageExtensionError('zip_root_manifest_missing');
  return Object.freeze(normalized);
}

export function findDevelopmentBuildHashes(javascriptSources) {
  if (!Array.isArray(javascriptSources) || javascriptSources.some((source) => typeof source !== 'string')) {
    throw new PackageExtensionError('bundled_javascript_invalid');
  }
  const matches = new Set();
  for (const source of javascriptSources) {
    for (const match of source.matchAll(versionHashPattern)) matches.add(match[0]);
  }
  return Object.freeze([...matches].sort(bytewiseCompare));
}

export function readZipInventory(zipPath) {
  const entries = readDeterministicZip(path.resolve(zipPath));
  const relativePaths = validateZipEntryNames(entries.map(({ relativePath }) => relativePath));
  return Object.freeze(entries.map((entry, index) => {
    const bytes = Buffer.from(entry.bytes);
    return Object.freeze({ relativePath: relativePaths[index], bytes, sha256: hash(bytes) });
  }));
}

export function createProvisionalReleaseEvidence(input) {
  if (input.target === 'edge') {
    return Object.freeze({
      schemaVersion: 4,
      browserTarget: 'edge',
      capabilities: Object.freeze({ gistSync: true, agent: true, organizeProvider: true }),
      generatedAt: input.generatedAt,
      packageVersion: input.packageVersion,
      source: Object.freeze({ commit: input.source.commit, dirty: false }),
      package: Object.freeze({
        releaseReady: false,
        releaseReadinessReason: 'edge_runtime_verification_required',
        publicationClaimed: false,
        zipRootManifest: true,
        manifestResourcesClosed: true,
        sourceOnlyEntriesExcluded: true,
        remoteExecutableCodeExcluded: true,
        productionDisclosureMarkers: disclosureBundleMarkers,
      }),
      packagedPermissions: input.permissions,
      packageInput: input.packageInput,
      build: input.build,
      generatedFiles: Object.freeze([
        fileEvidence(input.artifactsDir, input.checksumPath),
        fileEvidence(input.artifactsDir, input.zipPath),
      ].sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath))),
      packagedManifest: Object.freeze({
        relativePath: 'manifest.json',
        bytes: input.manifestEntry.bytes.byteLength,
        sha256: input.manifestEntry.sha256,
        browserTarget: 'edge',
      }),
      manifestResources: input.manifestResources,
    });
  }
  if (input.target !== 'firefox') {
    return Object.freeze({
      schemaVersion: 2,
      generatedAt: input.generatedAt,
      packageVersion: input.packageVersion,
      source: Object.freeze({ commit: input.source.commit, dirty: false }),
      package: Object.freeze({
        releaseReady: false,
        releaseReadinessReason: 'agent_runtime_verification_required',
        dashboardSubmissionClaimed: false,
        zipRootManifest: true,
        manifestResourcesClosed: true,
        sourceOnlyEntriesExcluded: true,
        productionDisclosureMarkers: disclosureBundleMarkers,
      }),
      packagedPermissions: input.permissions,
      packageInput: input.packageInput,
      build: input.build,
      generatedFiles: Object.freeze([
        fileEvidence(input.artifactsDir, input.checksumPath),
        fileEvidence(input.artifactsDir, input.zipPath),
      ].sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath))),
      packagedManifest: Object.freeze({
        relativePath: 'manifest.json',
        bytes: input.manifestEntry.bytes.byteLength,
        sha256: input.manifestEntry.sha256,
      }),
      manifestResources: input.manifestResources,
    });
  }
  const gecko = input.manifest.browser_specific_settings.gecko;
  return Object.freeze({
    schemaVersion: 3,
    browserTarget: 'firefox',
    generatedAt: input.generatedAt,
    packageVersion: input.packageVersion,
    source: Object.freeze({ commit: input.source.commit, dirty: false }),
    package: Object.freeze({
      releaseReady: false,
      releaseReadinessReason: 'agent_runtime_verification_required',
      publicationClaimed: false,
      zipRootManifest: true,
      manifestResourcesClosed: true,
      sourceOnlyEntriesExcluded: true,
      remoteExecutableCodeExcluded: true,
      productionDisclosureMarkers: disclosureBundleMarkers,
    }),
    packagedPermissions: input.permissions,
    packageInput: input.packageInput,
    build: input.build,
    generatedFiles: Object.freeze([
      fileEvidence(input.artifactsDir, input.checksumPath),
      fileEvidence(input.artifactsDir, input.zipPath),
      input.reviewerSource.archive,
      input.reviewerSource.checksum,
    ].sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath))),
    packagedManifest: Object.freeze({
      relativePath: 'manifest.json',
      bytes: input.manifestEntry.bytes.byteLength,
      sha256: input.manifestEntry.sha256,
      browserTarget: 'firefox',
      background: Object.freeze({
        kind: 'event_page',
        module: true,
        scripts: Object.freeze([...input.manifest.background.scripts]),
      }),
      gecko: Object.freeze({
        id: gecko.id,
        strictMinVersion: gecko.strict_min_version,
        dataCollectionPermissions: Object.freeze({
          required: Object.freeze([...gecko.data_collection_permissions.required]),
          optional: Object.freeze([...gecko.data_collection_permissions.optional]),
        }),
      }),
    }),
    reviewerSource: Object.freeze({
      archive: input.reviewerSource.archive,
      checksum: input.reviewerSource.checksum,
      readme: input.reviewerSource.readme,
      packageInput: input.reviewerSource.packageInput,
    }),
    manifestResources: input.manifestResources,
  });
}

export function resolvePackageTarget(option, environmentValue) {
  const optionTarget = option === undefined ? undefined : normalizeProductStoreTarget(option);
  const environmentTarget = environmentValue === undefined ? undefined : normalizeProductStoreTarget(environmentValue);
  if (optionTarget !== undefined && environmentTarget !== undefined && optionTarget !== environmentTarget) {
    throw new PackageExtensionError('package_target_mismatch', `${String(option)} != ${String(environmentValue)}`);
  }
  const target = optionTarget ?? environmentTarget ?? 'chrome';
  if (target !== 'chrome' && target !== 'firefox' && target !== 'edge') {
    throw new PackageExtensionError('package_target_invalid', String(target));
  }
  return target;
}
function assertMatchingStoreTarget(packageTarget, storeTargetValue) {
  if (storeTargetValue === undefined) return;
  const storeTarget = normalizeProductStoreTarget(storeTargetValue);
  if (storeTarget !== packageTarget) {
    throw new PackageExtensionError('package_store_target_mismatch', `${String(storeTargetValue)} != ${packageTarget}`);
  }
}
function resolveSkipBuild(option, environmentValue) {
  if (option !== undefined) {
    if (typeof option !== 'boolean') throw new PackageExtensionError('skip_build_invalid');
    return option;
  }
  if (environmentValue === undefined) return false;
  if (environmentValue !== 'true') throw new PackageExtensionError('skip_build_invalid', 'GSM_SKIP_PACKAGE_BUILD');
  return true;
}

function runProductionBuild({ root, environment, target, runner }) {
  if (runner) return runner(target);
  const pnpmExecPath = environment.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const script = target === 'firefox' ? 'build:firefox' : target === 'edge' ? 'build:edge' : 'build';
  const args = pnpmExecPath ? [pnpmExecPath, script] : ['pnpm', script];
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...environment,
      GSM_RELEASE: 'true',
      GSM_DEV: 'false',
      GSM_PACKAGE_TARGET: target,
      GSM_STORE_TARGET: target,
      ...(target === 'firefox' ? { GSM_DIST_DIR: FIREFOX_DIST_DIR } : target === 'edge' ? { GSM_DIST_DIR: EDGE_DIST_DIR } : {}),
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0 || result.signal) throw new PackageExtensionError('production_build_failed');
  const parsed = parseViteChunkAdvisories({ stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  return Object.freeze({ advisories: parsed.advisories, outputSha256: parsed.outputSha256 });
}
function completeCapturedBuildEvidence(captured, inventory, workerRelativePath) {
  const workerEntry = inventory.find(({ relativePath }) => relativePath === workerRelativePath);
  if (!workerEntry) throw new PackageExtensionError('worker_artifact_missing', workerRelativePath);
  return {
    worker: measureBundleArtifact(workerEntry),
    mermaid: discoverMermaidArtifacts(inventory),
    advisories: captured?.advisories,
    outputSha256: captured?.outputSha256,
  };
}


function validateBuildEvidence(value, inventory, workerRelativePath, workerBaseline, target) {
  if (!isPlainObject(value)) throw new PackageExtensionError('release_build_evidence_required');
  const expectedKeys = ['advisories', 'mermaid', 'outputSha256', 'worker'];
  if (!isDeepStrictEqual(Object.keys(value).sort(bytewiseCompare), expectedKeys)) {
    throw new PackageExtensionError('release_build_evidence_invalid');
  }
  const workerEntry = inventory.find(({ relativePath }) => relativePath === workerRelativePath);
  if (!workerEntry) throw new PackageExtensionError('worker_artifact_missing', workerRelativePath);
  const worker = measureBundleArtifact(workerEntry);
  enforceWorkerReleaseBaseline(worker, workerBaseline);
  const mermaid = discoverMermaidArtifacts(inventory);
  if (!isDeepStrictEqual(value.worker, worker) || !isDeepStrictEqual(value.mermaid, mermaid)) {
    throw new PackageExtensionError('release_bundle_evidence_mismatch');
  }
  if (!Array.isArray(value.advisories)) throw new PackageExtensionError('release_advisories_invalid');
  for (const advisory of value.advisories) {
    if (typeof advisory !== 'string') throw new PackageExtensionError('release_advisories_invalid');
    const parsed = parseViteChunkAdvisories({ stdout: advisory, stderr: '' });
    if (parsed.advisories.length !== 1 || parsed.advisories[0] !== advisory) {
      throw new PackageExtensionError('release_advisories_invalid');
    }
  }
  if (typeof value.outputSha256 !== 'string' || !SHA256.test(value.outputSha256)) {
    throw new PackageExtensionError('release_build_output_hash_invalid');
  }
  return Object.freeze({
    worker,
    mermaid,
    advisories: Object.freeze([...value.advisories]),
    outputSha256: value.outputSha256,
  });
}

function createZipFromInventory({ zipPath, inventory }) {
  if (inventory.length === 0) throw new PackageExtensionError('package_inventory_empty');
  writeDeterministicZip(zipPath, inventory);
}

function assertSameInventory(expected, actual, label) {
  const expectedFingerprint = fingerprintPackageInventory(expected);
  const actualFingerprint = fingerprintPackageInventory(actual);
  if (!isDeepStrictEqual(expectedFingerprint, actualFingerprint) || expected.length !== actual.length) {
    throw new PackageExtensionError('package_inventory_mismatch', label);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      expected[index].relativePath !== actual[index].relativePath
      || expected[index].sha256 !== actual[index].sha256
      || !expected[index].bytes.equals(actual[index].bytes)
    ) throw new PackageExtensionError('package_inventory_mismatch', label);
  }
}

function parseRootManifest(inventory, label) {
  const manifestEntries = inventory.filter(({ relativePath }) => relativePath === 'manifest.json');
  if (manifestEntries.length !== 1) throw new PackageExtensionError('root_manifest_invalid', label);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestEntries[0].bytes));
  } catch {
    throw new PackageExtensionError('root_manifest_invalid', label);
  }
}

function assertExactManifestBytes(expected, actual, label) {
  const expectedBytes = expected.find(({ relativePath }) => relativePath === 'manifest.json')?.bytes;
  const actualBytes = actual.find(({ relativePath }) => relativePath === 'manifest.json')?.bytes;
  if (!expectedBytes || !actualBytes || !expectedBytes.equals(actualBytes)) {
    throw new PackageExtensionError('root_manifest_bytes_mismatch', label);
  }
}

function readAndValidatePermissions(manifest, target = 'chrome') {
  const permissions = {
    permissions: sortedUniqueStrings(manifest.permissions),
    optionalPermissions: sortedUniqueStrings(manifest.optional_permissions),
    hostPermissions: sortedUniqueStrings(manifest.host_permissions),
    optionalHostPermissions: sortedUniqueStrings(manifest.optional_host_permissions),
  };
  const expectedPermissions = reviewedPermissions;
  if (!isDeepStrictEqual(permissions, expectedPermissions)) throw new PackageExtensionError('packaged_permissions_unreviewed');
  if (target === 'chrome' || target === 'edge') return Object.freeze(permissions);
  if (target !== 'firefox') throw new PackageExtensionError('package_target_invalid');
  const gecko = manifest.browser_specific_settings?.gecko;
  const dataCollectionPermissions = {
    required: sortedUniqueStrings(gecko?.data_collection_permissions?.required),
    optional: sortedUniqueStrings(gecko?.data_collection_permissions?.optional),
  };
  if (
    !isPlainObject(gecko)
    || gecko.id !== FIREFOX_GECKO_ID
    || gecko.strict_min_version !== FIREFOX_MIN_VERSION
    || !isDeepStrictEqual(dataCollectionPermissions.required, [...FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS].sort(bytewiseCompare))
    || !isDeepStrictEqual(dataCollectionPermissions.optional, [...FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS].sort(bytewiseCompare))

  ) throw new PackageExtensionError('firefox_permissions_unreviewed');
  return Object.freeze({ ...permissions, dataCollectionPermissions: Object.freeze(dataCollectionPermissions) });
}
export function assertRemoteExecutableCodeExcluded(inventory) {
  const executableEntries = inventory.filter(({ relativePath }) => /\.(?:html|js|mjs)$/u.test(relativePath));
  const remoteCodePatterns = [
    /\bimport\s*(?:\(\s*|(?:[^'"\n]*\bfrom\s*)?)["']\s*(?:https?:|data:|blob:)/u,
    /\bimportScripts\s*\(\s*["']\s*(?:https?:|data:|blob:)/u,
    /\bnew\s+(?:SharedWorker|Worker)\s*\(\s*["']\s*(?:https?:|data:|blob:)/u,
    /<script\b[^>]*\bsrc\s*=\s*["']\s*(?:https?:|data:|blob:)/iu,
    /\bWebAssembly\.(?:compileStreaming|instantiateStreaming)\s*\(\s*(?:await\s+)?fetch\s*\(/u,
    /\b(?:eval|Function)\s*\(\s*(?:await\s+)?fetch\s*\(/u,
  ];
  for (const entry of executableEntries) {
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
    } catch {
      throw new PackageExtensionError('remote_executable_code_scan_invalid', entry.relativePath);
    }
    if (remoteCodePatterns.some((pattern) => pattern.test(source))) {
      throw new PackageExtensionError('remote_executable_code_present', entry.relativePath);
    }
  }
  return Object.freeze({
    remoteExecutableCodeExcluded: true,
    scannedEntries: Object.freeze(executableEntries.map(({ relativePath }) => relativePath)),
  });
}

function assertProductionDisclosure(inventory) {
  const bundledJavaScript = inventory
    .filter(({ relativePath }) => relativePath.endsWith('.js'))
    .map(({ bytes }) => bytes.toString('utf8'));
  const versionHashes = findDevelopmentBuildHashes(bundledJavaScript);
  if (versionHashes.length > 0) {
    throw new PackageExtensionError('development_build_hash_present', versionHashes.join(','));
  }
  const missing = disclosureBundleMarkers.filter((marker) => (
    !bundledJavaScript.some((source) => source.includes(marker))
  ));
  if (missing.length > 0) throw new PackageExtensionError('production_disclosure_marker_missing', missing.join(','));
}

function assertApprovedCandidateVersion(packageVersion, approvedVersion) {
  parseChromeExtensionVersion(packageVersion, 'package version');
  if (typeof approvedVersion !== 'string' || approvedVersion !== packageVersion) {
    throw new PackageExtensionError('approved_candidate_version_required');
  }
  if (compareChromeExtensionVersions(approvedVersion, PUBLIC_EXTENSION_VERSION) <= 0) {
    throw new PackageExtensionError('approved_candidate_version_not_newer');
  }
}

function assertVersionIdentity(packageVersion, manifestVersion, approvedVersion) {
  parseChromeExtensionVersion(manifestVersion, 'manifest version');
  if (packageVersion !== approvedVersion || manifestVersion !== packageVersion) {
    throw new PackageExtensionError('package_version_identity_mismatch');
  }
}

function assertTestedPackageInput(tested, current) {
  if (!isPlainObject(tested) || !isDeepStrictEqual(Object.keys(tested).sort(bytewiseCompare), ['algorithm', 'fileCount', 'sha256'])) {
    throw new PackageExtensionError('tested_package_input_required');
  }
  if (!isDeepStrictEqual(tested, current)) throw new PackageExtensionError('tested_package_input_stale');
}

function readCleanSource(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: root,
    encoding: 'utf8',
  }).trim().length > 0;
  return Object.freeze({ commit, dirty });
}

function assertCleanSource(source) {
  if (!isPlainObject(source) || !SOURCE_COMMIT.test(source.commit) || source.dirty !== false) {
    throw new PackageExtensionError('clean_source_required');
  }
}

function ensureArtifactDirectory(artifactsDir) {
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(artifactsDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new PackageExtensionError('artifact_directory_invalid');
  }
}

function assertFreshTargets(targets) {
  for (const target of targets) {
    if (existsSync(target)) throw new PackageExtensionError('package_artifact_exists', path.basename(target));
  }
}
function assertNoStaleTrustArtifacts(targets) {
  for (const target of targets) {
    if (existsSync(target)) throw new PackageExtensionError('stale_release_artifact_present', path.basename(target));
  }
}

function writeOwnedFile(target, bytes, createdPaths, mode) {
  let descriptor;
  try {
    descriptor = openSync(target, 'wx', mode);
    createdPaths.add(target);
    writeFileSync(descriptor, bytes);
    chmodSync(target, mode);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}


function assertChecksum(checksumPath, zipPath) {
  const expected = `${hash(readFileSync(zipPath))}  ${path.basename(zipPath)}\n`;
  if (readFileSync(checksumPath, 'utf8') !== expected) {
    throw new PackageExtensionError('package_checksum_mismatch');
  }
}

function fileEvidence(baseDir, filePath) {
  const bytes = readFileSync(filePath);
  return Object.freeze({
    relativePath: normalizePackageRelativePath(path.relative(baseDir, filePath).split(path.sep).join('/')),
    bytes: bytes.byteLength,
    sha256: hash(bytes),
  });
}

function sortedUniqueStrings(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new PackageExtensionError('packaged_permissions_invalid');
  }
  const sorted = [...new Set(value)].sort(bytewiseCompare);
  if (sorted.length !== value.length) throw new PackageExtensionError('packaged_permissions_invalid');
  return Object.freeze(sorted);
}

function parseJsonInput(value, label) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 * 1024) {
    throw new PackageExtensionError('environment_json_invalid', label);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new PackageExtensionError('environment_json_invalid', label);
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = packageExtension();
    console.log(`✅ Packaged ${path.relative(process.cwd(), result.zipPath)}`);
    console.log(`✅ Wrote ${path.relative(process.cwd(), result.checksumPath)}`);
    console.log(`✅ Wrote immutable ${path.relative(process.cwd(), result.evidencePath)}`);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
