import {
  projectWatchInbox,
  type GitHubNotificationThread,
  type WatchInboxProjection,
} from '@/watch/watch-model';
import type { WatchInboxQueryResponse } from '@/watch/watch-contract';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const WATCH_CREDENTIAL_ERROR_CODES: Record<string, true> = {
  authentication_required: true,
  permission_denied: true,
};

/** Compact, locale-neutral age used for Watch's machine-data column. */
export function formatWatchRelativeTime(
  value: string | null,
  now: number = Date.now(),
): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return null;

  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE_MS) return '<1m';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (elapsed < MONTH_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  if (elapsed < YEAR_MS) return `${Math.floor(elapsed / MONTH_MS)}mo`;
  return `${Math.floor(elapsed / YEAR_MS)}y`;
}

export type WatchReasonPreset =
  | 'direct'
  | 'security'
  | 'participation'
  | 'watching'
  | 'other';

export const WATCH_REASON_PRESETS: Record<Exclude<WatchReasonPreset, 'other'>, readonly string[]> = {
  direct: [
    'approval_requested',
    'assign',
    'invitation',
    'member_feature_requested',
    'mention',
    'review_requested',
    'team_mention',
  ],
  security: ['security_advisory_credit', 'security_alert'],
  participation: ['author', 'ci_activity', 'comment', 'manual', 'state_change'],
  watching: ['subscribed'],
};

const CATEGORIZED_REASONS = new Set(Object.values(WATCH_REASON_PRESETS).flat());

export interface WatchReasonCount {
  reason: string;
  count: number;
}

export function countWatchReasons(
  threads: Iterable<GitHubNotificationThread>,
): WatchReasonCount[] {
  const counts = new Map<string, WatchReasonCount>();
  for (const thread of threads) {
    const key = thread.reason.toLowerCase();
    const current = counts.get(key);
    if (current) current.count++;
    else counts.set(key, { reason: thread.reason, count: 1 });
  }
  return Array.from(counts.values()).sort((left, right) => (
    left.reason.localeCompare(right.reason)
  ));
}

export function watchReasonPresetValues(
  preset: WatchReasonPreset,
  availableReasons: Iterable<string>,
): string[] {
  const available = Array.from(availableReasons);
  const allowed = preset === 'other'
    ? null
    : new Set(WATCH_REASON_PRESETS[preset]);
  return available.filter((reason) => (
    allowed ? allowed.has(reason.toLowerCase()) : !CATEGORIZED_REASONS.has(reason.toLowerCase())
  ));
}

export function filterWatchInboxProjection(
  projection: WatchInboxProjection,
  input: { query?: string; reasons?: Iterable<string> } = {},
): WatchInboxProjection {
  const query = input.query?.trim().toLowerCase() ?? '';
  const reasons = new Set(
    Array.from(input.reasons ?? [], (reason) => reason.trim().toLowerCase()).filter(Boolean),
  );
  const threads = projection.threads.filter((thread) => {
    if (reasons.size > 0 && !reasons.has(thread.reason.toLowerCase())) return false;
    if (!query) return true;
    return [
      thread.repositoryFullName,
      thread.subjectTitle,
    ].some((value) => value.toLowerCase().includes(query));
  });
  return projectWatchInbox(threads);
}
export function watchGroupContentSignature(
  threads: Iterable<GitHubNotificationThread>,
): string {
  const markers = Array.from(threads, (thread) => [thread.id, thread.updatedAt] as const);
  markers.sort(([leftId, leftUpdatedAt], [rightId, rightUpdatedAt]) => (
    leftId.localeCompare(rightId) || leftUpdatedAt.localeCompare(rightUpdatedAt)
  ));
  return JSON.stringify(markers);
}

export function hasNewWatchGroupContent(
  previousSignature: string,
  threads: Iterable<GitHubNotificationThread>,
): boolean {
  let previousMarkers: Set<string>;
  try {
    const parsed = JSON.parse(previousSignature) as unknown;
    if (!Array.isArray(parsed)) return true;
    previousMarkers = new Set(parsed.map((marker) => JSON.stringify(marker)));
  } catch {
    return true;
  }
  return Array.from(threads).some((thread) => (
    !previousMarkers.has(JSON.stringify([thread.id, thread.updatedAt]))
  ));
}

export type WatchStatusPresentationKind =
  | 'loading'
  | 'refreshing'
  | 'credential_error'
  | 'query_error'
  | 'refresh_error'
  | 'cooldown'
  | 'scope_error'
  | 'inbox_error'
  | 'stale'
  | 'truncated'
  | 'never_loaded'
  | 'fresh';

export interface WatchStatusPresentation {
  kind: WatchStatusPresentationKind;
  tone: 'muted' | 'success' | 'warning' | 'destructive';
  code: string | null;
  snapshotAt: string | null;
}

export function deriveWatchStatusPresentation(input: {
  result: WatchInboxQueryResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: 'query' | 'refresh' | null;
}): WatchStatusPresentation {
  const { result, loading, refreshing, error } = input;
  if (loading && !result) {
    return { kind: 'loading', tone: 'muted', code: null, snapshotAt: null };
  }

  const state = result?.status.state;
  const code = state?.inbox.errorCode ?? state?.scope.errorCode ?? null;
  const snapshotAt = state?.inbox.lastSuccessfulAt ?? state?.scope.lastSuccessfulAt ?? null;
  const hasSnapshot = snapshotAt !== null;
  if (code && WATCH_CREDENTIAL_ERROR_CODES[code]) {
    return {
      kind: 'credential_error',
      tone: hasSnapshot ? 'warning' : 'destructive',
      code,
      snapshotAt,
    };
  }
  if (error === 'query') {
    return {
      kind: 'query_error',
      tone: hasSnapshot ? 'warning' : 'destructive',
      code,
      snapshotAt,
    };
  }
  if (error === 'refresh') {
    return { kind: 'refresh_error', tone: 'warning', code, snapshotAt };
  }
  if (result?.status.inboxStatus === 'cooldown') {
    return { kind: 'cooldown', tone: 'warning', code: 'cooldown', snapshotAt };
  }
  if (result?.status.scopeStatus === 'error') {
    return {
      kind: 'scope_error',
      tone: hasSnapshot ? 'warning' : 'destructive',
      code,
      snapshotAt,
    };
  }
  if (result?.status.inboxStatus === 'error') {
    return {
      kind: 'inbox_error',
      tone: hasSnapshot ? 'warning' : 'destructive',
      code,
      snapshotAt,
    };
  }
  if (result?.status.scopeStatus === 'stale' || result?.status.inboxStatus === 'stale') {
    return { kind: 'stale', tone: 'warning', code, snapshotAt };
  }
  if (state?.inbox.truncated) {
    return { kind: 'truncated', tone: 'warning', code: 'truncated', snapshotAt };
  }
  if (refreshing || result?.status.refreshing) {
    return { kind: 'refreshing', tone: 'muted', code: null, snapshotAt };
  }
  if (!result || result.status.scopeStatus === 'not_configured'
    || result.status.scopeStatus === 'never_loaded'
    || result.status.inboxStatus === 'not_configured'
    || result.status.inboxStatus === 'never_loaded'
    || result.status.inboxStatus === 'scope_unavailable') {
    return { kind: 'never_loaded', tone: 'muted', code: null, snapshotAt };
  }
  return { kind: 'fresh', tone: 'success', code: null, snapshotAt };
}
