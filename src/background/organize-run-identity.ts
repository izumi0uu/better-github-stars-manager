import type { OrganizeJobRunSnapshot } from '@/bgsm-agent';
import { parseControllerId, parseRunId } from '@/bgsm-agent/identity';
import type { OrganizeJobRecord } from '@/types';
import type {
  BgsmOrganizeJobClientMessage,
  BgsmOrganizeJobControlFailureReason,
  BgsmOrganizeJobErrorReason,
} from '@/utils/messaging';
import type { OrganizeRunIdentity } from './organize-job-controller';

/**
 * Addressing and failure classification for durable OrganizeJobRun messages. A
 * page is identified by controller plus session; a run additionally carries its
 * id and generation, and the two must never be conflated when replying to a
 * reconnected port.
 */
export type OrganizePageIdentity = Readonly<{
  controllerId: BgsmOrganizeJobClientMessage['controllerId'];
  sessionId: string;
}>;

export class OrganizeControlFailure extends Error {
  readonly reason: BgsmOrganizeJobControlFailureReason;

  constructor(reason: BgsmOrganizeJobControlFailureReason) {
    super(reason);
    this.name = 'OrganizeControlFailure';
    this.reason = reason;
  }
}

export function isTerminalOrganizeJob(job: Pick<OrganizeJobRecord, 'status'>): boolean {
  return job.status === 'completed' || job.status === 'cancelled';
}

export function durableOrganizePageIdentity(job: Pick<OrganizeJobRecord, 'controllerId' | 'sessionId'>): OrganizePageIdentity {
  return { controllerId: parseControllerId(job.controllerId), sessionId: job.sessionId };
}

export function durableOrganizeRunIdentity(
  job: Pick<OrganizeJobRecord, 'controllerId' | 'sessionId' | 'runId' | 'generation'>,
): OrganizeRunIdentity {
  return {
    ...durableOrganizePageIdentity(job),
    runId: parseRunId(job.runId),
    generation: job.generation,
  };
}

export function readdressOrganizeSnapshot(
  snapshot: OrganizeJobRunSnapshot,
  page: OrganizePageIdentity,
): OrganizeJobRunSnapshot {
  return Object.freeze({ ...snapshot, ...organizePageAddress(page) });
}

export function organizePageAddress(page: OrganizePageIdentity): OrganizePageIdentity {
  return { controllerId: page.controllerId, sessionId: page.sessionId };
}

export function ephemeralOrganizeRunIdentity(
  snapshot: Pick<OrganizeJobRunSnapshot, 'controllerId' | 'sessionId' | 'runId' | 'generation'>,
): OrganizeRunIdentity {
  return {
    controllerId: snapshot.controllerId,
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    generation: snapshot.generation,
  };
}

export function classifyOrganizeJobRunError(error: unknown): BgsmOrganizeJobErrorReason {
  if (error instanceof OrganizeControlFailure) return error.reason;
  const message = error instanceof Error ? error.message : '';
  if (/already consumed/u.test(message)) return 'preflight_replayed';
  if (/preflight.*stale|stale.*preflight/u.test(message)) return 'preflight_stale';
  if (/preflight/u.test(message)) return 'preflight_invalid';
  if (/active OrganizeJobRun/u.test(message)) return 'already_started';
  if (/revision is stale/u.test(message)) return 'revision_conflict';
  if (/stale|does not belong/u.test(message)) return 'stale_generation';
  return 'internal_error';
}

export function boundOrganizeJobRunError(detail: string): string {
  const value = detail.trim() || "BGSM OrganizeJobRun failed.";
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= 4_096) return value;
  let bounded = "";
  for (const codePoint of value) {
    if (encoder.encode(bounded + codePoint).byteLength > 4_096) break;
    bounded += codePoint;
  }
  return bounded;
}

export function classifyOrganizeRestoreFailure(
  error: unknown,
): 'checkpoint_invariant' | 'checkpoint_missing' | 'storage_unavailable' | 'unknown' {
  const message = error instanceof Error ? error.message : '';
  if (
    error instanceof TypeError
    || error instanceof RangeError
    || /invalid|malformed|stale|contiguous|FrozenScope|ledger|fingerprint/u.test(message)
  ) return 'checkpoint_invariant';
  if (/missing|Unknown organize job/u.test(message)) return 'checkpoint_missing';
  const name = error instanceof Error ? error.name : '';
  if (/Database|Transaction|Quota|Abort|InvalidState|UnknownError/u.test(name)) {
    return 'storage_unavailable';
  }
  return 'unknown';
}

export function organizeApplyBlocksAgentWrites(job: OrganizeJobRecord | undefined): boolean {
  return !!job && ['apply_sealed', 'applying', 'paused'].includes(job.status);
}
