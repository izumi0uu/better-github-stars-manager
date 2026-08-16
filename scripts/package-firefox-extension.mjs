#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { packageExtension } from './package-extension.mjs';
import { packageFirefoxReviewerSource } from './package-firefox-review-source.mjs';
import { parseChromeExtensionVersion } from './package-manifest-closure.mjs';

export function packageFirefoxArtifacts(options = {}) {
  const extensionPackager = options.extensionPackager ?? packageExtension;
  const reviewerSourcePackager = options.reviewerSourcePackager ?? packageFirefoxReviewerSource;
  const extension = extensionPackager({ target: 'firefox' });
  const reviewerSource = reviewerSourcePackager({ reuseExisting: true });
  return Object.freeze({ extension, reviewerSource });
}

export function verifyFirefoxArtifactChecksums(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const packageVersion = options.packageVersion ?? pkg.version;
  parseChromeExtensionVersion(packageVersion, 'Firefox checksum package version');
  const artifactsDir = path.resolve(
    root,
    options.artifactsDir ?? process.env.GSM_ARTIFACTS_DIR ?? path.join('artifacts', 'firefox'),
  );
  const baseName = `better-github-stars-manager-firefox-${packageVersion}`;
  const archives = [`${baseName}.zip`, `${baseName}-source.zip`];
  return Object.freeze(archives.map((archiveName) => {
    const archivePath = path.join(artifactsDir, archiveName);
    const checksumPath = `${archivePath}.sha256`;
    const archive = readFileSync(archivePath);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const checksum = readFileSync(checksumPath, 'utf8');
    if (checksum !== `${sha256}  ${archiveName}\n`) {
      throw new Error(`Firefox artifact checksum mismatch: ${archiveName}`);
    }
    return Object.freeze({ archive: archiveName, bytes: archive.length, sha256 });
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argumentsList = process.argv.slice(2);
    if (argumentsList.length === 0) {
      packageFirefoxArtifacts();
      console.log('Packaged Firefox extension and reviewer source artifacts.');
    } else if (argumentsList.length === 1 && argumentsList[0] === '--verify-checksums') {
      const verified = verifyFirefoxArtifactChecksums();
      console.log(`Verified ${verified.length} Firefox artifact checksums.`);
    } else {
      throw new Error('Usage: package-firefox-extension.mjs [--verify-checksums]');
    }
  } catch (error) {
    console.error(`Firefox packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
