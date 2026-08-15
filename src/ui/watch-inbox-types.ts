import type { ChangeEventHandler, CompositionEventHandler } from 'react';
import type { WatchCollapsedRepositorySignatures } from '@/types';
import type { WatchInboxQueryResponse, WatchThreadAction } from '@/watch/watch-contract';

export type WatchThreadActionPending = Readonly<{
  action: WatchThreadAction;
  threadIds: readonly string[];
}>;

export interface WatchInboxSearchInput {
  value: string;
  commit: (value: string) => void;
  inputProps: Readonly<{
    value: string;
    onChange: ChangeEventHandler<HTMLInputElement>;
    onCompositionStart: CompositionEventHandler<HTMLInputElement>;
    onCompositionUpdate: CompositionEventHandler<HTMLInputElement>;
    onCompositionEnd: CompositionEventHandler<HTMLInputElement>;
  }>;
}

export interface WatchInboxProps {
  result: WatchInboxQueryResponse | null;
  scrollElement?: HTMLElement | null;
  loading: boolean;
  refreshing: boolean;
  error: 'query' | 'refresh' | null;
  actionPending: WatchThreadActionPending | null;
  actionError: WatchThreadAction | null;
  unreadOnly: boolean;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  onRefresh: () => void;
  onRetryQuery: () => void;
  onOpenOptions: () => void;
  onOpenMainTokenOptions: () => void;
  onMarkThreadsRead: (ids: readonly string[]) => void;
  onMarkThreadsDone: (ids: readonly string[]) => void;
  collapsedRepositories?: WatchCollapsedRepositorySignatures;
  onRepositoryCollapseChange?: (repository: string, signature: string | null) => void;
  onSelectRepository?: (fullName: string) => void;
}
