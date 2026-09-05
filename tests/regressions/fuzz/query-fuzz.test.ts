import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { queryStars } from '@/background/query';
import {
  compareNullableDate,
  type StarsQueryParams,
  type StarsQueryResult,
} from '@/stars/stars-query';
import { db } from '@/storage/db';
import { visibleTagNames } from '@/tags/tag-model';
import { normalizeStoredTag, type LegacyTagRow } from '@/storage/tag-shape';
import type { Star, Tag, TagMeta } from '@/types';
import type { SortKey } from '@/ui/filter-store';
import { createRng, fuzzCases, fuzzFailure, type SeededRng } from '../../helpers/seeded-fuzz';

const FILE = 'tests/regressions/fuzz/query-fuzz.test.ts';
const PREFIX = 'QUERY_FUZZ';
const SUITE = 'query fuzz';
const CASES = fuzzCases(PREFIX, '20260705-query', 200);

const languages = ['TypeScript', 'Rust', 'Go', 'Python', 'Ruby'];
const words = ['agent', 'vector', 'sync', 'render', 'index', 'worker', 'cache', 'query'];
const tagNames = ['ai', 'ui', 'infra', 'database', 'testing', 'sync', 'archived', 'tooling'];
const sortKeys: SortKey[] = ['starred_at', 'pushed_at', 'created_at', 'stargazers_count', 'name'];

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterAll(async () => {
  await db.close();
});

describe('query seeded fuzz', () => {
  for (const caseIndex of CASES.cases) {
    it(`matches the reference query model for case ${caseIndex}`, async () => {
      const rng = createRng(CASES.seed, caseIndex);
      const generated = generateQueryCase(rng);
      await db.stars.bulkPut(generated.stars);
      await db.tags.bulkPut(generated.tags);
      await db.tagMeta.bulkPut(generated.tagMeta);

      const actual = await queryStars(generated.params);
      const expected = referenceQuery(generated);

      assertQueryEqual(actual, expected, {
        caseIndex,
        trace: summarizeCase(generated),
      });
    });
  }

  it('observes committed DB mutations without an explicit cache reset', async () => {
    const rng = createRng(CASES.seed, CASES.singleCase ?? 0);
    const generated = generateQueryCase(rng, { forceStars: 3 });
    await db.stars.bulkPut(generated.stars);
    await db.tags.bulkPut(generated.tags);
    await db.tagMeta.bulkPut(generated.tagMeta);

    await queryStars(generated.params);
    const injected = makeStar('cache/injected', 999, rng, { language: 'TypeScript' });
    await db.stars.put(injected);

    const refreshed = await queryStars(generated.params);
    assert.equal(
      refreshed.grandTotal,
      generated.stars.length + 1,
      fuzzFailure({
        suite: SUITE,
        prefix: PREFIX,
        seed: CASES.seed,
        caseIndex: CASES.singleCase ?? 0,
        file: FILE,
        invariant: 'query observes committed direct DB mutation',
        expected: generated.stars.length + 1,
        actual: refreshed.grandTotal,
      }),
    );
  });
});

interface GeneratedQueryCase {
  stars: Star[];
  tags: Tag[];
  tagMeta: TagMeta[];
  params: StarsQueryParams;
}

function generateQueryCase(rng: SeededRng, options: { forceStars?: number } = {}): GeneratedQueryCase {
  const starCount = options.forceStars ?? rng.int(0, 80);
  const stars = Array.from({ length: starCount }, (_value, index) => makeStar(`owner${index % 7}/repo${index}`, index, rng));
  const fullNames = stars.map((star) => star.full_name);
  const tags = fullNames.flatMap((fullName, index) => {
    if (rng.bool(0.18)) return [];
    const selected = rng.subset(tagNames, rng.int(0, 4));
    return [makeTag(fullName, selected, index, rng)];
  });
  if (rng.bool(0.35)) {
    tags.push(makeTag(`missing/repo${rng.int(0, 100)}`, rng.subset(tagNames, 3), 999, rng));
  }
  const tagMeta = tagNames
    .filter(() => rng.bool(0.75))
    .map((name, index) => ({
      name,
      dimension: rng.maybe(rng.pick(['topic', 'stack', 'workflow']), 0.7),
      color: rng.maybe(`#${rng.int(0, 0xffffff).toString(16).padStart(6, '0')}`, 0.5),
      mtime: iso(index + 400),
      excluded: rng.bool(0.2) ? true : undefined,
    } satisfies TagMeta));
  const queryTerm = rng.pick([
    '',
    '',
    'repo',
    'rpo',
    'owner1/repo',
    'agent',
    'sync',
    'note',
    'cache',
    rng.pick(words),
  ]);
  const params: StarsQueryParams = {
    filter: {
      query: rng.bool(0.2) ? `  ${queryTerm.toUpperCase()}  ` : queryTerm,
      languages: rng.subset(languages, 2),
      tags: rng.subset(tagNames, 3),
      tagMode: rng.pick(['any', 'all'] as const),
      showTombstone: rng.bool(0.25),
      onlyFavorite: rng.bool(0.2),
      onlyUntagged: rng.bool(0.2),
      onlyArchived: rng.bool(0.2),
      onlyOwned: rng.bool(0.2),
      sortKey: rng.pick(sortKeys),
      sortDir: rng.pick(['asc', 'desc'] as const),
    },
    offset: rng.int(0, Math.max(0, starCount + 5)),
    limit: rng.int(1, 25),
    accountLogin: rng.bool(0.8) ? `owner${rng.int(0, 6)}` : null,
  };
  return { stars, tags, tagMeta, params };
}

function makeStar(fullName: string, index: number, rng: SeededRng, overrides: Partial<Star> = {}): Star {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: rng.subset(words, 3).join(' '),
    language: rng.maybe(rng.pick(languages), 0.75),
    stargazers_count: rng.int(0, 5000),
    topics: rng.subset(words, 4),
    pushed_at: rng.maybe(iso(index + rng.int(0, 50)), 0.85),
    created_at: rng.maybe(iso(index + rng.int(100, 150)), 0.8),
    fork: rng.bool(0.15),
    archived: rng.bool(0.15),
    starred_at: iso(index + 200),
    tombstone: rng.bool(0.15),
    synced_at: iso(index + 300),
    ...overrides,
  };
}

function makeTag(fullName: string, selected: string[], index: number, rng: SeededRng): Tag {
  const dismissedAutoTags = rng.subset(tagNames.filter((tag) => !selected.includes(tag)), 1);
  const mtime = iso(index + 500);
  return {
    full_name: fullName,
    manualTags: selected,
    autoTags: rng.subset(tagNames.filter((tag) => (
      !selected.includes(tag) && !dismissedAutoTags.includes(tag)
    )), 2),
    dismissedAutoTags,
    manualTagsMtime: mtime,
    autoTagsMtime: mtime,
    dismissedAutoTagsMtime: mtime,
    notes: rng.bool(0.35) ? `note ${rng.pick(words)}` : '',
    favorite: rng.bool(0.2),
    gh_list_id: rng.bool(0.2) ? rng.int(1, 20) : null,
    mtime,
  };
}

function referenceQuery(input: GeneratedQueryCase): StarsQueryResult {
  const indexedStars = [...input.stars].sort((a, b) => a.full_name.localeCompare(b.full_name));
  const excluded = referenceExcludedTagKeys(input.tagMeta);
  const indexedTags = input.tags
    .map((tag) => normalizeStoredTag(tag as LegacyTagRow))
    .map((tag) => ({
      ...tag,
      manualTags: tag.manualTags.filter((name) => !excluded.has(referenceTagKey(name))),
      autoTags: tag.autoTags.filter((name) => !excluded.has(referenceTagKey(name))),
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const tagMap = new Map(indexedTags.map((tag) => [tag.full_name, tag]));
  const q = normalizeReferenceSearchText(input.params.filter.query.trim());
  const relevanceByFullName = new Map<string, number>();
  const langSet = input.params.filter.languages.length ? new Set(input.params.filter.languages) : null;
  const tagSet = input.params.filter.tags.length
    ? new Set(input.params.filter.tags.map((tag) => referenceTagKey(tag)))
    : null;
  const filtered = indexedStars.filter((star) => {
    if (!input.params.filter.showTombstone && star.tombstone) return false;
    if (input.params.filter.onlyArchived && !star.archived) return false;
    if (input.params.filter.onlyOwned) {
      const owner = input.params.accountLogin?.trim().normalize('NFKC').toLocaleLowerCase('en-US');
      const fullName = star.full_name.normalize('NFKC').toLocaleLowerCase('en-US');
      if (!owner || !fullName.startsWith(`${owner}/`)) return false;
    }
    if (langSet && (star.language === null || !langSet.has(star.language))) return false;
    const tagRecord = tagMap.get(star.full_name);
    const myTags = visibleTagNames(tagRecord);
    const myTagKeys = myTags.map((tag) => referenceTagKey(tag));
    if (input.params.filter.onlyFavorite && !tagRecord?.favorite) return false;
    if (input.params.filter.onlyUntagged && myTags.length > 0) return false;
    if (tagSet) {
      if (input.params.filter.tagMode === 'all') {
        if (!input.params.filter.tags.every((tag) => myTagKeys.includes(referenceTagKey(tag)))) return false;
      } else if (!myTagKeys.some((tag) => tagSet.has(tag))) {
        return false;
      }
    }
    if (q) {
      const relevance = referenceSearchRelevance(star, tagRecord?.notes ?? '', q);
      if (relevance === 0) return false;
      relevanceByFullName.set(star.full_name, relevance);
    }
    return true;
  });
  const sorted = sortReferenceRows(
    filtered,
    input.params.filter.sortKey,
    input.params.filter.sortDir,
    q ? relevanceByFullName : undefined,
  );
  const rows = sorted.slice(input.params.offset, input.params.offset + input.params.limit);
  const languagesFacet = [...countLanguages(indexedStars).entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  const tagCounts = countTags(indexedTags, excluded);
  const tagTree = [...tagCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const tagsForRows: Record<string, Tag | undefined> = {};
  for (const row of rows) tagsForRows[row.full_name] = tagMap.get(row.full_name);
  return {
    rows,
    total: filtered.length,
    grandTotal: input.stars.length,
    tagsForRows,
    languages: languagesFacet,
    tagTree,
    tagTotal: tagCounts.size,
  };
}

function sortReferenceRows(
  rows: Star[],
  key: SortKey,
  dir: 'asc' | 'desc',
  relevance?: ReadonlyMap<string, number>,
): Star[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (relevance) {
      const difference = (relevance.get(b.full_name) ?? 0) - (relevance.get(a.full_name) ?? 0);
      if (difference !== 0) return difference;
    }
    switch (key) {
      case 'pushed_at':
        return compareNullableDate(a.pushed_at, b.pushed_at, a.full_name, b.full_name, dir);
      case 'created_at':
        return compareNullableDate(a.created_at, b.created_at, a.full_name, b.full_name, dir);
      case 'starred_at':
        return a.starred_at.localeCompare(b.starred_at) * mul;
      case 'stargazers_count':
        return (a.stargazers_count - b.stargazers_count) * mul;
      case 'name':
        return a.full_name.localeCompare(b.full_name) * mul;
    }
  });
}

function referenceSearchRelevance(star: Star, notes: string, query: string): number {
  const fullName = normalizeReferenceSearchText(star.full_name);
  const slash = star.full_name.lastIndexOf('/');
  const repositoryName = normalizeReferenceSearchText(star.full_name.slice(slash + 1));

  if (fullName === query) return 900;
  const fuzzyQuery = compactReferenceFuzzyQuery(query);
  if (!query.includes('/')) {
    if (repositoryName === query) return 800;
    if (repositoryName.startsWith(query)) return 700;
    if (repositoryName.includes(query)) return 600;
    if (referenceSequenceMatch(repositoryName, fuzzyQuery)) return 500;
  }
  if (fullName.startsWith(query)) return 400;
  if (fullName.includes(query)) return 300;
  if (referenceSequenceMatch(fullName, fuzzyQuery)) return 200;

  const metadata = normalizeReferenceSearchText(
    `${star.description} ${star.topics.join(' ')} ${notes}`,
  );
  return metadata.includes(query) ? 100 : 0;
}

function referenceSequenceMatch(candidate: string, query: string): boolean {
  let searchFrom = 0;
  for (const character of query) {
    const index = candidate.indexOf(character, searchFrom);
    if (index < 0) return false;
    searchFrom = index + character.length;
  }
  return query.length > 0;
}

function normalizeReferenceSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function compactReferenceFuzzyQuery(value: string): string {
  return value.replace(/[-_./\s]+/gu, '');
}

function countLanguages(stars: Star[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const star of stars) {
    if (star.language) counts.set(star.language, (counts.get(star.language) ?? 0) + 1);
  }
  return counts;
}

function countTags(tags: Tag[], excluded: Set<string>): Map<string, number> {
  const countsByKey = new Map<string, { name: string; count: number }>();
  for (const row of tags) {
    for (const tag of visibleTagNames(row)) {
      const key = referenceTagKey(tag);
      if (excluded.has(key)) continue;
      const current = countsByKey.get(key);
      countsByKey.set(key, {
        name: current?.name ?? tag,
        count: (current?.count ?? 0) + 1,
      });
    }
  }
  return new Map([...countsByKey.values()].map(({ name, count }) => [name, count]));
}

function referenceExcludedTagKeys(metas: readonly TagMeta[]): Set<string> {
  const winners = new Map<string, TagMeta>();
  for (const meta of metas) {
    const key = referenceTagKey(meta.name);
    const current = winners.get(key);
    if (!current || referencePrefersRightMeta(current, meta)) winners.set(key, meta);
  }
  return new Set(
    [...winners]
      .filter(([, meta]) => meta.excluded)
      .map(([key]) => key),
  );
}

function referencePrefersRightMeta(left: TagMeta, right: TagMeta): boolean {
  if (left.mtime !== right.mtime) return right.mtime > left.mtime;
  if ((left.excluded === true) !== (right.excluded === true)) return right.excluded === true;
  return right.name.localeCompare(left.name, 'en-US') < 0;
}

function referenceTagKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function assertQueryEqual(
  actual: StarsQueryResult,
  expected: StarsQueryResult,
  context: { caseIndex: number; trace: unknown },
): void {
  const actualSummary = summarizeResult(actual);
  const expectedSummary = summarizeResult(expected);
  assert.deepEqual(
    actualSummary,
    expectedSummary,
    fuzzFailure({
      suite: SUITE,
      prefix: PREFIX,
      seed: CASES.seed,
      caseIndex: context.caseIndex,
      file: FILE,
      invariant: 'query result matches reference model',
      expected: expectedSummary,
      actual: actualSummary,
      trace: context.trace,
    }),
  );
}

function summarizeResult(result: StarsQueryResult) {
  return {
    rows: result.rows.map((row) => row.full_name),
    total: result.total,
    grandTotal: result.grandTotal,
    tagsForRows: Object.fromEntries(Object.entries(result.tagsForRows).map(([name, tag]) => [name, tag ? visibleTagNames(tag) : null])),
    languages: result.languages,
    tagTree: result.tagTree,
    tagTotal: result.tagTotal,
  };
}

function summarizeCase(input: GeneratedQueryCase) {
  return {
    filter: input.params.filter,
    offset: input.params.offset,
    limit: input.params.limit,
    stars: input.stars.map((star) => ({
      full_name: star.full_name,
      language: star.language,
      archived: star.archived,
      tombstone: star.tombstone,
      created_at: star.created_at,
      pushed_at: star.pushed_at,
    })),
    tags: input.tags.map((tag) => ({ full_name: tag.full_name, tags: visibleTagNames(tag), favorite: tag.favorite, notes: tag.notes })),
    excluded: input.tagMeta.filter((meta) => meta.excluded).map((meta) => meta.name),
  };
}

function iso(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1 + offset, 0, 0, 0)).toISOString();
}
