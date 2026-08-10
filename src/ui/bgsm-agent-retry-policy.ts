import type {
  AgentRetryDraft,
  AgentRetryDraftKind,
} from '@/storage/agent-session-store';
import type {
  BgsmAgentActiveTurn,
  BgsmAgentTurnEvent,
  BgsmAgentTurnResult,
} from '@/bgsm-agent/turn-protocol';

export type PendingRetryAuthority =
  | 'fresh'
  | 'recovered_stop'
  | 'recovered_retryable'
  | 'recovered_retry'
  | 'unknown_resume';

export type PendingWriteOutcome = 'in_flight' | 'committed' | 'failed' | 'unknown';


type PendingWriteState = Readonly<{
  writeOutcomes: Map<string, PendingWriteOutcome>;
}>;

export function canReplayPendingTurn(pending: PendingWriteState): boolean {
  return [...pending.writeOutcomes.values()].every((outcome) => outcome === 'failed');
}

export function canSafelyRetryPendingTurn(
  pending: PendingWriteState & Readonly<{
    retryAuthority: PendingRetryAuthority;
    sourceRetryDraft: AgentRetryDraft | null;
  }>,
): boolean {
  return pending.retryAuthority === 'fresh'
    && pending.sourceRetryDraft === null
    && canReplayPendingTurn(pending);
}

export function canSafelyRetrySettledPendingTurn(
  pending: PendingWriteState & Readonly<{ retryAuthority: PendingRetryAuthority }>,
): boolean {
  return pending.retryAuthority !== 'unknown_resume' && canReplayPendingTurn(pending);
}

export function trackPendingWriteOutcome(
  pending: PendingWriteState,
  event: BgsmAgentTurnEvent,
): boolean {
  if (event.type === 'tool_execution_start' && event.risk === 'write') {
    pending.writeOutcomes.set(event.callId, 'in_flight');
    return true;
  }
  if (event.type === 'tool_execution_end' && event.risk === 'write') {
    pending.writeOutcomes.set(
      event.callId,
      event.writeOutcome === 'not_applicable' ? 'unknown' : event.writeOutcome,
    );
    return true;
  }
  return false;
}

export function retryDraftKindForResult(
  result: Pick<BgsmAgentTurnResult, 'reason' | 'contextFailureReason'>,
): AgentRetryDraftKind | null {
  if (result.reason === 'final_answer' || result.reason === 'attempt_state_lost') return null;
  if (result.reason === 'aborted') return 'stopped';
  if (result.reason === 'context_limit' || result.contextFailureReason) return 'context_limit';
  return 'failed';
}


export function sameDraftTurn(
  draft: AgentRetryDraft,
  activeTurn: BgsmAgentActiveTurn,
): boolean {
  return activeTurn.launch.sessionId === draft.sessionId
    && activeTurn.launch.turnAttemptId === draft.turnAttemptId
    && activeTurn.launch.baseRevision === draft.baseRevision
    && activeTurn.launch.prompt.trim() === draft.prompt.trim();
}

export function sameRetryDraft(
  left: AgentRetryDraft | null,
  right: AgentRetryDraft,
): boolean {
  return left !== null
    && left.sessionId === right.sessionId
    && left.turnAttemptId === right.turnAttemptId
    && left.baseRevision === right.baseRevision
    && left.prompt === right.prompt
    && left.kind === right.kind
    && left.settlement === right.settlement
    && left.updatedAt === right.updatedAt;
}
