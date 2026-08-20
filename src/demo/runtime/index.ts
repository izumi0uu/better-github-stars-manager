import {
  type DeleteAllTagsResult,
  type ManagerAccount,
  type ManagerPreferences,
  type ManagerPreferencesPatch,
  type ManagerResourcePolicy,
  type ManagerRuntime,
  type ManagerRuntimeEventKind,
  type ManagerRuntimeListener,
  type ManagerSurfaceBadgeCounts,
  type WatchRepositoryDetail,
} from '@/runtime/manager-runtime';
import { projectStarsQuery, type StarsQueryParams, type StarsQueryResult } from '@/stars/stars-query';
import { projectWatchInbox, normalizeRepositoryFullName, type WatchSubjectDetail } from '@/watch/watch-model';
import type {
  WatchInboxQueryResponse,
  WatchLoadOlderResult,
  WatchRefreshResult,
  WatchStatus,
  WatchThreadMutationInput,
  WatchThreadMutationResult,
} from '@/watch/watch-contract';
import { projectRadarActivities } from '@/radar/radar-projector';
import type { RadarQueryResponse, RadarRefreshResult, RadarStatus } from '@/radar/radar-contract';
import { projectRecommendations } from '@/recommendations/recommendation-projector';
import type {
  RecommendationQueryResponse,
  RecommendationRecord,
  RecommendationRefreshResult,
  RecommendationStatus,
} from '@/recommendations/recommendation-model';
import {
  addTagNames,
  autoTagNames,
  canonicalTagKey,
  canonicalTagMetaWinners,
  dismissedAutoTagNames,
  includesTagName,
  manualTagNames,
  normalizeTagNames,
  sameTagNames,
  visibleTagNames,
  withoutTagName,
} from '@/tags/tag-model';
import type { Star, Tag } from '@/types';
import { DEMO_FIXTURE, type DemoFixture } from '@/demo/fixtures';

type Mutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

type DemoState = Mutable<DemoFixture> & { recommendationBatchIndex: number };

function cloneMutable<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

function createBaselineState(): DemoState {
  return cloneMutable({
    now: DEMO_FIXTURE.now,
    account: DEMO_FIXTURE.account,
    preferences: DEMO_FIXTURE.preferences,
    stars: DEMO_FIXTURE.stars,
    tags: DEMO_FIXTURE.tags,
    tagMeta: DEMO_FIXTURE.tagMeta,
    watchThreads: DEMO_FIXTURE.watchThreads,
    watchState: DEMO_FIXTURE.watchState,
    watchSubjectDetailsByThreadId: DEMO_FIXTURE.watchSubjectDetailsByThreadId,
    radarActivities: DEMO_FIXTURE.radarActivities,
    radarState: DEMO_FIXTURE.radarState,
    recommendationBatches: DEMO_FIXTURE.recommendationBatches,
    recommendationState: DEMO_FIXTURE.recommendationState,
    recommendationIgnores: DEMO_FIXTURE.recommendationIgnores,
    avatarAssets: DEMO_FIXTURE.avatarAssets,
    recommendationBatchIndex: 0,
  });
}

function canonicalRepository(value: string): string {
  return normalizeRepositoryFullName(value);
}

function timestamp(now: number): string {
  return new Date(now).toISOString();
}

function emptyTag(fullName: string, now: number): Tag {
  const mtime = timestamp(now);
  return {
    full_name: fullName,
    manualTags: [],
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: mtime,
    autoTagsMtime: mtime,
    dismissedAutoTagsMtime: mtime,
    notes: '',
    favorite: false,
    mtime,
    gh_list_id: null,
  };
}

export type DemoManagerRuntimeOptions = Readonly<{
  onBlockedLink?: ManagerResourcePolicy['onBlockedLink'];
}>;

function createResourcePolicy(
  assets: Readonly<Record<string, string>>,
  onBlockedLink?: ManagerResourcePolicy['onBlockedLink'],
): ManagerResourcePolicy {
  const defaultAsset = assets.default ?? null;
  const findAsset = (identity: string): string | null => {
    const normalized = identity.trim().toLocaleLowerCase('en-US');
    const owner = normalized.split('/')[0] ?? normalized;
    return assets[normalized] ?? assets[owner] ?? defaultAsset;
  };

  return Object.freeze({
    resolveImage(resource: Parameters<ManagerResourcePolicy['resolveImage']>[0]) {
      return findAsset(resource.identity);
    },
    resolveLink() {
      return null;
    },
    onBlockedLink(resource: Parameters<ManagerResourcePolicy['onBlockedLink']>[0]) {
      // The host owns localized feedback; the runtime only guarantees navigation is blocked.
      onBlockedLink?.(resource);
    }
  });
}

class DemoManagerRuntime implements ManagerRuntime {
  readonly resources: ManagerResourcePolicy;

  private state = createBaselineState();
  private epoch = 0;
  private readonly listeners = new Set<ManagerRuntimeListener>();

  constructor(options: DemoManagerRuntimeOptions = {}) {
    this.resources = createResourcePolicy(this.state.avatarAssets, options.onBlockedLink);
  }

  now(): number {
    return this.state.now;
  }

  subscribe(listener: ManagerRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getAccount(): Promise<ManagerAccount> {
    return cloneMutable(this.state.account);
  }

  async readPreferences(): Promise<ManagerPreferences> {
    return cloneMutable(this.state.preferences);
  }

  async updatePreferences(patch: ManagerPreferencesPatch): Promise<ManagerPreferences> {
    const next = {
      ...this.state.preferences,
      ...cloneMutable(patch),
    } satisfies ManagerPreferences;
    if (JSON.stringify(this.state.preferences) !== JSON.stringify(next)) {
      this.state.preferences = next;
      this.publish('preferences');
    }
    return cloneMutable(this.state.preferences);
  }

  async queryStars(params: StarsQueryParams): Promise<StarsQueryResult> {
    return cloneMutable(projectStarsQuery({
      stars: this.state.stars,
      tags: this.state.tags,
      tagMeta: this.state.tagMeta,
    }, {
      ...params,
      accountLogin: params.accountLogin ?? this.state.account.username ?? undefined,
    }));
  }

  async querySurfaceBadges(): Promise<ManagerSurfaceBadgeCounts> {
    const watch = this.projectWatch(false);
    const radar = this.projectRadar();
    return {
      watchUnreadCount: watch.unreadCount,
      radarUnseenCount: radar.filter((activity) => activity.source === 'following' && !activity.seen).length,
    };
  }

  async listExcludedTags(): Promise<string[]> {
    return [...canonicalTagMetaWinners(this.state.tagMeta).values()]
      .filter((meta) => meta.excluded === true)
      .map((meta) => meta.name)
      .sort((left, right) => left.localeCompare(right));
  }

  async setTags(fullName: string, tags: readonly string[]): Promise<void> {
    const displayName = this.repositoryDisplayName(fullName);
    const { tag: existing, created } = this.ensureTag(displayName);
    const nextManualTags = normalizeTagNames(tags);
    const removedManualTags = manualTagNames(existing)
      .filter((name) => !includesTagName(nextManualTags, name));
    const nextDismissed = addTagNames(dismissedAutoTagNames(existing), removedManualTags)
      .filter((name) => !includesTagName(nextManualTags, name));
    const manualChanged = !sameTagNames(manualTagNames(existing), nextManualTags);
    const dismissedChanged = !sameTagNames(dismissedAutoTagNames(existing), nextDismissed);
    const revived = this.reviveExcludedTags(nextManualTags);
    if (!manualChanged && !dismissedChanged && !revived && !created) return;

    const mtime = timestamp(this.state.now);
    Object.assign(existing, {
      manualTags: nextManualTags,
      dismissedAutoTags: nextDismissed,
      manualTagsMtime: manualChanged ? mtime : existing.manualTagsMtime,
      dismissedAutoTagsMtime: dismissedChanged ? mtime : existing.dismissedAutoTagsMtime,
      mtime,
    });
    this.publish('data');
  }

  async setNotes(fullName: string, notes: string): Promise<void> {
    const { tag, created } = this.ensureTag(this.repositoryDisplayName(fullName));
    if (tag.notes === notes && !created) return;
    tag.notes = notes;
    tag.mtime = timestamp(this.state.now);
    this.publish('data');
  }

  async setFavorite(fullName: string, favorite: boolean): Promise<void> {
    const { tag, created } = this.ensureTag(this.repositoryDisplayName(fullName));
    if (tag.favorite === favorite && !created) return;
    tag.favorite = favorite;
    tag.mtime = timestamp(this.state.now);
    this.publish('data');
  }

  async markUnstarred(fullName: string): Promise<void> {
    const repositoryKey = canonicalRepository(fullName);
    const star = this.state.stars.find((row) => canonicalRepository(row.full_name) === repositoryKey);
    if (!star) throw new Error(`Unknown repository: ${fullName}`);
    if (star.tombstone && star.viewer_has_starred === false) return;
    star.tombstone = true;
    star.viewer_has_starred = false;
    star.synced_at = timestamp(this.state.now);
    this.publish('data');
  }

  async removeVisibleTag(fullName: string, name: string): Promise<{ removed: boolean }> {
    const repositoryKey = canonicalRepository(fullName);
    const tag = this.state.tags.find((row) => canonicalRepository(row.full_name) === repositoryKey);
    if (!tag) return { removed: false };
    const hadManual = includesTagName(manualTagNames(tag), name);
    const hadAuto = includesTagName(autoTagNames(tag), name);
    if (!hadManual && !hadAuto) return { removed: false };

    const mtime = timestamp(this.state.now);
    const nextDismissed = addTagNames(dismissedAutoTagNames(tag), [name]);
    tag.manualTags = withoutTagName(manualTagNames(tag), name);
    tag.autoTags = withoutTagName(autoTagNames(tag), name);
    tag.dismissedAutoTags = nextDismissed;
    if (hadManual) tag.manualTagsMtime = mtime;
    if (hadAuto) tag.autoTagsMtime = mtime;
    tag.dismissedAutoTagsMtime = mtime;
    tag.mtime = mtime;
    this.publish('data');
    return { removed: true };
  }

  async deleteTag(name: string): Promise<{ removed: number }> {
    const requestedKey = canonicalTagKey(name);
    if (!requestedKey) return { removed: 0 };
    const mtime = timestamp(this.state.now);
    let repositoriesChanged = 0;
    let preferredName = name.trim();

    for (const tag of this.state.tags) {
      const visible = visibleTagNames(tag);
      const matching = visible.filter((tagName) => canonicalTagKey(tagName) === requestedKey);
      if (matching.length === 0) continue;
      preferredName ||= matching[0] ?? name.trim();
      const hadManual = matching.some((tagName) => includesTagName(manualTagNames(tag), tagName));
      const hadAuto = matching.some((tagName) => includesTagName(autoTagNames(tag), tagName));
      tag.manualTags = manualTagNames(tag).filter((tagName) => canonicalTagKey(tagName) !== requestedKey);
      tag.autoTags = autoTagNames(tag).filter((tagName) => canonicalTagKey(tagName) !== requestedKey);
      if (hadAuto) tag.dismissedAutoTags = addTagNames(dismissedAutoTagNames(tag), [preferredName]);
      if (hadManual) tag.manualTagsMtime = mtime;
      if (hadAuto) {
        tag.autoTagsMtime = mtime;
        tag.dismissedAutoTagsMtime = mtime;
      }
      tag.mtime = mtime;
      repositoriesChanged++;
    }

    const aliases = this.state.tagMeta.filter((meta) => canonicalTagKey(meta.name) === requestedKey);
    const current = canonicalTagMetaWinners(aliases).get(requestedKey);
    this.state.tagMeta = this.state.tagMeta.filter((meta) => canonicalTagKey(meta.name) !== requestedKey);
    this.state.tagMeta.push({
      name: current?.name ?? preferredName,
      dimension: current?.dimension ?? null,
      color: current?.color ?? null,
      excluded: true,
      mtime,
    });
    this.publish('data');
    return { removed: repositoriesChanged };
  }

  async deleteAllTags(): Promise<DeleteAllTagsResult> {
    const removedNames = new Set<string>();
    let assignmentsRemoved = 0;
    let changed = false;
    const mtime = timestamp(this.state.now);
    for (const tag of this.state.tags) {
      const visible = visibleTagNames(tag);
      if (visible.length === 0 && dismissedAutoTagNames(tag).length === 0) continue;
      visible.forEach((name) => removedNames.add(canonicalTagKey(name)));
      assignmentsRemoved += visible.length;
      const manualChanged = manualTagNames(tag).length > 0;
      const autoChanged = autoTagNames(tag).length > 0;
      const dismissedChanged = dismissedAutoTagNames(tag).length > 0;
      tag.manualTags = [];
      tag.autoTags = [];
      tag.dismissedAutoTags = [];
      if (manualChanged) tag.manualTagsMtime = mtime;
      if (autoChanged) tag.autoTagsMtime = mtime;
      if (dismissedChanged) tag.dismissedAutoTagsMtime = mtime;
      tag.mtime = mtime;
      changed = true;
    }
    if (changed) this.publish('data');
    return { assignmentsRemoved, distinctTagsRemoved: removedNames.size };
  }

  async queryWatchInbox(options: Readonly<{ unreadOnly: boolean }>): Promise<WatchInboxQueryResponse> {
    return cloneMutable({
      ...this.projectWatch(options.unreadOnly),
      status: this.watchStatus(),
    });
  }

  async getWatchRepositoryDetail(fullName: string): Promise<WatchRepositoryDetail> {
    const repositoryKey = canonicalRepository(fullName);
    const star = this.state.stars.find((row) => (
      canonicalRepository(row.full_name) === repositoryKey
      && !row.tombstone
      && row.viewer_has_starred !== false
    )) ?? null;
    const tag = this.state.tags.find((row) => canonicalRepository(row.full_name) === repositoryKey) ?? null;
    return cloneMutable({ star, tag });
  }

  async getWatchSubjectDetail(threadId: string): Promise<WatchSubjectDetail> {
    const detail = this.state.watchSubjectDetailsByThreadId[threadId];
    if (!detail || !this.state.watchThreads.some((thread) => thread.id === threadId)) {
      throw new Error(`Unknown Watch thread: ${threadId}`);
    }
    return cloneMutable(detail);
  }

  async refreshWatch(): Promise<WatchRefreshResult> {
    const current = this.projectWatch(false);
    const now = timestamp(this.state.now);
    const distinctThreadCount = new Set(this.state.watchThreads.map((thread) => thread.id)).size;
    this.state.watchState.scope.lastAttemptAt = now;
    this.state.watchState.scope.lastSuccessfulAt = now;
    this.state.watchState.scope.errorCode = null;
    this.state.watchState.inbox.lastAttemptAt = now;
    this.state.watchState.inbox.lastSuccessfulAt = now;
    this.state.watchState.inbox.errorCode = null;
    this.state.watchState.inbox.candidateCount = distinctThreadCount;
    this.state.watchState.inbox.matchedCount = current.totalCount;
    this.state.watchState.inbox.scanId = null;
    this.state.watchState.inbox.scanStatus = 'complete';
    this.state.watchState.inbox.scanStartedAt = null;
    this.state.watchState.inbox.scanPageCount = distinctThreadCount === 0 ? 0 : 1;
    this.state.watchState.inbox.lastConvergedAt = now;
    this.state.watchState.inbox.truncated = false;
    this.state.watchState.inbox.historyBefore = now;
    this.state.watchState.inbox.historyNextPage = null;
    this.state.watchState.inbox.historyExhausted = true;
    this.state.watchState.inbox.historyErrorCode = null;
    this.state.watchState.inbox.nextAllowedAt = null;
    this.publish('watch');
    return cloneMutable({
      status: this.watchStatus(),
      scopePublished: true,
      inboxPublished: true,
      notModified: true,
    });
  }

  async loadOlderWatch(): Promise<WatchLoadOlderResult> {
    return cloneMutable({
      status: this.watchStatus(),
      addedCount: 0,
      hasMore: false,
    });
  }

  async markWatchLoaded(): Promise<string | null> {
    const loadedAt = timestamp(this.state.now);
    this.state.watchState.inbox.newerThan = loadedAt;
    return loadedAt;
  }

  async markWatchThreadsRead(input: WatchThreadMutationInput): Promise<WatchThreadMutationResult> {
    this.assertWatchAccount(input.accountLogin);
    const ids = new Set(input.threadIds);
    let changedCount = 0;
    const readAt = timestamp(this.state.now);
    for (const thread of this.state.watchThreads) {
      if (!ids.has(thread.id) || !thread.unread) continue;
      thread.unread = false;
      thread.lastReadAt = readAt;
      changedCount++;
    }
    if (changedCount > 0) this.publish('watch');
    return { action: 'read', requestedCount: ids.size, changedCount };
  }

  async markWatchThreadsDone(input: WatchThreadMutationInput): Promise<WatchThreadMutationResult> {
    this.assertWatchAccount(input.accountLogin);
    const ids = new Set(input.threadIds);
    const before = this.state.watchThreads.length;
    this.state.watchThreads = this.state.watchThreads.filter((thread) => !ids.has(thread.id));
    const changedCount = before - this.state.watchThreads.length;
    for (const id of ids) delete this.state.watchSubjectDetailsByThreadId[id];
    if (changedCount > 0) this.publish('watch');
    return { action: 'done', requestedCount: ids.size, changedCount };
  }

  async updateWatchCollapse(repositoryFullName: string, contentSignature: string | null): Promise<void> {
    const repositoryKey = canonicalRepository(repositoryFullName);
    const collapsed = { ...this.state.preferences.watchCollapsedRepositories };
    if (contentSignature === null) {
      if (!(repositoryKey in collapsed)) return;
      delete collapsed[repositoryKey];
    } else {
      if (collapsed[repositoryKey] === contentSignature) return;
      collapsed[repositoryKey] = contentSignature;
    }
    this.state.preferences.watchCollapsedRepositories = collapsed;
    this.publish('preferences');
  }

  async queryRadar(): Promise<RadarQueryResponse> {
    const activities = this.projectRadar();
    return cloneMutable({
      activities,
      unseenCount: activities.filter((activity) => activity.source === 'following' && !activity.seen).length,
      status: this.radarStatus(),
    });
  }

  async refreshRadar(): Promise<RadarRefreshResult> {
    const now = timestamp(this.state.now);
    this.state.radarState.lastAttemptAt = now;
    this.state.radarState.lastSuccessfulAt = now;
    this.state.radarState.batchCount++;
    this.state.radarState.activityCount = this.state.radarActivities.length;
    this.publish('radar');
    return cloneMutable({ published: true, status: this.radarStatus() });
  }

  async markRadarActivitiesSeen(activityIds: readonly string[]): Promise<RadarStatus> {
    const ids = new Set(activityIds);
    const seenAt = timestamp(this.state.now);
    let changed = false;
    for (const activity of this.state.radarActivities) {
      if (!ids.has(activity.id) || activity.seenAt !== null) continue;
      activity.seenAt = seenAt;
      changed = true;
    }
    if (changed) this.publish('radar');
    return cloneMutable(this.radarStatus());
  }

  async dismissRadarActivities(activityIds: readonly string[]): Promise<RadarStatus> {
    const ids = new Set(activityIds);
    const dismissedAt = timestamp(this.state.now);
    let changed = false;
    for (const activity of this.state.radarActivities) {
      if (!ids.has(activity.id) || activity.dismissedAt !== null) continue;
      activity.dismissedAt = dismissedAt;
      changed = true;
    }
    if (changed) this.publish('radar');
    return cloneMutable(this.radarStatus());
  }

  async queryRecommendations(): Promise<RecommendationQueryResponse> {
    return cloneMutable({
      recommendations: this.projectRecommendations(),
      ignored: this.state.recommendationIgnores,
      status: this.recommendationStatus(),
    });
  }

  async refreshRecommendations(): Promise<RecommendationRefreshResult> {
    this.state.recommendationBatchIndex = (
      this.state.recommendationBatchIndex + 1
    ) % this.state.recommendationBatches.length;
    const now = timestamp(this.state.now);
    this.state.recommendationState.lastAttemptAt = now;
    this.state.recommendationState.lastSuccessfulAt = now;
    this.state.recommendationState.candidateCount = this.activeRecommendationBatch().length;
    this.publish('recommendations');
    return cloneMutable({ published: true, status: this.recommendationStatus() });
  }

  async ignoreRecommendation(repositoryKey: string, repositoryFullName: string): Promise<void> {
    const key = canonicalRepository(repositoryKey);
    if (this.state.recommendationIgnores.some((row) => row.repositoryKey === key)) return;
    const matching = this.allRecommendations().find((row) => row.repositoryKey === key);
    this.state.recommendationIgnores.push({
      id: `${this.state.account.username ?? 'demo'}:${key}`,
      accountLogin: this.accountLogin(),
      repositoryKey: key,
      repositoryFullName: matching?.repositoryFullName ?? repositoryFullName,
      ignoredAt: timestamp(this.state.now),
    });
    this.publish('recommendations');
  }

  async restoreIgnoredRecommendation(repositoryKey: string): Promise<void> {
    const key = canonicalRepository(repositoryKey);
    const before = this.state.recommendationIgnores.length;
    this.state.recommendationIgnores = this.state.recommendationIgnores
      .filter((row) => row.repositoryKey !== key);
    if (this.state.recommendationIgnores.length !== before) this.publish('recommendations');
  }

  async starRepository(fullName: string): Promise<Star> {
    const { star, changed } = this.ensureLiveStar(fullName);
    if (changed) this.publish('data');
    return cloneMutable(star);
  }

  async addRepositoryTag(fullName: string, tagName: string): Promise<void> {
    const name = normalizeTagNames([tagName])[0];
    if (!name) throw new Error('Tag name is required.');
    const ensured = this.ensureLiveStar(fullName);
    const { tag, created } = this.ensureTag(ensured.star.full_name);
    const current = manualTagNames(tag);
    const tags = addTagNames(current, [name]);
    const revived = this.reviveExcludedTags([name]);
    if (sameTagNames(current, tags) && !ensured.changed && !revived && !created) return;
    const mtime = timestamp(this.state.now);
    tag.manualTags = tags;
    tag.dismissedAutoTags = withoutTagName(dismissedAutoTagNames(tag), name);
    tag.manualTagsMtime = mtime;
    tag.dismissedAutoTagsMtime = mtime;
    tag.mtime = mtime;
    this.publish('data');
  }

  async reset(): Promise<number> {
    this.state = createBaselineState();
    this.publish('reset');
    return this.epoch;
  }

  private publish(kind: ManagerRuntimeEventKind): void {
    const event = Object.freeze({ kind, epoch: ++this.epoch });
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One subscriber cannot prevent the remaining subscribers from observing the commit.
      }
    }
  }

  private accountLogin(): string {
    const login = this.state.account.username?.trim().toLocaleLowerCase('en-US');
    if (!login) throw new Error('Demo account is unavailable.');
    return login;
  }

  private assertWatchAccount(accountLogin: string): void {
    if (accountLogin.trim().toLocaleLowerCase('en-US') !== this.accountLogin()) {
      throw new Error('Watch account does not match the Demo account.');
    }
  }

  private repositoryDisplayName(fullName: string): string {
    const key = canonicalRepository(fullName);
    const star = this.state.stars.find((row) => canonicalRepository(row.full_name) === key);
    if (star) return star.full_name;
    const tag = this.state.tags.find((row) => canonicalRepository(row.full_name) === key);
    if (tag) return tag.full_name;
    const recommendation = this.allRecommendations().find((row) => row.repositoryKey === key);
    if (recommendation) return recommendation.repositoryFullName;
    const activity = this.state.radarActivities.find((row) => row.repositoryKey === key);
    return activity?.repositoryFullName ?? key;
  }

  private ensureTag(fullName: string): { tag: Tag; created: boolean } {
    const repositoryKey = canonicalRepository(fullName);
    const existing = this.state.tags.find((tag) => canonicalRepository(tag.full_name) === repositoryKey);
    if (existing) return { tag: existing, created: false };
    const created = emptyTag(fullName, this.state.now);
    this.state.tags.push(created);
    return { tag: created, created: true };
  }

  private reviveExcludedTags(names: readonly string[]): boolean {
    const keys = new Set(names.map(canonicalTagKey));
    let changed = false;
    for (const meta of this.state.tagMeta) {
      if (!keys.has(canonicalTagKey(meta.name)) || meta.excluded !== true) continue;
      meta.excluded = false;
      meta.mtime = timestamp(this.state.now);
      changed = true;
    }
    return changed;
  }

  private projectWatch(unreadOnly: boolean) {
    return projectWatchInbox(this.state.watchThreads, { unreadOnly });
  }

  private watchStatus(): WatchStatus {
    return {
      accountLogin: this.accountLogin(),
      hasMainToken: true,
      hasNotificationsToken: true,
      refreshing: false,
      refreshPhase: null,
      scopeStatus: 'fresh',
      inboxStatus: 'fresh',
      state: cloneMutable(this.state.watchState),
    };
  }

  private projectRadar() {
    return projectRadarActivities({
      accountLogin: this.accountLogin(),
      nowMillis: this.state.now,
      windowDays: this.state.radarState.windowDays ?? 60,
      activities: this.state.radarActivities,
      stars: this.state.stars,
      tags: this.state.tags,
      tagMeta: this.state.tagMeta,
    }).map((activity) => ({
      ...activity,
      repositoryHtmlUrl: '#',
    }));
  }

  private radarStatus(): RadarStatus {
    return {
      accountLogin: this.accountLogin(),
      hasMainToken: true,
      refreshing: false,
      windowDays: this.state.radarState.windowDays ?? 60,
      snapshotStatus: this.state.radarState.partialReasons.length > 0 ? 'partial' : 'fresh',
      errorCode: this.state.radarState.errorCode,
      state: cloneMutable(this.state.radarState),
    };
  }

  private activeRecommendationBatch(): RecommendationRecord[] {
    return this.state.recommendationBatches[this.state.recommendationBatchIndex] ?? [];
  }

  private allRecommendations(): RecommendationRecord[] {
    return this.state.recommendationBatches.flat();
  }

  private projectRecommendations(): RecommendationRecord[] {
    return projectRecommendations({
      accountLogin: this.accountLogin(),
      recommendations: this.activeRecommendationBatch(),
      stars: this.state.stars,
      ignores: this.state.recommendationIgnores,
    });
  }

  private recommendationStatus(): RecommendationStatus {
    return {
      accountLogin: this.accountLogin(),
      hasMainToken: true,
      refreshing: false,
      snapshotStatus: 'fresh',
      errorCode: this.state.recommendationState.errorCode,
      state: cloneMutable(this.state.recommendationState),
    };
  }

  private ensureLiveStar(fullName: string): { star: Star; changed: boolean } {
    const repositoryKey = canonicalRepository(fullName);
    const existing = this.state.stars.find((star) => canonicalRepository(star.full_name) === repositoryKey);
    if (existing) {
      if (!existing.tombstone && existing.viewer_has_starred !== false) return { star: existing, changed: false };
      existing.tombstone = false;
      existing.viewer_has_starred = true;
      existing.starred_at = timestamp(this.state.now);
      existing.synced_at = timestamp(this.state.now);
      return { star: existing, changed: true };
    }

    const recommendation = this.allRecommendations().find((row) => row.repositoryKey === repositoryKey);
    const activity = this.state.radarActivities.find((row) => row.repositoryKey === repositoryKey);
    if (!recommendation && !activity) throw new Error(`Unknown repository: ${fullName}`);
    const displayName = recommendation?.repositoryFullName ?? activity?.repositoryFullName ?? repositoryKey;
    const owner = displayName.split('/')[0] ?? displayName;
    const star: Star = recommendation ? {
      full_name: displayName,
      html_url: recommendation.repositoryHtmlUrl,
      description: recommendation.description,
      language: recommendation.language,
      stargazers_count: recommendation.stargazerCount,
      topics: [...recommendation.topics],
      pushed_at: recommendation.pushedAt,
      created_at: recommendation.createdAt,
      fork: recommendation.fork,
      archived: recommendation.archived,
      owner_avatar_url: this.state.avatarAssets[owner] ?? this.state.avatarAssets.default,
      viewer_has_starred: true,
      starred_at: timestamp(this.state.now),
      tombstone: false,
      synced_at: timestamp(this.state.now),
    } : {
      full_name: displayName,
      html_url: activity?.repositoryHtmlUrl ?? '#',
      description: activity?.repositoryDescription ?? '',
      language: activity?.repositoryLanguage ?? null,
      stargazers_count: activity?.repositoryStargazerCount ?? 0,
      topics: [...(activity?.repositoryTopics ?? [])],
      pushed_at: activity?.starredAt ?? timestamp(this.state.now),
      created_at: null,
      fork: false,
      archived: false,
      owner_avatar_url: this.state.avatarAssets[owner] ?? this.state.avatarAssets.default,
      viewer_has_starred: true,
      starred_at: timestamp(this.state.now),
      tombstone: false,
      synced_at: timestamp(this.state.now),
    };
    this.state.stars.push(star);
    return { star, changed: true };
  }
}

export function createDemoManagerRuntime(options: DemoManagerRuntimeOptions = {}): ManagerRuntime {
  return new DemoManagerRuntime(options);
}
