import { createRepositorySearchMatcher, type SearchTextRange } from '@/search/repository-search';
import {
  aggregateRadarProjects,
  type RadarActivityPresentation,
  type RadarProjectPresentation,
} from '@/radar/radar-model';

export interface RadarActivitySearchResult {
  activity: RadarActivityPresentation;
  relevance: number;
  actorRanges: readonly SearchTextRange[];
  repositoryRanges: readonly SearchTextRange[];
}

export interface RadarProjectSearchResult {
  project: RadarProjectPresentation;
  relevance: number;
  actorRangesByLogin: Readonly<Record<string, readonly SearchTextRange[]>>;
  repositoryRanges: readonly SearchTextRange[];
}

const ACTOR_RELEVANCE: Readonly<Record<string, number>> = {
  'repository-exact': 1_900,
  'repository-prefix': 1_800,
  'repository-substring': 1_700,
  'repository-fuzzy': 1_600,
};
const ACTOR_PREFIX = 'actor/';

function actorMatch(rawQuery: string, login: string): {
  relevance: number;
  ranges: readonly SearchTextRange[];
} {
  const query = rawQuery.trim().replace(/^@/u, '');
  if (!query) return { relevance: 0, ranges: [] };
  const match = createRepositorySearchMatcher(query).matchName(`${ACTOR_PREFIX}${login}`);
  const relevance = ACTOR_RELEVANCE[match.kind] ?? 0;
  if (!match.matched || relevance === 0) return { relevance: 0, ranges: [] };
  return {
    relevance,
    ranges: match.nameRanges.flatMap((range) => {
      const start = Math.max(ACTOR_PREFIX.length, range.start) - ACTOR_PREFIX.length;
      const end = Math.max(ACTOR_PREFIX.length, range.end) - ACTOR_PREFIX.length;
      return end > start ? [{ start, end }] : [];
    }),
  };
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function searchRadarActivities(
  activities: readonly RadarActivityPresentation[],
  rawQuery: string,
): RadarActivitySearchResult[] {
  const repositoryMatcher = createRepositorySearchMatcher(rawQuery);
  const queryEmpty = repositoryMatcher.empty && rawQuery.trim().replace(/^@/u, '').length === 0;
  const results = activities.flatMap((activity): RadarActivitySearchResult[] => {
    if (queryEmpty) {
      return [{ activity, relevance: 0, actorRanges: [], repositoryRanges: [] }];
    }
    const actor = actorMatch(rawQuery, activity.actorLogin);
    const repository = repositoryMatcher.matchName(activity.repositoryDisplayName);
    if (actor.relevance === 0 && !repository.matched) return [];
    return [{
      activity,
      relevance: Math.max(actor.relevance, repository.relevance),
      actorRanges: actor.ranges,
      repositoryRanges: repository.matched ? repository.nameRanges : [],
    }];
  });
  if (queryEmpty) return results;
  return results.sort((left, right) => (
    right.relevance - left.relevance
      || timestamp(right.activity.starredAt) - timestamp(left.activity.starredAt)
      || left.activity.id.localeCompare(right.activity.id)
  ));
}

export function searchRadarProjects(
  activities: readonly RadarActivityPresentation[],
  rawQuery: string,
): RadarProjectSearchResult[] {
  const projects = aggregateRadarProjects(activities);
  const repositoryMatcher = createRepositorySearchMatcher(rawQuery);
  const queryEmpty = repositoryMatcher.empty && rawQuery.trim().replace(/^@/u, '').length === 0;
  const results = projects.flatMap((project): RadarProjectSearchResult[] => {
    if (queryEmpty) {
      return [{
        project,
        relevance: 0,
        actorRangesByLogin: {},
        repositoryRanges: [],
      }];
    }
    const actorRangesByLogin: Record<string, readonly SearchTextRange[]> = {};
    let actorRelevance = 0;
    for (const activity of project.activities) {
      const actor = actorMatch(rawQuery, activity.actorLogin);
      if (actor.relevance === 0) continue;
      actorRelevance = Math.max(actorRelevance, actor.relevance);
      actorRangesByLogin[activity.actorLogin.toLocaleLowerCase('en-US')] = actor.ranges;
    }
    const repository = repositoryMatcher.matchName(project.repositoryDisplayName);
    if (actorRelevance === 0 && !repository.matched) return [];
    return [{
      project,
      relevance: Math.max(actorRelevance, repository.relevance),
      actorRangesByLogin,
      repositoryRanges: repository.matched ? repository.nameRanges : [],
    }];
  });
  if (queryEmpty) return results;
  return results.sort((left, right) => (
    right.relevance - left.relevance
      || timestamp(right.project.latestStarredAt) - timestamp(left.project.latestStarredAt)
      || left.project.repositoryKey.localeCompare(right.project.repositoryKey)
  ));
}
