import { isRunId, type RunId } from './identity';

declare const scopeTokenBrand: unique symbol;
declare const scopeFingerprintBrand: unique symbol;

export type PreflightToken = string & {
  readonly [scopeTokenBrand]: 'PreflightToken';
};
export type ContinuationCursorToken = string & {
  readonly [scopeTokenBrand]: 'ContinuationCursorToken';
};
export type ScopeFingerprintV1 = string & {
  readonly [scopeFingerprintBrand]: 'ScopeFingerprintV1';
};

export const PREFLIGHT_TOKEN_PREFIX = 'preflight:v1:';
export const CONTINUATION_CURSOR_TOKEN_PREFIX = 'cursor:v1:';
export const SCOPE_FINGERPRINT_PREFIX = 'fs:v1:';

export const FROZEN_SCOPE_KINDS = Object.freeze([
  'selected_repository',
  'current_view',
  'all_live_stars',
  'result_subset',
  'still_untagged_after_auto_tags',
] as const);

export type FrozenScopeKind = typeof FROZEN_SCOPE_KINDS[number];

export const CURRENT_VIEW_SORT_KEYS = Object.freeze([
  'starred_at',
  'pushed_at',
  'created_at',
  'stargazers_count',
  'name',
] as const);
export type CurrentViewSortKey = typeof CURRENT_VIEW_SORT_KEYS[number];

export type CurrentViewCandidateFilter = Readonly<{
  query: string;
  languages: readonly string[];
  tags: readonly string[];
  tagMode: 'any' | 'all';
  showTombstone: boolean;
  onlyFavorite: boolean;
  onlyUntagged: boolean;
  onlyArchived: boolean;
  sortKey: CurrentViewSortKey;
  sortDir: 'asc' | 'desc';
}>;

export type LaunchCandidateContract =
  | Readonly<{ kind: 'selected_repository'; selectedRepositoryIdHint: string }>
  | Readonly<{ kind: 'current_view'; filter: CurrentViewCandidateFilter }>
  | Readonly<{ kind: 'all_live_stars' }>
  | Readonly<{ kind: 'result_subset'; sourceRunId: RunId; sourceGeneration: number }>
  | Readonly<{ kind: 'still_untagged_after_auto_tags' }>;

export type FrozenScope = Readonly<{
  version: 1;
  kind: FrozenScopeKind;
  label: string;
  filterSnapshot: string;
  repositoryIds: readonly string[];
  count: number;
  capturedAt: number;
  fingerprint: ScopeFingerprintV1;
}>;

export type FrozenScopeProjection = Readonly<{
  version: 1;
  kind: FrozenScopeKind;
  label: string;
  count: number;
  capturedAt: number;
  fingerprint: ScopeFingerprintV1;
}>;

export type FrozenScopeCursor = Readonly<{
  runId: RunId;
  generation: number;
  nextFrozenIndex: number;
}>;

export function parsePreflightToken(value: string): PreflightToken {
  return parseToken(value, PREFLIGHT_TOKEN_PREFIX, 'preflightToken');
}

export function parseContinuationCursorToken(value: string): ContinuationCursorToken {
  return parseToken(value, CONTINUATION_CURSOR_TOKEN_PREFIX, 'continuationCursorToken');
}

export function parseScopeFingerprintV1(value: string): ScopeFingerprintV1 {
  if (!isScopeFingerprintV1(value)) {
    throw new TypeError('FrozenScope fingerprint must be fs:v1:<base64url SHA-256>.');
  }
  return value;
}

export function isPreflightToken(value: unknown): value is PreflightToken {
  return isPrefixedToken(value, PREFLIGHT_TOKEN_PREFIX);
}

export function isContinuationCursorToken(value: unknown): value is ContinuationCursorToken {
  return isPrefixedToken(value, CONTINUATION_CURSOR_TOKEN_PREFIX);
}

export function isScopeFingerprintV1(value: unknown): value is ScopeFingerprintV1 {
  return typeof value === 'string' && /^fs:v1:[A-Za-z0-9_-]{43}$/u.test(value);
}

export function createFrozenScope(input: Readonly<{
  kind: FrozenScopeKind;
  label: string;
  filterSnapshot: string;
  repositoryIds: readonly string[];
  capturedAt: number;
  fingerprint: ScopeFingerprintV1;
}>): FrozenScope {
  if (!FROZEN_SCOPE_KINDS.includes(input.kind)) throw new TypeError('Unsupported FrozenScope kind.');
  assertTrimmedNonempty(input.label, 'FrozenScope label');
  if (typeof input.filterSnapshot !== 'string') {
    throw new TypeError('FrozenScope filterSnapshot must be a string.');
  }
  assertNonnegativeSafeInteger(input.capturedAt, 'FrozenScope capturedAt');
  if (!isScopeFingerprintV1(input.fingerprint)) {
    throw new TypeError('FrozenScope fingerprint is malformed.');
  }
  const repositoryIds = deduplicateRepositoryIds(input.repositoryIds);
  if (repositoryIds.length === 0) throw new TypeError('FrozenScope cannot be empty.');
  return Object.freeze({
    version: 1,
    kind: input.kind,
    label: input.label,
    filterSnapshot: input.filterSnapshot,
    repositoryIds: Object.freeze(repositoryIds),
    count: repositoryIds.length,
    capturedAt: input.capturedAt,
    fingerprint: input.fingerprint,
  });
}

export function validateFrozenScope(value: unknown): asserts value is FrozenScope {
  if (!isRecord(value)) throw new TypeError('FrozenScope must be an object.');
  assertExactKeys(value, [
    'version',
    'kind',
    'label',
    'filterSnapshot',
    'repositoryIds',
    'count',
    'capturedAt',
    'fingerprint',
  ]);
  if (value.version !== 1) throw new TypeError('FrozenScope version must be 1.');
  if (!FROZEN_SCOPE_KINDS.includes(value.kind as FrozenScopeKind)) {
    throw new TypeError('Unsupported FrozenScope kind.');
  }
  assertTrimmedNonempty(value.label, 'FrozenScope label');
  if (typeof value.filterSnapshot !== 'string') {
    throw new TypeError('FrozenScope filterSnapshot must be a string.');
  }
  if (!Array.isArray(value.repositoryIds) || value.repositoryIds.length === 0) {
    throw new TypeError('FrozenScope repositoryIds must be a nonempty array.');
  }
  const deduplicated = deduplicateRepositoryIds(value.repositoryIds);
  if (deduplicated.length !== value.repositoryIds.length) {
    throw new TypeError('FrozenScope repositoryIds must already be ordered and deduplicated.');
  }
  assertNonnegativeSafeInteger(value.count, 'FrozenScope count');
  if (value.count !== value.repositoryIds.length) {
    throw new TypeError('FrozenScope count must be derived from repositoryIds.');
  }
  assertNonnegativeSafeInteger(value.capturedAt, 'FrozenScope capturedAt');
  if (!isScopeFingerprintV1(value.fingerprint)) {
    throw new TypeError('FrozenScope fingerprint is malformed.');
  }
}

export function projectFrozenScope(scope: FrozenScope): FrozenScopeProjection {
  validateFrozenScope(scope);
  return Object.freeze({
    version: scope.version,
    kind: scope.kind,
    label: scope.label,
    count: scope.count,
    capturedAt: scope.capturedAt,
    fingerprint: scope.fingerprint,
  });
}

export function validateFrozenScopeProjection(
  value: unknown,
): asserts value is FrozenScopeProjection {
  if (!isRecord(value)) throw new TypeError('FrozenScope projection must be an object.');
  assertExactKeys(value, ['version', 'kind', 'label', 'count', 'capturedAt', 'fingerprint']);
  if (value.version !== 1) throw new TypeError('FrozenScope projection version must be 1.');
  if (!FROZEN_SCOPE_KINDS.includes(value.kind as FrozenScopeKind)) {
    throw new TypeError('Unsupported FrozenScope projection kind.');
  }
  assertTrimmedNonempty(value.label, 'FrozenScope projection label');
  assertNonnegativeSafeInteger(value.count, 'FrozenScope projection count');
  if (value.count === 0) throw new TypeError('FrozenScope projection cannot be empty.');
  assertNonnegativeSafeInteger(value.capturedAt, 'FrozenScope projection capturedAt');
  if (!isScopeFingerprintV1(value.fingerprint)) {
    throw new TypeError('FrozenScope projection fingerprint is malformed.');
  }
}

export function validateLaunchCandidateContract(
  value: unknown,
): asserts value is LaunchCandidateContract {
  if (!isRecord(value)) throw new TypeError('Launch candidate contract must be an object.');
  if (!FROZEN_SCOPE_KINDS.includes(value.kind as FrozenScopeKind)) {
    throw new TypeError('Launch candidate kind is invalid.');
  }
  if (value.kind === 'current_view') {
    assertExactKeys(value, ['kind', 'filter']);
    validateCurrentViewFilter(value.filter);
    return;
  }
  if (value.kind === 'result_subset') {
    assertExactKeys(value, ['kind', 'sourceRunId', 'sourceGeneration']);
    if (!isRunId(value.sourceRunId)) throw new TypeError('Result-subset sourceRunId is malformed.');
    assertNonnegativeSafeInteger(value.sourceGeneration, 'Result-subset sourceGeneration');
    return;
  }
  if (value.kind === 'selected_repository') {
    assertExactKeys(value, ['kind', 'selectedRepositoryIdHint']);
    assertTrimmedNonempty(value.selectedRepositoryIdHint, 'Selected repository hint');
    return;
  }
  assertExactKeys(value, ['kind']);
}

export function createFrozenScopeCursor(
  runId: RunId,
  generation: number,
  nextFrozenIndex: number,
): FrozenScopeCursor {
  if (!isRunId(runId)) throw new TypeError('FrozenScope cursor runId is malformed.');
  assertNonnegativeSafeInteger(generation, 'FrozenScope cursor generation');
  assertNonnegativeSafeInteger(nextFrozenIndex, 'FrozenScope cursor nextFrozenIndex');
  return Object.freeze({ runId, generation, nextFrozenIndex });
}

export function validateFrozenScopeCursor(value: unknown): asserts value is FrozenScopeCursor {
  if (!isRecord(value)) throw new TypeError('FrozenScope cursor must be an object.');
  assertExactKeys(value, ['runId', 'generation', 'nextFrozenIndex']);
  if (!isRunId(value.runId)) throw new TypeError('FrozenScope cursor runId is malformed.');
  assertNonnegativeSafeInteger(value.generation, 'FrozenScope cursor generation');
  assertNonnegativeSafeInteger(value.nextFrozenIndex, 'FrozenScope cursor nextFrozenIndex');
}

function deduplicateRepositoryIds(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    assertTrimmedNonempty(value, 'FrozenScope repository ID');
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function validateCurrentViewFilter(value: unknown): asserts value is CurrentViewCandidateFilter {
  if (!isRecord(value)) throw new TypeError('Current-view candidate filter must be an object.');
  assertExactKeys(value, [
    'query',
    'languages',
    'tags',
    'tagMode',
    'showTombstone',
    'onlyFavorite',
    'onlyUntagged',
    'onlyArchived',
    'sortKey',
    'sortDir',
  ]);
  if (typeof value.query !== 'string') throw new TypeError('Current-view query must be a string.');
  validateUniqueStringArray(value.languages, 'languages');
  validateUniqueStringArray(value.tags, 'tags');
  if (value.tagMode !== 'any' && value.tagMode !== 'all') {
    throw new TypeError('Current-view tagMode is invalid.');
  }
  for (const field of ['showTombstone', 'onlyFavorite', 'onlyUntagged', 'onlyArchived'] as const) {
    if (typeof value[field] !== 'boolean') throw new TypeError(`Current-view ${field} must be boolean.`);
  }
  if (!CURRENT_VIEW_SORT_KEYS.includes(value.sortKey as CurrentViewSortKey)) {
    throw new TypeError('Current-view sortKey is invalid.');
  }
  if (value.sortDir !== 'asc' && value.sortDir !== 'desc') {
    throw new TypeError('Current-view sortDir is invalid.');
  }
}

function validateUniqueStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new TypeError(`Current-view ${field} must be an array.`);
  const unique = new Set<string>();
  for (const item of value) {
    assertTrimmedNonempty(item, `Current-view ${field} item`);
    if (unique.has(item)) throw new TypeError(`Current-view ${field} must be unique.`);
    unique.add(item);
  }
}

function parseToken<Name extends 'PreflightToken' | 'ContinuationCursorToken'>(
  value: string,
  prefix: string,
  field: string,
): string & { readonly [scopeTokenBrand]: Name } {
  if (!isPrefixedToken(value, prefix)) {
    throw new TypeError(`${field} must be a nonempty ${prefix} token.`);
  }
  return value as string & { readonly [scopeTokenBrand]: Name };
}

function isPrefixedToken(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length;
}

function assertTrimmedNonempty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${field} must be a trimmed nonempty string.`);
  }
}

function assertNonnegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Unexpected contract keys: ${actual.join(', ')}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
