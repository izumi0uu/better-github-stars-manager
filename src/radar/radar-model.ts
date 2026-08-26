import type { FollowingHistoryWindowDays } from '@/types';

import {
  normalizeRepositoryFullName,
  repositoryHtmlUrl,
} from '@/watch/watch-model';

export const RADAR_STARS_PER_FOLLOWER = 30;
export const RADAR_MAX_FOLLOWING = 200;
export const RADAR_PARTIAL_REASONS = [
  'github_star_list_truncated',
  'private_activity_omitted',
  'following_scan_truncated',
] as const;

export type RadarPartialReason = typeof RADAR_PARTIAL_REASONS[number];
export type RadarActivitySource = 'following' | 'self';
export type RadarRefreshMode = 'full' | 'incremental';
export type RadarReconciliationPauseReason = 'request_budget' | 'deadline' | 'rate_reserve';
const RADAR_RECONCILIATION_DAY_MS = 24 * 60 * 60 * 1_000;

export interface RadarReconciliationFollowingCursor {
  phase: 'following';
  nextCursor: string | null;
  seenCursors: string[];
  logins: string[];
  totalCount: number | null;
}

export interface RadarReconciliationActorCursor {
  login: string;
  nextCursor: string | null;
  seenCursors: string[];
  complete: boolean;
}

export interface RadarReconciliationActivityCursor {
  phase: 'activity';
  followingCount: number;
  actors: RadarReconciliationActorCursor[];
}

export type RadarReconciliationCursor =
  | RadarReconciliationFollowingCursor
  | RadarReconciliationActivityCursor;

export interface RadarReconciliationCheckpoint {
  schemaVersion: 1;
  reconciliationId: string;
  revision: number;
  accountLogin: string;
  credentialIdentity: string;
  windowDays: FollowingHistoryWindowDays;
  startedAt: string;
  cutoffAt: string;
  updatedAt: string;
  cursor: RadarReconciliationCursor;
  partialReasons: RadarPartialReason[];
  scannedFollowingCount: number;
  batchCount: number;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  maxRequestCost: number | null;
  pauseReason: RadarReconciliationPauseReason | null;
  nextAllowedAt: string | null;
}


export type RadarErrorCode =
  | 'authentication_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'request_aborted'
  | 'deadline_exceeded'
  | 'network_error'
  | 'github_unavailable'
  | 'invalid_content_type'
  | 'invalid_response'
  | 'invalid_pagination'
  | 'invalid_activity';

/** Stable error metadata only; GraphQL payloads and token data never escape. */
export class GitHubRadarError extends Error {
  readonly code: RadarErrorCode;
  readonly status?: number;
  readonly batch?: number;
  readonly resetAt?: string;

  constructor(
    code: RadarErrorCode,
    options: { status?: number; batch?: number; resetAt?: string } = {},
  ) {
    super(code);
    this.name = 'GitHubRadarError';
    this.code = code;
    this.status = options.status;
    this.batch = options.batch;
    this.resetAt = options.resetAt;
  }
}

export interface RadarActivityRecord {
  id: string;
  accountLogin: string;
  actorLogin: string;
  actorAvatarUrl: string | null;
  repositoryKey: string;
  repositoryFullName: string;
  repositoryDisplayName: string;
  repositoryHtmlUrl: string;
  repositoryDescription: string;
  repositoryLanguage: string | null;
  repositoryLanguageColor: string | null;
  repositoryOwnerLogin?: string | null;
  repositoryOwnerAvatarUrl?: string | null;
  repositoryTopics: string[];
  repositoryStargazerCount: number;
  viewerHadStarred: boolean;
  starredAt: string;
  dismissedAt: string | null;
  seenAt: string | null;
  /** Persistence-only marker for the full reconciliation that observed this row. */
  reconciliationId?: string | null;
}

export interface RadarActivityPresentation extends RadarActivityRecord {
  source: RadarActivitySource;
  seen: boolean;
  viewerHasStarred: boolean;
  favorite: boolean;
  tags: string[];
  suggestedTags: string[];
  displayedStargazerCount: number;
}

export interface RadarProjectPresentation {
  repositoryKey: string;
  repositoryFullName: string;
  repositoryDisplayName: string;
  repositoryHtmlUrl: string;
  repositoryDescription: string;
  repositoryLanguage: string | null;
  repositoryLanguageColor: string | null;
  repositoryOwnerLogin: string | null;
  repositoryOwnerAvatarUrl: string | null;
  repositoryStargazerCount: number;
  displayedStargazerCount: number;
  viewerHasStarred: boolean;
  favorite: boolean;
  tags: string[];
  suggestedTags: string[];
  activityCount: number;
  latestStarredAt: string;
  /** The same newest-first activity references used by Feed, not a second scan. */
  activities: readonly RadarActivityPresentation[];
  activityIds: string[];
}
export interface RadarStateRecord {
  id: 'singleton';
  accountLogin: string;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  /** Window covered by the latest authoritative full reconciliation. */
  windowDays: number | null;
  lastRefreshMode?: RadarRefreshMode | null;
  lastIncrementalAt?: string | null;
  lastFullReconciledAt?: string | null;
  /** Opaque credential/account identity used to fence refresh provenance. */
  credentialIdentity?: string | null;
  errorCode: RadarErrorCode | null;
  nextAllowedAt: string | null;
  activityCount: number;
  followingCount: number;
  scannedFollowingCount: number;
  batchCount: number;
  partialReasons: RadarPartialReason[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  /** Highest GitHub-reported GraphQL cost observed in the latest refresh. */
  maxRequestCost?: number | null;
}

/** Private persisted state; reconciliation cursors never cross the UI boundary. */
export interface RadarStoredStateRecord extends RadarStateRecord {
  reconciliation?: RadarReconciliationCheckpoint | null;
}


function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
export function normalizeRadarRepositoryTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.flatMap((item) => {
    const topic = nonEmptyString(item);
    return topic ? [topic.toLocaleLowerCase('en-US')] : [];
  });
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}


function normalizedTimestamp(value: unknown): string {
  const text = nonEmptyString(value);
  if (!text) throw new GitHubRadarError('invalid_activity');
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new GitHubRadarError('invalid_activity');
  return new Date(millis).toISOString();
}

function normalizedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubRadarError('invalid_activity');
  }
  return value;
}

function normalizedNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return nonEmptyString(value);
}

function normalizedLanguageColor(value: unknown): string | null {
  const color = normalizedNullableString(value);
  if (color === null) return null;
  if (!/^#[0-9a-f]{6}$/iu.test(color)) throw new GitHubRadarError('invalid_activity');
  return color.toLowerCase();
}

function canonicalLogin(value: unknown): string {
  const login = nonEmptyString(value);
  if (!login || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(login)) {
    throw new GitHubRadarError('invalid_activity');
  }
  return login.toLocaleLowerCase('en-US');
}
function checkpointTimestamp(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}
function reconciliationCutoffAt(
  startedAt: string,
  windowDays: FollowingHistoryWindowDays,
): string {
  return new Date(
    Date.parse(startedAt) - windowDays * RADAR_RECONCILIATION_DAY_MS,
  ).toISOString();
}


function checkpointCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function checkpointNullableCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  const count = checkpointCount(value);
  return count === null ? undefined : count;
}

function checkpointNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  const text = nonEmptyString(value);
  return text ?? undefined;
}

function checkpointStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.map(nonEmptyString);
  if (strings.some((item) => item === null)) return null;
  const normalized = strings as string[];
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function checkpointLogin(value: unknown): string | null {
  try {
    return canonicalLogin(value);
  } catch {
    return null;
  }
}

function checkpointLoginList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > RADAR_MAX_FOLLOWING) return null;
  const logins = value.map(checkpointLogin);
  if (logins.some((login) => login === null)) return null;
  const normalized = logins as string[];
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function normalizeReconciliationCursor(value: unknown): RadarReconciliationCursor | null {
  const input = record(value);
  if (!input) return null;
  if (input.phase === 'following') {
    const nextCursor = checkpointNullableString(input.nextCursor);
    const seenCursors = checkpointStringList(input.seenCursors);
    const logins = checkpointLoginList(input.logins);
    const totalCount = checkpointNullableCount(input.totalCount);
    if (
      nextCursor === undefined
      || !seenCursors
      || !logins
      || totalCount === undefined
      || (totalCount !== null && totalCount < logins.length)
      || (nextCursor === null && (
        seenCursors.length !== 0 || logins.length !== 0 || totalCount !== null
      ))
      || (nextCursor !== null && seenCursors.at(-1) !== nextCursor)
    ) return null;
    return { phase: 'following', nextCursor, seenCursors, logins, totalCount };
  }
  if (input.phase !== 'activity' || !Array.isArray(input.actors)) return null;
  if (input.actors.length > RADAR_MAX_FOLLOWING) return null;
  const followingCount = checkpointCount(input.followingCount);
  if (followingCount === null || followingCount < input.actors.length) return null;
  const actors: RadarReconciliationActorCursor[] = [];
  for (const value of input.actors) {
    const actor = record(value);
    const login = checkpointLogin(actor?.login);
    const nextCursor = checkpointNullableString(actor?.nextCursor);
    const seenCursors = checkpointStringList(actor?.seenCursors);
    const complete = actor?.complete;
    if (
      !login
      || nextCursor === undefined
      || !seenCursors
      || typeof complete !== 'boolean'
      || (complete && nextCursor !== null)
      || (!complete && nextCursor === null && seenCursors.length !== 0)
      || (nextCursor !== null && seenCursors.at(-1) !== nextCursor)
    ) return null;
    actors.push({ login, nextCursor, seenCursors, complete });
  }
  if (new Set(actors.map((actor) => actor.login)).size !== actors.length) return null;
  return { phase: 'activity', followingCount, actors };
}

export function createRadarReconciliationCheckpoint(input: Readonly<{
  reconciliationId: string;
  accountLogin: string;
  credentialIdentity: string;
  windowDays: FollowingHistoryWindowDays;
  startedAt: string;
}>): RadarReconciliationCheckpoint {
  const startedAt = checkpointTimestamp(input.startedAt);
  const reconciliationId = nonEmptyString(input.reconciliationId);
  const credentialIdentity = nonEmptyString(input.credentialIdentity);
  const accountLogin = checkpointLogin(input.accountLogin);
  if (!startedAt || !reconciliationId || !credentialIdentity || !accountLogin) {
    throw new TypeError('Radar reconciliation identity is invalid.');
  }
  return {
    schemaVersion: 1,
    reconciliationId,
    revision: 0,
    accountLogin,
    credentialIdentity,
    windowDays: input.windowDays,
    startedAt,
    cutoffAt: reconciliationCutoffAt(startedAt, input.windowDays),
    updatedAt: startedAt,
    cursor: {
      phase: 'following',
      nextCursor: null,
      seenCursors: [],
      logins: [],
      totalCount: null,
    },
    partialReasons: [],
    scannedFollowingCount: 0,
    batchCount: 0,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
    maxRequestCost: null,
    pauseReason: null,
    nextAllowedAt: null,
  };
}

export function normalizeRadarReconciliationCheckpoint(
  value: unknown,
): RadarReconciliationCheckpoint | null {
  const input = record(value);
  if (!input || input.schemaVersion !== 1) return null;
  const reconciliationId = nonEmptyString(input.reconciliationId);
  const revision = checkpointCount(input.revision);
  const accountLogin = checkpointLogin(input.accountLogin);
  const credentialIdentity = nonEmptyString(input.credentialIdentity);
  const windowDays = input.windowDays;
  const normalizedWindowDays: FollowingHistoryWindowDays | null = windowDays === 30
    || windowDays === 60
    || windowDays === 90
    ? windowDays
    : null;
  const startedAt = checkpointTimestamp(input.startedAt);
  const cutoffAt = checkpointTimestamp(input.cutoffAt);
  const updatedAt = checkpointTimestamp(input.updatedAt);
  const cursor = normalizeReconciliationCursor(input.cursor);
  const scannedFollowingCount = checkpointCount(input.scannedFollowingCount);
  const batchCount = checkpointCount(input.batchCount);
  const rateLimitRemaining = checkpointNullableCount(input.rateLimitRemaining);
  const rateLimitResetAt = input.rateLimitResetAt === null
    ? null
    : checkpointTimestamp(input.rateLimitResetAt);
  const maxRequestCost = checkpointNullableCount(input.maxRequestCost);
  const pauseReason = input.pauseReason;
  const nextAllowedAt = input.nextAllowedAt === null
    ? null
    : checkpointTimestamp(input.nextAllowedAt);
  if (
    !reconciliationId
    || revision === null
    || !accountLogin
    || !credentialIdentity
    || normalizedWindowDays === null
    || !startedAt
    || !cutoffAt
    || !updatedAt
    || Date.parse(cutoffAt) > Date.parse(startedAt)
    || Date.parse(updatedAt) < Date.parse(startedAt)
    || !cursor
    || scannedFollowingCount === null
    || scannedFollowingCount > (cursor.phase === 'activity' ? cursor.actors.length : cursor.logins.length)
    || batchCount === null
    || rateLimitRemaining === undefined
    || (input.rateLimitResetAt !== null && rateLimitResetAt === null)
    || maxRequestCost === undefined
    || (pauseReason !== null
      && pauseReason !== 'request_budget'
      && pauseReason !== 'deadline'
      && pauseReason !== 'rate_reserve')
    || (input.nextAllowedAt !== null && nextAllowedAt === null)
  ) return null;
  if (cutoffAt !== reconciliationCutoffAt(startedAt, normalizedWindowDays)) return null;
  const partialReasons = normalizeRadarPartialReasons(input.partialReasons);
  if (
    !Array.isArray(input.partialReasons)
    || input.partialReasons.some((reason) => (
      typeof reason !== 'string' || !RADAR_PARTIAL_REASONS.includes(reason as RadarPartialReason)
    ))
  ) return null;
  return {
    schemaVersion: 1,
    reconciliationId,
    revision,
    accountLogin,
    credentialIdentity,
    windowDays: normalizedWindowDays,
    startedAt,
    cutoffAt,
    updatedAt,
    cursor,
    partialReasons,
    scannedFollowingCount,
    batchCount,
    rateLimitRemaining,
    rateLimitResetAt,
    maxRequestCost,
    pauseReason,
    nextAllowedAt,
  };
}

export function normalizeRadarAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function radarActivityId(input: {
  actorLogin: string;
  repositoryFullName: string;
  starredAt: string;
}): string {
  return JSON.stringify([
    canonicalLogin(input.actorLogin),
    normalizeRepositoryFullName(input.repositoryFullName),
    normalizedTimestamp(input.starredAt),
  ]);
}

/** Normalize one GraphQL star edge into the only persisted Radar row shape. */
export function normalizeRadarActivity(
  value: unknown,
  options: { accountLogin: string; dismissedAt?: string | null },
): RadarActivityRecord {
  const input = record(value);
  if (!input) throw new GitHubRadarError('invalid_activity');

  const actorLogin = nonEmptyString(input.actorLogin);
  const repositoryDisplayName = nonEmptyString(input.repositoryFullName);
  if (!actorLogin || !repositoryDisplayName) throw new GitHubRadarError('invalid_activity');

  let repositoryKey: string;
  try {
    repositoryKey = normalizeRepositoryFullName(repositoryDisplayName);
  } catch {
    throw new GitHubRadarError('invalid_activity');
  }

  const starredAt = normalizedTimestamp(input.starredAt);
  const dismissedAt = options.dismissedAt == null
    ? null
    : normalizedTimestamp(options.dismissedAt);

  return {
    id: radarActivityId({ actorLogin, repositoryFullName: repositoryKey, starredAt }),
    accountLogin: canonicalLogin(options.accountLogin),
    actorLogin,
    actorAvatarUrl: normalizeRadarAvatarUrl(input.actorAvatarUrl),
    repositoryKey,
    repositoryFullName: repositoryDisplayName,
    repositoryDisplayName,
    repositoryHtmlUrl: repositoryHtmlUrl(repositoryKey),
    repositoryDescription: typeof input.repositoryDescription === 'string'
      ? input.repositoryDescription
      : '',
    repositoryLanguage: normalizedNullableString(input.repositoryLanguage),
    repositoryLanguageColor: normalizedLanguageColor(input.repositoryLanguageColor),
    repositoryOwnerLogin: normalizedNullableString(input.repositoryOwnerLogin),
    repositoryOwnerAvatarUrl: normalizeRadarAvatarUrl(input.repositoryOwnerAvatarUrl),
    repositoryTopics: normalizeRadarRepositoryTopics(input.repositoryTopics),
    repositoryStargazerCount: normalizedCount(input.repositoryStargazerCount),
    viewerHadStarred: input.viewerHadStarred === true,
    starredAt,
    dismissedAt,
    seenAt: null,
  };
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stable newest-first ordering with deterministic activity identity ties. */
export function sortRadarActivities<T extends Pick<RadarActivityRecord, 'id' | 'starredAt'>>(
  activities: Iterable<T>,
): T[] {
  return [...activities].sort((left, right) => (
    timestampValue(right.starredAt) - timestampValue(left.starredAt)
      || left.id.localeCompare(right.id)
  ));
}

export function dedupeRadarActivities(
  activities: Iterable<RadarActivityRecord>,
): RadarActivityRecord[] {
  const byId = new Map<string, RadarActivityRecord>();
  for (const activity of sortRadarActivities(activities)) {
    if (!byId.has(activity.id)) byId.set(activity.id, activity);
  }
  return sortRadarActivities(byId.values());
}

export function normalizeRadarPartialReasons(value: unknown): RadarPartialReason[] {
  if (!Array.isArray(value)) return [];
  const allowed: Record<RadarPartialReason, true> = {
    github_star_list_truncated: true,
    private_activity_omitted: true,
    following_scan_truncated: true,
  };
  const present = new Set(value.filter((item): item is RadarPartialReason => (
    typeof item === 'string' && item in allowed
  )));
  return RADAR_PARTIAL_REASONS.filter((reason) => present.has(reason));

}

/** Projects is always derived from the same flat Feed model. */
export function aggregateRadarProjects(
  activities: readonly RadarActivityPresentation[],
): RadarProjectPresentation[] {
  const groups = new Map<string, RadarActivityPresentation[]>();
  for (const activity of sortRadarActivities(activities)) {
    const group = groups.get(activity.repositoryKey);
    if (group) group.push(activity);
    else groups.set(activity.repositoryKey, [activity]);
  }

  return [...groups.values()].map((group) => {
    const latest = group[0]!;
    return {
      repositoryKey: latest.repositoryKey,
      repositoryFullName: latest.repositoryFullName,
      repositoryDisplayName: latest.repositoryDisplayName,
      repositoryHtmlUrl: latest.repositoryHtmlUrl,
      repositoryDescription: latest.repositoryDescription,
      repositoryLanguage: latest.repositoryLanguage,
      repositoryLanguageColor: latest.repositoryLanguageColor,
      repositoryOwnerLogin: latest.repositoryOwnerLogin ?? null,
      repositoryOwnerAvatarUrl: latest.repositoryOwnerAvatarUrl ?? null,
      repositoryStargazerCount: latest.repositoryStargazerCount,
      displayedStargazerCount: latest.displayedStargazerCount,
      viewerHasStarred: latest.viewerHasStarred,
      favorite: latest.favorite,
      tags: latest.tags,
      suggestedTags: latest.suggestedTags,
      activityCount: group.length,
      latestStarredAt: latest.starredAt,
      activities: group,
      activityIds: group
        .filter((activity) => activity.source === 'following')
        .map((activity) => activity.id),
    };
  }).sort((left, right) => (
    timestampValue(right.latestStarredAt) - timestampValue(left.latestStarredAt)
      || left.repositoryFullName.localeCompare(right.repositoryFullName)
  ));
}
