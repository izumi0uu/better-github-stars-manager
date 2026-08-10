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
