import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES,
  AGENT_SENT_TASK_DATA_CATEGORIES,
} from '@/bgsm-agent/disclosure';

const root = process.cwd();

describe('Agent Phase 4 release conformance', () => {
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

  it.each([
    'docs/privacy-policy.md',
    'docs/chrome-web-store-submission.md',
  ])('%s states the complete AI-provider privacy boundary', (file) => {
    const text = read(file).toLowerCase();
    for (const phrase of [
      'prompt or bounded task instruction',
      'public repository metadata',
      'public code snippets',
      'current prompt',
      'local conversation history',
      'unencrypted',
      'diagnostics',
      'visible, bounded tag taxonomy',
      'protocol observations',
      'private notes',
      'credentials or secrets',
      'github token',
      'unrelated or out-of-scope stars',
      'authorization header',
      'developer-operated proxy',
    ]) {
      expect(text, `${file} is missing ${phrase}`).toContain(phrase);
    }
    expect(text).toContain('openai');
    expect(text).toContain('openrouter');
    expect(text).toContain('anthropic');
    expect(text).toContain('custom');
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


  it('packages auditable disclosure evidence', () => {
    const packaging = read('scripts/package-extension.mjs');
    expect(packaging).toContain('release-evidence-');
    expect(packaging).toContain('zipRootManifest');
    expect(packaging).toContain('packagedPermissions');
    expect(packaging).toContain('dashboardSubmissionClaimed: false');
    expect(packaging).toContain('releaseReady: false');
    expect(packaging).toContain('phase5_integrated_verification_required');
    expect(packaging).toContain('sourceDirty');
    expect(packaging).toContain('productionDisclosureMarkers');

    const verification = read('scripts/run-agent-phase5-verification.mjs');
    for (const check of [
      'typecheck',
      'test:vitest',
      'test:runtime',
      'test:smoke',
      'test:runtime:organize-job-host',
      'test:runtime:organize-job-recovery',
      'test:runtime:agent-diagnostics',
      'test:runtime:agent-scenarios',
      'package:extension',
    ]) expect(verification).toContain(check);
    expect(verification).toContain('GSM_DIST_DIR');
    expect(verification).toContain('GSM_ARTIFACTS_DIR');
    expect(verification).toContain("assertCleanSource('Phase 5 verification must start from a clean source tree.')");

    const finalizer = read('scripts/verify-agent-release-gates.mjs');
    expect(finalizer).toContain("releaseReady: true");
    expect(finalizer).toContain("phase5_integrated_verification_passed");
    expect(finalizer).toContain("dashboardSubmissionClaimed: false");
    expect(finalizer).toContain("git(['status', '--porcelain', '--untracked-files=normal'])");
    expect(finalizer).toContain("'agentDiagnosticsReleaseIsolation'");
    expect(finalizer).toContain("'agentScenariosExtensionHost'");
    expect(finalizer).toContain("'organizeJobRecovery'");

    const isolation = read('tests/runtime/agent-diagnostics-release-isolation.mjs');
    for (const boundary of [
      'release.zip',
      'externally_connectable',
      'bgsm-agent-dev-evidence-v1',
      'bgsm-agent-dev-control-v1',
      'bgsm-agent-dev-traces-v1',
      'SCENARIO_PRIVATE_CURRENT_PROMPT_CANARY',
      'indexedDB.databases()',
    ]) expect(isolation).toContain(boundary);

    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('pnpm verify:agent-phase5');
    expect(workflow).toContain('pnpm verify:agent-release-gates');
    expect(workflow.indexOf('pnpm verify:agent-release-gates'))
      .toBeLessThan(workflow.indexOf('uses: actions/upload-artifact'));
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

  it('keeps Agent session RPC failures isolated from global sync progress', () => {
    const background = read('src/background/index.ts');
    expect(background).toContain('if (!isAgentSessionRequest(req))');
    for (const request of [
      'inspectAgentSessionCatalog',
      'createAgentSession',
      'loadAgentSession',
      'loadAgentSessionTranscriptPage',
      'deleteAgentSession',
      'getAgentStorageUsage',
      'clearAgentToolCache',
    ]) {
      expect(background).toContain(`'${request}'`);
    }
    // Turn commits are owned by the admitted background lease. They must not
    // be exposed as a UI-callable RPC that could carry a large transition.
    expect(background).not.toContain("'commitAgentSessionTransition'");
  });
  it('keeps product artifact policy outside the generic Agent harness', () => {
    const source = readSourceTree('src/agent-harness');
    for (const forbidden of [
      'read_agent_artifact',
      'artifact_available',
      '@/bgsm-agent',
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
