import type { Config, Star, Tag } from '@/types';
import type { StarsQueryParams, StarsQueryResult } from '@/stars/stars-query';
import type {
  WatchInboxQueryResponse,
  WatchLoadOlderResult,
  WatchRefreshResult,
  WatchStatus,
  WatchThreadMutationInput,
  WatchThreadMutationResult,
} from '@/watch/watch-contract';
import type { WatchSubjectDetail } from '@/watch/watch-model';
import type { RadarQueryResponse, RadarRefreshResult, RadarStatus } from '@/radar/radar-contract';
import type {
  RecommendationQueryResponse,
  RecommendationRefreshResult,
} from '@/recommendations/recommendation-model';

export type ManagerRuntimeEventKind =
  | 'data'
  | 'preferences'
  | 'watch'
  | 'watch-status'
  | 'radar'
  | 'recommendations'
  | 'reset';

export type ManagerRuntimeEvent = Readonly<{
  kind: ManagerRuntimeEventKind;
  epoch: number;
  watchStatus?: WatchStatus;
}>;

export type ManagerRuntimeListener = (event: ManagerRuntimeEvent) => void;

export type ManagerAccount = Readonly<{
  username: string | null;
  avatarUrl: string | null;
  displayName: string | null;
}>;

export type ManagerPreferences = Readonly<Pick<
  Config,
  | 'theme'
  | 'locale'
  | 'libraryView'
  | 'watchCollapsedRepositories'
  | 'columnLayoutMode'
  | 'customColumnLayout'
>>;

export type ManagerPreferencesPatch = Partial<ManagerPreferences>;

export type ManagerSurfaceBadgeCounts = Readonly<{
  watchUnreadCount: number;
  radarUnseenCount: number;
}>;

export type ManagerImageResource = Readonly<{
  kind: 'actor-avatar' | 'repository-avatar';
  identity: string;
  remoteUrl: string | null;
}>;

export type ManagerLinkResource = Readonly<
  | { kind: 'actor'; login: string; remoteUrl: string }
  | { kind: 'repository'; fullName: string; remoteUrl: string }
  | { kind: 'subject'; label: string; remoteUrl: string }
>;

export interface ManagerResourcePolicy {
  resolveImage(resource: ManagerImageResource): string | null;
  resolveLink(resource: ManagerLinkResource): string | null;
  onBlockedLink(resource: ManagerLinkResource): void;
}

export type WatchRepositoryDetail = Readonly<{
  star: Star | null;
  tag: Tag | null;
}>;

export type DeleteAllTagsResult = Readonly<{
  assignmentsRemoved: number;
  distinctTagsRemoved: number;
}>;

export interface ManagerRuntime {
  readonly resources: ManagerResourcePolicy;

  now(): number;
  subscribe(listener: ManagerRuntimeListener): () => void;
  getAccount(): Promise<ManagerAccount>;
  readPreferences(): Promise<ManagerPreferences>;
  updatePreferences(patch: ManagerPreferencesPatch): Promise<ManagerPreferences>;

  queryStars(params: StarsQueryParams): Promise<StarsQueryResult>;
  querySurfaceBadges(): Promise<ManagerSurfaceBadgeCounts>;
  listExcludedTags(): Promise<string[]>;
  setTags(fullName: string, tags: readonly string[]): Promise<void>;
  setNotes(fullName: string, notes: string): Promise<void>;
  setFavorite(fullName: string, favorite: boolean): Promise<void>;
  markUnstarred(fullName: string): Promise<void>;
  removeVisibleTag(fullName: string, name: string): Promise<{ removed: boolean }>;
  deleteTag(name: string): Promise<{ removed: number }>;
  deleteAllTags(): Promise<DeleteAllTagsResult>;

  queryWatchInbox(options: Readonly<{ unreadOnly: boolean }>): Promise<WatchInboxQueryResponse>;
  getWatchRepositoryDetail(fullName: string): Promise<WatchRepositoryDetail>;
  getWatchSubjectDetail(threadId: string): Promise<WatchSubjectDetail>;
  refreshWatch(): Promise<WatchRefreshResult>;
  loadOlderWatch(): Promise<WatchLoadOlderResult>;
  markWatchLoaded(): Promise<string | null>;
  markWatchThreadsRead(input: WatchThreadMutationInput): Promise<WatchThreadMutationResult>;
  markWatchThreadsDone(input: WatchThreadMutationInput): Promise<WatchThreadMutationResult>;
  updateWatchCollapse(repositoryFullName: string, contentSignature: string | null): Promise<void>;

  queryRadar(): Promise<RadarQueryResponse>;
  refreshRadar(): Promise<RadarRefreshResult>;
  markRadarActivitiesSeen(activityIds: readonly string[]): Promise<RadarStatus>;
  dismissRadarActivities(activityIds: readonly string[]): Promise<RadarStatus>;

  queryRecommendations(): Promise<RecommendationQueryResponse>;
  refreshRecommendations(): Promise<RecommendationRefreshResult>;
  ignoreRecommendation(repositoryKey: string, repositoryFullName: string): Promise<void>;
  restoreIgnoredRecommendation(repositoryKey: string): Promise<void>;
  starRepository(fullName: string): Promise<Star>;
  addRepositoryTag(fullName: string, tag: string): Promise<void>;

  reset(): Promise<number>;
}
