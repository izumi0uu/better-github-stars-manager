/** Core domain types for Better GitHub Stars Manager. */

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

/** Star metadata stored locally. */
export interface Star {
  full_name: string;
  html_url: string;
  description: string;
  language: string | null;
  stargazers_count: number;
  topics: string[];
  pushed_at: string; // ISO, repo last push
  fork: boolean;
  archived: boolean;
  starred_at: string;
  /** Latest known release date for the repo (published_at preferred, created_at fallback). */
  latest_release_at: string | null;
  /** Timestamp of the last attempt to hydrate latest_release_at. */
  latest_release_synced_at: string | null;
  /** True once a full rescan no longer sees this repo in /user/starred. */
  tombstone: boolean;
  synced_at: string;
}

/** The user's annotation record for a repo. */
export interface Tag {
  full_name: string;
  tags: string[];
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
  /** Max number of topic-derived tags auto-added per repo in a single auto-tag pass. */
  autoTagLimit: number;
  /** Whether your own GitHub stars page should open the overlay panel by default. */
  starsPanelDefaultEnabled: boolean;
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

/** Serialized tag transport stored in the sync gist. */
export interface GistPayload {
  v: 1;
  tags: Record<string, Omit<Tag, 'full_name'>>;
  tagMeta: Record<string, Omit<TagMeta, 'name'>>;
  exportedAt: string;
}

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
