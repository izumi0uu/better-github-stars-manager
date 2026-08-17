#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageExtension } from './package-extension.mjs';

export function packageEdgeExtension(options = {}) {
  const extensionPackager = options.extensionPackager ?? packageExtension;
  return extensionPackager({
    ...options.packageOptions,
    target: 'edge',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = packageEdgeExtension();
    console.log(`Packaged Edge extension: ${path.relative(process.cwd(), result.zipPath)}`);
    console.log(`Wrote Edge checksum: ${path.relative(process.cwd(), result.checksumPath)}`);
    console.log(`Wrote immutable Edge evidence: ${path.relative(process.cwd(), result.evidencePath)}`);
  } catch (error) {
    console.error(`Edge packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
