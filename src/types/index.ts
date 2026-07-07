/** Core domain types for Better GitHub Stars Manager. */

import type { ColumnId } from '@/ui/column-layout';

export type Locale = 'en' | 'zh-CN';

export type OnboardingStage =
  | 'needs_token'
  | 'awaiting_sync'
  | 'syncing'
  | 'sync_failed'
  | 'empty_library'
  | 'coach'
  | 'done';

export type BackfillId = 'repo_data_sync_v1';

export type BackfillStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'deferred';

export interface BackfillState {
  status: BackfillStatus;
  queuedAt: string | null;
  lastAttemptAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export type BackfillMap = Partial<Record<BackfillId, BackfillState>>;

export type LibraryViewSortKey = 'starred_at' | 'pushed_at' | 'created_at' | 'stargazers_count' | 'name';
export type LibraryViewSortDir = 'asc' | 'desc';

export interface LibraryViewPrefs {
  version: 1;
  filters: {
    languages: string[];
    tags: string[];
    tagMode: 'any' | 'all';
    showTombstone: boolean;
    onlyFavorite: boolean;
    onlyUntagged: boolean;
    onlyArchived: boolean;
  };
  sort: {
    sortKey: LibraryViewSortKey;
    sortDir: LibraryViewSortDir;
  };
}

/** Star metadata stored locally. */
export interface Star {
  full_name: string;
  html_url: string;
  description: string;
  language: string | null;
  stargazers_count: number;
  topics: string[];
  pushed_at: string | null; // ISO, repo last push; null for never-pushed repositories
  created_at: string | null; // ISO, repo creation time
  fork: boolean;
  archived: boolean;
  starred_at: string;
  /** True once a full rescan no longer sees this repo in /user/starred. */
  tombstone: boolean;
  synced_at: string;
}

/** The user's annotation record for a repo. */
export interface Tag {
  full_name: string;
  manualTags: string[];
  autoTags: string[];
  dismissedAutoTags: string[];
  manualTagsMtime: string;
  autoTagsMtime: string;
  dismissedAutoTagsMtime: string;
  notes: string;
  favorite?: boolean;
  mtime: string;
  /** Reserved for a possible future GitHub-native Lists integration. */
  gh_list_id?: number | null;
}

/**
 * Metadata about a tag itself. `excluded` acts as a persistent delete tombstone
 * so auto-assign does not resurrect a removed tag.
 */
export interface TagMeta {
  name: string;
  dimension: string | null;
  color: string | null;
  mtime: string;
  /** Auto-assign skips excluded names until a manual re-add clears the tombstone. */
  excluded?: boolean;
}

/** Light config kept in chrome.storage.local. */
export interface Config {
  tokenEncrypted: string | null;
  tokenCryptoMeta: CryptoMeta | null;
  theme: 'dark' | 'light';
  locale: Locale;
  defaultView: 'list' | 'table';
  lastSyncStarredAt: string | null;
  gistId: string | null;
  gistSyncCursor: string | null;
  username: string | null;
  avatarUrl: string | null;
  displayName: string | null;
  /** Explicit first-run onboarding stage. */
  onboardingStage: OnboardingStage;
  /** Hides first-run onboarding once the user dismisses it. */
  seenOnboarding: boolean;
  /** Bitmask of one-time button coachmarks already shown. */
  seenTooltips: number;
  /** Legacy max topic-derived tags per repo. Read as compatibility input only. */
  autoTagLimit: number;
  /** Max topic-derived tags per repo for Auto Tags. */
  maxTagsPerRepo: number;
  /** Minimum repos that must share a topic before bulk Auto Tags generates it. */
  minTopicRepoCount: number;
  /** Durable library view intent for filters and primary sort. */
  libraryView: LibraryViewPrefs;
  /** Whether your own GitHub stars page should open the overlay panel by default. */
  starsPanelDefaultEnabled: boolean;
  /** Last selected stars-table layout mode. */
  columnLayoutMode: 'default' | 'custom';
  /** User-saved custom stars-table column layout; null means custom equals default. */
  customColumnLayout: {
    order: string[];
    hidden: string[];
    widths?: Partial<Record<ColumnId, number>>;
  } | null;
  /** One-shot migration flag: clear auto-derived `language` tags (now that
   *  language is a first-class filter, not a tag). Set true after the migration
   *  runs so it never repeats. */
  langTagMigrationDone: boolean;
  /** Last sync snapshot mirrored from the background so reopened surfaces can
   *  still show progress/error context after a long-running job or SW wake. */
  lastSyncProgress: SyncProgress;
  /** One-shot data-capability backfills keyed by feature, not app version. */
  backfills: BackfillMap;
}

export interface CryptoMeta {
  iv: string; // base64
  salt: string; // base64
}

export type GistTagRowV1 = {
  tags: string[];
  notes: string;
  favorite?: boolean;
  mtime: string;
  gh_list_id?: number | null;
};

export type GistTagRowV2 = {
  manualTags: string[];
  autoTags: string[];
  dismissedAutoTags: string[];
  manualTagsMtime: string;
  autoTagsMtime: string;
  dismissedAutoTagsMtime: string;
  notes: string;
  favorite?: boolean;
  mtime: string;
  gh_list_id?: number | null;
};

export interface GistPayloadV1 {
  v: 1;
  tags: Record<string, GistTagRowV1>;
  tagMeta: Record<string, Omit<TagMeta, 'name'>>;
  exportedAt: string;
}

export interface GistPayloadV2 {
  v: 2;
  tags: Record<string, GistTagRowV2>;
  tagMeta: Record<string, Omit<TagMeta, 'name'>>;
  exportedAt: string;
}

/** Serialized tag transport stored in the sync gist. */
export type GistPayload = GistPayloadV1 | GistPayloadV2;

/** A suggested tag derived from repo metadata. */
export interface TagSuggestion {
  full_name: string;
  suggested: string[];
  source: 'topics';
}

/** Sync progress reported to the UI. */
export interface SyncProgress {
  phase: 'idle' | 'full' | 'incremental' | 'rescan' | 'gist';
  done: number;
  total: number | null;
  message: string;
}
