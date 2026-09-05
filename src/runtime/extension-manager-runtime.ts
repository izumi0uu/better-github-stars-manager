import {
  authStore,
  CONFIG_STORAGE_KEY,
  GITHUB_CREDENTIALS_STORAGE_KEY,
} from '@/auth/auth-store';
import type {
  OwnedPublicRepositoryLoadResult,
  DeleteAllTagsResult,
  ManagerAccount,
  ManagerPreferences,
  ManagerPreferencesPatch,
  ManagerResourcePolicy,
  ManagerRuntime,
  ManagerRuntimeEventKind,
  ManagerRuntimeListener,
  ManagerSurfaceBadgeCounts,
  WatchRepositoryDetail,
} from '@/runtime/manager-runtime';
import type { RadarQueryResponse, RadarRefreshResult, RadarStatus } from '@/radar/radar-contract';
import type {
  RecommendationQueryResponse,
  RecommendationRefreshResult,
} from '@/recommendations/recommendation-model';
import type { StarsQueryParams, StarsQueryResult } from '@/stars/stars-query';
import type { Config } from '@/types';
import type {
  WatchInboxQueryResponse,
  WatchLoadOlderResult,
  WatchRefreshResult,
  WatchStatus,
  WatchThreadMutationInput,
  WatchThreadMutationResult,
} from '@/watch/watch-contract';
import type { WatchSubjectDetail } from '@/watch/watch-model';
import { bgCall } from '@/utils/messaging';

const extensionResources = Object.freeze({
  resolveImage: ({ remoteUrl }) => remoteUrl,
  resolveLink: ({ remoteUrl }) => remoteUrl,
  onBlockedLink: () => {},
} satisfies ManagerResourcePolicy);

function preferencesFromConfig(config: Config): ManagerPreferences {
  return {
    theme: config.theme,
    locale: config.locale,
    radarWindowDays: config.radarWindowDays,
    libraryView: config.libraryView,
    watchCollapsedRepositories: config.watchCollapsedRepositories,
    columnLayoutMode: config.columnLayoutMode,
    customColumnLayout: config.customColumnLayout,
  };
}

function storedMainCredentialIdentity(value: unknown): string {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const cryptoMeta = record.tokenCryptoMeta
    && typeof record.tokenCryptoMeta === 'object'
    && !Array.isArray(record.tokenCryptoMeta)
    ? record.tokenCryptoMeta as Record<string, unknown>
    : {};
  const text = (candidate: unknown) => typeof candidate === 'string' ? candidate : null;
  return JSON.stringify([
    text(record.username)?.trim().toLowerCase() || null,
    text(record.tokenEncrypted),
    text(cryptoMeta.salt),
    text(cryptoMeta.iv),
    text(record.githubCredentialStatus),
  ]);
}

/** Chrome-extension implementation of the storage-neutral manager port. */
export class ExtensionManagerRuntime implements ManagerRuntime {
  readonly resources = extensionResources;
  private epoch = 0;
  private readonly listeners = new Set<ManagerRuntimeListener>();
  private listening = false;

  private publish(kind: ManagerRuntimeEventKind, watchStatus?: WatchStatus): void {
    const event = {
      kind,
      epoch: ++this.epoch,
      ...(watchStatus ? { watchStatus } : {}),
    } as const;
    for (const listener of [...this.listeners]) listener(event);
  }

  private readonly onMessage = (message: { type?: string; status?: WatchStatus }) => {
    switch (message.type) {
      case 'dataChanged':
        this.publish('data');
        break;
      case 'watchChanged':
        this.publish('watch', message.status);
        break;
      case 'watchStatusChanged':
        this.publish('watch-status', message.status);
        break;
      case 'radarChanged':
        this.publish('radar');
        break;
      case 'recommendationsChanged':
        this.publish('recommendations');
        break;
      default:
        break;
    }
  };

  private readonly onStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return;
    if (changes[CONFIG_STORAGE_KEY]) this.publish('preferences');
    const credentialsChange = changes[GITHUB_CREDENTIALS_STORAGE_KEY];
    if (credentialsChange) {
      const mainCredentialChanged = storedMainCredentialIdentity(credentialsChange.oldValue)
        !== storedMainCredentialIdentity(credentialsChange.newValue);
      this.publish(mainCredentialChanged ? 'reset' : 'watch');
    }
  };

  private startListening(): void {
    if (this.listening) return;
    const runtimeMessages = globalThis.chrome?.runtime?.onMessage;
    const storageChanges = globalThis.chrome?.storage?.onChanged;
    if (!runtimeMessages || !storageChanges) return;
    this.listening = true;
    runtimeMessages.addListener(this.onMessage);
    storageChanges.addListener(this.onStorageChanged);
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    globalThis.chrome?.runtime?.onMessage?.removeListener(this.onMessage);
    globalThis.chrome?.storage?.onChanged?.removeListener(this.onStorageChanged);
  }

  now(): number {
    return Date.now();
  }

  subscribe(listener: ManagerRuntimeListener): () => void {
    this.listeners.add(listener);
    this.startListening();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopListening();
    };
  }

  async getAccount(): Promise<ManagerAccount> {
    const account = await authStore.getAccount();
    return {
      username: account.username,
      avatarUrl: account.avatarUrl,
      displayName: account.displayName,
    };
  }

  async readPreferences(): Promise<ManagerPreferences> {
    return preferencesFromConfig(await authStore.getConfig());
  }

  async updatePreferences(patch: ManagerPreferencesPatch): Promise<ManagerPreferences> {
    await authStore.update(patch);
    return this.readPreferences();
  }

  queryStars(params: StarsQueryParams): Promise<StarsQueryResult> {
    return bgCall('query', { params });
  }

  loadOwnedPublicRepositories(): Promise<OwnedPublicRepositoryLoadResult> {
    return bgCall('syncOwnedPublicRepositories');
  }

  querySurfaceBadges(): Promise<ManagerSurfaceBadgeCounts> {
    return bgCall('queryManagerSurfaceBadges');
  }

  listExcludedTags() {
    return bgCall('listExcluded');
  }

  async setTags(fullName: string, tags: readonly string[]): Promise<void> {
    await bgCall('setTags', { full_name: fullName, tags: [...tags] });
  }

  async setNotes(fullName: string, notes: string): Promise<void> {
    await bgCall('setNotes', { full_name: fullName, notes });
  }

  async setFavorite(fullName: string, favorite: boolean): Promise<void> {
    await bgCall('setFavorite', { full_name: fullName, favorite });
  }

  async markUnstarred(fullName: string): Promise<void> {
    await bgCall('markUnstarred', { full_name: fullName });
  }

  removeVisibleTag(fullName: string, name: string) {
    return bgCall('removeVisibleTag', { full_name: fullName, name });
  }

  deleteTag(name: string) {
    return bgCall('deleteTag', { name });
  }

  deleteAllTags(): Promise<DeleteAllTagsResult> {
    return bgCall('deleteAllTags');
  }

  queryWatchInbox(options: Readonly<{ unreadOnly: boolean }>): Promise<WatchInboxQueryResponse> {
    return bgCall('queryWatchInbox', options);
  }

  getWatchRepositoryDetail(fullName: string): Promise<WatchRepositoryDetail> {
    return bgCall(
      'getWatchRepositoryDetail',
      { fullName },
    );
  }

  getWatchSubjectDetail(threadId: string): Promise<WatchSubjectDetail> {
    return bgCall('getWatchSubjectDetail', {
      threadId,
    });
  }

  refreshWatch(): Promise<WatchRefreshResult> {
    return bgCall('refreshWatchInbox');
  }

  loadOlderWatch(): Promise<WatchLoadOlderResult> {
    return bgCall('loadOlderWatchInbox');
  }

  markWatchLoaded(): Promise<string | null> {
    return bgCall('markWatchInboxLoaded');
  }

  markWatchThreadsRead(input: WatchThreadMutationInput): Promise<WatchThreadMutationResult> {
    return bgCall('markWatchThreadsRead', {
      accountLogin: input.accountLogin,
      threadIds: [...input.threadIds],
    });
  }

  markWatchThreadsDone(input: WatchThreadMutationInput): Promise<WatchThreadMutationResult> {
    return bgCall('markWatchThreadsDone', {
      accountLogin: input.accountLogin,
      threadIds: [...input.threadIds],
    });
  }

  async updateWatchCollapse(repositoryFullName: string, contentSignature: string | null): Promise<void> {
    await authStore.updateWatchRepositoryCollapse(repositoryFullName, contentSignature);
  }

  queryRadar(): Promise<RadarQueryResponse> {
    return bgCall('queryRadar');
  }

  refreshRadar(): Promise<RadarRefreshResult> {
    return bgCall('refreshRadar');
  }
  fullReconcileRadar(): Promise<RadarRefreshResult> {
    return bgCall('fullReconcileRadar');
  }

  markRadarActivitiesSeen(activityIds: readonly string[]): Promise<RadarStatus> {
    return bgCall(
      'markRadarActivitiesSeen',
      { activityIds: [...activityIds] },
    );
  }

  dismissRadarActivities(activityIds: readonly string[]): Promise<RadarStatus> {
    return bgCall(
      'dismissRadarActivities',
      { activityIds: [...activityIds] },
    );
  }

  queryRecommendations(): Promise<RecommendationQueryResponse> {
    return bgCall('queryRecommendations');
  }

  refreshRecommendations(): Promise<RecommendationRefreshResult> {
    return bgCall('refreshRecommendations');
  }

  async ignoreRecommendation(repositoryKey: string, repositoryFullName: string): Promise<void> {
    await bgCall('ignoreRecommendation', { repositoryKey, repositoryFullName });
  }

  async restoreIgnoredRecommendation(repositoryKey: string): Promise<void> {
    await bgCall('restoreIgnoredRecommendation', { repositoryKey });
  }

  starRepository(fullName: string) {
    return bgCall('radarStarRepository', { fullName });
  }

  async addRepositoryTag(fullName: string, tag: string): Promise<void> {
    await bgCall('radarAddTag', { fullName, tag });
  }

  async reset(): Promise<number> {
    return this.epoch;
  }
}

export function createExtensionManagerRuntime(): ManagerRuntime {
  return new ExtensionManagerRuntime();
}
