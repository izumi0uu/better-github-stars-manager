import { describe, expect, it } from 'vitest';
import {
  buildRecommendationQueryPlan,
  rankRecommendationCandidates,
  selectRecommendationSeeds,
  type RecommendationCandidate,
  type RecommendationSeedInput,
} from '@/recommendations/recommendation-model';

const NOW = '2026-08-10T12:00:00.000Z';

function seed(
  fullName: string,
  starredAt: string,
  overrides: Partial<RecommendationSeedInput> = {},
): RecommendationSeedInput {
  return {
    full_name: fullName,
    language: 'TypeScript',
    topics: ['developer-tools'],
    starred_at: starredAt,
    stargazers_count: 100,
    tombstone: false,
    viewer_has_starred: true,
    ...overrides,
  };
}

function candidate(
  repositoryKey: string,
  overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
  const [owner = '', name = ''] = repositoryKey.split('/');
  return {
    repositoryKey,
    repositoryFullName: repositoryKey,
    repositoryHtmlUrl: `https://github.com/${repositoryKey}`,
    description: '',
    language: 'TypeScript',
    stargazerCount: 100,
    topics: ['developer-tools'],
    owner,
    name,
    pushedAt: '2026-08-09T12:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    fork: false,
    archived: false,
    ...overrides,
  };
}

describe('recommendation model', () => {
  it('selects only live, valid seeds with deterministic diversity', () => {
    const rows = [
      seed('Same/One', '2026-08-10T11:00:00Z'),
      seed('Same/Two', '2026-08-10T10:00:00Z'),
      seed('Same/Three', '2026-08-10T09:00:00Z'),
      seed('Other/Four', '2026-08-10T08:00:00Z', { language: 'Rust', topics: ['cli'] }),
      seed('Dead/Repo', '2026-08-10T12:00:00Z', { tombstone: true }),
      seed('Unstarred/Repo', '2026-08-10T12:00:00Z', { viewer_has_starred: false }),
      seed('malformed', '2026-08-10T12:00:00Z'),
      seed('Owner/BadDate', 'not-a-date'),
    ];

    expect(selectRecommendationSeeds(rows, 3).map((item) => item.repositoryKey)).toEqual([
      'same/one',
      'same/two',
      'other/four',
    ]);
    expect(selectRecommendationSeeds(rows, 0)).toEqual([]);
    expect(selectRecommendationSeeds(rows, Number.NaN)).toEqual([]);
  });

  it('builds a stable bounded query plan and quotes language qualifiers', () => {
    const seeds = selectRecommendationSeeds([
      seed('Owner/Tool', '2026-08-10T11:00:00Z', {
        language: 'C++',
        topics: ['developer-tools', 'cli'],
      }),
      seed('Second/Project', '2026-08-10T10:00:00Z', {
        language: 'Rust',
        topics: ['developer-tools'],
      }),
    ]);

    const plan = buildRecommendationQueryPlan(seeds);
    expect(plan).toHaveLength(6);
    expect(plan[0]).toMatchObject({ signalKind: 'topic', signalValue: 'developer-tools' });
    expect(new Set(plan.map((item) => item.signalKind))).toEqual(new Set(['topic', 'language', 'owner', 'name']));
    expect(plan.find((item) => item.signalKind === 'language')?.query)
      .toContain('language:c++');
    expect(buildRecommendationQueryPlan(seeds, -1)).toEqual([]);
  });

  it('excludes local, archived, forked, and unrelated repositories before ranking', () => {
    const seeds = selectRecommendationSeeds([
      seed('Seed/Repo', '2026-08-10T11:00:00Z'),
    ]);
    const rows = rankRecommendationCandidates({
      accountLogin: 'Viewer',
      seeds,
      candidates: [
        candidate('local/repo'),
        candidate('archived/repo', { archived: true }),
        candidate('fork/repo', { fork: true }),
        candidate('unrelated/repo', { language: 'Rust', topics: [], owner: 'unrelated', name: 'different' }),
        candidate('candidate/tool'),
      ],
      excludedRepositoryKeys: new Set(['local/repo']),
      fetchedAt: NOW,
    });

    expect(rows.map((row) => row.repositoryKey)).toEqual(['candidate/tool']);
    expect(rows[0]).toMatchObject({
      accountLogin: 'viewer',
      reason: {
        kind: 'topic',
        value: 'developer-tools',
        seedRepositoryKey: 'seed/repo',
      },
    });
  });

  it('publishes at most sixty unique eligible candidates without padding short results', () => {
    const seeds = selectRecommendationSeeds([
      seed('Seed/Repo', '2026-08-10T11:00:00Z'),
    ]);
    const candidates = Array.from({ length: 75 }, (_, index) => candidate(`candidate/repo-${String(index).padStart(2, '0')}`));

    const full = rankRecommendationCandidates({
      accountLogin: 'viewer',
      seeds,
      candidates,
      excludedRepositoryKeys: new Set(),
      fetchedAt: NOW,
    });
    const short = rankRecommendationCandidates({
      accountLogin: 'viewer',
      seeds,
      candidates: candidates.slice(0, 17),
      excludedRepositoryKeys: new Set(),
      fetchedAt: NOW,
    });

    expect(full).toHaveLength(60);
    expect(new Set(full.map((row) => row.repositoryKey))).toHaveLength(60);
    expect(short).toHaveLength(17);
  });

  it('keeps stable order for score ties and rejects invalid ranking boundaries', () => {
    const seeds = selectRecommendationSeeds([seed('Seed/Repo', '2026-08-10T11:00:00Z')]);
    const input = {
      accountLogin: 'viewer',
      seeds,
      candidates: [candidate('b/repo'), candidate('a/repo')],
      excludedRepositoryKeys: new Set<string>(),
      fetchedAt: NOW,
    };

    expect(rankRecommendationCandidates(input).map((row) => row.repositoryKey))
      .toEqual(['a/repo', 'b/repo']);
    expect(rankRecommendationCandidates({ ...input, fetchedAt: 'invalid' })).toEqual([]);
    expect(rankRecommendationCandidates({ ...input, limit: 0 })).toEqual([]);
  });
});
