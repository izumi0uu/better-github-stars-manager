import type { RadarQueryResponse } from '@/radar/radar-contract';
import type { RadarActivitySource } from '@/radar/radar-model';
import type { RecommendationQueryResponse } from '@/recommendations/recommendation-model';

export type RadarView = 'feed' | 'projects';
export type RadarDiscoverView = 'following' | 'for-you';
export type RadarActionKind = 'star' | 'favorite' | 'tag' | 'dismiss' | 'ignore';
export type RadarSourceFilters = Readonly<Record<RadarActivitySource, boolean>>;

export type RadarPendingAction = Readonly<{
  kind: RadarActionKind;
  repositoryKey: string;
}>;

export type RadarActionError = Readonly<{
  repositoryKey: string;
  message: string;
}>;

export interface RadarProps {
  result: RadarQueryResponse | null;
  recommendations: RecommendationQueryResponse | null;
  scrollElement?: HTMLElement | null;
  discoverView: RadarDiscoverView;
  loading: boolean;
  recommendationLoading: boolean;
  refreshing: boolean;
  recommendationRefreshing: boolean;
  error: 'query' | 'refresh' | null;
  recommendationError: 'query' | 'refresh' | null;
  actionError: RadarActionError | null;
  pendingAction: RadarPendingAction | null;
  recommendationFavorites: Readonly<Record<string, boolean>>;
  view: RadarView;
  sources: RadarSourceFilters;
  onDiscoverViewChange: (view: RadarDiscoverView) => void;
  onViewChange: (view: RadarView) => void;
  onSourceEnabledChange: (source: RadarActivitySource, enabled: boolean) => void;
  onRefresh: () => void;
  onRefreshRecommendations: () => void;
  onRetryQuery: () => void;
  onRetryRecommendations: () => void;
  onOpenOptions: () => void;
  onStar: (repositoryKey: string, fullName: string) => Promise<unknown>;
  onUnstar: (repositoryKey: string, fullName: string) => Promise<unknown>;
  onIgnore: (repositoryKey: string, repositoryFullName: string) => Promise<unknown>;
  onRestoreIgnored: (repositoryKey: string) => Promise<unknown>;
  onSetFavorite: (
    repositoryKey: string,
    fullName: string,
    favorite: boolean,
  ) => Promise<unknown>;
  onAddTag: (repositoryKey: string, fullName: string, tag: string) => Promise<unknown>;
  onDismiss: (repositoryKey: string, activityIds: readonly string[]) => Promise<unknown>;
  onMarkSeen: (activityIds: readonly string[]) => void;
}
