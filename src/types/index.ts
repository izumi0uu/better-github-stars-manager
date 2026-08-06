/** Core domain types for Better GitHub Stars Manager. */

import type { ColumnId } from '@/ui/column-layout';
import type { AgentDataDisclosureAcceptance } from '@/bgsm-agent/disclosure';

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

export type OrganizeJobStatus =
  | 'analyzing'
  | 'analysis_blocked'
  | 'paused'
  | 'review'
  | 'apply_sealed'
  | 'applying'
  | 'completed'
  | 'cancelled';

export type OrganizeStoredJobStatus = OrganizeJobStatus | 'preflight_ready';

export type OrganizePreflightState = 'ready' | 'consumed';

export interface OrganizePreflightAuthority {
  token: string;
  requestId: string;
  state: OrganizePreflightState;
  expiresAt: number;
  consumedAt: number | null;
}

export type OrganizeItemAnalysisState =
  | 'pending'
  | 'leased'
  | 'actionable'
  | 'unchanged'
  | 'insufficient_evidence'
  | 'missing'
  | 'tombstoned'
  | 'failed';

export interface OrganizeProposedAction {
  kind: 'add_existing_tag' | 'propose_new_tag';
  tag: string;
  evidence: string;
}

export interface OrganizeFrozenScopeSnapshot {
  kind: string;
  label: string;
  filterSnapshot: unknown;
  repositoryIds: string[];
  capturedAt: number;
  fingerprint: string;
}

export interface OrganizeAnalysisRange {
  startFrozenIndex: number;
  endFrozenIndexExclusive: number;
  depth: number;
}

/** Preference snapshot that stays fixed for one whole-library organization job. */
export interface OrganizeTagPolicySnapshot {
  maxTagsPerRepo: number;
  minTopicRepoCount: number;
}

/** Durable header for a resumable whole-library tag organization job. */
export interface OrganizeJobRecord {
  jobId: string;
  /** Present only while active; v1 enforces one job per slot with a unique index. */
  activeSlot?: string;
  controllerId: string;
  sessionId: string;
  runId: string;
  generation: number;
  proposalId: string;
  frozenScope: OrganizeFrozenScopeSnapshot;
  taskInstruction: string;
  /** Optional only for legacy v4 rows created before organization preferences were snapshotted. */
  tagPolicy?: OrganizeTagPolicySnapshot;
  budget: unknown;
  usage: unknown;
  nextFrozenIndex: number;
  /** Depth-first worklist used only while isolating a failed analyzer page. */
  analysisPendingRanges?: OrganizeAnalysisRange[];
  providerBinding: unknown | null;
  status: OrganizeStoredJobStatus;
  preflight?: OrganizePreflightAuthority | null;
  revision: number;
  itemCount: number;
  applyId: string | null;
  pauseRequested: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
}

export interface OrganizeItemRecord {
  id: string;
  jobId: string;
  position: number;
  fullName: string;
  analysisState: OrganizeItemAnalysisState;
  proposedActions: OrganizeProposedAction[];
  approvedActions: OrganizeProposedAction[];
  proposedAdditions: string[];
  sourceFingerprint: string | null;
  selected: boolean;
  retryCount: number;
  failure: string | null;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  analyzedAt: number | null;
}

export interface OrganizeTaxonomyRecord {
  jobId: string;
  fingerprint: string;
  snapshot: unknown;
  createdAt: number;
}

export type OrganizeApplyStatus = 'sealed' | 'applying' | 'completed' | 'cancelled';
export type OrganizeApplyRowState =
  | 'pending'
  | 'leased'
  | 'changed'
  | 'unchanged'
  | 'skipped'
  | 'failed';

export interface OrganizeApplyRecord {
  applyId: string;
  jobId: string;
  sourceRevision: number;
  /** Taxonomy state expected before the next chunk; advances with this Apply's own writes. */
  expectedTaxonomyFingerprint: string;
  status: OrganizeApplyStatus;
  rowCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface OrganizeApplyRowRecord {
  id: string;
  applyId: string;
  jobId: string;
  position: number;
  fullName: string;
  approvedActions: OrganizeProposedAction[];
  approvedAdditions: string[];
  sourceFingerprint: string;
  taxonomyFingerprint: string;
  state: OrganizeApplyRowState;
  outcomeReason: string | null;
  attemptCount: number;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  settledAt: number | null;
}

/** Latest durable Gist-sync dirtiness for one tag row or the tagMeta snapshot. */
export interface TagDirtyOutboxRecord {
  id: string;
  kind: 'tag' | 'meta';
  key: string;
  version: string;
  updatedAt: string;
}

export type AgentProviderId =
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'custom-openai-compatible';

export type AgentCustomProviderProtocol = 'chat-completions' | 'responses';

export interface AgentCredentialScope {
  provider: AgentProviderId;
  origin: string;
}

export interface AgentProviderCapabilityRecord {
  fingerprint: string;
  verifiedAt: number;
  textChat: true;
  namedToolRoundTrip: true;
  contextCapability?: AgentModelContextCapability;
}

export type AgentModelContextCapabilitySource =
  | 'builtin-official'
  | 'provider-verified'
  | 'user-declared';

export interface AgentModelContextCapability {
  schemaVersion: 1;
  contextWindow: number;
  maxOutputTokens: number;
  source: AgentModelContextCapabilitySource;
  sourceRevision: string;
  capabilityRevision: string;
}

export interface AgentProviderConfig {
  provider: AgentProviderId;
  /** Persisted only for Custom; native services resolve a fixed protocol. */
  protocol: AgentCustomProviderProtocol | null;
  baseUrl: string | null;
  model: string;
  /** Required for unknown routes; Custom services may explicitly override an exact model preset. */
  declaredContextWindow?: number | null;
  /** Optional cost/latency working-set cap; may only reduce the provider window. */
  workingContextWindow?: number | null;
  apiKeyEncrypted: string | null;
  apiKeyCryptoMeta: CryptoMeta | null;
  credentialScope: AgentCredentialScope | null;
  credentialRevision: string | null;
  capability: AgentProviderCapabilityRecord | null;
}

/** Light config kept in chrome.storage.local. */
export interface Config {
  tokenEncrypted: string | null;
  tokenCryptoMeta: CryptoMeta | null;
  watchNotificationsTokenEncrypted: string | null;
  watchNotificationsTokenCryptoMeta: CryptoMeta | null;
  agentProvider: AgentProviderConfig;
  /** Explicit Agent data-sharing acknowledgement for one disclosure/provider/origin tuple. */
  agentDataDisclosureAcceptance: AgentDataDisclosureAcceptance | null;
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
  /** Whether the one-time Auto Tags choice has already been answered. */
  autoTagAgentPromptSeen: boolean;
  /** Legacy max topic-derived tags per repo. Read as compatibility input only. */
  autoTagLimit: number;
  /** Max topic-derived tags per repo for automated organization. */
  maxTagsPerRepo: number;
  /** Minimum repos that must share a topic/tag before automated organization uses it. */
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
    showRepositoryOwner?: boolean;
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
