import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { AgentSessionLaunchDigest } from '@/bgsm-agent/session-transport';
import {
  createBgsmAgentSessionRpcRouter,
  describeBgsmAgentSessionFailure,
  parseBgsmAgentSessionRequest,
  type BgsmAgentSessionRequest,
} from '@/background/bgsm-agent-session-rpc';

const launchDigest: AgentSessionLaunchDigest = `asl:v1:${'s'.repeat(43)}`;

function createRouterHarness() {
  const calls: string[] = [];
  const deletedNotifications: string[] = [];
  const deleteInputs: Array<{ sessionId: string; executionEpochId: string }> = [];
  const state = { durableInspectionCalls: 0 };
  let deleteResult = true;
  const router = createBgsmAgentSessionRpcRouter({
    executionEpochId: 'worker-session-rpc',
    inspectActiveTurn(sessionId) {
      calls.push(`active:${sessionId}`);
      return sessionId === 'session-live' ? { authority: 'registry' } : null;
    },
    async inspectDurableTurn(sessionId) {
      state.durableInspectionCalls += 1;
      calls.push(`durable:${sessionId}`);
      return { authority: 'coordinator', sessionId };
    },
    async dismissRetry(input) {
      calls.push(`dismiss:${input.sessionId}:${input.turnAttemptId}`);
      return true;
    },
    async abandonUncertainAttempt(input) {
      calls.push(`abandon:${input.sessionId}:${input.turnAttemptId}`);
      return true;
    },
    async discardDamagedRecovery(sessionId) {
      calls.push(`discard:${sessionId}`);
      return 2;
    },
    notifySessionDeleted(sessionId) {
      deletedNotifications.push(sessionId);
    },
    operations: {
      async inspectCatalog() {
        calls.push('catalog');
        return { kind: 'catalog' };
      },
      async getOrCreateInitialSession() {
        calls.push('initial');
        return { kind: 'initial' };
      },
      async createSession(sessionId) {
        calls.push(`create:${sessionId ?? 'generated'}`);
        return { kind: 'created', sessionId };
      },
      async loadSession(sessionId) {
        calls.push(`load:${sessionId}`);
        return { kind: 'loaded', sessionId };
      },
      async loadCommittedTurn(input) {
        calls.push(`committed:${input.sessionId}:${input.turnAttemptId}`);
        return { kind: 'committed', input };
      },
      async readRetryDraft(sessionId) {
        calls.push(`retry:${sessionId}`);
        return { kind: 'retry', sessionId };
      },
      async loadTranscriptPage(sessionId, beforeSequence) {
        calls.push(`page:${sessionId}:${beforeSequence}`);
        return { kind: 'page', sessionId, beforeSequence };
      },
      async deleteSession(input) {
        deleteInputs.push({ ...input });
        calls.push(`delete:${input.sessionId}`);
        const result = deleteResult;
        deleteResult = false;
        return result;
      },
      async getStorageUsage() {
        calls.push('usage');
        return { kind: 'usage' };
      },
      async clearToolCache() {
        calls.push('clear');
        return { kind: 'clear' };
      },
    },
  });

  return {
    router,
    calls,
    deletedNotifications,
    deleteInputs,
    state,
  };
}

describe('background Agent session RPC router', () => {
  it('routes every session request through injected authority without an envelope', async () => {
    const harness = createRouterHarness();
    const requests: readonly BgsmAgentSessionRequest[] = [
      { type: 'inspectAgentSessionCatalog' },
      { type: 'getOrCreateInitialAgentSession' },
      { type: 'inspectActiveAgentSessionTurn', sessionId: 'session-live' },
      { type: 'inspectActiveAgentSessionTurn', sessionId: 'session-durable' },
      { type: 'createAgentSession', sessionId: 'session-created' },
      { type: 'loadAgentSession', sessionId: 'session-load' },
      {
        type: 'loadCommittedAgentSessionTurn',
        sessionId: 'session-committed',
        turnAttemptId: 'turn-committed',
        launchDigest,
      },
      { type: 'readAgentRetryDraftCandidate', sessionId: 'session-retry' },
      {
        type: 'dismissAgentSessionRetry',
        sessionId: 'session-dismiss',
        turnAttemptId: 'turn-dismiss',
      },
      {
        type: 'abandonAgentSessionUncertainAttempt',
        sessionId: 'session-uncertain',
        turnAttemptId: 'turn-uncertain',
      },
      { type: 'discardDamagedAgentSessionRecovery', sessionId: 'session-discard' },
      {
        type: 'loadAgentSessionTranscriptPage',
        sessionId: 'session-page',
        beforeSequence: 17,
      },
      { type: 'deleteAgentSession', sessionId: 'session-delete' },
      { type: 'deleteAgentSession', sessionId: 'session-not-deleted' },
      { type: 'getAgentStorageUsage' },
      { type: 'clearAgentToolCache' },
    ];

    const results: unknown[] = [];
    for (const request of requests) results.push(await harness.router.handle(request));

    assert.deepEqual(results, [
      { kind: 'catalog' },
      { kind: 'initial' },
      { authority: 'registry' },
      { authority: 'coordinator', sessionId: 'session-durable' },
      { kind: 'created', sessionId: 'session-created' },
      { kind: 'loaded', sessionId: 'session-load' },
      {
        kind: 'committed',
        input: {
          type: 'loadCommittedAgentSessionTurn',
          sessionId: 'session-committed',
          turnAttemptId: 'turn-committed',
          launchDigest,
        },
      },
      { kind: 'retry', sessionId: 'session-retry' },
      true,
      true,
      2,
      { kind: 'page', sessionId: 'session-page', beforeSequence: 17 },
      { deleted: true },
      { deleted: false },
      { kind: 'usage' },
      { kind: 'clear' },
    ]);
    assert.deepEqual(harness.calls, [
      'catalog',
      'initial',
      'active:session-live',
      'active:session-durable',
      'durable:session-durable',
      'create:session-created',
      'load:session-load',
      'committed:session-committed:turn-committed',
      'retry:session-retry',
      'dismiss:session-dismiss:turn-dismiss',
      'abandon:session-uncertain:turn-uncertain',
      'discard:session-discard',
      'page:session-page:17',
      'delete:session-delete',
      'delete:session-not-deleted',
      'usage',
      'clear',
    ]);
    assert.equal(harness.state.durableInspectionCalls, 1);
    assert.deepEqual(harness.deleteInputs, [
      { sessionId: 'session-delete', executionEpochId: 'worker-session-rpc' },
      { sessionId: 'session-not-deleted', executionEpochId: 'worker-session-rpc' },
    ]);
    assert.deepEqual(harness.deletedNotifications, ['session-delete']);
  });

  it('preserves thrown operation failures for the composition root to translate', async () => {
    const failure = Object.assign(new Error('not found'), {
      code: 'agent_session_not_found',
      sessionId: 'session-missing',
    });
    const router = createBgsmAgentSessionRpcRouter({
      executionEpochId: 'worker-failure',
      inspectActiveTurn: () => null,
      inspectDurableTurn: async () => null,
      dismissRetry: async () => false,
      abandonUncertainAttempt: async () => false,
      discardDamagedRecovery: async () => 0,
      notifySessionDeleted: () => {},
      operations: {
        async loadSession() {
          throw failure;
        },
      },
    });

    await assert.rejects(
      () => router.handle({ type: 'loadAgentSession', sessionId: 'session-missing' }),
      (error) => error === failure,
    );
  });

  it('parses every exact request and rejects malformed or extra fields before any operation', async () => {
    const validRequests: readonly BgsmAgentSessionRequest[] = [
      { type: 'inspectAgentSessionCatalog' },
      { type: 'getOrCreateInitialAgentSession' },
      { type: 'inspectActiveAgentSessionTurn', sessionId: 'session-live' },
      { type: 'createAgentSession' },
      { type: 'createAgentSession', sessionId: 'session-created' },
      { type: 'loadAgentSession', sessionId: 'session-load' },
      {
        type: 'loadCommittedAgentSessionTurn',
        sessionId: 'session-committed',
        turnAttemptId: 'turn-committed',
        launchDigest,
      },
      { type: 'readAgentRetryDraftCandidate', sessionId: 'session-retry' },
      { type: 'dismissAgentSessionRetry', sessionId: 'session-dismiss', turnAttemptId: 'turn-dismiss' },
      {
        type: 'abandonAgentSessionUncertainAttempt',
        sessionId: 'session-uncertain',
        turnAttemptId: 'turn-uncertain',
      },
      { type: 'discardDamagedAgentSessionRecovery', sessionId: 'session-discard' },
      { type: 'loadAgentSessionTranscriptPage', sessionId: 'session-page', beforeSequence: 17 },
      { type: 'deleteAgentSession', sessionId: 'session-delete' },
      { type: 'getAgentStorageUsage' },
      { type: 'clearAgentToolCache' },
    ];
    for (const request of validRequests) {
      assert.deepEqual(parseBgsmAgentSessionRequest(request), request);
    }
    assert.equal(parseBgsmAgentSessionRequest({ type: 'notAnAgentCommand' }), null);

    const malformedRequests: readonly unknown[] = [
      ...validRequests.map((request) => ({ ...request, unexpected: true })),
      { type: 'loadAgentSession' },
      { type: 'loadAgentSession', sessionId: ' session-load' },
      { type: 'loadAgentSession', sessionId: 'é'.repeat(257) },
      {
        type: 'loadCommittedAgentSessionTurn',
        sessionId: 'session-committed',
        turnAttemptId: 'turn-committed',
        launchDigest: 'asl:v1:invalid',
      },
      { type: 'dismissAgentSessionRetry', sessionId: 'session-dismiss', turnAttemptId: '' },
      { type: 'loadAgentSessionTranscriptPage', sessionId: 'session-page', beforeSequence: 0 },
      { type: 'loadAgentSessionTranscriptPage', sessionId: 'session-page', beforeSequence: 1.5 },
    ];
    const harness = createRouterHarness();
    for (const request of malformedRequests) {
      assert.equal(parseBgsmAgentSessionRequest(request), null);
      await assert.rejects(() => harness.router.handle(request), TypeError);
    }
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.state.durableInspectionCalls, 0);
    assert.deepEqual(harness.deleteInputs, []);
    assert.deepEqual(harness.deletedNotifications, []);
  });

  it('bounds serializable failure details', () => {
    assert.deepEqual(describeBgsmAgentSessionFailure({
      code: 'agent_storage_capacity_exceeded',
      sessionId: 'session-capacity',
      availableBytes: 4,
      hardLimitBytes: 8,
      providerMessage: 'must not escape',
    }), {
      code: 'agent_storage_capacity_exceeded',
      details: {
        sessionId: 'session-capacity',
        availableBytes: 4,
        hardLimitBytes: 8,
      },
    });
    assert.deepEqual(
      describeBgsmAgentSessionFailure({ name: 'QuotaExceededError', ignored: 'detail' }),
      { code: 'agent_session_quota_exceeded' },
    );
    assert.equal(
      describeBgsmAgentSessionFailure({ code: 'unbounded_provider_detail', secret: 'nope' }),
      null,
    );
  });
});
