import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { packageInputFingerprint } from './package-input-fingerprint.mjs';
import {
  normalizePackageRelativePath,
  parseChromeExtensionVersion,
  parseMv3WorkerLoader,
  resolvePackagePath,
} from './package-manifest-closure.mjs';

export const MAX_RUNTIME_EVIDENCE_BYTES = 32 * 1024;

const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.schema\.json$/u;
const MAX_COLLECTION_ITEMS = 128;
const MAX_DEPTH = 16;
const MAX_NODES = 2_048;
const MAX_STRING_BYTES = 512;
const FORBIDDEN_KEYS = new Set([
  'authorization',
  'body',
  'cause',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'dom',
  'error',
  'errors',
  'errormessage',
  'header',
  'headers',
  'message',
  'messages',
  'payload',
  'prompt',
  'prompts',
  'rawerror',
  'requestbody',
  'responsebody',
  'stack',
  'toolarguments',
  'toolpayload',
  'toolresultpayload',
  'transcript',
  'transcripts',
  'url',
  'urls',
]);

export class RuntimeEvidenceError extends Error {
  constructor(code) {
    super('Runtime evidence contract failed.');
    this.name = 'RuntimeEvidenceError';
    this.code = code;
  }
}

export function readRuntimeReleaseDistIdentity(distDirectory) {
  try {
    const requestedRoot = path.resolve(distDirectory);
    const manifestPath = resolvePackagePath(requestedRoot, 'manifest.json', 'runtime evidence manifest');
    const distRoot = path.dirname(manifestPath);
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest?.manifest_version !== 3) throw new Error('invalid manifest version');
    parseChromeExtensionVersion(manifest?.version, 'runtime evidence manifest version');

    const loaderPath = resolvePackagePath(
      distRoot,
      manifest?.background?.service_worker,
      'runtime evidence worker loader',
    );
    const loaderBytes = readFileSync(loaderPath);
    const { loaderRelativePath, workerRelativePath } = parseMv3WorkerLoader({
      manifest,
      loaderText: loaderBytes.toString('utf8'),
    });
    const workerPath = resolvePackagePath(distRoot, workerRelativePath, 'runtime evidence worker');
    const workerBytes = readFileSync(workerPath);

    return Object.freeze({
      packageInput: packageInputFingerprint(distRoot),
      manifest: Object.freeze({
        relativePath: 'manifest.json',
        bytes: manifestBytes.byteLength,
        sha256: sha256(manifestBytes),
        manifestVersion: 3,
        extensionVersion: manifest.version,
      }),
      loader: fileIdentity(loaderRelativePath, loaderBytes),
      worker: fileIdentity(workerRelativePath, workerBytes),
    });
  } catch (error) {
    if (error instanceof RuntimeEvidenceError) throw error;
    throw new RuntimeEvidenceError('release_dist_identity_invalid');
  }
}

export function assertRuntimeReleaseDistIdentity(value) {
  exactKeys(value, ['packageInput', 'manifest', 'loader', 'worker']);
  exactKeys(value.packageInput, ['algorithm', 'fileCount', 'sha256']);
  if (
    value.packageInput.algorithm !== 'sha256'
    || !nonnegativeInteger(value.packageInput.fileCount)
    || !HEX_SHA256.test(value.packageInput.sha256)
  ) throw new RuntimeEvidenceError('release_dist_identity_invalid');

  exactKeys(value.manifest, ['relativePath', 'bytes', 'sha256', 'manifestVersion', 'extensionVersion']);
  if (
    value.manifest.relativePath !== 'manifest.json'
    || !positiveInteger(value.manifest.bytes)
    || !HEX_SHA256.test(value.manifest.sha256)
    || value.manifest.manifestVersion !== 3
    || !validChromeExtensionVersion(value.manifest.extensionVersion)
  ) throw new RuntimeEvidenceError('release_dist_identity_invalid');

  for (const key of ['loader', 'worker']) {
    exactKeys(value[key], ['relativePath', 'bytes', 'sha256']);
    safeRelativeJavaScriptPath(value[key].relativePath);
    if (!positiveInteger(value[key].bytes) || !HEX_SHA256.test(value[key].sha256)) {
      throw new RuntimeEvidenceError('release_dist_identity_invalid');
    }
  }
  if (value.loader.relativePath === value.worker.relativePath) {
    throw new RuntimeEvidenceError('release_dist_identity_invalid');
  }
}

export function serializeRuntimeEvidence(evidence, {
  validateEvidence,
  privateMarkers = [],
  maxBytes = MAX_RUNTIME_EVIDENCE_BYTES,
} = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new RuntimeEvidenceError('schema_invalid');
  }
  if (typeof validateEvidence !== 'function') throw new RuntimeEvidenceError('schema_invalid');
  if (!positiveInteger(maxBytes) || maxBytes > MAX_RUNTIME_EVIDENCE_BYTES) {
    throw new RuntimeEvidenceError('size_limit_invalid');
  }
  if (!Object.hasOwn(evidence, 'evidenceBytes')) throw new RuntimeEvidenceError('schema_invalid');

  try {
    let serialized = '';
    let previousBytes = -1;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      evidence.evidenceBytes = previousBytes < 0 ? 0 : previousBytes;
      serialized = `${JSON.stringify(evidence, null, 2)}\n`;
      const bytes = Buffer.byteLength(serialized);
      if (bytes === evidence.evidenceBytes) break;
      previousBytes = bytes;
    }
    serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    evidence.evidenceBytes = Buffer.byteLength(serialized);
    serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (Buffer.byteLength(serialized) !== evidence.evidenceBytes) {
      evidence.evidenceBytes = Buffer.byteLength(serialized);
      serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    }
    if (Buffer.byteLength(serialized) !== evidence.evidenceBytes) {
      throw new RuntimeEvidenceError('size_accounting_invalid');
    }
    validateEvidence(evidence);
    assertRuntimeEvidencePrivate(evidence, privateMarkers);
    if (evidence.evidenceBytes > maxBytes) throw new RuntimeEvidenceError('evidence_too_large');
    return serialized;
  } catch (error) {
    if (error instanceof RuntimeEvidenceError) throw error;
    throw new RuntimeEvidenceError('schema_invalid');
  }
}

export function writeRuntimeEvidenceAtomic(directory, filename, serialized) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new RuntimeEvidenceError('evidence_directory_invalid');
  }
  if (typeof filename !== 'string' || !SAFE_FILENAME.test(filename)) {
    throw new RuntimeEvidenceError('evidence_filename_invalid');
  }
  if (
    typeof serialized !== 'string'
    || !serialized.endsWith('\n')
    || Buffer.byteLength(serialized) > MAX_RUNTIME_EVIDENCE_BYTES
  ) throw new RuntimeEvidenceError('serialized_evidence_invalid');

  const resolvedDirectory = path.resolve(directory);
  let descriptor = null;
  let temporaryPath = null;
  try {
    mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
    chmodSync(resolvedDirectory, 0o700);
    const directoryRoot = realpathSync(resolvedDirectory);
    const destination = path.join(directoryRoot, filename);
    temporaryPath = path.join(
      directoryRoot,
      `.${filename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, serialized, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, destination);
    temporaryPath = null;
    chmodSync(destination, 0o600);
    return destination;
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch {}
    }
    if (temporaryPath && existsSync(temporaryPath)) {
      try { rmSync(temporaryPath, { force: true }); } catch {}
    }
    if (error instanceof RuntimeEvidenceError) throw error;
    throw new RuntimeEvidenceError('atomic_write_failed');
  }
}

export function publishRuntimeEvidence({
  directory,
  filename,
  evidence,
  validateEvidence,
  privateMarkers = [],
}) {
  const serialized = serializeRuntimeEvidence(evidence, { validateEvidence, privateMarkers });
  writeRuntimeEvidenceAtomic(directory, filename, serialized);
  return Object.freeze({ bytes: evidence.evidenceBytes });
}

function assertRuntimeEvidencePrivate(value, privateMarkers) {
  const markers = [...privateMarkers].filter((marker) => typeof marker === 'string' && marker.length > 0);
  let nodes = 0;
  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new RuntimeEvidenceError('evidence_unbounded');
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new RuntimeEvidenceError('private_evidence_rejected');
      return;
    }
    if (typeof candidate === 'boolean' || candidate === null) return;
    if (typeof candidate === 'string') {
      if (Buffer.byteLength(candidate) > MAX_STRING_BYTES) throw new RuntimeEvidenceError('evidence_unbounded');
      if (/\b(?:https?|chrome-extension|data):\/\//iu.test(candidate)) {
        throw new RuntimeEvidenceError('private_evidence_rejected');
      }
      if (/\b(?:authorization|bearer|basic)\b|(?:github_pat_|ghp_|sk-)|api[-_ ]?key/iu.test(candidate)) {
        throw new RuntimeEvidenceError('private_evidence_rejected');
      }
      if (markers.some((marker) => candidate.includes(marker))) {
        throw new RuntimeEvidenceError('private_evidence_rejected');
      }
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_COLLECTION_ITEMS) throw new RuntimeEvidenceError('evidence_unbounded');
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!candidate || typeof candidate !== 'object' || Object.getPrototypeOf(candidate) !== Object.prototype) {
      throw new RuntimeEvidenceError('private_evidence_rejected');
    }
    const entries = Object.entries(candidate);
    if (entries.length > MAX_COLLECTION_ITEMS) throw new RuntimeEvidenceError('evidence_unbounded');
    for (const [key, nested] of entries) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new RuntimeEvidenceError('private_evidence_rejected');
      visit(nested, depth + 1);
    }
  };
  visit(value, 0);
}

function fileIdentity(relativePath, bytes) {
  if (bytes.byteLength <= 0) throw new Error('empty release file');
  return Object.freeze({
    relativePath,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

function safeRelativeJavaScriptPath(value) {
  try {
    const relativePath = normalizePackageRelativePath(value, 'runtime evidence JavaScript path');
    if (!relativePath.endsWith('.js')) throw new Error('JavaScript path required');
    return relativePath;
  } catch {
    throw new RuntimeEvidenceError('release_dist_identity_invalid');
  }
}

function validChromeExtensionVersion(value) {
  try {
    parseChromeExtensionVersion(value, 'runtime evidence extension version');
    return true;
  } catch {
    return false;
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeEvidenceError('release_dist_identity_invalid');
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new RuntimeEvidenceError('release_dist_identity_invalid');
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
