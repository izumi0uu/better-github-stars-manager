import { describe, expect, it } from 'vitest';
import {
  canReplayPendingTurn,
  canSafelyRetryPendingTurn,
  canSafelyRetrySettledPendingTurn,
  retryDraftKindForResult,
  sameDraftTurn,
  sameRetryDraft,
  trackPendingWriteOutcome,
} from '@/ui/bgsm-agent-retry-policy';
import type { AgentRetryDraft } from '@/storage/agent-session-store';
import type { BgsmAgentTurnEvent } from '@/utils/messaging';

const delivery = {
  turnAttemptId: 'attempt-one',
  sessionId: 'session-one',
  baseRevision: 0,
};

describe('BGSM Agent retry policy', () => {
  it('allows replay only after every observed write failed', () => {
    const writeOutcomes = new Map<string, 'in_flight' | 'committed' | 'failed' | 'unknown'>();
    expect(canReplayPendingTurn({ writeOutcomes })).toBe(true);

    writeOutcomes.set('write-one', 'failed');
    writeOutcomes.set('write-two', 'failed');
    expect(canReplayPendingTurn({ writeOutcomes })).toBe(true);

    writeOutcomes.set('write-two', 'unknown');
    expect(canReplayPendingTurn({ writeOutcomes })).toBe(false);
  });

  it('keeps recovered authority and claimed drafts from using the fresh retry path', () => {
    const writeOutcomes = new Map([['write-one', 'failed' as const]]);
    const sourceRetryDraft: AgentRetryDraft = {
      sessionId: 'session-one',
      turnAttemptId: 'attempt-one',
      baseRevision: 0,
      prompt: 'Retry this.',
      kind: 'failed',
      settlement: 'retryable',
      updatedAt: 1,
    };

    expect(canSafelyRetryPendingTurn({
      writeOutcomes,
      retryAuthority: 'fresh',
      sourceRetryDraft: null,
    })).toBe(true);
    expect(canSafelyRetryPendingTurn({
      writeOutcomes,
      retryAuthority: 'recovered_retryable',
      sourceRetryDraft,
    })).toBe(false);
    expect(canSafelyRetrySettledPendingTurn({
      writeOutcomes,
      retryAuthority: 'recovered_stop',
    })).toBe(true);
    expect(canSafelyRetrySettledPendingTurn({
      writeOutcomes,
      retryAuthority: 'unknown_resume',
    })).toBe(false);
  });

  it('tracks write starts and terminal outcomes conservatively', () => {
    const writeOutcomes = new Map<string, 'in_flight' | 'committed' | 'failed' | 'unknown'>();
    const start = {
      ...delivery,
      type: 'tool_execution_start',
      toolName: 'apply_tags',
      callId: 'write-one',
      risk: 'write',
    } satisfies BgsmAgentTurnEvent;
    const end = {
      ...delivery,
      type: 'tool_execution_end',
      toolName: 'apply_tags',
      callId: 'write-one',
      risk: 'write',
      ok: false,
      writeOutcome: 'not_applicable',
    } satisfies BgsmAgentTurnEvent;

    expect(trackPendingWriteOutcome({ writeOutcomes }, start)).toBe(true);
    expect(writeOutcomes.get('write-one')).toBe('in_flight');
    expect(trackPendingWriteOutcome({ writeOutcomes }, end)).toBe(true);
    expect(writeOutcomes.get('write-one')).toBe('unknown');
  });

  it('maps terminal results to the durable draft category', () => {
    expect(retryDraftKindForResult({ reason: 'final_answer' })).toBeNull();
    expect(retryDraftKindForResult({ reason: 'attempt_state_lost' })).toBeNull();
    expect(retryDraftKindForResult({ reason: 'aborted' })).toBe('stopped');
    expect(retryDraftKindForResult({
      reason: 'provider_error',
      contextFailureReason: 'provider_context_overflow_repeated',
    })).toBe('context_limit');
    expect(retryDraftKindForResult({ reason: 'provider_error' })).toBe('failed');
  });


  it('matches active turns semantically but retry drafts exactly', () => {
    const source: AgentRetryDraft = {
      sessionId: 'session-one',
      turnAttemptId: 'attempt-one',
      baseRevision: 0,
      prompt: 'Retry this.',
      kind: 'failed',
      settlement: 'retryable',
      updatedAt: 1,
    };
    expect(sameDraftTurn(source, {
      executionEpochId: 'worker-one',
      launch: {
        sessionId: source.sessionId,
        turnAttemptId: source.turnAttemptId,
        baseRevision: source.baseRevision,
        prompt: `  ${source.prompt}  `,
      },
    })).toBe(true);
    expect(sameRetryDraft(structuredClone(source), source)).toBe(true);
    expect(sameRetryDraft({ ...source, updatedAt: 2 }, source)).toBe(false);
  });
});

