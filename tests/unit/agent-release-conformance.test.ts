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

  it('states the complete Provider privacy boundary without forcing identical prose', () => {
    const privacy = read('docs/privacy-policy.md').toLowerCase();
    for (const phrase of [
      'prompt or bounded task instruction',
      'committed conversation history',
      'current prompt',
      'visible, bounded tag taxonomy',
      'private notes',
      'credentials or secrets',
      'github token',
      'unrelated or out-of-scope stars',
      'authorization: bearer',
      'x-api-key',
      'developer-operated proxy',
    ]) expect(privacy, `privacy policy is missing ${phrase}`).toContain(phrase);

    const submission = read('docs/chrome-web-store-submission.md').toLowerCase();
    for (const phrase of [
      'task data can include the prompt',
      'committed conversation history',
      'current-turn local evidence',
      'visible bounded tags',
      'unrequested private notes',
      'credentials',
      'github token',
      'unrelated stars',
      'authorization: bearer',
      'x-api-key',
      'developer-operated proxy',
    ]) expect(submission, `submission notes are missing ${phrase}`).toContain(phrase);

    for (const provider of ['openai', 'openrouter', 'anthropic', 'custom']) {
      expect(privacy).toContain(provider);
      expect(submission).toContain(provider);
    }
  });

  it('distinguishes the current retention and release contract from historical review evidence', () => {
    const privacy = read('docs/privacy-policy.md');
    expect(privacy).toMatch(/normally prunes valid settled attempts to the newest 128 per conversation/i);
    expect(privacy).toMatch(/current attempt and damaged recovery evidence beyond that normal pruning boundary/i);
    expect(privacy).toMatch(/until you explicitly delete the conversation/i);
    expect(privacy).not.toMatch(/(?:absolute|hard|maximum) (?:limit|maximum|cap) of 128/i);

    const submission = read('docs/chrome-web-store-submission.md');
    expect(submission).toMatch(/normally pruned to the newest 128 per conversation/i);
    expect(submission).toMatch(/current attempt and damaged recovery evidence may remain until explicit conversation deletion/i);

    const review = read('docs/bgsm-agent-implementation-review.md');
    const currentRecordEnd = review.indexOf('## 1. Original 2026-07 audit summary');
    expect(currentRecordEnd, 'implementation review is missing the historical-review boundary')
      .toBeGreaterThan(-1);
    const currentRecord = review.slice(0, currentRecordEnd);
    expect(currentRecord).toContain('Phase 7B worker-replacement evidence');
    expect(currentRecord).toMatch(/Phase 7B worker-replacement proofs are implemented and verified/i);
    expect(review).toContain('This document preserves the original findings and remediation plan as review history');
    expect(review).toContain('Historical evidence from the implementation audit before this document was written');
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


  it('wires one behavior-named, approval-gated release flow without legacy aliases', () => {
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
    const tagVersionCheck = workflow.indexOf('test "$TAG_NAME" = "v$package_version"');
    const runtimeVerification = workflow.indexOf('pnpm verify:agent-runtime');
    const gateFinalization = workflow.indexOf('pnpm verify:agent-release-gates');
    const canonicalEnumeration = workflow.indexOf('--list-release-artifacts');
    const artifactUpload = workflow.indexOf('uses: actions/upload-artifact');
    const githubRelease = workflow.indexOf('gh release create');
    const chromeWebStore = workflow.indexOf('node scripts/publish-chrome-web-store.mjs');

    expect(workflow).toContain('GSM_VERSION_APPROVAL');
    expect(workflow).not.toContain('verify:agent-phase5');
    expect(tagVersionCheck).toBeGreaterThan(-1);
    expect(tagVersionCheck).toBeLessThan(runtimeVerification);
    expect(runtimeVerification).toBeLessThan(gateFinalization);
    expect(gateFinalization).toBeLessThan(canonicalEnumeration);
    expect(canonicalEnumeration).toBeLessThan(artifactUpload);
    expect(artifactUpload).toBeLessThan(githubRelease);
    expect(githubRelease).toBeLessThan(chromeWebStore);

    expect(workflow).toContain('scripts/verify-agent-release-gates.mjs --list-release-artifacts');
    expect(workflow).toContain('path: ${{ steps.release-artifacts.outputs.files }}');
    expect(workflow).toContain('mapfile -t release_files');
    expect(workflow).toContain('"${release_files[@]}"');
    expect(workflow).not.toContain('artifacts/*');

    expect(workflow).toContain('publish_to_chrome_web_store:');
    expect(workflow).toContain(
      "if: ${{ github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/tags/') && inputs.publish_to_chrome_web_store == true && vars.CWS_DEPLOY_ENABLED == 'true' }}",
    );
    expect(workflow).toContain('CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}');
    expect(workflow).toContain('CWS_EXTENSION_ID: ${{ vars.CWS_EXTENSION_ID }}');

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

  it('records the context v2 Pi comparison and removes stale no-compaction claims', () => {
    const piReference = read('docs/plans/agent-provider/pi-source-reference.md');
    const normalizedPiReference = piReference.replace(/\s+/gu, ' ');
    for (const phrase of [
      '6d5ede31c8b8584b422bd0fa2ce10a39b2a0cdce',
      '1,050,000',
      '128,000',
      '272K',
      'dynamic tool-result allowance',
      'does not reuse `16384` as a byte result cap',
      'completed assistant-tool envelope',
    ]) expect(normalizedPiReference).toContain(phrase);

    const review = read('docs/bgsm-agent-implementation-review.md');
    expect(review).toContain('Automatic context compaction is now implemented');
    expect(review).not.toContain('- automatic context compaction;');

    const plan = read('docs/bgsm-agent-tag-assistant-plan.md');
    expect(plan).toContain('compacts before a turn and after a complete tool');
    expect(plan).not.toContain('MVP does not need full chat memory compaction yet');
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

function readSourceTree(relativeDirectory: string): string {
  const directory = path.join(root, relativeDirectory);
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      return entry.isDirectory() ? readSourceTree(relativePath) : [read(relativePath)];
    })
    .join('\n');
}
