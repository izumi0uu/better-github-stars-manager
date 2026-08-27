import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES,
  AGENT_SENT_TASK_DATA_CATEGORIES,
} from '@/bgsm-agent/disclosure';

const root = process.cwd();

describe('Agent release conformance', () => {
  it('keeps the runtime disclosure category contract wired into the informational UI', () => {
    const source = read('src/options/AgentDataDisclosurePanel.tsx');
    for (const category of [
      ...AGENT_SENT_TASK_DATA_CATEGORIES,
      ...AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES,
    ]) {
      expect(source).toContain(category);
    }
    expect(source).toContain('agentDisclosureKeyException');
    expect(source).toContain('agentDisclosureCustomAccess');
  });

  it('keeps manifest host declarations aligned with built-in and custom behavior', () => {
    const manifest = read('manifest.config.ts');
    expect(manifest).toContain("'https://api.openai.com/*'");
    expect(manifest).toContain("'https://api.anthropic.com/*'");
    expect(manifest).toContain("'https://openrouter.ai/*'");
    expect(manifest).toContain("optional_host_permissions");
    expect(manifest).toContain("'https://*/*'");
    expect(manifest).toContain("'http://localhost/*'");
    expect(manifest).toContain("'http://127.0.0.1/*'");
  });


  it('wires independent browser packaging, public-only assembly, and Chrome-only publication', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['verify:agent-runtime'])
      .toBe('node scripts/run-agent-runtime-verification.mjs');
    expect(packageJson.scripts['verify:agent-release-gates'])
      .toBe('node scripts/verify-agent-release-gates.mjs');
    expect(packageJson.scripts).not.toHaveProperty('verify:agent-phase5');
    expect(existsSync(path.join(root, 'scripts/run-agent-runtime-verification.mjs'))).toBe(true);
    expect(existsSync(path.join(root, 'scripts/run-agent-phase5-verification.mjs'))).toBe(false);

    const workflow = read('.github/workflows/release.yml');
    const packageChrome = topLevelJob(workflow, 'package-chrome');
    const packageFirefox = topLevelJob(workflow, 'package-firefox');
    const assemble = topLevelJob(workflow, 'assemble-release');
    const publish = topLevelJob(workflow, 'publish-chrome-web-store');

    expect(workflow).toMatch(/^permissions:\n  contents: read\n/m);
    expect(assemble).toContain('permissions:\n      contents: write');
    expect(workflow).not.toMatch(/^permissions:\n  contents: write\n/m);
    expect(workflow).toContain('GSM_VERSION_APPROVAL: ${{ vars.GSM_VERSION_APPROVAL }}');
    expect(workflow).not.toContain('verify:agent-phase5');

    for (const action of [
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
      'uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6',
      'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7',
      'uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7',
      'uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8',
    ]) {
      expect(workflow).toContain(action);
    }
    expect(workflow).not.toMatch(/uses: actions\/(?:checkout|upload-artifact|download-artifact)@v\d/gu);
    expect(workflow).not.toMatch(/uses: pnpm\/action-setup@v\d/gu);
    expect(workflow).not.toMatch(/uses: actions\/setup-node@v\d/gu);
    expect(workflow.match(/uses: actions\/checkout@/gu) ?? []).toHaveLength(4);
    expect(workflow.match(/uses: pnpm\/action-setup@/gu) ?? []).toHaveLength(2);
    expect(workflow.match(/uses: actions\/setup-node@/gu) ?? []).toHaveLength(4);
    expect(workflow.match(/uses: actions\/upload-artifact@/gu) ?? []).toHaveLength(5);
    expect(workflow.match(/uses: actions\/download-artifact@/gu) ?? []).toHaveLength(3);
    expect(workflow.match(/persist-credentials: false/gu) ?? []).toHaveLength(4);
    expect(workflow.match(/fetch-depth: 0/gu) ?? []).toHaveLength(4);

    for (const job of [packageChrome, packageFirefox]) {
      expect(job).toContain('pnpm install --frozen-lockfile');
      expect(job).not.toMatch(/^[ \t]+cache:[ \t]*pnpm[ \t]*$/m);
      expect(job).toContain('test "$TAG_NAME" = "v$package_version"');
      expect(job).toContain('pnpm verify:agent-runtime');
      expect(job).toContain('pnpm verify:agent-release-gates');
      expect(job).toContain('--list-release-artifacts');
      expect(job).toContain('--list-public-release-assets');
      expect(job).toContain('if-no-files-found: error');
      expect(job).toContain('release-private-');
      expect(job).toContain('release-public-');
    }
    expect(packageChrome).toContain('GSM_ARTIFACTS_DIR: artifacts');
    expect(packageChrome).not.toContain('GSM_PACKAGE_TARGET: firefox');
    expect(packageFirefox).toContain('GSM_BROWSER_TARGET: firefox');
    expect(packageFirefox).toContain('GSM_PACKAGE_TARGET: firefox');
    expect(packageFirefox).toContain('GSM_DIST_DIR: dist-firefox');
    expect(packageFirefox).toContain('GSM_ARTIFACTS_DIR: artifacts/firefox');
    expect(packageFirefox).toContain("PUPPETEER_HEADLESS: 'false'");
    expect(packageFirefox).toContain('xvfb-run -a pnpm verify:agent-runtime');
    expect(packageFirefox).toContain('pnpm exec puppeteer browsers install chrome');
    expect(packageFirefox).toContain('pnpm exec puppeteer browsers install firefox');
    expect(packageFirefox).toContain('pnpm exec puppeteer browsers install firefox@stable_140.0.4');
    expect(packageFirefox).toContain("pnpm exec puppeteer browsers install firefox --format '{{path}}'");
    expect(packageFirefox).toContain("pnpm exec puppeteer browsers install firefox@stable_140.0.4 --format '{{path}}'");
    expect(packageFirefox).toContain("printf 'FIREFOX_STABLE_EXECUTABLE=%s\\n'");
    expect(packageFirefox).toContain("printf 'FIREFOX_140_EXECUTABLE=%s\\n'");
    const runtimeVerification = packageFirefox.indexOf('pnpm verify:agent-runtime');
    const outputCheck = packageFirefox.indexOf('pnpm check:firefox-output');
    const firefoxLint = packageFirefox.indexOf('pnpm lint:firefox');
    const gateFinalization = packageFirefox.indexOf('pnpm verify:agent-release-gates');
    expect(runtimeVerification).toBeGreaterThan(-1);
    expect(outputCheck).toBeGreaterThan(runtimeVerification);
    expect(firefoxLint).toBeGreaterThan(outputCheck);
    expect(gateFinalization).toBeGreaterThan(firefoxLint);
    expect(packageFirefox).not.toContain('pnpm build:firefox');
    expect(packageFirefox).not.toContain('pnpm test:smoke:firefox');
    expect(packageFirefox).not.toContain('pnpm test:verify-firefox');

    expect(assemble).toContain('needs:\n      - package-chrome\n      - package-firefox');
    expect(assemble).toContain("needs.package-chrome.result == 'success'");
    expect(assemble).toContain("needs.package-firefox.result == 'success'");
    expect(assemble).toContain('name: release-public-chrome-${{ github.sha }}');
    expect(assemble).toContain('name: release-public-firefox-${{ github.sha }}');
    expect(assemble).toContain('path: release-files/chrome');
    expect(assemble).toContain('path: release-files/firefox');
    expect(assemble).toContain('set -euo pipefail');
    expect(assemble).toContain('for source_dir in release-files/chrome release-files/firefox; do');
    expect(assemble).toContain('if [[ -e "$destination_path" || -L "$destination_path" ]]');
    expect(assemble).toContain('Duplicate public release filename');
    expect(assemble).toContain('cp "$source_path" "$destination_path"');
    expect(assemble).not.toContain('cp -n');
    expect(assemble).toContain('--verify-public-release-directory release-files all');
    expect(assemble).toContain('test "$(wc -l < "$asset_list")" -eq 6');
    expect(assemble).toContain('name: release-public-${{ github.sha }}');
    expect(assemble).toContain('node-version: 24');
    expect(assemble).toContain('Create or verify immutable GitHub release');
    expect(assemble).toContain('mapfile -t release_files');
    expect(assemble).toContain('test "${#release_files[@]}" -eq 6');
    expect(assemble).toContain('gh release view "$TAG_NAME" --json assets --jq');
    expect(assemble).toContain('gh release download "$TAG_NAME"');
    expect(assemble).toContain('gh release create "$TAG_NAME" "${release_files[@]}"');
    expect(assemble).toContain('cmp -s "$release_file" "$existing_release_dir/downloaded/$asset_name"');
    expect(assemble).not.toMatch(/\bgh release (?:upload|edit|delete)\b/gu);
    expect(assemble).not.toContain('--clobber');
    expect(assemble).not.toContain('release-private-');

    expect(publish).toContain('needs: assemble-release');
    expect(publish).toContain("needs.assemble-release.result == 'success'");
    expect(publish).toContain('inputs.publish_to_chrome_web_store == true');
    expect(publish).toContain("vars.CWS_DEPLOY_ENABLED == 'true'");
    expect(publish).toContain('name: release-public-chrome-${{ github.sha }}');
    expect(publish).toContain('path: chrome-public');
    expect(publish).toContain('--verify-public-release-directory chrome-public chrome > "$RUNNER_TEMP/chrome-public-assets.txt"');
    expect(publish.match(/--verify-public-release-directory chrome-public chrome/gu) ?? []).toHaveLength(1);
    expect(publish).toContain('set -euo pipefail');
    expect(publish).toContain('mapfile -t chrome_assets < "$RUNNER_TEMP/chrome-public-assets.txt"');
    expect(publish).not.toContain('< <(');
    expect(publish).toContain('if [[ "${#chrome_zips[@]}" -ne 1 ]]');
    expect(publish).toContain('Expected exactly one Chrome ZIP in verified public inventory');
    expect(publish).toContain('node scripts/publish-chrome-web-store.mjs "$zip_path"');
    expect(publish).toContain('node-version: 24');
    expect(publish).not.toContain('release-public-firefox');
    expect(publish).not.toContain('release-private-');
    expect(publish).toContain('*firefox*|*-source.zip');

    const packaging = read('scripts/package-extension.mjs');
    expect(packaging).toContain('releaseReady: false');
    expect(packaging).toContain('agent_runtime_verification_required');
    expect(packaging).toContain('dashboardSubmissionClaimed: false');
    expect(packaging).toContain('GSM_APPROVED_RELEASE_VERSION');
    expect(packaging).toContain('GSM_TESTED_PACKAGE_INPUT');
    expect(packaging).toContain('GSM_RELEASE_BUILD_EVIDENCE');
  });

  it('ships real credential-free disclosure screenshots at allowed store dimensions', () => {
    const screenshots = [
      'public/store/screenshots/screenshot-main-stars.png',
      'public/store/screenshots/screenshot-detail-panel.png',
      'public/store/screenshots/screenshot-agent-disclosure-light-1280x800.png',
      'public/store/screenshots/screenshot-agent-disclosure-dark-640x400.png',
    ];
    for (const screenshot of screenshots) {
      const bytes = readFileSync(path.join(root, screenshot));
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      const dimensions = `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
      expect(['1280x800', '640x400']).toContain(dimensions);
    }

    const captureScript = read('scripts/capture-store-screenshots.mjs');
    expect(captureScript).toContain("assert.equal(disclosure.categoryCount, 4)");
    expect(captureScript).toContain("assert.equal(disclosure.collapsed, true)");
    expect(captureScript).toContain("assert.deepEqual(disclosure.passwordValues, [''])");
  });

  it('delegates Agent background authority through the worker runtime graph', () => {
    const background = read('src/background/index.ts');
    const runtime = read('src/background/bgsm-agent-runtime.ts');
    const sessionRpc = read('src/background/bgsm-agent-session-rpc.ts');
    const turnService = read('src/background/bgsm-agent-turn-service.ts');

    expect(background).toContain("from './bgsm-agent-runtime'");
    expect(background).toContain('bgsmAgentRuntime.sessionRpc.handle(agentSessionRequest)');
    expect(background).toContain('bgsmAgentRuntime.sessionRpc.describeFailure(e)');
    expect(background).toContain('attachBgsmAgentTurnPort(port, bgsmAgentRuntime.turnRegistry)');
    expect(background).toContain('if (!agentSessionRequest)');
    expect(background).toContain('chrome.runtime.onMessage.addListener');
    expect(background).toContain('chrome.runtime.onConnect.addListener');

    expect(runtime).toContain('export function createBgsmAgentRuntime');
    expect(sessionRpc).toContain('export type BgsmAgentSessionRequest');
    expect(sessionRpc).toContain('export function createBgsmAgentSessionRpcRouter');
    expect(turnService).toContain('export function createBgsmAgentTurnService');
    expect(sessionRpc).not.toContain('commitAgentSessionTransition');
    for (const extractedOwner of [runtime, sessionRpc, turnService]) {
      expect(extractedOwner).not.toContain('chrome.runtime');
      expect(extractedOwner).not.toContain("from './index'");
      expect(extractedOwner).not.toContain("from '@/background/index'");
    }
  });

  it('keeps per-page Agent client authority behind the external controller', () => {
    const hook = read('src/ui/hooks/use-bgsm-agent.ts');
    const controller = read('src/ui/agent-client-controller.ts');
    const sessionController = read('src/ui/agent-client-session-controller.ts');
    const turnController = read('src/ui/agent-client-turn-controller.ts');

    expect(hook).toContain("from '@/ui/agent-client-controller'");
    expect(hook).toContain('createBgsmAgentClientController');
    expect(hook).toContain('controller.updateOptions(options)');
    expect(hook).toContain('useSyncExternalStore');
    expect(controller).toContain('export function createBgsmAgentClientController');
    expect(sessionController).toContain('export function createBgsmAgentClientSessionController');
    expect(turnController).toContain('export function createBgsmAgentClientTurnController');
    expect(existsSync(path.join(root, 'src/ui/hooks/use-bgsm-agent-session-controller.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/ui/hooks/use-bgsm-agent-turn-controller.ts'))).toBe(false);
  });
  it('keeps Agent turn wire ownership in the shared protocol', () => {
    const protocol = read('src/bgsm-agent/turn-protocol.ts');
    const messaging = read('src/utils/messaging.ts');
    const backgroundPort = read('src/background/bgsm-agent-turn-port.ts');
    const sessionTransport = read('src/bgsm-agent/session-transport.ts');

    expect(protocol).not.toContain('export type BgsmAgentTurnEventPayload');
    for (const adapter of [messaging, backgroundPort]) {
      expect(adapter).toContain("from '@/bgsm-agent/turn-protocol'");
      for (const duplicateOwner of [
        'type BgsmAgentTurnClientMessage =',
        'type BgsmAgentTurnServerMessage =',
        'type BgsmAgentTurnPublishedMessage =',
        'type BgsmAgentTurnSequencedServerMessage =',
        'function validateAgentTurnEvent(',
        'function validateAgentTurnResult(',
        'function validateAgentTurnError(',
      ]) {
        expect(adapter).not.toContain(duplicateOwner);
      }
    }
    expect(sessionTransport).not.toContain('turn-protocol');
  });

  it('keeps product artifact policy outside the generic Agent harness', () => {
    const source = readSourceTree('src/agent-harness');
    for (const forbidden of [
      'read_agent_artifact',
      'artifact_available',
      '@/bgsm-agent',
      'IndexedDB',
      '@/storage',
      'AgentToolResultArtifactWriter',
      'AgentToolResultArtifactDisposer',
      'AgentToolResultArtifactPointer',
      'artifactIds',
    ]) {
      expect(source, `src/agent-harness contains forbidden boundary ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

});

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function topLevelJob(workflow: string, name: string): string {
  const jobsHeading = /^jobs:[ \t]*\r?$/m.exec(workflow);
  if (!jobsHeading) throw new Error('Missing top-level jobs mapping');

  const jobs = workflow.slice(jobsHeading.index + jobsHeading[0].length);
  const heading = new RegExp(
    String.raw`^  ${name}:[ \t]*\r?\n`,
    'm',
  ).exec(jobs);
  if (!heading) throw new Error(`Missing top-level workflow job: ${name}`);

  const contentStart = heading.index + heading[0].length;
  const remainder = jobs.slice(contentStart);
  const followingJob = remainder.search(/^  [A-Za-z0-9_-]+:[ \t]*\r?$/m);
  return followingJob === -1 ? remainder : remainder.slice(0, followingJob);
}

function readSourceTree(relativeDirectory: string): string {
  const directory = path.join(root, relativeDirectory);
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      return entry.isDirectory() ? readSourceTree(relativePath) : [read(relativePath)];
    })
    .join('\n');
}
