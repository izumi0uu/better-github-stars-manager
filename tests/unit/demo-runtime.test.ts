import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoManagerRuntime } from '@/demo/runtime';
import type { ManagerRuntime, ManagerRuntimeEvent } from '@/runtime/manager-runtime';
import type { StarsQueryParams } from '@/stars/stars-query';

const ALL_STARS_QUERY: StarsQueryParams = {
  filter: {
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any',
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    onlyOwned: false,
    sortKey: 'starred_at',
    sortDir: 'desc',
  },
  accountLogin: 'demo-scout',
  offset: 0,
  limit: 1_000,
};

async function semanticSnapshot(runtime: ManagerRuntime) {
  const [account, preferences, stars, excludedTags, watch, radar, recommendations, badges] = await Promise.all([
    runtime.getAccount(),
    runtime.readPreferences(),
    runtime.queryStars(ALL_STARS_QUERY),
    runtime.listExcludedTags(),
    runtime.queryWatchInbox({ unreadOnly: false }),
    runtime.queryRadar(),
    runtime.queryRecommendations(),
    runtime.querySurfaceBadges(),
  ]);
  return {
    now: runtime.now(),
    account,
    preferences,
    stars,
    excludedTags,
    watch,
    radar,
    recommendations,
    badges,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DemoManagerRuntime', () => {
  it('derives populated totals and badges from canonical rows', async () => {
    const runtime = createDemoManagerRuntime();
    const [stars, watchAll, watchUnread, radar, recommendations, badges] = await Promise.all([
      runtime.queryStars(ALL_STARS_QUERY),
      runtime.queryWatchInbox({ unreadOnly: false }),
      runtime.queryWatchInbox({ unreadOnly: true }),
      runtime.queryRadar(),
      runtime.queryRecommendations(),
      runtime.querySurfaceBadges(),
    ]);

    expect(runtime.now()).toBe(Date.parse('2026-08-16T12:00:00.000Z'));
    expect(stars.grandTotal).toBeGreaterThanOrEqual(60);
    expect(stars.total).toBe(stars.rows.length);
    expect(stars.tagTotal).toBe(10);
    expect(stars.languages.reduce((count, [, languageCount]) => count + languageCount, 0))
      .toBeLessThanOrEqual(stars.grandTotal);
    expect(watchAll.totalCount).toBe(16);
    expect(watchAll.groups).toHaveLength(5);
    expect(watchUnread.threads.every((thread) => thread.unread)).toBe(true);
    const outsideLocalStars = watchAll.threads.find((thread) => (
      !stars.rows.some((star) => star.full_name === thread.repositoryFullName)
    ));
    expect(outsideLocalStars).toMatchObject({
      id: '1099',
      repositoryFullName: 'aurora-workshop/inbox-bridge',
      unread: true,
    });
    expect(radar.activities.filter((activity) => activity.source === 'following')).toHaveLength(12);
    expect(recommendations.recommendations.length).toBeGreaterThanOrEqual(6);
    expect(badges).toEqual({
      watchUnreadCount: watchAll.threads.filter((thread) => thread.unread).length,
      radarUnseenCount: radar.activities.filter((activity) => (
        activity.source === 'following' && !activity.seen
      )).length,
    });
  });

  it('reprojects the selected Following window and reconciles provenance on full refresh', async () => {
    const runtime = createDemoManagerRuntime();
    const initial = await runtime.queryRadar();
    const initialSelfCount = initial.activities.filter((activity) => activity.source === 'self').length;

    expect(initialSelfCount).toBeGreaterThan(0);
    expect(initial.status).toMatchObject({
      windowDays: 60,
      snapshotStatus: 'fresh',
      state: { windowDays: 60 },
    });

    await runtime.updatePreferences({ radarWindowDays: 30 });
    const narrowed = await runtime.queryRadar();
    expect(narrowed.activities.filter((activity) => activity.source === 'self')).toHaveLength(0);
    expect(narrowed.status).toMatchObject({
      windowDays: 30,
      snapshotStatus: 'stale',
      state: { windowDays: 60 },
    });

    const refreshed = await runtime.fullReconcileRadar();
    expect(refreshed.status).toMatchObject({
      windowDays: 30,
      snapshotStatus: 'fresh',
      state: { windowDays: 30 },
    });
  });

  it('applies the synthetic account to owned-repository queries', async () => {
    const runtime = createDemoManagerRuntime();
    const owned = await runtime.queryStars({
      ...ALL_STARS_QUERY,
      accountLogin: undefined,
      filter: {
        ...ALL_STARS_QUERY.filter,
        onlyOwned: true,
      },
    });

    expect(owned.rows.length).toBeGreaterThan(0);
    expect(owned.rows.every((star) => star.full_name.startsWith('demo-scout/'))).toBe(true);
  });

  it('keeps Stars annotations and deletion semantics coherent', async () => {
    const runtime = createDemoManagerRuntime();
    const fullName = 'meadow-labs/beacon-kit';

    await runtime.setTags(fullName, ['Demo Tag', 'Reference']);
    await runtime.setNotes(fullName, 'A local-only note.');
    await runtime.setFavorite(fullName, true);
    let stars = await runtime.queryStars(ALL_STARS_QUERY);
    expect(stars.tagsForRows[fullName]).toMatchObject({
      manualTags: ['Demo Tag', 'Reference'],
      notes: 'A local-only note.',
      favorite: true,
    });
    expect((await runtime.queryRadar()).activities).toContainEqual(expect.objectContaining({
      repositoryKey: fullName,
      favorite: true,
      tags: expect.arrayContaining(['Demo Tag', 'Reference']),
    }));

    expect(await runtime.removeVisibleTag(fullName, 'Demo Tag')).toEqual({ removed: true });
    expect(await runtime.deleteTag('Reference')).toMatchObject({ removed: expect.any(Number) });
    expect(await runtime.listExcludedTags()).toContain('Reference');
    await runtime.setTags(fullName, ['Reference']);
    expect(await runtime.listExcludedTags()).not.toContain('Reference');

    const deleted = await runtime.deleteAllTags();
    expect(deleted.assignmentsRemoved).toBeGreaterThan(0);
    expect(deleted.distinctTagsRemoved).toBeGreaterThan(0);
    stars = await runtime.queryStars(ALL_STARS_QUERY);
    expect(stars.tagTotal).toBe(0);
    expect(stars.tagsForRows[fullName]?.notes).toBe('A local-only note.');
    expect(stars.tagsForRows[fullName]?.favorite).toBe(true);
  });

  it('updates Watch, Following, and recommendation state locally', async () => {
    const runtime = createDemoManagerRuntime();
    const watchBefore = await runtime.queryWatchInbox({ unreadOnly: false });
    const unread = watchBefore.threads.find((thread) => thread.unread);
    const done = watchBefore.threads.find((thread) => thread.id !== unread?.id);
    expect(unread).toBeDefined();
    expect(done).toBeDefined();

    const detail = await runtime.getWatchSubjectDetail(unread!.id);
    expect(detail.repositoryFullName).toBe(unread!.repositoryFullName);
    expect(await runtime.markWatchThreadsRead({
      accountLogin: 'demo-scout',
      threadIds: [unread!.id],
    })).toMatchObject({ action: 'read', changedCount: 1 });
    expect(await runtime.markWatchThreadsDone({
      accountLogin: 'demo-scout',
      threadIds: [done!.id],
    })).toMatchObject({ action: 'done', changedCount: 1 });
    await runtime.updateWatchCollapse(unread!.repositoryFullName, 'demo-signature');
    expect((await runtime.readPreferences()).watchCollapsedRepositories)
      .toMatchObject({ [unread!.repositoryFullName]: 'demo-signature' });
    await runtime.updateWatchCollapse(unread!.repositoryFullName, null);
    expect((await runtime.readPreferences()).watchCollapsedRepositories)
      .not.toHaveProperty(unread!.repositoryFullName);
    const starsBeforeUnstar = await runtime.queryStars(ALL_STARS_QUERY);
    const watchBeforeUnstar = await runtime.queryWatchInbox({ unreadOnly: false });
    await runtime.markUnstarred(unread!.repositoryFullName);
    expect((await runtime.queryStars(ALL_STARS_QUERY)).total).toBe(starsBeforeUnstar.total - 1);
    const watchAfterUnstar = await runtime.queryWatchInbox({ unreadOnly: false });
    expect(watchAfterUnstar.totalCount).toBe(watchBeforeUnstar.totalCount);
    expect(watchAfterUnstar.groups)
      .toContainEqual(expect.objectContaining({ repositoryFullName: unread!.repositoryFullName }));
    const refreshedWatch = await runtime.refreshWatch();
    expect(refreshedWatch.status.state?.inbox).toMatchObject({
      candidateCount: watchAfterUnstar.totalCount,
      matchedCount: watchAfterUnstar.totalCount,
      scanId: null,
      scanStatus: 'complete',
      scanStartedAt: null,
      scanPageCount: 1,
      lastConvergedAt: '2026-08-16T12:00:00.000Z',
      truncated: false,
      historyNextPage: null,
      historyExhausted: true,
      historyErrorCode: null,
    });

    const radarBefore = await runtime.queryRadar();
    const unseen = radarBefore.activities.filter((activity) => (
      activity.source === 'following' && !activity.seen
    ));
    expect(unseen.length).toBeGreaterThanOrEqual(2);
    await runtime.markRadarActivitiesSeen([unseen[0]!.id]);
    await runtime.dismissRadarActivities([unseen[1]!.id]);
    const radarAfter = await runtime.queryRadar();
    expect(radarAfter.activities.find((activity) => activity.id === unseen[0]!.id)?.seen).toBe(true);
    expect(radarAfter.activities.some((activity) => activity.id === unseen[1]!.id)).toBe(false);

    const recommendation = (await runtime.queryRecommendations()).recommendations[0]!;
    await runtime.ignoreRecommendation(recommendation.repositoryKey, recommendation.repositoryFullName);
    expect((await runtime.queryRecommendations()).recommendations)
      .not.toContainEqual(expect.objectContaining({ repositoryKey: recommendation.repositoryKey }));
    await runtime.restoreIgnoredRecommendation(recommendation.repositoryKey);
    expect((await runtime.queryRecommendations()).recommendations)
      .toContainEqual(expect.objectContaining({ repositoryKey: recommendation.repositoryKey }));
  });

  it('stars and tags discoveries atomically across surfaces', async () => {
    const runtime = createDemoManagerRuntime();
    const initialStars = await runtime.queryStars(ALL_STARS_QUERY);
    const recommendations = (await runtime.queryRecommendations()).recommendations;
    const starredRecommendation = recommendations[0]!;
    const taggedRecommendation = recommendations[1]!;
    const events: ManagerRuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.starRepository(starredRecommendation.repositoryFullName);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'data', epoch: 1 });
    expect((await runtime.queryRecommendations()).recommendations)
      .not.toContainEqual(expect.objectContaining({ repositoryKey: starredRecommendation.repositoryKey }));
    let stars = await runtime.queryStars(ALL_STARS_QUERY);
    expect(stars.total).toBe(initialStars.total + 1);
    expect(stars.rows).toContainEqual(expect.objectContaining({
      full_name: starredRecommendation.repositoryFullName,
      tombstone: false,
    }));
    expect((await runtime.queryRadar()).activities).toContainEqual(expect.objectContaining({
      repositoryKey: starredRecommendation.repositoryKey,
      viewerHasStarred: true,
    }));

    await runtime.addRepositoryTag(taggedRecommendation.repositoryFullName, 'Discovery');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'data', epoch: 2 });
    stars = await runtime.queryStars(ALL_STARS_QUERY);
    expect(stars.rows).toContainEqual(expect.objectContaining({
      full_name: taggedRecommendation.repositoryFullName,
      tombstone: false,
    }));
    expect(stars.tagsForRows[taggedRecommendation.repositoryFullName]?.manualTags)
      .toContain('Discovery');
    expect((await runtime.queryRadar()).activities).toContainEqual(expect.objectContaining({
      repositoryKey: taggedRecommendation.repositoryKey,
      viewerHasStarred: true,
      tags: expect.arrayContaining(['Discovery']),
    }));
    expect((await runtime.queryRecommendations()).recommendations)
      .not.toContainEqual(expect.objectContaining({ repositoryKey: taggedRecommendation.repositoryKey }));
  });

  it('publishes exactly one monotonically versioned event for every committed operation', async () => {
    const runtime = createDemoManagerRuntime();
    const initialWatch = await runtime.queryWatchInbox({ unreadOnly: false });
    const watchRows = initialWatch.threads.filter((thread) => (
      thread.repositoryFullName !== 'aurora-workshop/atlas-notes' && thread.unread
    ));
    const radarRows = (await runtime.queryRadar()).activities.filter((activity) => (
      activity.source === 'following' && !activity.seen
    ));
    const recommendationRows = (await runtime.queryRecommendations()).recommendations;
    const events: ManagerRuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));

    await runtime.updatePreferences({ theme: 'dark' });
    await runtime.setTags('meadow-labs/beacon-kit', ['One', 'Two']);
    await runtime.setNotes('meadow-labs/beacon-kit', 'Changed');
    await runtime.setFavorite('meadow-labs/beacon-kit', true);
    await runtime.removeVisibleTag('meadow-labs/beacon-kit', 'One');
    await runtime.deleteTag('Two');
    await runtime.deleteAllTags();
    await runtime.markUnstarred('aurora-workshop/atlas-notes');
    await runtime.markWatchThreadsRead({ accountLogin: 'demo-scout', threadIds: [watchRows[0]!.id] });
    await runtime.markWatchThreadsDone({ accountLogin: 'demo-scout', threadIds: [watchRows[1]!.id] });
    await runtime.updateWatchCollapse(watchRows[0]!.repositoryFullName, 'collapsed');
    await runtime.markRadarActivitiesSeen([radarRows[0]!.id]);
    await runtime.dismissRadarActivities([radarRows[1]!.id]);
    await runtime.ignoreRecommendation(
      recommendationRows[2]!.repositoryKey,
      recommendationRows[2]!.repositoryFullName,
    );
    await runtime.restoreIgnoredRecommendation(recommendationRows[2]!.repositoryKey);
    await runtime.starRepository(recommendationRows[0]!.repositoryFullName);
    await runtime.addRepositoryTag(recommendationRows[1]!.repositoryFullName, 'Discovery');
    await runtime.refreshWatch();
    await runtime.refreshRadar();
    await runtime.refreshRecommendations();
    await runtime.reset();

    expect(events.map((event) => event.kind)).toEqual([
      'preferences',
      'data', 'data', 'data', 'data', 'data', 'data', 'data',
      'watch', 'watch', 'preferences',
      'radar', 'radar',
      'recommendations', 'recommendations',
      'data', 'data',
      'watch', 'radar', 'recommendations',
      'reset',
    ]);
    expect(events.map((event) => event.epoch)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );

    unsubscribe();
    await runtime.updatePreferences({ theme: 'dark' });
    expect(events).toHaveLength(21);
  });

  it('rotates local recommendation batches deterministically and resets exactly every time', async () => {
    const runtime = createDemoManagerRuntime();
    const baseline = await semanticSnapshot(runtime);
    const initialRecommendations = baseline.recommendations.recommendations;
    const watchThread = baseline.watch.threads.find((thread) => thread.unread)!;
    const radarRows = baseline.radar.activities.filter((activity) => (
      activity.source === 'following' && !activity.seen
    ));

    await runtime.updatePreferences({ theme: 'dark', locale: 'zh-CN' });
    await runtime.setNotes('meadow-labs/beacon-kit', 'Reset me');
    await runtime.markUnstarred('aurora-workshop/atlas-notes');
    await runtime.markWatchThreadsRead({ accountLogin: 'demo-scout', threadIds: [watchThread.id] });
    await runtime.updateWatchCollapse(watchThread.repositoryFullName, 'reset-signature');
    await runtime.markRadarActivitiesSeen([radarRows[0]!.id]);
    await runtime.dismissRadarActivities([radarRows[1]!.id]);
    await runtime.ignoreRecommendation(
      initialRecommendations[2]!.repositoryKey,
      initialRecommendations[2]!.repositoryFullName,
    );
    await runtime.starRepository(initialRecommendations[0]!.repositoryFullName);
    await runtime.refreshRecommendations();
    const rotatedNames = (await runtime.queryRecommendations()).recommendations
      .map((row) => row.repositoryFullName);
    expect(rotatedNames).not.toEqual(initialRecommendations.map((row) => row.repositoryFullName));

    await runtime.reset();
    expect(await semanticSnapshot(runtime)).toEqual(baseline);
    await runtime.refreshRecommendations();
    expect((await runtime.queryRecommendations()).recommendations.map((row) => row.repositoryFullName))
      .toEqual(rotatedNames);

    await runtime.setTags('meadow-labs/beacon-kit', ['Second reset']);
    await runtime.markWatchThreadsDone({ accountLogin: 'demo-scout', threadIds: [watchThread.id] });
    await runtime.reset();
    expect(await semanticSnapshot(runtime)).toEqual(baseline);
  });

  it('returns isolated snapshots that cannot mutate canonical state', async () => {
    const runtime = createDemoManagerRuntime();
    const events: ManagerRuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const stars = await runtime.queryStars(ALL_STARS_QUERY);
    const watch = await runtime.queryWatchInbox({ unreadOnly: false });
    const preferences = await runtime.readPreferences();
    const repository = stars.rows[0]!;
    const thread = watch.threads[0]!;

    repository.topics.push('caller-owned-change');
    repository.description = 'Caller-owned change';
    thread.subjectTitle = 'Caller-owned change';
    thread.unread = !thread.unread;
    preferences.libraryView.filters.tags.push('Caller-owned change');

    const [nextStars, nextWatch, nextPreferences] = await Promise.all([
      runtime.queryStars(ALL_STARS_QUERY),
      runtime.queryWatchInbox({ unreadOnly: false }),
      runtime.readPreferences(),
    ]);
    expect(nextStars.rows.find((row) => row.full_name === repository.full_name)?.topics)
      .not.toContain('caller-owned-change');
    expect(nextStars.rows.find((row) => row.full_name === repository.full_name)?.description)
      .not.toBe('Caller-owned change');
    expect(nextWatch.threads.find((row) => row.id === thread.id)?.subjectTitle)
      .not.toBe('Caller-owned change');
    expect(nextPreferences.libraryView.filters.tags).not.toContain('Caller-owned change');
    expect(events).toEqual([]);
  });

  it('contains resources and local refreshes without navigation or network access', async () => {
    const network = vi.fn(() => Promise.reject(new Error('Network access is forbidden.')));
    vi.stubGlobal('fetch', network);
    const runtime = createDemoManagerRuntime();

    const actorImage = runtime.resources.resolveImage({
      kind: 'actor-avatar',
      identity: 'lina-builds',
      remoteUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    });
    const repositoryImage = runtime.resources.resolveImage({
      kind: 'repository-avatar',
      identity: 'aurora-workshop/atlas-notes',
      remoteUrl: 'https://avatars.githubusercontent.com/u/2?v=4',
    });
    expect(actorImage).toBeTruthy();
    expect(repositoryImage).toBeTruthy();
    expect(actorImage).not.toMatch(/^https?:\/\//iu);
    expect(repositoryImage).not.toMatch(/^https?:\/\//iu);
    const blocked = {
      kind: 'repository' as const,
      fullName: 'aurora-workshop/atlas-notes',
      remoteUrl: 'https://github.com/aurora-workshop/atlas-notes',
    };
    expect(runtime.resources.resolveLink(blocked)).toBeNull();
    expect(() => runtime.resources.onBlockedLink(blocked)).not.toThrow();

    const recommendation = (await runtime.queryRecommendations()).recommendations[0]!;
    await runtime.starRepository(recommendation.repositoryFullName);
    const [stars, watch, radar, recommendations] = await Promise.all([
      runtime.queryStars(ALL_STARS_QUERY),
      runtime.queryWatchInbox({ unreadOnly: false }),
      runtime.queryRadar(),
      runtime.queryRecommendations(),
    ]);
    const projectedUrls = [
      ...stars.rows.map((star) => star.html_url),
      ...watch.threads.flatMap((thread) => [thread.repositoryHtmlUrl, thread.subjectHtmlUrl]),
      ...radar.activities.map((activity) => activity.repositoryHtmlUrl),
      ...recommendations.recommendations.map((row) => row.repositoryHtmlUrl),
    ].filter((value): value is string => value !== null);
    expect(projectedUrls.some((url) => url.includes('github.com'))).toBe(false);
    await runtime.refreshWatch();
    await runtime.refreshRadar();
    await runtime.refreshRecommendations();
    expect(network).not.toHaveBeenCalled();
  });
});
