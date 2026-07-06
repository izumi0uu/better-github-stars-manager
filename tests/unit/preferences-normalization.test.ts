import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  DEFAULT_AUTO_TAG_LIMIT,
  DEFAULT_LIBRARY_VIEW_PREFS,
  DEFAULT_MIN_TOPIC_REPO_COUNT,
  normalizeLibraryViewPrefs,
  normalizeMaxTagsPerRepo,
  normalizeMinTopicRepoCount,
} from '../../src/preferences';

describe('preference normalization', () => {
  it('normalizes split auto-tag policy fields', () => {
    assert.equal(normalizeMaxTagsPerRepo('7'), 7);
    assert.equal(normalizeMaxTagsPerRepo(undefined, 8), 8);
    assert.equal(normalizeMaxTagsPerRepo('0'), 1);
    assert.equal(normalizeMaxTagsPerRepo('100'), 50);
    assert.equal(normalizeMaxTagsPerRepo('nope'), DEFAULT_AUTO_TAG_LIMIT);

    assert.equal(normalizeMinTopicRepoCount(undefined), DEFAULT_MIN_TOPIC_REPO_COUNT);
    assert.equal(normalizeMinTopicRepoCount('3'), 3);
    assert.equal(normalizeMinTopicRepoCount('2.9'), 2);
    assert.equal(normalizeMinTopicRepoCount('-1'), 1);
    assert.equal(normalizeMinTopicRepoCount('99'), 50);
  });

  it('normalizes libraryView v1 and strips non-owned fields', () => {
    const prefs = normalizeLibraryViewPrefs({
      version: 99,
      filters: {
        languages: ['TypeScript', 'TypeScript', '', 42],
        tags: ['react', 'missing-tag', 'react'],
        tagMode: 'all',
        showTombstone: true,
        onlyFavorite: true,
        onlyUntagged: true,
        onlyArchived: true,
        query: 'do-not-persist',
      },
      sort: {
        sortKey: 'created_at',
        sortDir: 'asc',
        tagSortDir: 'desc',
      },
      columnLayoutMode: 'custom',
    });

    assert.deepEqual(prefs, {
      version: 1,
      filters: {
        languages: ['TypeScript'],
        tags: ['react', 'missing-tag'],
        tagMode: 'all',
        showTombstone: true,
        onlyFavorite: true,
        onlyUntagged: true,
        onlyArchived: true,
      },
      sort: {
        sortKey: 'created_at',
        sortDir: 'asc',
      },
    });
  });

  it('falls back safely for invalid libraryView values', () => {
    const prefs = normalizeLibraryViewPrefs({
      filters: {
        languages: 'TypeScript',
        tags: null,
        tagMode: 'bad',
      },
      sort: {
        sortKey: 'bad',
        sortDir: 'sideways',
      },
    });

    assert.deepEqual(prefs, DEFAULT_LIBRARY_VIEW_PREFS);
  });
});
