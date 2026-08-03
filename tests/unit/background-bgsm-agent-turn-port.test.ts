import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  parseScopeFingerprintV1,
  type BgsmAgentConversationBinding,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';
import { attachBgsmAgentTurnPort } from '@/background/bgsm-agent-turn-port';
import type {
  BgsmAgentTurnAckDisposition,
  BgsmAgentTurnResult,
} from '@/utils/messaging';
import { AGENT_CONTEXT_CAPABILITY_REQUIRED } from '@/api/errors';

type Listener<T> = (value: T) => void;

const conversationBinding: BgsmAgentConversationBinding = {
  version: 1,
  candidateContract: {
    kind: 'selected_repository',
    selectedRepositoryIdHint: 'owner/repo',
  },
  scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${'a'.repeat(43)}`),
  label: 'owner/repo',
  count: 1,
  providerFingerprint: `pcf:v1:${'b'.repeat(43)}`,
};

function fakePort() {
  const messageListeners: Array<Listener<unknown>> = [];
  const disconnectListeners: Array<() => void> = [];
  const posted: unknown[] = [];
  let disconnected = false;
  return {
    port: {
      postMessage(message: unknown) { posted.push(message); },
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        disconnectListeners.forEach((listener) => listener());
      },
      onMessage: {
        addListener(listener: Listener<unknown>) { messageListeners.push(listener); },
        removeListener() {},
        hasListener() { return false; },
        hasListeners() { return messageListeners.length > 0; },
      },
      onDisconnect: {
        addListener(listener: () => void) { disconnectListeners.push(listener); },
        removeListener() {},
        hasListener() { return false; },
        hasListeners() { return disconnectListeners.length > 0; },
      },
    },
    posted,
    get disconnected() { return disconnected; },
    deliver(message: unknown) { messageListeners.forEach((listener) => listener(message)); },
    start(input: BgsmAgentTurnInput) {
      const hello = posted.find((message) => (
        (message as { type?: string }).type === 'bgsmAgentTurnHello'
      )) as { executionEpochId: string } | undefined;
      if (!hello) throw new Error('expected Agent worker handshake');
      messageListeners.forEach((listener) => listener({
        type: 'startBgsmAgentTurn',
        executionEpochId: hello.executionEpochId,
        ...input,
      }));
    },
    acknowledge(
      input: BgsmAgentTurnInput,
      appliedRevision: number | null = null,
      disposition: BgsmAgentTurnAckDisposition = appliedRevision === null
        ? 'no_transition'
        : 'applied',
    ) {
      const hello = posted[0] as { executionEpochId: string };
      messageListeners.forEach((listener) => listener({
        type: 'ackBgsmAgentTurnResult',
        executionEpochId: hello.executionEpochId,
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        disposition,
        appliedRevision,
      }));
      if (!posted.some((message) => (
        (message as { type?: string }).type === 'bgsmAgentTurnAck'
      ))) throw new Error('expected Agent acknowledgement confirmation');
      if (!disconnected) {
        disconnected = true;
        disconnectListeners.forEach((listener) => listener());
      }
    },
  };
}

describe('Cubby turn Port ownership', () => {
  it('rejects malformed start envelopes instead of repairing them', () => {
    const transport = fakePort();
    let runCount = 0;
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async () => 'failed',
      async runTurn(input) {
        runCount += 1;
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          newMessages: [],
        };
      },
    });

    transport.deliver({
      type: 'startBgsmAgentTurn',
      executionEpochId: (transport.posted[0] as { executionEpochId: string }).executionEpochId,
      turnAttemptId: 'malformed-attempt',
      sessionId: 'strict-session',
      baseRevision: 0,
      prompt: 'Do not normalize me',
      history: [],
      unexpected: true,
    });

    assert.equal(runCount, 0);
    assert.equal(transport.disconnected, true);
    assert.deepEqual(transport.posted.map((message) => (message as { type: string }).type), [
      'bgsmAgentTurnHello',
    ]);
  });

  it.each(['no_transition', 'transition_rejected', 'detached'] as const)(
    'accepts and confirms a %s result acknowledgement without a revision',
    async (disposition) => {
      const transport = fakePort();
      attachBgsmAgentTurnPort(transport.port, {
        translateError: async () => 'failed',
        async runTurn(input) {
          return {
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            reason: 'final_answer',
            changed: false,
            changedCount: 0,
            newMessages: [],
          };
        },
      });
      const input: BgsmAgentTurnInput = {
        turnAttemptId: `turn-attempt-ack-${disposition}`,
        sessionId: `session-ack-${disposition}`,
        baseRevision: 0,
        prompt: 'Acknowledge the terminal result',
        history: [],
        binding: conversationBinding,
      };

      transport.start(input);
      await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
      transport.acknowledge(input, null, disposition);

      assert.deepEqual(messagesOfType(transport.posted, 'bgsmAgentTurnAck')[0], {
        type: 'bgsmAgentTurnAck',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        disposition,
        appliedRevision: null,
      });
    },
  );

  it('carries a validated completed split-turn projection through the Port', async () => {
    const transport = fakePort();
    let received: BgsmAgentTurnInput | undefined;
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async () => 'failed',
      async runTurn(input) {
        received = input;
        return {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          newMessages: [],
          candidateActiveProjection: input.activeProjections?.[0],
        };
      },
    });
    const activeProjection = {
      schemaVersion: 1 as const,
      currentUserMessageId: 'split-user',
      summarizedThroughMessageId: 'split-tool-result',
      retainedSuffixFirstMessageId: 'split-final-answer',
      rawMessageCountAtCreation: 3,
      rawTailMessageIdAtCreation: 'split-tool-result',
      capabilityRevision: 'capability-v1',
      policyRevision: 'policy-v1',
      summary: 'The completed tool envelope is historical context only.',
    };
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-projection',
      sessionId: 'projection-session',
      baseRevision: 2,
      prompt: 'Continue the analysis.',
      history: [
        { id: 'split-user', role: 'user', content: 'Inspect tags.', createdAt: 1 },
        {
          id: 'split-tool-call',
          role: 'agent',
          content: '',
          createdAt: 2,
          toolCalls: [{ id: 'split-call', name: 'list_tags', arguments: {} }],
        },
        {
          id: 'split-tool-result',
          role: 'tool',
          content: JSON.stringify({ ok: true, data: { count: 1 } }),
          createdAt: 3,
          toolCallId: 'split-call',
          toolName: 'list_tags',
        },
        {
          id: 'split-final-answer',
          role: 'agent',
          content: 'The inspection is complete.',
          createdAt: 4,
        },
      ],
      activeProjections: [activeProjection],
      binding: conversationBinding,
    };

    transport.start(input);
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);

    assert.deepEqual(received?.activeProjections, [activeProjection]);
    assert.deepEqual(
      messagesOfType(transport.posted, 'bgsmAgentTurnResult')[0]?.result.candidateActiveProjection,
      activeProjection,
    );
    transport.acknowledge(input, input.baseRevision + 1);
    await waitUntil(() => transport.disconnected);
  });

  it('aborts through an identity-bound stop command and still delivers one terminal result', async () => {
    const transport = fakePort();
    let aborted = false;
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async () => 'failed',
      runTurn: async (input, options) => new Promise<BgsmAgentTurnResult>((resolve) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          options.emit({ type: 'agent_done', sessionId: input.sessionId, reason: 'aborted' });
          resolve({
            turnAttemptId: input.turnAttemptId,
            sessionId: input.sessionId,
            baseRevision: input.baseRevision,
            reason: 'aborted',
            changed: false,
            changedCount: 0,
            newMessages: [],
          });
        }, { once: true });
      }),
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-stop',
      sessionId: 'stop-session',
      baseRevision: 5,
      prompt: 'Stop',
      history: [],
      binding: conversationBinding,
    };
    transport.start(input);
    transport.deliver({
      type: 'stopBgsmAgentTurn',
      executionEpochId: (transport.posted[0] as { executionEpochId: string }).executionEpochId,
      turnAttemptId: input.turnAttemptId,
      sessionId: 'wrong-session',
      baseRevision: input.baseRevision,
    });
    assert.equal(aborted, false);
    transport.deliver({
      type: 'stopBgsmAgentTurn',
      executionEpochId: (transport.posted[0] as { executionEpochId: string }).executionEpochId,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    });
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    transport.acknowledge(input);
    await waitUntil(() => transport.disconnected);

    assert.equal(aborted, true);
    const results = messagesOfType(transport.posted, 'bgsmAgentTurnResult');
    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.reason, 'aborted');
    assert.deepEqual(
      sequenceNumbers(transport.posted),
      sequenceNumbers(transport.posted).map((_sequence, index) => index),
    );
  });

  it('turns unresolved context capability into an actionable typed result', async () => {
    const transport = fakePort();
    attachBgsmAgentTurnPort(transport.port, {
      translateError: async () => 'unused',
      async runTurn() {
        throw new Error(AGENT_CONTEXT_CAPABILITY_REQUIRED);
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-capability',
      sessionId: 'capability-session',
      baseRevision: 0,
      prompt: 'Inspect repositories',
      history: [],
      binding: conversationBinding,
    };
    transport.start(input);
    await waitUntil(() => messagesOfType(transport.posted, 'bgsmAgentTurnResult').length === 1);
    transport.acknowledge(input);
    await waitUntil(() => transport.disconnected);

    assert.equal(messagesOfType(transport.posted, 'bgsmAgentTurnError').length, 0);
    const results = messagesOfType(transport.posted, 'bgsmAgentTurnResult');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]?.result, {
      turnAttemptId: 'turn-attempt-capability',
      sessionId: 'capability-session',
      baseRevision: 0,
      reason: 'context_limit',
      contextFailureReason: 'capability_unresolved',
      changed: false,
      changedCount: 0,
      newMessages: [],
    });
  });
});

function messagesOfType<T extends string>(messages: unknown[], type: T) {
  return messages.filter((message): message is Record<string, any> & { type: T } => (
    !!message && typeof message === 'object' && (message as { type?: string }).type === type
  ));
}

function sequenceNumbers(messages: unknown[]): number[] {
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return [];
    const sequence = (message as { sequence?: unknown }).sequence;
    return typeof sequence === 'number' ? [sequence] : [];
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for background Port state.');
}
