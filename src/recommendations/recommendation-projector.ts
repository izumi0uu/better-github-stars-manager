import type { Star } from '@/types';
import type {
  RecommendationIgnoreRecord,
  RecommendationRecord,
} from '@/recommendations/recommendation-model';
import { normalizeRepositoryFullName } from '@/watch/watch-model';

export type RecommendationProjectionSource = Readonly<{
  accountLogin: string;
  recommendations: readonly RecommendationRecord[];
  stars: readonly Star[];
  ignores: readonly RecommendationIgnoreRecord[];
}>;

export function projectRecommendations(
  source: RecommendationProjectionSource,
): RecommendationRecord[] {
  const accountLogin = source.accountLogin.trim().toLocaleLowerCase('en-US');
  const liveLibrary = new Set(source.stars.flatMap((star) => {
    if (star.tombstone || star.viewer_has_starred === false) return [];
    try {
      return [normalizeRepositoryFullName(star.full_name)];
    } catch {
      return [];
    }
  }));
  const ignoredKeys = new Set(source.ignores
    .filter((row) => row.accountLogin === accountLogin)
    .map((row) => row.repositoryKey));

  return source.recommendations
    .filter((recommendation) => (
      recommendation.accountLogin === accountLogin
      && !liveLibrary.has(recommendation.repositoryKey)
      && !ignoredKeys.has(recommendation.repositoryKey)
    ))
    .sort((left, right) => (
      right.score - left.score
        || right.stargazerCount - left.stargazerCount
        || left.repositoryKey.localeCompare(right.repositoryKey)
    ));
}
