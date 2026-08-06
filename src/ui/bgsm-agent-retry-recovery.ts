import type { AgentRetryDraft, LoadedAgentSession } from '@/storage/agent-session-store';
import {
  sameDraftTurn,
  type PendingRetryAuthority,
} from '@/ui/bgsm-agent-retry-policy';
import type { BgsmAgentActiveTurn } from '@/utils/messaging';

export type HydratedActiveTurn = Readonly<{
  turn: BgsmAgentActiveTurn;
  retryAuthority: Exclude<PendingRetryAuthority, 'fresh'>;
  sourceRetryDraft: AgentRetryDraft | null;
}>;

export type HydratedRetryResolution = Readonly<{
  draft: AgentRetryDraft | null;
  activeTurn: HydratedActiveTurn | null;
}>;

export type BgsmAgentRetryRecoveryGateway = Readonly<{
  readCandidate: (sessionId: string) => Promise<AgentRetryDraft | null>;
}>;

/**
 * Hydration only reads the background-owned attempt projection. A stale or
 * unrelated projection never becomes UI authority; admission resolves it
 * atomically as retry, supersede, or conflict.
 */
export async function resolveBgsmAgentHydratedRetryState(
  loaded: LoadedAgentSession,
  activeTurn: BgsmAgentActiveTurn | null,
  gateway: BgsmAgentRetryRecoveryGateway,
): Promise<HydratedRetryResolution> {
  const sessionId = loaded.session.id;
  const currentRevision = loaded.session.revision;
  const currentActiveTurn = activeTurn?.launch.sessionId === sessionId
    && activeTurn.launch.baseRevision === currentRevision
    ? activeTurn
    : null;
  const candidate = await gateway.readCandidate(sessionId);
  const usableCandidate = candidate?.baseRevision === currentRevision ? candidate : null;

  if (!currentActiveTurn) return { draft: usableCandidate, activeTurn: null };
  if (!usableCandidate) {
    return {
      draft: null,
      activeTurn: {
        turn: currentActiveTurn,
        retryAuthority: 'unknown_resume',
        sourceRetryDraft: candidate,
      },
    };
  }
  if (!sameDraftTurn(usableCandidate, currentActiveTurn)) {
    return {
      draft: usableCandidate,
      activeTurn: {
        turn: currentActiveTurn,
        retryAuthority: 'unknown_resume',
        sourceRetryDraft: usableCandidate,
      },
    };
  }
  return {
    draft: usableCandidate,
    activeTurn: {
      turn: currentActiveTurn,
      retryAuthority: usableCandidate.settlement === 'stop_pending'
        ? 'recovered_stop'
        : 'recovered_retryable',
      sourceRetryDraft: usableCandidate,
    },
  };
}
