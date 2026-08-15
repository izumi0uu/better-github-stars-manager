import Dexie from 'dexie';
import {
  errorToolResult,
  toModelMessage,
  validateProviderProtocolHistory,
  type AgentContextFailureReason,
  type AgentStopReason,
  type ModelToolCall,
} from '@/agent-harness';
import { canonicalJson } from '@/agent-harness/canonical-json';
import {
  AgentArtifactCoverageError,
  agentArtifactCoverageDirectives,
  applyAgentArtifactCoverageEvidence,
  createAgentArtifactCoverage,
  createAgentArtifactCoverageReceipt,
  settleAgentArtifactCoverageIncomplete,
  validateAgentArtifactContinuationCheckpoint,
  validateAgentArtifactCoverageEvidence,
  validateAgentArtifactCoverageReceipt,
  validateAgentArtifactCoverageRecords,
  verifyAgentArtifactCoverageRecord,
  type AgentArtifactContinuationCheckpoint,
  type AgentArtifactCoverageEvidence,
  type AgentArtifactCoverageRecord,
  type AgentArtifactCoverageReceipt,
} from '@/bgsm-agent/artifact-coverage';
import {
  createBgsmAgentSession,
  applyBgsmAgentSessionTransitionToValidatedPrefix,
  validateBgsmAgentActiveProjection,
  validateBgsmAgentCompactionCheckpoint,
  validateBgsmAgentSessionHistory,
  verifyBgsmAgentActiveProjections,
  verifyBgsmAgentCheckpoint,
  type BgsmAgentSession,
  type BgsmAgentSessionMessage,
  type BgsmAgentSessionTransition,
} from '@/bgsm-agent/session';
import {
  assertAgentTurnTransportIdentifier,
  digestAgentSessionLaunch,
  digestAgentSessionTransition,
  serializedJsonUtf8Bytes,
  validateAgentSessionLaunchIdentity,
  validateAgentSessionLaunchDigest as validateLaunchDigest,
  type AgentSessionAttemptDigest,
  type AgentSessionLaunchDigest,
  type AgentSessionLaunchIdentity,
} from '@/bgsm-agent/session-transport';
import { validateBgsmAgentConversationBinding } from '@/bgsm-agent/conversation-binding';
import {
  AgentStorageCapacityError,
  accountAgentAttemptCreated,
  accountAgentAttemptDeleted,
  accountAgentAttemptRecoveryCreated,
  accountAgentAttemptRecoveryDeleted,
  accountAgentAttemptRecoveryUpdated,
  accountAgentAttemptUpdated,
  accountAgentMessagesAdded,
  accountAgentSessionCreated,
  accountAgentSessionUpdated,
  agentMessageLogicalByteLength,
  bindAgentArtifactsToMessages,
  cleanupAgentToolCache,
  deleteAgentSessionArtifacts,
  discardUnboundAgentArtifactsInCurrentTransaction,
  ensureAgentStorageUsage,
  reconcileAgentStorageUsageInCurrentTransaction,
  validateAgentArtifactCoverageEvidenceInCurrentTransaction,
  validateAgentArtifactCoverageStartInCurrentTransaction,
} from './agent-storage-store';
import {
  AGENT_SESSION_SCHEMA_VERSION,
  AGENT_SESSION_TERMINAL_OUTCOME_MAX_BYTES,
  AGENT_SESSION_TITLE_MAX_LENGTH,
  AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  AGENT_SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES,
  type AgentSessionAppliedTurnReceipt,
  type AgentSessionAttemptReceipt,
  type AgentSessionCatalogInspection,
  type AgentSessionCommitResult,
  type AgentSessionHandoffAnchor,
  type AgentSessionMessageRecord,
  type AgentSessionMetadata,
  type AgentSessionPresentationMessage,
  type AgentSessionRecord,
  type AgentSessionRetryDraft,
  type AgentSessionRetryKind,
  type AgentSessionTerminalOutcome,
  type AgentSessionTranscriptMessage,
  type AgentSessionTranscriptPage,
  type AgentSessionTurnAdmission,
  type AgentSessionTurnLease,
  type BgsmAgentSessionSummary,
  type CanonicalLoadedAgentSession,
  type LoadedAgentSession,
} from './agent-session-model';
import {
  agentAttemptStorageId,
  type AgentAttemptRecord,
  type AgentAttemptTerminalReason,
} from './agent-attempt-model';
import {
  joinAgentArtifactContinuation,
  splitAgentArtifactContinuation,
  validateAgentArtifactContinuationControl,
  validateAgentAttemptRecoveryRecord,
  type AgentAttemptRecoveryRecord,
} from './agent-attempt-recovery-model';
import { db } from './db';
import type { AgentCanonicalSessionCache } from './agent-session-cache';
import { getOrganizeJobsLinkedToAgentSession } from './organize-job-store';

export {
  AGENT_SESSION_SCHEMA_VERSION,
  AGENT_SESSION_TERMINAL_OUTCOME_MAX_BYTES,
  AGENT_SESSION_TITLE_MAX_LENGTH,
  AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  AGENT_SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES,
} from './agent-session-model';
export type {
  AgentRetryDraft,
  AgentRetryDraftKind,
  AgentSessionAppliedTurnReceipt,
  AgentSessionCatalogInspection,
  AgentSessionCommitResult,
  AgentSessionHandoffAnchor,
  AgentSessionMessageRecord,
  AgentSessionMetadata,
  AgentSessionPresentationMessage,
  AgentSessionRecord,
  AgentSessionRetryDraft,
  AgentSessionRetryKind,
  AgentSessionRetrySettlement,
  AgentSessionTerminalOutcome,
  AgentSessionTranscriptMessage,
  AgentSessionTranscriptPage,
  AgentSessionTurnAdmission,
  AgentSessionTurnLease,
  BgsmAgentSessionSummary,
  LoadedAgentSession,
} from './agent-session-model';
export type {
  AgentAttemptRecord,
  AgentAttemptRecoveryClass,
  AgentAttemptState,
  AgentAttemptTerminalReason,
} from './agent-attempt-model';
export type {
  AgentArtifactContinuationControl,
  AgentAttemptRecoveryRecord,
} from './agent-attempt-recovery-model';

const AGENT_SESSION_RECENT_ATTEMPT_LIMIT = 128;

type AgentAttemptRow = AgentAttemptRecord;
type AgentAttemptRecoveryRow = AgentAttemptRecoveryRecord;


async function readAgentAttemptRows(sessionId: string): Promise<AgentAttemptRow[]> {
  return db.agentAttempts.where('sessionId').equals(sessionId).toArray();
}

async function readAgentAttempt(
  sessionId: string,
  turnAttemptId: string,
): Promise<AgentAttemptRow | undefined> {
  return db.agentAttempts
    .where('[sessionId+turnAttemptId]')
    .equals([sessionId, turnAttemptId])
    .first();
}

async function loadAgentAttemptContinuation(
  attempt: AgentAttemptRow,
): Promise<AgentArtifactContinuationCheckpoint | null> {
  const control = attempt.artifactContinuationControl;
  if (control === null) {
    await assertNoAgentAttemptRecovery(attempt);
    return null;
  }
  validateAgentArtifactContinuationControl(control);
  const [exactRecoveryCount, recoveryById] = await Promise.all([
    db.agentAttemptRecoveries
      .where('[sessionId+turnAttemptId]')
      .equals([attempt.sessionId, attempt.turnAttemptId])
      .count(),
    db.agentAttemptRecoveries.get(attempt.id),
  ]);
  if (exactRecoveryCount !== 1 || recoveryById === undefined) {
    throw new TypeError('Agent attempt recovery does not have an exact one-to-one identity.');
  }
  return joinAgentArtifactContinuation(control, recoveryById, {
    id: attempt.id,
    sessionId: attempt.sessionId,
    turnAttemptId: attempt.turnAttemptId,
  });
}
async function assertNoAgentAttemptRecovery(attempt: AgentAttemptRow): Promise<void> {
  const [exactRecoveryCount, recoveryByIdCount] = await Promise.all([
    db.agentAttemptRecoveries
      .where('[sessionId+turnAttemptId]')
      .equals([attempt.sessionId, attempt.turnAttemptId])
      .count(),
    db.agentAttemptRecoveries
      .where('id')
      .equals(attempt.id)
      .count(),
  ]);
  if (exactRecoveryCount !== 0 || recoveryByIdCount !== 0) {
    throw new AgentAttemptCorruptionError(
      attempt.sessionId,
      'Agent attempt cannot retain recovery messages in this state.',
    );
  }
}


async function quarantineAgentAttemptRecovery(
  attempt: AgentAttemptRow,
  now: number,
): Promise<void> {
  const artifactCoverage = await Dexie.waitFor(Promise.all(
    attempt.artifactCoverage.map((coverage) => settleAgentArtifactCoverageIncomplete(
      coverage,
      'attempt_state_lost',
    )),
  ));
  await discardUnboundAgentArtifactsInCurrentTransaction({
    artifactIds: artifactCoverage.map((coverage) => coverage.artifactId),
    sessionId: attempt.sessionId,
    turnAttemptId: attempt.turnAttemptId,
  }, now);
  await deleteAgentAttemptRecoveriesForAttempt(attempt, now, true);
  await putAgentAttempt(attempt, {
    ...attempt,
    state: 'state_uncertain',
    terminalReason: 'attempt_state_lost',
    retryKind: null,
    writeSettlement: 'unsafe',
    artifactCoverage,
    artifactContinuationControl: null,
    lease: null,
    updatedAt: Math.max(now, attempt.updatedAt),
  }, now);
}
function isAttemptActive(attempt: AgentAttemptRow): boolean {
  return attempt.state === 'running'
    || attempt.state === 'stop_pending'
    || attempt.state === 'state_uncertain';
}

function isAttemptRetryAuthority(attempt: AgentAttemptRow): boolean {
  return attempt.state === 'retryable' || attempt.state === 'stop_pending';
}

function retryDraftFromAttemptRow(attempt: AgentAttemptRow): AgentSessionRetryDraft | null {
  if (
    !attempt.admittedLaunch
    || !isAttemptRetryAuthority(attempt)
    || !attempt.retryKind
  ) return null;
  return {
    sessionId: attempt.sessionId,
    turnAttemptId: attempt.turnAttemptId,
    baseRevision: attempt.receipt?.appliedRevision ?? attempt.admittedLaunch.baseRevision,
    prompt: attempt.admittedLaunch.prompt,
    kind: attempt.retryKind,
    settlement: attempt.state === 'retryable' ? 'retryable' : 'stop_pending',
    updatedAt: attempt.updatedAt,
  };
}

function validateAgentAttemptRow(
  attempt: AgentAttemptRow,
  expectedSessionId?: string,
): void {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    throw new TypeError('Agent attempt must be an object.');
  }
  if (!hasExactKeys(attempt as unknown as Record<string, unknown>, [
    'admittedLaunch',
    'admittedLaunchDigest',
    'artifactContinuationControl',
    'artifactCoverage',
    'id',
    'lease',
    'receipt',
    'recoveryClass',
    'retryKind',
    'sessionId',
    'state',
    'terminalReason',
    'turnAttemptId',
    'updatedAt',
    'writeSettlement',
  ])) throw new TypeError('Agent attempt has unexpected fields.');
  if (typeof attempt.id !== 'string' || !/^aat:v1:[A-Za-z0-9_-]{43}$/u.test(attempt.id)) {
    throw new TypeError('Agent attempt storage key is malformed.');
  }
  assertAgentTurnTransportIdentifier(attempt.sessionId, 'Agent attempt session ID');
  if (expectedSessionId && attempt.sessionId !== expectedSessionId) {
    throw new TypeError('Agent attempt belongs to another session.');
  }
  assertAgentTurnTransportIdentifier(attempt.turnAttemptId, 'Agent attempt ID');
  if (![
    'running',
    'stop_pending',
    'retryable',
    'committed',
    'state_uncertain',
    'terminal_non_retryable',
  ].includes(attempt.state)) throw new TypeError('Agent attempt state is invalid.');
  validateAgentArtifactCoverageRecords(attempt.artifactCoverage);
  if (attempt.artifactContinuationControl !== null) {
    validateAgentArtifactContinuationControl(attempt.artifactContinuationControl);
  }
  const coverageDirectives = agentArtifactCoverageDirectives(attempt.artifactCoverage);
  if (coverageDirectives.length > 0) {
    if (
      attempt.artifactContinuationControl === null
      || canonicalJson(attempt.artifactContinuationControl.directives) !== canonicalJson(coverageDirectives)
    ) throw new TypeError('Pending artifact coverage lacks its exact continuation control.');
  } else if (attempt.artifactContinuationControl !== null) {
    throw new TypeError('Agent artifact continuation control exists without pending coverage.');
  }
  if (
    attempt.artifactContinuationControl !== null
    && attempt.state !== 'running'
  ) throw new TypeError('Settled Agent attempts cannot retain continuation control.');
  validateLaunchDigest(attempt.admittedLaunchDigest);
  if (
    attempt.recoveryClass !== 'statically_read_only'
    && attempt.recoveryClass !== 'write_capable_or_unknown'
  ) throw new TypeError('Agent attempt recovery class is invalid.');
  if (attempt.retryKind !== null && !AGENT_SESSION_RETRY_KINDS[attempt.retryKind]) {
    throw new TypeError('Agent attempt retry kind is invalid.');
  }
  if (
    attempt.writeSettlement !== null
    && attempt.writeSettlement !== 'none'
    && attempt.writeSettlement !== 'all_failed'
    && attempt.writeSettlement !== 'unsafe'
  ) throw new TypeError('Agent attempt write settlement is invalid.');
  if (attempt.terminalReason !== null && !AGENT_ATTEMPT_TERMINAL_REASONS[attempt.terminalReason]) {
    throw new TypeError('Agent attempt terminal reason is invalid.');
  }
  if (!attempt.admittedLaunch) {
    throw new TypeError('Agent attempt must retain its admitted launch.');
  }
  validateAgentSessionLaunch(attempt.admittedLaunch, attempt.sessionId);
  if (attempt.admittedLaunch.turnAttemptId !== attempt.turnAttemptId) {
    throw new TypeError('Agent attempt launch identity does not match its row.');
  }
  if (attempt.receipt !== null) {
    validateAttemptReceipt(attempt.receipt);
    if (attempt.receipt.turnAttemptId !== attempt.turnAttemptId) {
      throw new TypeError('Agent attempt receipt identity does not match its row.');
    }
    if (attempt.receipt.launchDigest !== attempt.admittedLaunchDigest) {
      throw new TypeError('Agent attempt receipt launch digest does not match its row.');
    }
  }
  if (attempt.lease !== null) {
    validateAgentSessionTurnLease(attempt.lease);
    if (
      attempt.lease.turnAttemptId !== attempt.turnAttemptId
      || attempt.lease.launchDigest !== attempt.admittedLaunchDigest
    ) throw new TypeError('Agent attempt lease does not match its row.');
  }
  if (attempt.state === 'running') {
    if (!attempt.admittedLaunch || !attempt.lease || attempt.receipt !== null) {
      throw new TypeError('Running Agent attempt is incomplete.');
    }
  }
  if (attempt.state === 'retryable') {
    if (!attempt.retryKind || attempt.lease) {
      throw new TypeError('Retryable Agent attempt is incomplete.');
    }
  }
  if (attempt.state === 'committed' && !attempt.receipt) {
    throw new TypeError('Committed Agent attempt lacks a receipt.');
  }
  if (attempt.state === 'state_uncertain') {
    if (
      attempt.terminalReason !== 'attempt_state_lost'
      || attempt.writeSettlement !== 'unsafe'
      || attempt.receipt !== null
      || attempt.retryKind !== null
      || attempt.lease !== null
      || attempt.artifactContinuationControl !== null
    ) throw new TypeError('Uncertain Agent attempt must retain only unsafe non-resumable evidence.');
  }
  if (attempt.state === 'terminal_non_retryable' && attempt.terminalReason === 'abandoned') {
    if (
      attempt.writeSettlement !== 'unsafe'
      || attempt.receipt !== null
      || attempt.retryKind !== null
      || attempt.lease !== null
      || attempt.artifactContinuationControl !== null
    ) throw new TypeError('Abandoned Agent attempt must retain only unsafe uncertainty evidence.');
  } else if (attempt.state === 'terminal_non_retryable' && attempt.lease) {
    throw new TypeError('Terminal Agent attempt cannot retain a lease.');
  }
  assertTimestamp(attempt.updatedAt, 'Agent attempt update time');
}

async function verifyAgentAttemptRowIdentity(attempt: AgentAttemptRow): Promise<void> {
  const launch = attempt.admittedLaunch;
  if (!launch) throw new TypeError('Agent attempt must retain its admitted launch.');
  const [launchDigest, storageId] = await Promise.all([
    digestAgentSessionLaunch(launch),
    agentAttemptStorageId(attempt.sessionId, attempt.turnAttemptId),
    Promise.all(attempt.artifactCoverage.map(verifyAgentArtifactCoverageRecord)),
  ]);
  if (launchDigest !== attempt.admittedLaunchDigest || storageId !== attempt.id) {
    throw new TypeError('Agent attempt immutable identity is inconsistent.');
  }
}

async function validateAgentAttemptRowIdentity(attempt: AgentAttemptRow): Promise<void> {
  validateAgentAttemptRow(attempt);
  await Dexie.waitFor(verifyAgentAttemptRowIdentity(attempt));
}

async function validateSessionAttemptRows(
  sessionId: string,
  attempts: readonly AgentAttemptRow[],
): Promise<void> {
  try {
    for (const attempt of attempts) validateAgentAttemptRow(attempt, sessionId);
    await Dexie.waitFor(Promise.all(attempts.map((attempt) => verifyAgentAttemptRowIdentity(attempt))));
    for (const attempt of attempts) {
      if (
        attempt.state === 'state_uncertain'
        || (attempt.state === 'terminal_non_retryable' && attempt.terminalReason === 'abandoned')
      ) await assertNoAgentAttemptRecovery(attempt);
    }
  } catch (error) {
    if (error instanceof AgentAttemptCorruptionError) throw error;
    throw new AgentAttemptCorruptionError(sessionId, errorMessage(error), { cause: error });
  }
}

async function putAgentAttempt(
  previous: AgentAttemptRow | undefined,
  next: AgentAttemptRow,
  now: number,
): Promise<void> {
  await validateAgentAttemptRowIdentity(next);
  if (previous) {
    await validateAgentAttemptRowIdentity(previous);
    await accountAgentAttemptUpdated(previous, next, now);
  } else {
    await accountAgentAttemptCreated(next, now);
  }
  await db.agentAttempts.put(next);
}

async function putAgentAttemptRecovery(
  attempt: AgentAttemptRow,
  previous: AgentAttemptRecoveryRow | undefined,
  next: AgentAttemptRecoveryRow,
  now: number,
): Promise<void> {
  validateAgentAttemptRecoveryRecord(next);
  if (
    next.id !== attempt.id
    || next.sessionId !== attempt.sessionId
    || next.turnAttemptId !== attempt.turnAttemptId
  ) throw new TypeError('Agent attempt recovery identity does not match its parent attempt.');
  if (previous) {
    validateAgentAttemptRecoveryRecord(previous);
    if (
      previous.id !== next.id
      || previous.sessionId !== attempt.sessionId
      || previous.turnAttemptId !== attempt.turnAttemptId
    ) throw new TypeError('Agent attempt recovery identity does not match its parent attempt.');
    await accountAgentAttemptRecoveryUpdated(previous, next, now);
  } else {
    await accountAgentAttemptRecoveryCreated(next, now);
  }
  await db.agentAttemptRecoveries.put(next);
}

async function deleteAgentAttemptRecovery(
  recovery: AgentAttemptRecoveryRow,
  now: number,
  allowCorrupt = false,
): Promise<void> {
  if (!allowCorrupt) validateAgentAttemptRecoveryRecord(recovery);
  await accountAgentAttemptRecoveryDeleted(recovery, now);
  await db.agentAttemptRecoveries.delete(recovery.id);
}

async function deleteAgentAttemptRecoveriesForAttempt(
  attempt: AgentAttemptRow,
  now: number,
  allowCorrupt = false,
): Promise<void> {
  const [exactRecoveries, recoveryById] = await Promise.all([
    db.agentAttemptRecoveries
      .where('[sessionId+turnAttemptId]')
      .equals([attempt.sessionId, attempt.turnAttemptId])
      .toArray(),
    db.agentAttemptRecoveries.get(attempt.id),
  ]);
  const recoveries = new Map<string, AgentAttemptRecoveryRow>();
  for (const recovery of exactRecoveries) recoveries.set(recovery.id, recovery);
  if (recoveryById) recoveries.set(recoveryById.id, recoveryById);
  for (const recovery of recoveries.values()) {
    await deleteAgentAttemptRecovery(recovery, now, allowCorrupt);
  }
}

async function discardAgentAttemptRecoveriesForAttempt(
  attempt: AgentAttemptRow,
): Promise<void> {
  const [exactRecoveries, recoveryById] = await Promise.all([
    db.agentAttemptRecoveries
      .where('[sessionId+turnAttemptId]')
      .equals([attempt.sessionId, attempt.turnAttemptId])
      .toArray(),
    db.agentAttemptRecoveries.get(attempt.id),
  ]);
  const recoveryIds = new Set<string>();
  for (const recovery of exactRecoveries) recoveryIds.add(recovery.id);
  if (recoveryById) recoveryIds.add(recoveryById.id);
  for (const recoveryId of recoveryIds) {
    await db.agentAttemptRecoveries.delete(recoveryId);
  }
}

/** Caller owns a transaction including agentAttempts, agentAttemptRecoveries, and agentStorageUsage. */
async function pruneSettledAgentAttempts(
  sessionId: string,
  now: number,
  preserveAttemptIds: readonly string[] = [],
): Promise<void> {
  const protectedIds = new Set(preserveAttemptIds);
  const attemptCount = await db.agentAttempts.where('sessionId').equals(sessionId).count();
  if (attemptCount <= AGENT_SESSION_RECENT_ATTEMPT_LIMIT + protectedIds.size) return;
  const settled: AgentAttemptRow[] = [];
  for (const attempt of await readAgentAttemptRows(sessionId)) {
    try {
      await validateAgentAttemptRowIdentity(attempt);
    } catch {
      // Damaged rows are user-recoverable evidence, never auto-prune them.
      continue;
    }
    if (
      (attempt.state === 'committed' || attempt.state === 'terminal_non_retryable')
      && !protectedIds.has(attempt.turnAttemptId)
    ) settled.push(attempt);
  }
  settled.sort((left, right) => (
    (right.receipt?.appliedRevision ?? -1) - (left.receipt?.appliedRevision ?? -1)
    || right.updatedAt - left.updatedAt
  ));
  for (const attempt of settled.slice(AGENT_SESSION_RECENT_ATTEMPT_LIMIT)) {
    await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
    await accountAgentAttemptDeleted(attempt, now);
    await db.agentAttempts.delete(attempt.id);
  }
}

async function recentAttemptReceipts(
  sessionId: string,
): Promise<AgentSessionAppliedTurnReceipt[]> {
  const receipts: AgentSessionAppliedTurnReceipt[] = [];
  for (const attempt of await readAgentAttemptRows(sessionId)) {
    try {
      await validateAgentAttemptRowIdentity(attempt);
      if (attempt.receipt) receipts.push(cloneAttemptReceipt(attempt.receipt));
    } catch {
      // Transcript hydration is intentionally independent from attempt damage.
    }
  }
  return receipts
    .sort((left, right) => left.appliedRevision - right.appliedRevision)
    .slice(-AGENT_SESSION_RECENT_ATTEMPT_LIMIT);
}

const AGENT_ATTEMPT_TERMINAL_REASONS: Record<AgentAttemptTerminalReason, true> = {
  final_answer: true,
  approval_required: true,
  interaction_required: true,
  protocol_error: true,
  step_budget_reached: true,
  context_limit: true,
  provider_error: true,
  attempt_state_lost: true,
  aborted: true,
  retried: true,
  superseded: true,
  dismissed: true,
  abandoned: true,
};

export class AgentSessionNotFoundError extends Error {
  readonly code = 'agent_session_not_found';

  constructor(readonly sessionId: string) {
    super(`Agent session ${sessionId} does not exist.`);
    this.name = 'AgentSessionNotFoundError';
  }
}

export class AgentSessionRevisionConflictError extends Error {
  readonly code = 'agent_session_revision_conflict';

  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Agent session ${sessionId} revision changed from ${expectedRevision} to ${actualRevision}.`,
    );
    this.name = 'AgentSessionRevisionConflictError';
  }
}

export class AgentSessionAttemptConflictError extends Error {
  readonly code = 'agent_session_attempt_conflict';

  constructor(readonly sessionId: string, readonly turnAttemptId: string) {
    super(`Agent turn attempt ${turnAttemptId} was reused with a different payload.`);
    this.name = 'AgentSessionAttemptConflictError';
  }
}

export class AgentSessionCorruptionError extends Error {
  readonly code = 'agent_session_corrupt';

  constructor(readonly sessionId: string, message: string, options?: ErrorOptions) {
    super(`Agent session ${sessionId} is corrupt: ${message}`, options);
    this.name = 'AgentSessionCorruptionError';
  }
}

export class AgentAttemptCorruptionError extends Error {
  readonly code = 'agent_attempt_corrupt';

  constructor(readonly sessionId: string, message: string, options?: ErrorOptions) {
    super(`Agent attempt for session ${sessionId} is corrupt: ${message}`, options);
    this.name = 'AgentAttemptCorruptionError';
  }
}

export class AgentSessionDeletionBlockedError extends Error {
  readonly code = 'agent_session_deletion_blocked';

  constructor(readonly sessionId: string, readonly jobId: string) {
    super(`Agent session ${sessionId} has active organize job ${jobId}; cancel or discard it first.`);
    this.name = 'AgentSessionDeletionBlockedError';
  }
}

export class AgentSessionTurnActiveError extends Error {
  readonly code = 'agent_session_turn_active';

  constructor(readonly sessionId: string, readonly turnAttemptId: string) {
    super(`Agent session ${sessionId} has active turn ${turnAttemptId}.`);
    this.name = 'AgentSessionTurnActiveError';
  }
}

export class AgentSessionTurnLeaseMismatchError extends Error {
  readonly code = 'agent_session_turn_lease_mismatch';

  constructor(readonly sessionId: string, readonly turnAttemptId: string) {
    super(`Agent turn ${turnAttemptId} no longer owns the durable session lease.`);
    this.name = 'AgentSessionTurnLeaseMismatchError';
  }
}

type AgentSessionCreationOptions = Readonly<{
  idFactory?: () => string;
  now?: () => number;
}>;

export async function createAgentSession(
  options: AgentSessionCreationOptions = {},
): Promise<LoadedAgentSession> {
  const { record, now } = createAgentSessionRecord(options);
  return runAgentSessionCreationWithCleanup(() => db.transaction(
    'rw',
    [db.agentSessions, db.agentAttempts, db.agentMessages, db.agentStorageUsage],
    async () => {
      const existing = await db.agentSessions.get(record.id);
      if (existing) {
        validateTransportSessionRecord(existing);
        return transportLoadedFromRecord(existing, await readTranscriptPage(existing));
      }
      await db.agentSessions.add(record);
      await accountAgentSessionCreated(record, now);
      return transportLoadedFromRecord(record, emptyTranscriptPage(record.id));
    },
  ));
}

/**
 * Atomically returns the newest readable session or creates the first one.
 * This is the empty-catalog activation authority shared by every Agent page;
 * chrome.storage remains only a page bootstrap hint.
 */
export async function getOrCreateInitialAgentSession(
  options: AgentSessionCreationOptions = {},
): Promise<LoadedAgentSession> {
  const { record: candidate, now } = createAgentSessionRecord(options);
  return runAgentSessionCreationWithCleanup(() => db.transaction(
    'rw',
    [db.agentSessions, db.agentAttempts, db.agentMessages, db.agentStorageUsage],
    async () => {
      const readableRecords: AgentSessionRecord[] = [];
      for (const existing of await db.agentSessions.toArray()) {
        try {
          validateTransportSessionRecord(existing);
          readableRecords.push(existing);
        } catch (error) {
          if (!(error instanceof AgentSessionCorruptionError)) throw error;
        }
      }
      readableRecords.sort((left, right) => (
        right.updatedAt - left.updatedAt
        || right.createdAt - left.createdAt
        || left.id.localeCompare(right.id)
      ));
      for (const existing of readableRecords) {
        try {
          return await transportLoadedFromRecord(existing, await readTranscriptPage(existing));
        } catch (error) {
          if (!(error instanceof AgentSessionCorruptionError)) throw error;
        }
      }

      await db.agentSessions.add(candidate);
      await accountAgentSessionCreated(candidate, now);
      return transportLoadedFromRecord(candidate, emptyTranscriptPage(candidate.id));
    },
  ));
}

function createAgentSessionRecord(
  options: AgentSessionCreationOptions,
): Readonly<{ record: AgentSessionRecord; now: number }> {
  const now = (options.now ?? Date.now)();
  assertTimestamp(now, 'Agent session creation time');
  const requestedId = options.idFactory?.();
  if (requestedId !== undefined) {
    assertAgentTurnTransportIdentifier(requestedId, 'Agent session ID');
  }
  const session = createBgsmAgentSession(
    requestedId === undefined ? undefined : () => requestedId,
  );
  assertAgentTurnTransportIdentifier(session.id, 'Agent session ID');
  return {
    now,
    record: {
      id: session.id,
      schemaVersion: AGENT_SESSION_SCHEMA_VERSION,
      title: '',
      revision: session.revision,
      lastSequence: 0,
      binding: null,
      compactionCheckpoint: null,
      activeProjections: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function runAgentSessionCreationWithCleanup(
  createOnce: () => Promise<LoadedAgentSession>,
): Promise<LoadedAgentSession> {
  await ensureAgentStorageUsage();
  try {
    return await createOnce();
  } catch (error) {
    if (!isRecoverableStorageError(error)) throw error;
    const cleanup = await cleanupAgentToolCache({ targetTotalBytes: 0 });
    if (cleanup.freedBytes === 0) throw error;
    return createOnce();
  }
}

/**
 * Returns valid headers and reports malformed rows separately so one damaged
 * conversation cannot prevent the session menu from opening.
 */
export async function inspectAgentSessionCatalog(): Promise<AgentSessionCatalogInspection> {
  const records = await db.agentSessions.toArray();
  const summaries: BgsmAgentSessionSummary[] = [];
  const corruptions: Array<{ sessionId: string | null; message: string }> = [];
  for (const record of records) {
    try {
      validateAgentSessionRecord(record);
      summaries.push(toSummary(record));
    } catch (error) {
      corruptions.push({
        sessionId: typeof record?.id === 'string' ? record.id : null,
        message: errorMessage(error),
      });
    }
  }
  summaries.sort((left, right) => (
    right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id)
  ));
  return { summaries, corruptions };
}

export async function listAgentSessionSummaries(): Promise<BgsmAgentSessionSummary[]> {
  return [...(await inspectAgentSessionCatalog()).summaries];
}

export async function loadAgentSession(sessionId: string): Promise<LoadedAgentSession> {
  assertAgentTurnTransportIdentifier(sessionId, 'Agent session ID');
  return db.transaction('r', [db.agentSessions, db.agentAttempts, db.agentMessages], async () => {
    const record = await db.agentSessions.get(sessionId);
    if (!record) throw new AgentSessionNotFoundError(sessionId);
    validateTransportSessionRecord(record);
    return transportLoadedFromRecord(record, await readTranscriptPage(record));
  });
}

/** Full canonical history is available only to the background turn runtime. */
export async function loadCanonicalAgentSession(
  sessionId: string,
  cache?: AgentCanonicalSessionCache,
): Promise<BgsmAgentSession> {
  assertAgentTurnTransportIdentifier(sessionId, 'Agent session ID');
  const loaded = await db.transaction('r', db.agentSessions, db.agentMessages, async () => {
    const record = await db.agentSessions.get(sessionId);
    if (!record) throw new AgentSessionNotFoundError(sessionId);
    // The header is the cross-worker revision fence. Never trust memory before
    // validating the authoritative row that names the cached revision.
    validateTransportSessionRecord(record);
    const cached = cache?.get(sessionId, record.revision);
    if (cached) return { session: cached, cacheCandidate: false };
    const rows = await db.agentMessages.where('sessionId').equals(sessionId).sortBy('sequence');
    const reconstructed = reconstructCanonicalSession(record, rows).session;
    return { session: reconstructed, cacheCandidate: true };
  });
  const callerSnapshot = cloneSession(loaded.session);
  if (loaded.cacheCandidate) cache?.put(loaded.session);
  return callerSnapshot;
}

export async function loadAgentSessionTranscriptPage(
  sessionId: string,
  beforeSequence?: number,
): Promise<AgentSessionTranscriptPage> {
  assertAgentTurnTransportIdentifier(sessionId, 'Agent session ID');
  if (beforeSequence !== undefined) {
    assertPositiveSafeInteger(beforeSequence, 'Agent transcript cursor');
  }
  return db.transaction('r', db.agentSessions, db.agentMessages, async () => {
    const record = await db.agentSessions.get(sessionId);
    if (!record) throw new AgentSessionNotFoundError(sessionId);
    validateTransportSessionRecord(record);
    if (beforeSequence !== undefined && beforeSequence > record.lastSequence + 1) {
      throw new TypeError('Agent transcript cursor is outside the canonical history.');
    }
    return readTranscriptPage(record, beforeSequence);
  });
}

export type AgentDurableTurnInspection = Readonly<{
  executionEpochId: string;
  launch: AgentSessionLaunchIdentity;
  artifactCoverage: readonly AgentArtifactCoverageRecord[];
  artifactContinuation: AgentArtifactContinuationCheckpoint | null;
}>;

/**
 * A replacement worker resumes only a statically read-only running attempt.
 * Every other interrupted authority becomes state_uncertain before returning.
 */
export async function inspectDurableAgentSessionTurn(
  sessionId: string,
  executionEpochId: string,
): Promise<AgentDurableTurnInspection | null> {
  assertAgentTurnTransportIdentifier(sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(executionEpochId, 'Agent worker execution epoch');
  await ensureAgentStorageUsage();
  let recoveryError: AgentAttemptCorruptionError | null = null;
  const inspection = await db.transaction('rw', [
    db.agentSessions,
    db.agentAttempts,
    db.agentArtifacts,
    db.agentAttemptRecoveries,
    db.agentArtifactChunks,
    db.agentStorageUsage,
  ], async () => {
    const record = await db.agentSessions.get(sessionId);
    if (!record) return null;
    validateAgentSessionRecord(record);
    const attempts = await readAgentAttemptRows(sessionId);
    await validateSessionAttemptRows(sessionId, attempts);
    const recoverable = attempts.filter((attempt) => (
      attempt.state === 'running' || attempt.state === 'stop_pending'
    ));
    if (recoverable.length > 1) {
      throw new AgentAttemptCorruptionError(sessionId, 'multiple recoverable attempts exist.');
    }
    const attempt = recoverable[0];
    if (!attempt) return null;
    const now = Date.now();
    if (attempt.state === 'running' && attempt.recoveryClass === 'statically_read_only') {
      let recoveredContinuation: AgentArtifactContinuationCheckpoint | null;
      try {
        recoveredContinuation = await loadAgentAttemptContinuation(attempt);
      } catch (error) {
        recoveryError = new AgentAttemptCorruptionError(sessionId, errorMessage(error), { cause: error });
        await quarantineAgentAttemptRecovery(attempt, now);
        return null;
      }
      const baseRevision = attempt.lease?.baseRevision ?? attempt.admittedLaunch.baseRevision;
      await putAgentAttempt(attempt, {
        ...attempt,
        lease: {
          executionEpochId,
          turnAttemptId: attempt.turnAttemptId,
          baseRevision,
          launchDigest: attempt.admittedLaunchDigest,
          acquiredAt: now,
        },
        updatedAt: Math.max(now, attempt.updatedAt),
      }, now);
      return {
        executionEpochId,
        launch: cloneValue(attempt.admittedLaunch),
        artifactCoverage: attempt.artifactCoverage.map((coverage) => cloneValue(coverage)),
        artifactContinuation: recoveredContinuation
          ? cloneValue(recoveredContinuation)
          : null,
      };
    }
    const artifactCoverage = await Dexie.waitFor(Promise.all(
      attempt.artifactCoverage.map((coverage) => settleAgentArtifactCoverageIncomplete(
        coverage,
        'attempt_state_lost',
      )),
    ));
    await discardUnboundAgentArtifactsInCurrentTransaction({
      artifactIds: artifactCoverage.map((coverage) => coverage.artifactId),
      sessionId,
      turnAttemptId: attempt.turnAttemptId,
    }, now);
    await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
    await putAgentAttempt(attempt, {
      ...attempt,
      state: 'state_uncertain',
      terminalReason: 'attempt_state_lost',
      retryKind: null,
      writeSettlement: 'unsafe',
      artifactCoverage,
      artifactContinuationControl: null,
      lease: null,
      updatedAt: Math.max(now, attempt.updatedAt),
    }, now);
    return null;
  });
  if (recoveryError) throw recoveryError;
  return inspection;
}

export async function readAgentSessionRetryDraftCandidate(
  sessionId: string,
): Promise<AgentSessionRetryDraft | null> {
  assertAgentTurnTransportIdentifier(sessionId, 'Agent session ID');
  return db.transaction('r', [db.agentSessions, db.agentAttempts, db.agentAttemptRecoveries], async () => {
    const record = await db.agentSessions.get(sessionId);
    if (!record) return null;
    validateAgentSessionRecord(record);
    const attempts = await readAgentAttemptRows(sessionId);
    await validateSessionAttemptRows(sessionId, attempts);
    const drafts: Array<{ draft: AgentSessionRetryDraft }> = [];
    for (const attempt of attempts) {
      const draft = retryDraftFromAttemptRow(attempt);
      if (!draft) continue;
      await assertNoAgentAttemptRecovery(attempt);
      drafts.push({ draft });
    }
    return drafts
      .sort((left, right) => right.draft.updatedAt - left.draft.updatedAt)[0]?.draft ?? null;
  });
}


/**
 * Admission, explicit retry settlement, and replay lookup share one write
 * transaction. A new retry always consumes the exact prior retry authority;
 * a fresh prompt supersedes any unconsumed retry authority in the same commit.
 */
export async function admitAgentSessionTurn(input: Readonly<{
  sessionId: string;
  baseRevision: number;
  turnAttemptId: string;
  executionEpochId: string;
  launchDigest: AgentSessionLaunchDigest;
  launch: AgentSessionLaunchIdentity;
  recoveryClass?: AgentAttemptRecord['recoveryClass'];
  now?: () => number;
}>): Promise<AgentSessionTurnAdmission> {
  validateTurnAdmissionInput(input);
  if (await digestAgentSessionLaunch(input.launch) !== input.launchDigest) {
    throw new AgentSessionAttemptConflictError(input.sessionId, input.turnAttemptId);
  }
  if (
    input.recoveryClass !== undefined
    && input.recoveryClass !== 'statically_read_only'
    && input.recoveryClass !== 'write_capable_or_unknown'
  ) throw new TypeError('Agent attempt recovery class is invalid.');
  const acquiredAt = (input.now ?? Date.now)();
  assertTimestamp(acquiredAt, 'Agent turn lease acquisition time');
  const storageId = await agentAttemptStorageId(input.sessionId, input.turnAttemptId);
  await ensureAgentStorageUsage();
  return db.transaction(
    'rw',
    [db.agentSessions, db.agentAttempts, db.agentAttemptRecoveries, db.agentMessages, db.agentStorageUsage],
    async () => {
      const record = await db.agentSessions.get(input.sessionId);
      if (!record) throw new AgentSessionNotFoundError(input.sessionId);
      validateAgentSessionRecord(record);
      const exactExisting = await readAgentAttempt(input.sessionId, input.turnAttemptId);
      if (exactExisting) {
        await validateSessionAttemptRows(input.sessionId, [exactExisting]);
        if (
          exactExisting.admittedLaunchDigest !== input.launchDigest
          || canonicalJson(exactExisting.admittedLaunch) !== canonicalJson(input.launch)
        ) throw new AgentSessionAttemptConflictError(record.id, input.turnAttemptId);
        if (exactExisting.receipt) {
          const presentationRows = await readTurnPresentationRows(record, input.turnAttemptId);
          return {
            kind: 'replay',
            commit: await commitResultFromReceipt(
              record,
              presentationRows,
              toSummary(record),
              exactExisting.receipt,
              true,
            ),
          };
        }
      }
      const attempts = await readAgentAttemptRows(input.sessionId);
      await validateSessionAttemptRows(input.sessionId, attempts);
      const existing = attempts.find((attempt) => attempt.turnAttemptId === input.turnAttemptId);
      if (existing) {
        if (
          existing.admittedLaunchDigest !== input.launchDigest
          || canonicalJson(existing.admittedLaunch) !== canonicalJson(input.launch)
        ) throw new AgentSessionAttemptConflictError(record.id, input.turnAttemptId);
        if (existing.receipt) {
          const presentationRows = await readTurnPresentationRows(record, input.turnAttemptId);
          return {
            kind: 'replay',
            commit: await commitResultFromReceipt(
              record,
              presentationRows,
              toSummary(record),
              existing.receipt,
              true,
            ),
          };
        }
        if (existing.state !== 'running') {
          throw new AgentSessionAttemptConflictError(record.id, input.turnAttemptId);
        }
        if (
          existing.recoveryClass !== 'statically_read_only'
          && existing.lease?.executionEpochId !== input.executionEpochId
        ) throw new AgentSessionTurnLeaseMismatchError(record.id, input.turnAttemptId);
        const next: AgentAttemptRow = {
          ...existing,
          lease: {
            executionEpochId: input.executionEpochId,
            turnAttemptId: input.turnAttemptId,
            baseRevision: input.baseRevision,
            launchDigest: input.launchDigest,
            acquiredAt,
          },
          updatedAt: Math.max(acquiredAt, existing.updatedAt),
        };
        await putAgentAttempt(existing, next, acquiredAt);
        return { kind: 'acquired' };
      }
      if (record.revision !== input.baseRevision) {
        throw new AgentSessionRevisionConflictError(record.id, input.baseRevision, record.revision);
      }
      const active = attempts.find((attempt) => isAttemptActive(attempt));
      if (active) throw new AgentSessionTurnActiveError(record.id, active.turnAttemptId);
      const retrySourceId = input.launch.retrySourceAttemptId;
      if (retrySourceId) {
        const source = attempts.find((attempt) => attempt.turnAttemptId === retrySourceId);
        const sourceDraft = source ? retryDraftFromAttemptRow(source) : null;
        const competingSource = attempts.find((attempt) => (
          attempt.state === 'retryable' && attempt.turnAttemptId !== retrySourceId
        ));
        if (
          !source
          || !sourceDraft
          || source.state !== 'retryable'
          || sourceDraft.prompt !== input.launch.prompt
          || sourceDraft.baseRevision !== input.baseRevision
          || competingSource
        ) throw new AgentSessionAttemptConflictError(record.id, input.turnAttemptId);
        await assertNoAgentAttemptRecovery(source);
        await deleteAgentAttemptRecoveriesForAttempt(source, acquiredAt);
        await putAgentAttempt(source, {
          ...source,
          state: 'terminal_non_retryable',
          terminalReason: 'retried',
          retryKind: null,
          artifactContinuationControl: null,
          lease: null,
          updatedAt: Math.max(acquiredAt, source.updatedAt),
        }, acquiredAt);
      } else {
        for (const attempt of attempts) {
          if (attempt.state !== 'retryable') continue;
          await assertNoAgentAttemptRecovery(attempt);
          await deleteAgentAttemptRecoveriesForAttempt(attempt, acquiredAt);
          await putAgentAttempt(attempt, {
            ...attempt,
            state: 'terminal_non_retryable',
            terminalReason: 'superseded',
            retryKind: null,
            artifactContinuationControl: null,
            lease: null,
            updatedAt: Math.max(acquiredAt, attempt.updatedAt),
          }, acquiredAt);
        }
      }
      const next: AgentAttemptRow = {
        id: storageId,
        sessionId: input.sessionId,
        turnAttemptId: input.turnAttemptId,
        state: 'running',
        terminalReason: null,
        admittedLaunch: cloneValue(input.launch),
        admittedLaunchDigest: input.launchDigest,
        recoveryClass: input.recoveryClass ?? 'write_capable_or_unknown',
        retryKind: null,
        writeSettlement: null,
        receipt: null,
        artifactCoverage: [],
        artifactContinuationControl: null,
        lease: {
          executionEpochId: input.executionEpochId,
          turnAttemptId: input.turnAttemptId,
          baseRevision: input.baseRevision,
          launchDigest: input.launchDigest,
          acquiredAt,
        },
        updatedAt: acquiredAt,
      };
      await putAgentAttempt(undefined, next, acquiredAt);
      await pruneSettledAgentAttempts(input.sessionId, acquiredAt, [input.turnAttemptId]);
      return { kind: 'acquired' };
    },
  );
}

export type AgentArtifactCoverageCheckpointProposal = Readonly<
  | { kind: 'start'; record: AgentArtifactCoverageRecord }
  | { kind: 'evidence'; coverageId: string; evidence: AgentArtifactCoverageEvidence }
>;

export type AgentArtifactEnvelopeCheckpointInput = Readonly<{
  sessionId: string;
  turnAttemptId: string;
  launchDigest: AgentSessionLaunchDigest;
  executionEpochId: string;
  proposals: readonly AgentArtifactCoverageCheckpointProposal[];
  continuation: AgentArtifactContinuationCheckpoint | null;
  expectedNonProgressRepromptUsed?: boolean;
  now?: () => number;
}>;

export type AgentArtifactEnvelopeCheckpointResult = Readonly<{
  artifactCoverage: readonly AgentArtifactCoverageRecord[];
  artifactContinuation: AgentArtifactContinuationCheckpoint | null;
}>;

/** Persists a complete admitted assistant/tool envelope before it can be published. */
export async function checkpointAgentSessionArtifactEnvelope(
  input: AgentArtifactEnvelopeCheckpointInput,
): Promise<AgentArtifactEnvelopeCheckpointResult> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  assertAgentTurnTransportIdentifier(input.executionEpochId, 'Agent worker execution epoch');
  validateLaunchDigest(input.launchDigest);
  if (!Array.isArray(input.proposals)) throw new TypeError('Agent artifact coverage proposals must be an array.');
  if (input.continuation !== null) validateAgentArtifactContinuationCheckpoint(input.continuation);
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent artifact checkpoint time');
  await ensureAgentStorageUsage();
  return db.transaction(
    'rw',
    [
      db.agentSessions,
      db.agentAttempts,
      db.agentAttemptRecoveries,
      db.agentArtifacts,
      db.agentArtifactChunks,
      db.agentStorageUsage,
    ],
    async () => {
      const session = await db.agentSessions.get(input.sessionId);
      if (!session) throw new AgentSessionNotFoundError(input.sessionId);
      validateAgentSessionRecord(session);
      const attempt = await readAgentAttempt(input.sessionId, input.turnAttemptId);
      if (!attempt || attempt.admittedLaunchDigest !== input.launchDigest) {
        throw new AgentSessionAttemptConflictError(input.sessionId, input.turnAttemptId);
      }
      await validateAgentAttemptRowIdentity(attempt);
      if (
        attempt.state !== 'running'
        || !attempt.lease
        || attempt.lease.executionEpochId !== input.executionEpochId
        || attempt.lease.turnAttemptId !== input.turnAttemptId
        || attempt.lease.baseRevision !== session.revision
        || attempt.lease.launchDigest !== input.launchDigest
      ) throw new AgentSessionTurnLeaseMismatchError(input.sessionId, input.turnAttemptId);
      await loadAgentAttemptContinuation(attempt);
      const previousRecovery = await db.agentAttemptRecoveries.get(attempt.id);
      if (input.expectedNonProgressRepromptUsed !== undefined) {
        if (
          !attempt.artifactContinuationControl
          || attempt.artifactContinuationControl.nonProgressRepromptUsed
            !== input.expectedNonProgressRepromptUsed
        ) throw new AgentArtifactCoverageError('Agent artifact continuation re-prompt state changed.');
      }
      if (
        attempt.artifactContinuationControl?.nonProgressRepromptUsed
        && input.continuation !== null
        && !input.continuation.nonProgressRepromptUsed
      ) throw new AgentArtifactCoverageError('Agent artifact continuation re-prompt use cannot be reset.');

      let coverage = [...attempt.artifactCoverage];
      for (const proposal of input.proposals) {
        if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
          throw new TypeError('Agent artifact coverage proposal is malformed.');
        }
        const proposalKeys = proposal.kind === 'start'
          ? ['kind', 'record']
          : ['coverageId', 'evidence', 'kind'];
        if (!hasExactKeys(proposal as unknown as Record<string, unknown>, proposalKeys)) {
          throw new TypeError('Agent artifact coverage proposal has unexpected fields.');
        }
        if (proposal.kind === 'start') {
          await Dexie.waitFor(verifyAgentArtifactCoverageRecord(proposal.record));
          const expected = await Dexie.waitFor(createAgentArtifactCoverage({
            artifactId: proposal.record.artifactId,
            sourceToolCallId: proposal.record.sourceToolCallId,
            expectedBytes: proposal.record.expectedBytes,
            artifactSha256: proposal.record.artifactSha256,
            integrityManifestSha256: proposal.record.integrityManifestSha256,
          }));
          if (canonicalJson(expected) !== canonicalJson(proposal.record)) {
            throw new AgentArtifactCoverageError('Artifact coverage start is not canonical.');
          }
          const existing = coverage.find((record) => record.coverageId === proposal.record.coverageId);
          if (existing) {
            if (canonicalJson(existing) !== canonicalJson(proposal.record)) {
              throw new AgentArtifactCoverageError('Artifact coverage start conflicts with durable state.');
            }
            continue;
          }
          await validateAgentArtifactCoverageStartInCurrentTransaction({
            record: proposal.record,
            sessionId: input.sessionId,
            turnAttemptId: input.turnAttemptId,
          });
          coverage.push(cloneValue(proposal.record));
          validateAgentArtifactCoverageRecords(coverage);
          continue;
        }
        if (proposal.kind !== 'evidence') {
          throw new TypeError('Agent artifact coverage proposal kind is invalid.');
        }
        validateAgentArtifactCoverageEvidence(proposal.evidence);
        const record = coverage.find((candidate) => candidate.coverageId === proposal.coverageId);
        if (!record) {
          throw new AgentArtifactCoverageError('Artifact coverage evidence references an unknown obligation.');
        }
        const pending = coverage.find((candidate) => candidate.state === 'pending');
        if (!pending || pending.coverageId !== record.coverageId) {
          throw new AgentArtifactCoverageError('Artifact coverage evidence must follow source-admission order.');
        }
        await validateAgentArtifactCoverageEvidenceInCurrentTransaction({
          record,
          evidence: proposal.evidence,
          sessionId: input.sessionId,
          turnAttemptId: input.turnAttemptId,
        });
        const applied = await Dexie.waitFor(applyAgentArtifactCoverageEvidence(
          record,
          proposal.evidence,
        ));
        coverage = coverage.map((candidate) => (
          candidate.coverageId === record.coverageId ? applied.record : candidate
        ));
      }

      const directives = agentArtifactCoverageDirectives(coverage);
      if (directives.length > 0) {
        if (!input.continuation) {
          throw new AgentArtifactCoverageError('Pending artifact coverage requires a continuation checkpoint.');
        }
        if (canonicalJson(input.continuation.directives) !== canonicalJson(directives)) {
          throw new AgentArtifactCoverageError('Continuation directives do not match durable artifact coverage.');
        }
      } else if (input.continuation !== null) {
        throw new AgentArtifactCoverageError('Completed artifact coverage cannot retain a continuation checkpoint.');
      }
      const split = input.continuation
        ? splitAgentArtifactContinuation(input.continuation, {
            id: attempt.id,
            sessionId: attempt.sessionId,
            turnAttemptId: attempt.turnAttemptId,
          })
        : null;

      const next: AgentAttemptRow = {
        ...attempt,
        artifactCoverage: coverage.map((record) => cloneValue(record)),
        artifactContinuationControl: split?.control ?? null,
        updatedAt: Math.max(now, attempt.updatedAt),
      };
      await putAgentAttempt(attempt, next, now);
      if (split) {
        await putAgentAttemptRecovery(attempt, previousRecovery, split.recovery, now);
      } else {
        await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
      }
      return {
        artifactCoverage: next.artifactCoverage.map((record) => cloneValue(record)),
        artifactContinuation: input.continuation
          ? cloneValue(input.continuation)
          : null,
      };
    },
  );
}

export async function markAgentSessionArtifactRepromptUsed(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  launchDigest: AgentSessionLaunchDigest;
  executionEpochId: string;
  continuation: AgentArtifactContinuationCheckpoint;
  now?: () => number;
}>): Promise<AgentArtifactContinuationCheckpoint> {
  validateAgentArtifactContinuationCheckpoint(input.continuation);
  if (!input.continuation.nonProgressRepromptUsed) {
    throw new AgentArtifactCoverageError('Agent artifact continuation re-prompt checkpoint is not marked used.');
  }
  const checkpoint = await checkpointAgentSessionArtifactEnvelope({
    ...input,
    proposals: [],
    expectedNonProgressRepromptUsed: false,
  });
  if (!checkpoint.artifactContinuation) {
    throw new AgentArtifactCoverageError('Agent artifact continuation checkpoint was lost.');
  }
  return checkpoint.artifactContinuation;
}

export async function loadCommittedAgentSessionTurn(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  launchDigest: AgentSessionLaunchDigest;
}>): Promise<AgentSessionCommitResult | null> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  validateLaunchDigest(input.launchDigest);
  return db.transaction(
    'r',
    [db.agentSessions, db.agentAttempts, db.agentAttemptRecoveries, db.agentMessages],
    async () => {
      const record = await db.agentSessions.get(input.sessionId);
      if (!record) throw new AgentSessionNotFoundError(input.sessionId);
      validateTransportSessionRecord(record);
      const attempt = await readAgentAttempt(input.sessionId, input.turnAttemptId);
      if (!attempt) return null;
      await validateSessionAttemptRows(input.sessionId, [attempt]);
      if (!attempt.receipt) return null;
      assertMatchingLaunchDigest(record.id, attempt.receipt, input.launchDigest);
      const presentationRows = await readTurnPresentationRows(record, input.turnAttemptId);
      return commitResultFromReceipt(
        record,
        presentationRows,
        toSummary(record),
        attempt.receipt,
        true,
      );
    },
  );
}

export async function acquireAgentSessionTurnLease(input: Readonly<{
  sessionId: string;
  baseRevision: number;
  turnAttemptId: string;
  executionEpochId: string;
  launchDigest: AgentSessionLaunchDigest;
  now?: () => number;
}>): Promise<void> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertNonnegativeSafeInteger(input.baseRevision, 'Agent session base revision');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  assertAgentTurnTransportIdentifier(input.executionEpochId, 'Agent worker execution epoch');
  validateLaunchDigest(input.launchDigest);
  const acquiredAt = (input.now ?? Date.now)();
  assertTimestamp(acquiredAt, 'Agent turn lease acquisition time');
  await ensureAgentStorageUsage();
  await db.transaction('rw', [db.agentSessions, db.agentAttempts, db.agentAttemptRecoveries, db.agentStorageUsage], async () => {
    const record = await db.agentSessions.get(input.sessionId);
    if (!record) throw new AgentSessionNotFoundError(input.sessionId);
    validateAgentSessionRecord(record);
    if (record.revision !== input.baseRevision) {
      throw new AgentSessionRevisionConflictError(record.id, input.baseRevision, record.revision);
    }
    const attempts = await readAgentAttemptRows(input.sessionId);
    await validateSessionAttemptRows(input.sessionId, attempts);
    const attempt = attempts.find((row) => row.turnAttemptId === input.turnAttemptId);
    if (!attempt || attempt.admittedLaunchDigest !== input.launchDigest) {
      throw new AgentSessionAttemptConflictError(record.id, input.turnAttemptId);
    }
    const active = attempts.find((row) => row.turnAttemptId !== input.turnAttemptId && isAttemptActive(row));
    if (active) throw new AgentSessionTurnActiveError(record.id, active.turnAttemptId);
    if (attempt.state !== 'running') {
      throw new AgentSessionTurnLeaseMismatchError(record.id, input.turnAttemptId);
    }
    if (
      attempt.lease?.executionEpochId === input.executionEpochId
      && attempt.lease.baseRevision === input.baseRevision
      && attempt.lease.launchDigest === input.launchDigest
    ) return;
    await putAgentAttempt(attempt, {
      ...attempt,
      lease: {
        executionEpochId: input.executionEpochId,
        turnAttemptId: input.turnAttemptId,
        baseRevision: input.baseRevision,
        launchDigest: input.launchDigest,
        acquiredAt,
      },
      updatedAt: Math.max(acquiredAt, attempt.updatedAt),
    }, acquiredAt);
  });
}

export async function releaseAgentSessionTurnLease(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  executionEpochId: string;
}>): Promise<boolean> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  assertAgentTurnTransportIdentifier(input.executionEpochId, 'Agent worker execution epoch');
  await ensureAgentStorageUsage();
  return db.transaction('rw', [db.agentSessions, db.agentAttempts, db.agentAttemptRecoveries, db.agentStorageUsage], async () => {
    const record = await db.agentSessions.get(input.sessionId);
    if (!record) return false;
    validateAgentSessionRecord(record);
    const attempt = await readAgentAttempt(input.sessionId, input.turnAttemptId);
    if (!attempt) return false;
    await validateSessionAttemptRows(input.sessionId, [attempt]);
    if (attempt.receipt || !attempt.lease) return true;
    // Port acknowledgement controls delivery retention only. A terminal runner
    // must settle its own attempt before the transport drops its in-memory copy.
    return false;
  });
}

/**
 * Fences rollback to the exact read-only lease claimed by this worker epoch.
 * A failed in-memory restore cannot leave that durable attempt runnable.
 */
export async function rollbackClaimedAgentSessionTurnRecovery(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  executionEpochId: string;
  launchDigest: AgentSessionLaunchDigest;
  now?: () => number;
}>): Promise<boolean> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  assertAgentTurnTransportIdentifier(input.executionEpochId, 'Agent worker execution epoch');
  validateLaunchDigest(input.launchDigest);
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent recovery rollback time');
  await ensureAgentStorageUsage();
  return db.transaction('rw', [
    db.agentSessions,
    db.agentAttempts,
    db.agentAttemptRecoveries,
    db.agentArtifacts,
    db.agentArtifactChunks,
    db.agentStorageUsage,
  ], async () => {
    const record = await db.agentSessions.get(input.sessionId);
    if (!record) return false;
    validateAgentSessionRecord(record);
    const attempts = await readAgentAttemptRows(input.sessionId);
    await validateSessionAttemptRows(input.sessionId, attempts);
    const attempt = attempts.find((candidate) => candidate.turnAttemptId === input.turnAttemptId);
    if (
      !attempt
      || attempt.receipt
      || attempt.state !== 'running'
      || attempt.recoveryClass !== 'statically_read_only'
      || attempt.admittedLaunchDigest !== input.launchDigest
      || !attempt.lease
      || attempt.lease.executionEpochId !== input.executionEpochId
      || attempt.lease.turnAttemptId !== input.turnAttemptId
      || attempt.lease.baseRevision !== attempt.admittedLaunch.baseRevision
      || attempt.lease.launchDigest !== input.launchDigest
    ) return false;
    const artifactCoverage = await Dexie.waitFor(Promise.all(
      attempt.artifactCoverage.map((coverage) => settleAgentArtifactCoverageIncomplete(
        coverage,
        'attempt_state_lost',
      )),
    ));
    await discardUnboundAgentArtifactsInCurrentTransaction({
      artifactIds: artifactCoverage.map((coverage) => coverage.artifactId),
      sessionId: input.sessionId,
      turnAttemptId: input.turnAttemptId,
    }, now);
    await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
    await putAgentAttempt(attempt, {
      ...attempt,
      state: 'state_uncertain',
      terminalReason: 'attempt_state_lost',
      retryKind: null,
      writeSettlement: 'unsafe',
      artifactCoverage,
      artifactContinuationControl: null,
      lease: null,
      updatedAt: Math.max(now, attempt.updatedAt),
    }, now);
    return true;
  });
}

function retryKindForOutcome(outcome: AgentSessionTerminalOutcome): AgentSessionRetryKind {
  if (outcome.reason === 'aborted') return 'stopped';
  return outcome.reason === 'context_limit' || outcome.contextFailureReason
    ? 'context_limit'
    : 'failed';
}

function canRetryAttemptOutcome(outcome: AgentSessionTerminalOutcome): boolean {
  return outcome.reason !== 'final_answer'
    && outcome.reason !== 'attempt_state_lost'
    && outcome.writeSettlement !== 'unsafe';
}

export type AgentAttemptTerminalSettlementInput = Readonly<{
  sessionId: string;
  turnAttemptId: string;
  launchDigest: AgentSessionLaunchDigest;
  outcome: AgentSessionTerminalOutcome;
  coverageFailureCode?: string;
  executionEpochId?: string;
  now?: () => number;
}>;

/** Settles preflight, provider, abort, and transport-independent failures. */
export async function settleAgentSessionAttemptWithoutTransition(
  input: AgentAttemptTerminalSettlementInput,
): Promise<void> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  if (input.executionEpochId !== undefined) {
    assertAgentTurnTransportIdentifier(input.executionEpochId, 'Agent worker execution epoch');
  }
  validateLaunchDigest(input.launchDigest);
  validateTerminalOutcome(input.outcome);
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent attempt settlement time');
  await ensureAgentStorageUsage();
  await db.transaction('rw', [
    db.agentSessions,
    db.agentAttempts,
    db.agentAttemptRecoveries,
    db.agentArtifacts,
    db.agentArtifactChunks,
    db.agentStorageUsage,
  ], async () => {
    const record = await db.agentSessions.get(input.sessionId);
    if (!record) throw new AgentSessionNotFoundError(input.sessionId);
    validateAgentSessionRecord(record);
    const attempts = await readAgentAttemptRows(input.sessionId);
    await validateSessionAttemptRows(input.sessionId, attempts);
    const attempt = attempts.find((candidate) => candidate.turnAttemptId === input.turnAttemptId);
    if (!attempt || attempt.admittedLaunchDigest !== input.launchDigest) {
      throw new AgentSessionAttemptConflictError(input.sessionId, input.turnAttemptId);
    }
    if (attempt.receipt || attempt.state === 'retryable' || attempt.state === 'terminal_non_retryable') {
      await assertNoAgentAttemptRecovery(attempt);
      await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
      return;
    }
    if (attempt.state === 'state_uncertain') {
      await assertNoAgentAttemptRecovery(attempt);
      await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
      return;
    }
    if (
      input.executionEpochId !== undefined
      && attempt.lease !== null
      && attempt.lease.executionEpochId !== input.executionEpochId
    ) throw new AgentSessionTurnLeaseMismatchError(input.sessionId, input.turnAttemptId);
    if (attempt.state === 'running' && input.executionEpochId !== undefined && !attempt.lease) {
      throw new AgentSessionTurnLeaseMismatchError(input.sessionId, input.turnAttemptId);
    }
    const retryable = canRetryAttemptOutcome(input.outcome);
    const artifactCoverage = await Dexie.waitFor(Promise.all(
      attempt.artifactCoverage.map((coverage) => settleAgentArtifactCoverageIncomplete(
        coverage,
        input.coverageFailureCode ?? input.outcome.reason,
      )),
    ));
    await discardUnboundAgentArtifactsInCurrentTransaction({
      artifactIds: artifactCoverage.map((coverage) => coverage.artifactId),
      sessionId: input.sessionId,
      turnAttemptId: input.turnAttemptId,
    }, now);
    await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
    await putAgentAttempt(attempt, {
      ...attempt,
      state: retryable ? 'retryable' : 'terminal_non_retryable',
      terminalReason: retryable ? null : input.outcome.reason,
      retryKind: retryable ? retryKindForOutcome(input.outcome) : null,
      writeSettlement: input.outcome.writeSettlement,
      artifactCoverage,
      artifactContinuationControl: null,
      lease: null,
      updatedAt: Math.max(now, attempt.updatedAt),
    }, now);
    await pruneSettledAgentAttempts(input.sessionId, now, [input.turnAttemptId]);
  });
}

/** Marks an interrupted write-capable attempt as explicitly non-resumable. */
export async function markAgentSessionAttemptStateUncertain(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  executionEpochId?: string;
  now?: () => number;
}>): Promise<boolean> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  if (input.executionEpochId !== undefined) {
    assertAgentTurnTransportIdentifier(input.executionEpochId, 'Agent worker execution epoch');
  }
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent attempt uncertainty time');
  await ensureAgentStorageUsage();
  return db.transaction('rw', [
    db.agentSessions,
    db.agentAttempts,
    db.agentAttemptRecoveries,
    db.agentArtifacts,
    db.agentArtifactChunks,
    db.agentStorageUsage,
  ], async () => {
    const record = await db.agentSessions.get(input.sessionId);
    if (!record) return false;
    validateAgentSessionRecord(record);
    const attempts = await readAgentAttemptRows(input.sessionId);
    await validateSessionAttemptRows(input.sessionId, attempts);
    const attempt = attempts.find((candidate) => candidate.turnAttemptId === input.turnAttemptId);
    if (!attempt || attempt.receipt) return false;
    if (
      input.executionEpochId !== undefined
      && attempt.lease !== null
      && attempt.lease.executionEpochId !== input.executionEpochId
    ) return false;
    if (attempt.state === 'state_uncertain') {
      await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
      return true;
    }
    if (attempt.state !== 'running' && attempt.state !== 'stop_pending') return false;
    const artifactCoverage = await Dexie.waitFor(Promise.all(
      attempt.artifactCoverage.map((coverage) => settleAgentArtifactCoverageIncomplete(
        coverage,
        'attempt_state_lost',
      )),
    ));
    await discardUnboundAgentArtifactsInCurrentTransaction({
      artifactIds: artifactCoverage.map((coverage) => coverage.artifactId),
      sessionId: input.sessionId,
      turnAttemptId: input.turnAttemptId,
    }, now);
    await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
    await putAgentAttempt(attempt, {
      ...attempt,
      state: 'state_uncertain',
      terminalReason: 'attempt_state_lost',
      retryKind: null,
      writeSettlement: 'unsafe',
      artifactCoverage,
      artifactContinuationControl: null,
      lease: null,
      updatedAt: Math.max(now, attempt.updatedAt),
    }, now);
    return true;
  });
}

/** Dismiss is an explicit background command; it never edits the admitted launch. */
export async function dismissAgentSessionAttemptRetry(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  now?: () => number;
}>): Promise<boolean> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent retry dismissal time');
  await ensureAgentStorageUsage();
  return db.transaction('rw', [db.agentSessions, db.agentAttempts, db.agentAttemptRecoveries, db.agentStorageUsage], async () => {
    const record = await db.agentSessions.get(input.sessionId);
    if (!record) return false;
    validateAgentSessionRecord(record);
    const attempts = await readAgentAttemptRows(input.sessionId);
    await validateSessionAttemptRows(input.sessionId, attempts);
    const attempt = attempts.find((candidate) => candidate.turnAttemptId === input.turnAttemptId);
    if (!attempt || attempt.state !== 'retryable') return false;
    await assertNoAgentAttemptRecovery(attempt);
    await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
    await putAgentAttempt(attempt, {
      ...attempt,
      state: 'terminal_non_retryable',
      terminalReason: 'dismissed',
      retryKind: null,
      lease: null,
      artifactContinuationControl: null,
      updatedAt: Math.max(now, attempt.updatedAt),
    }, now);
    await pruneSettledAgentAttempts(input.sessionId, now, [input.turnAttemptId]);
    return true;
  });
}

/**
 * Explicitly abandons one state-uncertain attempt without rewriting its launch
 * identity or making any claim about whether an interrupted write succeeded.
 */
export async function abandonAgentSessionUncertainAttempt(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  now?: () => number;
}>): Promise<boolean> {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent uncertain attempt abandonment time');
  await ensureAgentStorageUsage();
  return db.transaction(
    'rw',
    [
      db.agentSessions,
      db.agentAttempts,
      db.agentAttemptRecoveries,
      db.agentArtifacts,
      db.agentArtifactChunks,
      db.agentStorageUsage,
    ],
    async () => {
      const record = await db.agentSessions.get(input.sessionId);
      if (!record) return false;
      validateAgentSessionRecord(record);
      const attempts = await readAgentAttemptRows(input.sessionId);
      await validateSessionAttemptRows(input.sessionId, attempts);
      const attempt = attempts.find((candidate) => candidate.turnAttemptId === input.turnAttemptId);
      if (!attempt || attempt.state !== 'state_uncertain') return false;
      await discardUnboundAgentArtifactsInCurrentTransaction({
        artifactIds: attempt.artifactCoverage.map((coverage) => coverage.artifactId),
        sessionId: attempt.sessionId,
        turnAttemptId: attempt.turnAttemptId,
      }, now);
      await deleteAgentAttemptRecoveriesForAttempt(attempt, now);
      await putAgentAttempt(attempt, {
        ...attempt,
        state: 'terminal_non_retryable',
        terminalReason: 'abandoned',
        retryKind: null,
        artifactContinuationControl: null,
        lease: null,
        updatedAt: Math.max(now, attempt.updatedAt),
      }, now);
      await pruneSettledAgentAttempts(input.sessionId, now, [input.turnAttemptId]);
      return true;
    },
  );
}

/**
 * Explicitly removes damaged recovery authority without changing transcript
 * rows or valid terminal receipts. This is the only automatic-repair boundary.
 */
export async function discardDamagedAgentSessionRecovery(
  sessionId: string,
  now = Date.now(),
): Promise<number> {
  assertAgentTurnTransportIdentifier(sessionId, 'Agent session ID');
  assertTimestamp(now, 'Agent damaged recovery discard time');
  await ensureAgentStorageUsage();
  return db.transaction(
    'rw',
    [
      db.agentSessions,
      db.agentAttempts,
      db.agentAttemptRecoveries,
      db.agentMessages,
      db.agentArtifacts,
      db.agentArtifactChunks,
      db.agentStorageUsage,
    ],
    async () => {
      if (!await db.agentSessions.get(sessionId)) return 0;
      let removed = 0;
      for (const attempt of await readAgentAttemptRows(sessionId)) {
        await discardAgentAttemptRecoveriesForAttempt(attempt);
        let valid = true;
        try {
          await validateAgentAttemptRowIdentity(attempt);
        } catch {
          valid = false;
        }
        if (!valid) {
          await db.agentAttempts.delete(attempt.id);
          removed += 1;
          continue;
        }
        if (!isAttemptActive(attempt) && attempt.state !== 'retryable') continue;
        if (attempt.receipt) {
          await db.agentAttempts.put({
            ...attempt,
            state: 'terminal_non_retryable',
            terminalReason: attempt.receipt.outcome.reason,
            retryKind: null,
            lease: null,
            artifactContinuationControl: null,
            updatedAt: Math.max(now, attempt.updatedAt),
          });
        } else {
          await db.agentAttempts.delete(attempt.id);
        }
        removed += 1;
      }
      await reconcileAgentStorageUsageInCurrentTransaction(now);
      return removed;
    },
  );
}

export type AgentSessionTransitionCommitInput = Readonly<{
  turnAttemptId: string;
  transition: BgsmAgentSessionTransition;
  launchDigest: AgentSessionLaunchDigest;
  outcome: AgentSessionTerminalOutcome;
  now?: () => number;
}>;

export async function commitAgentSessionTransition(
  input: AgentSessionTransitionCommitInput,
  cache?: AgentCanonicalSessionCache,
): Promise<AgentSessionCommitResult> {
  return commitAgentSessionTransitionInternal(input, undefined, cache);
}

/** Commits only while the exact worker epoch still owns the admitted turn. */
export async function commitLeasedAgentSessionTurn(
  input: AgentSessionTransitionCommitInput & Readonly<{ executionEpochId: string }>,
  cache?: AgentCanonicalSessionCache,
): Promise<AgentSessionCommitResult> {
  assertAgentTurnTransportIdentifier(input.executionEpochId, 'Agent worker execution epoch');
  return commitAgentSessionTransitionInternal(input, input.executionEpochId, cache);
}

async function commitAgentSessionTransitionInternal(
  input: AgentSessionTransitionCommitInput,
  requiredExecutionEpochId?: string,
  cache?: AgentCanonicalSessionCache,
): Promise<AgentSessionCommitResult> {
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  validateLaunchDigest(input.launchDigest);
  validateTerminalOutcome(input.outcome);
  validatePersistableTransition(input.transition);
  const digest = await digestAgentSessionTransition(input.transition);
  const now = (input.now ?? Date.now)();
  assertTimestamp(now, 'Agent session update time');

  await ensureAgentStorageUsage();
  const commitOnce = (
    transition: BgsmAgentSessionTransition,
    transitionDigest: AgentSessionAttemptDigest,
    artifactIdsToDiscard: readonly string[] = [],
  ) => db.transaction(
    'rw',
    [
      db.agentSessions,
      db.agentAttempts,
      db.agentAttemptRecoveries,
      db.agentMessages,
      db.agentArtifacts,
      db.agentArtifactChunks,
      db.agentStorageUsage,
    ],
    async () => {
      const record = await db.agentSessions.get(transition.sessionId);
      if (!record) throw new AgentSessionNotFoundError(transition.sessionId);
      validateAgentSessionRecord(record);
      const exactAttempt = await readAgentAttempt(record.id, input.turnAttemptId);
      if (exactAttempt) {
        await validateSessionAttemptRows(record.id, [exactAttempt]);
        if (exactAttempt.admittedLaunchDigest !== input.launchDigest) {
          throw new AgentSessionAttemptConflictError(record.id, input.turnAttemptId);
        }
        if (exactAttempt.receipt) {
          assertMatchingReceipt(
            record.id,
            exactAttempt.receipt,
            { ...input, transition },
            transitionDigest,
          );
          const presentationRows = await readTurnPresentationRows(record, input.turnAttemptId);
          return {
            result: await commitResultFromReceipt(
              record,
              presentationRows,
              toSummary(record),
              exactAttempt.receipt,
              true,
            ),
            cacheCandidate: null,
          };
        }
      }
      const attempts = await readAgentAttemptRows(record.id);
      await validateSessionAttemptRows(record.id, attempts);
      const attempt = attempts.find((candidate) => candidate.turnAttemptId === input.turnAttemptId);
      if (!attempt || attempt.admittedLaunchDigest !== input.launchDigest) {
        throw new AgentSessionAttemptConflictError(record.id, input.turnAttemptId);
      }
      if (record.revision !== transition.baseRevision) {
        throw new AgentSessionRevisionConflictError(
          record.id,
          transition.baseRevision,
          record.revision,
        );
      }
      const cachedSession = cache?.peek(record.id, record.revision);
      const validatedPrefix = cachedSession ?? reconstructCanonicalSession(
        record,
        await db.agentMessages.where('sessionId').equals(transition.sessionId).sortBy('sequence'),
      ).session;
      if (requiredExecutionEpochId !== undefined) {
        if (
          !attempt.lease
          || attempt.lease.executionEpochId !== requiredExecutionEpochId
          || attempt.lease.turnAttemptId !== input.turnAttemptId
          || attempt.lease.baseRevision !== transition.baseRevision
          || attempt.lease.launchDigest !== input.launchDigest
        ) throw new AgentSessionTurnLeaseMismatchError(record.id, input.turnAttemptId);
      } else {
        const active = attempts.find((candidate) => (
          candidate.turnAttemptId !== input.turnAttemptId && isAttemptActive(candidate)
        ));
        if (active) throw new AgentSessionTurnActiveError(record.id, active.turnAttemptId);
      }
      for (const coverage of attempt.artifactCoverage) {
        await Dexie.waitFor(verifyAgentArtifactCoverageRecord(coverage));
        if (coverage.state !== 'complete') {
          throw new AgentArtifactCoverageError('Final commit requires complete artifact coverage.');
        }
        await validateAgentArtifactCoverageStartInCurrentTransaction({
          record: coverage,
          sessionId: record.id,
          turnAttemptId: input.turnAttemptId,
        });
      }
      await assertNoAgentAttemptRecovery(attempt);
      if (attempt.artifactContinuationControl !== null) {
        throw new AgentArtifactCoverageError('Final commit cannot retain artifact continuation state.');
      }

      const applied = applyBgsmAgentSessionTransitionToValidatedPrefix(
        validatedPrefix,
        transition,
      );
      if (!applied.applied) {
        throw new AgentSessionRevisionConflictError(
          record.id,
          transition.baseRevision,
          record.revision,
        );
      }
      let messageRows = transition.messageDelta.map((message, index) => (
        toMessageRecord(
          record.id,
          record.lastSequence + index + 1,
          input.turnAttemptId,
          message,
          now,
        )
      ));
      const coverageReceipts = attempt.artifactCoverage.map((coverage) => (
        createAgentArtifactCoverageReceipt(coverage, now)
      ));
      const coverageReceiptsByMessage = new Map<string, AgentArtifactCoverageReceipt[]>();
      for (const receipt of coverageReceipts) {
        const sources = messageRows.filter((row) => (
          row.role === 'tool'
          && row.toolCallId === receipt.sourceToolCallId
          && row.artifactIds?.includes(receipt.artifactId)
        ));
        if (sources.length !== 1) {
          throw new AgentArtifactCoverageError('Artifact coverage receipt source is not canonical.');
        }
        coverageReceiptsByMessage.set(sources[0]!.id, [
          ...(coverageReceiptsByMessage.get(sources[0]!.id) ?? []),
          receipt,
        ]);
      }
      messageRows = messageRows.map((row) => {
        const receipts = coverageReceiptsByMessage.get(row.id);
        if (!receipts) return row;
        const withReceipts = {
          ...row,
          artifactCoverageReceipts: receipts.map((receipt) => cloneValue(receipt)),
        };
        return {
          ...withReceipts,
          byteLength: agentMessageLogicalByteLength(withReceipts),
        };
      });
      const title = record.title || titleFromCanonicalHistory(applied.session.messages);
      const nextReceipt: AgentSessionAttemptReceipt = {
        turnAttemptId: input.turnAttemptId,
        digest: transitionDigest,
        launchDigest: input.launchDigest,
        appliedRevision: applied.session.revision,
        outcome: cloneValue(input.outcome),
      };
      const nextRecord: AgentSessionRecord = {
        id: record.id,
        schemaVersion: AGENT_SESSION_SCHEMA_VERSION,
        title,
        revision: applied.session.revision,
        lastSequence: record.lastSequence + messageRows.length,
        binding: applied.session.binding ? cloneValue(applied.session.binding) : null,
        compactionCheckpoint: applied.session.compaction
          ? cloneValue(applied.session.compaction)
          : null,
        activeProjections: cloneValue(applied.session.activeProjections ?? []),
        createdAt: record.createdAt,
        updatedAt: Math.max(now, record.updatedAt + 1),
      };
      const retryKind = retryKindForOutcome(input.outcome);
      const canRetry = canRetryAttemptOutcome(input.outcome);
      const nextAttempt: AgentAttemptRow = {
        ...attempt,
        state: canRetry
          ? 'retryable'
          : input.outcome.reason === 'final_answer'
            ? 'committed'
            : 'terminal_non_retryable',
        terminalReason: canRetry ? null : input.outcome.reason,
        retryKind: canRetry ? retryKind : null,
        writeSettlement: input.outcome.writeSettlement,
        receipt: nextReceipt,
        artifactContinuationControl: null,
        lease: null,
        updatedAt: Math.max(now, attempt.updatedAt),
      };

      if (artifactIdsToDiscard.length > 0) {
        await discardUnboundAgentArtifactsInCurrentTransaction({
          artifactIds: artifactIdsToDiscard,
          sessionId: transition.sessionId,
          turnAttemptId: input.turnAttemptId,
        }, now);
      }
      await accountAgentSessionUpdated(record, nextRecord, now);
      await accountAgentMessagesAdded(messageRows, now);
      await putAgentAttempt(attempt, nextAttempt, now);
      await pruneSettledAgentAttempts(record.id, now, [input.turnAttemptId]);
      await bindAgentArtifactsToMessages(
        messageRows.flatMap((row) => (row.artifactIds ?? []).map((artifactId) => ({
          artifactId,
          sessionId: row.sessionId,
          turnAttemptId: row.turnAttemptId,
          messageId: row.id,
          toolCallId: row.toolCallId!,
        }))),
        now,
      );
      if (messageRows.length > 0) await db.agentMessages.bulkAdd(messageRows);
      await db.agentSessions.put(nextRecord);
      return {
        result: await commitResultFromReceipt(
          nextRecord,
          messageRows,
          toSummary(nextRecord),
          nextReceipt,
          false,
        ),
        cacheCandidate: applied.session,
      };
    },
  );
  const commitAndPublish = async (
    transition: BgsmAgentSessionTransition,
    transitionDigest: AgentSessionAttemptDigest,
    artifactIdsToDiscard: readonly string[] = [],
  ): Promise<AgentSessionCommitResult> => {
    const committed = await commitOnce(transition, transitionDigest, artifactIdsToDiscard);
    if (committed.cacheCandidate) cache?.put(committed.cacheCandidate);
    return committed.result;
  };
  try {
    return await commitAndPublish(input.transition, digest);
  } catch (error) {
    if (!isRecoverableStorageError(error)) throw error;
    let storageError = error;
    // Keep transition artifacts alive while reclaiming unrelated cache, then
    // degrade only the artifact-backed payload if storage remains exhausted.
    const cleanup = await cleanupAgentToolCache({
      targetTotalBytes: 0,
      protectedArtifactIds: collectTransitionArtifactIds(input.transition),
    });
    if (cleanup.freedBytes > 0) {
      try {
        return await commitAndPublish(input.transition, digest);
      } catch (retryError) {
        if (!isRecoverableStorageError(retryError)) throw retryError;
        storageError = retryError;
      }
    }

    const degraded = degradeArtifactBackedTransition(input.transition);
    if (degraded.artifactIds.length === 0) throw storageError;
    validatePersistableTransition(degraded.transition);
    const degradedDigest = await digestAgentSessionTransition(degraded.transition);
    return commitAndPublish(degraded.transition, degradedDigest, degraded.artifactIds);
  }
}

function degradeArtifactBackedTransition(
  transition: BgsmAgentSessionTransition,
): Readonly<{
  transition: BgsmAgentSessionTransition;
  artifactIds: string[];
}> {
  const artifactIds = new Set(collectTransitionArtifactIds(transition));
  const messageDelta = transition.messageDelta.map((message) => {
    if (message.role !== 'tool' || !message.opaqueReferences?.length) return message;
    const { opaqueReferences: _opaqueReferences, ...boundedMessage } = message;
    return {
      ...boundedMessage,
      content: JSON.stringify(errorToolResult(
        'tool_result_artifact_evicted',
        'The complete tool result could not be retained because local Agent storage is full.',
      )),
    };
  });
  return {
    transition: { ...transition, messageDelta },
    artifactIds: [...artifactIds],
  };
}

function collectTransitionArtifactIds(
  transition: BgsmAgentSessionTransition,
): string[] {
  return [...new Set(transition.messageDelta.flatMap((message) => (
    message.role === 'tool' ? message.opaqueReferences ?? [] : []
  )))];
}
async function readTurnPresentationRows(
  record: AgentSessionRecord,
  turnAttemptId: string,
): Promise<AgentSessionMessageRecord[]> {
  try {
    const rows = await db.agentMessages
      .where('[sessionId+turnAttemptId]')
      .equals([record.id, turnAttemptId])
      .sortBy('sequence');
    const seenIds = new Set<string>();
    const seenSequences = new Set<number>();
    for (const row of rows) {
      assertPositiveSafeInteger(row.sequence, 'Canonical message sequence');
      if (row.sequence > record.lastSequence) {
        throw new TypeError('Canonical message sequence exceeds the durable cursor.');
      }
      validateAgentSessionMessageRecord(row, record.id, row.sequence);
      if (seenIds.has(row.id) || seenSequences.has(row.sequence)) {
        throw new TypeError('Canonical message IDs and sequences must be unique.');
      }
      seenIds.add(row.id);
      seenSequences.add(row.sequence);
    }
    return rows;
  } catch (error) {
    if (error instanceof AgentSessionCorruptionError) throw error;
    throw new AgentSessionCorruptionError(record.id, errorMessage(error), { cause: error });
  }
}

async function commitResultFromReceipt(
  record: AgentSessionRecord,
  rows: AgentSessionMessageRecord[],
  summary: BgsmAgentSessionSummary,
  receipt: AgentSessionAttemptReceipt,
  idempotent: boolean,
): Promise<AgentSessionCommitResult> {
  return {
    session: metadataFrom(record),
    summary,
    turnAttemptId: receipt.turnAttemptId,
    idempotent,
    appliedRevision: receipt.appliedRevision,
    digest: receipt.digest,
    launchDigest: receipt.launchDigest,
    outcome: cloneValue(receipt.outcome),
    transcript: await readTranscriptPage(record),
    presentationMessages: buildTurnPresentation(rows, receipt.turnAttemptId),
  };
}


function buildTurnPresentation(
  rows: readonly AgentSessionMessageRecord[],
  turnAttemptId: string,
): AgentSessionPresentationMessage[] {
  const turnRows = rows.filter((row) => row.turnAttemptId === turnAttemptId);
  const user = turnRows.find((row) => row.role === 'user');
  const assistant = turnRows.findLast((row) => row.role === 'agent' && row.content.trim().length > 0);
  const presentation = [user, assistant]
    .filter((row): row is AgentSessionMessageRecord => row !== undefined)
    .filter((row, index, selected) => selected.findIndex((candidate) => (
      candidate.sequence === row.sequence
    )) === index)
    .sort((left, right) => left.sequence - right.sequence)
    .map((row): AgentSessionPresentationMessage => ({
      sequence: row.sequence,
      id: row.id,
      role: row.role as 'user' | 'agent',
      content: row.content,
      createdAt: row.createdAt,
    }));
  if (serializedJsonUtf8Bytes(presentation) > AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES) {
    throw new RangeError('Agent turn presentation exceeds the transcript page budget.');
  }
  return presentation;
}


function assertMatchingReceipt(
  sessionId: string,
  receipt: AgentSessionAttemptReceipt,
  input: AgentSessionTransitionCommitInput,
  digest: AgentSessionAttemptDigest,
): void {
  if (
    receipt.digest !== digest
    || receipt.launchDigest !== input.launchDigest
    || canonicalJson(receipt.outcome) !== canonicalJson(input.outcome)
  ) {
    throw new AgentSessionAttemptConflictError(sessionId, input.turnAttemptId);
  }
}

function assertMatchingLaunchDigest(
  sessionId: string,
  receipt: AgentSessionAttemptReceipt,
  launchDigest: AgentSessionLaunchDigest,
): void {
  if (receipt.launchDigest !== launchDigest) {
    throw new AgentSessionAttemptConflictError(sessionId, receipt.turnAttemptId);
  }
}


/**
 * Conversation-owned rows are deleted together. Linked nonterminal Organize
 * authority blocks deletion; terminal Organize evidence remains independent.
 */
export async function deleteAgentSession(
  sessionId: string,
  options: Readonly<{
    now?: () => number;
    executionEpochId?: string;
    cache?: AgentCanonicalSessionCache;
  }> = {},
): Promise<boolean> {
  assertAgentTurnTransportIdentifier(sessionId, 'Agent session ID');
  if (options.executionEpochId !== undefined) {
    assertAgentTurnTransportIdentifier(options.executionEpochId, 'Agent worker execution epoch');
  }
  const now = (options.now ?? Date.now)();
  assertTimestamp(now, 'Agent session deletion time');
  await ensureAgentStorageUsage();
  const deleted = await db.transaction(
    'rw',
    [
      db.agentSessions,
      db.agentAttempts,
      db.agentAttemptRecoveries,
      db.agentMessages,
      db.agentArtifacts,
      db.agentArtifactChunks,
      db.agentStorageUsage,
      db.organizeJobs,
      db.organizeItems,
      db.organizeTaxonomies,
      db.organizeApplies,
      db.organizeApplyRows,
    ],
    async () => {
      const record = await db.agentSessions.get(sessionId);
      if (!record) return false;
      const attempts = await readAgentAttemptRows(sessionId);
      const activeAttempt = attempts.find((attempt) => {
        try {
          validateAgentAttemptRow(attempt, sessionId);
          return isAttemptActive(attempt)
            && !!attempt.lease
            && (
              options.executionEpochId === undefined
              || attempt.lease.executionEpochId === options.executionEpochId
            );
        } catch {
          // A damaged attempt cannot prove live worker ownership; deletion is
          // the user's explicit recovery boundary for that damaged record.
          return false;
        }
      });
      if (activeAttempt) {
        throw new AgentSessionTurnActiveError(sessionId, activeAttempt.turnAttemptId);
      }
      const stalePreflights: string[] = [];
      let blockingJobId: string | null = null;
      for (const job of await getOrganizeJobsLinkedToAgentSession(sessionId)) {
        if (job.status === 'completed' || job.status === 'cancelled') continue;
        if (job.status === 'preflight_ready' && (
          job.preflight?.state !== 'ready'
          || job.preflight.expiresAt <= now
        )) {
          stalePreflights.push(job.jobId);
          continue;
        }
        blockingJobId = job.jobId;
        break;
      }
      if (blockingJobId) {
        throw new AgentSessionDeletionBlockedError(sessionId, blockingJobId);
      }
      for (const jobId of stalePreflights) {
        await deleteStaleOrganizePreflightArtifacts(jobId);
      }
      const referencedArtifactIds = new Set<string>();
      await db.agentMessages.where('sessionId').equals(sessionId).each((message) => {
        if (!Array.isArray(message.artifactIds)) return;
        for (const artifactId of message.artifactIds) {
          if (typeof artifactId === 'string') referencedArtifactIds.add(artifactId);
        }
      });
      await deleteAgentSessionArtifacts(sessionId, [...referencedArtifactIds]);
      await db.agentMessages.where('sessionId').equals(sessionId).delete();
      await db.agentAttemptRecoveries.where('sessionId').equals(sessionId).delete();
      await db.agentAttempts.where('sessionId').equals(sessionId).delete();
      await db.agentSessions.delete(sessionId);
      // Rebuilding from the surviving rows keeps deletion available even when
      // the removed session contained malformed byte counters or artifacts.
      await reconcileAgentStorageUsageInCurrentTransaction(now);
      return true;
    },
  );
  if (deleted) options.cache?.delete(sessionId);
  return deleted;
}

async function deleteStaleOrganizePreflightArtifacts(jobId: string): Promise<void> {
  const applies = await db.organizeApplies.where('jobId').equals(jobId).toArray();
  for (const apply of applies) {
    await db.organizeApplyRows.where('applyId').equals(apply.applyId).delete();
    await db.organizeApplies.delete(apply.applyId);
  }
  await db.organizeItems.where('jobId').equals(jobId).delete();
  await db.organizeTaxonomies.delete(jobId);
  await db.organizeJobs.delete(jobId);
}

function reconstructCanonicalSession(
  record: AgentSessionRecord,
  rows: AgentSessionMessageRecord[],
): CanonicalLoadedAgentSession {
  try {
    validateAgentSessionRecord(record);
    if (rows.length !== record.lastSequence) {
      throw new TypeError('Message count does not match the durable sequence cursor.');
    }
    const seenIds = new Set<string>();
    const messages = rows.map((row, index) => {
      validateAgentSessionMessageRecord(row, record.id, index + 1);
      if (seenIds.has(row.id)) throw new TypeError('Canonical message IDs must be unique.');
      seenIds.add(row.id);
      return fromMessageRecord(row);
    });
    validateBgsmAgentSessionHistory(messages);
    validateProviderProtocolHistory(messages.map(toModelMessage));
    if (record.compactionCheckpoint) {
      verifyBgsmAgentCheckpoint(messages, record.compactionCheckpoint);
    }
    verifyBgsmAgentActiveProjections(
      messages,
      record.activeProjections,
      record.compactionCheckpoint ?? undefined,
    );
    const session: BgsmAgentSession = {
      id: record.id,
      revision: record.revision,
      messages,
      ...(record.binding ? { binding: cloneValue(record.binding) } : {}),
      ...(record.compactionCheckpoint
        ? { compaction: cloneValue(record.compactionCheckpoint) }
        : {}),
      ...(record.activeProjections.length > 0
        ? { activeProjections: cloneValue(record.activeProjections) }
        : {}),
    };
    return canonicalLoadedFrom(record, session);
  } catch (error) {
    if (error instanceof AgentSessionCorruptionError) throw error;
    throw new AgentSessionCorruptionError(record.id, errorMessage(error), { cause: error });
  }
}

function validateAgentSessionRecord(record: AgentSessionRecord): void {
  if (!record || typeof record !== 'object') throw new TypeError('Header must be an object.');
  assertAgentTurnTransportIdentifier(record.id, 'Agent session ID');
  if (record.schemaVersion !== AGENT_SESSION_SCHEMA_VERSION) {
    throw new TypeError('Unsupported durable session schema version.');
  }
  if (typeof record.title !== 'string') throw new TypeError('Session title must be a string.');
  if (record.title && (record.title !== record.title.trim()
    || [...record.title].length > AGENT_SESSION_TITLE_MAX_LENGTH)) {
    throw new TypeError('Session title is not normalized.');
  }
  assertNonnegativeSafeInteger(record.revision, 'Session revision');
  assertNonnegativeSafeInteger(record.lastSequence, 'Session sequence cursor');
  if (record.binding !== null) validateBgsmAgentConversationBinding(record.binding);
  if (record.compactionCheckpoint !== null) {
    validateBgsmAgentCompactionCheckpoint(record.compactionCheckpoint);
  }
  if (!Array.isArray(record.activeProjections)) {
    throw new TypeError('Active projections must be an array.');
  }
  for (const projection of record.activeProjections) {
    validateBgsmAgentActiveProjection(projection);
  }
  assertTimestamp(record.createdAt, 'Agent session creation time');
  assertTimestamp(record.updatedAt, 'Agent session update time');
  if (record.updatedAt < record.createdAt) {
    throw new TypeError('Agent session update time precedes its creation time.');
  }
}

function validateAgentSessionTurnLease(lease: AgentSessionTurnLease): void {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    throw new TypeError('Agent turn lease must be an object.');
  }
  const keys = Object.keys(lease).sort();
  if (
    keys.length !== 5
    || keys[0] !== 'acquiredAt'
    || keys[1] !== 'baseRevision'
    || keys[2] !== 'executionEpochId'
    || keys[3] !== 'launchDigest'
    || keys[4] !== 'turnAttemptId'
  ) throw new TypeError('Agent turn lease has unexpected fields.');
  assertBoundedText(lease.executionEpochId, 'Agent worker execution epoch', 512, true);
  assertBoundedText(lease.turnAttemptId, 'Agent turn attempt ID', 512, true);
  assertNonnegativeSafeInteger(lease.baseRevision, 'Agent turn lease base revision');
  validateLaunchDigest(lease.launchDigest);
  assertTimestamp(lease.acquiredAt, 'Agent turn lease acquisition time');
}

function validateAgentSessionMessageRecord(
  row: AgentSessionMessageRecord,
  sessionId: string,
  expectedSequence: number,
): void {
  if (!row || typeof row !== 'object') throw new TypeError('Message row must be an object.');
  const messageKeys = [
    'byteLength',
    'content',
    'createdAt',
    'expiresAt',
    'id',
    'lastAccessedAt',
    'role',
    'schemaVersion',
    'sequence',
    'sessionId',
    'storageClass',
    'turnAttemptId',
    ...(row.toolCallId === undefined ? [] : ['toolCallId']),
    ...(row.toolName === undefined ? [] : ['toolName']),
    ...(row.toolCalls === undefined ? [] : ['toolCalls']),
    ...(row.artifactIds === undefined ? [] : ['artifactIds']),
    ...(row.artifactCoverageReceipts === undefined ? [] : ['artifactCoverageReceipts']),
  ];
  if (!hasExactKeys(row as unknown as Record<string, unknown>, messageKeys)) {
    throw new TypeError('Canonical Agent message has unexpected fields.');
  }
  if (row.schemaVersion !== AGENT_SESSION_SCHEMA_VERSION) {
    throw new TypeError('Unsupported durable message schema version.');
  }
  assertNonemptyTrimmedString(row.id, 'Canonical message ID');
  if (row.sessionId !== sessionId) throw new TypeError('Message belongs to another session.');
  if (row.sequence !== expectedSequence) throw new TypeError('Message sequence has a gap.');
  assertAgentTurnTransportIdentifier(row.turnAttemptId, 'Message turn attempt ID');
  if (row.role !== 'user' && row.role !== 'agent' && row.role !== 'tool') {
    throw new TypeError('Message role is not canonical.');
  }
  assertBoundedText(row.id, 'Canonical message ID', 512, true);
  assertBoundedText(row.content, 'Message content', 512 * 1024, false);
  assertNonnegativeSafeInteger(row.byteLength, 'Message logical byte length');
  if (row.storageClass !== 'canonical') {
    throw new TypeError('Canonical Agent messages must use canonical storage.');
  }
  if (row.byteLength !== agentMessageLogicalByteLength(row as unknown as Record<string, unknown>)) {
    throw new TypeError('Canonical Agent message byte length is invalid.');
  }
  if (serializedJsonUtf8Bytes(row) > AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES) {
    throw new RangeError('Serialized Agent message row exceeds the transcript page budget.');
  }
  if (!Number.isSafeInteger(row.createdAt) || row.createdAt < 0) {
    throw new TypeError('Message creation time must be a nonnegative safe integer.');
  }
  if (!Number.isSafeInteger(row.lastAccessedAt) || row.lastAccessedAt < row.createdAt) {
    throw new TypeError('Message access time must not precede creation.');
  }
  if (row.expiresAt !== null) throw new TypeError('Canonical Agent messages cannot expire.');
  if (row.role === 'user') {
    if (
      row.toolCallId !== undefined
      || row.toolName !== undefined
      || row.toolCalls !== undefined
      || row.artifactIds !== undefined
      || row.artifactCoverageReceipts !== undefined
    ) {
      throw new TypeError('User messages cannot contain tool metadata.');
    }
    return;
  }
  if (row.role === 'agent') {
    if (
      row.toolCallId !== undefined
      || row.toolName !== undefined
      || row.artifactIds !== undefined
      || row.artifactCoverageReceipts !== undefined
    ) {
      throw new TypeError('Assistant messages cannot contain tool-result metadata.');
    }
    if (row.toolCalls !== undefined) {
      if (row.toolCalls.length === 0 || row.toolCalls.length > 64) {
        throw new TypeError('Assistant tool-call envelopes must contain between 1 and 64 calls.');
      }
      row.toolCalls.forEach(validatePersistableToolCall);
    }
    return;
  }
  if (row.toolCalls !== undefined) {
    throw new TypeError('Tool-result messages cannot declare tool calls.');
  }
  assertBoundedText(row.toolCallId, 'Tool call ID', 512, true);
  assertBoundedText(row.toolName, 'Tool name', 256, true);
  if (row.artifactIds !== undefined) {
    if (
      !Array.isArray(row.artifactIds)
      || row.artifactIds.length === 0
      || row.artifactIds.length > 8
    ) throw new TypeError('Tool-result artifact references must contain between 1 and 8 IDs.');
    const artifactIds = new Set<string>();
    for (const artifactId of row.artifactIds) {
      assertBoundedText(artifactId, 'Agent artifact ID', 512, true);
      if (artifactIds.has(artifactId)) {
        throw new TypeError('Tool-result artifact references must be unique.');
      }
      artifactIds.add(artifactId);
    }
  }
  if (row.artifactCoverageReceipts !== undefined) {
    if (
      !Array.isArray(row.artifactCoverageReceipts)
      || row.artifactCoverageReceipts.length === 0
      || row.artifactCoverageReceipts.length > 64
    ) throw new TypeError('Artifact coverage receipts must contain between 1 and 64 records.');
    const coverageIds = new Set<string>();
    for (const receipt of row.artifactCoverageReceipts) {
      validateAgentArtifactCoverageReceipt(receipt);
      if (
        receipt.sourceToolCallId !== row.toolCallId
        || !row.artifactIds?.includes(receipt.artifactId)
        || coverageIds.has(receipt.coverageId)
      ) throw new TypeError('Artifact coverage receipt does not match its canonical source row.');
      coverageIds.add(receipt.coverageId);
    }
  }
}

function validatePersistableTransition(transition: BgsmAgentSessionTransition): void {
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
    throw new TypeError('Agent session transition must be an object.');
  }
  assertAgentTurnTransportIdentifier(transition.sessionId, 'Agent session ID');
  assertNonnegativeSafeInteger(transition.baseRevision, 'Agent session base revision');
  if (!Array.isArray(transition.messageDelta)) {
    throw new TypeError('Agent session message delta must be an array.');
  }
  if (transition.binding !== undefined) {
    validateBgsmAgentConversationBinding(transition.binding);
  }
  if (transition.candidateCheckpoint !== undefined) {
    validateBgsmAgentCompactionCheckpoint(transition.candidateCheckpoint);
  }
  if (
    transition.candidateActiveProjection !== undefined
    && transition.candidateActiveProjection !== null
  ) {
    validateBgsmAgentActiveProjection(transition.candidateActiveProjection);
  }
  transition.messageDelta.forEach((message, index) => {
    const row = toMessageRecord(
      transition.sessionId,
      index + 1,
      'validation-attempt',
      message,
    );
    validateAgentSessionMessageRecord(row, transition.sessionId, index + 1);
  });
}

function validatePersistableToolCall(value: ModelToolCall): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent tool call must be an object.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'arguments' || keys[1] !== 'id' || keys[2] !== 'name') {
    throw new TypeError('Agent tool call has unexpected fields.');
  }
  assertBoundedText(value.id, 'Tool call ID', 512, true);
  assertBoundedText(value.name, 'Tool call name', 256, true);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value.arguments);
  } catch {
    throw new TypeError('Agent tool call arguments are not JSON serializable.');
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 256 * 1024) {
    throw new RangeError('Agent tool call arguments are too large.');
  }
}

function toMessageRecord(
  sessionId: string,
  sequence: number,
  turnAttemptId: string,
  message: BgsmAgentSessionMessage,
  lastAccessedAt = message.createdAt,
): AgentSessionMessageRecord {
  const record = {
    id: message.id,
    schemaVersion: AGENT_SESSION_SCHEMA_VERSION,
    sessionId,
    sequence,
    turnAttemptId,
    role: message.role,
    content: message.content,
    storageClass: 'canonical' as const,
    createdAt: message.createdAt,
    lastAccessedAt: Math.max(message.createdAt, lastAccessedAt),
    expiresAt: null,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.toolCalls ? { toolCalls: cloneValue(message.toolCalls) } : {}),
    ...(message.opaqueReferences ? { artifactIds: [...message.opaqueReferences] } : {}),
  };
  return {
    ...record,
    byteLength: agentMessageLogicalByteLength(record),
  };
}

function fromMessageRecord(row: AgentSessionMessageRecord): BgsmAgentSessionMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    ...(row.toolCallId !== undefined ? { toolCallId: row.toolCallId } : {}),
    ...(row.toolName !== undefined ? { toolName: row.toolName } : {}),
    ...(row.toolCalls !== undefined ? { toolCalls: cloneValue(row.toolCalls) } : {}),
    ...(row.artifactIds !== undefined ? { opaqueReferences: [...row.artifactIds] } : {}),
  };
}
function fromMessageRecordForTransport(
  row: AgentSessionMessageRecord,
): AgentSessionTranscriptMessage {
  return {
    sequence: row.sequence,
    ...fromMessageRecord(row),
  };
}


function titleFromCanonicalHistory(messages: readonly BgsmAgentSessionMessage[]): string {
  const prompt = messages.find((message) => message.role === 'user')?.content;
  if (!prompt) return '';
  const clean = prompt.trim().replace(/\s+/gu, ' ');
  const characters = [...clean];
  if (characters.length <= AGENT_SESSION_TITLE_MAX_LENGTH) return clean;
  return `${characters
    .slice(0, AGENT_SESSION_TITLE_MAX_LENGTH - 1)
    .join('')
    .trimEnd()}\u2026`;
}

function canonicalLoadedFrom(
  record: AgentSessionRecord,
  session: BgsmAgentSession,
): CanonicalLoadedAgentSession {
  return {
    session: cloneSession(session),
    summary: toSummary(record),
    lastAppliedTurnAttemptId: null,
    appliedTurnReceipts: [],
  };
}

async function transportLoadedFromRecord(
  record: AgentSessionRecord,
  transcript: AgentSessionTranscriptPage,
): Promise<LoadedAgentSession> {
  const appliedTurnReceipts = await recentAttemptReceipts(record.id);
  return {
    session: metadataFrom(record),
    transcript,
    summary: toSummary(record),
    lastAppliedTurnAttemptId: appliedTurnReceipts.at(-1)?.turnAttemptId ?? null,
    appliedTurnReceipts,
  };
}

function metadataFrom(record: AgentSessionRecord): AgentSessionMetadata {
  return {
    id: record.id,
    revision: record.revision,
    ...(record.binding ? { binding: cloneValue(record.binding) } : {}),
    ...(record.compactionCheckpoint
      ? { compaction: cloneValue(record.compactionCheckpoint) }
      : {}),
    ...(record.activeProjections.length > 0
      ? { activeProjections: cloneValue(record.activeProjections) }
      : {}),
  };
}

async function readTranscriptPage(
  record: AgentSessionRecord,
  beforeSequence?: number,
): Promise<AgentSessionTranscriptPage> {
  try {
    if (record.lastSequence === 0 || beforeSequence === 1) {
      return emptyTranscriptPage(record.id);
    }
    // Pages run newest-to-oldest and exclude the cursor row, preserving a
    // contiguous transcript across page boundaries without duplicates.
    const upperSequence = beforeSequence ?? Number.MAX_SAFE_INTEGER;
    const rows = await db.agentMessages
      .where('[sessionId+sequence]')
      .between(
        [record.id, 0],
        [record.id, upperSequence],
        true,
        beforeSequence === undefined,
      )
      .reverse()
      .limit(AGENT_SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES)
      .toArray();
    const expectedFirstSequence = beforeSequence === undefined
      ? record.lastSequence
      : Math.min(record.lastSequence, beforeSequence - 1);
    let expectedSequence = expectedFirstSequence;
    const seenIds = new Set<string>();
    for (const row of rows) {
      if (row.sequence !== expectedSequence) {
        throw new TypeError('Message sequence has a gap.');
      }
      validateAgentSessionMessageRecord(row, record.id, row.sequence);
      if (seenIds.has(row.id)) {
        throw new TypeError('Canonical message IDs must be unique.');
      }
      seenIds.add(row.id);
      expectedSequence -= 1;
    }
    if (
      rows.length < AGENT_SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES
      && expectedSequence > 0
    ) {
      throw new TypeError('Message count does not match the durable sequence cursor.');
    }

    const pageDescending: AgentSessionMessageRecord[] = [];
    let bytes = 2;
    for (const row of rows) {
      const message = fromMessageRecordForTransport(row);
      const messageBytes = serializedJsonUtf8Bytes(message);
      const separatorBytes = pageDescending.length > 0 ? 1 : 0;
      if (bytes + messageBytes + separatorBytes > AGENT_SESSION_TRANSCRIPT_PAGE_MAX_BYTES) {
        if (pageDescending.length === 0) {
          throw new RangeError('Serialized Agent message exceeds the transcript page budget.');
        }
        break;
      }
      pageDescending.push(row);
      bytes += messageBytes + separatorBytes;
    }
    const page = pageDescending.reverse();
    return {
      sessionId: record.id,
      messages: page.map(fromMessageRecordForTransport),
      nextBeforeSequence: page[0] && page[0].sequence > 1 ? page[0].sequence : null,
    };
  } catch (error) {
    if (error instanceof AgentSessionCorruptionError) throw error;
    throw new AgentSessionCorruptionError(record.id, errorMessage(error), { cause: error });
  }
}

function emptyTranscriptPage(sessionId: string): AgentSessionTranscriptPage {
  return { sessionId, messages: [], nextBeforeSequence: null };
}

function validateTransportSessionRecord(record: AgentSessionRecord): void {
  try {
    validateAgentSessionRecord(record);
  } catch (error) {
    if (error instanceof AgentSessionCorruptionError) throw error;
    throw new AgentSessionCorruptionError(record.id, errorMessage(error), { cause: error });
  }
}

function validateAttemptReceipt(receipt: AgentSessionAttemptReceipt): void {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new TypeError('Agent attempt receipt must be an object.');
  }
  if (!hasExactKeys(receipt as unknown as Record<string, unknown>, [
    'appliedRevision',
    'digest',
    'launchDigest',
    'outcome',
    'turnAttemptId',
  ])) throw new TypeError('Agent attempt receipt has unexpected fields.');
  assertAgentTurnTransportIdentifier(receipt.turnAttemptId, 'Applied turn attempt ID');
  if (!/^asd:v1:[A-Za-z0-9_-]{43}$/u.test(receipt.digest)) {
    throw new TypeError('Applied turn attempt digest is malformed.');
  }
  validateLaunchDigest(receipt.launchDigest);
  assertPositiveSafeInteger(receipt.appliedRevision, 'Applied turn receipt revision');
  validateTerminalOutcome(receipt.outcome);
}

function toSummary(record: AgentSessionRecord): BgsmAgentSessionSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function cloneSession(session: BgsmAgentSession): BgsmAgentSession {
  return cloneValue(session);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneAttemptReceipt(receipt: AgentSessionAttemptReceipt): AgentSessionAppliedTurnReceipt {
  return {
    turnAttemptId: receipt.turnAttemptId,
    digest: receipt.digest,
    launchDigest: receipt.launchDigest,
    appliedRevision: receipt.appliedRevision,
    outcome: cloneValue(receipt.outcome),
  };
}

const AGENT_SESSION_RETRY_KINDS: Record<AgentSessionRetryKind, true> = {
  stopped: true,
  failed: true,
  context_limit: true,
};


function validateAgentSessionLaunch(
  launch: AgentSessionLaunchIdentity,
  sessionId: string,
): void {
  validateAgentSessionLaunchIdentity(launch);
  if (launch.sessionId !== sessionId) {
    throw new TypeError('Agent turn launch belongs to another session.');
  }
}


function validateTurnAdmissionInput(input: Readonly<{
  sessionId: string;
  baseRevision: number;
  turnAttemptId: string;
  executionEpochId: string;
  launchDigest: AgentSessionLaunchDigest;
  launch: AgentSessionLaunchIdentity;
}>): void {
  assertAgentTurnTransportIdentifier(input.sessionId, 'Agent session ID');
  assertNonnegativeSafeInteger(input.baseRevision, 'Agent session base revision');
  assertAgentTurnTransportIdentifier(input.turnAttemptId, 'Agent turn attempt ID');
  assertAgentTurnTransportIdentifier(input.executionEpochId, 'Agent worker execution epoch');
  validateLaunchDigest(input.launchDigest);
  validateAgentSessionLaunch(input.launch, input.sessionId);
  if (
    input.launch.sessionId !== input.sessionId
    || input.launch.turnAttemptId !== input.turnAttemptId
    || input.launch.baseRevision !== input.baseRevision
  ) throw new TypeError('Agent turn launch identity does not match admission.');
}


function validateTerminalOutcome(value: unknown): asserts value is AgentSessionTerminalOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent terminal outcome must be an object.');
  }
  const outcome = value as Record<string, unknown>;
  const keys = [
    'reason',
    'changed',
    'changedCount',
    'writeSettlement',
    ...(outcome.contextFailureReason === undefined ? [] : ['contextFailureReason']),
    ...(outcome.organizeLibraryAction === undefined ? [] : ['organizeLibraryAction']),
    ...(outcome.handoffAnchor === undefined ? [] : ['handoffAnchor']),
  ].sort();
  if (!hasExactKeys(outcome, keys)) {
    throw new TypeError('Agent terminal outcome has unexpected fields.');
  }
  if (
    typeof outcome.reason !== 'string'
    || !AGENT_STOP_REASONS.has(outcome.reason as AgentStopReason)
  ) {
    throw new TypeError('Agent terminal outcome reason is invalid.');
  }
  if (typeof outcome.changed !== 'boolean') {
    throw new TypeError('Agent terminal outcome changed flag is invalid.');
  }
  assertNonnegativeSafeInteger(outcome.changedCount, 'Agent terminal outcome changed count');
  if ((Number(outcome.changedCount) > 0) !== outcome.changed) {
    throw new TypeError('Agent terminal outcome changed count does not match its flag.');
  }
  if (
    outcome.writeSettlement !== 'none'
    && outcome.writeSettlement !== 'all_failed'
    && outcome.writeSettlement !== 'unsafe'
  ) {
    throw new TypeError('Agent terminal outcome write settlement is invalid.');
  }
  if (outcome.changed && outcome.writeSettlement !== 'unsafe') {
    throw new TypeError('Changed Agent terminal outcome must have an unsafe write settlement.');
  }
  if (
    outcome.contextFailureReason !== undefined
    && (
      typeof outcome.contextFailureReason !== 'string'
      || !AGENT_CONTEXT_FAILURE_REASONS.has(
        outcome.contextFailureReason as AgentContextFailureReason,
      )
    )
  ) {
    throw new TypeError('Agent terminal outcome context failure reason is invalid.');
  }
  if (
    outcome.organizeLibraryAction !== undefined
    && outcome.organizeLibraryAction !== 'request_confirmation'
    && outcome.organizeLibraryAction !== 'start_analysis'
  ) {
    throw new TypeError('Agent terminal outcome organize action is invalid.');
  }
  if (outcome.handoffAnchor !== undefined) {
    if (outcome.organizeLibraryAction === undefined) {
      throw new TypeError('Agent terminal outcome handoff anchor requires an organize action.');
    }
    validateHandoffAnchor(outcome.handoffAnchor);
  }
  if (serializedJsonUtf8Bytes(outcome) > AGENT_SESSION_TERMINAL_OUTCOME_MAX_BYTES) {
    throw new RangeError('Agent terminal outcome is too large.');
  }
}

function validateHandoffAnchor(value: unknown): asserts value is AgentSessionHandoffAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent handoff anchor must be an object.');
  }
  const anchor = value as Record<string, unknown>;
  if (!hasExactKeys(anchor, ['createdAt', 'messageId'])) {
    throw new TypeError('Agent handoff anchor has unexpected fields.');
  }
  if (anchor.messageId !== null) {
    assertBoundedText(anchor.messageId, 'Agent handoff message ID', 512, true);
  }
  assertTimestamp(anchor.createdAt, 'Agent handoff creation time');
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

const AGENT_STOP_REASONS = new Set<AgentStopReason>([
  'final_answer',
  'approval_required',
  'interaction_required',
  'protocol_error',
  'step_budget_reached',
  'context_limit',
  'provider_error',
  'attempt_state_lost',
  'aborted',
]);

const AGENT_CONTEXT_FAILURE_REASONS = new Set<AgentContextFailureReason>([
  'capability_unresolved',
  'current_turn_too_large',
  'no_candidate',
  'summary_provider_failed',
  'summary_invalid',
  'fallback_too_large',
  'final_preflight_failed',
  'tool_result_memory_limit',
  'provider_context_overflow',
  'provider_context_overflow_repeated',
  'provider_request_byte_limit',
  'provider_request_byte_limit_repeated',
]);

function assertNonemptyTrimmedString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be trimmed and nonempty.`);
  }
}

function assertBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  requireNonempty: boolean,
): asserts value is string {
  if (
    typeof value !== 'string'
    || (requireNonempty && value.length === 0)
    || (requireNonempty && value.trim() !== value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`${label} is too large.`);
  }
}

function assertNonnegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite nonnegative number.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isQuotaExceededError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'QuotaExceededError';
}

function isRecoverableStorageError(error: unknown): boolean {
  return error instanceof AgentStorageCapacityError || isQuotaExceededError(error);
}
