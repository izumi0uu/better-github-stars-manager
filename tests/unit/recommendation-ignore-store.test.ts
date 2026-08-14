import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import type {
  RecommendationRecord,
  RecommendationSourceSnapshot,
} from '@/recommendations/recommendation-model';
import {
  commitRecommendationSnapshot,
  ignoreRecommendation,
  listIgnoredRepositories,
  listRecommendations,
  restoreIgnoredRecommendation,
} from '@/storage/recommendation-store';
import { db } from '@/storage/db';

const NOW = '2026-08-10T12:00:00.000Z';

function record(repositoryKey: string, score: number): RecommendationRecord {
  const [owner, name] = repositoryKey.split('/');
  return {
    id: repositoryKey,
    accountLogin: 'viewer',
    repositoryKey,
    repositoryFullName: repositoryKey,
    repositoryHtmlUrl: `https://github.com/${repositoryKey}`,
    description: 'description',
    language: 'TypeScript',
    stargazerCount: 100,
    topics: [],
    owner: owner ?? 'owner',
    name: name ?? 'repo',
    pushedAt: null,
    createdAt: null,
    fork: false,
    archived: false,
    score,
    reason: {
      kind: 'topic',
      value: 'developer-tools',
      seedRepositoryKey: 'seed/repo',
      seedRepositoryFullName: 'Seed/Repo',
    },
    fetchedAt: NOW,
  };
}

function snapshot(
  accountLogin: string,
  rows: RecommendationRecord[],
  overrides: Partial<RecommendationSourceSnapshot> = {},
) {
  return { ...snapshotBase(accountLogin, rows), ...overrides };
}

function snapshotBase(accountLogin: string, rows: RecommendationRecord[]): RecommendationSourceSnapshot {
  return {
    accountLogin,
    recommendations: rows,
    fetchedAt: NOW,
    seedCount: 1,
    queryCount: 1,
    rateLimitRemaining: 8,
    rateLimitResetAt: null,
  };
}

describe('For You ignore persistence', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(() => {
    db.close();
  });

  it('keeps an ignored repository out of queries and later snapshots', async () => {
    await commitRecommendationSnapshot(snapshot('viewer', [
      record('one/repo', 3),
      record('two/repo', 2),
    ]));
    await ignoreRecommendation('viewer', 'one/repo');
    assert.deepEqual(
      (await listRecommendations('viewer')).map((item) => item.repositoryKey),
      ['two/repo'],
    );

    await commitRecommendationSnapshot(snapshot('viewer', [
      record('one/repo', 9),
      record('two/repo', 2),
      record('three/repo', 1),
    ]));
    assert.deepEqual(
      (await listRecommendations('viewer')).map((item) => item.repositoryKey),
      ['two/repo', 'three/repo'],
    );
  });

  it('persists a future reset after a successful exhausted Search snapshot', async () => {
    const resetAt = '2099-08-10T12:15:00.000Z';
    const state = await commitRecommendationSnapshot(snapshot('viewer', [record('one/repo', 3)], {
      rateLimitRemaining: 0,
      rateLimitResetAt: resetAt,
    }));

    assert.equal(state.errorCode, null);
    assert.equal(state.nextAllowedAt, resetAt);
    assert.equal(state.rateLimitRemaining, 0);
  });

  it('normalizes the repository key and rejects malformed identities', async () => {
    await ignoreRecommendation('viewer', 'One/Repo');
    assert.equal((await listRecommendations('viewer')).length, 0);
    await assert.rejects(() => ignoreRecommendation('viewer', 'not-a-repo'));
  });

  it('scopes ignores per account', async () => {
    await ignoreRecommendation('viewer', 'one/repo');
    await commitRecommendationSnapshot(snapshot('other', [record('one/repo', 3)]));
    assert.equal((await listRecommendations('other')).length, 1);
    assert.equal((await listRecommendations('viewer')).length, 0);
  });

  it('lists ignored repositories newest first with their display names', async () => {
    await db.recommendationIgnores.bulkPut([
      {
        id: 'viewer:one/repo',
        accountLogin: 'viewer',
        repositoryKey: 'one/repo',
        repositoryFullName: 'One/Repo',
        ignoredAt: '2026-08-10T10:00:00.000Z',
      },
      {
        id: 'viewer:two/repo',
        accountLogin: 'viewer',
        repositoryKey: 'two/repo',
        repositoryFullName: 'Two/Repo',
        ignoredAt: '2026-08-10T11:00:00.000Z',
      },
    ]);
    const rows = await listIgnoredRepositories('viewer');
    assert.deepEqual(rows.map((row) => row.repositoryKey), ['two/repo', 'one/repo']);
    assert.deepEqual(rows.map((row) => row.repositoryFullName), ['Two/Repo', 'One/Repo']);
  });

  it('keeps the display name passed at ignore time', async () => {
    await ignoreRecommendation('viewer', 'one/repo', 'One/Repo');
    await ignoreRecommendation('viewer', 'two/repo');
    const rows = await listIgnoredRepositories('viewer');
    assert.ok(rows.some((row) => row.repositoryKey === 'one/repo' && row.repositoryFullName === 'One/Repo'));
    assert.ok(rows.some((row) => row.repositoryKey === 'two/repo' && row.repositoryFullName === 'two/repo'));
  });

  it('restores an ignored repository so future snapshots can include it again', async () => {
    await ignoreRecommendation('viewer', 'one/repo');
    await restoreIgnoredRecommendation('viewer', 'One/Repo');
    assert.equal((await listIgnoredRepositories('viewer')).length, 0);
    await commitRecommendationSnapshot(snapshot('viewer', [record('one/repo', 3)]));
    assert.deepEqual(
      (await listRecommendations('viewer')).map((item) => item.repositoryKey),
      ['one/repo'],
    );
  });
});
