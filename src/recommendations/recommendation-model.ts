import type { RecommendationPresentation } from './recommendation-projector';

export const RECOMMENDATION_MAX_SEEDS = 12;
export const RECOMMENDATION_MAX_QUERIES = 6;
export const RECOMMENDATION_RESULTS_PER_QUERY = 100;
export const RECOMMENDATION_MAX_CANDIDATES = 60;

/** Canonical `owner/repo` identity shared by candidates, seeds, and ignore entries. */
export function canonicalRepositoryKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('/');
  if (
    parts.length !== 2
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(parts[0] ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(parts[1] ?? '')
  ) return null;
  return parts[0]!.toLocaleLowerCase('en-US') + '/' + parts[1]!.toLocaleLowerCase('en-US');
}

export type RecommendationSignalKind = 'topic' | 'language' | 'owner' | 'keyword' | 'name';

export type RecommendationSeed = Readonly<{
  repositoryKey: string;
  repositoryFullName: string;
  owner: string;
  name: string;
  language: string | null;
  topics: readonly string[];
  descriptionKeywords: readonly string[];
  starredAt: string;
  stargazerCount: number;
}>;

export type RecommendationQueryPlanItem = Readonly<{
  id: string;
  query: string;
  signalKind: RecommendationSignalKind;
  signalValue: string;
  seedRepositoryKeys: readonly string[];
}>;

export type RecommendationCandidate = Readonly<{
  repositoryKey: string;
  repositoryFullName: string;
  repositoryHtmlUrl: string;
  description: string;
  language: string | null;
  stargazerCount: number;
  topics: readonly string[];
  owner: string;
  name: string;
  pushedAt: string | null;
  createdAt: string | null;
  fork: boolean;
  archived: boolean;
}>;

export type RecommendationReason = Readonly<{
  kind: RecommendationSignalKind;
  value: string;
  seedRepositoryKey: string;
  seedRepositoryFullName: string;
}>;

export type RecommendationRecord = RecommendationCandidate & Readonly<{
  id: string;
  accountLogin: string;
  score: number;
  reason: RecommendationReason;
  fetchedAt: string;
}>;

/** A repository the account asked never to see in For You again. */
export type RecommendationIgnoreRecord = Readonly<{
  id: string;
  accountLogin: string;
  repositoryKey: string;
  repositoryFullName: string;
  ignoredAt: string;
}>;

export type RecommendationErrorCode =
  | 'authentication_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'request_aborted'
  | 'deadline_exceeded'
  | 'network_error'
  | 'github_unavailable'
  | 'invalid_content_type'
  | 'invalid_response'
  | 'invalid_candidate';

export class GitHubRecommendationError extends Error {
  readonly code: RecommendationErrorCode;
  readonly status?: number;
  readonly resetAt?: string;

  constructor(
    code: RecommendationErrorCode,
    options: { status?: number; resetAt?: string } = {},
  ) {
    super(code);
    this.name = 'GitHubRecommendationError';
    this.code = code;
    this.status = options.status;
    this.resetAt = options.resetAt;
  }
}

export interface RecommendationStateRecord {
  id: 'singleton';
  accountLogin: string;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  errorCode: RecommendationErrorCode | null;
  nextAllowedAt: string | null;
  candidateCount: number;
  seedCount: number;
  queryCount: number;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

export type RecommendationSnapshotStatus =
  | 'not_configured'
  | 'never_loaded'
  | 'fresh'
  | 'stale'
  | 'error'
  | 'cooldown';

export interface RecommendationStatus {
  accountLogin: string | null;
  hasMainToken: boolean;
  refreshing: boolean;
  snapshotStatus: RecommendationSnapshotStatus;
  errorCode: RecommendationErrorCode | null;
  state: RecommendationStateRecord | null;
}

export interface RecommendationQueryResponse {
  recommendations: RecommendationPresentation[];
  ignored: RecommendationIgnoreRecord[];
  status: RecommendationStatus;
}

export interface RecommendationRefreshResult {
  published: boolean;
  status: RecommendationStatus;
}

export interface RecommendationSourceSnapshot {
  accountLogin: string;
  recommendations: RecommendationRecord[];
  fetchedAt: string;
  seedCount: number;
  queryCount: number;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

function canonicalText(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeToken(value: string): string | null {
  const token = canonicalText(value);
  return /^[a-z0-9][a-z0-9_.-]{0,49}$/u.test(token) ? token : null;
}

function safeLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const language = canonicalText(value);
  return language.length > 0
    && language.length <= 50
    && !/[\u0000-\u001f\u007f]/u.test(language)
    ? language
    : null;
}

function splitRepositoryName(fullName: string): { owner: string; name: string } | null {
  const parts = fullName.trim().split('/');
  if (parts.length !== 2) return null;
  const owner = safeToken(parts[0] ?? '');
  const name = safeToken(parts[1] ?? '');
  return owner && name ? { owner, name } : null;
}

function repositoryKey(fullName: string): string | null {
  const parts = splitRepositoryName(fullName);
  return parts ? `${parts.owner}/${parts.name}` : null;
}

function normalizedTopics(value: readonly string[]): string[] {
  return [...new Set(value.flatMap((topic) => {
    if (typeof topic !== 'string') return [];
    const normalized = safeToken(topic);
    return normalized ? [normalized] : [];
  }))].sort((left, right) => left.localeCompare(right));
}

const MAX_DESCRIPTION_KEYWORDS = 6;
const DESCRIPTION_KEYWORD_STOP_WORDS = new Set([
  'about',
  'based',
  'build',
  'built',
  'from',
  'github',
  'into',
  'open',
  'project',
  'repository',
  'simple',
  'source',
  'that',
  'this',
  'using',
  'with',
  'your',
]);
const DESCRIPTION_KEYWORD_PATTERN = /[\p{L}\p{N}]{4,50}/gu;

function extractDescriptionKeywords(value: string): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const match of value.normalize('NFKC').toLocaleLowerCase('en-US').matchAll(DESCRIPTION_KEYWORD_PATTERN)) {
    const keyword = match[0];
    if (!keyword || DESCRIPTION_KEYWORD_STOP_WORDS.has(keyword) || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length === MAX_DESCRIPTION_KEYWORDS) break;
  }
  return keywords;
}

function searchQualifierValue(value: string): string {
  return /^[a-z0-9][a-z0-9_.+-]*$/u.test(value)
    ? value
    : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function normalizedLimit(value: number | undefined, maximum: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value as number, maximum)
    : 0;
}

export type RecommendationSeedInput = Readonly<{
  full_name: string;
  language: string | null;
  topics: readonly string[];
  description: string;
  starred_at: string;
  stargazers_count: number;
  tombstone: boolean;
  viewer_has_starred?: boolean;
}>;

/** Select diverse recent seeds without letting one language or owner monopolize the query plan. */
export function selectRecommendationSeeds(
  rows: readonly RecommendationSeedInput[],
  limit = RECOMMENDATION_MAX_SEEDS,
): RecommendationSeed[] {
  const target = normalizedLimit(limit, RECOMMENDATION_MAX_SEEDS);
  if (target === 0) return [];
  const candidates = rows.flatMap((row) => {
    if (row.tombstone || row.viewer_has_starred === false) return [];
    if (typeof row.full_name !== 'string' || typeof row.starred_at !== 'string') return [];
    const parts = splitRepositoryName(row.full_name);
    const key = repositoryKey(row.full_name);
    const starredAt = timestamp(row.starred_at);
    if (!parts || !key || starredAt === 0) return [];
    const language = safeLanguage(row.language);
    const topics = Array.isArray(row.topics) ? normalizedTopics(row.topics) : [];
    return [{
      repositoryKey: key,
      repositoryFullName: row.full_name.trim(),
      owner: parts.owner,
      name: parts.name,
      language,
      topics,
      descriptionKeywords: topics.length === 0 && typeof row.description === 'string'
        ? extractDescriptionKeywords(row.description)
        : [],
      starredAt: new Date(starredAt).toISOString(),
      stargazerCount: Number.isSafeInteger(row.stargazers_count) && row.stargazers_count >= 0
        ? row.stargazers_count
        : 0,
    } satisfies RecommendationSeed];
  }).sort((left, right) => (
    timestamp(right.starredAt) - timestamp(left.starredAt)
      || right.topics.length - left.topics.length
      || left.repositoryKey.localeCompare(right.repositoryKey)
  ));

  const selected: RecommendationSeed[] = [];
  const selectedKeys = new Set<string>();
  const languageCounts = new Map<string, number>();
  const ownerCounts = new Map<string, number>();
  const passes = [
    (seed: RecommendationSeed) => (seed.language ? languageCounts.get(seed.language) ?? 0 : 0) < 2
      && (ownerCounts.get(seed.owner) ?? 0) < 2,
    (seed: RecommendationSeed) => (ownerCounts.get(seed.owner) ?? 0) < 2,
    () => true,
  ];
  for (const accepts of passes) {
    for (const seed of candidates) {
      if (selected.length >= target) break;
      if (selectedKeys.has(seed.repositoryKey) || !accepts(seed)) continue;
      selected.push(seed);
      selectedKeys.add(seed.repositoryKey);
      if (seed.language) languageCounts.set(seed.language, (languageCounts.get(seed.language) ?? 0) + 1);
      ownerCounts.set(seed.owner, (ownerCounts.get(seed.owner) ?? 0) + 1);
    }
  }
  return selected;
}


type Signal = Readonly<{
  kind: RecommendationSignalKind;
  value: string;
  frequency: number;
  newestSeedAt: number;
  seedRepositoryKeys: readonly string[];
}>;

function buildSignals(seeds: readonly RecommendationSeed[]): Signal[] {
  const signals = new Map<string, { kind: RecommendationSignalKind; value: string; seedKeys: Set<string>; newest: number }>();
  const add = (kind: RecommendationSignalKind, value: string, seed: RecommendationSeed) => {
    const key = `${kind}:${value}`;
    const current = signals.get(key) ?? { kind, value, seedKeys: new Set<string>(), newest: 0 };
    current.seedKeys.add(seed.repositoryKey);
    current.newest = Math.max(current.newest, timestamp(seed.starredAt));
    signals.set(key, current);
  };
  for (const seed of seeds) {
    seed.topics.forEach((topic) => add('topic', topic, seed));
    if (seed.language) add('language', seed.language, seed);
    add('owner', seed.owner, seed);
    if (seed.topics.length === 0) {
      seed.descriptionKeywords.slice(0, 2).forEach((keyword) => add('keyword', keyword, seed));
    }
    const nameTokens = seed.name.split(/[-_.]+/u).filter((token) => token.length >= 4);
    nameTokens.slice(0, 2).forEach((token) => add('name', token, seed));
  }
  const kindPriority: Record<RecommendationSignalKind, number> = {
    topic: 0,
    language: 1,
    owner: 2,
    keyword: 3,
    name: 4,
  };
  return [...signals.values()].map((signal) => ({
    kind: signal.kind,
    value: signal.value,
    frequency: signal.seedKeys.size,
    newestSeedAt: signal.newest,
    seedRepositoryKeys: [...signal.seedKeys].sort((left, right) => left.localeCompare(right)),
  })).sort((left, right) => (
    kindPriority[left.kind] - kindPriority[right.kind]
      || right.frequency - left.frequency
      || right.newestSeedAt - left.newestSeedAt
      || left.value.localeCompare(right.value)
  ));
}


/** Turn selected seeds into a stable, bounded set of GitHub repository Search requests. */
export function buildRecommendationQueryPlan(
  seeds: readonly RecommendationSeed[],
  limit = RECOMMENDATION_MAX_QUERIES,
): RecommendationQueryPlanItem[] {
  const target = normalizedLimit(limit, RECOMMENDATION_MAX_QUERIES);
  if (target === 0) return [];
  const signals = buildSignals(seeds);
  const selected: Signal[] = [];
  const usedKinds = new Set<RecommendationSignalKind>();
  for (const signal of signals) {
    if (selected.length >= target) break;
    if (usedKinds.has(signal.kind)) continue;
    selected.push(signal);
    usedKinds.add(signal.kind);
  }
  for (const signal of signals) {
    if (selected.length >= target) break;
    if (selected.some((current) => current.kind === signal.kind && current.value === signal.value)) continue;
    selected.push(signal);
  }
  return selected.map((signal) => ({
    id: `${signal.kind}:${signal.value}`,
    query: queryForSignal(signal),
    signalKind: signal.kind,
    signalValue: signal.value,
    seedRepositoryKeys: signal.seedRepositoryKeys,
  }));
}

function queryForSignal(signal: Signal): string {
  const value = searchQualifierValue(signal.value);
  switch (signal.kind) {
    case 'topic': return `topic:${value} archived:false fork:false stars:>=10`;
    case 'language': return `language:${value} archived:false fork:false stars:>=25`;
    case 'owner': return `user:${value} archived:false fork:false stars:>=5`;
    case 'keyword': return `${value} in:name,description archived:false fork:false stars:>=10`;
    case 'name': return `${value} in:name archived:false fork:false stars:>=10`;
  }
}

type Similarity = Readonly<{
  score: number;
  reason: RecommendationReason;
}>;

type CandidateSimilaritySignals = Readonly<{
  topics: ReadonlySet<string>;
  keywords: ReadonlySet<string>;
  nameTokens: readonly string[];
}>;

function candidateSimilaritySignals(candidate: RecommendationCandidate): CandidateSimilaritySignals {
  const keywords = new Set(extractDescriptionKeywords(candidate.description));
  for (const keyword of extractDescriptionKeywords(candidate.name)) keywords.add(keyword);
  return {
    topics: new Set(candidate.topics.map(canonicalText)),
    keywords,
    nameTokens: candidate.name.split(/[-_.]+/u),
  };
}

function similarity(
  candidate: RecommendationCandidate,
  seed: RecommendationSeed,
  signals: CandidateSimilaritySignals,
): Similarity {
  const sharedTopics = seed.topics.filter((topic) => signals.topics.has(topic));
  if (sharedTopics.length > 0) {
    return {
      score: 80 + Math.min(sharedTopics.length, 3) * 12,
      reason: {
        kind: 'topic',
        value: sharedTopics[0]!,
        seedRepositoryKey: seed.repositoryKey,
        seedRepositoryFullName: seed.repositoryFullName,
      },
    };
  }
  if (candidate.language && seed.language && canonicalText(candidate.language) === seed.language) {
    return {
      score: 50,
      reason: {
        kind: 'language',
        value: seed.language,
        seedRepositoryKey: seed.repositoryKey,
        seedRepositoryFullName: seed.repositoryFullName,
      },
    };
  }
  if (candidate.owner === seed.owner) {
    return {
      score: 38,
      reason: {
        kind: 'owner',
        value: seed.owner,
        seedRepositoryKey: seed.repositoryKey,
        seedRepositoryFullName: seed.repositoryFullName,
      },
    };
  }
  if (seed.topics.length === 0) {
    const sharedKeywords = seed.descriptionKeywords.filter((keyword) => signals.keywords.has(keyword));
    if (sharedKeywords.length > 0) {
      return {
        score: 30 + Math.min(sharedKeywords.length, 3) * 2,
        reason: {
          kind: 'keyword',
          value: sharedKeywords[0]!,
          seedRepositoryKey: seed.repositoryKey,
          seedRepositoryFullName: seed.repositoryFullName,
        },
      };
    }
  }
  const seedName = seed.name.split(/[-_.]+/u);
  const sharedName = seedName.find((part) => part.length >= 4 && signals.nameTokens.includes(part));
  return {
    score: sharedName ? 22 : 0,
    reason: {
      kind: 'name',
      value: sharedName ?? seed.name,
      seedRepositoryKey: seed.repositoryKey,
      seedRepositoryFullName: seed.repositoryFullName,
    },
  };
}

function auxiliaryScore(candidate: RecommendationCandidate, nowMillis: number): number {
  const popularity = Math.min(24, Math.log10(candidate.stargazerCount + 1) * 6);
  const pushedAt = timestamp(candidate.pushedAt);
  const ageDays = pushedAt > 0 ? Math.max(0, (nowMillis - pushedAt) / 86_400_000) : 3650;
  const freshness = Math.max(0, 18 - Math.log2(ageDays + 1) * 3);
  return popularity + freshness;
}

type RawRecommendationCandidate = Readonly<{
  candidate: RecommendationCandidate;
  rawScore: number;
  strongestRelationships: readonly Similarity[];
}>;

function compareRecommendationReasons(left: Similarity, right: Similarity): number {
  return left.reason.seedRepositoryKey.localeCompare(right.reason.seedRepositoryKey)
    || left.reason.seedRepositoryFullName.localeCompare(right.reason.seedRepositoryFullName)
    || left.reason.kind.localeCompare(right.reason.kind)
    || left.reason.value.localeCompare(right.reason.value);
}

function compareRawRecommendationCandidates(
  left: RawRecommendationCandidate,
  right: RawRecommendationCandidate,
): number {
  return right.rawScore - left.rawScore
    || right.candidate.stargazerCount - left.candidate.stargazerCount
    || left.candidate.repositoryKey.localeCompare(right.candidate.repositoryKey);
}

export function rankRecommendationCandidates(input: Readonly<{
  accountLogin: string;
  candidates: readonly RecommendationCandidate[];
  seeds: readonly RecommendationSeed[];
  excludedRepositoryKeys: ReadonlySet<string>;
  fetchedAt: string;
  limit?: number;
}>): RecommendationRecord[] {
  const fetchedAtMillis = timestamp(input.fetchedAt);
  const accountLogin = canonicalText(input.accountLogin);
  const target = normalizedLimit(
    input.limit ?? RECOMMENDATION_MAX_CANDIDATES,
    RECOMMENDATION_MAX_CANDIDATES,
  );
  if (!accountLogin || fetchedAtMillis === 0 || target === 0) return [];
  const deduped = new Map<string, RecommendationCandidate>();
  for (const candidate of input.candidates) {
    if (candidate.archived || candidate.fork || input.excludedRepositoryKeys.has(candidate.repositoryKey)) continue;
    if (!deduped.has(candidate.repositoryKey)) deduped.set(candidate.repositoryKey, candidate);
  }

  const rawCandidates: RawRecommendationCandidate[] = [];
  for (const candidate of deduped.values()) {
    const signals = candidateSimilaritySignals(candidate);
    let strongestScore = 0;
    const strongestRelationships: Similarity[] = [];
    for (const seed of input.seeds) {
      const relationship = similarity(candidate, seed, signals);
      if (relationship.score > strongestScore) {
        strongestScore = relationship.score;
        strongestRelationships.length = 0;
        strongestRelationships.push(relationship);
      } else if (relationship.score === strongestScore && relationship.score > 0) {
        strongestRelationships.push(relationship);
      }
    }
    if (strongestRelationships.length === 0) continue;
    rawCandidates.push({
      candidate,
      rawScore: Number((strongestScore + auxiliaryScore(candidate, fetchedAtMillis)).toFixed(3)),
      strongestRelationships: strongestRelationships.sort(compareRecommendationReasons),
    });
  }

  rawCandidates.sort(compareRawRecommendationCandidates);
  if (rawCandidates.length > target) rawCandidates.length = target;
  const assignmentsBySeed = new Map<string, number>();
  const multipleSeeds = input.seeds.length > 1;
  const recommendations: RecommendationRecord[] = [];
  for (const rawCandidate of rawCandidates) {
    let relationship = rawCandidate.strongestRelationships[0]!;
    for (let index = 1; index < rawCandidate.strongestRelationships.length; index += 1) {
      const next = rawCandidate.strongestRelationships[index]!;
      const currentAssignments = assignmentsBySeed.get(relationship.reason.seedRepositoryKey) ?? 0;
      const nextAssignments = assignmentsBySeed.get(next.reason.seedRepositoryKey) ?? 0;
      if (
        nextAssignments < currentAssignments
        || (nextAssignments === currentAssignments && compareRecommendationReasons(next, relationship) < 0)
      ) relationship = next;
    }
    const seedRepositoryKey = relationship.reason.seedRepositoryKey;
    const assignmentCount = (assignmentsBySeed.get(seedRepositoryKey) ?? 0) + 1;
    assignmentsBySeed.set(seedRepositoryKey, assignmentCount);
    const repeatPenalty = multipleSeeds
      ? Math.min(40, Math.max(0, assignmentCount - 3) * 5)
      : 0;
    recommendations.push({
      ...rawCandidate.candidate,
      id: rawCandidate.candidate.repositoryKey,
      accountLogin,
      score: Number(Math.max(0, rawCandidate.rawScore - repeatPenalty).toFixed(3)),
      reason: relationship.reason,
      fetchedAt: new Date(fetchedAtMillis).toISOString(),
    });
  }
  return recommendations.sort((left, right) => (
    right.score - left.score
      || right.stargazerCount - left.stargazerCount
      || left.repositoryKey.localeCompare(right.repositoryKey)
  ));
}
