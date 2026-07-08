#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertFirefoxManifestContract,
  readJsonFile,
} from '../../scripts/check-firefox-output-contracts.mjs';

const DIST = path.resolve(process.cwd(), 'dist-firefox');
const MANIFEST_PATH = path.join(DIST, 'manifest.json');
const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const REQUIRE_BROWSER = process.env.FIREFOX_SMOKE_REQUIRE_BROWSER === 'true';

const COMMON_FIREFOX_PATHS = [
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
  '/usr/local/bin/firefox',
  '/opt/homebrew/bin/firefox',
];

function isCliEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function step(message) {
  console.log(`\n${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function skip(message) {
  console.log(`  SKIP ${message}`);
}

function failOrSkip(message) {
  if (REQUIRE_BROWSER) {
    throw new Error(`${message}. Set FIREFOX_EXECUTABLE_PATH or install Firefox to run the browser smoke.`);
  }
  skip(`${message}. Set FIREFOX_SMOKE_REQUIRE_BROWSER=true to make this a hard failure.`);
}

function assertFile(relativePath, label) {
  const absolutePath = path.join(DIST, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Firefox smoke missing ${label}: ${path.relative(process.cwd(), absolutePath)}`);
  }
  ok(`${label}: ${relativePath}`);
}

export function resolveFirefoxExecutable(env = process.env) {
  const configured = env.FIREFOX_EXECUTABLE_PATH ?? env.WEB_EXT_FIREFOX_BINARY;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`Configured Firefox executable does not exist: ${configured}`);
    }
    return configured;
  }

  for (const candidate of COMMON_FIREFOX_PATHS) {
    if (existsSync(candidate)) return candidate;
  }

  for (const alias of ['firefox', 'firefox-nightly', 'firefoxdeveloperedition']) {
    const resolved = spawnSync('sh', ['-lc', `command -v ${alias}`], {
      encoding: 'utf8',
    });
    const executable = resolved.stdout.trim();
    if (resolved.status === 0 && executable) return executable;
  }

  return null;
}

function assertFirefoxDistShape() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`No dist-firefox/manifest.json found at ${DIST}. Run "pnpm build:firefox" first.`);
  }

  const manifest = readJsonFile(MANIFEST_PATH);
  assertFirefoxManifestContract(manifest);
  ok('Firefox manifest contract passed');

  assertFile(manifest.background.scripts[0], 'background module loader');
  assertFile(manifest.action.default_popup, 'action popup page');
  assertFile(manifest.options_ui.page, 'options page');

  for (const [index, script] of manifest.content_scripts.entries()) {
    for (const jsPath of script.js ?? []) {
      assertFile(jsPath, `content script ${index + 1}`);
    }
  }
}

function webExtVersion() {
  const result = spawnSync('pnpm', ['dlx', 'web-ext', '--version'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return {
      ok: false,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    };
  }

  return {
    ok: true,
    output: result.stdout.trim() || result.stderr.trim(),
  };
}

async function runWebExtFirefoxSmoke(firefoxExecutable) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'gsm-firefox-smoke-'));
  const timeoutMs = Number(process.env.FIREFOX_SMOKE_TIMEOUT_MS ?? DEFAULT_LAUNCH_TIMEOUT_MS);
  const args = [
    'dlx',
    'web-ext',
    'run',
    '--source-dir',
    DIST,
    '--target',
    'firefox-desktop',
    '--firefox',
    firefoxExecutable,
    '--firefox-profile',
    profile,
    '--profile-create-if-missing',
    '--no-reload',
    '--no-input',
    '--start-url',
    'about:blank',
  ];

  const output = [];
  let sawRunnerReady = false;
  let sawError = false;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (result instanceof Error) {
          reject(result);
          return;
        }
        resolve();
      };

      const child = spawn('pnpm', args, {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const collect = (chunk) => {
        const text = chunk.toString();
        output.push(text);
        if (/The extension will reload|Installed|Running web extension from/i.test(text)) {
          sawRunnerReady = true;
        }
        if (/\bERROR\b|WebExtError|Error:/i.test(text)) {
          sawError = true;
        }
      };

      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', finish);
      child.on('exit', (code, signal) => {
        if (sawRunnerReady && !sawError) {
          finish();
          return;
        }
        finish(
          new Error(
            `web-ext exited before Firefox smoke became ready (code=${code}, signal=${signal}).\n${output.join('')}`,
          ),
        );
      });

      timeout = setTimeout(() => {
        child.kill('SIGTERM');
        if (sawError) {
          finish(new Error(`web-ext reported an error during Firefox smoke.\n${output.join('')}`));
          return;
        }
        if (!sawRunnerReady) {
          finish(new Error(`web-ext did not report Firefox smoke readiness before timeout.\n${output.join('')}`));
          return;
        }
        finish();
      }, timeoutMs);
    });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

export async function main() {
  step('1) Firefox output contract');
  assertFirefoxDistShape();

  step('2) Firefox browser runner');
  const firefoxExecutable = resolveFirefoxExecutable();
  if (!firefoxExecutable) {
    failOrSkip('Firefox executable not found');
    return;
  }
  ok(`Firefox executable: ${firefoxExecutable}`);

  const webExt = webExtVersion();
  if (!webExt.ok) {
    failOrSkip(`web-ext is unavailable through pnpm dlx${webExt.output ? `: ${webExt.output}` : ''}`);
    return;
  }
  ok(`web-ext available: ${webExt.output}`);

  await runWebExtFirefoxSmoke(firefoxExecutable);
  ok('web-ext launched Firefox with dist-firefox and closed after the readiness window');

  console.log('\nFirefox extension smoke passed.');
}

if (isCliEntry()) {
  main().catch((error) => {
    console.error(`\nFirefox extension smoke failed:\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
