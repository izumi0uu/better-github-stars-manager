import type { Star, Tag, TagMeta } from '@/types';
import {
  dedupeRadarActivities,
  normalizeRadarActivity,
  normalizeRadarAvatarUrl,
  normalizeRadarRepositoryTopics,
  sortRadarActivities,
  type RadarActivityPresentation,
  type RadarActivityRecord,
} from '@/radar/radar-model';
import { normalizeRepositoryFullName } from '@/watch/watch-model';
import { canonicalTagKey, excludedCanonicalTagKeys, visibleTagNames } from '@/tags/tag-model';

export type RadarProjectionSource = Readonly<{
  accountLogin: string;
  nowMillis: number;
  windowDays: number;
  activities: readonly RadarActivityRecord[];
  stars: readonly Star[];
  tags: readonly Tag[];
  tagMeta: readonly TagMeta[];
}>;

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function storedSeenAt(value: unknown): string | null {
  return typeof value === 'string' && timestamp(value) !== null ? value : null;
}

function ownStarPresentation(
  star: Star,
  accountLogin: string,
  tag: Tag | undefined,
  excludedTagKeys: ReadonlySet<string>,
): RadarActivityPresentation | null {
  try {
    const activity = normalizeRadarActivity({
      actorLogin: accountLogin,
      actorAvatarUrl: null,
      repositoryFullName: star.full_name,
      repositoryDescription: star.description,
      repositoryLanguage: star.language,
      repositoryLanguageColor: null,
      repositoryOwnerLogin: normalizeRepositoryFullName(star.full_name).split('/')[0] ?? null,
      repositoryOwnerAvatarUrl: star.owner_avatar_url ?? null,
      repositoryStargazerCount: star.stargazers_count,
      repositoryTopics: star.topics,
      viewerHadStarred: true,
      starredAt: star.starred_at,
    }, { accountLogin });
    return {
      ...activity,
      source: 'self',
      seen: true,
      viewerHasStarred: true,
      favorite: tag?.favorite === true,
      tags: tag ? visibleTagNames(tag) : [],
      suggestedTags: activity.repositoryTopics.filter(
        (topic) => !excludedTagKeys.has(canonicalTagKey(topic)),
      ),
      displayedStargazerCount: star.stargazers_count,
    };
  } catch {
    return null;
  }
}

export function projectRadarActivities(source: RadarProjectionSource): RadarActivityPresentation[] {
  const accountLogin = source.accountLogin.trim().toLocaleLowerCase('en-US');
  const cutoffMillis = source.nowMillis - source.windowDays * 24 * 60 * 60 * 1_000;
  const storedActivities = dedupeRadarActivities(source.activities)
    .filter((activity) => {
      const starredAt = timestamp(activity.starredAt);
      return activity.accountLogin === accountLogin
        && activity.dismissedAt === null
        && starredAt !== null
        && starredAt >= cutoffMillis
        && starredAt <= source.nowMillis;
    });
  const ownStars = source.stars.filter((star) => {
    const starredAt = timestamp(star.starred_at);
    return !star.tombstone
      && star.viewer_has_starred !== false
      && starredAt !== null
      && starredAt >= cutoffMillis
      && starredAt <= source.nowMillis;
  });
  const repositoryKeys = new Set([
    ...storedActivities.map((activity) => activity.repositoryKey),
    ...ownStars.map((star) => normalizeRepositoryFullName(star.full_name)),
  ]);
  const stars = new Map(
    source.stars.flatMap((star) => {
      const repositoryKey = normalizeRepositoryFullName(star.full_name);
      return repositoryKeys.has(repositoryKey) ? [[repositoryKey, star] as const] : [];
    }),
  );
  const tags = new Map<string, Tag>();
  for (const tag of source.tags) {
    const repositoryKey = normalizeRepositoryFullName(tag.full_name);
    if (repositoryKeys.has(repositoryKey)) tags.set(repositoryKey, tag);
  }
  const excludedTagKeys = excludedCanonicalTagKeys(source.tagMeta);

  const following = storedActivities.map((activity): RadarActivityPresentation => {
    const star = stars.get(activity.repositoryKey);
    const tag = tags.get(activity.repositoryKey);
    const seenAt = storedSeenAt(activity.seenAt);
    const hasLiveStar = !!star && !star.tombstone && star.viewer_has_starred !== false;
    const repositoryTopics = normalizeRadarRepositoryTopics(
      hasLiveStar ? star.topics : activity.repositoryTopics,
    );
    return {
      ...activity,
      source: 'following',
      seenAt,
      seen: seenAt !== null,
      actorAvatarUrl: normalizeRadarAvatarUrl(activity.actorAvatarUrl),
      repositoryOwnerLogin: activity.repositoryOwnerLogin ?? null,
      repositoryOwnerAvatarUrl: normalizeRadarAvatarUrl(activity.repositoryOwnerAvatarUrl),
      repositoryTopics,
      viewerHasStarred: star ? hasLiveStar : activity.viewerHadStarred,
      favorite: tag?.favorite === true,
      tags: tag ? visibleTagNames(tag) : [],
      suggestedTags: repositoryTopics.filter(
        (topic) => !excludedTagKeys.has(canonicalTagKey(topic)),
      ),
      displayedStargazerCount: star?.stargazers_count ?? activity.repositoryStargazerCount,
    };
  });
  const own = ownStars.flatMap((star) => {
    const repositoryKey = normalizeRepositoryFullName(star.full_name);
    const activity = ownStarPresentation(star, accountLogin, tags.get(repositoryKey), excludedTagKeys);
    return activity ? [activity] : [];
  });
  return sortRadarActivities([...following, ...own]);
}
