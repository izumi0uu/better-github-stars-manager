import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidateCache, queryStars } from '@/background/query';
import {
  projectMatchingStars,
  projectStarsQuery,
  type StarsQueryParams,
} from '@/stars/stars-query';
import { projectRadarActivities } from '@/radar/radar-projector';
import {
  normalizeRadarActivity,
  type RadarActivityRecord,
} from '@/radar/radar-model';
import { projectRecommendations } from '@/recommendations/recommendation-projector';
import type {
  RecommendationIgnoreRecord,
  RecommendationRecord,
} from '@/recommendations/recommendation-model';
import { listRadarActivities } from '@/storage/radar-store';
import { listRecommendations } from '@/storage/recommendation-store';
import { db } from '@/storage/db';
import { visibleTagNames } from '@/tags/tag-model';
import type { Star, Tag, TagMeta } from '@/types';

const NOW = '2026-08-16T12:00:00.000Z';
const RECENT = '2026-08-15T12:00:00.000Z';
const OLDER = '2026-08-10T12:00:00.000Z';
const EXPIRED = '2026-07-01T12:00:00.000Z';

const DEFAULT_FILTER: StarsQueryParams['filter'] = {
  query: '',
  languages: [],
  tags: [],
  tagMode: 'any',
  showTombstone: false,
  onlyFavorite: false,
  onlyUntagged: false,
  onlyArchived: false,
  onlyOwned: false,
  sortKey: 'name',
  sortDir: 'asc',
};

function star(fullName: string, overrides: Partial<Star> = {}): Star {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: `${fullName} description`,
    language: 'TypeScript',
    stargazers_count: 100,
    topics: [],
    pushed_at: RECENT,
    created_at: OLDER,
    fork: false,
    archived: false,
    starred_at: RECENT,
    tombstone: false,
    synced_at: NOW,
    ...overrides,
  };
}

function tag(fullName: string, overrides: Partial<Tag> = {}): Tag {
  return {
    full_name: fullName,
    manualTags: [],
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: NOW,
    autoTagsMtime: NOW,
    dismissedAutoTagsMtime: NOW,
    notes: '',
    favorite: false,
    mtime: NOW,
    ...overrides,
  };
}

function radarActivity(
  id: string,
  repositoryFullName: string,
  starredAt: string,
  overrides: Partial<RadarActivityRecord> = {},
): RadarActivityRecord {
  const activity = normalizeRadarActivity({
    actorLogin: `actor-${id}`,
    actorAvatarUrl: null,
    repositoryFullName,
    repositoryDescription: 'remote description',
    repositoryLanguage: 'Rust',
    repositoryLanguageColor: '#dea584',
    repositoryStargazerCount: 7,
    repositoryTopics: ['remote-topic', 'blocked-topic'],
    viewerHadStarred: false,
    starredAt,
  }, { accountLogin: 'viewer' });
  return { ...activity, id, ...overrides };
}

function recommendation(
  repositoryKey: string,
  score: number,
  stargazerCount: number,
): RecommendationRecord {
  const [owner = '', name = ''] = repositoryKey.split('/');
  return {
    id: repositoryKey,
    accountLogin: 'viewer',
    repositoryKey,
    repositoryFullName: repositoryKey,
    repositoryHtmlUrl: `https://github.com/${repositoryKey}`,
    description: `${repositoryKey} description`,
    language: 'TypeScript',
    stargazerCount,
    topics: ['developer-tools'],
    owner,
    name,
    pushedAt: RECENT,
    createdAt: OLDER,
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

beforeEach(async () => {
  await db.delete();
  await db.open();
  invalidateCache();
});

afterAll(() => {
  db.close();
});

describe('storage-neutral projector parity', () => {
  it('keeps Stars filters, facets, excluded tags, and null-date ordering identical', async () => {
    const stars = [
      star('alpha/null-date', { created_at: null, pushed_at: null }),
      star('beta/recent', { created_at: RECENT }),
      star('delta/older', { created_at: OLDER }),
      star('rust/project', { language: 'Rust' }),
    ];
    const tags = [
      tag('alpha/null-date', {
        manualTags: ['Keep', 'Deleted'],
        autoTags: ['Automatic'],
        notes: 'searchable note',
      }),
      tag('beta/recent', { manualTags: ['Keep'] }),
      tag('delta/older', { manualTags: ['Keep'] }),
    ];
    const tagMeta: TagMeta[] = [
      { name: 'Deleted', dimension: null, color: null, excluded: true, mtime: NOW },
      { name: 'Keep', dimension: null, color: null, excluded: false, mtime: NOW },
    ];
    await Promise.all([
      db.stars.bulkPut(stars),
      db.tags.bulkPut(tags),
      db.tagMeta.bulkPut(tagMeta),
    ]);
    invalidateCache();

    const params: StarsQueryParams = {
      filter: {
        ...DEFAULT_FILTER,
        languages: ['TypeScript'],
        tags: ['keep'],
        sortKey: 'created_at',
        sortDir: 'asc',
      },
      offset: 0,
      limit: 20,
    };
    const source = {
      stars: await db.stars.toArray(),
      tags: await db.tags.toArray(),
      tagMeta: await db.tagMeta.toArray(),
    };
    const projected = projectStarsQuery(source, params);
    const stored = await queryStars(params);

    expect(stored).toEqual(projected);
    expect(stored.rows.map((row) => row.full_name)).toEqual([
      'delta/older',
      'beta/recent',
      'alpha/null-date',
    ]);
    expect(stored).toMatchObject({ total: 3, grandTotal: 4, tagTotal: 2 });
    expect(stored.languages).toEqual([['TypeScript', 3], ['Rust', 1]]);
    expect(stored.tagTree).toEqual([
      { name: 'Keep', count: 3 },
      { name: 'Automatic', count: 1 },
    ]);
    expect(visibleTagNames(stored.tagsForRows['alpha/null-date'])).toEqual([
      'Keep',
      'Automatic',
    ]);

    const descending = projectMatchingStars(source, {
      ...params.filter,
      sortDir: 'desc',
    });
    expect(descending.map((row) => row.full_name)).toEqual([
      'beta/recent',
      'delta/older',
      'alpha/null-date',
    ]);
  });

  it('keeps own and following Radar rows identical to the canonical projection', async () => {
    const recentOwnStar = star('owner/own', {
      starred_at: RECENT,
      topics: ['own-topic', 'blocked-topic'],
      stargazers_count: 55,
    });
    const followedStar = star('Owner/Followed', {
      starred_at: EXPIRED,
      topics: ['local-topic', 'blocked-topic'],
      stargazers_count: 321,
    });
    const activities = [
      radarActivity('followed', 'Owner/Followed', NOW),
      radarActivity('dismissed', 'owner/dismissed', NOW, { dismissedAt: NOW }),
    ];
    await Promise.all([
      db.stars.bulkPut([recentOwnStar, followedStar]),
      db.tags.bulkPut([
        tag('owner/own', { manualTags: ['mine'], favorite: true }),
        tag('owner/followed', { manualTags: ['following'], favorite: true }),
      ]),
      db.tagMeta.put({
        name: 'BLOCKED-TOPIC',
        dimension: null,
        color: null,
        excluded: true,
        mtime: NOW,
      }),
      db.radarActivities.bulkPut(activities),
    ]);

    const source = {
      accountLogin: ' VIEWER ',
      nowMillis: Date.parse(NOW),
      activities: await db.radarActivities.where('accountLogin').equals('viewer').toArray(),
      stars: await db.stars.toArray(),
      tags: await db.tags.toArray(),
      tagMeta: await db.tagMeta.toArray(),
    };
    const projected = projectRadarActivities(source);
    const stored = await listRadarActivities(' VIEWER ', Date.parse(NOW));

    expect(stored).toEqual(projected);
    expect(stored.map((row) => [row.source, row.repositoryKey])).toEqual([
      ['following', 'owner/followed'],
      ['self', 'owner/own'],
    ]);
    expect(stored[0]).toMatchObject({
      viewerHasStarred: true,
      favorite: true,
      tags: ['following'],
      repositoryTopics: ['blocked-topic', 'local-topic'],
      suggestedTags: ['local-topic'],
      displayedStargazerCount: 321,
    });
    expect(stored[1]).toMatchObject({
      actorLogin: 'viewer',
      seen: true,
      viewerHasStarred: true,
      favorite: true,
      tags: ['mine'],
      suggestedTags: ['own-topic'],
    });
  });

  it('keeps ignores, live-star exclusion, tombstones, and deterministic recommendation ranking identical', async () => {
    const recommendations = [
      recommendation('live/repo', 100, 1_000),
      recommendation('ignored/repo', 90, 900),
      recommendation('z/repo', 10, 100),
      recommendation('a/repo', 10, 100),
      recommendation('popular/repo', 10, 200),
      recommendation('tombstone/repo', 8, 80),
      recommendation('unstarred/repo', 7, 70),
    ];
    const ignores: RecommendationIgnoreRecord[] = [{
      id: 'viewer:ignored/repo',
      accountLogin: 'viewer',
      repositoryKey: 'ignored/repo',
      repositoryFullName: 'Ignored/Repo',
      ignoredAt: NOW,
    }];
    await Promise.all([
      db.recommendations.bulkPut(recommendations),
      db.recommendationIgnores.bulkPut(ignores),
      db.stars.bulkPut([
        star('Live/Repo'),
        star('Tombstone/Repo', { tombstone: true }),
        star('Unstarred/Repo', { viewer_has_starred: false }),
      ]),
    ]);

    const source = {
      accountLogin: ' VIEWER ',
      recommendations: await db.recommendations.where('accountLogin').equals('viewer').toArray(),
      stars: await db.stars.toArray(),
      ignores: await db.recommendationIgnores.where('accountLogin').equals('viewer').toArray(),
    };
    const projected = projectRecommendations(source);
    const stored = await listRecommendations(' VIEWER ');

    expect(stored).toEqual(projected);
    expect(stored.map((row) => row.repositoryKey)).toEqual([
      'popular/repo',
      'a/repo',
      'z/repo',
      'tombstone/repo',
      'unstarred/repo',
    ]);
  });
});
