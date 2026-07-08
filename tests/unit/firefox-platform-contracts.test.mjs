import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import manifest from '../../manifest.config.ts';
import pkg from '../../package.json';
import { createFirefoxManifest, FIREFOX_DIST_DIR, FIREFOX_GECKO_ID, FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS } from '../../scripts/build-firefox-extension.mjs';
import { assertChromeManifestContract, chromePreservationRows } from '../../scripts/check-chrome-output-contracts.mjs';
import { assertFirefoxManifestContract } from '../../scripts/check-firefox-output-contracts.mjs';
import { createCapabilityLedger } from '../../scripts/generate-capability-ledger.mjs';
import { buildLedger, classifyPath, parseNameStatus, parseWorktreePorcelain } from '../../scripts/gate-minus-one-ledger.mjs';

const packageScriptSource = readFileSync(new URL('../../scripts/package-extension.mjs', import.meta.url), 'utf8');
const firefoxPackageScriptSource = readFileSync(new URL('../../scripts/package-firefox-extension.mjs', import.meta.url), 'utf8');
const firefoxSmokeScriptSource = readFileSync(new URL('../runtime/firefox-extension-smoke.mjs', import.meta.url), 'utf8');
const firefoxE2eScriptSource = readFileSync(new URL('../manual/e2e/verify-firefox.mjs', import.meta.url), 'utf8');

describe('Chrome manifest and package contracts', () => {
  it('keeps the source Chrome manifest on the MV3 service worker contract', () => {
    assertChromeManifestContract(manifest);
  });

  it('accepts CRXJS built loader entries in the Chrome output manifest', () => {
    assertChromeManifestContract({
      ...manifest,
      background: {
        service_worker: 'service-worker-loader.js',
        type: 'module',
      },
      action: {
        default_popup: 'src/popup/index.html',
      },
      options_ui: {
        page: 'src/options/index.html',
      },
      content_scripts: [
        {
          matches: ['https://github.com/*'],
          js: ['assets/index.tsx-loader-CF6jb6ek.js'],
          run_at: 'document_idle',
        },
        {
          matches: ['https://github.com/*'],
          js: ['assets/index.tsx-loader-DRVM6EPd.js'],
          run_at: 'document_idle',
        },
      ],
    });
  });

  it('keeps explicit Chrome build/package aliases before target split work', () => {
    assert.equal(pkg.scripts['build:chrome'], 'pnpm build');
    assert.equal(pkg.scripts['package:chrome'], 'pnpm package:extension');
  });

  it('adds explicit Firefox build/package/check aliases without changing legacy Chrome commands', () => {
    assert.equal(pkg.scripts.build, 'tsc --noEmit && vite build');
    assert.equal(pkg.scripts['package:extension'], 'node scripts/package-extension.mjs');
    assert.equal(pkg.scripts['build:firefox'], 'node scripts/build-firefox-extension.mjs');
    assert.equal(pkg.scripts['package:firefox'], 'node scripts/package-firefox-extension.mjs');
    assert.equal(pkg.scripts['check:firefox-output'], 'node scripts/check-firefox-output-contracts.mjs');
    assert.equal(pkg.scripts['lint:firefox'], 'pnpm dlx web-ext lint --source-dir dist-firefox');
    assert.equal(pkg.scripts['test:smoke:firefox'], 'node tests/runtime/firefox-extension-smoke.mjs');
    assert.equal(pkg.scripts['test:verify-firefox'], 'node tests/manual/e2e/verify-firefox.mjs');
  });

  it('records Chrome preservation rows with rollback moves', () => {
    for (const row of chromePreservationRows()) {
      assert.ok(row.surface);
      assert.ok(row.invariant);
      assert.ok(row.protectedTest);
      assert.ok(row.breakingSymptom);
      assert.ok(row.rollback);
    }
  });

  it('keeps the package script rooted on Chrome dist output', () => {
    assert.match(packageScriptSource, /const distDir = path\.resolve\(root, 'dist'\);/);
    assert.match(packageScriptSource, /path\.join\(distDir, 'manifest\.json'\)/);
    assert.match(packageScriptSource, /GSM_SKIP_PACKAGE_BUILD/);
    assert.doesNotMatch(packageScriptSource, /dist-firefox|dist\/firefox|artifacts\/firefox/);
  });

  it('keeps legacy Chrome artifacts while adding the separated Chrome target path', () => {
    assert.match(packageScriptSource, /const artifactsDir = path\.resolve\(root, 'artifacts'\);/);
    assert.match(packageScriptSource, /const chromeArtifactsDir = path\.join\(artifactsDir, 'chrome'\);/);
    assert.match(packageScriptSource, /const zipPath = path\.join\(artifactsDir, `\$\{baseName\}\.zip`\);/);
    assert.match(packageScriptSource, /const chromeZipPath = path\.join\(chromeArtifactsDir, `\$\{baseName\}\.zip`\);/);
    assert.match(packageScriptSource, /cpSync\(zipPath, chromeZipPath\);/);
  });

  it('keeps Firefox package artifacts separate from the legacy Chrome package path', () => {
    assert.match(firefoxPackageScriptSource, /const distDir = path\.resolve\(root, 'dist-firefox'\);/);
    assert.match(firefoxPackageScriptSource, /const artifactsDir = path\.resolve\(root, 'artifacts\/firefox'\);/);
    assert.match(firefoxPackageScriptSource, /GSM_SKIP_FIREFOX_BUILD/);
    assert.match(firefoxPackageScriptSource, /'web-ext'/);
    assert.match(firefoxPackageScriptSource, /'build'/);
    assert.match(firefoxPackageScriptSource, /'--source-dir'/);
    assert.match(firefoxPackageScriptSource, /'--artifacts-dir'/);
    assert.match(firefoxPackageScriptSource, /'--filename'/);
    assert.match(firefoxPackageScriptSource, /path\.basename\(zipPath\)/);
    assert.match(firefoxPackageScriptSource, /'--overwrite-dest'/);
    assert.match(firefoxPackageScriptSource, /'--ignore-files'/);
    for (const ignoredPath of ["'poster'", "'poster/**'", "'store'", "'store/**'", "'.DS_Store'", "'**/.DS_Store'"]) {
      assert.ok(firefoxPackageScriptSource.includes(ignoredPath));
    }
    assert.match(firefoxPackageScriptSource, /createHash\('sha256'\)/);
    assert.match(firefoxPackageScriptSource, /writeFileSync\(checksumPath/);
  });

});

describe('Firefox contract helper scripts', () => {
  it('can be imported from node eval without running their CLIs', () => {
    const scripts = [
      './scripts/build-firefox-extension.mjs',
      './scripts/check-chrome-output-contracts.mjs',
      './scripts/check-firefox-output-contracts.mjs',
      './scripts/generate-capability-ledger.mjs',
      './scripts/gate-minus-one-ledger.mjs',
      './scripts/package-firefox-extension.mjs',
      './tests/runtime/firefox-extension-smoke.mjs',
      './tests/manual/e2e/verify-firefox.mjs',
    ];

    for (const script of scripts) {
      execFileSync(process.execPath, ['-e', `await import(${JSON.stringify(script)})`], {
        cwd: new URL('../..', import.meta.url),
      });
    }
  });

  it('keeps Firefox smoke on moz-extension/web-ext paths instead of Chrome extension APIs', () => {
    assert.match(firefoxSmokeScriptSource, /dist-firefox/);
    assert.match(firefoxSmokeScriptSource, /web-ext/);
    assert.match(firefoxSmokeScriptSource, /FIREFOX_SMOKE_REQUIRE_BROWSER/);
    assert.doesNotMatch(firefoxSmokeScriptSource, /chrome-extension:\/\//);
    assert.doesNotMatch(firefoxSmokeScriptSource, /browser\.extensions\(\)/);
    assert.doesNotMatch(firefoxSmokeScriptSource, /service_worker/);
  });

  it('adds a Firefox e2e verifier that requires a real browser launch', () => {
    assert.match(firefoxE2eScriptSource, /resolveFirefoxExecutable/);
    assert.match(firefoxE2eScriptSource, /browser:\s*'firefox'/);
    assert.match(firefoxE2eScriptSource, /extraPrefsFirefox/);
    assert.match(firefoxE2eScriptSource, /installExtension\(firefoxDist\)/);
    assert.match(firefoxE2eScriptSource, /extensions\.webextensions\.uuids/);
    assert.match(firefoxE2eScriptSource, /moz-extension:\/\//);
    assert.doesNotMatch(firefoxE2eScriptSource, /prefs\.js/);
    assert.match(firefoxE2eScriptSource, /browser\.storage\.local\.set/);
    assert.match(firefoxE2eScriptSource, /browser\.storage\.local\.get/);
    assert.match(firefoxE2eScriptSource, /GitHub Token/);
    assert.match(firefoxE2eScriptSource, /package:firefox/);
    assert.match(firefoxE2eScriptSource, /check:firefox-output/);
    assert.match(firefoxE2eScriptSource, /lint:firefox/);
    assert.match(firefoxE2eScriptSource, /test:smoke:firefox/);
    assert.match(firefoxE2eScriptSource, /FIREFOX_SMOKE_REQUIRE_BROWSER/);
    assert.doesNotMatch(firefoxE2eScriptSource, /chrome-extension:\/\//);
  });
});

describe('Firefox Gate 0 manifest feasibility', () => {
  it('creates a target-specific Firefox manifest from the Chrome manifest', () => {
    const firefoxManifest = createFirefoxManifest({
      ...manifest,
      background: {
        service_worker: 'service-worker-loader.js',
        type: 'module',
      },
      content_scripts: [
        {
          matches: ['https://github.com/*'],
          js: ['assets/index.tsx-loader-CF6jb6ek.js'],
          run_at: 'document_idle',
        },
        {
          matches: ['https://github.com/*'],
          js: ['assets/index.tsx-loader-DRVM6EPd.js'],
          run_at: 'document_idle',
        },
      ],
    });

    assertFirefoxManifestContract(firefoxManifest);
    assert.deepEqual(firefoxManifest.background, {
      scripts: ['service-worker-loader.js'],
      type: 'module',
    });
    assert.equal(firefoxManifest.browser_specific_settings.gecko.id, FIREFOX_GECKO_ID);
    const requiredDataPermissions = firefoxManifest.browser_specific_settings.gecko.data_collection_permissions.required;
    assert.deepEqual(requiredDataPermissions, FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS);
    assert.deepEqual(requiredDataPermissions, ['authenticationInfo', 'websiteActivity', 'websiteContent']);
    assert.ok(!requiredDataPermissions.includes('none'));
    assert.equal(FIREFOX_DIST_DIR, 'dist-firefox');
  });
});

describe('Capability Ledger v0', () => {
  it('derives a static Chrome capability ledger from the manifest', () => {
    const ledger = createCapabilityLedger(manifest, {
      target: 'chrome',
      generatedAt: '2026-07-07T00:00:00.000Z',
    });

    assert.equal(ledger.schemaVersion, 1);
    assert.equal(ledger.target, 'chrome');
    assert.equal(ledger.manifestVersion, 3);
    assert.equal(ledger.backgroundMode, 'service_worker_module');
    assert.deepEqual(ledger.permissions, ['storage']);
    assert.ok(ledger.hostPermissions.includes('https://api.github.com/*'));
    assert.ok(ledger.hostPermissions.includes('https://github.com/*'));
    assert.equal(ledger.optionsPage, true);
    assert.equal(ledger.openOptionsPage, 'available-through-runtime-api');
    assert.equal(ledger.liveProbeStatus, 'deferred');
  });

  it('derives a static Firefox capability ledger from the target manifest', () => {
    const firefoxManifest = createFirefoxManifest({
      ...manifest,
      background: {
        service_worker: 'service-worker-loader.js',
        type: 'module',
      },
    });
    const ledger = createCapabilityLedger(firefoxManifest, {
      target: 'firefox',
      generatedAt: '2026-07-08T00:00:00.000Z',
    });

    assert.equal(ledger.target, 'firefox');
    assert.equal(ledger.backgroundMode, 'event_page_scripts_module');
    assert.equal(ledger.runtimeMessagingMode, 'webextension-promise-or-wrapper');
    assert.equal(ledger.liveProbeStatus, 'deferred');
  });
});

describe('Gate -1 overlap ledger', () => {
  it('classifies merge-sensitive surfaces', () => {
    assert.deepEqual(classifyPath('package.json'), ['package']);
    assert.deepEqual(classifyPath('manifest.config.ts'), ['build']);
    assert.deepEqual(classifyPath('src/utils/messaging.ts'), ['messaging']);
    assert.deepEqual(classifyPath('src/ui/ManagerPanel.tsx'), ['ui']);
  });

  it('parses git worktree porcelain output', () => {
    const worktrees = parseWorktreePorcelain(`worktree /repo\nHEAD abc\nbranch refs/heads/develop\n\nworktree /repo-agent\nHEAD def\nbranch refs/heads/feat/agent\nprunable gitdir file points to non-existent location\n`);

    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[0].branch, 'develop');
    assert.equal(worktrees[1].prunable, true);
  });

  it('parses name-status output including renames', () => {
    assert.deepEqual(parseNameStatus('M\tpackage.json\nR100\told.ts\tnew.ts'), [
      { status: 'M', file: 'package.json' },
      { status: 'R100', file: 'new.ts' },
    ]);
  });

  it('requires owner and decision for planned-path collisions', () => {
    const ledger = buildLedger({
      generatedAt: '2026-07-07T00:00:00.000Z',
      baseRef: 'develop',
      baseHead: 'base-sha',
      agentRef: 'feat/agent',
      agentHead: 'agent-sha',
      mergeBase: 'abc',
      leftOnly: 2,
      rightOnly: 1,
      plannedPaths: ['package.json', 'src/background/index.ts'],
      agentChanges: [
        { status: 'M', file: 'package.json' },
        { status: 'M', file: 'src/ui/ManagerPanel.tsx' },
      ],
      decisionMap: {
        'package.json': { owner: 'firefox-slice', decision: 'split' },
      },
    });

    assert.equal(ledger.branchStatus.state, 'diverged');
    assert.equal(ledger.baseHead, 'base-sha');
    assert.equal(ledger.agentHead, 'agent-sha');
    assert.equal(ledger.collisions.length, 1);
    assert.equal(ledger.collisions[0].path, 'package.json');
    assert.equal(ledger.passed, true);
  });

  it('fails when a collision has no decision', () => {
    const ledger = buildLedger({
      generatedAt: '2026-07-07T00:00:00.000Z',
      baseRef: 'develop',
      baseHead: 'base-sha',
      agentRef: 'feat/agent',
      agentHead: 'agent-sha',
      mergeBase: 'abc',
      leftOnly: 0,
      rightOnly: 1,
      plannedPaths: ['src/types/index.ts'],
      agentChanges: [{ status: 'M', file: 'src/types/index.ts' }],
    });

    assert.equal(ledger.branchStatus.state, 'ahead');
    assert.equal(ledger.passed, false);
  });

  it('fails when a collision has an unknown decision value', () => {
    const ledger = buildLedger({
      generatedAt: '2026-07-07T00:00:00.000Z',
      baseRef: 'develop',
      baseHead: 'base-sha',
      agentRef: 'feat/agent',
      agentHead: 'agent-sha',
      mergeBase: 'abc',
      leftOnly: 1,
      rightOnly: 1,
      plannedPaths: ['package.json'],
      agentChanges: [{ status: 'M', file: 'package.json' }],
      decisionMap: {
        'package.json': { owner: 'firefox-slice', decision: 'maybe' },
      },
    });

    assert.equal(ledger.passed, false);
  });
});

