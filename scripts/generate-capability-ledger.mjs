#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function detectBackgroundMode(background = {}) {
  if (background.service_worker && background.type === 'module') return 'service_worker_module';
  if (background.service_worker) return 'service_worker';
  if (Array.isArray(background.scripts) && background.type === 'module') return 'event_page_scripts_module';
  if (Array.isArray(background.scripts)) return 'event_page_scripts';
  if (background.page) return 'event_page';
  return 'none';
}

export function createCapabilityLedger(manifest, options = {}) {
  const target = options.target ?? 'chrome';

  return {
    schemaVersion: 1,
    target,
    source: options.source ?? 'static-manifest',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    manifestVersion: manifest.manifest_version,
    backgroundMode: detectBackgroundMode(manifest.background),
    permissions: [...(manifest.permissions ?? [])].sort(),
    hostPermissions: [...(manifest.host_permissions ?? [])].sort(),
    optionsPage: Boolean(manifest.options_ui?.page),
    actionPopup: Boolean(manifest.action?.default_popup),
    contentScripts: (manifest.content_scripts ?? []).map((script) => ({
      matches: script.matches ?? [],
      js: script.js ?? [],
      runAt: script.run_at ?? null,
    })),
    tabsCreate: 'available-through-runtime-api',
    openOptionsPage: manifest.options_ui?.page ? 'available-through-runtime-api' : 'unavailable',
    runtimeMessagingMode: target === 'chrome' ? 'chrome-callback-wrapped' : 'webextension-promise-or-wrapper',
    unavailableCapabilities: [],
    liveProbeStatus: 'deferred',
  };
}

function parseArgs(argv) {
  const args = {
    manifest: path.resolve(process.cwd(), 'dist/manifest.json'),
    target: 'chrome',
    output: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') args.manifest = path.resolve(process.cwd(), argv[++i]);
    else if (arg === '--target') args.target = argv[++i];
    else if (arg === '--output') args.output = path.resolve(process.cwd(), argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function isCliEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readJson(args.manifest);
  const ledger = createCapabilityLedger(manifest, {
    target: args.target,
    source: path.relative(process.cwd(), args.manifest),
  });
  const output = `${JSON.stringify(ledger, null, 2)}\n`;

  if (args.output) {
    writeFileSync(args.output, output);
    console.log(`Capability ledger written: ${path.relative(process.cwd(), args.output)}`);
  } else {
    process.stdout.write(output);
  }
}

if (isCliEntry()) {
  main();
}
