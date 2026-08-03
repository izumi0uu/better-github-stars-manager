import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
  CONTEXT_PROFILE_32768,
  CONTEXT_PROFILE_8192,
  InvalidCommittedHistoryError,
  buildSummaryRange,
  estimateContext,
  estimateContextWithUsage,
  estimateMessageTokens,
  estimateSerializedTokens,
  estimateToolSchemasTokens,
  estimateUtf8Tokens,
  isSummaryRequestWithinEffectiveWindow,
  isWithinHardLimit,
  isWithinSummaryInputCap,
  parseCommittedHistory,
  preflightContextRequest,
  resolveContextBudgetProfile,
  resolveEffectiveContextWindow,
  selectActiveTurnCompactionCandidate,
  selectCompactionCandidate,
  shouldCompact,
  verifyCheckpointCursor,
  type AgentMessage,
  type CompactionCheckpoint,
  type ContextBudgetProfile,
  type ModelMessage,
} from '../../src/agent-harness/index.ts';

function message(
  id: string,
  role: AgentMessage['role'],
  content = '',
  extra: Partial<AgentMessage> = {},
): AgentMessage {
  return { id, role, content, createdAt: Number(id.replace(/\D/g, '')) || 1, ...extra };
}

function simpleTurn(prefix: string, content = ''): AgentMessage[] {
  return [
    message(`${prefix}-u`, 'user', content),
    message(`${prefix}-a`, 'agent', content),
  ];
}

function oneToolTurn(prefix: string): AgentMessage[] {
  return [
    message(`${prefix}-u`, 'user', 'inspect'),
    message(`${prefix}-call`, 'agent', '', {
      toolCalls: [{ id: `${prefix}-c1`, name: 'inspect_tag', arguments: { tag: 'work' } }],
    }),
    message(`${prefix}-result`, 'tool', '{}', {
      toolCallId: `${prefix}-c1`,
      toolName: 'inspect_tag',
    }),
    message(`${prefix}-a`, 'agent', 'done'),
  ];
}

function planningProfile(overrides: Partial<ContextBudgetProfile> = {}): ContextBudgetProfile {
  return {
    ...CONTEXT_PROFILE_8192,
    ...overrides,
  };
}

const emptyRequestBase = { messages: [] as ModelMessage[], toolSchemas: [] as unknown[] };

describe('compaction deterministic estimator', () => {
  it('accounts for request, messages, output demand, and UTF-8 bytes exactly', () => {
    assert.equal(estimateUtf8Tokens('abc'), 1);
    assert.equal(estimateUtf8Tokens('😀😀'), 3);

    const estimate = estimateContext({
      messages: [{ role: 'user', content: 'abc' }],
      maxOutputTokens: 10,
    });
    assert.deepEqual(estimate, { inputTokens: 41, contextDemandTokens: 51 });
    assert.equal(estimate.inputTokens, 32 + 8 + 1);
    assert.equal(estimate.contextDemandTokens, estimate.inputTokens + 10);
  });

  it('adds exact tool-call, result-linkage, and serialized-schema costs', () => {
    const call: ModelMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c', name: 't', arguments: { x: 'y' } }],
    };
    const result: ModelMessage = {
      role: 'tool',
      content: 'abc',
      toolCallId: 'c',
      toolName: 't',
    };
    const schema = { type: 'object' };

    assert.equal(estimateSerializedTokens({ x: 'y' }), 3);
    assert.equal(estimateMessageTokens(call), 8 + 16 + 1 + 1 + 3);
    assert.equal(
      estimateMessageTokens({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c', name: 't', arguments: null }],
      }),
      8 + 16 + 1 + 1 + 1,
    );
    assert.equal(
      estimateMessageTokens({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c', name: 't', arguments: undefined }],
      }),
      8 + 16 + 1 + 1 + 1,
    );
    assert.equal(estimateMessageTokens(result), 8 + 1 + 12 + 1 + 1);
    assert.equal(
      estimateContext({ messages: [call, result], toolSchemas: [schema], maxOutputTokens: 0 })
        .inputTokens,
      32 + (8 + 16 + 1 + 1 + 3) + (8 + 1 + 12 + 1 + 1) + 32 + 6,
    );
  });

  it('keeps multiple calls and schemas additive', () => {
    const singleCall = estimateMessageTokens({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: '1', name: 'x', arguments: {} }],
    });
    const doubleCall = estimateMessageTokens({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: '1', name: 'x', arguments: {} },
        { id: '1', name: 'x', arguments: {} },
      ],
    });
    assert.equal(doubleCall, 8 + 2 * (singleCall - 8));

    const oneSchema = estimateContext({ messages: [], toolSchemas: [{}], maxOutputTokens: 0 });
    const twoSchemas = estimateContext({ messages: [], toolSchemas: [{}, {}], maxOutputTokens: 0 });
    assert.equal(twoSchemas.inputTokens - 32, 2 * (oneSchema.inputTokens - 32));
  });

  it('uses the larger of a full estimate and latest Provider prefix usage plus trailing input', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', content: '{"ok":true,"data":{}}', toolCallId: 'c1', toolName: 'read' },
    ];
    const toolSchemas = [{ name: 'read', parameters: { type: 'object' } }];
    const trailingInputTokens = estimateMessageTokens(messages[2])
      + estimateToolSchemasTokens(toolSchemas);
    const observed = estimateContextWithUsage({
      messages,
      toolSchemas,
      maxOutputTokens: 50,
      latestUsage: {
        prefixMessageCount: 2,
        usage: {
          inputTokens: 170,
          outputTokens: 30,
          totalTokens: 200,
          cachedInputTokens: 40,
          cacheCreationInputTokens: 10,
          reasoningOutputTokens: 20,
        },
      },
    });

    assert.equal(observed.providerPrefixTokens, 200);
    assert.equal(observed.trailingInputTokens, trailingInputTokens);
    assert.equal(observed.inputTokens, 200 + trailingInputTokens);
    assert.equal(observed.contextDemandTokens, observed.inputTokens + 50);

    const smallerUsage = estimateContextWithUsage({
      messages,
      toolSchemas,
      maxOutputTokens: 50,
      latestUsage: {
        prefixMessageCount: 2,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    });
    assert.equal(smallerUsage.inputTokens, smallerUsage.deterministicInputTokens);
  });

  it('falls back conservatively for missing, malformed, or out-of-range usage anchors', () => {
    const input = {
      messages: [{ role: 'user' as const, content: '😀'.repeat(20) }],
      toolSchemas: [{ type: 'object' }],
      maxOutputTokens: 10,
    };
    const deterministic = estimateContext(input);
    const anchors = [
      undefined,
      {
        prefixMessageCount: 2,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      {
        prefixMessageCount: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 99 },
      },
      {
        prefixMessageCount: 1,
        usage: {
          inputTokens: 5,
          outputTokens: 1,
          totalTokens: 6,
          cachedInputTokens: 4,
          cacheCreationInputTokens: 2,
        },
      },
    ];

    for (const latestUsage of anchors) {
      const estimate = estimateContextWithUsage({
        ...input,
        latestUsage: latestUsage as Parameters<typeof estimateContextWithUsage>[0]['latestUsage'],
      });
      assert.equal(estimate.inputTokens, deterministic.inputTokens);
      assert.equal(estimate.providerPrefixTokens, null);
      assert.equal(estimate.trailingInputTokens, deterministic.inputTokens);
    }
  });

  it('saturates Provider usage plus trailing input instead of overflowing admission math', () => {
    const estimate = estimateContextWithUsage({
      messages: [
        { role: 'assistant', content: '' },
        { role: 'user', content: 'trailing' },
      ],
      maxOutputTokens: 100,
      latestUsage: {
        prefixMessageCount: 1,
        usage: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 0,
          totalTokens: Number.MAX_SAFE_INTEGER,
        },
      },
    });
    assert.equal(estimate.inputTokens, Number.MAX_SAFE_INTEGER);
    assert.equal(estimate.contextDemandTokens, Number.MAX_SAFE_INTEGER);
  });
});

describe('compaction context budgets', () => {
  it('uses full declared windows and never invents an 8K fallback', () => {
    assert.throws(() => resolveEffectiveContextWindow(undefined), /unresolved/u);
    assert.throws(() => resolveEffectiveContextWindow(null), /unresolved/u);
    assert.equal(resolveEffectiveContextWindow(4096), 4096);
    assert.equal(resolveEffectiveContextWindow(1_050_000), 1_050_000);
    const large = resolveContextBudgetProfile(1_050_000);
    assert.equal(large.providerWindow, 1_050_000);
    assert.equal(large.workingWindow, 1_050_000);
    assert.equal(large.effectiveWindow, 1_050_000);
    assert.equal(large.compactionReserveTokens, 16_384);
    assert.equal(large.keepRecentTokens, 20_000);
    assert.equal(large.hardLimit, 1_050_000 - 1_024 - 4_096);
    assert.equal(large.softLimit, large.hardLimit - 16_384);
    assert.equal(large.summaryInputCap, 1_050_000 - 1_024 - 4_096);
    assert.equal(CONTEXT_PROFILE_32768.providerWindow, 32_768);
  });

  it('locks exact soft, hard, summary-cap, and summary-request boundaries', () => {
    assert.equal(
      shouldCompact({ inputTokens: CONTEXT_PROFILE_8192.softLimit - 1, contextDemandTokens: 99_999 }, CONTEXT_PROFILE_8192),
      false,
    );
    assert.equal(
      shouldCompact({ inputTokens: CONTEXT_PROFILE_8192.softLimit, contextDemandTokens: 0 }, CONTEXT_PROFILE_8192),
      true,
    );
    assert.equal(
      isWithinHardLimit(
        { inputTokens: CONTEXT_PROFILE_8192.hardLimit, contextDemandTokens: 99_999 },
        CONTEXT_PROFILE_8192,
      ),
      true,
    );
    assert.equal(
      isWithinHardLimit(
        { inputTokens: CONTEXT_PROFILE_8192.hardLimit + 1, contextDemandTokens: 0 },
        CONTEXT_PROFILE_8192,
      ),
      false,
    );
    assert.equal(isWithinSummaryInputCap(CONTEXT_PROFILE_8192.summaryInputCap, CONTEXT_PROFILE_8192), true);
    assert.equal(isWithinSummaryInputCap(CONTEXT_PROFILE_8192.summaryInputCap + 1, CONTEXT_PROFILE_8192), false);
    const summaryBoundary = CONTEXT_PROFILE_8192.workingWindow
      - CONTEXT_PROFILE_8192.safetyReserveTokens
      - 1024
      - 1024;
    assert.equal(isSummaryRequestWithinEffectiveWindow(summaryBoundary, CONTEXT_PROFILE_8192), true);
    assert.equal(isSummaryRequestWithinEffectiveWindow(summaryBoundary + 1, CONTEXT_PROFILE_8192), false);

    assert.deepEqual(
      preflightContextRequest(
        { messages: [], maxOutputTokens: 8 },
        { hardLimit: 40 },
      ),
      { inputTokens: 32, contextDemandTokens: 40, accepted: true },
    );
    assert.deepEqual(
      preflightContextRequest(
        { messages: [], maxOutputTokens: 9 },
        { hardLimit: 31 },
      ),
      { inputTokens: 32, contextDemandTokens: 41, accepted: false },
    );

    const usagePreflight = preflightContextRequest(
      {
        messages: [{ role: 'assistant', content: '' }],
        maxOutputTokens: 8,
        latestUsage: {
          prefixMessageCount: 1,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        },
      },
      { hardLimit: 119 },
    );
    assert.equal(usagePreflight.inputTokens, 120);
    assert.equal(usagePreflight.accepted, false);
  });
});

describe('complete committed-turn grammar', () => {
  it('accepts empty, simple, tool, multi-call, and multi-step histories', () => {
    assert.deepEqual(parseCommittedHistory([]), { turns: [], legalBoundaries: [] });
    assert.deepEqual(parseCommittedHistory(simpleTurn('1')).legalBoundaries, [2]);
    assert.deepEqual(parseCommittedHistory(oneToolTurn('1')).legalBoundaries, [4]);

    const settledToolTerminal = oneToolTurn('terminal').slice(0, -1);
    const settledThenFollowedUp = [...settledToolTerminal, ...simpleTurn('next')];
    assert.deepEqual(parseCommittedHistory(settledThenFollowedUp), {
      turns: [
        { start: 0, end: 3 },
        { start: 3, end: 5 },
      ],
      legalBoundaries: [3, 5],
    });
    assert.equal(
      verifyCheckpointCursor(settledThenFollowedUp, {
        summarizedMessageCount: 3,
        summarizedThroughMessageId: 'terminal-result',
      }),
      3,
    );

    const multi = [
      message('1-u', 'user'),
      message('2-call', 'agent', '', {
        toolCalls: [
          { id: 'c1', name: 'one', arguments: {} },
          { id: 'c2', name: 'two', arguments: {} },
        ],
      }),
      message('3-r1', 'tool', '', { toolCallId: 'c1', toolName: 'one' }),
      message('4-r2', 'tool', '', { toolCallId: 'c2', toolName: 'two' }),
      message('5-call', 'agent', '', {
        toolCalls: [{ id: 'c3', name: 'three', arguments: {} }],
      }),
      message('6-r3', 'tool', '', { toolCallId: 'c3', toolName: 'three' }),
      message('7-a', 'agent'),
      ...simpleTurn('8'),
    ];
    assert.deepEqual(parseCommittedHistory(multi).legalBoundaries, [7, 9]);
  });

  it.each([
    ['assistant first', [message('1', 'agent')]],
    ['orphan result', [message('1', 'tool')]],
    ['missing result', [
      message('1', 'user'),
      message('2', 'agent', '', { toolCalls: [{ id: 'c1', name: 'one', arguments: {} }] }),
      message('3', 'agent'),
    ]],
    ['duplicate result', [
      message('1', 'user'),
      message('2', 'agent', '', { toolCalls: [{ id: 'c1', name: 'one', arguments: {} }] }),
      message('3', 'tool', '', { toolCallId: 'c1', toolName: 'one' }),
      message('4', 'tool', '', { toolCallId: 'c1', toolName: 'one' }),
      message('5', 'agent'),
    ]],
    ['duplicate declared call ID', [
      message('1', 'user'),
      message('2', 'agent', '', { toolCalls: [
        { id: 'c1', name: 'one', arguments: {} },
        { id: 'c1', name: 'two', arguments: {} },
      ] }),
    ]],
    ['mismatched call ID', [
      message('1', 'user'),
      message('2', 'agent', '', { toolCalls: [{ id: 'c1', name: 'one', arguments: {} }] }),
      message('3', 'tool', '', { toolCallId: 'other', toolName: 'one' }),
      message('4', 'agent'),
    ]],
    ['mismatched tool name', [
      message('1', 'user'),
      message('2', 'agent', '', { toolCalls: [{ id: 'c1', name: 'one', arguments: {} }] }),
      message('3', 'tool', '', { toolCallId: 'c1', toolName: 'two' }),
      message('4', 'agent'),
    ]],
    ['new user before final', [message('1', 'user'), message('2', 'user')]],
    ['trailing incomplete user', [message('1', 'user')]],
    ['result after final', [...simpleTurn('1'), message('3', 'tool')]],
  ])('rejects %s', (_label, history) => {
    assert.throws(() => parseCommittedHistory(history), InvalidCommittedHistoryError);
  });

  it('returns only post-final boundaries and verifies checkpoint count plus terminal ID', () => {
    const history = [...oneToolTurn('1'), ...simpleTurn('2')];
    const parsed = parseCommittedHistory(history);
    assert.deepEqual(parsed.legalBoundaries, [4, 6]);
    assert.equal(history[3].role, 'agent');
    assert.equal(history[5].role, 'agent');
    assert.equal(
      verifyCheckpointCursor(history, {
        summarizedMessageCount: 4,
        summarizedThroughMessageId: history[3].id,
      }),
      4,
    );
    assert.throws(
      () => verifyCheckpointCursor(history, {
        summarizedMessageCount: 3,
        summarizedThroughMessageId: history[2].id,
      }),
      InvalidCommittedHistoryError,
    );
    assert.throws(
      () => verifyCheckpointCursor(history, {
        summarizedMessageCount: 4,
        summarizedThroughMessageId: 'stale-id',
      }),
      InvalidCommittedHistoryError,
    );
  });
});

describe('summary ranges and compaction candidates', () => {
  it('constructs exact initial, incremental, and all-history ranges without mutation', () => {
    const history = [...simpleTurn('1'), ...simpleTurn('2'), ...simpleTurn('3')];
    const rawBefore = JSON.stringify(history);
    const initial = buildSummaryRange(history, 2);
    assert.equal(initial.kind, 'initial');
    assert.deepEqual(initial.messages.map((item) => item.id), history.slice(0, 2).map((item) => item.id));
    assert.equal(initial.allHistory, false);

    const checkpoint: CompactionCheckpoint = {
      summary: 'previous summary',
      summarizedMessageCount: 2,
      summarizedThroughMessageId: history[1].id,
    };
    const incremental = buildSummaryRange(history, 4, checkpoint);
    assert.equal(incremental.kind, 'incremental');
    assert.equal(incremental.previousSummary, 'previous summary');
    assert.deepEqual(
      incremental.messages.map((item) => item.id),
      history.slice(2, 4).map((item) => item.id),
    );
    assert.equal(incremental.messages.some((item) => item.id === history[0].id), false);

    const all = buildSummaryRange(history, history.length, checkpoint);
    assert.equal(all.allHistory, true);
    assert.deepEqual(all.messages, history.slice(2));
    assert.equal(all.summarizedThroughMessageId, history.at(-1)?.id);
    assert.equal(JSON.stringify(history), rawBefore);
  });

  it('chooses the earliest ascending candidate that preserves the recent suffix target', () => {
    const history = [
      ...simpleTurn('1', 'x'.repeat(30)),
      ...simpleTurn('2', 'x'.repeat(30)),
      ...simpleTurn('3', 'x'.repeat(30)),
    ];
    const rawBefore = JSON.stringify(history);
    const candidate = selectCompactionCandidate({
      history,
      profile: planningProfile({ recentHistoryTarget: 72 }),
      summaryRequestBase: emptyRequestBase,
      agentRequestBase: { ...emptyRequestBase, maxOutputTokens: 100 },
    });
    assert.equal(candidate?.boundary, 2);
    assert.equal(candidate?.retainedHistoryTokens, 72);
    assert.deepEqual(candidate?.range.messages, history.slice(0, 2));
    assert.deepEqual(candidate?.retainedHistory, history.slice(2));
    assert.equal(JSON.stringify(history), rawBefore);
  });

  it('advances incrementally without resending the already summarized prefix', () => {
    const history = [
      ...simpleTurn('1', 'x'.repeat(30)),
      ...simpleTurn('2', 'x'.repeat(30)),
      ...simpleTurn('3', 'x'.repeat(30)),
    ];
    const checkpoint: CompactionCheckpoint = {
      summary: 'prior',
      summarizedMessageCount: 2,
      summarizedThroughMessageId: history[1].id,
    };
    const candidate = selectCompactionCandidate({
      history,
      checkpoint,
      profile: planningProfile({ recentHistoryTarget: 36 }),
      summaryRequestBase: emptyRequestBase,
      agentRequestBase: { ...emptyRequestBase, maxOutputTokens: 100 },
    });
    assert.equal(candidate?.boundary, 4);
    assert.equal(candidate?.range.start, 2);
    assert.deepEqual(candidate?.range.messages, history.slice(2, 4));
    assert.equal(candidate?.range.messages.some((item) => item.id === history[0].id), false);
  });

  it('accepts exact summary and projection boundaries and rejects one token over', () => {
    const history = simpleTurn('1', 'x'.repeat(30));
    const compactedTokens = history.reduce(
      (total, item) => total + estimateMessageTokens({
        role: item.role === 'agent' ? 'assistant' : 'user',
        content: item.content,
      }),
      0,
    );
    const exactSummaryInput = 32 + compactedTokens;
    const exactProjectionInput = 32 + 8 + 1024;
    const base = {
      history,
      summaryRequestBase: emptyRequestBase,
      agentRequestBase: { ...emptyRequestBase, maxOutputTokens: 100 },
    };

    assert.ok(selectCompactionCandidate({
      ...base,
      profile: planningProfile({
        recentHistoryTarget: 0,
        summaryInputCap: exactSummaryInput,
        hardLimit: exactProjectionInput,
      }),
    }));
    assert.equal(selectCompactionCandidate({
      ...base,
      profile: planningProfile({
        recentHistoryTarget: 0,
        summaryInputCap: exactSummaryInput - 1,
        hardLimit: exactProjectionInput,
      }),
    }), null);
    assert.equal(selectCompactionCandidate({
      ...base,
      profile: planningProfile({
        recentHistoryTarget: 0,
        summaryInputCap: exactSummaryInput,
        hardLimit: exactProjectionInput - 1,
      }),
    }), null);
  });

  it('allows all-history compaction and returns no candidate for an oversized complete turn', () => {
    const history = [...simpleTurn('1', 'x'.repeat(30)), ...simpleTurn('2', 'x'.repeat(30))];
    const allHistory = selectCompactionCandidate({
      history,
      profile: planningProfile({ recentHistoryTarget: 0 }),
      summaryRequestBase: emptyRequestBase,
      agentRequestBase: { ...emptyRequestBase, maxOutputTokens: 100 },
    });
    assert.equal(allHistory?.boundary, history.length);
    assert.equal(allHistory?.range.allHistory, true);
    assert.deepEqual(allHistory?.retainedHistory, []);

    const oversized = simpleTurn('9', 'x'.repeat(9000));
    assert.equal(selectCompactionCandidate({
      history: oversized,
      profile: planningProfile({ recentHistoryTarget: 0, summaryInputCap: 100 }),
      summaryRequestBase: emptyRequestBase,
      agentRequestBase: { ...emptyRequestBase, maxOutputTokens: 100 },
    }), null);
  });

  it('never includes fixed current-prompt input in the summary range', () => {
    const history = simpleTurn('1', 'old');
    const currentPrompt: ModelMessage = { role: 'user', content: 'CURRENT-ONLY' };
    const candidate = selectCompactionCandidate({
      history,
      profile: planningProfile({ recentHistoryTarget: 0 }),
      summaryRequestBase: emptyRequestBase,
      agentRequestBase: { messages: [currentPrompt], maxOutputTokens: 100 },
    });
    assert.ok(candidate);
    assert.equal(JSON.stringify(candidate.range).includes('CURRENT-ONLY'), false);
  });

  it('splits an active turn only at an assistant-envelope boundary', () => {
    const rawMessages = [
      message('1-user', 'user', 'ORIGINAL-CURRENT-PROMPT'),
      message('2-call', 'agent', 'first', {
        toolCalls: [{ id: 'call-1', name: 'read', arguments: { page: 1 } }],
      }),
      message('3-result', 'tool', '{}', { toolCallId: 'call-1', toolName: 'read' }),
      message('4-call', 'agent', 'second', {
        toolCalls: [{ id: 'call-2', name: 'read', arguments: { page: 2 } }],
      }),
      message('5-result', 'tool', '{}', { toolCallId: 'call-2', toolName: 'read' }),
      message('6-call', 'agent', 'third', {
        toolCalls: [{ id: 'call-3', name: 'read', arguments: { page: 3 } }],
      }),
      message('7-result', 'tool', '{}', { toolCallId: 'call-3', toolName: 'read' }),
    ];
    const candidate = selectActiveTurnCompactionCandidate({
      rawMessages,
      start: 1,
      profile: planningProfile({ recentHistoryTarget: 1_000 }),
      summaryRequestBase: emptyRequestBase,
      agentRequestBase: {
        messages: [{ role: 'user', content: rawMessages[0]!.content }],
        maxOutputTokens: 100,
      },
    });

    assert.equal(candidate?.boundary, 3);
    assert.deepEqual(candidate?.range.messages, rawMessages.slice(1, 3));
    assert.equal(candidate?.range.messages.some((item) => item.role === 'user'), false);
    assert.equal(candidate?.range.summarizedThroughMessageId, '3-result');
    assert.deepEqual(candidate?.retainedHistory, rawMessages.slice(3));
    assert.equal(candidate?.retainedHistory[0]?.role, 'agent');
  });

  it('can summarize all settled active envelopes when no recent suffix fits', () => {
    const rawMessages = [
      message('1-user', 'user', 'ORIGINAL-CURRENT-PROMPT'),
      message('2-call', 'agent', 'read', {
        toolCalls: [{ id: 'call-1', name: 'read', arguments: { page: 1 } }],
      }),
      message('3-result', 'tool', '{}', { toolCallId: 'call-1', toolName: 'read' }),
    ];
    const candidate = selectActiveTurnCompactionCandidate({
      rawMessages,
      start: 1,
      profile: planningProfile({ recentHistoryTarget: 0 }),
      summaryRequestBase: emptyRequestBase,
      agentRequestBase: {
        messages: [{ role: 'user', content: rawMessages[0]!.content }],
        maxOutputTokens: 100,
      },
    });

    assert.equal(candidate?.boundary, rawMessages.length);
    assert.deepEqual(candidate?.range.messages, rawMessages.slice(1));
    assert.deepEqual(candidate?.retainedHistory, []);
    assert.equal(candidate?.range.summarizedThroughMessageId, '3-result');
  });
});
