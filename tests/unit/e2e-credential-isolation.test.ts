import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const ACTION_PINS: Record<string, { sha: string; version: string }> = {
  'actions/checkout': {
    sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
    version: 'v7',
  },
  'actions/setup-node': {
    sha: '820762786026740c76f36085b0efc47a31fe5020',
    version: 'v7',
  },
  'actions/upload-artifact': {
    sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    version: 'v7',
  },
  'pnpm/action-setup': {
    sha: '0977fd99725f1db4007ccb2928dbb4e90d06cc86',
    version: 'v6',
  },
};

describe('E2E credential isolation', () => {
  it('keeps credential-free and authenticated browser verification isolated', () => {
    const workflow = read('.github/workflows/e2e.yml');
    expect(workflow).not.toContain('GSM_RESET_GIST');
    const noTokenJob = jobBlock(workflow, 'verify-extension-no-token');
    const authenticatedJob = jobBlock(workflow, 'verify-extension-authenticated');

    expect(noTokenJob).not.toContain('secrets.');
    expectCheckoutCredentialPersistenceDisabled(noTokenJob);
    expectCheckoutCredentialPersistenceDisabled(authenticatedJob);

    const authenticatedCondition = jobField(authenticatedJob, 'if').replace(/\s+/g, ' ');
    expect(authenticatedCondition).toMatch(
      /github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)\)/,
    );
    expect(authenticatedJob).toMatch(/^[ \t]*environment:[ \t]*e2e-credentials[ \t]*$/m);
    expect(authenticatedJob).toMatch(
      /^[ \t]*group:[ \t]*e2e-credentials-\$\{\{ github\.ref \}\}[ \t]*$/m,
    );
    expect(authenticatedJob).toMatch(
      /^[ \t]*cancel-in-progress:[ \t]*false[ \t]*$/m,
    );
    expect(authenticatedJob).toMatch(
      /\$\{\{\s*secrets\.E2E_GH_TOKEN\s*\}\}/,
    );
    expect(authenticatedJob).toMatch(
      /\$\{\{\s*secrets\.E2E_GH_TOKEN_NO_GISTS\s*\}\}/,
    );
    expect(authenticatedJob).toMatch(
      /\$\{GSM_SCENARIO:-[^}\r\n]*\bno-gists-token\b[^}\r\n]*\}/,
    );
    expect(authenticatedJob).toMatch(/--require-selected\b/);

    expect(workflow).not.toMatch(/\bsecrets\.GH_TOKEN\b/);
    expect(workflow).not.toMatch(/\bsecrets\.GH_TOKEN_NO_GISTS\b/);
  });

  it('keeps canonical workflow coverage representative', () => {
    const ciWorkflow = read('.github/workflows/ci.yml');
    const ciJob = jobBlock(ciWorkflow, 'verify');
    expectCheckoutCredentialPersistenceDisabled(ciJob);
    expectActionsPinned(ciWorkflow, [
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'actions/upload-artifact',
    ]);
    expectActionlintVerification(ciJob);

    const e2eWorkflow = read('.github/workflows/e2e.yml');
    expectActionsPinned(e2eWorkflow, [
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
    ]);
    expect(e2eWorkflow).toMatch(
      /^  push:\r?\n    branches:\r?\n      - master[ \t]*$/m,
    );

    const noTokenJob = jobBlock(e2eWorkflow, 'verify-extension-no-token');
    const firstRun = noTokenJob.indexOf(
      'pnpm test:verify-first-run -- --scenario=no-token',
    );
    const productionBuild = noTokenJob.indexOf(
      'GSM_RELEASE=true GSM_DEV=false pnpm build',
    );
    const agentSession = noTokenJob.indexOf(
      'pnpm test:runtime:agent-session',
    );
    expect(firstRun).toBeGreaterThan(-1);
    expect(productionBuild).toBeGreaterThan(firstRun);
    expect(agentSession).toBeGreaterThan(productionBuild);

    const packagedHostCommands = noTokenJob.match(
      /pnpm test:runtime:(?:agent-[A-Za-z0-9-]+|organize-job-[A-Za-z0-9-]+)/g,
    ) ?? [];
    expect(packagedHostCommands).toEqual(['pnpm test:runtime:agent-session']);

    expectInOrder(ciJob, [
      'pnpm build:edge',
      'pnpm check:edge-output',
      'pnpm build:demo',
      'pnpm verify:artifact-isolation',
      'pnpm exec puppeteer browsers install chrome',
      'pnpm test:demo:browser',
      'pnpm test',
    ]);
  });

  it('keeps Firefox verification credential-free and event-scoped', () => {
    const workflow = read('.github/workflows/e2e-firefox.yml');
    expect(workflow).toMatch(/^name: E2E Firefox Verification[ \t]*$/m);

    const triggerStart = workflow.indexOf('on:');
    const triggerEnd = workflow.indexOf('\nconcurrency:');
    expect(triggerStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(triggerStart);
    expect(workflow.slice(triggerStart, triggerEnd).replace(/\r/g, '').trim()).toBe([
      'on:',
      '  pull_request:',
      '  push:',
      '    branches:',
      '      - master',
      '  workflow_dispatch:',
      '  schedule:',
      "    - cron: '0 4 * * 1'",
    ].join('\n'));
    expect(workflow).toMatch(/^concurrency:\r?\n  group: e2e-firefox-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\r?\n  cancel-in-progress: true[ \t]*$/m);
    expect(workflow).toMatch(/^permissions:\r?\n  contents: read[ \t]*$/m);

    const jobsStart = workflow.indexOf('\njobs:\n');
    expect(jobsStart).toBeGreaterThan(-1);
    const jobNames = Array.from(
      workflow.slice(jobsStart + '\njobs:\n'.length).matchAll(/^  ([A-Za-z0-9_-]+):[ \t]*\r?$/gm),
      ([, name]) => name,
    );
    expect(jobNames).toEqual(['verify-firefox-stable', 'verify-firefox-versions']);

    const stableJob = jobBlock(workflow, 'verify-firefox-stable');
    const versionsJob = jobBlock(workflow, 'verify-firefox-versions');
    expect(jobField(stableJob, 'if').replace(/\s+/g, ' ').trim()).toBe(
      "github.event_name == 'pull_request' || github.event_name == 'push'",
    );
    expect(jobField(versionsJob, 'if').replace(/\s+/g, ' ').trim()).toBe(
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    );

    expect(workflow).not.toMatch(/\bsecrets\./);
    expect(workflow).not.toMatch(/\$\{\{\s*github\.token\s*\}\}/);
    expect(workflow).not.toMatch(
      /\b(?:GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AI_INPUT_API_KEY|CUBBY_API_KEY)\b/,
    );
    expect(workflow.match(/xvfb-run -a pnpm test:(?:smoke:firefox|verify-firefox)/gu) ?? []).toHaveLength(2);
    expectCheckoutCredentialPersistenceDisabled(stableJob);
    expectCheckoutCredentialPersistenceDisabled(versionsJob);
    expectActionsPinned(workflow, [
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'actions/upload-artifact',
    ]);

    for (const job of [stableJob, versionsJob]) {
      expect(job).toMatch(/^[ \t]*version:[ \t]*10\.33\.2[ \t]*$/m);
      expect(job).toMatch(/^[ \t]*node-version:[ \t]*24[ \t]*$/m);
      expect(job).toContain('pnpm install --frozen-lockfile');
      expect(job.match(/^[ \t]*PUPPETEER_HEADLESS:[ \t]*'false'[ \t]*$/gm) ?? []).toHaveLength(1);
      expect(job).not.toMatch(/^[ \t]*PUPPETEER_HEADLESS:[ \t]*'(?:true|new)'[ \t]*$/m);
      expect(job.match(/uses: actions\/upload-artifact@/g) ?? []).toHaveLength(1);
      expect(job).toMatch(/^[ \t]*path:[ \t]*dist-firefox[ \t]*$/m);
    }

    expectInOrder(stableJob, [
      'pnpm install --frozen-lockfile',
      'pnpm exec puppeteer browsers install firefox',
      "pnpm exec puppeteer browsers install firefox --format '{{path}}'",
      'pnpm build:firefox',
      'pnpm check:firefox-output',
      'pnpm lint:firefox',
      'pnpm test:smoke:firefox',
      'uses: actions/upload-artifact@',
    ]);
    expect(stableJob).not.toContain('firefox@stable_140.0.4');
    expect(stableJob).not.toContain('pnpm test:verify-firefox');
    expect(stableJob).toContain("printf 'FIREFOX_EXECUTABLE=%s\\n'");

    expectInOrder(versionsJob, [
      'pnpm install --frozen-lockfile',
      'pnpm exec puppeteer browsers install firefox',
      'pnpm exec puppeteer browsers install firefox@stable_140.0.4',
      'Resolve Firefox executable paths',
      'pnpm build:firefox',
      'pnpm check:firefox-output',
      'pnpm test:verify-firefox',
      'uses: actions/upload-artifact@',
    ]);
    expect(versionsJob.match(/pnpm build:firefox/g) ?? []).toHaveLength(1);
    expect(versionsJob.match(/pnpm check:firefox-output/g) ?? []).toHaveLength(1);
    expect(versionsJob).not.toContain('pnpm lint:firefox');
    expect(versionsJob).not.toContain('pnpm test:smoke:firefox');
    expect(versionsJob).toContain(
      "pnpm exec puppeteer browsers install firefox --format '{{path}}'",
    );
    expect(versionsJob).toContain(
      "pnpm exec puppeteer browsers install firefox@stable_140.0.4 --format '{{path}}'",
    );
    expect(versionsJob).not.toContain('resolveExecutablePath');
    expect(versionsJob).toMatch(/^[ \t]*id:[ \t]*firefox-paths[ \t]*$/m);
    expect(versionsJob).toContain(
      "printf 'stable=%s\\n' \"$stable_executable\" >> \"$GITHUB_OUTPUT\"",
    );
    expect(versionsJob).toContain(
      "printf 'minimum=%s\\n' \"$minimum_executable\" >> \"$GITHUB_OUTPUT\"",
    );
    expect(versionsJob).toMatch(
      /^[ \t]*FIREFOX_STABLE_EXECUTABLE:[ \t]*\$\{\{ steps\.firefox-paths\.outputs\.stable \}\}[ \t]*$/m,
    );
    expect(versionsJob).toMatch(
      /^[ \t]*FIREFOX_140_EXECUTABLE:[ \t]*\$\{\{ steps\.firefox-paths\.outputs\.minimum \}\}[ \t]*$/m,
    );
  });

  it('proves Microsoft Edge verification uses a real Edge binary without credentials', () => {
    const workflow = read('.github/workflows/e2e-edge.yml');
    expect(workflow).toMatch(/^name: E2E Edge Verification[ \t]*$/m);
    expect(workflow).toMatch(/^permissions:\r?\n  contents: read[ \t]*$/m);
    expect(workflow).toMatch(
      /^concurrency:\r?\n  group: e2e-edge-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\r?\n  cancel-in-progress: true[ \t]*$/m,
    );

    expect(workflow).not.toMatch(/\bsecrets\./);
    expect(workflow).not.toMatch(/\$\{\{\s*github\.token\s*\}\}/);
    expect(workflow).not.toMatch(
      /\b(?:GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AI_INPUT_API_KEY|CUBBY_API_KEY)\b/,
    );

    const job = jobBlock(workflow, 'verify-edge-stable');
    expectCheckoutCredentialPersistenceDisabled(job);
    expectActionsPinned(workflow, [
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'actions/upload-artifact',
    ]);

    expectInOrder(job, [
      'pnpm install --frozen-lockfile',
      "printf 'EDGE_EXECUTABLE=%s\\n'",
      'pnpm build:edge',
      'pnpm check:edge-output',
      'xvfb-run -a pnpm test:smoke:edge',
      'uses: actions/upload-artifact@',
    ]);
    expect(job).toMatch(/^[ \t]*path:[ \t]*dist-edge[ \t]*$/m);

    // Release identity proof requires the real Edge binary; substituting Chrome or Chromium
    // downgrades the evidence to test-only scope, so the resolver must never fall back.
    const resolveStep = stepBlock(job, 'Resolve Microsoft Edge executable');
    expect(resolveStep).toContain('set -euo pipefail');
    expect(resolveStep).toContain('microsoft-edge-stable');
    expect(resolveStep).not.toMatch(/\bchrom(?:e|ium)\b/i);
    expect(job).not.toContain('allowNonEdgeExecutableForLocalTest');
  });
});

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function jobBlock(workflow: string, name: string): string {
  const heading = new RegExp(
    String.raw`^([ \t]+)${name}:[ \t]*\r?\n`,
    'm',
  ).exec(workflow);

  if (!heading) {
    throw new Error(`Missing workflow job: ${name}`);
  }

  const contentStart = heading.index + heading[0].length;
  const remainder = workflow.slice(contentStart);
  const followingJob = remainder.search(
    new RegExp(String.raw`^${heading[1]}[A-Za-z0-9_-]+:[ \t]*\r?$`, 'm'),
  );

  return followingJob === -1 ? remainder : remainder.slice(0, followingJob);
}

function jobField(job: string, name: string): string {
  const field = new RegExp(
    String.raw`^([ \t]+)${name}:[ \t]*(.*)\r?$`,
    'm',
  ).exec(job);

  if (!field) {
    throw new Error(`Missing ${name} in E2E workflow job`);
  }

  const remainder = job.slice(field.index + field[0].length);
  const followingField = remainder.search(
    new RegExp(String.raw`^${field[1]}[A-Za-z0-9_-]+:[ \t]*`, 'm'),
  );

  return field[2] + (followingField === -1 ? remainder : remainder.slice(0, followingField));
}

function expectCheckoutCredentialPersistenceDisabled(job: string): void {
  const checkoutSteps = job
    .split(/(?=^[ \t]*-[ \t])/m)
    .filter((step) => /^[ \t]*(?:-[ \t]+)?uses:[ \t]*actions\/checkout@/m.test(step));

  if (checkoutSteps.length === 0) {
    throw new Error('Missing actions/checkout step in workflow job');
  }

  for (const checkoutStep of checkoutSteps) {
    expect(checkoutStep).toMatch(/^[ \t]*persist-credentials:[ \t]*false[ \t]*$/m);
  }
}

function expectActionsPinned(
  workflow: string,
  expectedActions: readonly string[],
): void {
  const useLines = workflow.match(/^[ \t]*uses:[ \t]*[^\r\n]+\r?$/gm) ?? [];
  const actionReferences = Array.from(
    workflow.matchAll(
      /^[ \t]*uses:[ \t]*([^@\s]+)@([^\s#]+)[ \t]+#[ \t]+([^\s]+)[ \t]*\r?$/gm,
    ),
  );

  expect(actionReferences).toHaveLength(useLines.length);
  expect(actionReferences.length).toBeGreaterThan(0);
  expect(workflow).not.toMatch(/^[ \t]*uses:[^\r\n]*@v\d+\b/m);

  const actions = actionReferences.map(([, action]) => action);
  for (const action of expectedActions) {
    expect(actions).toContain(action);
  }

  for (const [, action, ref, version] of actionReferences) {
    const expectedPin = ACTION_PINS[action];
    if (!expectedPin) {
      throw new Error(`Unexpected workflow action: ${action}`);
    }

    expect(ref).toMatch(/^[0-9a-f]{40}$/);
    expect(ref).toBe(expectedPin.sha);
    expect(version).toBe(expectedPin.version);
  }
}

function expectActionlintVerification(ciJob: string): void {
  const stepNames = Array.from(
    ciJob.matchAll(/^[ \t]*-[ \t]+name:[ \t]*(.+?)[ \t]*\r?$/gm),
    ([, name]) => name,
  );
  const checkoutStep = stepNames.indexOf('Checkout');
  expect(checkoutStep).toBeGreaterThanOrEqual(0);
  expect(stepNames[checkoutStep + 1]).toBe('Lint workflows with actionlint');

  const actionlintStep = stepBlock(ciJob, 'Lint workflows with actionlint');
  const archiveUrl =
    'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz';
  const checksum =
    '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
  const download = actionlintStep.indexOf(
    'curl --fail --location --silent --show-error',
  );
  const checksumVerification = actionlintStep.indexOf(
    'sha256sum --check --status',
  );
  const extraction = actionlintStep.indexOf(
    'tar --extract --gzip --file "$archive" --directory "$actionlint_dir" actionlint',
  );
  const execution = actionlintStep.indexOf(
    '"$actionlint_dir/actionlint" .github/workflows/*.yml',
  );

  expect(actionlintStep).toMatch(/^[ \t]*shell:[ \t]*bash[ \t]*$/m);
  expect(actionlintStep).toContain('set -euo pipefail');
  expect(actionlintStep).toContain(
    'actionlint_dir="${RUNNER_TEMP}/actionlint-1.7.12"',
  );
  expect(actionlintStep).toContain(archiveUrl);
  expect(actionlintStep).toContain(checksum);
  expect(actionlintStep).toContain('sha256sum --check --status');
  expect(actionlintStep).toContain('.github/workflows/*.yml');

  expect(download).toBeGreaterThan(-1);
  expect(checksumVerification).toBeGreaterThan(download);
  expect(extraction).toBeGreaterThan(checksumVerification);
  expect(execution).toBeGreaterThan(extraction);
}

function stepBlock(job: string, name: string): string {
  const heading = new RegExp(
    String.raw`^([ \t]*)-[ \t]+name:[ \t]*${name}[ \t]*\r?\n`,
    'm',
  ).exec(job);

  if (!heading) {
    throw new Error(`Missing workflow step: ${name}`);
  }

  const contentStart = heading.index + heading[0].length;
  const remainder = job.slice(contentStart);
  const followingStep = remainder.search(
    new RegExp(String.raw`^${heading[1]}-[ \t]+name:[ \t]*`, 'm'),
  );

  return followingStep === -1 ? remainder : remainder.slice(0, followingStep);
}

function expectInOrder(source: string, values: readonly string[]): void {
  let cursor = 0;
  for (const value of values) {
    const index = source.indexOf(value, cursor);
    expect(index, `Missing or out-of-order workflow source: ${value}`).toBeGreaterThanOrEqual(cursor);
    cursor = index + value.length;
  }
}
