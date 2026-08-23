import {
  dedupeRadarActivities,
  GitHubRadarError,
  normalizeRadarActivity,
  RADAR_MAX_FOLLOWING,
  RADAR_STARS_PER_FOLLOWER,
  type RadarActivityRecord,
  type RadarPartialReason,
  type RadarRefreshMode,
} from '@/radar/radar-model';
import type { RadarSourceSnapshot } from '@/radar/radar-contract';
import { DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS } from '@/preferences';

export const RADAR_INCREMENTAL_LOOKBACK_DAYS = 7 as const;

const GRAPHQL_URL = 'https://api.github.com/graphql';
const FOLLOWING_PAGE_SIZE = 100;
const DEFAULT_MAX_FOLLOWING = RADAR_MAX_FOLLOWING;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_STARS_PER_FOLLOWER = RADAR_STARS_PER_FOLLOWER;
const DEFAULT_RATE_LIMIT_LOW_WATER = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_DEADLINE_MS = 120_000;
const REQUEST_MAX_ATTEMPTS = 3;
const REQUEST_RETRY_BASE_DELAY_MS = 500;

const FOLLOWING_QUERY = `
  query RadarFollowing($cursor: String) {
    viewer {
      login
      following(first: ${FOLLOWING_PAGE_SIZE}, after: $cursor) {
        totalCount
        nodes { login }
        pageInfo { hasNextPage endCursor }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

type FetchLike = typeof fetch;

type GraphqlRateLimit = {
  remaining: number | null;
  resetAt: string | null;
};

type FollowingPage = GraphqlRateLimit & {
  accountLogin: string;
  logins: string[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
};

type ActivityPageTarget = Readonly<{
  login: string;
  cursor: string | null;
}>;

type ActivityBatch = GraphqlRateLimit & {
  activities: RadarActivityRecord[];
  continuations: ActivityPageTarget[];
  skippedTargets: ActivityPageTarget[];
  privateActivityOmitted: boolean;
};

export interface FetchGitHubRadarOptions {
  token: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  signal?: AbortSignal;
  windowDays?: number;
  refreshMode?: RadarRefreshMode;
  lookbackDays?: number;
  maxFollowing?: number;
  batchSize?: number;
  starsPerFollower?: number;
  rateLimitLowWater?: number;
  requestTimeoutMs?: number;
  deadlineMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return nonEmptyString(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseResetAt(value: unknown): string | null {
  const text = nullableString(value);
  if (!text) return null;
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function graphqlErrorTypes(error: Record<string, unknown>): string[] {
  const extensions = record(error.extensions);
  return [nonEmptyString(error.type), nonEmptyString(extensions?.type)].filter(
    (value): value is string => value !== null,
  );
}

function classifyGraphqlErrors(errors: readonly unknown[]): GitHubRadarError {
  if (errors.length === 0) return new GitHubRadarError('invalid_response');

  const types = errors.flatMap((item) => {
    const error = record(item);
    return error ? graphqlErrorTypes(error) : [];
  });

  if (types.some((type) => /RATE_LIMIT/iu.test(type))) {
    return new GitHubRadarError('rate_limited');
  }
  if (types.some((type) => /FORBIDDEN|INSUFFICIENT|ACCESS/iu.test(type))) {
    return new GitHubRadarError('permission_denied');
  }
  return new GitHubRadarError('invalid_response');
}

function recoverableMissingActivityIndexes(
  errors: readonly unknown[],
  targetCount: number,
): Set<number> | null {
  const indexes = new Set<number>();
  for (const item of errors) {
    const error = record(item);
    const types = error ? graphqlErrorTypes(error) : [];
    const path = error?.path;
    if (
      types.length === 0
      || types.some((type) => type.toUpperCase() !== 'NOT_FOUND')
      || !Array.isArray(path)
      || path.length === 0
      || path.some((segment) => typeof segment !== 'string'
        && !(typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0))
    ) return null;

    const alias = path[0];
    const match = typeof alias === 'string' ? /^follower(0|[1-9]\d*)$/u.exec(alias) : null;
    const index = match ? Number(match[1]) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= targetCount) return null;
    indexes.add(index);
  }
  return indexes.size > 0 ? indexes : null;
}

function headerRateLimit(response: Response): GraphqlRateLimit {
  const remainingText = response.headers.get('x-ratelimit-remaining');
  const parsedRemaining = remainingText === null ? Number.NaN : Number(remainingText);
  const resetText = response.headers.get('x-ratelimit-reset');
  const resetEpoch = resetText === null ? Number.NaN : Number(resetText);
  return {
    remaining: Number.isSafeInteger(parsedRemaining) && parsedRemaining >= 0
      ? parsedRemaining
      : null,
    resetAt: Number.isFinite(resetEpoch) && resetEpoch > 0
      ? new Date(resetEpoch * 1_000).toISOString()
      : null,
  };
}

function responseError(response: Response): GitHubRadarError {
  const rateLimit = headerRateLimit(response);
  if (response.status === 401) {
    return new GitHubRadarError('authentication_required', { status: response.status });
  }
  if (response.status === 429 || (response.status === 403 && rateLimit.remaining === 0)) {
    return new GitHubRadarError('rate_limited', {
      status: response.status,
      resetAt: rateLimit.resetAt ?? undefined,
    });
  }
  if (response.status === 403) {
    return new GitHubRadarError('permission_denied', { status: response.status });
  }
  if (response.status >= 500) {
    return new GitHubRadarError('github_unavailable', { status: response.status });
  }
  return new GitHubRadarError('invalid_response', { status: response.status });
}

async function retryTransientRequest<T>(
  request: () => Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const retryable = error instanceof GitHubRadarError
        && (error.code === 'github_unavailable' || error.code === 'network_error');
      if (!retryable || attempt === REQUEST_MAX_ATTEMPTS) throw error;

      if (signal?.aborted) throw new GitHubRadarError('request_aborted');
      const retryDelayMs = REQUEST_RETRY_BASE_DELAY_MS * attempt;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new GitHubRadarError('deadline_exceeded');
      const waitEndsAtDeadline = remainingMs <= retryDelayMs;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new GitHubRadarError('request_aborted'));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          if (waitEndsAtDeadline) reject(new GitHubRadarError('deadline_exceeded'));
          else resolve();
        }, Math.min(retryDelayMs, remainingMs));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  throw new GitHubRadarError('github_unavailable');
}

async function fetchGraphql(
  fetchImpl: FetchLike,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{
  data: Record<string, unknown>;
  errors: readonly unknown[];
  rateLimit: GraphqlRateLimit;
}> {
  if (options.signal?.aborted) throw new GitHubRadarError('request_aborted');
  const controller = new AbortController();
  let requestTimedOut = false;
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, options.timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (error) {
    if (requestTimedOut) throw new GitHubRadarError('deadline_exceeded');
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new GitHubRadarError('request_aborted');
    }
    throw new GitHubRadarError('network_error');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) throw responseError(response);
  const contentType = response.headers.get('content-type')?.toLocaleLowerCase('en-US') ?? '';
  if (!contentType.includes('json')) throw new GitHubRadarError('invalid_content_type');

  let envelope: Record<string, unknown>;
  try {
    const parsed = record(await response.json());
    if (!parsed) throw new GitHubRadarError('invalid_response');
    envelope = parsed;
  } catch (error) {
    if (error instanceof GitHubRadarError) throw error;
    throw new GitHubRadarError('invalid_response');
  }

  const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
  const data = record(envelope.data);
  if (!data) {
    if (errors.length > 0) throw classifyGraphqlErrors(errors);
    throw new GitHubRadarError('invalid_response');
  }
  return { data, errors, rateLimit: headerRateLimit(response) };
}

function parseRateLimit(
  data: Record<string, unknown>,
  fallback: GraphqlRateLimit,
): GraphqlRateLimit {
  const value = record(data.rateLimit);
  return {
    remaining: nonNegativeInteger(value?.remaining) ?? fallback.remaining,
    resetAt: parseResetAt(value?.resetAt) ?? fallback.resetAt,
  };
}

async function fetchFollowingPage(
  fetchImpl: FetchLike,
  token: string,
  cursor: string | null,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<FollowingPage> {
  const result = await fetchGraphql(fetchImpl, token, FOLLOWING_QUERY, { cursor }, options);
  if (result.errors.length > 0) throw classifyGraphqlErrors(result.errors);
  const viewer = record(result.data.viewer);
  const accountLogin = nonEmptyString(viewer?.login);
  const following = record(viewer?.following);
  const totalCount = nonNegativeInteger(following?.totalCount);
  const nodes = following?.nodes;
  const pageInfo = record(following?.pageInfo);
  if (!accountLogin || totalCount === null || !Array.isArray(nodes) || !pageInfo) {
    throw new GitHubRadarError('invalid_response');
  }

  const logins = nodes.map((node) => nonEmptyString(record(node)?.login));
  if (logins.some((login) => login === null)) throw new GitHubRadarError('invalid_response');
  const hasNextPage = pageInfo.hasNextPage;
  const endCursor = nullableString(pageInfo.endCursor);
  if (typeof hasNextPage !== 'boolean' || (hasNextPage && endCursor === null)) {
    throw new GitHubRadarError('invalid_pagination');
  }

  return {
    accountLogin,
    logins: logins as string[],
    totalCount,
    hasNextPage,
    endCursor,
    ...parseRateLimit(result.data, result.rateLimit),
  };
}

function buildActivityBatchQuery(count: number, starsPerFollower: number): string {
  const variables = Array.from({ length: count }, (_, index) => (
    `$login${index}: String!, $cursor${index}: String`
  )).join(', ');
  const aliases = Array.from({ length: count }, (_, index) => `
    follower${index}: user(login: $login${index}) {
      login
      avatarUrl
      starredRepositories(
        first: ${starsPerFollower}
        after: $cursor${index}
        orderBy: { field: STARRED_AT, direction: DESC }
      ) {
        edges {
          starredAt
          node {
            nameWithOwner
            owner { login avatarUrl }
            description
            isPrivate
            stargazerCount
            viewerHasStarred
            primaryLanguage { name color }
            repositoryTopics(first: 20) { nodes { topic { name } } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `).join('\n');

  return `query RadarActivityBatch(${variables}) {\n${aliases}\nrateLimit { remaining resetAt }\n}`;
}

function parseActivityBatch(
  data: Record<string, unknown>,
  fallbackRateLimit: GraphqlRateLimit,
  accountLogin: string,
  targets: readonly ActivityPageTarget[],
  cutoffMillis: number,
  skippedIndexes: ReadonlySet<number>,
): ActivityBatch {
  const activities: RadarActivityRecord[] = [];
  const continuations: ActivityPageTarget[] = [];
  let privateActivityOmitted = false;

  for (let index = 0; index < targets.length; index += 1) {
    if (skippedIndexes.has(index)) continue;
    const userValue = data[`follower${index}`];
    if (userValue === null) continue;
    const user = record(userValue);
    const actorLogin = nonEmptyString(user?.login);
    const actorAvatarUrl = nullableString(user?.avatarUrl);
    const connection = record(user?.starredRepositories);
    const edges = connection?.edges;
    const pageInfo = record(connection?.pageInfo);
    if (!actorLogin || !Array.isArray(edges) || !pageInfo || typeof pageInfo.hasNextPage !== 'boolean') {
      throw new GitHubRadarError('invalid_response', { batch: index });
    }

    const endCursor = nullableString(pageInfo.endCursor);
    if (pageInfo.hasNextPage && endCursor === null) {
      throw new GitHubRadarError('invalid_pagination', { batch: index });
    }

    let oldestReturnedMillis = Number.POSITIVE_INFINITY;
    for (const edgeValue of edges) {
      const edge = record(edgeValue);
      const starredAt = nonEmptyString(edge?.starredAt);
      const starredAtMillis = starredAt ? Date.parse(starredAt) : Number.NaN;
      const repository = record(edge?.node);
      if (!starredAt || !Number.isFinite(starredAtMillis) || !repository) {
        throw new GitHubRadarError('invalid_activity', { batch: index });
      }
      oldestReturnedMillis = Math.min(oldestReturnedMillis, starredAtMillis);
      if (starredAtMillis < cutoffMillis) continue;
      if (repository.isPrivate === true) {
        privateActivityOmitted = true;
        continue;
      }
      if (repository.isPrivate !== false) {
        throw new GitHubRadarError('invalid_activity', { batch: index });
      }
      const language = record(repository.primaryLanguage);
      const repositoryOwner = record(repository.owner);
      const repositoryTopics = record(repository.repositoryTopics);
      const repositoryTopicNodes = repositoryTopics?.nodes;
      if (!Array.isArray(repositoryTopicNodes)) {
        throw new GitHubRadarError('invalid_activity', { batch: index });
      }
      const repositoryTopicNames = repositoryTopicNodes.map((nodeValue) => {
        const node = record(nodeValue);
        const topic = record(node?.topic);
        return nonEmptyString(topic?.name);
      });
      if (repositoryTopicNames.some((name) => name === null)) {
        throw new GitHubRadarError('invalid_activity', { batch: index });
      }
      activities.push(normalizeRadarActivity({
        actorLogin,
        actorAvatarUrl,
        repositoryFullName: repository.nameWithOwner,
        repositoryDescription: typeof repository.description === 'string'
          ? repository.description
          : '',
        repositoryLanguage: language?.name ?? null,
        repositoryLanguageColor: language?.color ?? null,
        repositoryOwnerLogin: typeof repositoryOwner?.login === 'string'
          ? repositoryOwner.login
          : null,
        repositoryOwnerAvatarUrl: typeof repositoryOwner?.avatarUrl === 'string'
          ? repositoryOwner.avatarUrl
          : null,
        repositoryTopics: repositoryTopicNames,
        repositoryStargazerCount: repository.stargazerCount,
        viewerHadStarred: repository.viewerHasStarred,
        starredAt,
      }, { accountLogin }));
    }

    if (
      pageInfo.hasNextPage
      && (edges.length === 0 || oldestReturnedMillis >= cutoffMillis)
    ) {
      const currentCursor = targets[index]?.cursor ?? null;
      if (endCursor === currentCursor) {
        throw new GitHubRadarError('invalid_pagination', { batch: index });
      }
      continuations.push({ login: actorLogin, cursor: endCursor });
    }
  }

  return {
    activities,
    continuations,
    skippedTargets: targets.filter((_, index) => skippedIndexes.has(index)),
    privateActivityOmitted,
    ...parseRateLimit(data, fallbackRateLimit),
  };
}

async function fetchActivityBatch(
  fetchImpl: FetchLike,
  token: string,
  accountLogin: string,
  targets: readonly ActivityPageTarget[],
  starsPerFollower: number,
  cutoffMillis: number,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ActivityBatch> {
  const variables = Object.fromEntries(targets.flatMap((target, index) => [
    [`login${index}`, target.login],
    [`cursor${index}`, target.cursor],
  ]));
  const result = await fetchGraphql(
    fetchImpl,
    token,
    buildActivityBatchQuery(targets.length, starsPerFollower),
    variables,
    options,
  );
  const skippedIndexes = result.errors.length === 0
    ? new Set<number>()
    : recoverableMissingActivityIndexes(result.errors, targets.length);
  if (skippedIndexes === null) throw classifyGraphqlErrors(result.errors);
  return parseActivityBatch(
    result.data,
    result.rateLimit,
    accountLogin,
    targets,
    cutoffMillis,
    skippedIndexes,
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function minNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}
function addPendingActivityReasons(
  pending: readonly ActivityPageTarget[],
  partialReasons: Set<RadarPartialReason>,
): void {
  if (pending.some((target) => target.cursor === null)) {
    partialReasons.add('following_scan_truncated');
  }
  if (pending.some((target) => target.cursor !== null)) {
    partialReasons.add('github_star_list_truncated');
  }
}
/** Fetch the latest public star activity of followed GitHub users. */
export async function fetchGitHubRadar(
  options: FetchGitHubRadarOptions,
): Promise<RadarSourceSnapshot> {
  const token = options.token.trim();
  if (!token) throw new GitHubRadarError('authentication_required');

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now?.() ?? new Date();
  const nowMillis = now.getTime();
  if (!Number.isFinite(nowMillis)) throw new GitHubRadarError('invalid_response');
  const windowDays = positiveInteger(options.windowDays, DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS);
  const refreshMode: RadarRefreshMode = options.refreshMode === 'incremental' ? 'incremental' : 'full';
  const lookbackDays = refreshMode === 'incremental'
    ? RADAR_INCREMENTAL_LOOKBACK_DAYS
    : windowDays;
  const maxFollowing = positiveInteger(options.maxFollowing, DEFAULT_MAX_FOLLOWING);
  const batchSize = Math.min(
    positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE),
    DEFAULT_BATCH_SIZE,
  );
  const starsPerFollower = Math.min(
    positiveInteger(options.starsPerFollower, DEFAULT_STARS_PER_FOLLOWER),
    RADAR_STARS_PER_FOLLOWER,
  );
  const rateLimitLowWater = positiveInteger(
    options.rateLimitLowWater,
    DEFAULT_RATE_LIMIT_LOW_WATER,
  );
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const deadlineAt = Date.now() + positiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS);
  const requestOptions = () => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new GitHubRadarError('deadline_exceeded');
    return {
      signal: options.signal,
      timeoutMs: Math.min(requestTimeoutMs, remainingMs),
    };
  };

  const followingLogins: string[] = [];
  let accountLogin: string | null = null;
  let followingCount = 0;
  let cursor: string | null = null;
  let hasNextPage = true;
  let rateLimitRemaining: number | null = null;
  let rateLimitResetAt: string | null = null;
  const partialReasons = new Set<RadarPartialReason>();

  while (hasNextPage && followingLogins.length < maxFollowing) {
    const page = await retryTransientRequest(
      () => fetchFollowingPage(fetchImpl, token, cursor, requestOptions()),
      deadlineAt,
      options.signal,
    );
    if (accountLogin !== null && accountLogin !== page.accountLogin) {
      throw new GitHubRadarError('invalid_response');
    }
    accountLogin = page.accountLogin;
    followingCount = page.totalCount;
    followingLogins.push(...page.logins.slice(0, maxFollowing - followingLogins.length));
    rateLimitRemaining = minNullable(rateLimitRemaining, page.remaining);
    rateLimitResetAt = page.resetAt ?? rateLimitResetAt;
    hasNextPage = page.hasNextPage;
    cursor = page.endCursor;
    if (page.remaining !== null && page.remaining <= rateLimitLowWater && hasNextPage) break;
  }

  if (hasNextPage || followingLogins.length < followingCount) {
    partialReasons.add('following_scan_truncated');
  }
  if (accountLogin === null) throw new GitHubRadarError('invalid_response');

  const cutoffMillis = nowMillis - lookbackDays * 24 * 60 * 60 * 1_000;
  const activities: RadarActivityRecord[] = [];
  let batchCount = 0;
  let scannedFollowingCount = 0;

  const pendingActivityPages: ActivityPageTarget[] = followingLogins.map((login) => ({
    login,
    cursor: null,
  }));
  const seenContinuationPages = new Set<string>();
  let offset = 0;
  while (offset < pendingActivityPages.length) {
    const pending = pendingActivityPages.slice(offset);
    if (rateLimitRemaining !== null && rateLimitRemaining <= rateLimitLowWater) {
      addPendingActivityReasons(pending, partialReasons);
      break;
    }

    const targets = pending.slice(0, batchSize);
    let batch: ActivityBatch;
    try {
      batch = await retryTransientRequest(
        () => fetchActivityBatch(
          fetchImpl,
          token,
          accountLogin,
          targets,
          starsPerFollower,
          cutoffMillis,
          requestOptions(),
        ),
        deadlineAt,
        options.signal,
      );
    } catch (error) {
      if (error instanceof GitHubRadarError && error.code === 'deadline_exceeded') {
        addPendingActivityReasons(pending, partialReasons);
        break;
      }
      throw error;
    }

    offset += targets.length;
    activities.push(...batch.activities);
    batchCount += 1;
    scannedFollowingCount += targets.filter((target) => (
      target.cursor === null && !batch.skippedTargets.includes(target)
    )).length;
    rateLimitRemaining = minNullable(rateLimitRemaining, batch.remaining);
    rateLimitResetAt = batch.resetAt ?? rateLimitResetAt;
    if (batch.privateActivityOmitted) partialReasons.add('private_activity_omitted');
    addPendingActivityReasons(batch.skippedTargets, partialReasons);

    for (const continuation of batch.continuations) {
      const identity = JSON.stringify([
        continuation.login.toLocaleLowerCase('en-US'),
        continuation.cursor,
      ]);
      if (seenContinuationPages.has(identity)) {
        throw new GitHubRadarError('invalid_pagination');
      }
      seenContinuationPages.add(identity);
      pendingActivityPages.push(continuation);
    }
  }

  return {
    accountLogin: accountLogin.toLocaleLowerCase('en-US'),
    windowDays,
    refreshMode,
    lookbackDays,
    activities: dedupeRadarActivities(activities),
    fetchedAt: now.toISOString(),
    followingCount,
    scannedFollowingCount,
    batchCount,
    partialReasons: [
      'github_star_list_truncated',
      'private_activity_omitted',
      'following_scan_truncated',
    ].filter((reason): reason is RadarPartialReason => partialReasons.has(reason as RadarPartialReason)),
    rateLimitRemaining,
    rateLimitResetAt,
  };
}
