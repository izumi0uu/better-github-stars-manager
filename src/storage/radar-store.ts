import type { Star, Tag } from '@/types';
import { normalizeRepositoryFullName } from '@/watch/watch-model';
import type {
  RadarActivityPresentation,
  RadarActivityRecord,
  RadarErrorCode,
  RadarStateRecord,
} from '@/radar/radar-model';
import {
  dedupeRadarActivities,
  normalizeRadarActivity,
  normalizeRadarAvatarUrl,
  normalizeRadarPartialReasons,
  RADAR_DEFAULT_TAG_SUGGESTIONS,
  RADAR_WINDOW_DAYS,
  sortRadarActivities,
} from '@/radar/radar-model';
import type {
  RadarSnapshotStatus,
  RadarSourceSnapshot,
  RadarStatus,
} from '@/radar/radar-contract';
import { canonicalTagKey, visibleTagNames } from '@/tags/tag-model';
import { db } from './db';

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



async function getTagsByKey(repositoryKeys: ReadonlySet<string>): Promise<Map<string, Tag>> {
  const result = new Map<string, Tag>();
  await db.tags.each((tag) => {
    const key = normalizeRepositoryFullName(tag.full_name);
    if (repositoryKeys.has(key)) result.set(key, tag);
  });
  return result;
}

function ownStarPresentation(
  star: Star,
  accountLogin: string,
  tag: Tag | undefined,
): RadarActivityPresentation | null {
  try {
    const activity = normalizeRadarActivity({
      actorLogin: accountLogin,
      actorAvatarUrl: null,
      repositoryFullName: star.full_name,
      repositoryDescription: star.description,
      repositoryLanguage: star.language,
      repositoryLanguageColor: null,
      repositoryStargazerCount: star.stargazers_count,
      viewerHadStarred: true,
      starredAt: star.starred_at,
    }, { accountLogin });
    return {
      ...activity,
      source: 'self',
      seen: true,
      viewerHasStarred: true,
      favorite: tag?.favorite === true,
      tags: tag ? visibleTagNames(tag) : [],
      displayedStargazerCount: star.stargazers_count,
    };
  } catch {
    return null;
  }
}

export async function listRadarActivities(
  accountLogin: string,
  nowMillis = Date.now(),
): Promise<RadarActivityPresentation[]> {
  const key = accountKey(accountLogin);
  const [storedActivities, allStars] = await Promise.all([
    db.radarActivities.where('accountLogin').equals(key).toArray(),
    db.stars.toArray(),
  ]);
  const rows = storedActivities.filter((activity) => activity.dismissedAt === null);
  const cutoffMillis = nowMillis - RADAR_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
  const ownStars = allStars.filter((star) => {
    const starredAt = timestamp(star.starred_at);
    return !star.tombstone
      && star.viewer_has_starred !== false
      && starredAt !== null
      && starredAt >= cutoffMillis
      && starredAt <= nowMillis;
  });
  const repositoryKeys = new Set([
    ...rows.map((row) => row.repositoryKey),
    ...ownStars.map((star) => normalizeRepositoryFullName(star.full_name)),
  ]);
  const stars = new Map(
    allStars.flatMap((star) => {
      const repositoryKey = normalizeRepositoryFullName(star.full_name);
      return repositoryKeys.has(repositoryKey) ? [[repositoryKey, star] as const] : [];
    }),
  );
  const tags = await getTagsByKey(repositoryKeys);

  const following = rows.map((activity): RadarActivityPresentation => {
    const star = stars.get(activity.repositoryKey);
    const tag = tags.get(activity.repositoryKey);
    const seenAt = storedSeenAt(activity.seenAt);
    return {
      ...activity,
      source: 'following',
      seenAt,
      seen: seenAt !== null,
      actorAvatarUrl: normalizeRadarAvatarUrl(activity.actorAvatarUrl),
      viewerHasStarred: star
        ? !star.tombstone && star.viewer_has_starred !== false
        : activity.viewerHadStarred,
      favorite: tag?.favorite === true,
      tags: tag ? visibleTagNames(tag) : [],
      displayedStargazerCount: star?.stargazers_count ?? activity.repositoryStargazerCount,
    };
  });
  const own = ownStars.flatMap((star) => {
    const repositoryKey = normalizeRepositoryFullName(star.full_name);
    const activity = ownStarPresentation(star, key, tags.get(repositoryKey));
    return activity ? [activity] : [];
  });
  return sortRadarActivities([...following, ...own]);
}

export async function listRadarSuggestedTags(): Promise<string[]> {
  const meta = await db.tagMeta.toArray();
  const excluded = new Set(
    meta.filter((item) => item.excluded === true).map((item) => canonicalTagKey(item.name)),
  );
  const names = meta
    .filter((item) => !item.excluded)
    .map((item) => item.name.trim())
    .filter(Boolean);
  return [...new Set([...RADAR_DEFAULT_TAG_SUGGESTIONS, ...names])]
    .filter((name) => !excluded.has(canonicalTagKey(name)))
    .sort((left, right) => left.localeCompare(right));
}

export function radarSnapshotStatus(
  state: RadarStateRecord | null,
  nowMillis = Date.now(),
): RadarSnapshotStatus {
  if (!state) return 'never_loaded';
  const nextAllowedAt = timestamp(state.nextAllowedAt);
  if (nextAllowedAt !== null && nextAllowedAt > nowMillis) return 'cooldown';
  const lastSuccessfulAt = timestamp(state.lastSuccessfulAt);
  if (lastSuccessfulAt === null) return state.errorCode !== null ? 'error' : 'never_loaded';
  if (state.errorCode !== null || nowMillis - lastSuccessfulAt > RADAR_STALE_AFTER_MS) {
    return 'stale';
  }
  if (state.partialReasons.length > 0) return 'partial';
  return 'fresh';
}

export function makeRadarStatus(
  accountLogin: string | null,
  hasMainToken: boolean,
  refreshing: boolean,
  state: RadarStateRecord | null,
  nowMillis = Date.now(),
): RadarStatus {
  return {
    accountLogin: accountLogin ? accountKey(accountLogin) : null,
    hasMainToken,
    refreshing,
    snapshotStatus: !hasMainToken
      ? 'not_configured'
      : radarSnapshotStatus(state, nowMillis),
    errorCode: state?.errorCode ?? null,
    state,
  };
}
