import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import {
  classifyForbiddenPackageEntry,
  normalizePackageRelativePath,
} from './package-manifest-closure.mjs';

export class PackageInputError extends Error {
  constructor(code, label = 'package input') {
    super(`${code}: ${label}`);
    this.name = 'PackageInputError';
    this.code = code;
    this.label = label;
  }
}

export function createPackageInputInventory(distDir) {
  const requestedRoot = path.resolve(distDir);
  const rootStats = lstatPackageInput(requestedRoot, 'package_input_root_missing');
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new PackageInputError('package_input_root_invalid', requestedRoot);
  }
  const canonicalRoot = realpathPackageInput(requestedRoot, 'package_input_root_invalid');
  const canonicalRootStats = lstatPackageInput(canonicalRoot, 'package_input_root_invalid');
  if (!sameFileIdentity(rootStats, canonicalRootStats)) {
    throw new PackageInputError('package_input_root_changed', requestedRoot);
  }

  const inventory = [];
  collectPackageInputFiles(canonicalRoot, '', inventory, new Map());
  const finalRootStats = lstatPackageInput(requestedRoot, 'package_input_root_missing');
  if (
    !sameFileIdentity(rootStats, finalRootStats)
    || realpathPackageInput(requestedRoot, 'package_input_root_invalid') !== canonicalRoot
  ) throw new PackageInputError('package_input_root_changed', requestedRoot);
  return Object.freeze(inventory);
}

export function fingerprintPackageInventory(inventory) {
  assertCanonicalInventory(inventory);
  return fingerprintCanonicalEntries(inventory);
}

export function fingerprintPackageEntries(entries) {
  if (!Array.isArray(entries)) throw new PackageInputError('package_inventory_invalid');
  const canonical = entries.map((entry, index) => validateInventoryEntry(entry, index, false));
  canonical.sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath));
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index - 1].relativePath === canonical[index].relativePath) {
      throw new PackageInputError('package_inventory_order_invalid', canonical[index].relativePath);
    }
  }
  return fingerprintCanonicalEntries(canonical);
}

export function validatePackageInputFingerprint(value) {
  const keys = isPlainObject(value) ? Reflect.ownKeys(value) : [];
  if (
    !isPlainObject(value)
    || keys.some((key) => typeof key !== 'string')
    || !sameStringSet(keys, ['algorithm', 'fileCount', 'sha256'])
    || value.algorithm !== 'sha256'
    || !Number.isSafeInteger(value.fileCount)
    || value.fileCount < 0
    || !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) throw new PackageInputError('package_fingerprint_invalid');
  return Object.freeze({
    algorithm: value.algorithm,
    fileCount: value.fileCount,
    sha256: value.sha256,
  });
}

export function samePackageInputFingerprint(left, right) {
  const validatedLeft = validatePackageInputFingerprint(left);
  const validatedRight = validatePackageInputFingerprint(right);
  return validatedLeft.fileCount === validatedRight.fileCount
    && validatedLeft.sha256 === validatedRight.sha256;
}

export function packageInputFingerprint(distDir) {
  return fingerprintPackageInventory(createPackageInputInventory(distDir));
}

function collectPackageInputFiles(root, relativeDirectory, inventory, fileIdentities) {
  const absoluteDirectory = relativeDirectory
    ? path.join(root, ...relativeDirectory.split('/'))
    : root;
  const initialDirectoryStats = lstatPackageInput(absoluteDirectory, 'package_input_read_failed');
  if (initialDirectoryStats.isSymbolicLink() || !initialDirectoryStats.isDirectory()) {
    throw new PackageInputError('package_input_changed', relativeDirectory || '.');
  }
  if (realpathPackageInput(absoluteDirectory, 'package_input_read_failed') !== absoluteDirectory) {
    throw new PackageInputError('package_input_symlink_rejected', relativeDirectory || '.');
  }
  const names = readDirectoryNames(absoluteDirectory, relativeDirectory).sort(bytewiseCompare);
  for (const name of names) {
    const candidatePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    let relativePath;
    try {
      relativePath = normalizePackageRelativePath(candidatePath, 'package input entry');
    } catch {
      throw new PackageInputError('package_inventory_path_invalid', candidatePath);
    }
    const absolutePath = path.join(absoluteDirectory, name);
    const stats = lstatPackageInput(absolutePath, 'package_input_read_failed', relativePath);
    if (stats.isSymbolicLink()) {
      throw new PackageInputError('package_input_symlink_rejected', relativePath);
    }
    if (classifyForbiddenPackageEntry(relativePath) !== null) continue;
    if (stats.isDirectory()) {
      collectPackageInputFiles(root, relativePath, inventory, fileIdentities);
      continue;
    }
    if (!stats.isFile()) {
      throw new PackageInputError('package_input_not_regular', relativePath);
    }

    const identity = `${stats.dev}:${stats.ino}`;
    if (fileIdentities.has(identity)) {
      throw new PackageInputError('package_input_alias_rejected', relativePath);
    }
    fileIdentities.set(identity, relativePath);
    const bytes = readRegularFile(absolutePath, relativePath, stats);
    inventory.push(Object.freeze({
      relativePath,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }));
  }
  const finalNames = readDirectoryNames(absoluteDirectory, relativeDirectory).sort(bytewiseCompare);
  const finalDirectoryStats = lstatPackageInput(absoluteDirectory, 'package_input_read_failed', relativeDirectory || '.');
  if (
    !sameFileIdentity(initialDirectoryStats, finalDirectoryStats)
    || !sameStringArray(names, finalNames)
    || realpathPackageInput(absoluteDirectory, 'package_input_read_failed') !== absoluteDirectory
  ) throw new PackageInputError('package_input_changed', relativeDirectory || '.');
}

function readRegularFile(absolutePath, relativePath, initialStats) {
  let descriptor;
  try {
    if (realpathSync(absolutePath) !== absolutePath) {
      throw new PackageInputError('package_input_symlink_rejected', relativePath);
    }
    descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(descriptor, { bigint: true });
    if (!openedStats.isFile() || !sameFileIdentity(openedStats, initialStats)) {
      throw new PackageInputError('package_input_changed', relativePath);
    }
    const bytes = readFileSync(descriptor);
    const finalStats = fstatSync(descriptor, { bigint: true });
    const finalPathStats = lstatPackageInput(absolutePath, 'package_input_read_failed', relativePath);
    if (
      !sameFileIdentity(openedStats, finalStats)
      || !sameFileIdentity(finalStats, finalPathStats)
      || BigInt(bytes.byteLength) !== openedStats.size
      || realpathSync(absolutePath) !== absolutePath
    ) throw new PackageInputError('package_input_changed', relativePath);
    return bytes;
  } catch (error) {
    if (error instanceof PackageInputError) throw error;
    throw new PackageInputError('package_input_read_failed', relativePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertCanonicalInventory(inventory) {
  if (!Array.isArray(inventory)) throw new PackageInputError('package_inventory_invalid');
  let previous = null;
  for (let index = 0; index < inventory.length; index += 1) {
    const entry = validateInventoryEntry(inventory[index], index, true);
    if (previous !== null && bytewiseCompare(previous, entry.relativePath) >= 0) {
      throw new PackageInputError('package_inventory_order_invalid', entry.relativePath);
    }
    previous = entry.relativePath;
  }
}

function validateInventoryEntry(entry, index, requireHash) {
  if (!isPlainObject(entry)) {
    throw new PackageInputError('package_inventory_entry_invalid', `inventory[${index}]`);
  }
  let relativePath;
  try {
    relativePath = normalizePackageRelativePath(entry.relativePath, `inventory[${index}]`);
  } catch {
    throw new PackageInputError('package_inventory_path_invalid', `inventory[${index}]`);
  }
  if (
    classifyForbiddenPackageEntry(relativePath) !== null
    || entry.symlink === true
    || (entry.type !== undefined && entry.type !== 'file')
    || !Buffer.isBuffer(entry.bytes)
  ) throw new PackageInputError('package_inventory_entry_invalid', relativePath);
  const sha256 = createHash('sha256').update(entry.bytes).digest('hex');
  if (
    (requireHash && typeof entry.sha256 !== 'string')
    || (entry.sha256 !== undefined && (!/^[0-9a-f]{64}$/u.test(entry.sha256) || entry.sha256 !== sha256))
  ) throw new PackageInputError('package_inventory_entry_invalid', relativePath);
  return Object.freeze({ relativePath, bytes: entry.bytes, sha256 });
}

function fingerprintCanonicalEntries(entries) {
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.relativePath);
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\n');
  }
  return Object.freeze({
    algorithm: 'sha256',
    fileCount: entries.length,
    sha256: digest.digest('hex'),
  });
}

function lstatPackageInput(absolutePath, code, label = absolutePath) {
  try {
    return lstatSync(absolutePath, { bigint: true });
  } catch {
    throw new PackageInputError(code, label);
  }
}

function realpathPackageInput(absolutePath, code) {
  try {
    return realpathSync(absolutePath);
  } catch {
    throw new PackageInputError(code, absolutePath);
  }
}

function readDirectoryNames(absolutePath, label) {
  try {
    return readdirSync(absolutePath);
  } catch {
    throw new PackageInputError('package_input_read_failed', label || absolutePath);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameStringSet(left, right) {
  return sameStringArray([...left].sort(bytewiseCompare), [...right].sort(bytewiseCompare));
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
