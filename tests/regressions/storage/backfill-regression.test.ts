import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { db } from '../../../src/storage/db';
import { reconcileBackfillMap } from '../../../src/upgrades/tasks';
import { selectActiveBackfillId } from '../../../src/upgrades/backfill-state';
import type { Star } from '../../../src/types';

const base = {
  html_url: 'https://github.com/x',
  description: '',
  language: null as string | null,
  stargazers_count: 0,
  topics: [] as string[],
  pushed_at: '2026-06-20T00:00:00Z',
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
  it('marks release backfill pending when legacy live rows are missing sync metadata', async () => {
    await db.stars.put({
      ...base,
      full_name: 'legacy/repo',
      starred_at: '2026-06-20T00:00:00Z',
      latest_release_at: undefined,
      latest_release_synced_at: undefined,
    } as unknown as Star);

    const next = await reconcileBackfillMap({});
    assert.equal(next.release_metadata_v1?.status, 'pending');
    assert.equal(selectActiveBackfillId(next), 'release_metadata_v1');
  });

  it('keeps release backfill done after later rows arrive without release metadata', async () => {
    await db.stars.put({
      ...base,
      full_name: 'new/repo',
      starred_at: '2026-06-21T00:00:00Z',
      latest_release_at: null,
      latest_release_synced_at: null,
    } as Star);

    const next = await reconcileBackfillMap({
      release_metadata_v1: {
        status: 'done',
        queuedAt: '2026-06-22T00:00:00Z',
        lastAttemptAt: '2026-06-22T00:00:00Z',
        completedAt: '2026-06-22T00:05:00Z',
        error: null,
      },
    });
    assert.equal(next.release_metadata_v1?.status, 'done');
    assert.equal(selectActiveBackfillId(next), null);
  });

  it('does not surface deferred backfills as active cards', async () => {
    const active = selectActiveBackfillId({
      release_metadata_v1: {
        status: 'deferred',
        queuedAt: '2026-06-22T00:00:00Z',
        lastAttemptAt: null,
        completedAt: null,
        error: null,
      },
    });
    assert.equal(active, null);
  });
});
