import type {
  RadarActivityPresentation,
  RadarActivityRecord,
  RadarErrorCode,
  RadarReconciliationCheckpoint,
  RadarStateRecord,
  RadarStoredStateRecord,
} from '@/radar/radar-model';
import {
  dedupeRadarActivities,
  normalizeRadarPartialReasons,
  normalizeRadarReconciliationCheckpoint,
} from '@/radar/radar-model';
import { projectRadarActivities } from '@/radar/radar-projector';
import type {
  RadarReconciliationSourceStep,
  RadarReconciliationStatus,
  RadarSnapshotStatus,
  RadarSourceSnapshot,
  RadarStatus,
} from '@/radar/radar-contract';
import { db } from './db';
import { DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS } from '@/preferences';

const RADAR_STATE_ID = 'singleton' as const;
const RADAR_STALE_AFTER_MS = 30 * 60 * 1_000;

function now(): string {
  return new Date().toISOString();
}

function accountKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function emptyState(accountLogin: string, lastAttemptAt = now()): RadarStoredStateRecord {
  return {
    id: RADAR_STATE_ID,
    accountLogin: accountKey(accountLogin),
    lastAttemptAt,
    lastSuccessfulAt: null,
    windowDays: null,
    lastRefreshMode: null,
    lastIncrementalAt: null,
    lastFullReconciledAt: null,
    credentialIdentity: null,
    errorCode: null,
    nextAllowedAt: null,
    activityCount: 0,
    followingCount: 0,
    scannedFollowingCount: 0,
    batchCount: 0,
    partialReasons: [],
    rateLimitRemaining: null,
    rateLimitResetAt: null,
    maxRequestCost: null,
    reconciliation: null,
  };
}

function normalizeStoredState(state: RadarStoredStateRecord): RadarStoredStateRecord {
  return {
    ...state,
    accountLogin: accountKey(state.accountLogin),
    windowDays: Number.isSafeInteger(state.windowDays) ? state.windowDays : null,
    lastRefreshMode: state.lastRefreshMode === 'full' || state.lastRefreshMode === 'incremental'
      ? state.lastRefreshMode
      : null,
    lastIncrementalAt: typeof state.lastIncrementalAt === 'string' ? state.lastIncrementalAt : null,
    lastFullReconciledAt: typeof state.lastFullReconciledAt === 'string'
      ? state.lastFullReconciledAt
      : null,
    credentialIdentity: typeof state.credentialIdentity === 'string'
      ? state.credentialIdentity
      : null,
    partialReasons: normalizeRadarPartialReasons(state.partialReasons),
    maxRequestCost: Number.isSafeInteger(state.maxRequestCost) && (state.maxRequestCost ?? -1) >= 0
      ? state.maxRequestCost
      : null,
    reconciliation: normalizeRadarReconciliationCheckpoint(state.reconciliation),
  };
}

function publicState(state: RadarStoredStateRecord): RadarStateRecord {
  const visible = { ...normalizeStoredState(state) };
  delete visible.reconciliation;
  return visible;
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function storedSeenAt(value: unknown): string | null {
  return typeof value === 'string' && timestamp(value) !== null ? value : null;
}
function storedStateForAccount(
  state: RadarStoredStateRecord | undefined,
  accountLogin: string,
): RadarStoredStateRecord | null {
  if (!state) return null;
  const normalized = normalizeStoredState(state);
  return normalized.accountLogin === accountKey(accountLogin) ? normalized : null;
}

function stateForAccount(
  state: RadarStoredStateRecord | undefined,
  accountLogin: string,
): RadarStateRecord | null {
  const stored = storedStateForAccount(state, accountLogin);
  return stored ? publicState(stored) : null;
}

export async function countUnseenRadarActivities(
  accountLogin: string | null | undefined,
  nowMillis = Date.now(),
  windowDays = DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS,
): Promise<number> {
  if (!accountLogin?.trim()) return 0;
  const key = accountKey(accountLogin);
  const cutoffMillis = nowMillis - windowDays * 24 * 60 * 60 * 1_000;
  return db.transaction('r', db.radarActivities, db.radarState, async () => {
    const state = await db.radarState.get(RADAR_STATE_ID);
    if (!state || accountKey(state.accountLogin) !== key) return 0;
    return db.radarActivities
      .where('accountLogin')
      .equals(key)
      .filter((activity) => {
        const starredAt = timestamp(activity.starredAt);
        return activity.dismissedAt === null
          && storedSeenAt(activity.seenAt) === null
          && starredAt !== null
          && starredAt >= cutoffMillis
          && starredAt <= nowMillis;
      })
      .count();
  });
}

/** Remove another account's cached activity before any new account can read it. */
export async function prepareRadarAccount(accountLogin: string): Promise<void> {
  const key = accountKey(accountLogin);
  await db.transaction('rw', db.radarActivities, db.radarState, async () => {
    const state = await db.radarState.get(RADAR_STATE_ID);
    if (state && accountKey(state.accountLogin) === key) return;
    await db.radarActivities.clear();
    await db.radarState.delete(RADAR_STATE_ID);
  });
}

export async function getRadarState(accountLogin: string): Promise<RadarStateRecord | null> {
  return stateForAccount(await db.radarState.get(RADAR_STATE_ID), accountLogin);
}

export async function getRadarReconciliation(
  accountLogin: string,
): Promise<RadarReconciliationCheckpoint | null> {
  return storedStateForAccount(
    await db.radarState.get(RADAR_STATE_ID),
    accountLogin,
  )?.reconciliation ?? null;
}

export function projectRadarReconciliationStatus(
  checkpoint: RadarReconciliationCheckpoint | null,
  refreshing: boolean,
): RadarReconciliationStatus | null {
  if (!checkpoint) return null;
  const completedCount = checkpoint.cursor.phase === 'following'
    ? checkpoint.cursor.logins.length
    : checkpoint.cursor.actors.filter((actor) => actor.complete).length;
  const totalCount = checkpoint.cursor.phase === 'following'
    ? checkpoint.cursor.totalCount
    : checkpoint.cursor.followingCount;
  return {
    phase: checkpoint.cursor.phase,
    completedCount,
    totalCount,
    updatedAt: checkpoint.updatedAt,
    pauseReason: checkpoint.pauseReason ?? (refreshing ? null : 'interrupted'),
    nextAllowedAt: checkpoint.nextAllowedAt,
  };
}
function preservedDismissedAt(
  existingById: ReadonlyMap<string, RadarActivityRecord>,
  activity: RadarActivityRecord,
): string | null {
  return existingById.get(activity.id)?.dismissedAt ?? activity.dismissedAt ?? null;
}

function preservedSeenAt(
  existingById: ReadonlyMap<string, RadarActivityRecord>,
  activity: RadarActivityRecord,
): string | null {
  const existing = existingById.get(activity.id);
  return storedSeenAt(existing?.seenAt) ?? storedSeenAt(activity.seenAt);
}

type RadarCommitOptions = Readonly<{ credentialIdentity?: string | null }>;

/** Merge recent refreshes and replace only authoritative complete reconciliations. */
export async function commitRadarRefresh(
  snapshot: RadarSourceSnapshot,
  options: RadarCommitOptions = {},
): Promise<RadarStateRecord> {
  const accountLogin = accountKey(snapshot.accountLogin);
  if (!accountLogin) throw new Error('Radar account is required');
  if (snapshot.activities.some((activity) => accountKey(activity.accountLogin) !== accountLogin)) {
    throw new Error('Radar activity account mismatch');
  }
  const attemptAt = now();
  return db.transaction('rw', db.radarActivities, db.radarState, async () => {
    const storedState = await db.radarState.get(RADAR_STATE_ID);
    if (storedState && accountKey(storedState.accountLogin) !== accountLogin) {
      throw new Error('Radar account mismatch');
    }
    const previous = await db.radarActivities.toArray();
    if (previous.some((activity) => accountKey(activity.accountLogin) !== accountLogin)) {
      throw new Error('Radar activity account mismatch');
    }
    const previousStoredState = storedStateForAccount(storedState, accountLogin);
    const previousState = previousStoredState ? publicState(previousStoredState) : null;
    const completeFull = snapshot.refreshMode === 'full'
      && snapshot.lookbackDays === snapshot.windowDays
      && Number.isSafeInteger(snapshot.followingCount)
      && snapshot.followingCount >= 0
      && snapshot.scannedFollowingCount === snapshot.followingCount
      && Array.isArray(snapshot.partialReasons)
      && snapshot.partialReasons.length === 0;
    const existingCredential = previousState?.credentialIdentity ?? null;
    if (
      options.credentialIdentity !== undefined
      && existingCredential !== null
      && options.credentialIdentity !== existingCredential
      && !completeFull
    ) {
      throw new Error('Radar credential mismatch');
    }
    const existingById = new Map(previous.map((activity) => [activity.id, activity] as const));
    const incoming = dedupeRadarActivities(snapshot.activities).map((activity) => ({
      ...activity,
      accountLogin,
      dismissedAt: preservedDismissedAt(existingById, activity),
      seenAt: preservedSeenAt(existingById, activity),
      reconciliationId: snapshot.refreshMode === 'incremental'
        ? existingById.get(activity.id)?.reconciliationId ?? activity.reconciliationId ?? null
        : activity.reconciliationId ?? null,
    }));
    const mergedById = new Map(existingById);
    for (const activity of incoming) mergedById.set(activity.id, activity);
    const activities = completeFull
      ? incoming
      : dedupeRadarActivities(mergedById.values());
    if (completeFull) await db.radarActivities.clear();
    const written = completeFull ? activities : incoming;
    if (written.length > 0) await db.radarActivities.bulkPut(written);

    const previousOrEmpty = previousStoredState ?? emptyState(accountLogin, attemptAt);
    const state: RadarStoredStateRecord = {
      ...previousOrEmpty,
      id: RADAR_STATE_ID,
      accountLogin,
      lastAttemptAt: attemptAt,
      lastSuccessfulAt: snapshot.fetchedAt,
      windowDays: completeFull ? snapshot.windowDays : previousOrEmpty.windowDays,
      lastRefreshMode: snapshot.refreshMode,
      lastIncrementalAt: snapshot.refreshMode === 'incremental'
        ? snapshot.fetchedAt
        : previousOrEmpty.lastIncrementalAt,
      lastFullReconciledAt: completeFull
        ? snapshot.fetchedAt
        : previousOrEmpty.lastFullReconciledAt,
      credentialIdentity: options.credentialIdentity === undefined
        ? previousOrEmpty.credentialIdentity
        : options.credentialIdentity,
      errorCode: null,
      nextAllowedAt: null,
      activityCount: activities.length,
      followingCount: snapshot.followingCount,
      scannedFollowingCount: snapshot.scannedFollowingCount,
      batchCount: snapshot.batchCount,
      partialReasons: normalizeRadarPartialReasons(snapshot.partialReasons),
      rateLimitRemaining: snapshot.rateLimitRemaining,
      rateLimitResetAt: snapshot.rateLimitResetAt,
      maxRequestCost: snapshot.maxRequestCost ?? null,
      reconciliation: snapshot.refreshMode === 'incremental'
        ? previousStoredState?.reconciliation ?? null
        : null,
    };
    await db.radarState.put(state);
    return publicState(state);
  });
}

export async function commitRadarSnapshot(
  snapshot: RadarSourceSnapshot,
  options: RadarCommitOptions = {},
): Promise<RadarStateRecord> {
  return commitRadarRefresh(snapshot, options);
}

function hasPrefix(values: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= values.length && prefix.every((value, index) => values[index] === value);
}

function sameReconciliationIdentity(
  left: RadarReconciliationCheckpoint,
  right: RadarReconciliationCheckpoint,
): boolean {
  return left.reconciliationId === right.reconciliationId
    && left.accountLogin === right.accountLogin
    && left.credentialIdentity === right.credentialIdentity
    && left.windowDays === right.windowDays
    && left.startedAt === right.startedAt
    && left.cutoffAt === right.cutoffAt;
}

/** Cursor pages appended by one step, or null when history was rewritten. */
function appendedCursors(
  previous: readonly string[],
  next: readonly string[],
): string[] | null {
  if (!hasPrefix(next, previous)) return null;
  const appended = next.slice(previous.length);
  const seen = new Set(previous);
  for (const cursor of appended) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
  }
  return appended;
}

function validActorTransition(
  previous: RadarReconciliationCheckpoint['cursor'] & { phase: 'activity' },
  next: RadarReconciliationCheckpoint['cursor'] & { phase: 'activity' },
): boolean {
  if (previous.followingCount !== next.followingCount || previous.actors.length !== next.actors.length) {
    return false;
  }
  return previous.actors.every((actor, index) => {
    const candidate = next.actors[index];
    if (!candidate || candidate.login !== actor.login) return false;
    const appended = appendedCursors(actor.seenCursors, candidate.seenCursors);
    if (appended === null) return false;
    if (actor.complete) {
      return candidate.complete && candidate.nextCursor === null && appended.length === 0;
    }
    if (candidate.complete) return candidate.nextCursor === null;
    return appended.length === 0
      ? candidate.nextCursor === actor.nextCursor
      : candidate.nextCursor === appended.at(-1);
  });
}

/**
 * One step may page GitHub several times inside its request budget, so a
 * transition is valid when it extends frozen identity and cursor history
 * monotonically rather than by exactly one page.
 */
function validReconciliationTransition(
  previous: RadarReconciliationCheckpoint,
  next: RadarReconciliationCheckpoint,
): boolean {
  if (
    !sameReconciliationIdentity(previous, next)
    || next.revision !== previous.revision + 1
    || Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)
    || next.scannedFollowingCount < previous.scannedFollowingCount
    || next.batchCount < previous.batchCount
    || previous.partialReasons.some((reason) => !next.partialReasons.includes(reason))
  ) return false;

  if (previous.cursor.phase === 'activity') {
    return next.cursor.phase === 'activity' && validActorTransition(previous.cursor, next.cursor);
  }
  if (next.cursor.phase === 'following') {
    const appended = appendedCursors(previous.cursor.seenCursors, next.cursor.seenCursors);
    if (
      appended === null
      || !hasPrefix(next.cursor.logins, previous.cursor.logins)
      || (previous.cursor.totalCount !== null
        && next.cursor.totalCount !== previous.cursor.totalCount)
    ) return false;
    return appended.length === 0
      ? next.cursor.nextCursor === previous.cursor.nextCursor
        && next.cursor.logins.length === previous.cursor.logins.length
        && next.cursor.totalCount === previous.cursor.totalCount
      : next.cursor.nextCursor === appended.at(-1);
  }
  const actorLogins = next.cursor.actors.map((actor) => actor.login);
  return hasPrefix(actorLogins, previous.cursor.logins)
    && (previous.cursor.totalCount === null
      || next.cursor.followingCount === previous.cursor.totalCount);
}

function checkpointFollowingCount(checkpoint: RadarReconciliationCheckpoint): number {
  return checkpoint.cursor.phase === 'activity'
    ? checkpoint.cursor.followingCount
    : checkpoint.cursor.totalCount ?? checkpoint.cursor.logins.length;
}

export async function startRadarReconciliation(
  checkpointInput: RadarReconciliationCheckpoint,
): Promise<{ state: RadarStateRecord; checkpoint: RadarReconciliationCheckpoint }> {
  const checkpoint = normalizeRadarReconciliationCheckpoint(checkpointInput);
  if (
    !checkpoint
    || checkpoint.revision !== 0
    || checkpoint.cursor.phase !== 'following'
    || checkpoint.cursor.nextCursor !== null
    || checkpoint.cursor.logins.length !== 0
  ) throw new TypeError('Radar reconciliation start checkpoint is invalid.');
  return db.transaction('rw', db.radarActivities, db.radarState, async () => {
    const stored = await db.radarState.get(RADAR_STATE_ID);
    if (stored && accountKey(stored.accountLogin) !== checkpoint.accountLogin) {
      throw new Error('Radar account mismatch');
    }
    const previous = storedStateForAccount(stored, checkpoint.accountLogin)
      ?? emptyState(checkpoint.accountLogin, checkpoint.startedAt);
    const state: RadarStoredStateRecord = {
      ...previous,
      lastAttemptAt: checkpoint.startedAt,
      lastRefreshMode: 'full',
      errorCode: null,
      nextAllowedAt: null,
      reconciliation: checkpoint,
    };
    await db.radarState.put(state);
    return { state: publicState(state), checkpoint };
  });
}

export async function commitRadarReconciliationStep(input: Readonly<{
  accountLogin: string;
  credentialIdentity: string;
  windowDays: number;
  step: RadarReconciliationSourceStep;
}>): Promise<{
  applied: boolean;
  state: RadarStateRecord | null;
  checkpoint: RadarReconciliationCheckpoint | null;
}> {
  const accountLogin = accountKey(input.accountLogin);
  const next = normalizeRadarReconciliationCheckpoint(input.step.checkpoint);
  if (!next) throw new TypeError('Radar reconciliation checkpoint is invalid.');
  if (input.step.activities.some((activity) => accountKey(activity.accountLogin) !== accountLogin)) {
    throw new Error('Radar activity account mismatch');
  }
  return db.transaction('rw', db.radarActivities, db.radarState, async () => {
    const stored = await db.radarState.get(RADAR_STATE_ID);
    const currentState = storedStateForAccount(stored, accountLogin);
    const current = currentState?.reconciliation ?? null;
    if (
      !current
      || current.reconciliationId !== input.step.expectedReconciliationId
      || current.revision !== input.step.expectedRevision
      || current.credentialIdentity !== input.credentialIdentity
      || current.windowDays !== input.windowDays
      || !validReconciliationTransition(current, next)
      || input.step.complete !== (
        next.cursor.phase === 'activity' && next.cursor.actors.every((actor) => actor.complete)
      )
    ) {
      return {
        applied: false,
        state: currentState ? publicState(currentState) : null,
        checkpoint: current,
      };
    }

    const previousRows = await db.radarActivities.toArray();
    if (previousRows.some((activity) => accountKey(activity.accountLogin) !== accountLogin)) {
      throw new Error('Radar activity account mismatch');
    }
    const existingById = new Map(previousRows.map((activity) => [activity.id, activity] as const));
    const incoming = dedupeRadarActivities(input.step.activities).map((activity) => ({
      ...activity,
      accountLogin,
      dismissedAt: preservedDismissedAt(existingById, activity),
      seenAt: preservedSeenAt(existingById, activity),
      reconciliationId: current.reconciliationId,
    }));
    if (incoming.length > 0) await db.radarActivities.bulkPut(incoming);

    // Walking every frozen actor to the frozen cutoff establishes full-scan
    // provenance. Deleting rows needs more: the frozen actor set must also
    // cover the whole Following graph with no reported coverage gap, because a
    // capped or gapped epoch cannot prove a missing row was unstarred.
    const coverageComplete = input.step.complete
      && next.cursor.phase === 'activity'
      && Date.parse(next.cutoffAt) === Date.parse(next.startedAt)
        - next.windowDays * 24 * 60 * 60 * 1_000
      && next.scannedFollowingCount === next.cursor.actors.length;
    const sweepAuthority = coverageComplete
      && next.cursor.phase === 'activity'
      && next.cursor.actors.length === next.cursor.followingCount
      && next.partialReasons.length === 0;
    if (sweepAuthority) {
      const incomingIds = new Set(incoming.map((activity) => activity.id));
      const staleIds = previousRows
        .filter((activity) => (
          activity.reconciliationId !== current.reconciliationId && !incomingIds.has(activity.id)
        ))
        .map((activity) => activity.id);
      if (staleIds.length > 0) await db.radarActivities.bulkDelete(staleIds);
    }

    const activityCount = await db.radarActivities.count();
    const terminal = input.step.complete;
    const baseState = currentState ?? emptyState(accountLogin, next.updatedAt);
    const state: RadarStoredStateRecord = {
      ...baseState,
      id: RADAR_STATE_ID,
      accountLogin,
      lastAttemptAt: next.updatedAt,
      lastSuccessfulAt: terminal ? next.updatedAt : baseState.lastSuccessfulAt,
      windowDays: coverageComplete ? next.windowDays : baseState.windowDays,
      lastRefreshMode: 'full',
      lastFullReconciledAt: coverageComplete ? next.updatedAt : baseState.lastFullReconciledAt,
      credentialIdentity: coverageComplete ? next.credentialIdentity : baseState.credentialIdentity,
      errorCode: null,
      nextAllowedAt: next.nextAllowedAt,
      activityCount,
      followingCount: checkpointFollowingCount(next),
      scannedFollowingCount: next.scannedFollowingCount,
      batchCount: next.batchCount,
      partialReasons: terminal ? next.partialReasons : baseState.partialReasons,
      rateLimitRemaining: next.rateLimitRemaining,
      rateLimitResetAt: next.rateLimitResetAt,
      maxRequestCost: next.maxRequestCost,
      reconciliation: terminal ? null : next,
    };
    await db.radarState.put(state);
    return {
      applied: true,
      state: publicState(state),
      checkpoint: state.reconciliation ?? null,
    };
  });
}

export async function abandonRadarReconciliation(
  accountLogin: string,
  expectedReconciliationId?: string,
): Promise<boolean> {
  const key = accountKey(accountLogin);
  return db.transaction('rw', db.radarState, async () => {
    const stored = storedStateForAccount(await db.radarState.get(RADAR_STATE_ID), key);
    const current = stored?.reconciliation ?? null;
    if (!stored || !current) return false;
    if (expectedReconciliationId && current.reconciliationId !== expectedReconciliationId) return false;
    await db.radarState.put({ ...stored, reconciliation: null });
    return true;
  });
}

export async function recordRadarFailure(
  accountLogin: string,
  errorCode: RadarErrorCode,
  options: { nextAllowedAt?: string | null } = {},
): Promise<RadarStateRecord> {
  const key = accountKey(accountLogin);
  const attemptAt = now();
  return db.transaction('rw', db.radarActivities, db.radarState, async () => {
    const stored = await db.radarState.get(RADAR_STATE_ID);
    if (stored && accountKey(stored.accountLogin) !== key) {
      throw new Error('Radar account mismatch');
    }
    const rows = await db.radarActivities.toArray();
    if (rows.some((activity) => accountKey(activity.accountLogin) !== key)) {
      throw new Error('Radar activity account mismatch');
    }
    const previous = storedStateForAccount(stored, key);
    const state: RadarStoredStateRecord = {
      ...(previous ?? emptyState(key, attemptAt)),
      id: RADAR_STATE_ID,
      accountLogin: key,
      lastAttemptAt: attemptAt,
      errorCode,
      nextAllowedAt: options.nextAllowedAt ?? null,
    };
    await db.radarState.put(state);
    return publicState(state);
  });
}

export async function dismissRadarActivities(
  accountLogin: string,
  activityIds: readonly string[],
  dismissedAt = now(),
): Promise<number> {
  const key = accountKey(accountLogin);
  const uniqueIds = [...new Set(activityIds)];
  if (uniqueIds.length === 0) return 0;
  return db.transaction('rw', db.radarActivities, async () => {
    let changed = 0;
    for (const id of uniqueIds) {
      const activity = await db.radarActivities.get(id);
      if (!activity || activity.accountLogin !== key || activity.dismissedAt !== null) continue;
      await db.radarActivities.put({ ...activity, dismissedAt });
      changed += 1;
    }
    return changed;
  });
}
export async function markRadarActivitiesSeen(
  accountLogin: string,
  activityIds: readonly string[],
  seenAt = now(),
): Promise<number> {
  const key = accountKey(accountLogin);
  const uniqueIds = [...new Set(activityIds)];
  const normalizedSeenAt = storedSeenAt(seenAt);
  if (uniqueIds.length === 0) return 0;
  if (!normalizedSeenAt) throw new Error('Invalid Radar seen timestamp');
  return db.transaction('rw', db.radarActivities, async () => {
    const stored = await db.radarActivities.bulkGet(uniqueIds);
    const changed: RadarActivityRecord[] = [];
    for (const activity of stored) {
      if (
        activity
        && activity.accountLogin === key
        && storedSeenAt(activity.seenAt) === null
      ) changed.push({ ...activity, seenAt: normalizedSeenAt });
    }
    if (changed.length > 0) await db.radarActivities.bulkPut(changed);
    return changed.length;
  });
}

export async function clearRadarData(): Promise<void> {
  await db.transaction('rw', db.radarActivities, db.radarState, async () => {
    await db.radarActivities.clear();
    await db.radarState.clear();
  });
}


export async function listRadarActivities(
  accountLogin: string,
  nowMillis = Date.now(),
  windowDays = DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS,
): Promise<RadarActivityPresentation[]> {
  const key = accountKey(accountLogin);
  const [activities, stars, tags, tagMeta] = await Promise.all([
    db.radarActivities.where('accountLogin').equals(key).toArray(),
    db.stars.toArray(),
    db.tags.toArray(),
    db.tagMeta.toArray(),
  ]);
  return projectRadarActivities({
    accountLogin: key,
    nowMillis,
    windowDays,
    activities,
    stars,
    tags,
    tagMeta,
  });
}


export function radarSnapshotStatus(
  state: RadarStateRecord | null,
  nowMillis = Date.now(),
  windowDays = DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS,
): RadarSnapshotStatus {
  if (!state) return 'never_loaded';
  const nextAllowedAt = timestamp(state.nextAllowedAt);
  if (nextAllowedAt !== null && nextAllowedAt > nowMillis) return 'cooldown';
  const lastSuccessfulAt = timestamp(state.lastSuccessfulAt);
  if (lastSuccessfulAt === null) return state.errorCode !== null ? 'error' : 'never_loaded';
  if (
    state.windowDays !== windowDays
    || state.errorCode !== null
    || nowMillis - lastSuccessfulAt > RADAR_STALE_AFTER_MS
  ) return 'stale';
  if (state.partialReasons.length > 0) return 'partial';
  return 'fresh';
}
export function makeRadarStatus(
  accountLogin: string | null,
  hasMainToken: boolean,
  refreshing: boolean,
  state: RadarStateRecord | null,
  nowMillis = Date.now(),
  windowDays = DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS,
  reconciliation: RadarReconciliationCheckpoint | null = null,
): RadarStatus {
  return {
    accountLogin: accountLogin ? accountKey(accountLogin) : null,
    hasMainToken,
    refreshing,
    windowDays,
    snapshotStatus: !hasMainToken
      ? 'not_configured'
      : radarSnapshotStatus(state, nowMillis, windowDays),
    errorCode: state?.errorCode ?? null,
    state,
    reconciliation: projectRadarReconciliationStatus(reconciliation, refreshing),
  };
}
