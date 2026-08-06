import { describe, expect, it, vi } from 'vitest';
import type { AgentRetryDraft, LoadedAgentSession } from '@/storage/agent-session-store';
import {
  resolveBgsmAgentHydratedRetryState,
  type BgsmAgentRetryRecoveryGateway,
} from '@/ui/bgsm-agent-retry-recovery';
import type { BgsmAgentActiveTurn } from '@/utils/messaging';

describe('BGSM Agent retry recovery', () => {
  it('adopts a same-revision retryable projection without mutating it', async () => {
    const candidate = draft('session-one', 3, 'attempt-one', 'Retry this.', 'retryable');
    const gateway = gatewayWithCandidate(candidate);

    await expect(resolveBgsmAgentHydratedRetryState(
      loadedSession('session-one', 3),
      null,
      gateway,
    )).resolves.toEqual({ draft: candidate, activeTurn: null });
    expect(gateway.readCandidate).toHaveBeenCalledTimes(1);
  });

  it('identifies a matching stop-pending attempt as a recovered stop', async () => {
    const candidate = draft('session-one', 3, 'attempt-one', 'Retry this.', 'stop_pending');
    const running = active('session-one', 3, 'attempt-one', 'Retry this.');

    await expect(resolveBgsmAgentHydratedRetryState(
      loadedSession('session-one', 3),
      running,
      gatewayWithCandidate(candidate),
    )).resolves.toEqual({
      draft: candidate,
      activeTurn: {
        turn: running,
        retryAuthority: 'recovered_stop',
        sourceRetryDraft: candidate,
      },
    });
  });

  it('keeps an unrelated active turn fail-closed without rewriting retry authority', async () => {
    const candidate = draft('session-one', 3, 'attempt-one', 'Retry this.', 'retryable');
    const running = active('session-one', 3, 'attempt-two', 'New request.');

    await expect(resolveBgsmAgentHydratedRetryState(
      loadedSession('session-one', 3),
      running,
      gatewayWithCandidate(candidate),
    )).resolves.toEqual({
      draft: candidate,
      activeTurn: {
        turn: running,
        retryAuthority: 'unknown_resume',
        sourceRetryDraft: candidate,
      },
    });
  });

  it('does not treat a stale projection as retryable at a newer canonical revision', async () => {
    const candidate = draft('session-one', 2, 'attempt-one', 'Retry this.', 'retryable');

    await expect(resolveBgsmAgentHydratedRetryState(
      loadedSession('session-one', 3),
      null,
      gatewayWithCandidate(candidate),
    )).resolves.toEqual({ draft: null, activeTurn: null });
  });
});

function loadedSession(sessionId: string, revision: number): LoadedAgentSession {
  return {
    session: { id: sessionId, revision },
    transcript: { sessionId, messages: [], nextBeforeSequence: null },
    summary: { id: sessionId, title: '', createdAt: 1, updatedAt: 1 },
    lastAppliedTurnAttemptId: null,
    appliedTurnReceipts: [],
  };
}

function active(
  sessionId: string,
  baseRevision: number,
  turnAttemptId: string,
  prompt: string,
): BgsmAgentActiveTurn {
  return {
    executionEpochId: 'worker-one',
    launch: { sessionId, baseRevision, turnAttemptId, prompt },
  };
}

function draft(
  sessionId: string,
  baseRevision: number,
  turnAttemptId: string,
  prompt: string,
  settlement: AgentRetryDraft['settlement'],
): AgentRetryDraft {
  return {
    sessionId,
    baseRevision,
    turnAttemptId,
    prompt,
    kind: 'stopped',
    settlement,
    updatedAt: 1,
  };
}

function gatewayWithCandidate(candidate: AgentRetryDraft | null): BgsmAgentRetryRecoveryGateway {
  return { readCandidate: vi.fn(async () => candidate) };
}
