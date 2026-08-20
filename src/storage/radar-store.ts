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
  return state && state.accountLogin === accountKey(accountLogin) ? state : null;
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
    if (state?.accountLogin !== key) return 0;
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
    if (state?.accountLogin === key) return;
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
  return existing ? storedSeenAt(existing.seenAt) : null;
}


/** Replace one account's snapshot while retaining explicit dismissals and seen state. */
export async function commitRadarSnapshot(snapshot: RadarSourceSnapshot): Promise<RadarStateRecord> {
  const accountLogin = accountKey(snapshot.accountLogin);
  const attemptAt = now();
  return db.transaction('rw', db.radarActivities, db.radarState, async () => {
    const previous = await db.radarActivities.toArray();
    const existingById = new Map(
      previous
        .filter((activity) => activity.accountLogin === accountLogin)
        .map((activity) => [activity.id, activity] as const),
    );
    const activities = dedupeRadarActivities(snapshot.activities).map((activity) => ({
      ...activity,
      accountLogin,
      dismissedAt: preservedDismissedAt(existingById, activity),
      seenAt: preservedSeenAt(existingById, activity),
    }));
    await db.radarActivities.clear();
    if (activities.length > 0) await db.radarActivities.bulkPut(activities);

    const previousState = stateForAccount(
      await db.radarState.get(RADAR_STATE_ID),
      accountLogin,
    );
    const state: RadarStateRecord = {
      ...(previousState ?? emptyState(accountLogin, attemptAt)),
      id: RADAR_STATE_ID,
      accountLogin,
      lastAttemptAt: attemptAt,
      lastSuccessfulAt: snapshot.fetchedAt,
      windowDays: snapshot.windowDays,
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

export async function recordRadarFailure(
  accountLogin: string,
  errorCode: RadarErrorCode,
  options: { nextAllowedAt?: string | null } = {},
): Promise<RadarStateRecord> {
  const key = accountKey(accountLogin);
  const attemptAt = now();
  return db.transaction('rw', db.radarState, async () => {
    const previous = stateForAccount(await db.radarState.get(RADAR_STATE_ID), key);
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
