import type {
  GitHubWatchStateRecord,
  WatchInboxProjection,
} from '@/watch/watch-model';
export type WatchThreadAction = 'read' | 'done';

export interface WatchThreadMutationInput {
  accountLogin: string;
  threadIds: readonly string[];
}

export function parseWatchAccountLogin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const login = value.trim().toLocaleLowerCase('en-US');
  return login.length > 0 && login.length <= 39 ? login : null;
}

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
  | 'never_loaded'
  | 'fresh'
  | 'stale'
  | 'error'
  | 'cooldown';

export interface WatchStatus {
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

export interface WatchLoadOlderResult {
  status: WatchStatus;
  addedCount: number;
  hasMore: boolean;
}
