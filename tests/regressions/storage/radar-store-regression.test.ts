import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import {
  clearRadarData,
  commitRadarSnapshot,
  countUnseenRadarActivities,
  dismissRadarActivities,
  getRadarState,
  listRadarActivities,
  markRadarActivitiesSeen,
  makeRadarStatus,
  prepareRadarAccount,
  radarSnapshotStatus,
  recordRadarFailure,
} from '@/storage/radar-store';
import type { RadarSourceSnapshot } from '@/radar/radar-contract';
import type { RadarActivityRecord } from '@/radar/radar-model';

const FIRST = '2026-08-10T10:00:00.000Z';
const SECOND = '2026-08-10T11:00:00.000Z';

function star(fullName: string, count = 100, tombstone = false) {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: 'local description',
    language: 'TypeScript',
    stargazers_count: count,
    topics: ['local'],
    pushed_at: FIRST,
    created_at: '2020-01-01T00:00:00Z',
    fork: false,
    archived: false,
    starred_at: FIRST,
    tombstone,
    synced_at: FIRST,
  };
}

function activity(
  id: string,
  repositoryFullName: string,
  starredAt: string,
  overrides: Partial<RadarActivityRecord> = {},
): RadarActivityRecord {
  return {
    id,
    accountLogin: 'viewer',
    actorLogin: `actor-${id}`,
    actorAvatarUrl: `https://avatars.example/actor-${id}.png`,
    repositoryKey: repositoryFullName.toLocaleLowerCase('en-US'),
    repositoryFullName,
    repositoryDisplayName: repositoryFullName,
    repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
    repositoryDescription: 'remote description',
    repositoryLanguage: 'Rust',
    repositoryLanguageColor: '#dea584',
    repositoryStargazerCount: 7,
    repositoryTopics: ['remote'],
    viewerHadStarred: false,
    starredAt,
    dismissedAt: null,
    seenAt: null,
    ...overrides,
  };
}

function snapshot(activities: RadarActivityRecord[], fetchedAt = SECOND): RadarSourceSnapshot {
  return {
    accountLogin: 'Viewer',
    activities,
    fetchedAt,
    followingCount: 4,
    scannedFollowingCount: 4,
    batchCount: 1,
    partialReasons: [],
    rateLimitRemaining: 4_000,
    rateLimitResetAt: null,
  };
}
async function followedActivities() {
  return (await listRadarActivities('viewer', Date.parse(SECOND)))
    .filter((row) => row.source === 'following');
}

describe('Radar snapshot storage', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(async () => {
    await db.close();
  });

  it('joins local library annotations and preserves explicit dismissals across snapshots', async () => {
    await db.stars.put(star('Owner/Repo', 321));
    await db.tags.put({
      full_name: 'owner/repo',
      manualTags: ['infra'],
      autoTags: ['rust'],
      dismissedAutoTags: [],
      manualTagsMtime: FIRST,
      autoTagsMtime: FIRST,
      dismissedAutoTagsMtime: FIRST,
      notes: '',
      favorite: true,
      mtime: FIRST,
    });
    const first = activity('a', 'Owner/Repo', FIRST);
    const second = activity('b', 'Owner/Repo', SECOND);
    await commitRadarSnapshot(snapshot([first, second], FIRST));

    expect(await dismissRadarActivities('VIEWER', ['a', 'a'])).toBe(1);
    const visible = await followedActivities();
    expect(visible.map((row) => row.id)).toEqual(['b']);

    const next = activity('c', 'new/project', SECOND);
    await commitRadarSnapshot(snapshot([first, next], SECOND));
    const rawDismissed = await db.radarActivities.get('a');
    expect(rawDismissed?.dismissedAt).not.toBeNull();
    expect((await followedActivities()).map((row) => row.id)).toEqual(['c']);

    await commitRadarSnapshot(snapshot([second], SECOND));
    const joined = await followedActivities();
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      id: 'b',
      viewerHasStarred: true,
      favorite: true,
      displayedStargazerCount: 321,
      repositoryTopics: ['local'],
      suggestedTags: ['local'],
    });
    expect(joined[0]?.tags).toEqual(['infra', 'rust']);
  });

  it('clears account-bound Radar rows before another account can read them', async () => {
    await commitRadarSnapshot(snapshot([activity('a', 'owner/repo', FIRST)]));
    expect(await getRadarState('viewer')).not.toBeNull();

    await prepareRadarAccount('another-account');

    expect(await getRadarState('viewer')).toBeNull();
    expect(await db.radarActivities.count()).toBe(0);
    expect(await getRadarState('another-account')).toBeNull();
  });

  it('normalizes legacy Radar rows that predate avatar, topic, and seen fields', async () => {
    const legacy = activity('legacy', 'owner/legacy', FIRST);
    Reflect.deleteProperty(legacy, 'actorAvatarUrl');
    Reflect.deleteProperty(legacy, 'repositoryTopics');
    Reflect.deleteProperty(legacy, 'seenAt');
    await db.radarActivities.put(legacy);

    expect(await followedActivities()).toMatchObject([
      {
        id: 'legacy',
        source: 'following',
        actorAvatarUrl: null,
        repositoryTopics: [],
        suggestedTags: [],
        seen: false,
        seenAt: null,
      },
    ]);
  });

  it('marks following activity seen idempotently and preserves it across snapshots', async () => {
    const first = activity('a', 'owner/repo', FIRST);
    await commitRadarSnapshot(snapshot([first], FIRST));

    expect(await markRadarActivitiesSeen('another-account', ['a'], FIRST)).toBe(0);
    expect(await markRadarActivitiesSeen('VIEWER', ['a', 'a'], FIRST)).toBe(1);
    expect(await markRadarActivitiesSeen('viewer', ['a'], SECOND)).toBe(0);
    expect(await followedActivities()).toMatchObject([
      { id: 'a', source: 'following', seen: true, seenAt: FIRST },
    ]);

    await commitRadarSnapshot(snapshot([activity('a', 'owner/repo', FIRST)], SECOND));

    expect(await db.radarActivities.get('a')).toMatchObject({ seenAt: FIRST });
    expect(await followedActivities()).toMatchObject([{ id: 'a', seen: true }]);
  });

  it('counts visible unseen activity only for the bound account', async () => {
    await commitRadarSnapshot(snapshot([
      activity('unseen', 'owner/unseen', FIRST),
      activity('seen', 'owner/seen', FIRST, { seenAt: FIRST }),
      activity('dismissed', 'owner/dismissed', FIRST),
    ], FIRST));
    await dismissRadarActivities('viewer', ['dismissed']);
    await markRadarActivitiesSeen('viewer', ['seen'], FIRST);

    expect(await countUnseenRadarActivities('VIEWER')).toBe(1);
    expect(await countUnseenRadarActivities('another-account')).toBe(0);

    await markRadarActivitiesSeen('viewer', ['unseen'], SECOND);
    expect(await countUnseenRadarActivities('viewer')).toBe(0);
  });

  it('keeps the last successful rows while recording a stale failure', async () => {
    await commitRadarSnapshot(snapshot([activity('a', 'owner/repo', FIRST)], FIRST));
    const failure = await recordRadarFailure('viewer', 'network_error');
    expect(failure.lastSuccessfulAt).toBe(FIRST);
    expect(failure.errorCode).toBe('network_error');
    expect(await followedActivities()).toHaveLength(1);
    expect(radarSnapshotStatus(failure, Date.parse(FIRST) + 31 * 60_000)).toBe('stale');
    expect(makeRadarStatus('viewer', true, false, failure, Date.parse(FIRST) + 31 * 60_000))
      .toMatchObject({ snapshotStatus: 'stale', errorCode: 'network_error' });
  });

  it('projects recent live Stars as self activity without copying them into Radar storage', async () => {
    const expiredAt = new Date(Date.parse(SECOND) - 31 * 24 * 60 * 60 * 1_000).toISOString();
    await db.stars.bulkPut([
      star('owner/recent', 77),
      { ...star('owner/expired'), starred_at: expiredAt },
      star('owner/tombstone', 1, true),
    ]);
    await db.tags.put({
      full_name: 'owner/recent',
      manualTags: ['mine'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: FIRST,
      autoTagsMtime: FIRST,
      dismissedAutoTagsMtime: FIRST,
      notes: '',
      favorite: true,
      mtime: FIRST,
    });
    await commitRadarSnapshot(snapshot([
      activity('followed', 'owner/followed', SECOND),
    ]));

    const activities = await listRadarActivities('viewer', Date.parse(SECOND));

    expect(activities.map((row) => [row.source, row.repositoryKey])).toEqual([
      ['following', 'owner/followed'],
      ['self', 'owner/recent'],
    ]);
    expect(activities[1]).toMatchObject({
      actorLogin: 'viewer',
      actorAvatarUrl: null,
      viewerHasStarred: true,
      seen: true,
      favorite: true,
      tags: ['mine'],
      displayedStargazerCount: 77,
    });
    expect(await db.radarActivities.count()).toBe(1);
  });

  it('rolls back activity replacement when the state checkpoint fails', async () => {
    const old = activity('old', 'owner/old', FIRST);
    await commitRadarSnapshot(snapshot([old], FIRST));
    const beforeRows = await db.radarActivities.toArray();
    const beforeState = await db.radarState.get('singleton');
    const statePut = vi.spyOn(db.radarState, 'put').mockRejectedValueOnce(new Error('checkpoint failed'));

    await expect(commitRadarSnapshot(snapshot([activity('new', 'owner/new', SECOND)], SECOND)))
      .rejects.toThrow('checkpoint failed');

    statePut.mockRestore();
    expect(await db.radarActivities.toArray()).toEqual(beforeRows);
    expect(await db.radarState.get('singleton')).toEqual(beforeState);
  });

  it('keeps Radar cleanup separate from Stars and tag metadata', async () => {
    await db.stars.put(star('owner/library'));
    await db.tags.put({
      full_name: 'owner/library',
      manualTags: ['keep'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: FIRST,
      autoTagsMtime: FIRST,
      dismissedAutoTagsMtime: FIRST,
      notes: 'keep',
      favorite: false,
      mtime: FIRST,
    });
    await db.tagMeta.put({ name: 'keep', dimension: null, color: null, excluded: false, mtime: FIRST });
    await commitRadarSnapshot(snapshot([activity('a', 'owner/repo', FIRST)]));

    await clearRadarData();

    expect(await db.radarActivities.count()).toBe(0);
    expect(await db.radarState.count()).toBe(0);
    expect(await db.stars.get('owner/library')).toBeDefined();
    expect(await db.tags.get('owner/library')).toBeDefined();
    expect(await db.tagMeta.get('keep')).toBeDefined();
  });

  it('derives distinct suggestions from cached topics and only live local Star topics', async () => {
    await db.stars.bulkPut([
      { ...star('owner/live'), topics: ['local-live', 'excluded-topic'] },
      { ...star('owner/tombstoned', 1, true), topics: ['local-tombstone'] },
      {
        ...star('owner/nonstarred'),
        topics: ['local-nonstarred'],
        viewer_has_starred: false,
      },
    ]);
    await db.tagMeta.put({
      name: 'EXCLUDED-TOPIC',
      dimension: null,
      color: null,
      excluded: true,
      mtime: SECOND,
    });
    await commitRadarSnapshot(snapshot([
      activity('live', 'owner/live', SECOND, {
        repositoryTopics: ['remote-live', 'excluded-topic'],
      }),
      activity('tombstoned', 'owner/tombstoned', SECOND, {
        repositoryTopics: ['remote-tombstone', 'excluded-topic'],
      }),
      activity('nonstarred', 'owner/nonstarred', SECOND, {
        repositoryTopics: ['remote-nonstarred'],
      }),
      activity('remote', 'owner/remote', SECOND, {
        repositoryTopics: ['topic-one', 'topic-two'],
      }),
    ]));

    expect((await db.radarActivities.get('remote'))?.repositoryTopics)
      .toEqual(['topic-one', 'topic-two']);
    const rows = new Map((await followedActivities()).map((row) => [row.repositoryKey, row]));
    expect(rows.get('owner/live')).toMatchObject({
      repositoryTopics: ['excluded-topic', 'local-live'],
      suggestedTags: ['local-live'],
    });
    expect(rows.get('owner/tombstoned')).toMatchObject({
      repositoryTopics: ['excluded-topic', 'remote-tombstone'],
      suggestedTags: ['remote-tombstone'],
    });
    expect(rows.get('owner/nonstarred')).toMatchObject({
      repositoryTopics: ['remote-nonstarred'],
      suggestedTags: ['remote-nonstarred'],
    });
    expect(rows.get('owner/remote')).toMatchObject({
      repositoryTopics: ['topic-one', 'topic-two'],
      suggestedTags: ['topic-one', 'topic-two'],
    });
  });
});
