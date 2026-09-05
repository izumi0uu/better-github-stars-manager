import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import {
  clearRadarData,
  commitRadarReconciliationStep,
  commitRadarSnapshot,
  commitRadarRefresh,
  countUnseenRadarActivities,
  dismissRadarActivities,
  getRadarReconciliation,
  getRadarState,
  listRadarActivities,
  markRadarActivitiesSeen,
  makeRadarStatus,
  prepareRadarAccount,
  radarSnapshotStatus,
  recordRadarFailure,
  startRadarReconciliation,
} from '@/storage/radar-store';
import type { RadarReconciliationSourceStep, RadarSourceSnapshot } from '@/radar/radar-contract';
import {
  createRadarReconciliationCheckpoint,
  type RadarActivityRecord,
  type RadarReconciliationCheckpoint,
} from '@/radar/radar-model';

const FIRST = '2026-08-10T10:00:00.000Z';
const SECOND = '2026-08-10T11:00:00.000Z';
const THIRD = '2026-08-10T12:00:00.000Z';

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

function snapshot(
  activities: RadarActivityRecord[],
  fetchedAt = SECOND,
  windowDays = 60,
  refreshMode: 'full' | 'incremental' = 'full',
  partialReasons: RadarSourceSnapshot['partialReasons'] = [],
): RadarSourceSnapshot {
  return {
    accountLogin: 'Viewer',
    activities,
    windowDays,
    refreshMode,
    lookbackDays: refreshMode === 'incremental' ? 7 : windowDays,
    fetchedAt,
    followingCount: 4,
    scannedFollowingCount: 4,
    batchCount: 1,
    partialReasons,
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

  it('marks a different selected window stale and filters saved rows immediately', async () => {
    const nowMillis = Date.parse(SECOND);
    const insideSixty = new Date(nowMillis - 45 * 24 * 60 * 60 * 1_000).toISOString();
    const outsideSixty = new Date(nowMillis - 75 * 24 * 60 * 60 * 1_000).toISOString();
    const committed = await commitRadarSnapshot(snapshot([
      activity('inside', 'owner/inside', insideSixty),
      activity('outside', 'owner/outside', outsideSixty),
    ], SECOND, 90));

    expect(radarSnapshotStatus(committed, nowMillis, 90)).toBe('fresh');
    expect(radarSnapshotStatus(committed, nowMillis, 60)).toBe('stale');
    expect((await listRadarActivities('viewer', nowMillis, 60)).map((row) => row.id))
      .toEqual(['inside']);
    expect(await countUnseenRadarActivities('viewer', nowMillis, 60)).toBe(1);
  });

  it('bounds window reads at the cutoff and at now, inclusive', async () => {
    const nowMillis = Date.parse(SECOND);
    const day = 24 * 60 * 60 * 1_000;
    const atCutoff = new Date(nowMillis - 60 * day).toISOString();
    const justInside = new Date(nowMillis - 60 * day + 1_000).toISOString();
    const justOutside = new Date(nowMillis - 60 * day - 1_000).toISOString();
    const atNow = new Date(nowMillis).toISOString();
    const future = new Date(nowMillis + 1_000).toISOString();
    await commitRadarSnapshot(snapshot([
      activity('at-cutoff', 'owner/at-cutoff', atCutoff),
      activity('just-inside', 'owner/just-inside', justInside),
      activity('just-outside', 'owner/just-outside', justOutside),
      activity('at-now', 'owner/at-now', atNow),
      activity('future', 'owner/future', future),
    ], SECOND, 90));

    const listed = (await listRadarActivities('viewer', nowMillis, 60))
      .filter((row) => row.source === 'following')
      .map((row) => row.id)
      .sort();

    expect(listed).toEqual(['at-cutoff', 'at-now', 'just-inside']);
    expect(await countUnseenRadarActivities('viewer', nowMillis, 60)).toBe(3);
  });

  it('projects recent live Stars as self activity without copying them into Radar storage', async () => {
    const expiredAt = new Date(Date.parse(SECOND) - 61 * 24 * 60 * 60 * 1_000).toISOString();
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
  it('merges incremental rows, preserves local metadata, and retains omissions', async () => {
    const old = activity('old', 'owner/old', FIRST, { seenAt: FIRST, dismissedAt: SECOND });
    const updated = activity('updated', 'owner/updated', FIRST, {
      seenAt: FIRST,
      dismissedAt: SECOND,
      repositoryDescription: 'old remote value',
    });
    await commitRadarSnapshot(snapshot([old, updated], FIRST));

    const incoming = activity('updated', 'owner/updated', SECOND, {
      seenAt: null,
      dismissedAt: null,
      repositoryDescription: 'new remote value',
    });
    const state = await commitRadarRefresh(snapshot([incoming], SECOND, 60, 'incremental'));

    expect(await db.radarActivities.get('old')).toBeDefined();
    expect(await db.radarActivities.get('updated')).toMatchObject({
      starredAt: SECOND,
      repositoryDescription: 'new remote value',
      seenAt: FIRST,
      dismissedAt: SECOND,
    });
    expect(state.lastRefreshMode).toBe('incremental');
    expect(state.lastIncrementalAt).toBe(SECOND);
    expect(state.lastFullReconciledAt).toBe(FIRST);
  });

  it('removes omitted rows only for a complete full reconciliation', async () => {
    await commitRadarSnapshot(snapshot([
      activity('keep', 'owner/keep', FIRST),
      activity('stale', 'owner/stale', FIRST),
    ], FIRST));

    await commitRadarRefresh(snapshot([activity('keep', 'owner/keep', SECOND)], SECOND, 60, 'full'));
    expect(await db.radarActivities.get('stale')).toBeUndefined();
  });

  it('preserves omitted rows when full following coverage is incomplete', async () => {
    await commitRadarSnapshot(snapshot([
      activity('keep', 'owner/keep', FIRST),
      activity('stale', 'owner/stale', FIRST),
    ], FIRST));

    const incomplete = {
      ...snapshot([activity('keep', 'owner/keep', SECOND)], SECOND, 90, 'full'),
      scannedFollowingCount: 3,
    };
    const state = await commitRadarRefresh(incomplete);

    expect(await db.radarActivities.get('stale')).toBeDefined();
    expect(state.windowDays).toBe(60);
    expect(state.lastFullReconciledAt).toBe(FIRST);
  });

  it('preserves omitted rows for partial full results', async () => {
    await commitRadarSnapshot(snapshot([
      activity('keep', 'owner/keep', FIRST),
      activity('stale', 'owner/stale', FIRST),
    ], FIRST));

    const state = await commitRadarRefresh(snapshot(
      [activity('keep', 'owner/keep', SECOND)],
      SECOND,
      90,
      'full',
      ['following_scan_truncated'],
    ));
    expect(await db.radarActivities.get('stale')).toBeDefined();
    expect(state.windowDays).toBe(60);
    expect(state.lastFullReconciledAt).toBe(FIRST);
  });

  it('does not initialize authoritative window provenance from a partial full result', async () => {
    const state = await commitRadarRefresh(snapshot(
      [activity('partial', 'owner/partial', SECOND)],
      SECOND,
      90,
      'full',
      ['following_scan_truncated'],
    ));

    expect(state.windowDays).toBeNull();
    expect(state.lastFullReconciledAt).toBeNull();
  });

  it('rolls back incremental rows and state together when checkpointing fails', async () => {
    await commitRadarSnapshot(snapshot([activity('old', 'owner/old', FIRST)], FIRST));
    const beforeRows = await db.radarActivities.toArray();
    const beforeState = await db.radarState.get('singleton');
    const statePut = vi.spyOn(db.radarState, 'put').mockRejectedValueOnce(new Error('checkpoint failed'));

    await expect(commitRadarRefresh(snapshot([
      activity('new', 'owner/new', SECOND),
    ], SECOND, 60, 'incremental'))).rejects.toThrow('checkpoint failed');

    statePut.mockRestore();
    expect(await db.radarActivities.toArray()).toEqual(beforeRows);
    expect(await db.radarState.get('singleton')).toEqual(beforeState);
  });
  it('retains omissions when a full result does not cover the selected window', async () => {
    await commitRadarSnapshot(snapshot([
      activity('keep', 'owner/keep', FIRST),
      activity('stale', 'owner/stale', FIRST),
    ], FIRST));

    const state = await commitRadarRefresh({
      ...snapshot([activity('keep', 'owner/keep', SECOND)], SECOND, 90, 'full'),
      lookbackDays: 7,
    });
    expect(await db.radarActivities.get('stale')).toBeDefined();
    expect(state.windowDays).toBe(60);
    expect(state.lastFullReconciledAt).toBe(FIRST);
  });

  it('fences credential changes until a complete full replacement', async () => {
    await commitRadarSnapshot(
      snapshot([activity('old', 'owner/old', FIRST)], FIRST),
      { credentialIdentity: 'credential-a' },
    );
    const beforeRows = await db.radarActivities.toArray();
    const beforeState = await db.radarState.get('singleton');

    await expect(commitRadarRefresh(
      snapshot([activity('incremental', 'owner/incremental', SECOND)], SECOND, 60, 'incremental'),
      { credentialIdentity: 'credential-b' },
    )).rejects.toThrow('Radar credential mismatch');
    expect(await db.radarActivities.toArray()).toEqual(beforeRows);
    expect(await db.radarState.get('singleton')).toEqual(beforeState);

    const committed = await commitRadarRefresh(
      snapshot([activity('new', 'owner/new', SECOND)], SECOND, 60, 'full'),
      { credentialIdentity: 'credential-b' },
    );
    expect(committed.credentialIdentity).toBe('credential-b');
    expect(await db.radarActivities.get('old')).toBeUndefined();
    expect(await db.radarActivities.get('new')).toBeDefined();
  });

  it('rejects account-mismatched rows and failures without replacing the bound state', async () => {
    await commitRadarSnapshot(snapshot([activity('existing', 'owner/existing', FIRST)], FIRST));
    const beforeRows = await db.radarActivities.toArray();
    const beforeState = await db.radarState.get('singleton');

    await expect(commitRadarRefresh(snapshot([
      activity('foreign', 'owner/foreign', SECOND, { accountLogin: 'other-account' }),
    ], SECOND))).rejects.toThrow('Radar activity account mismatch');
    await expect(recordRadarFailure('other-account', 'network_error'))
      .rejects.toThrow('Radar account mismatch');
    expect(await db.radarActivities.toArray()).toEqual(beforeRows);
    expect(await db.radarState.get('singleton')).toEqual(beforeState);
  });
  it('persists resumable full-sync steps and cleans stale rows only at an authoritative terminal step', async () => {
    const existing = activity('existing', 'owner/existing', FIRST, {
      seenAt: FIRST,
      dismissedAt: SECOND,
    });
    const stale = activity('stale', 'owner/stale', FIRST);
    await commitRadarSnapshot(
      snapshot([existing, stale], FIRST),
      { credentialIdentity: 'credential-a' },
    );

    const initial = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:storage',
      accountLogin: 'viewer',
      credentialIdentity: 'credential-a',
      windowDays: 60,
      startedAt: SECOND,
    });
    const started = await startRadarReconciliation(initial);
    expect(started.checkpoint).toEqual(initial);

    const activityCheckpoint: RadarReconciliationCheckpoint = {
      ...initial,
      revision: 1,
      updatedAt: THIRD,
      cursor: {
        phase: 'activity',
        followingCount: 1,
        actors: [{
          login: 'actor-existing',
          nextCursor: null,
          seenCursors: [],
          complete: false,
        }],
      },
      batchCount: 1,
    };
    const firstStep: RadarReconciliationSourceStep = {
      expectedReconciliationId: initial.reconciliationId,
      expectedRevision: initial.revision,
      checkpoint: activityCheckpoint,
      activities: [activity('existing', 'owner/existing', THIRD, {
        repositoryDescription: 'updated remote description',
        seenAt: null,
        dismissedAt: null,
      })],
      complete: false,
    };
    const firstCommit = await commitRadarReconciliationStep({
      accountLogin: 'viewer',
      credentialIdentity: 'credential-a',
      windowDays: 60,
      step: firstStep,
    });
    expect(firstCommit.applied).toBe(true);
    expect(await getRadarReconciliation('viewer')).toEqual(activityCheckpoint);
    expect(await db.radarActivities.get('stale')).toBeDefined();
    expect(await db.radarActivities.get('existing')).toMatchObject({
      repositoryDescription: 'updated remote description',
      seenAt: FIRST,
      dismissedAt: SECOND,
      reconciliationId: initial.reconciliationId,
    });

    const terminalCheckpoint: RadarReconciliationCheckpoint = {
      ...activityCheckpoint,
      revision: 2,
      updatedAt: '2026-08-10T13:00:00.000Z',
      cursor: {
        phase: 'activity',
        followingCount: 1,
        actors: [{
          login: 'actor-existing',
          nextCursor: null,
          seenCursors: [],
          complete: true,
        }],
      },
      scannedFollowingCount: 1,
    };
    const terminalStep: RadarReconciliationSourceStep = {
      expectedReconciliationId: initial.reconciliationId,
      expectedRevision: activityCheckpoint.revision,
      checkpoint: terminalCheckpoint,
      activities: [],
      complete: true,
    };
    await expect(commitRadarReconciliationStep({
      accountLogin: 'viewer',
      credentialIdentity: 'credential-a',
      windowDays: 60,
      step: {
        ...terminalStep,
        checkpoint: {
          ...terminalCheckpoint,
          cutoffAt: '2026-08-03T11:00:00.000Z',
        },
      },
    })).rejects.toThrow('Radar reconciliation checkpoint is invalid.');
    expect(await db.radarActivities.get('stale')).toBeDefined();

    const terminalCommit = await commitRadarReconciliationStep({
      accountLogin: 'viewer',
      credentialIdentity: 'credential-a',
      windowDays: 60,
      step: terminalStep,
    });

    expect(terminalCommit.applied).toBe(true);
    expect(await getRadarReconciliation('viewer')).toBeNull();
    expect(await db.radarActivities.get('stale')).toBeUndefined();
    expect(await db.radarActivities.get('existing')).toBeDefined();
    expect(terminalCommit.state).toMatchObject({
      activityCount: 1,
      lastFullReconciledAt: terminalCheckpoint.updatedAt,
      windowDays: 60,
    });
  });

  it('advances full provenance without sweeping when the epoch could not cover every account', async () => {
    const stale = activity('stale', 'owner/stale', FIRST);
    await commitRadarSnapshot(
      snapshot([stale], FIRST),
      { credentialIdentity: 'credential-a' },
    );

    const initial = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:capped',
      accountLogin: 'viewer',
      credentialIdentity: 'credential-a',
      windowDays: 60,
      startedAt: SECOND,
    });
    await startRadarReconciliation(initial);

    // The frozen actor set covers only part of the Following graph, so the
    // epoch proves what it fetched but cannot prove an unobserved row is gone.
    const terminal: RadarReconciliationCheckpoint = {
      ...initial,
      revision: 1,
      updatedAt: THIRD,
      cursor: {
        phase: 'activity',
        followingCount: 2,
        actors: [{
          login: 'actor-fresh',
          nextCursor: null,
          seenCursors: [],
          complete: true,
        }],
      },
      partialReasons: ['following_scan_truncated'],
      scannedFollowingCount: 1,
      batchCount: 1,
    };
    const commit = await commitRadarReconciliationStep({
      accountLogin: 'viewer',
      credentialIdentity: 'credential-a',
      windowDays: 60,
      step: {
        expectedReconciliationId: initial.reconciliationId,
        expectedRevision: initial.revision,
        checkpoint: terminal,
        activities: [activity('fresh', 'owner/fresh', THIRD)],
        complete: true,
      },
    });

    expect(commit.applied).toBe(true);
    expect(await getRadarReconciliation('viewer')).toBeNull();
    expect(await db.radarActivities.get('stale')).toBeDefined();
    expect(commit.state).toMatchObject({
      lastFullReconciledAt: THIRD,
      windowDays: 60,
      partialReasons: ['following_scan_truncated'],
    });
  });

  it('accepts monotonic multi-page cursor advances and rejects rewritten history', async () => {
    const initial = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:cursors',
      accountLogin: 'viewer',
      credentialIdentity: 'credential-a',
      windowDays: 60,
      startedAt: SECOND,
    });
    await startRadarReconciliation(initial);
    const commit = (
      checkpoint: RadarReconciliationCheckpoint,
      expectedRevision: number,
    ) => commitRadarReconciliationStep({
      accountLogin: 'viewer',
      credentialIdentity: 'credential-a',
      windowDays: 60,
      step: {
        expectedReconciliationId: initial.reconciliationId,
        expectedRevision,
        checkpoint,
        activities: [],
        complete: false,
      },
    });

    // One step pages GitHub several times inside its request budget, so a
    // multi-page advance is the normal shape rather than a corruption signal.
    const followingPages: RadarReconciliationCheckpoint = {
      ...initial,
      revision: 1,
      updatedAt: THIRD,
      cursor: {
        phase: 'following',
        nextCursor: 'following-3',
        seenCursors: ['following-1', 'following-2', 'following-3'],
        logins: ['alice'],
        totalCount: 1,
      },
    };
    expect((await commit(followingPages, 0)).applied).toBe(true);
    const followingRewrite: RadarReconciliationCheckpoint = {
      ...followingPages,
      revision: 2,
      updatedAt: '2026-08-10T13:00:00.000Z',
      cursor: {
        phase: 'following',
        nextCursor: 'following-9',
        seenCursors: ['following-2', 'following-9'],
        logins: ['alice'],
        totalCount: 1,
      },
    };
    expect((await commit(followingRewrite, 1)).applied).toBe(false);
    expect(await getRadarReconciliation('viewer')).toEqual(followingPages);

    // The live Following size changes while a long scan runs, so a drifting
    // totalCount must not deadlock the epoch on a permanently rejected step.
    const followingDrift: RadarReconciliationCheckpoint = {
      ...followingPages,
      revision: 2,
      updatedAt: '2026-08-10T13:00:00.000Z',
      cursor: {
        phase: 'following',
        nextCursor: 'following-4',
        seenCursors: ['following-1', 'following-2', 'following-3', 'following-4'],
        logins: ['alice', 'bob'],
        totalCount: 2,
      },
    };
    const drifted = await commit(followingDrift, 1);
    expect(drifted.applied).toBe(true);
    expect(drifted.checkpoint?.cursor).toMatchObject({ totalCount: 2 });

    const activityStart: RadarReconciliationCheckpoint = {
      ...followingDrift,
      revision: 3,
      updatedAt: '2026-08-10T14:00:00.000Z',
      cursor: {
        phase: 'activity',
        followingCount: 2,
        actors: [
          { login: 'alice', nextCursor: null, seenCursors: [], complete: false },
          { login: 'bob', nextCursor: null, seenCursors: [], complete: false },
        ],
      },
    };
    expect((await commit(activityStart, 2)).applied).toBe(true);
    const actorPages: RadarReconciliationCheckpoint = {
      ...activityStart,
      revision: 4,
      updatedAt: '2026-08-10T15:00:00.000Z',
      batchCount: 2,
      cursor: {
        phase: 'activity',
        followingCount: 2,
        actors: [
          {
            login: 'alice',
            nextCursor: 'actor-3',
            seenCursors: ['actor-1', 'actor-2', 'actor-3'],
            complete: false,
          },
          { login: 'bob', nextCursor: null, seenCursors: [], complete: true },
        ],
      },
    };
    expect((await commit(actorPages, 3)).applied).toBe(true);
    const actorRewrite: RadarReconciliationCheckpoint = {
      ...actorPages,
      revision: 5,
      updatedAt: '2026-08-10T16:00:00.000Z',
      batchCount: 3,
      cursor: {
        phase: 'activity',
        followingCount: 2,
        actors: [
          {
            login: 'alice',
            nextCursor: 'actor-7',
            seenCursors: ['actor-2', 'actor-7'],
            complete: false,
          },
          { login: 'bob', nextCursor: null, seenCursors: [], complete: true },
        ],
      },
    };
    expect((await commit(actorRewrite, 4)).applied).toBe(false);
    expect(await getRadarReconciliation('viewer')).toEqual(actorPages);
  });

});
