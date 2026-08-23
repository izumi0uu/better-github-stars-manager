import type {
  RadarActivityPresentation,
  RadarActivityRecord,
  RadarErrorCode,
  RadarStateRecord,
} from '@/radar/radar-model';
import {
  dedupeRadarActivities,
  normalizeRadarPartialReasons,
} from '@/radar/radar-model';
import { projectRadarActivities } from '@/radar/radar-projector';
import type {
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

function emptyState(accountLogin: string, lastAttemptAt = now()): RadarStateRecord {
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
  };
}

function normalizeState(state: RadarStateRecord): RadarStateRecord {
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
  };
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function storedSeenAt(value: unknown): string | null {
  return typeof value === 'string' && timestamp(value) !== null ? value : null;
}
function stateForAccount(
  state: RadarStateRecord | undefined,
  accountLogin: string,
): RadarStateRecord | null {
  if (!state) return null;
  const normalized = normalizeState(state);
  return normalized.accountLogin === accountKey(accountLogin) ? normalized : null;
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
    const previousState = stateForAccount(storedState, accountLogin);
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
    }));
    const mergedById = new Map(existingById);
    for (const activity of incoming) mergedById.set(activity.id, activity);
    const activities = completeFull
      ? incoming
      : dedupeRadarActivities(mergedById.values());
    if (completeFull) await db.radarActivities.clear();
    const written = completeFull ? activities : incoming;
    if (written.length > 0) await db.radarActivities.bulkPut(written);

    const previousOrEmpty = previousState ?? emptyState(accountLogin, attemptAt);
    const state: RadarStateRecord = {
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
    };
    await db.radarState.put(state);
    return state;
  });
}

export async function commitRadarSnapshot(
  snapshot: RadarSourceSnapshot,
  options: RadarCommitOptions = {},
): Promise<RadarStateRecord> {
  return commitRadarRefresh(snapshot, options);
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
    const previous = stateForAccount(stored, key);
    const state: RadarStateRecord = {
      ...(previous ?? emptyState(key, attemptAt)),
      id: RADAR_STATE_ID,
      accountLogin: key,
      lastAttemptAt: attemptAt,
      errorCode,
      nextAllowedAt: options.nextAllowedAt ?? null,
    };
    await db.radarState.put(state);
    return state;
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
  };
}
