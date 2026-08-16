#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'both';
const DEMO_CANARY = 'bgsm-public-demo-fixture-v1';
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.svg', '.txt']);

if (!['demo', 'extension', 'both'].includes(mode)) {
  throw new Error(`Usage: node scripts/verify-demo-artifacts.mjs [demo|extension|both]`);
}

verifyOneWaySourceImports();
if (mode === 'demo' || mode === 'both') verifyDemoOutput(path.join(root, 'dist-demo'));
if (mode === 'extension' || mode === 'both') verifyExtensionOutput(path.join(root, 'dist'));
console.log(`Demo artifact isolation passed (${mode}).`);

function verifyDemoOutput(directory) {
  assert.ok(existsSync(path.join(directory, 'index.html')), 'dist-demo/index.html is missing');
  assert.equal(existsSync(path.join(directory, 'manifest.json')), false,
    'dist-demo contains an extension manifest');
  const files = visit(directory);
  const relativePaths = files.map((file) => path.relative(directory, file).replaceAll('\\', '/'));
  for (const relativePath of relativePaths) {
    assert.doesNotMatch(
      relativePath,
      /(?:^|\/)(?:background|content|options|popup|service-worker)(?:[/.]|$)/iu,
      `dist-demo contains an extension-only artifact: ${relativePath}`,
    );
  }
  const text = readInspectableSurface(directory, files);
  assert.ok(text.includes(DEMO_CANARY), 'dist-demo is missing the canonical Demo build marker');
  for (const marker of [
    'chrome.runtime.sendMessage',
    'chrome.storage.local',
    'indexedDB',
    'localStorage',
    'sessionStorage',
    'navigator.sendBeacon',
    'new WebSocket',
    'new EventSource',
    'api.github.com',
    'gist.github.com',
    'chrome-extension://',
    'gsm_github_credentials',
    'bgsm-agent-dev-control',
  ]) {
    assert.equal(text.includes(marker), false, `dist-demo leaked forbidden runtime marker: ${marker}`);
  }
}

function verifyExtensionOutput(directory) {
  assert.ok(existsSync(path.join(directory, 'manifest.json')), 'dist/manifest.json is missing');
  const files = visit(directory);
  const relativePaths = files.map((file) => path.relative(directory, file).replaceAll('\\', '/'));
  for (const relativePath of relativePaths) {
    assert.doesNotMatch(
      relativePath,
      /(?:^|[/.\-_])demo(?:[/.\-_]|$)/iu,
      `dist contains a Demo-named artifact: ${relativePath}`,
    );
  }
  const text = readInspectableSurface(directory, files);
  assert.equal(text.includes(DEMO_CANARY), false, 'dist leaked the canonical Demo fixture');
  assert.equal(text.includes('src/demo/'), false, 'dist leaked a Demo module path');
  assert.equal(text.includes('demo/index.html'), false, 'dist leaked the Demo HTML entry');
}

function verifyOneWaySourceImports() {
  const sourceRoot = path.join(root, 'src');
  const files = visit(sourceRoot).filter((file) => /\.[cm]?[jt]sx?$/u.test(file));
  const violations = [];
  const importPattern = /(?:from\s*|import\s*\(|import\s*)["']([^"']+)["']/gu;
  for (const file of files) {
    const relativePath = path.relative(sourceRoot, file).replaceAll('\\', '/');
    if (relativePath.startsWith('demo/')) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      const resolvesToDemo = specifier === '@/demo'
        || specifier.startsWith('@/demo/')
        || (specifier.startsWith('.')
          && path.resolve(path.dirname(file), specifier).startsWith(`${path.join(sourceRoot, 'demo')}${path.sep}`));
      if (resolvesToDemo) violations.push(`${relativePath}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, [], `Shared/extension source imports Demo modules:\n${violations.join('\n')}`);
}

function visit(directory) {
  assert.ok(existsSync(directory), `Missing artifact directory: ${path.relative(root, directory)}`);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symlink: ${target}`);
    if (entry.isDirectory()) files.push(...visit(target));
    else if (entry.isFile() && statSync(target).isFile()) files.push(target);
  }
  return files;
}

function readInspectableSurface(directory, files) {
  return files
    .filter((file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .map((file) => `${path.relative(directory, file)}\n${readFileSync(file, 'utf8')}`)
    .join('\n');
}
