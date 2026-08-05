import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  BGSM_AGENT_HISTORICAL_SUMMARY_PREAMBLE,
  applyBgsmAgentSessionTransition,
  bindBgsmAgentSession,
  buildBgsmAgentTurnMessages,
  createBgsmAgentSession,
  createBgsmAgentTurnInput,
  parseScopeFingerprintV1,
  selectBgsmAgentTurnNewMessages,
  type BgsmAgentCompactionCheckpoint,
  type BgsmAgentSessionMessage,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';
import { toModelMessage, validateProviderProtocolHistory } from '@/agent-harness';

const firstTurnMessages: BgsmAgentSessionMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    content: 'Inspect my tags',
    createdAt: 1,
  },
  {
    id: 'assistant-1',
    role: 'agent',
    content: '',
    createdAt: 2,
    toolCalls: [{ id: 'call-1', name: 'list_tags', arguments: {} }],
  },
  {
    id: 'tool-1',
    role: 'tool',
    content: '{"ok":true,"data":{"count":1}}',
    createdAt: 3,
    toolCallId: 'call-1',
    toolName: 'list_tags',
  },
  {
    id: 'assistant-2',
    role: 'agent',
    content: 'I inspected your tags.',
    createdAt: 4,
  },
];

const secondTurnMessages: BgsmAgentSessionMessage[] = [
  { id: 'user-2', role: 'user', content: 'What changed?', createdAt: 5 },
  { id: 'assistant-3', role: 'agent', content: 'Nothing changed.', createdAt: 6 },
];

const firstCheckpoint: BgsmAgentCompactionCheckpoint = {
  schemaVersion: 1,
  summary: 'The user asked to inspect tags; no write was requested.',
  summarizedMessageCount: firstTurnMessages.length,
  summarizedThroughMessageId: 'assistant-2',
};

const firstActiveProjection = {
  schemaVersion: 1 as const,
  currentUserMessageId: 'user-1',
  summarizedThroughMessageId: 'tool-1',
  retainedSuffixFirstMessageId: 'assistant-2',
  rawMessageCountAtCreation: 3,
  rawTailMessageIdAtCreation: 'tool-1',
  capabilityRevision: 'capability-v1',
  policyRevision: 'policy-v1',
  summary: 'The repository inspection completed; retain the final response.',
};

function input(overrides: Partial<BgsmAgentTurnInput> = {}): BgsmAgentTurnInput {
  return {
    turnAttemptId: 'turn-attempt-1',
    sessionId: 'session-1',
    baseRevision: 0,
    prompt: 'Continue',
    history: [...firstTurnMessages, ...secondTurnMessages],
    ...overrides,
  };
}

describe('Cubby session', () => {
  it('starts at revision zero and creates an isolated UI-owned turn snapshot', () => {
    const session = {
      ...createBgsmAgentSession(() => 'session-1'),
      revision: 3,
      messages: firstTurnMessages,
      compaction: firstCheckpoint,
    };
    const snapshot = createBgsmAgentTurnInput(session, 'What changed?', {
      kind: 'selected_repository',
      selectedRepositoryIdHint: 'owner/repo',
    }, () => 'turn-attempt-1');

    assert.deepEqual(snapshot, {
      turnAttemptId: 'turn-attempt-1',
      sessionId: 'session-1',
      baseRevision: 3,
      prompt: 'What changed?',
      history: firstTurnMessages,
      checkpoint: firstCheckpoint,
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      },
    });
    assert.notEqual(snapshot.history, session.messages);
    assert.notEqual(snapshot.checkpoint, session.compaction);
    assert.deepEqual(createBgsmAgentSession(() => 'new-session'), {
      id: 'new-session',
      revision: 0,
      messages: [],
    });
  });

  it('preserves the frozen binding for retries instead of adopting a new UI candidate', () => {
    const session = bindBgsmAgentSession(createBgsmAgentSession(() => 'session-bound'), {
      version: 1,
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/original',
      },
      scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${'a'.repeat(43)}`),
      label: 'owner/original',
      count: 1,
      providerFingerprint: `pcf:v1:${'b'.repeat(43)}`,
    });
    const retry = createBgsmAgentTurnInput(session, 'Retry', {
      kind: 'selected_repository',
      selectedRepositoryIdHint: 'owner/new-selection',
    });

    assert.equal(retry.binding, session.binding);
    assert.equal(retry.candidateContract, undefined);
  });

  it('projects one fresh system message, all history, and the current prompt without a checkpoint', () => {
    let id = 0;
    const first = buildBgsmAgentTurnMessages(input(), 'system-v1', {
      now: () => 10,
      idFactory: () => `generated-${++id}`,
    });
    const second = buildBgsmAgentTurnMessages(input(), 'system-v2', {
      now: () => 20,
      idFactory: () => `generated-${++id}`,
    });

    assert.equal(first.filter((message) => message.role === 'system').length, 1);
    assert.equal(second[0]?.content, 'system-v2');
    assert.equal(second.some((message) => message.content === 'system-v1'), false);
    assert.deepEqual(second.slice(1, -1), [...firstTurnMessages, ...secondTurnMessages]);
    assert.equal(second.at(-1)?.role, 'user');
    assert.equal(second.at(-1)?.content, 'Continue');
  });

  it('projects exactly one untrusted historical summary and only history after its verified cursor', () => {
    const history = [...firstTurnMessages, ...secondTurnMessages];
    const original = structuredClone(history);
    const checkpoint = { ...firstCheckpoint };
    let id = 0;

    const projected = buildBgsmAgentTurnMessages(
      input({ history, checkpoint }),
      'fresh system',
      { now: () => 10, idFactory: () => `generated-${++id}` },
    );

    assert.deepEqual(projected.map((message) => message.role), [
      'system',
      'user',
      'user',
      'agent',
      'user',
    ]);
    assert.equal(projected[1]?.content, `${BGSM_AGENT_HISTORICAL_SUMMARY_PREAMBLE}\n\n${checkpoint.summary}`);
    assert.deepEqual(projected.slice(2, -1), secondTurnMessages);
    assert.deepEqual(history, original);
    assert.deepEqual(checkpoint, firstCheckpoint);
  });

  it('supports an all-history checkpoint and fails instead of guessing on cursor mismatch', () => {
    const history = [...firstTurnMessages, ...secondTurnMessages];
    const checkpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: 'Both prior turns are historical.',
      summarizedMessageCount: history.length,
      summarizedThroughMessageId: 'assistant-3',
    };
    const projected = buildBgsmAgentTurnMessages(input({ history, checkpoint }), 'system');

    assert.deepEqual(projected.map((message) => message.role), ['system', 'user', 'user']);
    assert.throws(
      () => buildBgsmAgentTurnMessages(
        input({ checkpoint: { ...firstCheckpoint, summarizedThroughMessageId: 'wrong-id' } }),
        'system',
      ),
      /terminal message ID/i,
    );
    assert.throws(
      () => buildBgsmAgentTurnMessages(
        input({ checkpoint: { ...firstCheckpoint, summarizedMessageCount: 2 } }),
        'system',
      ),
      /complete-turn boundary/i,
    );
  });

  it('selects the current user message and generated delta from a checkpointed projection', () => {
    const turnInput = input({ checkpoint: firstCheckpoint });
    const projected = buildBgsmAgentTurnMessages(turnInput, 'system', {
      now: () => 10,
      idFactory: (() => {
        let id = 0;
        return () => `generated-${++id}`;
      })(),
    });
    const currentAssistant: BgsmAgentSessionMessage = {
      id: 'assistant-4',
      role: 'agent',
      content: 'Done.',
      createdAt: 11,
    };

    assert.deepEqual(
      selectBgsmAgentTurnNewMessages([...projected, currentAssistant], turnInput),
      [projected.at(-1), currentAssistant],
    );
  });

  it('atomically appends a complete delta and increments revision exactly once', () => {
    const session = createBgsmAgentSession(() => 'session-1');
    const transition = {
      sessionId: 'session-1',
      baseRevision: 0,
      messageDelta: firstTurnMessages,
    };
    const accepted = applyBgsmAgentSessionTransition(session, transition);
    const duplicate = applyBgsmAgentSessionTransition(accepted.session, transition);

    assert.equal(accepted.applied, true);
    assert.equal(accepted.session.revision, 1);
    assert.deepEqual(accepted.session.messages, firstTurnMessages);
    assert.deepEqual(session.messages, []);
    assert.deepEqual(duplicate, { applied: false, session: accepted.session });
  });

  it('applies a candidate checkpoint and complete delta in one transition', () => {
    const session = {
      id: 'session-1',
      revision: 4,
      messages: firstTurnMessages,
    };
    const accepted = applyBgsmAgentSessionTransition(session, {
      sessionId: 'session-1',
      baseRevision: 4,
      candidateCheckpoint: firstCheckpoint,
      messageDelta: secondTurnMessages,
    });

    assert.equal(accepted.session.revision, 5);
    assert.deepEqual(accepted.session.messages, [...firstTurnMessages, ...secondTurnMessages]);
    assert.deepEqual(accepted.session.compaction, firstCheckpoint);
  });

  it('advances a checkpoint against the combined raw history and terminal delta', () => {
    const session = {
      id: 'session-1',
      revision: 4,
      messages: firstTurnMessages,
    };
    const combinedCheckpoint: BgsmAgentCompactionCheckpoint = {
      schemaVersion: 1,
      summary: 'Both completed turns are historical.',
      summarizedMessageCount: firstTurnMessages.length + secondTurnMessages.length,
      summarizedThroughMessageId: 'assistant-3',
    };

    const accepted = applyBgsmAgentSessionTransition(session, {
      sessionId: session.id,
      baseRevision: session.revision,
      candidateCheckpoint: combinedCheckpoint,
      messageDelta: secondTurnMessages,
    });

    assert.equal(accepted.applied, true);
    assert.deepEqual(accepted.session.compaction, combinedCheckpoint);
  });

  it('retains a completed split-turn projection without rewriting raw history', () => {
    const original = structuredClone(firstTurnMessages);
    const accepted = applyBgsmAgentSessionTransition(
      createBgsmAgentSession(() => 'session-projection'),
      {
        sessionId: 'session-projection',
        baseRevision: 0,
        candidateActiveProjection: firstActiveProjection,
        messageDelta: firstTurnMessages,
      },
    );
    assert.equal(accepted.applied, true);
    assert.deepEqual(accepted.session.messages, original);
    assert.deepEqual(accepted.session.activeProjections, [firstActiveProjection]);

    const nextTurn = createBgsmAgentTurnInput(
      accepted.session,
      'What is the final conclusion?',
      { kind: 'selected_repository', selectedRepositoryIdHint: 'owner/repo' },
      () => 'next-turn',
    );
    const projected = buildBgsmAgentTurnMessages(nextTurn, 'system', {
      now: () => 20,
      idFactory: () => 'generated',
    });

    assert.deepEqual(projected.map((message) => message.role), [
      'system', 'user', 'user', 'agent', 'user',
    ]);
    assert.equal(projected[2]?.content.includes('Active-turn progress summary'), true);
    assert.equal(projected.some((message) => message.id === 'assistant-1'), false);
    assert.equal(projected.some((message) => message.id === 'tool-1'), false);
    assert.equal(projected.at(-1)?.content, 'What is the final conclusion?');
    assert.doesNotThrow(() => validateProviderProtocolHistory(projected.map(toModelMessage)));
    assert.deepEqual(accepted.session.messages, original);
  });

  it('commits a later split projection without reviving an earlier compressed turn', () => {
    const laterTurn: BgsmAgentSessionMessage[] = [
      { id: 'later-user', role: 'user', content: 'Inspect every page.', createdAt: 10 },
      {
        id: 'later-assistant-tool',
        role: 'agent',
        content: 'Reading the final page.',
        createdAt: 11,
        toolCalls: [{ id: 'later-call', name: 'list_stars', arguments: { cursor: 'last' } }],
      },
      {
        id: 'later-tool',
        role: 'tool',
        content: '{"ok":true,"data":{"nextCursor":null}}',
        createdAt: 12,
        toolCallId: 'later-call',
        toolName: 'list_stars',
      },
      { id: 'later-answer', role: 'agent', content: 'All pages were inspected.', createdAt: 13 },
    ];
    const laterProjection = {
      ...firstActiveProjection,
      currentUserMessageId: 'later-user',
      summarizedThroughMessageId: 'later-tool',
      retainedSuffixFirstMessageId: 'later-answer',
      rawMessageCountAtCreation: 3,
      rawTailMessageIdAtCreation: 'later-tool',
    };
    const session = {
      id: 'session-later-projection',
      revision: 2,
      messages: firstTurnMessages,
      activeProjections: [firstActiveProjection],
    };

    const accepted = applyBgsmAgentSessionTransition(session, {
      sessionId: session.id,
      baseRevision: session.revision,
      candidateActiveProjection: laterProjection,
      messageDelta: laterTurn,
    });

    assert.equal(accepted.applied, true);
    assert.deepEqual(accepted.session.activeProjections, [firstActiveProjection, laterProjection]);
    const projected = buildBgsmAgentTurnMessages(
      createBgsmAgentTurnInput(
        accepted.session,
        'Continue from the complete result.',
        { kind: 'selected_repository', selectedRepositoryIdHint: 'owner/repo' },
        () => 'later-turn-attempt',
      ),
      'system',
      { now: () => 20, idFactory: () => 'generated-later' },
    );
    assert.equal(projected.some((message) => message.id === 'assistant-1'), false);
    assert.equal(projected.some((message) => message.id === 'tool-1'), false);
    assert.equal(projected.some((message) => message.id === 'later-assistant-tool'), false);
    assert.equal(projected.some((message) => message.id === 'later-tool'), false);
    assert.equal(projected.some((message) => message.id === 'later-answer'), true);
    assert.equal(
      projected.filter((message) => message.content.includes('Active-turn progress summary')).length,
      2,
    );
    assert.doesNotThrow(() => validateProviderProtocolHistory(projected.map(toModelMessage)));
  });

  it('accepts a later-turn projection created before that turn received its final answer', () => {
    const laterTurn: BgsmAgentSessionMessage[] = [
      { id: 'later-user', role: 'user', content: 'Inspect every page.', createdAt: 10 },
      {
        id: 'later-assistant-tool',
        role: 'agent',
        content: '',
        createdAt: 11,
        toolCalls: [{ id: 'later-call', name: 'list_stars', arguments: { cursor: 'last' } }],
      },
      {
        id: 'later-tool',
        role: 'tool',
        content: '{"ok":true,"data":{"nextCursor":null}}',
        createdAt: 12,
        toolCallId: 'later-call',
        toolName: 'list_stars',
      },
      { id: 'later-answer', role: 'agent', content: 'All pages were inspected.', createdAt: 13 },
    ];
    const laterProjection = {
      ...firstActiveProjection,
      currentUserMessageId: 'later-user',
      summarizedThroughMessageId: 'later-tool',
      retainedSuffixFirstMessageId: null,
      rawMessageCountAtCreation: 3,
      rawTailMessageIdAtCreation: 'later-tool',
    };
    const session = {
      id: 'session-later-empty-suffix',
      revision: 2,
      messages: firstTurnMessages,
      activeProjections: [firstActiveProjection],
    };

    const accepted = applyBgsmAgentSessionTransition(session, {
      sessionId: session.id,
      baseRevision: session.revision,
      candidateActiveProjection: laterProjection,
      messageDelta: laterTurn,
    });

    assert.equal(accepted.applied, true);
    assert.deepEqual(accepted.session.activeProjections, [firstActiveProjection, laterProjection]);
  });

  it('allows a projected turn to end at a settled tool envelope before the next user turn', () => {
    const terminalToolTurn = firstTurnMessages.slice(0, 3);
    const history = [...terminalToolTurn, ...secondTurnMessages];
    const projected = buildBgsmAgentTurnMessages(input({
      history,
      activeProjections: [{
        ...firstActiveProjection,
        retainedSuffixFirstMessageId: null,
      }],
    }), 'system');

    assert.equal(projected.some((message) => message.id === 'assistant-1'), false);
    assert.equal(projected.some((message) => message.id === 'tool-1'), false);
    assert.equal(projected.some((message) => message.id === 'user-2'), true);
    assert.doesNotThrow(() => validateProviderProtocolHistory(projected.map(toModelMessage)));
  });

  it('rejects an active projection that crosses into a later user turn', () => {
    const history = [...firstTurnMessages, ...secondTurnMessages];
    assert.throws(
      () => buildBgsmAgentTurnMessages(input({
        history,
        activeProjections: [{
          ...firstActiveProjection,
          summarizedThroughMessageId: 'assistant-3',
          retainedSuffixFirstMessageId: null,
          rawMessageCountAtCreation: history.length,
          rawTailMessageIdAtCreation: 'assistant-3',
        }],
      }), 'system'),
      /cannot cross a user turn boundary/i,
    );
  });

  it('rejects a retained split projection absorbed by its historical checkpoint', () => {
    const session = {
      id: 'session-1',
      revision: 1,
      messages: firstTurnMessages,
      compaction: firstCheckpoint,
    };
    assert.throws(
      () => applyBgsmAgentSessionTransition(session, {
        sessionId: session.id,
        baseRevision: session.revision,
        candidateActiveProjection: firstActiveProjection,
        messageDelta: secondTurnMessages,
      }),
      /cannot precede its historical checkpoint/i,
    );
  });

  it('explicitly clears a split projection absorbed by a newer historical checkpoint', () => {
    const session = {
      id: 'session-1',
      revision: 1,
      messages: firstTurnMessages,
      activeProjections: [firstActiveProjection],
    };
    const accepted = applyBgsmAgentSessionTransition(session, {
      sessionId: session.id,
      baseRevision: session.revision,
      candidateCheckpoint: firstCheckpoint,
      candidateActiveProjection: null,
      messageDelta: [],
    });

    assert.equal(accepted.applied, true);
    assert.deepEqual(accepted.session.compaction, firstCheckpoint);
    assert.equal(accepted.session.activeProjections, undefined);
    assert.deepEqual(accepted.session.messages, firstTurnMessages);
  });

  it('rejects clearing active projections without an advancing checkpoint', () => {
    const session = {
      id: 'session-1',
      revision: 1,
      messages: firstTurnMessages,
      activeProjections: [firstActiveProjection],
    };
    assert.throws(
      () => applyBgsmAgentSessionTransition(session, {
        sessionId: session.id,
        baseRevision: session.revision,
        candidateActiveProjection: null,
        messageDelta: secondTurnMessages,
      }),
      /only be cleared by an advancing checkpoint/i,
    );
  });

  it('applies a valid checkpoint-only terminal transition without fabricating messages', () => {
    const session = { id: 'session-1', revision: 1, messages: firstTurnMessages };
    const accepted = applyBgsmAgentSessionTransition(session, {
      sessionId: 'session-1',
      baseRevision: 1,
      candidateCheckpoint: firstCheckpoint,
      messageDelta: [],
    });

    assert.equal(accepted.applied, true);
    assert.equal(accepted.session.revision, 2);
    assert.deepEqual(accepted.session.messages, firstTurnMessages);
    assert.deepEqual(accepted.session.compaction, firstCheckpoint);
  });

  it('retains a terminal settled tool envelope and commits the following turn', () => {
    const session = {
      id: 'session-1',
      revision: 1,
      messages: firstTurnMessages,
      compaction: firstCheckpoint,
    };
    const settledFailure: BgsmAgentSessionMessage[] = [
      { id: 'failed-user', role: 'user', content: 'Inspect more repositories.', createdAt: 10 },
      {
        id: 'failed-tool-call',
        role: 'agent',
        content: 'I will inspect the next page.',
        createdAt: 11,
        toolCalls: [{ id: 'failed-call', name: 'search_stars', arguments: { page: 2 } }],
      },
      {
        id: 'failed-tool-result',
        role: 'tool',
        content: JSON.stringify({ ok: true, data: { count: 4 } }),
        createdAt: 12,
        toolCallId: 'failed-call',
        toolName: 'search_stars',
      },
    ];
    const accepted = applyBgsmAgentSessionTransition(session, {
      sessionId: session.id,
      baseRevision: session.revision,
      messageDelta: settledFailure,
    });

    assert.equal(accepted.applied, true);
    assert.deepEqual(accepted.session.messages.slice(-3), settledFailure);
    const projected = buildBgsmAgentTurnMessages({
      turnAttemptId: 'retry',
      sessionId: accepted.session.id,
      baseRevision: accepted.session.revision,
      prompt: 'Continue from the settled result.',
      history: accepted.session.messages,
      checkpoint: accepted.session.compaction,
    }, 'system', {
      now: () => 20,
      idFactory: () => 'generated',
    });
    assert.deepEqual(projected.map((message) => message.role), [
      'system', 'user', 'user', 'agent', 'tool', 'user',
    ]);
    assert.equal(projected.at(-2)?.toolCallId, 'failed-call');

    const followedUp = applyBgsmAgentSessionTransition(accepted.session, {
      sessionId: accepted.session.id,
      baseRevision: accepted.session.revision,
      messageDelta: secondTurnMessages,
    });
    assert.equal(followedUp.applied, true);
    assert.deepEqual(
      followedUp.session.messages.slice(-5),
      [...settledFailure, ...secondTurnMessages],
    );
  });

  it('returns the original session for stale identity and rejects invalid atomic payloads', () => {
    const session = { id: 'session-1', revision: 2, messages: firstTurnMessages };
    const staleId = applyBgsmAgentSessionTransition(session, {
      sessionId: 'other-session',
      baseRevision: 2,
      messageDelta: [{ id: 'bad', role: 'tool', content: '', createdAt: 9 }],
    });
    const staleRevision = applyBgsmAgentSessionTransition(session, {
      sessionId: 'session-1',
      baseRevision: 1,
      messageDelta: [],
    });

    assert.deepEqual(staleId, { applied: false, session });
    assert.deepEqual(staleRevision, { applied: false, session });
    assert.throws(
      () => applyBgsmAgentSessionTransition(session, {
        sessionId: 'session-1',
        baseRevision: 2,
        messageDelta: [],
      }),
      /checkpoint, projection, or message delta/i,
    );
    assert.throws(
      () => applyBgsmAgentSessionTransition(session, {
        sessionId: 'session-1',
        baseRevision: 2,
        messageDelta: [{ id: 'partial-user', role: 'user', content: 'partial', createdAt: 9 }],
      }),
      /assistant message/i,
    );
    assert.throws(
      () => applyBgsmAgentSessionTransition(session, {
        sessionId: 'session-1',
        baseRevision: 2,
        candidateCheckpoint: { ...firstCheckpoint, summarizedThroughMessageId: 'wrong-id' },
        messageDelta: secondTurnMessages,
      }),
      /terminal message ID/i,
    );
    assert.equal(session.revision, 2);
    assert.deepEqual(session.messages, firstTurnMessages);
  });
});
