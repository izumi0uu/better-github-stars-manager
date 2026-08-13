import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { db } from '../../../src/storage/db';
import { backfillTasks, reconcileBackfillMap } from '../../../src/upgrades/tasks';
import { selectActiveBackfillId } from '../../../src/upgrades/backfill-state';
import type { Star } from '../../../src/types';

const base = {
  html_url: 'https://github.com/x',
  description: '',
  language: null as string | null,
  stargazers_count: 0,
  topics: [] as string[],
  pushed_at: '2026-06-20T00:00:00Z',
  created_at: null as string | null,
  fork: false,
  archived: false,
  tombstone: false,
  synced_at: '2026-06-20T00:00:00Z',
};

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterAll(async () => {
  await db.close();
});

describe('Backfill regressions', () => {
  it('prioritizes repo data sync when a legacy live row lacks creation time', async () => {
    await db.stars.put({
      ...base,
      full_name: 'legacy/repo',
      starred_at: '2026-06-20T00:00:00Z',
      created_at: undefined,
    } as unknown as Star);

    const next = await reconcileBackfillMap({});
    assert.equal(next.repo_data_sync_v1?.status, 'pending');
    assert.equal(next.repo_owner_avatar_v1?.status, 'pending');
    assert.equal(selectActiveBackfillId(next), 'repo_data_sync_v1');
  });

  it('marks owner-avatar backfill pending when live rows are missing owner avatars', async () => {
    await db.stars.put({
      ...base,
      full_name: 'legacy/avatar-missing',
      starred_at: '2026-06-20T00:00:00Z',
      created_at: '2020-01-01T00:00:00Z',
    } as Star);

    const next = await reconcileBackfillMap({});
    assert.equal(next.repo_data_sync_v1?.status, 'done');
    assert.equal(next.repo_owner_avatar_v1?.status, 'pending');
    assert.equal(selectActiveBackfillId(next), 'repo_owner_avatar_v1');
  });

  it('marks both repo metadata backfills done when live rows are complete', async () => {
    await db.stars.put({
      ...base,
      full_name: 'complete/repo',
      starred_at: '2026-06-20T00:00:00Z',
      created_at: '2020-01-01T00:00:00Z',
      owner_avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    } as Star);

    const next = await reconcileBackfillMap({});
    assert.equal(next.repo_data_sync_v1?.status, 'done');
    assert.equal(next.repo_owner_avatar_v1?.status, 'done');
    assert.equal(selectActiveBackfillId(next), null);
  });

  it('keeps repo data sync backfill done after later rows arrive without creation metadata', async () => {
    await db.stars.put({
      ...base,
      full_name: 'new/repo',
      starred_at: '2026-06-21T00:00:00Z',
      created_at: null,
    } as Star);

    const existing = {
      status: 'done' as const,
      queuedAt: '2026-06-22T00:00:00Z',
      lastAttemptAt: '2026-06-22T00:01:00Z',
      completedAt: '2026-06-22T00:05:00Z',
      error: null,
    };
    const next = await reconcileBackfillMap({
      repo_data_sync_v1: existing,
      repo_owner_avatar_v1: existing,
    });

    assert.deepEqual(next.repo_data_sync_v1, existing);
    assert.deepEqual(next.repo_owner_avatar_v1, existing);
    assert.equal(selectActiveBackfillId(next), null);
  });

  it('surfaces the owner-avatar backfill even when the shipped repo-data backfill is done', async () => {
    await db.stars.put({
      ...base,
      full_name: 'legacy/avatar-after-repo-data',
      starred_at: '2026-06-21T00:00:00Z',
      created_at: '2020-01-01T00:00:00Z',
    } as Star);

    const repoDataState = {
      status: 'done' as const,
      queuedAt: '2026-06-22T00:00:00Z',
      lastAttemptAt: '2026-06-22T00:01:00Z',
      completedAt: '2026-06-22T00:05:00Z',
      error: null,
    };
    const next = await reconcileBackfillMap({ repo_data_sync_v1: repoDataState });

    assert.deepEqual(next.repo_data_sync_v1, repoDataState);
    assert.equal(next.repo_owner_avatar_v1?.status, 'pending');
    assert.equal(selectActiveBackfillId(next), 'repo_owner_avatar_v1');
  });

  it('does not scan local data when an existing backfill is already done', async () => {
    const originalDetectNeed = backfillTasks.repo_data_sync_v1.detectNeed;
    let detectCalls = 0;
    backfillTasks.repo_data_sync_v1.detectNeed = async () => {
      detectCalls++;
      throw new Error('done backfills should not detect need');
    };
    try {
      const next = await reconcileBackfillMap({
        repo_data_sync_v1: {
          status: 'done',
          queuedAt: '2026-06-22T00:00:00Z',
          lastAttemptAt: '2026-06-22T00:00:00Z',
          completedAt: '2026-06-22T00:05:00Z',
          error: null,
        },
        repo_owner_avatar_v1: {
          status: 'done',
          queuedAt: '2026-08-13T00:00:00Z',
          lastAttemptAt: '2026-08-13T00:00:00Z',
          completedAt: '2026-08-13T00:05:00Z',
          error: null,
        },
      });
      assert.equal(next.repo_data_sync_v1?.status, 'done');
      assert.equal(detectCalls, 0);
    } finally {
      backfillTasks.repo_data_sync_v1.detectNeed = originalDetectNeed;
    }
  });

  it('keeps failed repo data sync backfills active and preserves retry evidence', async () => {
    await db.stars.put({
      ...base,
      full_name: 'failed/repo',
      starred_at: '2026-06-23T00:00:00Z',
      created_at: undefined,
    } as unknown as Star);

    const existing = {
      status: 'failed' as const,
      queuedAt: '2026-06-22T00:00:00Z',
      lastAttemptAt: '2026-06-22T00:04:00Z',
      completedAt: null,
      error: 'GitHub metadata refresh failed',
    };
    const next = await reconcileBackfillMap({
      repo_data_sync_v1: existing,
      repo_owner_avatar_v1: {
        status: 'done',
        queuedAt: '2026-08-13T00:00:00Z',
        lastAttemptAt: '2026-08-13T00:00:00Z',
        completedAt: '2026-08-13T00:05:00Z',
        error: null,
      },
    });

    assert.deepEqual(next.repo_data_sync_v1, existing);
    assert.equal(selectActiveBackfillId(next), 'repo_data_sync_v1');
  });

  it('keeps deferred repo data sync backfills inactive and preserves deferral evidence', async () => {
    await db.stars.put({
      ...base,
      full_name: 'deferred/repo',
      starred_at: '2026-06-24T00:00:00Z',
      created_at: null,
    } as Star);

    const existing = {
      status: 'deferred' as const,
      queuedAt: '2026-06-22T00:00:00Z',
      lastAttemptAt: '2026-06-22T00:03:00Z',
      completedAt: null,
      error: 'User postponed after previous failure',
    };
    const next = await reconcileBackfillMap({
      repo_data_sync_v1: existing,
      repo_owner_avatar_v1: {
        status: 'done',
        queuedAt: '2026-08-13T00:00:00Z',
        lastAttemptAt: '2026-08-13T00:00:00Z',
        completedAt: '2026-08-13T00:05:00Z',
        error: null,
      },
    });

    assert.deepEqual(next.repo_data_sync_v1, existing);
    assert.equal(selectActiveBackfillId(next), null);
  });

  it('does not surface deferred backfills as active cards', async () => {
    const active = selectActiveBackfillId({
      repo_data_sync_v1: {
        status: 'done',
        queuedAt: '2026-06-22T00:00:00Z',
        lastAttemptAt: '2026-06-22T00:00:00Z',
        completedAt: '2026-06-22T00:05:00Z',
        error: null,
      },
      repo_owner_avatar_v1: {
        status: 'deferred',
        queuedAt: '2026-08-13T00:00:00Z',
        lastAttemptAt: null,
        completedAt: null,
        error: null,
      },
    });
    assert.equal(active, null);
  });
});
