import type { AgentProviderConnectionResult } from '@/agent-harness/provider-registry';
import type { AgentProviderConnectionRequest } from '@/background/agent-provider-gate';
import type { BgsmAgentSessionRequest } from '@/background/bgsm-agent-session-rpc';
import type { BgsmAgentActiveTurn } from '@/bgsm-agent/turn-protocol';
import type { RadarQueryResponse, RadarRefreshResult, RadarStatus } from '@/radar/radar-contract';
import type {
  RecommendationQueryResponse,
  RecommendationRefreshResult,
  RecommendationStatus,
} from '@/recommendations/recommendation-model';
import type {
  DeleteAllTagsResult,
  ManagerAccount,
  OwnedPublicRepositoryLoadResult,
  ManagerSurfaceBadgeCounts,
  WatchRepositoryDetail,
} from '@/runtime/manager-runtime';
import type {
  AgentRetryDraft,
  AgentSessionCatalogInspection,
  AgentSessionCommitResult,
  AgentSessionTranscriptPage,
  LoadedAgentSession,
} from '@/storage/agent-session-store';
import type { AgentStorageCleanupResult, AgentStorageUsageSnapshot } from '@/storage/agent-storage-model';
import type { StarsQueryParams, StarsQueryResult } from '@/stars/stars-query';
import type { BackfillId, Config, OnboardingStage, Star, Tag } from '@/types';
import type { SyncStatus } from '@/utils/messaging';
import type {
  WatchInboxQueryResponse,
  WatchLoadOlderResult,
  WatchRefreshResult,
  WatchStatus,
  WatchThreadMutationInput,
  WatchThreadMutationResult,
} from '@/watch/watch-contract';
import type { WatchSubjectDetail } from '@/watch/watch-model';

/** Ordinary product commands only; Agent session parsing and streaming retain their own owners. */
export interface BackgroundCommandMap {
  syncOwnedPublicRepositories: { payload: undefined; result: OwnedPublicRepositoryLoadResult };
  syncIncremental: { payload: undefined; result: { added: number; tagged: number } };
  syncFull: { payload: { includeOwnedPublic?: boolean }; result: OwnedPublicRepositoryLoadResult & { tagged: number } };
  syncRescan: { payload: undefined; result: { tombstoned: number; revived: number } };
  autoAssignTags: { payload: undefined; result: { tagged: number; remainingUntagged: number } };
  gistPush: { payload: undefined; result: { pushed: number; snapshot: number; recreated: boolean } };
  gistPull: { payload: undefined; result: { merged: number; total: number; missing: boolean } };
  getStatus: { payload: undefined; result: SyncStatus };
  queryManagerSurfaceBadges: { payload: undefined; result: ManagerSurfaceBadgeCounts };
  getWatchStatus: { payload: undefined; result: WatchStatus };
  queryWatchInbox: { payload: { unreadOnly?: boolean }; result: WatchInboxQueryResponse };
  getWatchSubjectDetail: { payload: { threadId: string }; result: WatchSubjectDetail };
  getWatchRepositoryDetail: { payload: { fullName: string }; result: WatchRepositoryDetail };
  refreshWatchInbox: { payload: undefined; result: WatchRefreshResult };
  loadOlderWatchInbox: { payload: undefined; result: WatchLoadOlderResult };
  markWatchInboxLoaded: { payload: undefined; result: string | null };
  markWatchThreadsRead: { payload: WatchThreadMutationInput; result: WatchThreadMutationResult };
  markWatchThreadsDone: { payload: WatchThreadMutationInput; result: WatchThreadMutationResult };
  disconnectWatchInbox: { payload: undefined; result: WatchStatus };
  clearWatchData: { payload: undefined; result: WatchStatus };
  getRecommendationStatus: { payload: undefined; result: RecommendationStatus };
  queryRecommendations: { payload: undefined; result: RecommendationQueryResponse };
  refreshRecommendations: { payload: undefined; result: RecommendationRefreshResult };
  ignoreRecommendation: { payload: { repositoryKey: string; repositoryFullName?: string }; result: null };
  restoreIgnoredRecommendation: { payload: { repositoryKey: string }; result: null };
  refreshRecommendationsOnEntry: { payload: undefined; result: RecommendationRefreshResult | null };
  clearRecommendations: { payload: undefined; result: RecommendationStatus };
  getRadarStatus: { payload: undefined; result: RadarStatus };
  queryRadar: { payload: undefined; result: RadarQueryResponse };
  refreshRadar: { payload: undefined; result: RadarRefreshResult };
  fullReconcileRadar: { payload: undefined; result: RadarRefreshResult };
  dismissRadarActivities: { payload: { activityIds: readonly string[] }; result: RadarStatus };
  markRadarActivitiesSeen: { payload: { activityIds: readonly string[] }; result: RadarStatus };
  radarStarRepository: { payload: { fullName: string }; result: Star };
  radarAddTag: { payload: { fullName: string; tag: string }; result: { star: Star; tags: string[] } };
  getUsername: { payload: undefined; result: { username: string | null } };
  getAccount: { payload: undefined; result: ManagerAccount & Pick<Config, 'gistId'> };
  fetchAccount: { payload: undefined; result: ManagerAccount & Pick<Config, 'gistId'> };
  query: { payload: { params: StarsQueryParams }; result: StarsQueryResult };
  setTags: { payload: { full_name: string; tags: string[] }; result: void };
  setNotes: { payload: { full_name: string; notes: string }; result: void };
  setFavorite: { payload: { full_name: string; favorite: boolean }; result: { favorite: boolean } };
  markUnstarred: { payload: { full_name: string }; result: { full_name: string; tombstone: boolean } };
  removeVisibleTag: { payload: { full_name: string; name: string }; result: { removed: boolean } };
  deleteTag: { payload: { name: string }; result: { removed: number } };
  deleteAllTags: { payload: undefined; result: DeleteAllTagsResult };
  acceptSuggestions: { payload: { full_name: string; toAdd: string[] }; result: { tags: string[] } };
  acceptSuggestionsBatch: { payload: { items: { full_name: string; toAdd: string[] }[] }; result: { count: number } };
  suggestTags: { payload: { full_name: string }; result: void };
  getTag: { payload: { full_name: string }; result: { tag: Tag | null } };
  listExcluded: { payload: undefined; result: string[] };
  markOnboardingSeen: { payload: undefined; result: void };
  setOnboardingStage: { payload: { stage: OnboardingStage }; result: void };
  markTooltipSeen: { payload: { bit: number }; result: { seenTooltips: number } };
  testConnection: {
    payload: undefined;
    result: {
      status: number;
      statusText: string;
      remaining: string | null;
      limit: string | null;
      scopes: string | null;
      itemCount: number;
      sample: string | null;
    };
  };
  testAgentProviderConnection: { payload: AgentProviderConnectionRequest; result: AgentProviderConnectionResult };
  openOptions: { payload: { section?: 'github' | 'watch' }; result: void };
  devClearLocalData: { payload: undefined; result: { cleared: string[] } };
  runBackfill: { payload: { id: BackfillId }; result: OwnedPublicRepositoryLoadResult & { id: BackfillId; tagged: number } };
  deferBackfill: { payload: { id: BackfillId }; result: { id: BackfillId } };
}

export type BackgroundCommand = keyof BackgroundCommandMap;
export type BackgroundSyncCommand = Extract<
  BackgroundCommand,
  'syncIncremental' | 'syncFull' | 'syncRescan' | 'gistPull' | 'gistPush'
>;
export type BackgroundPayload<C extends BackgroundCommand> = BackgroundCommandMap[C]['payload'];
export type BackgroundResult<C extends BackgroundCommand> = BackgroundCommandMap[C]['result'];
export type BackgroundRequest<C extends BackgroundCommand = BackgroundCommand> = {
  [K in C]: { type: K } & (BackgroundPayload<K> extends undefined ? object : BackgroundPayload<K>);
}[C];
export type BackgroundFailure = { ok: false; error: string; code?: string; details?: unknown };
export type BackgroundSuccess<C extends BackgroundCommand> = C extends BackgroundCommand
  ? BackgroundResult<C> extends void
    ? { ok: true; data?: BackgroundResult<C> }
    : { ok: true; data: BackgroundResult<C> }
  : never;
export type BackgroundResponse<C extends BackgroundCommand = BackgroundCommand> = BackgroundSuccess<C> | BackgroundFailure;

/** Session payloads are derived from the dedicated validated request union, not redeclared. */
type AgentSessionResults = {
  inspectAgentSessionCatalog: AgentSessionCatalogInspection;
  getOrCreateInitialAgentSession: LoadedAgentSession;
  inspectActiveAgentSessionTurn: BgsmAgentActiveTurn | null;
  createAgentSession: LoadedAgentSession;
  loadAgentSession: LoadedAgentSession;
  loadCommittedAgentSessionTurn: AgentSessionCommitResult | null;
  readAgentRetryDraftCandidate: AgentRetryDraft | null;
  dismissAgentSessionRetry: boolean;
  abandonAgentSessionUncertainAttempt: boolean;
  discardDamagedAgentSessionRecovery: number;
  loadAgentSessionTranscriptPage: AgentSessionTranscriptPage;
  deleteAgentSession: { deleted: boolean };
  getAgentStorageUsage: AgentStorageUsageSnapshot;
  clearAgentToolCache: AgentStorageCleanupResult;
};
type AgentSessionCommandMap = {
  [C in BgsmAgentSessionRequest['type']]: {
    payload: keyof Omit<Extract<BgsmAgentSessionRequest, { type: C }>, 'type'> extends never
      ? undefined
      : Omit<Extract<BgsmAgentSessionRequest, { type: C }>, 'type'>;
    result: AgentSessionResults[C];
  };
};
type BackgroundCallMap = BackgroundCommandMap & AgentSessionCommandMap;
export type BackgroundCallCommand = keyof BackgroundCallMap;
export type BackgroundCallResult<C extends BackgroundCallCommand> = BackgroundCallMap[C]['result'];
export type BackgroundCallPayloadArgs<C extends BackgroundCallCommand> = C extends BackgroundCallCommand
  ? BackgroundCallMap[C]['payload'] extends undefined
    ? [payload?: undefined]
    : object extends BackgroundCallMap[C]['payload']
      ? [payload?: BackgroundCallMap[C]['payload']]
      : [payload: BackgroundCallMap[C]['payload']]
  : never;
