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
    description: '',
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
    const overLimitRows = Array.from({ length: 13 }, (_, index) => seed(
      `Owner-${String(index)}/Repo`,
      new Date(Date.parse(NOW) - index * 1_000).toISOString(),
    ));
    expect(selectRecommendationSeeds(overLimitRows, 99)).toHaveLength(12);
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
    expect(buildRecommendationQueryPlan(seeds, 99)).toHaveLength(6);
    expect(buildRecommendationQueryPlan(seeds, -1)).toEqual([]);
  });

  it('builds bounded keyword queries from topic-less seed descriptions', () => {
    const seeds = selectRecommendationSeeds([
      seed('Topicless/Seed', '2026-08-10T11:00:00Z', {
        language: null,
        topics: [],
        description: 'Constructor Open source Luminara workflows with Astral Forge Nimbus Quartz Vector Orbit',
      }),
    ]);
    const keywordPlan = buildRecommendationQueryPlan(seeds)
      .filter((item) => item.signalKind === 'keyword');

    expect(seeds[0]?.descriptionKeywords).toEqual([
      'constructor', 'luminara', 'workflows', 'astral', 'forge', 'nimbus',
    ]);
    expect(seeds[0]).not.toHaveProperty('description');
    expect(keywordPlan).toEqual([
      {
        id: 'keyword:constructor',
        query: 'constructor in:name,description archived:false fork:false stars:>=10',
        signalKind: 'keyword',
        signalValue: 'constructor',
        seedRepositoryKeys: ['topicless/seed'],
      },
      {
        id: 'keyword:luminara',
        query: 'luminara in:name,description archived:false fork:false stars:>=10',
        signalKind: 'keyword',
        signalValue: 'luminara',
        seedRepositoryKeys: ['topicless/seed'],
      },
    ]);
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

  it('matches topic-less seeds through candidate descriptions and names', () => {
    const seeds = selectRecommendationSeeds([
      seed('Seed/Repo', '2026-08-10T11:00:00Z', {
        language: null,
        topics: [],
        description: 'Luminara workflow engine',
      }),
    ]);
    const rows = rankRecommendationCandidates({
      accountLogin: 'viewer',
      seeds,
      candidates: [
        candidate('candidate/repo', {
          language: 'Rust',
          topics: [],
          description: 'A Luminara-compatible toolkit',
        }),
        candidate('candidate/luminara-tool', {
          language: 'Rust',
          topics: [],
          description: '',
        }),
      ],
      excludedRepositoryKeys: new Set(),
      fetchedAt: NOW,
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.reason)).toEqual([
      expect.objectContaining({
        kind: 'keyword',
        value: 'luminara',
        seedRepositoryKey: 'seed/repo',
      }),
      expect.objectContaining({
        kind: 'keyword',
        value: 'luminara',
        seedRepositoryKey: 'seed/repo',
      }),
    ]);
  });

  it('keeps description keywords exclusive to topic-less seeds', () => {
    const seeds = selectRecommendationSeeds([
      seed('Seed/Repo', '2026-08-10T11:00:00Z', {
        language: null,
        topics: ['developer-tools'],
        description: 'Luminara workflow engine',
      }),
    ]);
    expect(seeds[0]?.descriptionKeywords).toEqual([]);

    const rows = rankRecommendationCandidates({
      accountLogin: 'viewer',
      seeds: [{ ...seeds[0]!, descriptionKeywords: ['luminara'] }],
      candidates: [candidate('candidate/different', {
        language: 'Rust',
        topics: [],
        description: 'Luminara',
      })],
      excludedRepositoryKeys: new Set(),
      fetchedAt: NOW,
    });
    expect(rows).toEqual([]);
  });

  it('keeps all equally strongest reasons and distributes assignments deterministically', () => {
    const seeds = selectRecommendationSeeds([
      seed('Alpha/Seed', '2026-08-10T11:00:00Z', {
        language: null,
        topics: [],
        description: 'Luminara engine',
      }),
      seed('Beta/Seed', '2026-08-10T10:00:00Z', {
        language: null,
        topics: [],
        description: 'Luminara engine',
      }),
    ]);
    const input = {
      accountLogin: 'viewer',
      seeds,
      candidates: [
        candidate('candidate/one', { language: 'Rust', topics: [], description: 'Luminara' }),
        candidate('candidate/two', { language: 'Rust', topics: [], description: 'Luminara' }),
      ],
      excludedRepositoryKeys: new Set<string>(),
      fetchedAt: NOW,
    };

    const first = rankRecommendationCandidates(input);
    const second = rankRecommendationCandidates({ ...input, candidates: [...input.candidates].reverse() });
    expect(first.map((row) => row.reason.seedRepositoryKey)).toEqual(['alpha/seed', 'beta/seed']);
    expect(second.map((row) => row.reason.seedRepositoryKey)).toEqual(['alpha/seed', 'beta/seed']);
    expect(first.every((row) => row.reason.kind === 'keyword')).toBe(true);
  });

  it('penalizes a seed after three attributions so an alternative seed surfaces', () => {
    const seeds = selectRecommendationSeeds([
      seed('Alpha/Seed', '2026-08-10T11:00:00Z', {
        language: null,
        topics: ['alpha-signal'],
      }),
      seed('Beta/Seed', '2026-08-10T10:00:00Z', {
        language: null,
        topics: ['beta-signal'],
      }),
    ]);
    const alphaCandidates = Array.from({ length: 4 }, (_, index) => candidate(
      `candidate/alpha-${String(index + 1)}`,
      { language: null, topics: ['alpha-signal'] },
    ));
    const rows = rankRecommendationCandidates({
      accountLogin: 'viewer',
      seeds,
      candidates: [
        ...alphaCandidates,
        candidate('zeta/beta', { language: null, topics: ['beta-signal'] }),
      ],
      excludedRepositoryKeys: new Set(),
      fetchedAt: NOW,
    });

    expect(rows.map((row) => row.repositoryKey)).toEqual([
      'candidate/alpha-1',
      'candidate/alpha-2',
      'candidate/alpha-3',
      'zeta/beta',
      'candidate/alpha-4',
    ]);
    expect(rows.slice(0, 4).map((row) => row.reason.seedRepositoryKey)).toEqual([
      'alpha/seed', 'alpha/seed', 'alpha/seed', 'beta/seed',
    ]);
    expect(rows[3]?.score).toBeGreaterThan(rows[4]?.score ?? 0);
    expect((rows[0]?.score ?? 0) - (rows[4]?.score ?? 0)).toBe(5);
  });

  it('locks raw top-sixty membership before applying diversity penalties', () => {
    const seeds = selectRecommendationSeeds([
      seed('Alpha/Seed', '2026-08-10T11:00:00Z', {
        language: null,
        topics: ['alpha-signal'],
      }),
      seed('Beta/Seed', '2026-08-10T10:00:00Z', {
        language: null,
        topics: ['beta-signal'],
      }),
    ]);
    const rawTop = Array.from({ length: 60 }, (_, index) => candidate(
      `candidate/alpha-${String(index).padStart(2, '0')}`,
      { language: null, topics: ['alpha-signal'], stargazerCount: 100 },
    ));
    const rows = rankRecommendationCandidates({
      accountLogin: 'viewer',
      seeds,
      candidates: [
        ...rawTop,
        candidate('zeta/beta-below-cutoff', {
          language: null,
          topics: ['beta-signal'],
          stargazerCount: 99,
        }),
      ],
      excludedRepositoryKeys: new Set(),
      fetchedAt: NOW,
    });

    expect(rows).toHaveLength(60);
    expect(rows.every((row) => row.repositoryKey.startsWith('candidate/alpha-'))).toBe(true);
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
    const oversizedLimit = rankRecommendationCandidates({
      accountLogin: 'viewer',
      seeds,
      candidates,
      excludedRepositoryKeys: new Set(),
      fetchedAt: NOW,
      limit: 99,
    });

    expect(full).toHaveLength(60);
    expect(new Set(full.map((row) => row.repositoryKey))).toHaveLength(60);
    expect(short).toHaveLength(17);
    expect(oversizedLimit).toHaveLength(60);
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
