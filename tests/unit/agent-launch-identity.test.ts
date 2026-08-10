import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  digestAgentSessionLaunch,
  validateAgentSessionLaunchIdentity,
  type AgentSessionLaunchIdentity,
} from '@/bgsm-agent/session-transport';

const SELECTED_REPOSITORY_CANDIDATE = {
  kind: 'selected_repository' as const,
  selectedRepositoryIdHint: 'owner/repository',
};

function freshLaunch(): AgentSessionLaunchIdentity {
  return {
    turnAttemptId: 'attempt-launch-identity',
    sessionId: 'session-launch-identity',
    baseRevision: 3,
    prompt: 'Inspect the selected repository.',
    candidateContract: SELECTED_REPOSITORY_CANDIDATE,
  };
}

describe('Agent session launch identity', () => {
  it('digests the same immutable launch deterministically', async () => {
    const launch = freshLaunch();

    assert.equal(
      await digestAgentSessionLaunch(launch),
      await digestAgentSessionLaunch(launch),
    );
  });

  it('distinguishes a retry source from a fresh launch and from another source', async () => {
    const fresh = freshLaunch();
    const retry = {
      ...fresh,
      retrySourceAttemptId: 'attempt-retry-source-one',
    } satisfies AgentSessionLaunchIdentity;
    const differentRetrySource = {
      ...retry,
      retrySourceAttemptId: 'attempt-retry-source-two',
    } satisfies AgentSessionLaunchIdentity;

    const freshDigest = await digestAgentSessionLaunch(fresh);
    const retryDigest = await digestAgentSessionLaunch(retry);

    assert.notEqual(retryDigest, freshDigest);
    assert.notEqual(await digestAgentSessionLaunch(differentRetrySource), retryDigest);
  });

  it.each([
    ['untrimmed', ' attempt-retry-source'],
    ['oversized', 'a'.repeat(513)],
  ] as const)('rejects a %s retry source attempt identifier', (_kind, retrySourceAttemptId) => {
    assert.throws(() => validateAgentSessionLaunchIdentity({
      ...freshLaunch(),
      retrySourceAttemptId,
    }));
  });
});
