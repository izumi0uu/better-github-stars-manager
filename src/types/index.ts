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
  /** One-shot migration flag: clear auto-derived `language` tags (now that
   *  language is a first-class filter, not a tag). Set true after the migration
   *  runs so it never repeats. */
  langTagMigrationDone: boolean;
  /** Last sync snapshot mirrored from the background so reopened surfaces can
   *  still show progress/error context after a long-running job or SW wake. */
  lastSyncProgress: SyncProgress;
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
