import Dexie from 'dexie';
import type {
  OrganizeAnalysisRange,
  OrganizeApplyRecord,
  OrganizeApplyRowRecord,
  OrganizeFrozenScopeSnapshot,
  OrganizeItemAnalysisState,
  OrganizeItemRecord,
  OrganizeJobRecord,
  OrganizeProposedAction,
  OrganizeStoredJobStatus,
  OrganizeTaxonomyRecord,
  Tag,
} from '@/types';
import {
  createOrganizeTagPolicySnapshot,
  reconcileOrganizeTagCoverage,
  TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT,
  validateProviderAttemptReservation,
  validateRunBudgetUsage,
  type RunBudget,
  type RunBudgetUsage,
} from '@/bgsm-agent/policy';
import {
  createOrganizeJobId,
  isOrganizeJobId,
  type ProposalId,
  type RunId,
} from '@/bgsm-agent/identity';
import { isPreflightToken } from '@/bgsm-agent/scope';
import { sourceFingerprintV1 } from '@/bgsm-agent/source-fingerprint';
import { isTaxonomyFingerprintV1 } from '@/bgsm-agent/proposal';
import {
  buildSemanticPolicyTaxonomyFromStorage,
  fingerprintSemanticTaxonomy,
} from '@/bgsm-agent/semantic-dto';
import { addTagNames, excludedCanonicalTagKeys, sameTagNames } from '@/tags/tag-model';
import { db } from './db';
import { markDirtyForLocalWrites, queueTagDirtyOutbox } from './idb-tag-store';
import { normalizeStoredTag, type LegacyTagRow } from './tag-shape';

export const ORGANIZE_ANALYSIS_BATCH_DEFAULT = 25;
export const ORGANIZE_ANALYSIS_BATCH_MAX = 50;
export const ORGANIZE_APPLY_CHUNK_MAX = 100;
export const ORGANIZE_DEFAULT_LEASE_MS = 60_000;
export const ORGANIZE_ANALYSIS_LEASE_MS = 360_000;
export const ORGANIZE_ACTIVE_SLOT = 'organize-tags';

const REPLAYABLE_ORGANIZE_PREFLIGHT_STATUSES: ReadonlySet<OrganizeStoredJobStatus> = new Set([
  'analyzing',
  'analysis_blocked',
  'paused',
  'review',
  'apply_sealed',
  'applying',
]);

export type OrganizeLeaseOptions = Readonly<{
  ownerId: string;
  durationMs?: number;
  now?: number;
}>;

export type CreateOrganizeJobInput = Readonly<{
  jobId?: string;
  activeSlot?: string;
  controllerId: string;
  sessionId: string;
  runId: string;
  generation: number;
  proposalId?: string;
  frozenScope: OrganizeFrozenScopeSnapshot;
  taskInstruction: string;
  tagPolicy?: unknown;
  taxonomy: Readonly<{ fingerprint: string; snapshot: unknown }>;
  budget: unknown;
  usage: unknown;
  nextFrozenIndex?: number;
  providerBinding?: unknown | null;
  now?: number;
}>;

export type CreateOrganizePreflightInput = CreateOrganizeJobInput & Readonly<{
  preflightToken: string;
  requestId: string;
  expiresAt: number;
}>;

export type OrganizeAnalysisOutcome = Readonly<{
  position: number;
  state: Exclude<OrganizeItemAnalysisState, 'pending' | 'leased'> | 'retry';
  proposedActions?: readonly OrganizeProposedAction[];
  sourceFingerprint?: string | null;
  failure?: string | null;
}>;

export type OrganizeCoverage = Readonly<{
  total: number;
  pending: number;
  leased: number;
  actionable: number;
  unchanged: number;
  insufficientEvidence: number;
  missing: number;
  tombstoned: number;
  failed: number;
  analyzed: number;
  complete: boolean;
}>;

export type OrganizeReviewPage = Readonly<{
  jobId: string;
  revision: number;
  rows: readonly OrganizeItemRecord[];
  nextCursor: number | null;
}>;

export type OrganizeSelectionSummary = Readonly<{
  actionableRepositories: number;
  selectedRepositories: number;
  selectedActions: number;
}>;

export type OrganizeApplyProgress = Readonly<{
  applyId: string;
  total: number;
  settled: number;
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
}>;

export type OrganizeReceiptPage = Readonly<{
  applyId: string;
  rows: readonly OrganizeApplyRowRecord[];
  nextCursor: number | null;
}>;

export type OrganizeReceipt = Readonly<{
  apply: OrganizeApplyRecord;
  rows: readonly OrganizeApplyRowRecord[];
  counts: Readonly<{
    changed: number;
    unchanged: number;
    skipped: number;
    failed: number;
    pending: number;
  }>;
}>;

export async function createOrganizeJob(
  input: CreateOrganizeJobInput,
): Promise<OrganizeJobRecord> {
  validateCreateInput(input);
  const now = input.now ?? Date.now();
  const activeSlot = input.activeSlot ?? ORGANIZE_ACTIVE_SLOT;
  const jobId = input.jobId ?? createOrganizeJobId();
  const repositoryIds = [...input.frozenScope.repositoryIds];
  const initialStatus = repositoryIds.length === 0 ? 'review' : 'analyzing';
  const job: OrganizeJobRecord = {
    jobId,
    activeSlot,
    controllerId: input.controllerId,
    sessionId: input.sessionId,
    runId: input.runId,
    generation: input.generation,
    proposalId: input.proposalId ?? `proposal:v1:${jobId}`,
    frozenScope: { ...input.frozenScope, repositoryIds },
    taskInstruction: input.taskInstruction,
    tagPolicy: createOrganizeTagPolicySnapshot(input.tagPolicy),
    budget: input.budget,
    usage: input.usage,
    nextFrozenIndex: input.nextFrozenIndex ?? 0,
    analysisPendingRanges: [],
    providerBinding: input.providerBinding ?? null,
    status: initialStatus,
    revision: 1,
    itemCount: repositoryIds.length,
    applyId: null,
    pauseRequested: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null,
  };
  const items = repositoryIds.map((fullName, position): OrganizeItemRecord => ({
    id: itemId(jobId, position),
    jobId,
    position,
    fullName,
    analysisState: 'pending',
    proposedActions: [],
    approvedActions: [],
    proposedAdditions: [],
    sourceFingerprint: null,
    selected: false,
    retryCount: 0,
    failure: null,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    analyzedAt: null,
  }));
  const taxonomy: OrganizeTaxonomyRecord = {
    jobId,
    fingerprint: input.taxonomy.fingerprint,
    snapshot: input.taxonomy.snapshot,
    createdAt: now,
  };

  await db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeTaxonomies,
    db.organizeApplies,
    db.organizeApplyRows,
    async () => {
      const active = await findActiveJob(activeSlot);
      if (active) throw new TypeError(`Organize slot already has active job ${active.jobId}.`);
      await pruneTerminalOrganizeArtifacts();
      if (await db.organizeJobs.get(jobId)) throw new TypeError(`Organize job ${jobId} already exists.`);
      await db.organizeJobs.add(job);
      await db.organizeTaxonomies.add(taxonomy);
      if (items.length > 0) await db.organizeItems.bulkAdd(items);
    },
  );
  return job;
}

export async function createOrganizePreflight(
  input: CreateOrganizePreflightInput,
): Promise<OrganizeJobRecord> {
  validateCreateInput(input);
  if (!isPreflightToken(input.preflightToken)) {
    throw new TypeError('Organize preflight token is malformed.');
  }
  if (!input.requestId.trim()) throw new TypeError('Organize preflight requestId must be nonempty.');
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new TypeError('Organize preflight expiry must be later than its creation time.');
  }
  const jobId = input.jobId ?? createOrganizeJobId();
  const repositoryIds = [...input.frozenScope.repositoryIds];
  if (repositoryIds.length === 0) {
    throw new TypeError('Organize preflight requires at least one frozen repository.');
  }
  const job: OrganizeJobRecord = {
    jobId,
    controllerId: input.controllerId,
    sessionId: input.sessionId,
    runId: input.runId,
    generation: input.generation,
    proposalId: input.proposalId ?? `proposal:v1:${jobId}`,
    frozenScope: { ...input.frozenScope, repositoryIds },
    taskInstruction: input.taskInstruction,
    tagPolicy: createOrganizeTagPolicySnapshot(input.tagPolicy),
    budget: input.budget,
    usage: input.usage,
    nextFrozenIndex: 0,
    analysisPendingRanges: [],
    providerBinding: input.providerBinding ?? null,
    status: 'preflight_ready',
    preflight: {
      token: input.preflightToken,
      requestId: input.requestId,
      state: 'ready',
      expiresAt: input.expiresAt,
      consumedAt: null,
    },
    revision: 1,
    itemCount: repositoryIds.length,
    applyId: null,
    pauseRequested: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null,
  };
  const items = buildOrganizeItems(jobId, repositoryIds);
  const taxonomy: OrganizeTaxonomyRecord = {
    jobId,
    fingerprint: input.taxonomy.fingerprint,
    snapshot: input.taxonomy.snapshot,
    createdAt: now,
  };

  await db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeTaxonomies,
    async () => {
      const obsoletePreflights = (await db.organizeJobs.toArray()).filter((candidate) => (
        candidate.status === 'preflight_ready'
        && candidate.preflight?.state === 'ready'
        && (
          candidate.preflight.expiresAt <= now
          || (
            candidate.controllerId === input.controllerId
            && candidate.sessionId === input.sessionId
          )
        )
      ));
      for (const previous of obsoletePreflights) {
        await db.organizeItems.where('jobId').equals(previous.jobId).delete();
        await db.organizeTaxonomies.delete(previous.jobId);
        await db.organizeJobs.delete(previous.jobId);
      }
      if (await db.organizeJobs.get(jobId)) {
        throw new TypeError(`Organize job ${jobId} already exists.`);
      }
      await db.organizeJobs.add(job);
      await db.organizeTaxonomies.add(taxonomy);
      await db.organizeItems.bulkAdd(items);
    },
  );
  return job;
}

export async function getReadyOrganizePreflight(input: Readonly<{
  controllerId: string;
  sessionId: string;
  now?: number;
}>): Promise<OrganizeJobRecord | null> {
  const now = input.now ?? Date.now();
  const result = await db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeTaxonomies,
    async () => {
      const candidates = (await db.organizeJobs.toArray())
        .filter((job) => (
          job.status === 'preflight_ready'
          && job.preflight?.state === 'ready'
          && job.controllerId === input.controllerId
          && job.sessionId === input.sessionId
        ))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      const ready = candidates[0];
      if (!ready) return null;
      if (ready.preflight!.expiresAt > now) return ready;
      await deleteOrganizePreflightArtifacts(ready.jobId);
      return null;
    },
  );
  return result;
}

export async function getOrganizePreflightByToken(
  preflightToken: string,
): Promise<OrganizeJobRecord | null> {
  if (!isPreflightToken(preflightToken)) {
    throw new TypeError('Organize preflight token is malformed.');
  }
  return (await db.organizeJobs.toArray()).find((job) => (
    job.preflight?.token === preflightToken
  )) ?? null;
}

export async function activateOrganizePreflight(input: Readonly<{
  preflightToken: string;
  controllerId: string;
  sessionId: string;
  taskInstruction: string;
  now?: number;
}>): Promise<Readonly<{
  disposition: 'started' | 'already_started';
  job: OrganizeJobRecord;
}>> {
  if (!isPreflightToken(input.preflightToken)) {
    throw new TypeError('Organize preflight token is malformed.');
  }
  for (const [field, value] of [
    ['controllerId', input.controllerId],
    ['sessionId', input.sessionId],
    ['taskInstruction', input.taskInstruction],
  ] as const) {
    if (!value.trim()) throw new TypeError(`Organize preflight ${field} must be nonempty.`);
  }
  const now = input.now ?? Date.now();
  const outcome = await db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeTaxonomies,
    async () => {
      const job = (await db.organizeJobs.toArray()).find((candidate) => (
        candidate.preflight?.token === input.preflightToken
      ));
      if (!job || !job.preflight) return { kind: 'missing' as const };
      if (job.controllerId !== input.controllerId || job.sessionId !== input.sessionId) {
        return { kind: 'wrong_owner' as const };
      }
      if (job.preflight.state === 'consumed') {
        return REPLAYABLE_ORGANIZE_PREFLIGHT_STATUSES.has(job.status)
          && job.activeSlot === ORGANIZE_ACTIVE_SLOT
          ? { kind: 'active' as const, job }
          : { kind: 'missing' as const };
      }
      if (job.taskInstruction !== input.taskInstruction) {
        return { kind: 'instruction_changed' as const };
      }
      if (job.status !== 'preflight_ready') return { kind: 'missing' as const };
      if (job.preflight.expiresAt <= now) {
        await deleteOrganizePreflightArtifacts(job.jobId);
        return { kind: 'expired' as const };
      }
      const active = await findActiveJob(ORGANIZE_ACTIVE_SLOT);
      if (active && active.jobId !== job.jobId) return { kind: 'active_conflict' as const };
      const started: OrganizeJobRecord = {
        ...job,
        activeSlot: ORGANIZE_ACTIVE_SLOT,
        status: 'analyzing',
        preflight: {
          ...job.preflight,
          state: 'consumed',
          consumedAt: now,
        },
        revision: job.revision + 1,
        updatedAt: now,
      };
      await db.organizeJobs.put(started);
      return { kind: 'started' as const, job: started };
    },
  );
  if (outcome.kind === 'started') {
    return Object.freeze({ disposition: 'started', job: outcome.job });
  }
  if (outcome.kind === 'active') {
    return Object.freeze({ disposition: 'already_started', job: outcome.job });
  }
  if (outcome.kind === 'expired') throw new TypeError('Organize preflight has expired.');
  if (outcome.kind === 'wrong_owner') {
    throw new TypeError('Organize preflight belongs to another controller or session.');
  }
  if (outcome.kind === 'instruction_changed') {
    throw new TypeError('Organize preflight instruction changed after the scope was frozen.');
  }
  if (outcome.kind === 'active_conflict') {
    throw new TypeError('An active OrganizeJobRun already exists.');
  }
  throw new TypeError('Organize preflight token is invalid or stale.');
}

export async function cancelOrganizePreflight(input: Readonly<{
  controllerId: string;
  sessionId: string;
  requestId: string;
  now?: number;
}>): Promise<boolean> {
  return db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeTaxonomies,
    async () => {
      const job = (await db.organizeJobs.toArray()).find((candidate) => (
        candidate.status === 'preflight_ready'
        && candidate.preflight?.state === 'ready'
        && candidate.preflight.requestId === input.requestId
        && candidate.controllerId === input.controllerId
        && candidate.sessionId === input.sessionId
      ));
      if (!job) return false;
      await deleteOrganizePreflightArtifacts(job.jobId);
      return true;
    },
  );
}

export async function getActiveOrganizeJob(
  activeSlot = ORGANIZE_ACTIVE_SLOT,
): Promise<OrganizeJobRecord | undefined> {
  return findActiveJob(activeSlot);
}

export async function getOrganizeJob(jobId: string): Promise<OrganizeJobRecord | undefined> {
  return db.organizeJobs.get(jobId);
}

export async function getOrganizeJobForRun(
  runId: string,
  generation?: number,
): Promise<OrganizeJobRecord | undefined> {
  const jobs = await db.organizeJobs.toArray();
  return jobs
    .filter((job) => job.runId === runId && (generation === undefined || job.generation === generation))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

export async function getLatestOrganizeJob(): Promise<OrganizeJobRecord | undefined> {
  return (await db.organizeJobs.orderBy('updatedAt').reverse().toArray())[0];
}

export async function getOrganizeTaxonomy(
  jobId: string,
): Promise<OrganizeTaxonomyRecord | undefined> {
  return db.organizeTaxonomies.get(jobId);
}

export async function attachOrganizeJob(input: Readonly<{
  jobId: string;
  controllerId: string;
  sessionId: string;
  expectedRevision?: number;
  now?: number;
}>): Promise<OrganizeJobRecord> {
  if (!input.controllerId.trim() || !input.sessionId.trim()) {
    throw new TypeError('Attach controllerId and sessionId must be nonempty.');
  }
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, async () => {
    const job = await requireJob(input.jobId);
    if (input.expectedRevision !== undefined) {
      requireJobRevision(job, input.expectedRevision);
    }
    if (job.status === 'cancelled') {
      throw new TypeError('Cannot attach to a cancelled organize job.');
    }
    if (job.controllerId === input.controllerId && job.sessionId === input.sessionId) {
      return job;
    }
    const attached = {
      ...job,
      controllerId: input.controllerId,
      sessionId: input.sessionId,
      revision: job.revision + 1,
      updatedAt: now,
    };
    await db.organizeJobs.put(attached);
    return attached;
  });
}

export async function claimOrganizeAnalysisBatch(
  jobId: string,
  limit = ORGANIZE_ANALYSIS_BATCH_DEFAULT,
  lease: OrganizeLeaseOptions,
): Promise<Readonly<{
  leaseToken: string;
  leaseExpiresAt: number;
  items: readonly OrganizeItemRecord[];
}> | null> {
  assertLimit(limit, ORGANIZE_ANALYSIS_BATCH_MAX, 'analysis batch');
  const now = lease.now ?? Date.now();
  const durationMs = lease.durationMs ?? ORGANIZE_DEFAULT_LEASE_MS;
  assertLease(lease.ownerId, durationMs);
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(jobId);
    if (job.status !== 'analyzing') return null;
    await recoverAnalysisLeases(jobId, now);
    const pending = await db.organizeItems
      .where('[jobId+analysisState]')
      .equals([jobId, 'pending'])
      .sortBy('position');
    const selected = pending.slice(0, limit);
    if (selected.length === 0) {
      await finishAnalysisIfCovered(job, now);
      return null;
    }
    const leaseToken = newId('organize-analysis-lease');
    const leaseExpiresAt = now + durationMs;
    const claimed = selected.map((row): OrganizeItemRecord => ({
      ...row,
      analysisState: 'leased',
      leaseToken,
      leaseOwner: lease.ownerId,
      leaseExpiresAt,
    }));
    await db.organizeItems.bulkPut(claimed);
    await db.organizeJobs.update(jobId, { revision: job.revision + 1, updatedAt: now });
    return Object.freeze({ leaseToken, leaseExpiresAt, items: Object.freeze(claimed) });
  });
}

/**
 * Leases the exact contiguous page already admitted by the OrganizeJobRun scheduler.
 * IndexedDB validates that window; it does not choose a competing page.
 */
export async function reserveOrganizeAnalysisPage(input: Readonly<{
  jobId: string;
  runId: RunId;
  generation: number;
  expectedRevision: number;
  startFrozenIndex: number;
  endFrozenIndexExclusive: number;
  previousUsage: RunBudgetUsage;
  usage: RunBudgetUsage;
  lease: OrganizeLeaseOptions;
}>): Promise<Readonly<{
  leaseToken: string;
  leaseExpiresAt: number;
  items: readonly OrganizeItemRecord[];
  job: OrganizeJobRecord;
}> | null> {
  const length = input.endFrozenIndexExclusive - input.startFrozenIndex;
  assertLimit(length, ORGANIZE_ANALYSIS_BATCH_MAX, 'analysis page');
  const now = input.lease.now ?? Date.now();
  const durationMs = input.lease.durationMs ?? ORGANIZE_ANALYSIS_LEASE_MS;
  assertLease(input.lease.ownerId, durationMs);
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    requireAnalysisIdentity(job, input.runId, input.generation);
    requireJobRevision(job, input.expectedRevision);
    if (job.status !== 'analyzing') return null;
    assertUsageEquals(job.usage, input.previousUsage, 'Organize analysis page usage is stale.');
    validateAnalyzerBatchReservation(input.previousUsage, input.usage);
    await recoverAnalysisLeases(input.jobId, now);
    if (input.startFrozenIndex !== job.nextFrozenIndex) {
      throw new TypeError('Organize analysis page does not start at the durable cursor.');
    }
    if (input.endFrozenIndexExclusive > job.itemCount) {
      throw new RangeError('Organize analysis page exceeds the frozen scope.');
    }
    validateDurableAnalysisWindow(
      job,
      input.startFrozenIndex,
      input.endFrozenIndexExclusive,
    );
    const items = await db.organizeItems
      .where('[jobId+position]')
      .between(
        [input.jobId, input.startFrozenIndex],
        [input.jobId, input.endFrozenIndexExclusive - 1],
        true,
        true,
      )
      .sortBy('position');
    validateLedgerWindow(job, items, input.startFrozenIndex, input.endFrozenIndexExclusive);
    if (items.some((row) => row.analysisState === 'leased')) return null;
    if (items.some((row) => row.analysisState !== 'pending')) {
      throw new TypeError('Organize analysis page contains an already settled row.');
    }
    const leaseToken = newId('organize-analysis-lease');
    const leaseExpiresAt = now + durationMs;
    const leased = items.map((row): OrganizeItemRecord => ({
      ...row,
      analysisState: 'leased',
      leaseToken,
      leaseOwner: input.lease.ownerId,
      leaseExpiresAt,
    }));
    await db.organizeItems.bulkPut(leased);
    const next: OrganizeJobRecord = {
      ...job,
      usage: input.usage,
      revision: job.revision + 1,
      updatedAt: now,
    };
    await db.organizeJobs.put(next);
    return Object.freeze({
      leaseToken,
      leaseExpiresAt,
      items: Object.freeze(leased),
      job: next,
    });
  });
}

/** Persists one paid provider admission and renews its exact scheduler page lease. */
export async function reserveOrganizeAnalysisProviderAttempt(input: Readonly<{
  jobId: string;
  runId: RunId;
  generation: number;
  expectedRevision: number;
  leaseToken: string;
  previousUsage: RunBudgetUsage;
  usage: RunBudgetUsage;
  serializedRequestBytes: number;
  requestedOutputTokens: number;
  reservedAt: number;
  leaseDurationMs?: number;
}>): Promise<Readonly<{ leaseExpiresAt: number; job: OrganizeJobRecord }>> {
  const durationMs = input.leaseDurationMs ?? ORGANIZE_ANALYSIS_LEASE_MS;
  assertLease(input.leaseToken, durationMs);
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    requireAnalysisIdentity(job, input.runId, input.generation);
    requireJobRevision(job, input.expectedRevision);
    if (job.status !== 'analyzing') throw new TypeError('Organize analysis is not active.');
    assertUsageEquals(job.usage, input.previousUsage, 'Organize provider attempt usage is stale.');
    validateProviderAttemptReservation({
      reservedAt: input.reservedAt,
      serializedRequestBytes: input.serializedRequestBytes,
      requestedOutputTokens: input.requestedOutputTokens,
      previousUsage: input.previousUsage,
      usage: input.usage,
    });
    const claimed = await claimedAnalysisRows(input.jobId, input.leaseToken);
    if (claimed.length === 0) throw new TypeError('Organize analysis lease is stale or empty.');
    if (claimed.some((row) => (row.leaseExpiresAt ?? -Infinity) <= input.reservedAt)) {
      throw new TypeError('Organize analysis lease has expired.');
    }
    const start = claimed[0]!.position;
    const end = claimed.at(-1)!.position + 1;
    validateLedgerWindow(job, claimed, start, end);
    if (start !== job.nextFrozenIndex) {
      throw new TypeError('Organize provider attempt page is stale.');
    }
    const leaseExpiresAt = input.reservedAt + durationMs;
    await db.organizeItems.bulkPut(claimed.map((row) => ({ ...row, leaseExpiresAt })));
    const next: OrganizeJobRecord = {
      ...job,
      usage: input.usage,
      revision: job.revision + 1,
      updatedAt: input.reservedAt,
    };
    await db.organizeJobs.put(next);
    return Object.freeze({ leaseExpiresAt, job: next });
  });
}

/** Releases only the still-owned analysis page; a stale token cannot affect a replacement worker. */
export async function releaseOrganizeAnalysisPage(input: Readonly<{
  jobId: string;
  leaseToken: string;
  now?: number;
}>): Promise<boolean> {
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    const claimed = await claimedAnalysisRows(input.jobId, input.leaseToken);
    if (claimed.length === 0) return false;
    await db.organizeItems.bulkPut(claimed.map((row) => ({
      ...clearAnalysisLease(row),
      retryCount: row.retryCount + 1,
      failure: 'worker_restarted',
    })));
    await db.organizeJobs.put({
      ...job,
      status: 'analyzing',
      revision: job.revision + 1,
      updatedAt: now,
    });
    return true;
  });
}

/** Commits one scheduler page and advances the durable cursor atomically. */
export async function checkpointOrganizeAnalysisPage(input: Readonly<{
  jobId: string;
  runId: RunId;
  generation: number;
  expectedRevision: number;
  leaseToken: string;
  expectedNextFrozenIndex: number;
  outcomes: readonly OrganizeAnalysisOutcome[];
  usage: RunBudgetUsage;
  analysisPendingRanges: readonly OrganizeAnalysisRange[];
  providerBinding?: unknown;
  now?: number;
}>): Promise<Readonly<{
  job: OrganizeJobRecord;
  coverage: OrganizeCoverage;
}>> {
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    requireAnalysisIdentity(job, input.runId, input.generation);
    requireJobRevision(job, input.expectedRevision);
    if (job.status !== 'analyzing') throw new TypeError('Organize analysis is not active.');
    const claimed = await claimedAnalysisRows(input.jobId, input.leaseToken);
    if (claimed.length === 0) throw new TypeError('Organize analysis lease is stale or empty.');
    if (claimed.some((row) => (row.leaseExpiresAt ?? -Infinity) <= now)) {
      throw new TypeError('Organize analysis lease has expired.');
    }
    const start = claimed[0]!.position;
    const end = claimed.at(-1)!.position + 1;
    validateLedgerWindow(job, claimed, start, end);
    if (start !== job.nextFrozenIndex || end !== input.expectedNextFrozenIndex) {
      throw new TypeError('Organize analysis checkpoint cursor is stale.');
    }
    validateAnalysisCheckpointSplitState(job, end, input);
    const outcomes = new Map(input.outcomes.map((outcome) => [outcome.position, outcome]));
    if (outcomes.size !== claimed.length || claimed.some((row) => !outcomes.has(row.position))) {
      throw new TypeError('Analysis checkpoint must cover the exact leased page.');
    }
    const tagPolicy = createOrganizeTagPolicySnapshot(job.tagPolicy);
    const settled = claimed.map((row) => settleAnalysisRow(
      row,
      outcomes.get(row.position)!,
      now,
      tagPolicy.maxTagsPerRepo,
    ));
    await db.organizeItems.bulkPut(settled);
    let coverage = await coverageForJob(input.jobId);
    const firstFailed = settled.find((row) => row.analysisState === 'failed')?.position ?? null;
    const complete = coverage.complete && end === job.itemCount;
    if (coverage.complete && end !== job.itemCount) {
      throw new TypeError('Organize coverage cannot complete before the frozen cursor reaches the end.');
    }
    if (complete) {
      await reconcileStoredOrganizeTagCoverage(input.jobId, tagPolicy);
      coverage = await coverageForJob(input.jobId);
    }
    const next: OrganizeJobRecord = {
      ...job,
      tagPolicy,
      usage: input.usage,
      providerBinding: input.providerBinding ?? job.providerBinding,
      nextFrozenIndex: end,
      analysisPendingRanges: [...input.analysisPendingRanges],
      status: firstFailed !== null ? 'analysis_blocked' : complete ? 'review' : 'analyzing',
      revision: job.revision + 1,
      updatedAt: now,
    };
    if (complete) await validateOrganizeLedger(next);
    await db.organizeJobs.put(next);
    return Object.freeze({ job: next, coverage });
  });
}

/** Releases a failed page and persists its depth-first child work ranges. */
export async function splitOrganizeAnalysisPage(input: Readonly<{
  jobId: string;
  runId: RunId;
  generation: number;
  expectedRevision: number;
  leaseToken: string;
  now?: number;
}>): Promise<Readonly<{
  job: OrganizeJobRecord;
  pendingRanges: readonly OrganizeAnalysisRange[];
}>> {
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    requireAnalysisIdentity(job, input.runId, input.generation);
    requireJobRevision(job, input.expectedRevision);
    if (job.status !== 'analyzing') throw new TypeError('Organize analysis is not active.');
    const claimed = await claimedAnalysisRows(input.jobId, input.leaseToken);
    if (claimed.length <= 1) throw new TypeError('A singleton organize analysis page cannot be split.');
    if (claimed.some((row) => (row.leaseExpiresAt ?? -Infinity) <= now)) {
      throw new TypeError('Organize analysis lease has expired.');
    }
    const start = claimed[0]!.position;
    const end = claimed.at(-1)!.position + 1;
    validateLedgerWindow(job, claimed, start, end);
    if (start !== job.nextFrozenIndex) throw new TypeError('Organize analysis split page is stale.');
    validateAnalysisRanges(job.analysisPendingRanges ?? [], job.nextFrozenIndex, job.itemCount);
    const currentRange = job.analysisPendingRanges?.[0];
    if (
      currentRange
      && (
        currentRange.startFrozenIndex !== start
        || currentRange.endFrozenIndexExclusive !== end
      )
    ) {
      throw new TypeError('Organize analysis split page does not match its pending range.');
    }
    const depth = (currentRange?.depth ?? 0) + 1;
    const middle = start + Math.floor(claimed.length / 2);
    const pendingRanges: OrganizeAnalysisRange[] = [
      { startFrozenIndex: start, endFrozenIndexExclusive: middle, depth },
      { startFrozenIndex: middle, endFrozenIndexExclusive: end, depth },
      ...(job.analysisPendingRanges ?? []).slice(currentRange ? 1 : 0),
    ];
    validateAnalysisRanges(pendingRanges, job.nextFrozenIndex, job.itemCount);
    await db.organizeItems.bulkPut(claimed.map((row) => ({
      ...clearAnalysisLease(row),
    })));
    const next: OrganizeJobRecord = {
      ...job,
      analysisPendingRanges: pendingRanges,
      revision: job.revision + 1,
      updatedAt: now,
    };
    await db.organizeJobs.put(next);
    return Object.freeze({ job: next, pendingRanges: Object.freeze(pendingRanges) });
  });
}

/** Binds the current analysis provider without changing durable run phase or progress. */
export async function bindOrganizeJobProvider(input: Readonly<{
  jobId: string;
  runId: RunId;
  generation: number;
  providerBinding: unknown;
  now?: number;
}>): Promise<OrganizeJobRecord> {
  if (input.providerBinding === null || input.providerBinding === undefined) {
    throw new TypeError('Organize provider binding is required.');
  }
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, async () => {
    const job = await requireJob(input.jobId);
    requireAnalysisIdentity(job, input.runId, input.generation);
    if (!['analyzing', 'analysis_blocked', 'review'].includes(job.status)) {
      throw new TypeError('Organize provider binding requires an analysis or review job.');
    }
    if (job.providerBinding !== null && job.providerBinding !== undefined) {
      throw new TypeError('Organize analysis provider is already bound.');
    }
    const next: OrganizeJobRecord = {
      ...job,
      providerBinding: input.providerBinding,
      revision: job.revision + 1,
      updatedAt: now,
    };
    await db.organizeJobs.put(next);
    return next;
  });
}

export async function advanceOrganizeJobRun(input: Readonly<{
  jobId: string;
  controllerId: string;
  sessionId: string;
  runId: RunId;
  generation: number;
  expectedParent?: Readonly<{ runId: RunId; generation: number }>;
  proposalId: ProposalId;
  budget: RunBudget;
  usage: RunBudgetUsage;
  providerBinding?: unknown;
  startFrozenIndex: number;
  analysisPendingRanges: readonly OrganizeAnalysisRange[];
  now?: number;
}>): Promise<OrganizeJobRecord> {
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    if (job.status === 'review') {
      throw new TypeError('A review-ready organize job cannot start another analysis run.');
    }
    if (job.status !== 'analyzing') {
      throw new TypeError('Only an actively analyzing organize job can start another analysis run.');
    }
    if ((await coverageForJob(input.jobId)).complete) {
      throw new TypeError('An organize job with complete coverage cannot start another analysis run.');
    }
    const sameDurableIdentity = input.runId === job.runId && input.generation === job.generation;
    if (!sameDurableIdentity) {
      if (input.generation < job.generation) {
        throw new TypeError('Organize run generation cannot move backwards.');
      }
      if (input.generation === job.generation) {
        throw new TypeError('A different organize run cannot replace the current durable identity at the same generation.');
      }
      if (!input.expectedParent) {
        throw new TypeError('A new organize generation requires parent authority.');
      }
      if (
        input.expectedParent.runId !== job.runId
        || input.expectedParent.generation !== job.generation
      ) {
        throw new TypeError('Organize continuation parent authority does not match the current durable identity.');
      }
      if (input.generation !== input.expectedParent.generation + 1) {
        throw new TypeError('Organize continuation generation must advance exactly once from its parent.');
      }
    }
    if (input.startFrozenIndex < 0 || input.startFrozenIndex > job.itemCount) {
      throw new RangeError('Organize run start is outside the frozen scope.');
    }
    // Generation transitions must carry the durable split worklist unchanged.
    const durablePendingRanges = job.analysisPendingRanges ?? [];
    validateAnalysisRanges(input.analysisPendingRanges, input.startFrozenIndex, job.itemCount);
    const rewinding = input.startFrozenIndex < job.nextFrozenIndex;
    if (rewinding) {
      if (input.analysisPendingRanges.length > 0) {
        throw new TypeError('A rewound organize analysis must clear its pending range worklist.');
      }
      const suffix = await db.organizeItems
        .where('jobId')
        .equals(input.jobId)
        .filter((row) => row.position >= input.startFrozenIndex)
        .toArray();
      await db.organizeItems.bulkPut(suffix.map(resetAnalysisRow));
    } else if (input.startFrozenIndex !== job.nextFrozenIndex) {
      throw new TypeError('Organize continuation must start at the durable cursor.');
    } else {
      validateAnalysisRanges(durablePendingRanges, job.nextFrozenIndex, job.itemCount);
      if (!sameAnalysisRanges(input.analysisPendingRanges, durablePendingRanges)) {
        throw new TypeError('Organize continuation pending range worklist is stale.');
      }
    }
    const next: OrganizeJobRecord = {
      ...job,
      controllerId: input.controllerId,
      sessionId: input.sessionId,
      runId: input.runId,
      generation: input.generation,
      proposalId: input.proposalId,
      budget: input.budget,
      usage: input.usage,
      providerBinding: input.providerBinding ?? job.providerBinding,
      nextFrozenIndex: input.startFrozenIndex,
      analysisPendingRanges: input.analysisPendingRanges.map((range) => ({ ...range })),
      status: 'analyzing',
      revision: job.revision + 1,
      updatedAt: now,
    };
    await db.organizeJobs.put(next);
    return next;
  });
}

export async function retryOrganizeAnalysisFromFirstFailure(
  jobId: string,
  now = Date.now(),
): Promise<OrganizeJobRecord> {
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(jobId);
    if (job.status !== 'analysis_blocked') {
      throw new TypeError('Only an analysis-blocked organize job can retry.');
    }
    const failed = await db.organizeItems
      .where('[jobId+analysisState]')
      .equals([jobId, 'failed'])
      .sortBy('position');
    const retryFrom = failed[0]?.position;
    if (retryFrom === undefined) throw new TypeError('Blocked organize job has no failed row.');
    const suffix = await db.organizeItems
      .where('jobId')
      .equals(jobId)
      .filter((row) => row.position >= retryFrom)
      .toArray();
    await db.organizeItems.bulkPut(suffix.map(resetAnalysisRow));
    const next: OrganizeJobRecord = {
      ...job,
      nextFrozenIndex: retryFrom,
      analysisPendingRanges: [],
      status: 'analyzing',
      revision: job.revision + 1,
      updatedAt: now,
    };
    await db.organizeJobs.put(next);
    return next;
  });
}

export async function restoreOrganizeAnalysisCheckpoint(jobId: string): Promise<Readonly<{
  job: OrganizeJobRecord;
  taxonomy: OrganizeTaxonomyRecord;
  items: readonly OrganizeItemRecord[];
  resumeFrozenIndex: number;
}>> {
  await recoverExpiredOrganizeLeases();
  const job = await requireJob(jobId);
  validateAnalysisRanges(job.analysisPendingRanges ?? [], job.nextFrozenIndex, job.itemCount);
  const taxonomy = await getOrganizeTaxonomy(jobId);
  if (!taxonomy) throw new TypeError('Organize job taxonomy snapshot is missing.');
  const items = await validateOrganizeLedger(job, false);
  const firstUnresolved = items.find((row) => row.analysisState === 'pending' || row.analysisState === 'leased');
  const firstFailed = items.find((row) => row.analysisState === 'failed');
  return Object.freeze({
    job,
    taxonomy,
    items: Object.freeze(items),
    resumeFrozenIndex: firstFailed?.position ?? firstUnresolved?.position ?? job.itemCount,
  });
}

export async function settleOrganizeAnalysisBatch(input: Readonly<{
  jobId: string;
  leaseToken: string;
  outcomes: readonly OrganizeAnalysisOutcome[];
  usage?: unknown;
  providerBinding?: unknown;
  now?: number;
}>): Promise<OrganizeCoverage> {
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    if (job.status !== 'analyzing') throw new TypeError('Organize analysis is not active.');
    const claimed = await db.organizeItems
      .where('jobId')
      .equals(input.jobId)
      .filter((row) => row.analysisState === 'leased' && row.leaseToken === input.leaseToken)
      .sortBy('position');
    if (claimed.length === 0) throw new TypeError('Organize analysis lease is stale or empty.');
    if (claimed.some((row) => (row.leaseExpiresAt ?? -Infinity) <= now)) {
      throw new TypeError('Organize analysis lease has expired.');
    }
    const outcomes = new Map(input.outcomes.map((outcome) => [outcome.position, outcome]));
    if (outcomes.size !== claimed.length || claimed.some((row) => !outcomes.has(row.position))) {
      throw new TypeError('Analysis settlement must cover the exact claimed batch.');
    }
    const tagPolicy = createOrganizeTagPolicySnapshot(job.tagPolicy);
    const settled = claimed.map((row) => settleAnalysisRow(
      row,
      outcomes.get(row.position)!,
      now,
      tagPolicy.maxTagsPerRepo,
    ));
    await db.organizeItems.bulkPut(settled);
    const unresolved = await firstUnresolvedPosition(input.jobId);
    const nextRevision = job.revision + 1;
    await db.organizeJobs.update(input.jobId, {
      tagPolicy,
      usage: input.usage ?? job.usage,
      providerBinding: input.providerBinding ?? job.providerBinding,
      nextFrozenIndex: unresolved ?? job.itemCount,
      revision: nextRevision,
      updatedAt: now,
    });
    let coverage = await coverageForJob(input.jobId);
    if (coverage.complete) {
      await reconcileStoredOrganizeTagCoverage(input.jobId, tagPolicy);
      coverage = await coverageForJob(input.jobId);
      await db.organizeJobs.update(input.jobId, {
        status: 'review',
        revision: nextRevision + 1,
        updatedAt: now,
      });
    } else if (coverage.pending === 0 && coverage.leased === 0 && coverage.failed > 0) {
      await db.organizeJobs.update(input.jobId, {
        status: 'analysis_blocked',
        revision: nextRevision + 1,
        updatedAt: now,
      });
    }
    return coverage;
  });
}

export async function getOrganizeCoverage(jobId: string): Promise<OrganizeCoverage> {
  await requireJob(jobId);
  return coverageForJob(jobId);
}

export async function getOrganizeReviewPage(
  jobId: string,
  cursor: number | null = null,
  limit = 100,
): Promise<OrganizeReviewPage> {
  assertLimit(limit, 100, 'review page');
  const job = await requireJob(jobId);
  const rows = (await db.organizeItems
    .where('[jobId+analysisState]')
    .equals([jobId, 'actionable'])
    .sortBy('position'))
    .filter((row) => cursor === null || row.position > cursor)
    .slice(0, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return Object.freeze({
    jobId,
    revision: job.revision,
    rows: Object.freeze(page),
    nextCursor: hasMore ? page.at(-1)?.position ?? null : null,
  });
}

export async function getOrganizeReviewPageAtOffset(
  jobId: string,
  rowOffset = 0,
  limit = 100,
): Promise<OrganizeReviewPage & Readonly<{ rowOffset: number; nextRowOffset: number | null }>> {
  assertLimit(limit, 100, 'review page');
  if (!Number.isSafeInteger(rowOffset) || rowOffset < 0) {
    throw new RangeError('Review rowOffset must be a nonnegative safe integer.');
  }
  const job = await requireJob(jobId);
  const actionable = await db.organizeItems
    .where('[jobId+analysisState]')
    .equals([jobId, 'actionable'])
    .sortBy('position');
  const rows = actionable.slice(rowOffset, rowOffset + limit);
  const nextRowOffset = rowOffset + rows.length < actionable.length
    ? rowOffset + rows.length
    : null;
  return Object.freeze({
    jobId,
    revision: job.revision,
    rows: Object.freeze(rows),
    nextCursor: rows.length > 0 ? rows.at(-1)!.position : null,
    rowOffset,
    nextRowOffset,
  });
}

export async function getOrganizeSelectionSummary(
  jobId: string,
): Promise<OrganizeSelectionSummary> {
  await requireJob(jobId);
  const actionable = await db.organizeItems
    .where('[jobId+analysisState]')
    .equals([jobId, 'actionable'])
    .toArray();
  const selected = actionable.filter((row) => row.selected);
  return Object.freeze({
    actionableRepositories: actionable.length,
    selectedRepositories: selected.length,
    selectedActions: selected.reduce((sum, row) => sum + row.approvedActions.length, 0),
  });
}

export async function setAllOrganizeSelections(input: Readonly<{
  jobId: string;
  expectedRevision: number;
  selected: boolean;
  now?: number;
}>): Promise<OrganizeJobRecord> {
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    requireReviewRevision(job, input.expectedRevision);
    const rows = await db.organizeItems
      .where('[jobId+analysisState]')
      .equals([input.jobId, 'actionable'])
      .toArray();
    await db.organizeItems.bulkPut(rows.map((row) => ({
      ...row,
      selected: input.selected,
      approvedActions: input.selected
        ? row.proposedActions.map((action) => ({ ...action }))
        : row.approvedActions,
    })));
    const next = { ...job, revision: job.revision + 1, updatedAt: now };
    await db.organizeJobs.put(next);
    return next;
  });
}

export async function completeOrganizeJobWithoutApply(
  jobId: string,
  now = Date.now(),
): Promise<OrganizeJobRecord> {
  return db.transaction('rw', db.organizeJobs, db.organizeItems, db.organizeTaxonomies, async () => {
    const job = await requireJob(jobId);
    if (job.status !== 'review') throw new TypeError('No-change completion requires review-ready coverage.');
    const coverage = await coverageForJob(jobId);
    if (!coverage.complete || coverage.actionable !== 0) {
      throw new TypeError('No-change completion requires complete coverage without actions.');
    }
    await validateOrganizeLedger(job);
    const completed: OrganizeJobRecord = {
      ...job,
      activeSlot: undefined,
      status: 'completed',
      revision: job.revision + 1,
      updatedAt: now,
      completedAt: now,
    };
    await db.organizeItems.where('jobId').equals(jobId).delete();
    await db.organizeTaxonomies.delete(jobId);
    await db.organizeJobs.delete(jobId);
    return completed;
  });
}

export async function updateOrganizeSelection(input: Readonly<{
  jobId: string;
  expectedRevision: number;
  selections: readonly Readonly<{
    position: number;
    selected: boolean;
    approvedActions?: readonly OrganizeProposedAction[];
  }>[];
  now?: number;
}>): Promise<OrganizeJobRecord> {
  const now = input.now ?? Date.now();
  return db.transaction('rw', db.organizeJobs, db.organizeItems, async () => {
    const job = await requireJob(input.jobId);
    requireReviewRevision(job, input.expectedRevision);
    const unique = new Set(input.selections.map((entry) => entry.position));
    if (unique.size !== input.selections.length) throw new TypeError('Selection positions must be unique.');
    for (const selection of input.selections) {
      const row = await db.organizeItems.get(itemId(input.jobId, selection.position));
      if (!row || row.analysisState !== 'actionable') {
        throw new TypeError(`Selection position ${selection.position} is not actionable.`);
      }
      const approvedActions = selection.approvedActions
        ? selectApprovedActions(row.proposedActions, selection.approvedActions)
        : row.approvedActions;
      if (selection.selected && approvedActions.length === 0) {
        throw new TypeError('Selected organization rows require at least one approved action.');
      }
      await db.organizeItems.put({ ...row, selected: selection.selected, approvedActions });
    }
    const next = { ...job, revision: job.revision + 1, updatedAt: now };
    await db.organizeJobs.put(next);
    return next;
  });
}

export async function sealOrganizeApply(
  jobId: string,
  expectedRevision: number,
  now = Date.now(),
): Promise<OrganizeApplyRecord> {
  return db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeTaxonomies,
    db.organizeApplies,
    db.organizeApplyRows,
    async () => {
      const job = await requireJob(jobId);
      requireReviewRevision(job, expectedRevision);
      const selected = (await db.organizeItems
        .where('[jobId+analysisState]')
        .equals([jobId, 'actionable'])
        .sortBy('position'))
        .filter((row) => row.selected);
      const taxonomy = await db.organizeTaxonomies.get(jobId);
      if (!taxonomy) throw new TypeError('Organize Apply requires its frozen taxonomy.');
      const applyId = newId('organize-apply');
      const status = selected.length === 0 ? 'completed' : 'sealed';
      const apply: OrganizeApplyRecord = {
        applyId,
        jobId,
        sourceRevision: expectedRevision,
        expectedTaxonomyFingerprint: taxonomy.fingerprint,
        status,
        rowCount: selected.length,
        createdAt: now,
        updatedAt: now,
        completedAt: selected.length === 0 ? now : null,
      };
      const rows = selected.map((item): OrganizeApplyRowRecord => ({
        id: applyRowId(applyId, item.position),
        applyId,
        jobId,
        position: item.position,
        fullName: item.fullName,
        approvedActions: item.approvedActions.map((action) => ({ ...action })),
        approvedAdditions: item.approvedActions.map((action) => action.tag),
        sourceFingerprint: item.sourceFingerprint!,
        taxonomyFingerprint: taxonomy.fingerprint,
        state: 'pending',
        outcomeReason: null,
        attemptCount: 0,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        settledAt: null,
      }));
      await db.organizeApplies.add(apply);
      if (rows.length > 0) await db.organizeApplyRows.bulkAdd(rows);
      await db.organizeJobs.put({
        ...job,
        activeSlot: selected.length === 0 ? undefined : job.activeSlot,
        applyId,
        pauseRequested: false,
        status: selected.length === 0 ? 'completed' : 'apply_sealed',
        revision: job.revision + 1,
        updatedAt: now,
        completedAt: selected.length === 0 ? now : null,
      });
      return apply;
    },
  );
}

export async function claimOrganizeApplyChunk(
  applyId: string,
  max = ORGANIZE_APPLY_CHUNK_MAX,
  lease: OrganizeLeaseOptions = { ownerId: 'organize-apply' },
): Promise<Readonly<{
  leaseToken: string;
  leaseExpiresAt: number;
  rows: readonly OrganizeApplyRowRecord[];
}> | null> {
  assertLimit(max, ORGANIZE_APPLY_CHUNK_MAX, 'Apply chunk');
  const now = lease.now ?? Date.now();
  const durationMs = lease.durationMs ?? ORGANIZE_DEFAULT_LEASE_MS;
  assertLease(lease.ownerId, durationMs);
  return db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeApplies,
    db.organizeApplyRows,
    async () => {
      const apply = await requireApply(applyId);
      if (apply.status === 'completed' || apply.status === 'cancelled') return null;
      const job = await requireJob(apply.jobId);
      if (job.status === 'paused' || job.pauseRequested) return null;
      await recoverApplyLeases(applyId, now);
      const activeLease = await db.organizeApplyRows
        .where('[applyId+state]')
        .equals([applyId, 'leased'])
        .first();
      if (activeLease) return null;
      const pending = await db.organizeApplyRows
        .where('[applyId+state]')
        .equals([applyId, 'pending'])
        .sortBy('position');
      const selected = pending.slice(0, max);
      if (selected.length === 0) return null;
      const leaseToken = newId('organize-apply-lease');
      const leaseExpiresAt = now + durationMs;
      const claimed = selected.map((row): OrganizeApplyRowRecord => ({
        ...row,
        state: 'leased',
        attemptCount: row.attemptCount + 1,
        leaseToken,
        leaseOwner: lease.ownerId,
        leaseExpiresAt,
      }));
      await db.organizeApplyRows.bulkPut(claimed);
      await db.organizeApplies.put({ ...apply, status: 'applying', updatedAt: now });
      await db.organizeJobs.put({
        ...job,
        status: 'applying',
        revision: job.revision + 1,
        updatedAt: now,
      });
      return Object.freeze({ leaseToken, leaseExpiresAt, rows: Object.freeze(claimed) });
    },
  );
}

/** Revalidates and commits one claimed chunk; the sealed Apply itself has no 100-row cap. */
export async function settleOrganizeApplyChunk(input: Readonly<{
  applyId: string;
  leaseToken: string;
  now?: number;
}>): Promise<Readonly<{
  rows: readonly OrganizeApplyRowRecord[];
  complete: boolean;
}>> {
  const nowMs = input.now ?? Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const changedNames: string[] = [];
  const result = await db.transaction(
    'rw',
    [
      db.organizeJobs,
      db.organizeApplies,
      db.organizeApplyRows,
      db.organizeTaxonomies,
      db.stars,
      db.tags,
      db.tagMeta,
      db.tagDirtyOutbox,
    ],
    async () => {
      const apply = await requireApply(input.applyId);
      if (apply.status !== 'applying') throw new TypeError('Organize Apply is not applying.');
      const claimed = await db.organizeApplyRows
        .where('applyId')
        .equals(input.applyId)
        .filter((row) => row.state === 'leased' && row.leaseToken === input.leaseToken)
        .sortBy('position');
      if (claimed.length === 0) throw new TypeError('Organize Apply lease is stale or empty.');
      if (claimed.some((row) => (row.leaseExpiresAt ?? -Infinity) <= nowMs)) {
        throw new TypeError('Organize Apply lease has expired.');
      }
      const tagMeta = await db.tagMeta.toArray();
      const excluded = excludedCanonicalTagKeys(tagMeta);
      const frozenTaxonomy = await db.organizeTaxonomies.get(apply.jobId);
      if (!frozenTaxonomy) throw new TypeError('Organize Apply taxonomy snapshot is missing.');
      const rawTags = await db.tags.toArray();
      const currentTaxonomyFingerprint = await Dexie.waitFor(fingerprintSemanticTaxonomy(
        buildSemanticPolicyTaxonomyFromStorage(
          tagMeta,
          rawTags.map((rawTag) => normalizeStoredTag(rawTag as LegacyTagRow)),
        ),
      ));
      const validatesTaxonomy =
        isTaxonomyFingerprintV1(frozenTaxonomy.fingerprint) &&
        isTaxonomyFingerprintV1(apply.expectedTaxonomyFingerprint);
      const taxonomyChangedOutsideApply = validatesTaxonomy &&
        currentTaxonomyFingerprint !== apply.expectedTaxonomyFingerprint;
      const settled: OrganizeApplyRowRecord[] = [];
      for (const row of claimed) {
        const base = clearApplyLease(row, nowMs);
        if (
          isTaxonomyFingerprintV1(row.taxonomyFingerprint) &&
          (
            row.taxonomyFingerprint !== frozenTaxonomy.fingerprint ||
            taxonomyChangedOutsideApply
          )
        ) {
          settled.push({ ...base, state: 'skipped', outcomeReason: 'taxonomy_conflict' });
          continue;
        }
        const star = await db.stars.get(row.fullName);
        if (!star) {
          settled.push({ ...base, state: 'skipped', outcomeReason: 'missing' });
          continue;
        }
        if (star.tombstone) {
          settled.push({ ...base, state: 'skipped', outcomeReason: 'tombstoned' });
          continue;
        }
        const stored = await db.tags.get(row.fullName) as LegacyTagRow | undefined;
        const existing = stored ? normalizeStoredTag(stored) : emptyTag(row.fullName, timestamp);
        const fingerprint = await Dexie.waitFor(sourceFingerprintV1(star, stored ? existing : undefined));
        if (fingerprint !== row.sourceFingerprint) {
          settled.push({ ...base, state: 'skipped', outcomeReason: 'stale_source' });
          continue;
        }
        if (row.approvedAdditions.some((tag) => excluded.has(canonicalTag(tag)))) {
          settled.push({ ...base, state: 'skipped', outcomeReason: 'excluded_tag' });
          continue;
        }
        const manualTags = addTagNames(existing.manualTags, row.approvedAdditions);
        if (sameTagNames(existing.manualTags, manualTags)) {
          settled.push({ ...base, state: 'unchanged', outcomeReason: 'no_change' });
          continue;
        }
        await db.tags.put(normalizeStoredTag({
          ...existing,
          favorite: existing.favorite ?? false,
          manualTags,
          manualTagsMtime: timestamp,
          mtime: timestamp,
        }));
        await queueTagDirtyOutbox(row.fullName, timestamp);
        changedNames.push(row.fullName);
        settled.push({ ...base, state: 'changed', outcomeReason: null });
      }
      await db.organizeApplyRows.bulkPut(settled);
      const remaining = await db.organizeApplyRows
        .where('applyId')
        .equals(input.applyId)
        .filter((row) => row.state === 'pending' || row.state === 'leased')
        .count();
      const complete = remaining === 0;
      const expectedTaxonomyFingerprint = validatesTaxonomy && !taxonomyChangedOutsideApply
        ? await Dexie.waitFor(fingerprintSemanticTaxonomy(
            buildSemanticPolicyTaxonomyFromStorage(
              await db.tagMeta.toArray(),
              (await db.tags.toArray()).map((rawTag) => normalizeStoredTag(rawTag as LegacyTagRow)),
            ),
          ))
        : apply.expectedTaxonomyFingerprint;
      await db.organizeApplies.put({
        ...apply,
        expectedTaxonomyFingerprint,
        status: complete ? 'completed' : 'sealed',
        updatedAt: nowMs,
        completedAt: complete ? nowMs : null,
      });
      const job = await requireJob(apply.jobId);
      const paused = !complete && job.pauseRequested;
      await db.organizeJobs.put({
        ...job,
        activeSlot: complete ? undefined : job.activeSlot,
        status: complete ? 'completed' : paused ? 'paused' : 'apply_sealed',
        pauseRequested: false,
        revision: job.revision + 1,
        updatedAt: nowMs,
        completedAt: complete ? nowMs : null,
      });
      return Object.freeze({ rows: Object.freeze(settled), complete });
    },
  );
  markDirtyForLocalWrites(changedNames);
  return result;
}

export async function requestOrganizeApplyPause(
  jobId: string,
  now = Date.now(),
): Promise<OrganizeJobRecord> {
  return db.transaction('rw', db.organizeJobs, db.organizeApplyRows, async () => {
    const job = await requireJob(jobId);
    if (!job.applyId || !['apply_sealed', 'applying', 'paused'].includes(job.status)) {
      throw new TypeError('Only an active organize Apply can be paused.');
    }
    const leased = await db.organizeApplyRows
      .where('[applyId+state]')
      .equals([job.applyId, 'leased'])
      .count();
    const paused: OrganizeJobRecord = {
      ...job,
      status: leased === 0 ? 'paused' : job.status,
      pauseRequested: leased > 0,
      revision: job.revision + 1,
      updatedAt: now,
    };
    await db.organizeJobs.put(paused);
    return paused;
  });
}

export async function resumeOrganizeApply(
  jobId: string,
  expectedRevision: number,
  now = Date.now(),
): Promise<OrganizeJobRecord> {
  return db.transaction('rw', db.organizeJobs, async () => {
    const job = await requireJob(jobId);
    if (!job.applyId || job.status !== 'paused') {
      throw new TypeError('Only a paused organize Apply can resume.');
    }
    if (job.revision !== expectedRevision) throw new TypeError('Organize job revision is stale.');
    const resumed: OrganizeJobRecord = {
      ...job,
      status: 'apply_sealed',
      pauseRequested: false,
      revision: job.revision + 1,
      updatedAt: now,
    };
    await db.organizeJobs.put(resumed);
    return resumed;
  });
}

export async function getOrganizeReceipt(applyId: string): Promise<OrganizeReceipt | undefined> {
  const apply = await db.organizeApplies.get(applyId);
  if (!apply) return undefined;
  const rows = await db.organizeApplyRows.where('applyId').equals(applyId).sortBy('position');
  return Object.freeze({
    apply,
    rows: Object.freeze(rows),
    counts: Object.freeze({
      changed: rows.filter((row) => row.state === 'changed').length,
      unchanged: rows.filter((row) => row.state === 'unchanged').length,
      skipped: rows.filter((row) => row.state === 'skipped').length,
      failed: rows.filter((row) => row.state === 'failed').length,
      pending: rows.filter((row) => row.state === 'pending' || row.state === 'leased').length,
    }),
  });
}

export async function getOrganizeApplyProgress(
  applyId: string,
): Promise<OrganizeApplyProgress | undefined> {
  const apply = await db.organizeApplies.get(applyId);
  if (!apply) return undefined;
  const rows = await db.organizeApplyRows.where('applyId').equals(applyId).toArray();
  const changed = rows.filter((row) => row.state === 'changed').length;
  const unchanged = rows.filter((row) => row.state === 'unchanged').length;
  const skipped = rows.filter((row) => row.state === 'skipped').length;
  const failed = rows.filter((row) => row.state === 'failed').length;
  return Object.freeze({
    applyId,
    total: rows.length,
    settled: changed + unchanged + skipped + failed,
    changed,
    unchanged,
    skipped,
    failed,
  });
}

export async function getOrganizeReceiptPage(
  applyId: string,
  cursor: number | null = null,
  limit = 100,
  filter: 'all' | 'changed_or_failed' = 'all',
): Promise<OrganizeReceiptPage | undefined> {
  assertLimit(limit, 100, 'receipt page');
  if (!await db.organizeApplies.get(applyId)) return undefined;
  const rows = (await db.organizeApplyRows.where('applyId').equals(applyId).sortBy('position'))
    .filter((row) => cursor === null || row.position > cursor)
    .filter((row) => filter === 'all' || row.state === 'changed' || row.state === 'failed')
    .slice(0, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return Object.freeze({
    applyId,
    rows: Object.freeze(page),
    nextCursor: hasMore ? page.at(-1)?.position ?? null : null,
  });
}

export async function getOrganizeReceiptPageAtOffset(
  applyId: string,
  rowOffset = 0,
  limit = 100,
  filter: 'all' | 'changed_or_failed' = 'all',
): Promise<(OrganizeReceiptPage & Readonly<{
  rowOffset: number;
  nextRowOffset: number | null;
}> ) | undefined> {
  assertLimit(limit, 100, 'receipt page');
  if (!Number.isSafeInteger(rowOffset) || rowOffset < 0) {
    throw new RangeError('Receipt rowOffset must be a nonnegative safe integer.');
  }
  if (!await db.organizeApplies.get(applyId)) return undefined;
  const matching = (await db.organizeApplyRows.where('applyId').equals(applyId).sortBy('position'))
    .filter((row) => filter === 'all' || row.state === 'changed' || row.state === 'failed');
  const rows = matching.slice(rowOffset, rowOffset + limit);
  return Object.freeze({
    applyId,
    rows: Object.freeze(rows),
    nextCursor: rows.length > 0 ? rows.at(-1)!.position : null,
    rowOffset,
    nextRowOffset: rowOffset + rows.length < matching.length ? rowOffset + rows.length : null,
  });
}

export async function cancelOrganizeJob(jobId: string, _now = Date.now()): Promise<boolean> {
  return db.transaction('rw', db.organizeJobs, db.organizeItems, db.organizeTaxonomies, db.organizeApplies, db.organizeApplyRows, async () => {
    const job = await db.organizeJobs.get(jobId);
    if (!job || job.status === 'completed' || job.status === 'cancelled') return false;
    if (job.applyId || ['apply_sealed', 'applying', 'paused'].includes(job.status)) {
      throw new TypeError('A sealed organize Apply can only be paused or resumed.');
    }
    await db.organizeItems.where('jobId').equals(jobId).delete();
    await db.organizeTaxonomies.delete(jobId);
    await db.organizeJobs.delete(jobId);
    return true;
  });
}

export async function cleanupCompletedOrganizeJob(jobId: string): Promise<boolean> {
  return db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeTaxonomies,
    db.organizeApplies,
    db.organizeApplyRows,
    async () => {
      const job = await db.organizeJobs.get(jobId);
      if (!job) return false;
      if (job.status !== 'completed' && job.status !== 'cancelled') {
        throw new TypeError('Only terminal organize jobs can be cleaned up.');
      }
      await db.organizeItems.where('jobId').equals(jobId).delete();
      await db.organizeTaxonomies.delete(jobId);
      if (job.applyId) {
        const olderReceipts = (await db.organizeApplies.toArray()).filter((apply) => (
          apply.applyId !== job.applyId
          && (apply.status === 'completed' || apply.status === 'cancelled')
        ));
        for (const apply of olderReceipts) {
          await db.organizeApplyRows.where('applyId').equals(apply.applyId).delete();
          await db.organizeApplies.delete(apply.applyId);
        }
      }
      await db.organizeJobs.delete(jobId);
      return true;
    },
  );
}

/** Explicit receipt dismissal atomically removes its terminal job and durable artifacts. */
export async function dismissOrganizeReceipt(applyId: string): Promise<boolean> {
  return db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeTaxonomies,
    db.organizeApplies,
    db.organizeApplyRows,
    async () => {
      const apply = await db.organizeApplies.get(applyId);
      if (!apply) return false;
      if (apply.status !== 'completed' && apply.status !== 'cancelled') {
        throw new TypeError('Only terminal organize receipts can be dismissed.');
      }
      const job = await db.organizeJobs.get(apply.jobId);
      if (job) {
        if (job.applyId !== applyId || (job.status !== 'completed' && job.status !== 'cancelled')) {
          throw new TypeError('Only the terminal organize job that owns this receipt can be dismissed.');
        }
        await db.organizeItems.where('jobId').equals(job.jobId).delete();
        await db.organizeTaxonomies.delete(job.jobId);
        await db.organizeJobs.delete(job.jobId);
      }
      const olderReceipts = (await db.organizeApplies.toArray()).filter((record) => (
        record.applyId !== applyId &&
        (record.status === 'completed' || record.status === 'cancelled')
      ));
      for (const older of olderReceipts) {
        await db.organizeApplyRows.where('applyId').equals(older.applyId).delete();
        await db.organizeApplies.delete(older.applyId);
      }
      await db.organizeApplyRows.where('applyId').equals(applyId).delete();
      await db.organizeApplies.delete(applyId);
      return true;
    },
  );
}

export async function recoverExpiredOrganizeLeases(now = Date.now()): Promise<Readonly<{
  analysis: number;
  apply: number;
}>> {
  return db.transaction('rw', db.organizeJobs, db.organizeItems, db.organizeApplies, db.organizeApplyRows, async () => {
    const expiredAnalysis = await db.organizeItems
      .where('leaseExpiresAt')
      .belowOrEqual(now)
      .filter((row) => row.analysisState === 'leased')
      .toArray();
    if (expiredAnalysis.length > 0) {
      await db.organizeItems.bulkPut(expiredAnalysis.map((row) => ({
        ...clearAnalysisLease(row),
        retryCount: row.retryCount + 1,
        failure: 'lease_expired',
      })));
      for (const jobId of new Set(expiredAnalysis.map((row) => row.jobId))) {
        const job = await requireJob(jobId);
        await db.organizeJobs.put({
          ...job,
          status: 'analyzing',
          revision: job.revision + 1,
          updatedAt: now,
        });
      }
    }
    const expiredApply = await db.organizeApplyRows
      .where('leaseExpiresAt')
      .belowOrEqual(now)
      .filter((row) => row.state === 'leased')
      .toArray();
    if (expiredApply.length > 0) {
      await db.organizeApplyRows.bulkPut(expiredApply.map((row) => ({
        ...row,
        state: 'pending' as const,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      })));
      for (const applyId of new Set(expiredApply.map((row) => row.applyId))) {
        const apply = await db.organizeApplies.get(applyId);
        if (!apply) continue;
        await db.organizeApplies.put({ ...apply, status: 'sealed', updatedAt: now });
        const job = await requireJob(apply.jobId);
        await db.organizeJobs.put({
          ...job,
          status: 'apply_sealed',
          revision: job.revision + 1,
          updatedAt: now,
        });
      }
    }
    return Object.freeze({ analysis: expiredAnalysis.length, apply: expiredApply.length });
  });
}

/** Releases leases after the owning service-worker execution has been stopped. */
export async function releaseOrganizeJobLeases(
  jobId: string,
  now = Date.now(),
): Promise<Readonly<{ analysis: number; apply: number }>> {
  return db.transaction(
    'rw',
    db.organizeJobs,
    db.organizeItems,
    db.organizeApplies,
    db.organizeApplyRows,
    async () => {
      const job = await requireJob(jobId);
      const analysisRows = await db.organizeItems
        .where('jobId')
        .equals(jobId)
        .filter((row) => row.analysisState === 'leased')
        .toArray();
      if (analysisRows.length > 0) {
        await db.organizeItems.bulkPut(analysisRows.map((row) => ({
          ...clearAnalysisLease(row),
          retryCount: row.retryCount + 1,
          failure: 'worker_restarted',
        })));
      }
      let applyRows: OrganizeApplyRowRecord[] = [];
      if (job.applyId) {
        applyRows = await db.organizeApplyRows
          .where('applyId')
          .equals(job.applyId)
          .filter((row) => row.state === 'leased')
          .toArray();
        if (applyRows.length > 0) {
          await db.organizeApplyRows.bulkPut(applyRows.map((row) => ({
            ...row,
            state: 'pending' as const,
            leaseToken: null,
            leaseOwner: null,
            leaseExpiresAt: null,
          })));
          const apply = await requireApply(job.applyId);
          await db.organizeApplies.put({ ...apply, status: 'sealed', updatedAt: now });
        }
      }
      if (analysisRows.length > 0 || applyRows.length > 0) {
        await db.organizeJobs.put({
          ...job,
          status: applyRows.length > 0
            ? job.pauseRequested ? 'paused' : 'apply_sealed'
            : 'analyzing',
          pauseRequested: false,
          revision: job.revision + 1,
          updatedAt: now,
        });
      }
      return Object.freeze({ analysis: analysisRows.length, apply: applyRows.length });
    },
  );
}

async function findActiveJob(activeSlot: string): Promise<OrganizeJobRecord | undefined> {
  const rows = await db.organizeJobs.where('activeSlot').equals(activeSlot).toArray();
  return rows
    .filter((row) => row.status !== 'completed' && row.status !== 'cancelled')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function buildOrganizeItems(
  jobId: string,
  repositoryIds: readonly string[],
): OrganizeItemRecord[] {
  return repositoryIds.map((fullName, position): OrganizeItemRecord => ({
    id: itemId(jobId, position),
    jobId,
    position,
    fullName,
    analysisState: 'pending',
    proposedActions: [],
    approvedActions: [],
    proposedAdditions: [],
    sourceFingerprint: null,
    selected: false,
    retryCount: 0,
    failure: null,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    analyzedAt: null,
  }));
}

async function deleteOrganizePreflightArtifacts(jobId: string): Promise<void> {
  await db.organizeItems.where('jobId').equals(jobId).delete();
  await db.organizeTaxonomies.delete(jobId);
  await db.organizeJobs.delete(jobId);
}

async function requireJob(jobId: string): Promise<OrganizeJobRecord> {
  const job = await db.organizeJobs.get(jobId);
  if (!job) throw new TypeError(`Unknown organize job ${jobId}.`);
  return job;
}

async function requireApply(applyId: string): Promise<OrganizeApplyRecord> {
  const apply = await db.organizeApplies.get(applyId);
  if (!apply) throw new TypeError(`Unknown organize Apply ${applyId}.`);
  return apply;
}

async function pruneTerminalOrganizeArtifacts(): Promise<void> {
  const terminalJobs = (await db.organizeJobs.toArray()).filter((job) => (
    job.status === 'completed' || job.status === 'cancelled'
  ));
  for (const job of terminalJobs) {
    await db.organizeItems.where('jobId').equals(job.jobId).delete();
    await db.organizeTaxonomies.delete(job.jobId);
    await db.organizeJobs.delete(job.jobId);
  }
  const terminalApplies = (await db.organizeApplies.toArray()).filter((apply) => (
    apply.status === 'completed' || apply.status === 'cancelled'
  ));
  for (const apply of terminalApplies) {
    await db.organizeApplyRows.where('applyId').equals(apply.applyId).delete();
    await db.organizeApplies.delete(apply.applyId);
  }
}

async function claimedAnalysisRows(
  jobId: string,
  leaseToken: string,
): Promise<OrganizeItemRecord[]> {
  return db.organizeItems
    .where('jobId')
    .equals(jobId)
    .filter((row) => row.analysisState === 'leased' && row.leaseToken === leaseToken)
    .sortBy('position');
}

function assertUsageEquals(
  actual: unknown,
  expected: RunBudgetUsage,
  message: string,
): asserts actual is RunBudgetUsage {
  validateRunBudgetUsage(actual);
  validateRunBudgetUsage(expected);
  if (
    actual.firstAnalyzerRequestAt !== expected.firstAnalyzerRequestAt
    || actual.consumedFrozenPositions !== expected.consumedFrozenPositions
    || actual.analyzerBatches !== expected.analyzerBatches
    || actual.providerAttempts !== expected.providerAttempts
    || actual.serializedOutboundRequestBytes !== expected.serializedOutboundRequestBytes
    || actual.requestedOutputTokens !== expected.requestedOutputTokens
  ) {
    throw new TypeError(message);
  }
}

function validateAnalyzerBatchReservation(
  previous: RunBudgetUsage,
  next: RunBudgetUsage,
): void {
  validateRunBudgetUsage(previous);
  validateRunBudgetUsage(next);
  if (
    next.firstAnalyzerRequestAt !== previous.firstAnalyzerRequestAt
    || next.consumedFrozenPositions !== previous.consumedFrozenPositions
    || next.analyzerBatches !== previous.analyzerBatches + 1
    || next.providerAttempts !== previous.providerAttempts
    || next.serializedOutboundRequestBytes !== previous.serializedOutboundRequestBytes
    || next.requestedOutputTokens !== previous.requestedOutputTokens
  ) {
    throw new TypeError('Organize analysis page must reserve exactly one analyzer batch.');
  }
}

async function coverageForJob(jobId: string): Promise<OrganizeCoverage> {
  const rows = await db.organizeItems.where('jobId').equals(jobId).toArray();
  const count = (state: OrganizeItemAnalysisState) => rows.filter((row) => row.analysisState === state).length;
  const pending = count('pending');
  const leased = count('leased');
  const actionable = count('actionable');
  const unchanged = count('unchanged');
  const insufficientEvidence = count('insufficient_evidence');
  const missing = count('missing');
  const tombstoned = count('tombstoned');
  const failed = count('failed');
  return Object.freeze({
    total: rows.length,
    pending,
    leased,
    actionable,
    unchanged,
    insufficientEvidence,
    missing,
    tombstoned,
    failed,
    analyzed: actionable + unchanged + insufficientEvidence + missing + tombstoned + failed,
    complete: pending === 0 && leased === 0 && failed === 0,
  });
}

async function firstUnresolvedPosition(jobId: string): Promise<number | null> {
  const rows = await db.organizeItems.where('jobId').equals(jobId).sortBy('position');
  return rows.find((row) => row.analysisState === 'pending' || row.analysisState === 'leased')?.position ?? null;
}

async function finishAnalysisIfCovered(job: OrganizeJobRecord, now: number): Promise<void> {
  const tagPolicy = createOrganizeTagPolicySnapshot(job.tagPolicy);
  const coverage = await coverageForJob(job.jobId);
  if (coverage.complete) {
    await reconcileStoredOrganizeTagCoverage(job.jobId, tagPolicy);
    await db.organizeJobs.put({
      ...job,
      tagPolicy,
      status: 'review',
      nextFrozenIndex: job.itemCount,
      revision: job.revision + 1,
      updatedAt: now,
    });
  } else if (coverage.pending === 0 && coverage.leased === 0 && coverage.failed > 0) {
    await db.organizeJobs.put({
      ...job,
      tagPolicy,
      status: 'analysis_blocked',
      nextFrozenIndex: job.itemCount,
      revision: job.revision + 1,
      updatedAt: now,
    });
  }
}

async function reconcileStoredOrganizeTagCoverage(
  jobId: string,
  tagPolicy: ReturnType<typeof createOrganizeTagPolicySnapshot>,
): Promise<void> {
  const actionable = await db.organizeItems
    .where('[jobId+analysisState]')
    .equals([jobId, 'actionable'])
    .sortBy('position');
  const retainedActions = reconcileOrganizeTagCoverage(
    actionable.map((row) => ({ repositoryId: row.fullName, actions: row.proposedActions })),
    tagPolicy,
  );
  const reconciled = actionable.flatMap((row, index): OrganizeItemRecord[] => {
    const actions = retainedActions[index] ?? [];
    if (actions.length === 0) {
      return [{
        ...row,
        analysisState: 'insufficient_evidence',
        proposedActions: [],
        approvedActions: [],
        proposedAdditions: [],
        sourceFingerprint: null,
        selected: false,
      }];
    }
    if (actions.length === row.proposedActions.length) return [];
    return [{
      ...row,
      proposedActions: actions.map((action) => ({ ...action })),
      approvedActions: actions.map((action) => ({ ...action })),
      proposedAdditions: actions.map((action) => action.tag),
    }];
  });
  if (reconciled.length > 0) await db.organizeItems.bulkPut(reconciled);
}

async function recoverAnalysisLeases(jobId: string, now: number): Promise<void> {
  const rows = await db.organizeItems
    .where('jobId')
    .equals(jobId)
    .filter((row) => row.analysisState === 'leased' && (row.leaseExpiresAt ?? Infinity) <= now)
    .toArray();
  if (rows.length === 0) return;
  await db.organizeItems.bulkPut(rows.map((row) => ({
    ...clearAnalysisLease(row),
    retryCount: row.retryCount + 1,
    failure: 'lease_expired',
  })));
}

async function recoverApplyLeases(applyId: string, now: number): Promise<void> {
  const rows = await db.organizeApplyRows
    .where('applyId')
    .equals(applyId)
    .filter((row) => row.state === 'leased' && (row.leaseExpiresAt ?? Infinity) <= now)
    .toArray();
  if (rows.length === 0) return;
  await db.organizeApplyRows.bulkPut(rows.map((row) => ({
    ...row,
    state: 'pending' as const,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  })));
}

function clearAnalysisLease(row: OrganizeItemRecord): OrganizeItemRecord {
  return {
    ...row,
    analysisState: row.analysisState === 'leased' ? 'pending' : row.analysisState,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
}

function clearApplyLease(row: OrganizeApplyRowRecord, now: number): OrganizeApplyRowRecord {
  return {
    ...row,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    settledAt: now,
  };
}

function requireJobRevision(job: OrganizeJobRecord, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('Expected organize job revision must be a nonnegative safe integer.');
  }
  if (job.revision !== expectedRevision) throw new TypeError('Organize job revision is stale.');
}

function validateDurableAnalysisWindow(
  job: OrganizeJobRecord,
  startFrozenIndex: number,
  endFrozenIndexExclusive: number,
): void {
  const ranges = job.analysisPendingRanges ?? [];
  validateAnalysisRanges(ranges, job.nextFrozenIndex, job.itemCount);
  const head = ranges[0];
  if (
    head
    && (
      head.startFrozenIndex !== startFrozenIndex
      || head.endFrozenIndexExclusive !== endFrozenIndexExclusive
    )
  ) {
    throw new TypeError('Organize analysis page does not match its pending range.');
  }
}

function validateAnalysisCheckpointSplitState(
  job: OrganizeJobRecord,
  checkpointEndFrozenIndex: number,
  input: Readonly<{
    outcomes: readonly OrganizeAnalysisOutcome[];
    analysisPendingRanges: readonly OrganizeAnalysisRange[];
  }>,
): void {
  const current = job.analysisPendingRanges ?? [];
  validateAnalysisRanges(current, job.nextFrozenIndex, job.itemCount);
  const head = current[0];
  if (head && head.endFrozenIndexExclusive !== checkpointEndFrozenIndex) {
    throw new TypeError('Organize analysis checkpoint does not settle its pending range head.');
  }
  const expected = input.outcomes.some((outcome) => outcome.state === 'failed')
    ? []
    : head
      ? current.slice(1)
      : [];
  validateAnalysisRanges(input.analysisPendingRanges, checkpointEndFrozenIndex, job.itemCount);
  if (!sameAnalysisRanges(input.analysisPendingRanges, expected)) {
    throw new TypeError('Organize analysis checkpoint pending ranges are stale.');
  }
}

function validateAnalysisRanges(
  ranges: readonly OrganizeAnalysisRange[],
  expectedStart: number,
  itemCount: number,
): void {
  if (ranges.length > 7) {
    throw new TypeError('Organize analysis pending range worklist is too large.');
  }
  let start = expectedStart;
  let previousDepth = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.startFrozenIndex)
      || !Number.isSafeInteger(range.endFrozenIndexExclusive)
      || !Number.isSafeInteger(range.depth)
      || range.startFrozenIndex !== start
      || range.endFrozenIndexExclusive <= range.startFrozenIndex
      || range.endFrozenIndexExclusive > itemCount
      || range.depth <= 0
      || range.depth > 6
      || range.depth > previousDepth
    ) {
      throw new TypeError('Organize analysis pending range worklist is invalid.');
    }
    start = range.endFrozenIndexExclusive;
    previousDepth = range.depth;
  }
}

function sameAnalysisRanges(
  left: readonly OrganizeAnalysisRange[],
  right: readonly OrganizeAnalysisRange[],
): boolean {
  return left.length === right.length && left.every((range, index) => {
    const other = right[index];
    return other !== undefined
      && range.startFrozenIndex === other.startFrozenIndex
      && range.endFrozenIndexExclusive === other.endFrozenIndexExclusive
      && range.depth === other.depth;
  });
}

function requireReviewRevision(job: OrganizeJobRecord, expectedRevision: number): void {
  if (job.status !== 'review') throw new TypeError('Organize job is not in review.');
  if (job.revision !== expectedRevision) throw new TypeError('Organize job revision is stale.');
}

function validateCreateInput(input: CreateOrganizeJobInput): void {
  for (const [field, value] of [
    ['controllerId', input.controllerId],
    ['sessionId', input.sessionId],
    ['runId', input.runId],
    ['taskInstruction', input.taskInstruction],
    ['taxonomy fingerprint', input.taxonomy.fingerprint],
    ['scope fingerprint', input.frozenScope.fingerprint],
  ] as const) {
    if (!value.trim()) throw new TypeError(`${field} must be nonempty.`);
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new TypeError('generation must be a nonnegative safe integer.');
  }
  const ids = input.frozenScope.repositoryIds;
  if (new Set(ids).size !== ids.length || ids.some((id) => !id.trim())) {
    throw new TypeError('Frozen scope repository IDs must be unique and nonempty.');
  }
  const next = input.nextFrozenIndex ?? 0;
  if (next !== 0) {
    throw new TypeError('New organize jobs must begin at nextFrozenIndex 0.');
  }
  if (input.jobId !== undefined && !isOrganizeJobId(input.jobId)) {
    throw new TypeError('jobId must be a versioned organize-job identity when supplied.');
  }
  if (input.activeSlot !== undefined && !input.activeSlot.trim()) {
    throw new TypeError('activeSlot must be nonempty when supplied.');
  }
}

function validateAnalysisOutcome(outcome: OrganizeAnalysisOutcome): void {
  if (!Number.isSafeInteger(outcome.position) || outcome.position < 0) {
    throw new TypeError('Analysis outcome position must be a nonnegative safe integer.');
  }
  if (![
    'actionable',
    'unchanged',
    'insufficient_evidence',
    'missing',
    'tombstoned',
    'failed',
    'retry',
  ].includes(outcome.state)) {
    throw new TypeError('Analysis outcome state is invalid.');
  }
}

function settleAnalysisRow(
  row: OrganizeItemRecord,
  outcome: OrganizeAnalysisOutcome,
  now: number,
  maxTagsPerRepo = TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT,
): OrganizeItemRecord {
  validateAnalysisOutcome(outcome);
  const retry = outcome.state === 'retry';
  const proposedActions = retry
    ? []
    : normalizeActions(outcome.proposedActions ?? [], maxTagsPerRepo);
  const proposedAdditions = proposedActions.map((action) => action.tag);
  if (outcome.state === 'actionable' && proposedActions.length === 0) {
    throw new TypeError('Actionable organization outcomes require proposed actions.');
  }
  if (outcome.state !== 'actionable' && proposedActions.length > 0) {
    throw new TypeError('Non-actionable organization outcomes cannot carry proposed actions.');
  }
  if (outcome.state === 'actionable' && !outcome.sourceFingerprint) {
    throw new TypeError('Actionable organization outcomes require a source fingerprint.');
  }
  return {
    ...row,
    analysisState: retry ? 'pending' : outcome.state,
    proposedActions,
    approvedActions: outcome.state === 'actionable'
      ? proposedActions.map((action) => ({ ...action }))
      : [],
    proposedAdditions,
    sourceFingerprint: retry ? null : outcome.sourceFingerprint ?? null,
    selected: outcome.state === 'actionable',
    retryCount: row.retryCount + (retry ? 1 : 0),
    failure: outcome.failure ?? null,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    analyzedAt: retry ? null : now,
  };
}

function resetAnalysisRow(row: OrganizeItemRecord): OrganizeItemRecord {
  return {
    ...row,
    analysisState: 'pending',
    proposedActions: [],
    approvedActions: [],
    proposedAdditions: [],
    sourceFingerprint: null,
    selected: false,
    failure: null,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    analyzedAt: null,
  };
}

function requireAnalysisIdentity(
  job: OrganizeJobRecord,
  runId: RunId,
  generation: number,
): void {
  if (job.runId !== runId || job.generation !== generation) {
    throw new TypeError('Organize analysis run identity is stale.');
  }
}

function validateLedgerWindow(
  job: OrganizeJobRecord,
  rows: readonly OrganizeItemRecord[],
  start: number,
  end: number,
): void {
  if (rows.length !== end - start) {
    throw new TypeError('Organize ledger window is incomplete.');
  }
  rows.forEach((row, offset) => {
    const position = start + offset;
    if (
      row.jobId !== job.jobId ||
      row.position !== position ||
      row.fullName !== job.frozenScope.repositoryIds[position]
    ) {
      throw new TypeError('Organize ledger window does not match the frozen scope.');
    }
  });
}

async function validateOrganizeLedger(
  job: OrganizeJobRecord,
  requireComplete = true,
): Promise<OrganizeItemRecord[]> {
  const rows = await db.organizeItems.where('jobId').equals(job.jobId).sortBy('position');
  validateLedgerWindow(job, rows, 0, job.itemCount);
  if (job.itemCount !== job.frozenScope.repositoryIds.length) {
    throw new TypeError('Organize job item count does not match its frozen scope.');
  }
  if (
    requireComplete &&
    rows.some((row) => row.analysisState === 'pending' || row.analysisState === 'leased' || row.analysisState === 'failed')
  ) {
    throw new TypeError('Organize review requires a complete failure-free ledger.');
  }
  return rows;
}

function normalizeActions(
  values: readonly OrganizeProposedAction[],
  maxTagsPerRepo = TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT,
): OrganizeProposedAction[] {
  assertLimit(
    maxTagsPerRepo,
    TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT,
    'proposed actions',
  );
  if (values.length > maxTagsPerRepo) {
    throw new RangeError(`At most ${maxTagsPerRepo} proposed actions are allowed per repository.`);
  }
  const tags = addTagNames([], values.map((action) => action.tag));
  return tags.map((tag) => {
    const action = values.find((candidate) => canonicalTag(candidate.tag) === canonicalTag(tag));
    if (!action || !['add_existing_tag', 'propose_new_tag'].includes(action.kind)) {
      throw new TypeError('Proposed action is malformed.');
    }
    if (!action.evidence.trim()) throw new TypeError('Proposed action evidence must be nonempty.');
    return { kind: action.kind, tag, evidence: action.evidence };
  });
}

function selectApprovedActions(
  proposed: readonly OrganizeProposedAction[],
  approved: readonly OrganizeProposedAction[],
): OrganizeProposedAction[] {
  const normalized = normalizeActions(approved);
  return normalized.map((candidate) => {
    const sealed = proposed.find((action) => (
      action.kind === candidate.kind
      && canonicalTag(action.tag) === canonicalTag(candidate.tag)
      && action.evidence === candidate.evidence
    ));
    if (!sealed) throw new TypeError('Approved actions must be an exact subset of proposed actions.');
    return { ...sealed };
  });
}

function assertLimit(value: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${label} limit must be between 1 and ${max}.`);
  }
}

function assertLease(ownerId: string, durationMs: number): void {
  if (!ownerId.trim()) throw new TypeError('Lease ownerId must be nonempty.');
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new RangeError('Lease durationMs must be a positive safe integer.');
  }
}

function itemId(jobId: string, position: number): string {
  return `${jobId}\u0000${position}`;
}

function applyRowId(applyId: string, position: number): string {
  return `${applyId}\u0000${position}`;
}

function newId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:v1:${suffix}`;
}

function canonicalTag(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function emptyTag(fullName: string, timestamp: string): Tag {
  return {
    full_name: fullName,
    manualTags: [],
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: timestamp,
    autoTagsMtime: timestamp,
    dismissedAutoTagsMtime: timestamp,
    notes: '',
    favorite: false,
    mtime: timestamp,
  };
}
