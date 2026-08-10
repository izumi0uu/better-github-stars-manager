import type {
  GitHubWatchStateRecord,
  WatchInboxProjection,
} from '@/watch/watch-model';

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
  accountLogin: string | null;
  hasMainToken: boolean;
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
