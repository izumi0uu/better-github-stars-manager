import type {
  GitHubWatchStateRecord,
  WatchInboxProjection,
} from '@/watch/watch-model';
export type WatchThreadAction = 'read' | 'done';

export const WATCH_MAX_THREAD_ACTIONS = 500;

export interface WatchThreadMutationResult {
  action: WatchThreadAction;
  requestedCount: number;
  changedCount: number;
}

export function parseWatchThreadIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > WATCH_MAX_THREAD_ACTIONS) {
    return null;
  }
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const id = item.trim();
    if (!/^\d{1,32}$/u.test(id) || ids.has(id)) return null;
    ids.add(id);
  }
  return [...ids];
}

export function parseWatchThreadId(value: unknown): string | null {
  const parsed = parseWatchThreadIds([value]);
  return parsed?.[0] ?? null;
}

export type WatchScopeStatus =
  | 'not_configured'
  | 'never_loaded'
  | 'fresh'
  | 'stale'
  | 'error';

export type WatchInboxStatus =
  | 'not_configured'
  | 'scope_unavailable'
  | 'never_loaded'
  | 'fresh'
  | 'stale'
  | 'error'
  | 'cooldown';

export interface WatchStatus {
  /** Legacy status projections may still include this only in archived test fixtures. */
  credentialSource?: 'main' | 'dedicated' | null;
  accountLogin: string | null;
  hasMainToken: boolean;
  hasNotificationsToken: boolean;
  refreshing: boolean;
  scopeStatus: WatchScopeStatus;
  inboxStatus: WatchInboxStatus;
  state: GitHubWatchStateRecord | null;
}

export interface WatchInboxQueryResponse extends WatchInboxProjection {
  status: WatchStatus;
}

export interface WatchRefreshResult {
  status: WatchStatus;
  scopePublished: boolean;
  inboxPublished: boolean;
  notModified: boolean;
}
