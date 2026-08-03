import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function isPackageInputRelativePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  return normalized !== '.DS_Store'
    && !normalized.endsWith('/.DS_Store')
    && normalized !== 'store'
    && !normalized.startsWith('store/');
}

export function packageInputFingerprint(distDir) {
  const files = [];
  collectFiles(distDir, '', files);
  files.sort((left, right) => left.localeCompare(right));
  const digest = createHash('sha256');
  for (const relativePath of files) {
    const bytes = readFileSync(path.join(distDir, relativePath));
    digest.update(relativePath.split(path.sep).join('/'));
    digest.update('\0');
    digest.update(createHash('sha256').update(bytes).digest('hex'));
    digest.update('\n');
  }
  return Object.freeze({
    algorithm: 'sha256',
    fileCount: files.length,
    sha256: digest.digest('hex'),
  });
}

function collectFiles(root, relativeDirectory, files) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (!isPackageInputRelativePath(relativePath)) continue;
    if (entry.isDirectory()) collectFiles(root, relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
}
