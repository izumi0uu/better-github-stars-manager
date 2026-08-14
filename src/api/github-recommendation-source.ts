import {
  canonicalRepositoryKey,
  GitHubRecommendationError,
  RECOMMENDATION_RESULTS_PER_QUERY,
  rankRecommendationCandidates,
  type RecommendationCandidate,
  type RecommendationQueryPlanItem,
  type RecommendationSeed,
  type RecommendationSourceSnapshot,
} from '@/recommendations/recommendation-model';

const SEARCH_URL = 'https://api.github.com/search/repositories';
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_DEADLINE_MS = 75_000;

type FetchLike = typeof fetch;

type SearchRateLimit = Readonly<{
  remaining: number | null;
  resetAt: string | null;
}>;

export interface FetchGitHubRecommendationsOptions {
  token: string;
  accountLogin: string;
  seeds: readonly RecommendationSeed[];
  queryPlan: readonly RecommendationQueryPlanItem[];
  excludedRepositoryKeys: ReadonlySet<string>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  deadlineMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isoTimestamp(value: unknown): string | null {
  const normalized = nullableText(value);
  if (!normalized) return null;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function rateLimitFromHeaders(response: Response): SearchRateLimit {
  const remainingText = response.headers.get('x-ratelimit-remaining');
  const remaining = remainingText === null ? Number.NaN : Number(remainingText);
  const resetText = response.headers.get('x-ratelimit-reset');
  const resetEpoch = resetText === null ? Number.NaN : Number(resetText);
  return {
    remaining: Number.isSafeInteger(remaining) && remaining >= 0 ? remaining : null,
    resetAt: Number.isFinite(resetEpoch) && resetEpoch > 0
      ? new Date(resetEpoch * 1_000).toISOString()
      : null,
  };
}

function responseError(response: Response): GitHubRecommendationError {
  const rateLimit = rateLimitFromHeaders(response);
  const retryAfter = response.headers.get('retry-after');
  const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const resetAt = rateLimit.resetAt
    ?? (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? new Date(Date.now() + retryAfterSeconds * 1_000).toISOString()
      : null);
  if (response.status === 401) {
    return new GitHubRecommendationError('authentication_required', { status: response.status });
  }
  if (response.status === 429 || (response.status === 403 && rateLimit.remaining === 0)) {
    return new GitHubRecommendationError('rate_limited', {
      status: response.status,
      resetAt: resetAt ?? undefined,
    });
  }
  if (response.status === 403 || response.status === 422) {
    return new GitHubRecommendationError('permission_denied', { status: response.status });
  }
  if (response.status >= 500) {
    return new GitHubRecommendationError('github_unavailable', { status: response.status });
  }
  return new GitHubRecommendationError('invalid_response', { status: response.status });
}

function parseCandidate(value: unknown): RecommendationCandidate {
  const item = record(value);
  const repositoryFullName = text(item?.full_name);
  const repositoryKey = canonicalRepositoryKey(repositoryFullName);
  const owner = text(record(item?.owner)?.login)?.toLocaleLowerCase('en-US') ?? null;
  const name = text(item?.name)?.toLocaleLowerCase('en-US') ?? null;
  const htmlUrl = text(item?.html_url);
  const stargazerCount = count(item?.stargazers_count);
  const topics = item?.topics;
  const pushedAt = isoTimestamp(item?.pushed_at);
  const createdAt = isoTimestamp(item?.created_at);
  if (
    !repositoryFullName
    || !repositoryKey
    || !owner
    || !name
    || !htmlUrl
    || stargazerCount === null
    || !Array.isArray(topics)
    || topics.some((topic) => typeof topic !== 'string')
    || typeof item?.fork !== 'boolean'
    || typeof item?.archived !== 'boolean'
  ) throw new GitHubRecommendationError('invalid_candidate');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(htmlUrl);
  } catch {
    throw new GitHubRecommendationError('invalid_candidate');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
    throw new GitHubRecommendationError('invalid_candidate');
  }
  return {
    repositoryKey,
    repositoryFullName,
    repositoryHtmlUrl: parsedUrl.toString(),
    description: typeof item.description === 'string' ? item.description : '',
    language: nullableText(item.language),
    stargazerCount,
    topics: [...new Set((topics as string[]).map((topic) => topic.trim().toLocaleLowerCase('en-US')).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right)),
    owner,
    name,
    pushedAt,
    createdAt,
    fork: item.fork,
    archived: item.archived,
  };
}

async function fetchSearchPage(
  fetchImpl: FetchLike,
  token: string,
  plan: RecommendationQueryPlanItem,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ candidates: RecommendationCandidate[]; rateLimit: SearchRateLimit }> {
  if (options.signal?.aborted) throw new GitHubRecommendationError('request_aborted');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', plan.query);
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(RECOMMENDATION_RESULTS_PER_QUERY));
  url.searchParams.set('page', '1');

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new GitHubRecommendationError('deadline_exceeded');
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new GitHubRecommendationError('request_aborted');
    }
    throw new GitHubRecommendationError('network_error');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
  if (!response.ok) throw responseError(response);
  const contentType = response.headers.get('content-type')?.toLocaleLowerCase('en-US') ?? '';
  if (!contentType.includes('json')) throw new GitHubRecommendationError('invalid_content_type');
  let body: Record<string, unknown>;
  try {
    const parsed = record(await response.json());
    if (!parsed) throw new GitHubRecommendationError('invalid_response');
    body = parsed;
  } catch (error) {
    if (error instanceof GitHubRecommendationError) throw error;
    throw new GitHubRecommendationError('invalid_response');
  }
  if (!Array.isArray(body.items)) throw new GitHubRecommendationError('invalid_response');
  return {
    candidates: body.items.map(parseCandidate),
    rateLimit: rateLimitFromHeaders(response),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}
function minNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

/** Fetch bounded Search candidates and publish only locally ranked, non-library repositories. */
export async function fetchGitHubRecommendations(
  options: FetchGitHubRecommendationsOptions,
): Promise<RecommendationSourceSnapshot> {
  const token = options.token.trim();
  const accountLogin = options.accountLogin.trim().toLocaleLowerCase('en-US');
  if (!token || !accountLogin) throw new GitHubRecommendationError('authentication_required');
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new GitHubRecommendationError('invalid_response');
  const fetchedAt = now.toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadlineAt = Date.now() + positiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const candidates: RecommendationCandidate[] = [];
  let rateLimitRemaining: number | null = null;
  let rateLimitResetAt: string | null = null;
  let queryCount = 0;
  const seenPlanIds = new Set<string>();

  for (const plan of options.queryPlan) {
    if (seenPlanIds.has(plan.id)) continue;
    seenPlanIds.add(plan.id);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new GitHubRecommendationError('deadline_exceeded');
    const result = await fetchSearchPage(fetchImpl, token, plan, {
      signal: options.signal,
      timeoutMs: Math.min(requestTimeoutMs, remainingMs),
    });
    queryCount += 1;
    candidates.push(...result.candidates);
    rateLimitRemaining = minNullable(rateLimitRemaining, result.rateLimit.remaining);
    rateLimitResetAt = result.rateLimit.resetAt ?? rateLimitResetAt;
    if (result.rateLimit.remaining === 0) break;
  }

  return {
    accountLogin,
    recommendations: rankRecommendationCandidates({
      accountLogin,
      candidates,
      seeds: options.seeds,
      excludedRepositoryKeys: options.excludedRepositoryKeys,
      fetchedAt,
    }),
    fetchedAt,
    seedCount: options.seeds.length,
    queryCount,
    rateLimitRemaining,
    rateLimitResetAt,
  };
}
