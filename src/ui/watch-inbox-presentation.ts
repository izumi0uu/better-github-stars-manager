import {
  projectWatchInbox,
  type GitHubNotificationThread,
  type WatchInboxProjection,
} from '@/watch/watch-model';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

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
