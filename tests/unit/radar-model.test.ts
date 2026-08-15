import { describe, expect, it } from 'vitest';
import {
  aggregateRadarProjects,
  dedupeRadarActivities,
  GitHubRadarError,
  normalizeRadarActivity,
  normalizeRadarPartialReasons,
  radarActivityId,
  type RadarActivityPresentation,
  type RadarActivitySource,
} from '@/radar/radar-model';

function activity(input: {
  actor: string;
  repository: string;
  starredAt: string;
  stars?: number;
  favorite?: boolean;
  tags?: string[];
  topics?: string[];
  source?: RadarActivitySource;
}): RadarActivityPresentation {
  const row = normalizeRadarActivity({
    actorLogin: input.actor,
    actorAvatarUrl: `https://avatars.example/${input.actor}.png`,
    repositoryFullName: input.repository,
    repositoryDescription: `${input.repository} description`,
    repositoryLanguage: 'TypeScript',
    repositoryLanguageColor: '#3178c6',
    repositoryTopics: input.topics ?? [],
    repositoryStargazerCount: input.stars ?? 10,
    viewerHadStarred: false,
    starredAt: input.starredAt,
  }, { accountLogin: 'Viewer' });
  return {
    ...row,
    source: input.source ?? 'following',
    seen: input.source === 'self',
    viewerHasStarred: false,
    favorite: input.favorite ?? false,
    tags: input.tags ?? [],
    suggestedTags: row.repositoryTopics,
    displayedStargazerCount: input.stars ?? 10,
  };
}

describe('Radar activity model', () => {
  it('normalizes persisted identity while preserving display casing', () => {
    const row = normalizeRadarActivity({
      actorLogin: 'Octo-Friend',
      actorAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      repositoryFullName: 'Owner/Repo',
      repositoryDescription: null,
      repositoryLanguage: 'Rust',
      repositoryLanguageColor: '#DEA584',
      repositoryStargazerCount: 42,
      repositoryTopics: [' TypeScript ', 'ai', 'typescript', '', 'AI'],
      viewerHadStarred: true,
      starredAt: '2026-08-10T03:04:05Z',
    }, { accountLogin: 'Viewer' });

    expect(row.accountLogin).toBe('viewer');
    expect(row.actorAvatarUrl).toBe('https://avatars.githubusercontent.com/u/1?v=4');
    expect(row.repositoryKey).toBe('owner/repo');
    expect(row.repositoryFullName).toBe('Owner/Repo');
    expect(row.repositoryHtmlUrl).toBe('https://github.com/owner/repo');
    expect(row.repositoryDescription).toBe('');
    expect(row.repositoryLanguageColor).toBe('#dea584');
    expect(row.repositoryTopics).toEqual(['ai', 'typescript']);
    expect(row.seenAt).toBeNull();
    expect(row.starredAt).toBe('2026-08-10T03:04:05.000Z');
    expect(row.id).toBe(radarActivityId({
      actorLogin: 'octo-friend',
      repositoryFullName: 'owner/repo',
      starredAt: '2026-08-10T03:04:05.000Z',
    }));
  });

  it('drops unsafe actor avatar URLs without rejecting the activity', () => {
    const row = normalizeRadarActivity({
      actorLogin: 'friend',
      actorAvatarUrl: 'javascript:alert(1)',
      repositoryFullName: 'owner/repo',
      repositoryStargazerCount: 1,
      starredAt: '2026-08-10T00:00:00Z',
    }, { accountLogin: 'viewer' });

    expect(row.actorAvatarUrl).toBeNull();
  });

  it('rejects malformed remote activity before it reaches storage', () => {
    for (const malformed of [
      null,
      { actorLogin: '', repositoryFullName: 'owner/repo' },
      {
        actorLogin: 'friend',
        repositoryFullName: 'owner/repo',
        starredAt: 'not-a-date',
        repositoryStargazerCount: 1,
      },
      {
        actorLogin: 'friend',
        repositoryFullName: 'owner/repo',
        starredAt: '2026-08-10T00:00:00Z',
        repositoryStargazerCount: -1,
      },
      {
        actorLogin: 'friend',
        repositoryFullName: 'owner/repo',
        starredAt: '2026-08-10T00:00:00Z',
        repositoryStargazerCount: 1,
        repositoryLanguageColor: 'red',
      },
    ]) {
      expect(() => normalizeRadarActivity(malformed, { accountLogin: 'viewer' }))
        .toThrowError(GitHubRadarError);
    }
  });

  it('deduplicates identities and keeps a deterministic newest-first feed', () => {
    const older = activity({
      actor: 'alice',
      repository: 'owner/one',
      starredAt: '2026-08-10T01:00:00Z',
    });
    const newer = activity({
      actor: 'bob',
      repository: 'owner/two',
      starredAt: '2026-08-10T03:00:00Z',
    });

    expect(dedupeRadarActivities([older, newer, { ...older }]).map((row) => row.id))
      .toEqual([newer.id, older.id]);
  });

  it('derives Projects from the same feed and carries latest local presentation state', () => {
    const older = activity({
      actor: 'alice',
      repository: 'Owner/Repo',
      starredAt: '2026-08-10T01:00:00Z',
      stars: 10,
      topics: ['cached-topic'],
    });
    const newer = activity({
      actor: 'bob',
      repository: 'owner/repo',
      starredAt: '2026-08-10T03:00:00Z',
      stars: 12,
      favorite: true,
      tags: ['infra'],
      topics: ['local-topic'],
      source: 'self',
    });
    const other = activity({
      actor: 'carol',
      repository: 'another/project',
      starredAt: '2026-08-10T02:00:00Z',
    });

    const projects = aggregateRadarProjects([older, other, newer]);
    expect(projects.map((project) => project.repositoryKey)).toEqual([
      'owner/repo',
      'another/project',
    ]);
    expect(projects[0]).toMatchObject({
      activityCount: 2,
      latestStarredAt: newer.starredAt,
      favorite: true,
      tags: ['infra'],
      displayedStargazerCount: 12,
      suggestedTags: ['local-topic'],
    });
    expect(projects[0]?.activities).toEqual([newer, older]);
    expect(projects[0]?.activityIds).toEqual([older.id]);
  });

  it('retains every followed activity when a project exceeds the old 30-row cap', () => {
    const activities = Array.from({ length: 31 }, (_, index) => activity({
      actor: `actor-${index}`,
      repository: 'owner/busy-project',
      starredAt: new Date(Date.UTC(2026, 7, 10, 0, index)).toISOString(),
    }));

    const [project] = aggregateRadarProjects(activities);
    expect(project?.activityCount).toBe(31);
    expect(project?.activityIds).toHaveLength(31);
    expect(project?.activities).toHaveLength(31);
    expect(project?.activities.map(({ id }) => id)).toEqual(
      [...activities].reverse().map(({ id }) => id),
    );
  });

  it('retains repeated contributions from one actor with each starred time', () => {
    const newer = activity({
      actor: 'same-actor',
      repository: 'owner/repeated',
      starredAt: '2026-08-10T05:00:00Z',
    });
    const older = activity({
      actor: 'same-actor',
      repository: 'owner/repeated',
      starredAt: '2026-08-10T03:00:00Z',
    });

    const [project] = aggregateRadarProjects([older, newer]);
    expect(project?.activities.map(({ actorLogin, starredAt }) => ({ actorLogin, starredAt })))
      .toEqual([
        { actorLogin: 'same-actor', starredAt: newer.starredAt },
        { actorLogin: 'same-actor', starredAt: older.starredAt },
      ]);
  });

  it('keeps only known partial reasons in stable product order', () => {
    expect(normalizeRadarPartialReasons([
      'following_scan_truncated',
      'unknown',
      'private_activity_omitted',
      'following_scan_truncated',
    ])).toEqual(['private_activity_omitted', 'following_scan_truncated']);
  });
});
