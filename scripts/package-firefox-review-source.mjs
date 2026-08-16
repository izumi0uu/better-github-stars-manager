import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { normalizePackageRelativePath, parseChromeExtensionVersion } from './package-manifest-closure.mjs';
import {
  readDeterministicZip,
  writeDeterministicZip,
} from './deterministic-zip.mjs';

export const FIREFOX_REVIEWER_README = 'FIREFOX_REVIEWER_BUILD.md';
const ZIP_EPOCH = new Date('1980-01-01T00:00:00.000Z');
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const PUBLIC_KEY_MARKER = /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u;
const PRIVATE_TOKEN_MARKER = /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,})\b/u;
const PERSONAL_PATH_MARKER = /(?:^|[\s"'`])(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/u;
const ROOT_BUILD_INPUTS = new Set([
  '.gitignore',
  'components.json',
  'manifest.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'postcss.config.js',
  'tailwind.config.js',
  'tsconfig.json',
  'store-assets/screenshots/token-guide-create-classic-pat.webp',
  'store-assets/screenshots/token-guide-generate-token.webp',
  'store-assets/screenshots/token-guide-select-scopes.webp',
  'vite.config.ts',
]);
const SCRIPT_BUILD_INPUTS = new Set([
  'scripts/agent-runtime-evidence-contract.mjs',
  'scripts/agent-runtime-release-evidence.mjs',
  'scripts/build-firefox-extension.mjs',
  'scripts/deterministic-zip.mjs',
  'scripts/check-firefox-output-contracts.mjs',
  'scripts/enforce-package-manager.mjs',
  'scripts/lint-firefox-extension.mjs',
  'scripts/package-extension.mjs',
  'scripts/package-firefox-extension.mjs',
  'scripts/package-firefox-review-source.mjs',
  'scripts/package-input-fingerprint.mjs',
  'scripts/package-manifest-closure.mjs',
  'scripts/setup-hooks.mjs',
]);

export class FirefoxReviewerSourceError extends Error {
  constructor(code, label = 'Firefox reviewer source') {
    super(`${code}: ${label}`);
    this.name = 'FirefoxReviewerSourceError';
    this.code = code;
    this.label = label;
  }
}

export function packageFirefoxReviewerSource(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const packageVersion = options.packageVersion ?? pkg.version;
  parseChromeExtensionVersion(packageVersion, 'Firefox reviewer source version');
  const artifactsDir = path.resolve(root, options.artifactsDir ?? path.join('artifacts', 'firefox'));
  const baseName = `better-github-stars-manager-firefox-${packageVersion}-source.zip`;
  const zipPath = path.join(artifactsDir, baseName);
  const checksumPath = path.join(artifactsDir, `${baseName}.sha256`);
  const source = options.source ?? readCleanSource(root, options.reuseExisting === true);
  assertCleanSource(source);
  if (options.verifyGitSource !== false) {
    const currentSource = readCleanSource(root, true);
    assertCleanSource(currentSource);
    if (currentSource.commit !== source.commit) throw new FirefoxReviewerSourceError('reviewer_source_commit_changed');
  }
  const inventory = createFirefoxReviewerSourceInventory({
    root,
    packageVersion,
    trackedFiles: options.trackedFiles,
  });
  const packageInput = fingerprintSourceInventory(inventory);

  ensureArtifactDirectory(artifactsDir);
  if (options.reuseExisting === true && existsSync(zipPath) && existsSync(checksumPath)) {
    assertExistingArtifacts({ zipPath, checksumPath, inventory });
    return createResult({ artifactsDir, zipPath, checksumPath, inventory, packageInput, ownedPaths: [] });
  }
  if (existsSync(zipPath) || existsSync(checksumPath)) {
    throw new FirefoxReviewerSourceError('reviewer_source_artifact_exists', baseName);
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'bgsm-firefox-source-'));
  const stageDir = path.join(workDir, 'stage');
  const tempZipPath = path.join(workDir, baseName);
  const createdPaths = new Set();
  try {
    mkdirSync(stageDir);
    stageInventory(inventory, stageDir);
    createZip({ zipPath: tempZipPath, inventory });
    assertSameInventory(inventory, readZipInventory(tempZipPath), 'reviewer source ZIP');
    const zipBytes = readFileSync(tempZipPath);
    writeOwnedFile(zipPath, zipBytes, createdPaths);
    writeOwnedFile(
      checksumPath,
      Buffer.from(`${hash(zipBytes)}  ${path.basename(zipPath)}\n`),
      createdPaths,
    );
    assertChecksum(checksumPath, zipPath);
    return createResult({
      artifactsDir,
      zipPath,
      checksumPath,
      inventory,
      packageInput,
      ownedPaths: [...createdPaths],
    });
  } catch (error) {
    for (const createdPath of createdPaths) rmSync(createdPath, { force: true });
    throw error;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}


export function validateFirefoxReviewerSourceArtifact({ zipPath, checksumPath, evidence } = {}) {
  if (typeof zipPath !== 'string' || typeof checksumPath !== 'string') {
    throw new FirefoxReviewerSourceError('reviewer_source_artifact_paths_invalid');
  }
  const resolvedZipPath = path.resolve(zipPath);
  const resolvedChecksumPath = path.resolve(checksumPath);
  const expectedChecksumPath = `${resolvedZipPath}.sha256`;
  if (resolvedChecksumPath !== expectedChecksumPath) {
    throw new FirefoxReviewerSourceError('reviewer_source_checksum_path_invalid', checksumPath);
  }
  const artifactName = path.basename(resolvedZipPath);
  const match = /^better-github-stars-manager-firefox-(\d+(?:\.\d+){0,3})-source\.zip$/u.exec(artifactName);
  if (!match) throw new FirefoxReviewerSourceError('reviewer_source_artifact_name_invalid', artifactName);
  parseChromeExtensionVersion(match[1], 'Firefox reviewer source version');
  assertChecksum(resolvedChecksumPath, resolvedZipPath);
  const inventory = readZipInventory(resolvedZipPath);
  const packageInput = fingerprintSourceInventory(inventory);
  const readmeEntries = inventory.filter(({ relativePath }) => relativePath === FIREFOX_REVIEWER_README);
  if (readmeEntries.length !== 1) throw new FirefoxReviewerSourceError('reviewer_source_readme_invalid');
  const readme = Object.freeze({
    relativePath: FIREFOX_REVIEWER_README,
    bytes: readmeEntries[0].bytes.byteLength,
    sha256: readmeEntries[0].sha256,
  });
  const artifactsDir = path.dirname(resolvedZipPath);
  const verified = Object.freeze({
    archive: fileEvidence(artifactsDir, resolvedZipPath),
    checksum: fileEvidence(artifactsDir, resolvedChecksumPath),
    readme,
    packageInput,
  });
  if (evidence !== undefined && !sameReviewerSourceEvidence(verified, evidence)) {
    throw new FirefoxReviewerSourceError('reviewer_source_evidence_mismatch');
  }
  return verified;
}
export function createFirefoxReviewerSourceInventory({ root, packageVersion, trackedFiles } = {}) {
  const resolvedRoot = path.resolve(root ?? process.cwd());
  const tracked = trackedFiles ?? readTrackedFiles(resolvedRoot);
  if (!Array.isArray(tracked) || tracked.some((value) => typeof value !== 'string')) {
    throw new FirefoxReviewerSourceError('reviewer_source_tracked_files_invalid');
  }
  const entries = [];
  const seen = new Set();
  for (const candidate of tracked) {
    const relativePath = safeSourcePath(candidate);
    if (seen.has(relativePath)) throw new FirefoxReviewerSourceError('reviewer_source_path_duplicate', relativePath);
    seen.add(relativePath);
    if (isExcludedSourcePath(relativePath) || !isBuildInput(relativePath)) continue;
    const absolutePath = path.join(resolvedRoot, ...relativePath.split('/'));
    const bytes = readTrackedBuildInput(absolutePath, relativePath);
    assertPublicSourceBytes(relativePath, bytes);
    entries.push(Object.freeze({ relativePath, bytes, sha256: hash(bytes) }));
  }
  for (const required of ['.gitignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'manifest.config.ts', 'vite.config.ts']) {
    if (!entries.some(({ relativePath }) => relativePath === required)) {
      throw new FirefoxReviewerSourceError('reviewer_source_build_input_missing', required);
    }
  }
  const readmeBytes = Buffer.from(createReviewerReadme(packageVersion));
  entries.push(Object.freeze({
    relativePath: FIREFOX_REVIEWER_README,
    bytes: readmeBytes,
    sha256: hash(readmeBytes),
  }));
  entries.sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath));
  return Object.freeze(entries);
}

function readTrackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function readCleanSource(root, trackedOnly = false) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', `--untracked-files=${trackedOnly ? 'no' : 'normal'}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim().length > 0;
  return Object.freeze({ commit, dirty });
}

function assertCleanSource(source) {
  if (!source || typeof source !== 'object' || !SOURCE_COMMIT.test(source.commit) || source.dirty !== false) {
    throw new FirefoxReviewerSourceError('reviewer_source_clean_source_required');
  }
}

function safeSourcePath(value) {
  try {
    return normalizePackageRelativePath(value, 'reviewer source path');
  } catch {
    throw new FirefoxReviewerSourceError('reviewer_source_path_invalid', String(value));
  }
}

function isExcludedSourcePath(relativePath) {
  const segments = relativePath.toLowerCase().split('/');
  return segments.some((segment) => segment === '.git' || segment === 'node_modules')
    || segments[0] === 'dist'
    || segments[0] === 'dist-firefox'
    || segments[0] === 'artifacts'
    || segments[0] === '.trellis'
    || segments[0] === '.tmp';
}

function isBuildInput(relativePath) {
  if (ROOT_BUILD_INPUTS.has(relativePath) || SCRIPT_BUILD_INPUTS.has(relativePath)) return true;
  if (relativePath.startsWith('src/')) return true;
  return relativePath.startsWith('public/') && !relativePath.startsWith('public/store/');
}

function assertPublicSourceBytes(relativePath, bytes) {
  const lowerPath = relativePath.toLowerCase();
  if (
    /(?:^|\/)(?:\.env(?:\.|$)|credentials?|secrets?|private|personal)(?:\/|\.|$)/u.test(lowerPath)
    || /\.(?:pem|key|p12|pfx)$/u.test(lowerPath)
  ) throw new FirefoxReviewerSourceError('reviewer_source_private_input', relativePath);
  if (bytes.includes(0)) return;
  const source = bytes.toString('utf8');
  if (PUBLIC_KEY_MARKER.test(source) || PRIVATE_TOKEN_MARKER.test(source) || PERSONAL_PATH_MARKER.test(source)) {
    throw new FirefoxReviewerSourceError('reviewer_source_private_input', relativePath);
  }
}

function createReviewerReadme(packageVersion) {
  const pnpmVersion = String(pkg.packageManager).replace(/^pnpm@/u, '');
  const extensionName = `better-github-stars-manager-firefox-${packageVersion}.zip`;
  const sourceName = `better-github-stars-manager-firefox-${packageVersion}-source.zip`;
  return `# Better GitHub Stars Manager — Firefox reviewer build\n\nThis archive contains the tracked source and public, lockfile-pinned build inputs for the submitted Firefox extension. It intentionally excludes Git metadata, dependencies, build output, release artifacts, store-listing artwork that is not referenced by the runtime build, tests, private files, personal paths, and work-item notes.\n\n## Public toolchain\n\n- Git\n- Node.js with Corepack\n- pnpm ${pnpmVersion}, pinned by \`package.json\`\n- Public npm dependencies pinned by \`pnpm-lock.yaml\`\n\nZIP creation and inspection use the tracked \`scripts/deterministic-zip.mjs\` implementation, with stored entries, fixed timestamps and file modes, and no host \`zip\` or \`unzip\` dependency. SHA-256 creation and verification use Node.js \`node:crypto\`; no host checksum utility is required.\n\n## Rebuild and verify\n\nRun from this archive's root. The package gate requires a clean source commit, so first create local-only Git metadata; it is not included in either submitted ZIP.\n\n\`\`\`sh\ngit init\ngit config user.name "AMO Reviewer"\ngit config user.email "reviewer@localhost"\ngit add .\ngit commit -m "AMO reviewer build input"\ncorepack enable\ncorepack prepare pnpm@${pnpmVersion} --activate\npnpm install --frozen-lockfile\nGSM_APPROVED_RELEASE_VERSION=${packageVersion} pnpm package:firefox\npnpm lint:firefox\nnode scripts/package-firefox-extension.mjs --verify-checksums\n\`\`\`\n\nThe submitted extension archive is \`artifacts/firefox/${extensionName}\`, and the reviewer source archive is \`artifacts/firefox/${sourceName}\`. The extension archive has \`manifest.json\` at the ZIP root. The release packager validates the exact manifest resource closure, rejects remote executable code, and writes deterministic ZIP inventories and SHA-256 sidecars. Network \`fetch\` calls retrieve data only; the package contains every executable script it runs.\n`;
}

function ensureArtifactDirectory(artifactsDir) {
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  const stats = lstatSource(artifactsDir, artifactsDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new FirefoxReviewerSourceError('reviewer_source_artifact_directory_invalid');
  }
}

function stageInventory(inventory, stageDir) {
  fingerprintSourceInventory(inventory);
  for (const entry of inventory) {
    const absolutePath = path.join(stageDir, ...entry.relativePath.split('/'));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, entry.bytes, { flag: 'wx', mode: 0o644 });
    chmodSync(absolutePath, 0o644);
    utimesSync(absolutePath, ZIP_EPOCH, ZIP_EPOCH);
  }
}

function createZip({ zipPath, inventory }) {
  writeDeterministicZip(zipPath, inventory);
}

function readZipInventory(zipPath) {
  const entries = readDeterministicZip(path.resolve(zipPath));
  const seen = new Set();
  return Object.freeze(entries.map((entry) => {
    const relativePath = safeSourcePath(entry.relativePath);
    if (isExcludedSourcePath(relativePath)) throw new FirefoxReviewerSourceError('reviewer_source_forbidden_path', relativePath);
    if (seen.has(relativePath)) throw new FirefoxReviewerSourceError('reviewer_source_zip_entry_duplicate', relativePath);
    seen.add(relativePath);
    const bytes = Buffer.from(entry.bytes);
    return Object.freeze({ relativePath, bytes, sha256: hash(bytes) });
  }));
}

function assertExistingArtifacts({ zipPath, checksumPath, inventory }) {
  assertChecksum(checksumPath, zipPath);
  assertSameInventory(inventory, readZipInventory(zipPath), 'existing reviewer source ZIP');
}

function assertSameInventory(expected, actual, label) {
  if (expected.length !== actual.length) throw new FirefoxReviewerSourceError('reviewer_source_inventory_mismatch', label);
  for (let index = 0; index < expected.length; index += 1) {
    if (
      expected[index].relativePath !== actual[index].relativePath
      || expected[index].sha256 !== actual[index].sha256
      || !expected[index].bytes.equals(actual[index].bytes)
    ) throw new FirefoxReviewerSourceError('reviewer_source_inventory_mismatch', label);
  }
}

function assertChecksum(checksumPath, zipPath) {
  const expected = `${hash(readFileSync(zipPath))}  ${path.basename(zipPath)}\n`;
  if (readFileSync(checksumPath, 'utf8') !== expected) {
    throw new FirefoxReviewerSourceError('reviewer_source_checksum_mismatch');
  }
}

function writeOwnedFile(target, bytes, createdPaths) {
  let descriptor;
  try {
    descriptor = openSync(target, 'wx', 0o600);
    createdPaths.add(target);
    writeFileSync(descriptor, bytes);
    chmodSync(target, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function createResult({ artifactsDir, zipPath, checksumPath, inventory, packageInput, ownedPaths }) {
  const readme = inventory.find(({ relativePath }) => relativePath === FIREFOX_REVIEWER_README);
  return Object.freeze({
    zipPath,
    checksumPath,
    archive: fileEvidence(artifactsDir, zipPath),
    checksum: fileEvidence(artifactsDir, checksumPath),
    readme: Object.freeze({
      relativePath: FIREFOX_REVIEWER_README,
      bytes: readme.bytes.byteLength,
      sha256: readme.sha256,
    }),
    packageInput,
    ownedPaths: Object.freeze([...ownedPaths]),
  });
}

function fileEvidence(baseDir, filePath) {
  const bytes = readFileSync(filePath);
  return Object.freeze({
    relativePath: normalizePackageRelativePath(path.relative(baseDir, filePath).split(path.sep).join('/')),
    bytes: bytes.byteLength,
    sha256: hash(bytes),
  });
}

function readTrackedBuildInput(absolutePath, relativePath) {
  const initial = lstatSource(absolutePath, relativePath);
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new FirefoxReviewerSourceError('reviewer_source_entry_not_regular', relativePath);
  }
  const bytes = readFileSync(absolutePath);
  const final = lstatSource(absolutePath, relativePath);
  if (
    final.isSymbolicLink()
    || !final.isFile()
    || initial.dev !== final.dev
    || initial.ino !== final.ino
    || initial.size !== final.size
    || initial.mtimeMs !== final.mtimeMs
    || bytes.byteLength !== final.size
  ) throw new FirefoxReviewerSourceError('reviewer_source_input_changed', relativePath);
  return bytes;
}

function lstatSource(absolutePath, label) {
  try {
    return lstatSync(absolutePath);
  } catch {
    throw new FirefoxReviewerSourceError('reviewer_source_input_missing', label);
  }
}

function fingerprintSourceInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new FirefoxReviewerSourceError('reviewer_source_inventory_invalid');
  }
  const digest = createHash('sha256');
  let previous = null;
  for (const entry of inventory) {
    if (!entry || typeof entry !== 'object' || !Buffer.isBuffer(entry.bytes)) {
      throw new FirefoxReviewerSourceError('reviewer_source_inventory_invalid');
    }
    const relativePath = safeSourcePath(entry.relativePath);
    if (isExcludedSourcePath(relativePath) || (previous !== null && bytewiseCompare(previous, relativePath) >= 0)) {
      throw new FirefoxReviewerSourceError('reviewer_source_inventory_invalid', relativePath);
    }
    const sha256 = hash(entry.bytes);
    if (entry.sha256 !== sha256) throw new FirefoxReviewerSourceError('reviewer_source_inventory_invalid', relativePath);
    digest.update(relativePath);
    digest.update('\0');
    digest.update(sha256);
    digest.update('\n');
    previous = relativePath;
  }
  return Object.freeze({ algorithm: 'sha256', fileCount: inventory.length, sha256: digest.digest('hex') });
}

function sameReviewerSourceEvidence(left, right) {
  if (!right || typeof right !== 'object' || Array.isArray(right)) return false;
  if (Object.keys(right).sort(bytewiseCompare).join('\0') !== ['archive', 'checksum', 'packageInput', 'readme'].join('\0')) return false;
  return sameFileEvidence(left.archive, right.archive)
    && sameFileEvidence(left.checksum, right.checksum)
    && sameFileEvidence(left.readme, right.readme)
    && right.packageInput?.algorithm === left.packageInput.algorithm
    && right.packageInput?.fileCount === left.packageInput.fileCount
    && right.packageInput?.sha256 === left.packageInput.sha256;
}

function sameFileEvidence(left, right) {
  return right?.relativePath === left.relativePath
    && right?.bytes === left.bytes
    && right?.sha256 === left.sha256;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
