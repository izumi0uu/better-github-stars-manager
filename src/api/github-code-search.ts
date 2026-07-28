import { authStore } from '@/auth/auth-store';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_WEB_ORIGIN = 'https://github.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REPOSITORIES = 5;
const MAX_QUERY_SCALARS = 128;
const MAX_CANDIDATES = 8;
const MAX_MATCHES = 8;
const MAX_METADATA_BODY_BYTES = 64 * 1024;
const MAX_SEARCH_BODY_BYTES = 512 * 1024;
const MAX_BLOB_BODY_BYTES = 512 * 1024;
const MAX_DIRECTORY_CONTENTS_BODY_BYTES = 4 * 1024 * 1024;
const MAX_FILE_CONTENTS_BODY_BYTES = 512 * 1024;
const MAX_DECODED_BLOB_BYTES = 256 * 1024;
const MAX_SNIPPET_BYTES = 512;
const MAX_SUCCESS_ENVELOPE_BYTES = 8 * 1024;
const MAX_REPOSITORY_PATH_BYTES = 1_024;
const MAX_DIRECTORY_ENTRIES = 1_000;
const DEFAULT_DIRECTORY_PAGE_LIMIT = 50;
const MAX_DIRECTORY_PAGE_LIMIT = 100;
export const MAX_REPOSITORY_READ_LINES = 200;

export type GithubCodeSearchStatus = 'complete' | 'partial' | 'no_indexed_matches';

export type GithubCodeSearchWarning =
  | 'candidate_limit_reached'
  | 'match_limit_reached'
  | 'search_unavailable'
  | 'candidate_unavailable'
  | 'candidate_invalid'
  | 'candidate_not_text'
  | 'candidate_too_large'
  | 'candidate_without_literal_match'
  | 'rate_limited'
  | 'permission_denied';

export type GithubCodeSearchMatch = Readonly<{
  repository: string;
  path: string;
  blobSha: string;
  ref: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  apiUrl: string;
  githubUrl: string;
  untrusted: true;
}>;

export type GithubCodeSearchResult = Readonly<{
  status: GithubCodeSearchStatus;
  untrusted: true;
  searchedRepositoryCount: number;
  searchedRepositories: readonly string[];
  warnings: readonly GithubCodeSearchWarning[];
  matches: readonly GithubCodeSearchMatch[];
}>;

export type GithubCodeSearchInput = Readonly<{
  repositories: readonly string[];
  query: string;
}>;

export type GithubCodeSearchOptions = Readonly<{
  signal?: AbortSignal;
  deadline?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

export type GithubRepositoryFileType = 'file' | 'directory' | 'symlink' | 'submodule';

export type GithubRepositoryDirectoryWarning =
  | 'directory_limit_reached'
  | 'invalid_entry_skipped'
  | 'result_limit_reached';

export type GithubRepositoryDirectoryEntry = Readonly<{
  name: string;
  path: string;
  type: GithubRepositoryFileType;
  size: number | null;
  sha: string;
  untrusted: true;
}>;

export type GithubRepositoryDirectoryResult = Readonly<{
  status: 'complete' | 'partial';
  repository: string;
  path: string;
  defaultBranch: string;
  ref: string;
  cursor: string;
  nextCursor: string | null;
  totalEntries: number;
  warnings: readonly GithubRepositoryDirectoryWarning[];
  entries: readonly GithubRepositoryDirectoryEntry[];
  untrusted: true;
}>;

export type GithubRepositoryDirectoryInput = Readonly<{
  repositories: readonly string[];
  repository: string;
  path?: string;
  ref?: string;
  cursor?: string;
  limit?: number;
}>;

export type GithubRepositoryFileResult = Readonly<{
  repository: string;
  path: string;
  ref: string;
  blobSha: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
  content: string;
  nextLineStart: number | null;
  contentTruncated: boolean;
  untrusted: true;
}>;

export type GithubRepositoryFileInput = Readonly<{
  repositories: readonly string[];
  repository: string;
  path: string;
  ref: string;
  lineStart?: number;
  lineEnd?: number;
}>;

export type GithubCodeSearchErrorCode =
  | 'invalid_scope'
  | 'invalid_query'
  | 'invalid_repository'
  | 'invalid_path'
  | 'invalid_ref'
  | 'invalid_cursor'
  | 'invalid_limit'
  | 'invalid_line_range'
  | 'authentication_required'
  | 'scope_ineligible'
  | 'not_found'
  | 'not_directory'
  | 'not_file'
  | 'content_too_large'
  | 'content_not_text'
  | 'permission_denied'
  | 'rate_limited'
  | 'request_aborted'
  | 'deadline_exceeded'
  | 'github_unavailable';

export class GithubCodeSearchError extends Error {
  readonly code: GithubCodeSearchErrorCode;

  constructor(code: GithubCodeSearchErrorCode) {
    super(code);
    this.name = 'GithubCodeSearchError';
    this.code = code;
  }
}

type JsonRecord = Record<string, unknown>;

type Candidate = Readonly<{
  repository: string;
  path: string;
  sha: string;
  ref: string;
  githubUrl: string;
}>;

type RepositoryMetadata = Readonly<{
  defaultBranch: string | null;
}>;

class ResponseLimitError extends Error {}

class RequestFailure extends Error {
  readonly kind: 'aborted' | 'deadline' | 'network';

  constructor(kind: 'aborted' | 'deadline' | 'network') {
    super(kind);
    this.kind = kind;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRepositoryName(fullName: unknown): string {
  if (
    typeof fullName !== 'string'
    || fullName.length > 201
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u.test(fullName)
  ) {
    throw new GithubCodeSearchError('invalid_scope');
  }
  return fullName;
}

function validateRepositoryScope(value: readonly string[], maxRepositories?: number): string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || (maxRepositories !== undefined && value.length > maxRepositories)
  ) {
    throw new GithubCodeSearchError('invalid_scope');
  }
  const seen = new Set<string>();
  const repositories: string[] = [];
  for (const fullName of value) {
    validateRepositoryName(fullName);
    const key = fullName.toLowerCase();
    if (seen.has(key)) throw new GithubCodeSearchError('invalid_scope');
    seen.add(key);
    repositories.push(fullName);
  }
  return repositories;
}

function validateRepositories(value: readonly string[]): string[] {
  return validateRepositoryScope(value, MAX_REPOSITORIES);
}

export function validateGithubCodeSearchQuery(value: unknown): string {
  if (typeof value !== 'string') throw new GithubCodeSearchError('invalid_query');
  const scalarCount = Array.from(value).length;
  if (
    scalarCount < 1 ||
    scalarCount > MAX_QUERY_SCALARS ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ||
    /[\ud800-\udfff]/u.test(value) ||
    /["\\]/u.test(value) ||
    /(?:^|\s)(?:AND|OR|NOT)(?:\s|$)/u.test(value) ||
    /(?:^|\s)[A-Za-z][A-Za-z0-9_-]*\s*:/u.test(value)
  ) {
    throw new GithubCodeSearchError('invalid_query');
  }
  return value;
}

function validateScopedRepository(
  repositories: readonly string[],
  requestedRepository: string,
): { repositories: string[]; repository: string } {
  const validatedRepositories = validateRepositoryScope(repositories);
  if (typeof requestedRepository !== 'string') {
    throw new GithubCodeSearchError('invalid_repository');
  }
  const normalizedRequested = requestedRepository.normalize('NFKC').toLocaleLowerCase('en-US');
  const repository = validatedRepositories.find((candidate) =>
    candidate.normalize('NFKC').toLocaleLowerCase('en-US') === normalizedRequested
  );
  if (!repository) throw new GithubCodeSearchError('invalid_repository');
  return { repositories: validatedRepositories, repository };
}

function validateRepositoryPath(value: string | undefined, allowRoot: boolean): string {
  if (value === undefined && allowRoot) return '';
  if (typeof value !== 'string') throw new GithubCodeSearchError('invalid_path');
  if (value === '' && allowRoot) return value;
  const bytes = new TextEncoder().encode(value).byteLength;
  if (
    value.length < 1
    || bytes > MAX_REPOSITORY_PATH_BYTES
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new GithubCodeSearchError('invalid_path');
  }
  return value;
}

function validateCommitRef(value: string | undefined, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new GithubCodeSearchError('invalid_ref');
  }
  return value;
}

function validateDirectoryCursor(value: string | undefined): { cursor: string; offset: number } {
  const cursor = value ?? '0';
  if (!/^(?:0|[1-9][0-9]{0,3})$/u.test(cursor)) {
    throw new GithubCodeSearchError('invalid_cursor');
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset > MAX_DIRECTORY_ENTRIES) {
    throw new GithubCodeSearchError('invalid_cursor');
  }
  return { cursor, offset };
}

function validateDirectoryLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_DIRECTORY_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DIRECTORY_PAGE_LIMIT) {
    throw new GithubCodeSearchError('invalid_limit');
  }
  return limit;
}

function validateLineRange(
  lineStartValue: number | undefined,
  lineEndValue: number | undefined,
): { lineStart: number; lineEnd: number } {
  const lineStart = lineStartValue ?? 1;
  const lineEnd = lineEndValue ?? lineStart + MAX_REPOSITORY_READ_LINES - 1;
  if (
    !Number.isSafeInteger(lineStart)
    || !Number.isSafeInteger(lineEnd)
    || lineStart < 1
    || lineEnd < lineStart
    || lineEnd - lineStart + 1 > MAX_REPOSITORY_READ_LINES
  ) {
    throw new GithubCodeSearchError('invalid_line_range');
  }
  return { lineStart, lineEnd };
}

function repositoryParts(fullName: string): readonly [string, string] {
  const slash = fullName.indexOf('/');
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

function apiRepositoryUrl(fullName: string): string {
  const [owner, repo] = repositoryParts(fullName);
  return `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function apiBlobUrl(fullName: string, sha: string): string {
  return `${apiRepositoryUrl(fullName)}/git/blobs/${encodeURIComponent(sha)}`;
}

function apiGitBranchRefUrl(fullName: string, branch: string): string {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  return `${apiRepositoryUrl(fullName)}/git/ref/heads/${encodedBranch}`;
}

function apiContentsUrl(fullName: string, path: string, ref: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${apiRepositoryUrl(fullName)}/contents${encodedPath ? `/${encodedPath}` : ''}`);
  url.searchParams.set('ref', ref);
  return url.href;
}

function searchUrl(repository: string, query: string): string {
  const url = new URL('/search/code', GITHUB_API_ORIGIN);
  url.searchParams.set('q', `"${query}" repo:${repository}`);
  url.searchParams.set('per_page', String(MAX_CANDIDATES));
  return url.href;
}

function requestContext(options: GithubCodeSearchOptions): {
  signal: AbortSignal;
  cleanup: () => void;
  wasDeadlineExceeded: () => boolean;
} {
  const now = Date.now();
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs as number))
    : DEFAULT_TIMEOUT_MS;
  const deadlineAt = options.deadline === undefined
    ? now + timeoutMs
    : Math.min(options.deadline, now + timeoutMs);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= now) {
    throw new GithubCodeSearchError('deadline_exceeded');
  }
  if (options.signal?.aborted) throw new GithubCodeSearchError('request_aborted');

  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(), Math.max(1, deadlineAt - now));
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  return {
    signal,
    cleanup: () => clearTimeout(timer),
    wasDeadlineExceeded: () => deadlineController.signal.aborted,
  };
}

async function githubFetch(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  signal: AbortSignal,
  wasDeadlineExceeded: () => boolean,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.origin !== GITHUB_API_ORIGIN || parsed.protocol !== 'https:') {
    throw new GithubCodeSearchError('github_unavailable');
  }
  try {
    return await fetchImpl(parsed.href, {
      method: 'GET',
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new RequestFailure(wasDeadlineExceeded() ? 'deadline' : 'aborted');
    }
    void error;
    throw new RequestFailure('network');
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      throw new ResponseLimitError();
    }
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new ResponseLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ResponseLimitError();
  }
}

function requireSuccessfulResponse(response: Response): void {
  if (response.ok) return;
  if (response.status === 401) throw new GithubCodeSearchError('authentication_required');
  if (response.status === 403 || response.status === 429) {
    if (
      response.status === 429
      || response.headers.get('x-ratelimit-remaining') === '0'
      || response.headers.has('retry-after')
    ) {
      throw new GithubCodeSearchError('rate_limited');
    }
    throw new GithubCodeSearchError('permission_denied');
  }
  throw new GithubCodeSearchError('github_unavailable');
}

function throwIfAborted(signal: AbortSignal, wasDeadlineExceeded: () => boolean): void {
  if (!signal.aborted) return;
  throw new GithubCodeSearchError(
    wasDeadlineExceeded() ? 'deadline_exceeded' : 'request_aborted',
  );
}

async function validateRepository(
  repository: string,
  fetchImpl: typeof fetch,
  token: string,
  signal: AbortSignal,
  wasDeadlineExceeded: () => boolean,
): Promise<RepositoryMetadata> {
  let response: Response;
  try {
    response = await githubFetch(
      fetchImpl,
      apiRepositoryUrl(repository),
      token,
      signal,
      wasDeadlineExceeded,
    );
    if (response.status === 404) throw new GithubCodeSearchError('scope_ineligible');
    requireSuccessfulResponse(response);
    const body = await readBoundedJson(response, MAX_METADATA_BODY_BYTES);
    if (
      !isRecord(body) ||
      body.full_name !== repository ||
      body.private !== false ||
      body.archived !== false ||
      ('visibility' in body && body.visibility !== 'public')
    ) {
      throw new GithubCodeSearchError('scope_ineligible');
    }
    const defaultBranch = body.default_branch;
    if (
      defaultBranch !== undefined
      && (
        typeof defaultBranch !== 'string'
        || defaultBranch.length < 1
        || defaultBranch.length > 255
        || defaultBranch.startsWith('/')
        || defaultBranch.endsWith('/')
        || defaultBranch.includes('\\')
        || defaultBranch.split('/').some((part) => part === '' || part === '.' || part === '..')
        || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(defaultBranch)
      )
    ) {
      throw new GithubCodeSearchError('scope_ineligible');
    }
    return { defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : null };
  } catch (error) {
    throwIfAborted(signal, wasDeadlineExceeded);
    if (error instanceof GithubCodeSearchError) throw error;
    if (error instanceof RequestFailure) {
      if (error.kind === 'aborted') throw new GithubCodeSearchError('request_aborted');
      if (error.kind === 'deadline') throw new GithubCodeSearchError('deadline_exceeded');
    }
    throw new GithubCodeSearchError('github_unavailable');
  }
}

function validateGithubBlobUrl(
  repository: string,
  path: string,
  value: unknown,
): { githubUrl: string; ref: string } | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.origin !== GITHUB_WEB_ORIGIN
    || url.username
    || url.password
    || url.search
    || url.hash
  ) return null;
  const [owner, repo] = repositoryParts(repository);
  const parts = url.pathname.split('/').slice(1);
  if (parts.length < 5 || parts[0] !== owner || parts[1] !== repo || parts[2] !== 'blob') {
    return null;
  }
  const ref = parts[3];
  if (!ref || !/^[0-9a-f]{40,64}$/u.test(ref)) return null;
  try {
    if (parts.slice(4).map(decodeURIComponent).join('/') !== path) return null;
  } catch {
    return null;
  }
  return { githubUrl: url.href, ref };
}

function parseCandidate(repository: string, value: unknown): Candidate | null {
  if (!isRecord(value) || !isRecord(value.repository)) return null;
  const { path, sha } = value;
  if (
    value.repository.full_name !== repository ||
    typeof path !== 'string' ||
    typeof sha !== 'string' ||
    !/^[0-9a-f]{40,64}$/.test(sha)
  ) return null;
  let validatedPath: string;
  try {
    validatedPath = validateRepositoryPath(path, false);
  } catch {
    return null;
  }
  const location = validateGithubBlobUrl(repository, validatedPath, value.html_url);
  if (!location) return null;
  return { repository, path: validatedPath, sha, ...location };
}

async function searchRepository(
  repository: string,
  query: string,
  fetchImpl: typeof fetch,
  token: string,
  signal: AbortSignal,
  wasDeadlineExceeded: () => boolean,
): Promise<{ candidates: Candidate[]; truncated: boolean; invalidCandidates: boolean }> {
  const response = await githubFetch(
    fetchImpl,
    searchUrl(repository, query),
    token,
    signal,
    wasDeadlineExceeded,
    'application/vnd.github.text-match+json',
  );
  requireSuccessfulResponse(response);
  const body = await readBoundedJson(response, MAX_SEARCH_BODY_BYTES);
  const totalCount = isRecord(body) ? body.total_count : null;
  if (
    !isRecord(body) ||
    !Array.isArray(body.items) ||
    ('incomplete_results' in body && typeof body.incomplete_results !== 'boolean') ||
    typeof totalCount !== 'number' ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0
  ) {
    throw new RequestFailure('network');
  }
  const candidates = body.items
    .map((item) => parseCandidate(repository, item))
    .filter((item): item is Candidate => item !== null);
  return {
    candidates,
    truncated: body.incomplete_results === true ||
      totalCount > body.items.length,
    invalidCandidates: candidates.length < body.items.length,
  };
}

function decodeBase64(content: string, declaredSize: number): Uint8Array {
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_DECODED_BLOB_BYTES) {
    throw new ResponseLimitError();
  }
  if (!/^(?:[A-Za-z0-9+/]{4}|\r?\n)*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\r?\n?$/.test(content)) {
    throw new TypeError('invalid base64');
  }
  const normalized = content.replace(/\r?\n/g, '');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const decodedLength = normalized.length === 0 ? 0 : (normalized.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(decodedLength) || decodedLength > MAX_DECODED_BLOB_BYTES) {
    throw new ResponseLimitError();
  }
  if (decodedLength !== declaredSize) throw new TypeError('invalid base64');
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new TypeError('invalid base64');
  }
  if (btoa(binary) !== normalized) throw new TypeError('invalid base64');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== declaredSize) throw new TypeError('invalid base64');
  return bytes;
}

function decodeTextBlob(body: unknown, expectedSha: string): string {
  if (
    !isRecord(body) ||
    body.sha !== expectedSha ||
    body.encoding !== 'base64' ||
    typeof body.content !== 'string' ||
    typeof body.size !== 'number'
  ) throw new TypeError('invalid blob');
  const bytes = decodeBase64(body.content, body.size);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('binary blob');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(decoded)) {
    throw new TypeError('binary blob');
  }
  return decoded;
}

function requireRepositoryContentResponse(response: Response): void {
  if (response.status === 404) throw new GithubCodeSearchError('not_found');
  requireSuccessfulResponse(response);
}

async function resolveDefaultBranchCommit(
  repository: string,
  defaultBranch: string,
  fetchImpl: typeof fetch,
  token: string,
  signal: AbortSignal,
  wasDeadlineExceeded: () => boolean,
): Promise<string> {
  const response = await githubFetch(
    fetchImpl,
    apiGitBranchRefUrl(repository, defaultBranch),
    token,
    signal,
    wasDeadlineExceeded,
  );
  requireRepositoryContentResponse(response);
  const body = await readBoundedJson(response, MAX_METADATA_BODY_BYTES);
  if (
    !isRecord(body)
    || !isRecord(body.object)
    || body.object.type !== 'commit'
    || typeof body.object.sha !== 'string'
    || !/^[0-9a-f]{40,64}$/u.test(body.object.sha)
  ) {
    throw new RequestFailure('network');
  }
  return body.object.sha;
}

function parseDirectoryEntry(
  directoryPath: string,
  value: unknown,
): GithubRepositoryDirectoryEntry | null {
  if (!isRecord(value)) return null;
  const mappedType: GithubRepositoryFileType | null = value.type === 'file'
    ? 'file'
    : value.type === 'dir'
      ? 'directory'
      : value.type === 'symlink'
        ? 'symlink'
        : value.type === 'submodule'
          ? 'submodule'
          : null;
  if (
    !mappedType
    || typeof value.name !== 'string'
    || typeof value.path !== 'string'
    || typeof value.sha !== 'string'
    || !/^[0-9a-f]{40,64}$/u.test(value.sha)
  ) return null;
  let path: string;
  try {
    path = validateRepositoryPath(value.path, false);
  } catch {
    return null;
  }
  if (
    value.name.length < 1
    || value.name.includes('/')
    || value.name.includes('\\')
    || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value.name)
    || new TextEncoder().encode(value.name).byteLength > 255
    || path !== `${directoryPath ? `${directoryPath}/` : ''}${value.name}`
  ) return null;
  const size = value.size;
  if (
    size !== undefined
    && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
  ) return null;
  return Object.freeze({
    name: value.name,
    path,
    type: mappedType,
    size: typeof size === 'number' ? size : null,
    sha: value.sha,
    untrusted: true,
  });
}

function repositoryRequestError(
  error: unknown,
  signal: AbortSignal,
  wasDeadlineExceeded: () => boolean,
): never {
  throwIfAborted(signal, wasDeadlineExceeded);
  if (error instanceof GithubCodeSearchError) throw error;
  if (error instanceof RequestFailure) {
    if (error.kind === 'aborted') throw new GithubCodeSearchError('request_aborted');
    if (error.kind === 'deadline') throw new GithubCodeSearchError('deadline_exceeded');
  }
  throw new GithubCodeSearchError('github_unavailable');
}

export async function listRepositoryFiles(
  input: GithubRepositoryDirectoryInput,
  options: GithubCodeSearchOptions = {},
): Promise<GithubRepositoryDirectoryResult> {
  const { repository } = validateScopedRepository(input.repositories, input.repository);
  const path = validateRepositoryPath(input.path, true);
  const requestedRef = validateCommitRef(input.ref, false);
  const { cursor, offset } = validateDirectoryCursor(input.cursor);
  const limit = validateDirectoryLimit(input.limit);
  if (offset > 0 && !requestedRef) throw new GithubCodeSearchError('invalid_ref');

  const token = await authStore.getToken();
  if (!token) throw new GithubCodeSearchError('authentication_required');
  const fetchImpl = options.fetchImpl ?? fetch;
  const context = requestContext(options);
  try {
    const metadata = await validateRepository(
      repository,
      fetchImpl,
      token,
      context.signal,
      context.wasDeadlineExceeded,
    );
    if (!metadata.defaultBranch) throw new GithubCodeSearchError('scope_ineligible');
    const ref = requestedRef ?? await resolveDefaultBranchCommit(
      repository,
      metadata.defaultBranch,
      fetchImpl,
      token,
      context.signal,
      context.wasDeadlineExceeded,
    );
    const response = await githubFetch(
      fetchImpl,
      apiContentsUrl(repository, path, ref),
      token,
      context.signal,
      context.wasDeadlineExceeded,
    );
    requireRepositoryContentResponse(response);
    const body = await readBoundedJson(response, MAX_DIRECTORY_CONTENTS_BODY_BYTES);
    if (isRecord(body)) throw new GithubCodeSearchError('not_directory');
    if (!Array.isArray(body)) throw new RequestFailure('network');

    const warnings: GithubRepositoryDirectoryWarning[] = [];
    const entries: GithubRepositoryDirectoryEntry[] = [];
    const seen = new Set<string>();
    for (const value of body) {
      const entry = parseDirectoryEntry(path, value);
      if (!entry || seen.has(entry.path)) {
        if (!warnings.includes('invalid_entry_skipped')) warnings.push('invalid_entry_skipped');
        continue;
      }
      seen.add(entry.path);
      entries.push(entry);
    }
    entries.sort((left, right) =>
      (left.type === 'directory' ? 0 : 1) - (right.type === 'directory' ? 0 : 1)
      || left.name.localeCompare(right.name)
      || left.path.localeCompare(right.path)
      || left.sha.localeCompare(right.sha)
    );
    if (body.length >= MAX_DIRECTORY_ENTRIES) warnings.push('directory_limit_reached');
    if (offset > 0 && offset >= entries.length) {
      throw new GithubCodeSearchError('invalid_cursor');
    }
    const page = entries.slice(offset, Math.min(entries.length, offset + limit));
    const nextCursor = offset + page.length < entries.length
      ? String(offset + page.length)
      : null;
    return Object.freeze({
      status: warnings.length > 0 ? 'partial' : 'complete',
      repository,
      path,
      defaultBranch: metadata.defaultBranch,
      ref,
      cursor,
      nextCursor,
      totalEntries: entries.length,
      warnings: Object.freeze(warnings),
      entries: Object.freeze(page),
      untrusted: true,
    });
  } catch (error) {
    if (error instanceof ResponseLimitError) {
      throw new GithubCodeSearchError('content_too_large');
    }
    repositoryRequestError(error, context.signal, context.wasDeadlineExceeded);
  } finally {
    context.cleanup();
  }
}

function sourceLines(source: string): string[] {
  return source.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

export async function readRepositoryFile(
  input: GithubRepositoryFileInput,
  options: GithubCodeSearchOptions = {},
): Promise<GithubRepositoryFileResult> {
  const { repository } = validateScopedRepository(input.repositories, input.repository);
  const path = validateRepositoryPath(input.path, false);
  const ref = validateCommitRef(input.ref, true)!;
  const { lineStart, lineEnd } = validateLineRange(input.lineStart, input.lineEnd);

  const token = await authStore.getToken();
  if (!token) throw new GithubCodeSearchError('authentication_required');
  const fetchImpl = options.fetchImpl ?? fetch;
  const context = requestContext(options);
  try {
    await validateRepository(
      repository,
      fetchImpl,
      token,
      context.signal,
      context.wasDeadlineExceeded,
    );
    const response = await githubFetch(
      fetchImpl,
      apiContentsUrl(repository, path, ref),
      token,
      context.signal,
      context.wasDeadlineExceeded,
    );
    requireRepositoryContentResponse(response);
    const body = await readBoundedJson(response, MAX_FILE_CONTENTS_BODY_BYTES);
    if (Array.isArray(body)) throw new GithubCodeSearchError('not_file');
    if (
      !isRecord(body)
      || body.type !== 'file'
      || body.path !== path
      || typeof body.sha !== 'string'
      || !/^[0-9a-f]{40,64}$/u.test(body.sha)
    ) {
      throw new GithubCodeSearchError('not_file');
    }
    let source: string;
    try {
      source = decodeTextBlob(body, body.sha);
    } catch (error) {
      if (error instanceof ResponseLimitError) {
        throw new GithubCodeSearchError('content_too_large');
      }
      throw new GithubCodeSearchError('content_not_text');
    }
    const lines = sourceLines(source);
    if (lineStart > lines.length) throw new GithubCodeSearchError('invalid_line_range');
    const returnedLineEnd = Math.min(lineEnd, lines.length);
    const content = lines.slice(lineStart - 1, returnedLineEnd).join('\n');
    return Object.freeze({
      repository,
      path,
      ref,
      blobSha: body.sha,
      lineStart,
      lineEnd: returnedLineEnd,
      totalLines: lines.length,
      content,
      nextLineStart: returnedLineEnd > 0 && returnedLineEnd < lines.length
        ? returnedLineEnd + 1
        : null,
      contentTruncated: false,
      untrusted: true,
    });
  } catch (error) {
    if (error instanceof ResponseLimitError) {
      throw new GithubCodeSearchError('content_too_large');
    }
    repositoryRequestError(error, context.signal, context.wasDeadlineExceeded);
  } finally {
    context.cleanup();
  }
}

function truncateUtf8Around(value: string, needle: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= MAX_SNIPPET_BYTES) return value;
  const needleIndex = value.indexOf(needle);
  const characters = Array.from(value);
  const prefixScalars = Array.from(value.slice(0, Math.max(0, needleIndex))).length;
  const needleScalars = Array.from(needle).length;
  let start = Math.max(0, prefixScalars - 80);
  let end = Math.min(characters.length, prefixScalars + needleScalars + 80);
  let result = characters.slice(start, end).join('');
  while (encoder.encode(result).byteLength > MAX_SNIPPET_BYTES) {
    const leftContext = prefixScalars - start;
    const rightContext = end - (prefixScalars + needleScalars);
    if (rightContext > leftContext && end > prefixScalars + needleScalars) end -= 1;
    else if (start < prefixScalars) start += 1;
    else if (end > prefixScalars + needleScalars) end -= 1;
    else break;
    result = characters.slice(start, end).join('');
  }
  return result;
}

function sanitizeSnippet(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '\ufffd');
}

function matchesForCandidate(candidate: Candidate, source: string, query: string): GithubCodeSearchMatch[] {
  const lines = source.split('\n');
  const matches: GithubCodeSearchMatch[] = [];
  const literalPattern = new RegExp(escapeRegExp(query), 'iu');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    const literalMatch = literalPattern.exec(line);
    if (!literalMatch) continue;
    const apiUrl = apiBlobUrl(candidate.repository, candidate.sha);
    matches.push(Object.freeze({
      repository: candidate.repository,
      path: candidate.path,
      blobSha: candidate.sha,
      ref: candidate.ref,
      lineStart: index + 1,
      lineEnd: index + 1,
      snippet: truncateUtf8Around(sanitizeSnippet(line), literalMatch[0]),
      apiUrl,
      githubUrl: `${candidate.githubUrl}#L${index + 1}`,
      untrusted: true,
    }));
  }
  return matches;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function hydrateCandidate(
  candidate: Candidate,
  query: string,
  fetchImpl: typeof fetch,
  token: string,
  signal: AbortSignal,
  wasDeadlineExceeded: () => boolean,
): Promise<GithubCodeSearchMatch[]> {
  const response = await githubFetch(
    fetchImpl,
    apiBlobUrl(candidate.repository, candidate.sha),
    token,
    signal,
    wasDeadlineExceeded,
  );
  requireSuccessfulResponse(response);
  const body = await readBoundedJson(response, MAX_BLOB_BODY_BYTES);
  return matchesForCandidate(candidate, decodeTextBlob(body, candidate.sha), query);
}

function addWarning(warnings: GithubCodeSearchWarning[], warning: GithubCodeSearchWarning): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

export async function searchIndexedRepositoryCode(
  input: GithubCodeSearchInput,
  options: GithubCodeSearchOptions = {},
): Promise<GithubCodeSearchResult> {
  const repositories = validateRepositories(input.repositories);
  const query = validateGithubCodeSearchQuery(input.query);
  const token = await authStore.getToken();
  if (!token) throw new GithubCodeSearchError('authentication_required');
  const fetchImpl = options.fetchImpl ?? fetch;
  const context = requestContext(options);

  try {
    for (const repository of repositories) {
      await validateRepository(
        repository,
        fetchImpl,
        token,
        context.signal,
        context.wasDeadlineExceeded,
      );
    }

    const warnings: GithubCodeSearchWarning[] = [];
    const candidates: Candidate[] = [];
    for (const repository of repositories) {
      try {
        const result = await searchRepository(
          repository,
          query,
          fetchImpl,
          token,
          context.signal,
          context.wasDeadlineExceeded,
        );
        if (result.truncated) addWarning(warnings, 'candidate_limit_reached');
        if (result.invalidCandidates) addWarning(warnings, 'candidate_invalid');
        for (const candidate of result.candidates) {
          if (candidates.length >= MAX_CANDIDATES) {
            addWarning(warnings, 'candidate_limit_reached');
            break;
          }
          if (!candidates.some((existing) =>
            existing.repository === candidate.repository &&
            existing.path === candidate.path &&
            existing.sha === candidate.sha
          )) candidates.push(candidate);
        }
      } catch (error) {
        throwIfAborted(context.signal, context.wasDeadlineExceeded);
        if (error instanceof RequestFailure && error.kind === 'aborted') {
          throw new GithubCodeSearchError('request_aborted');
        }
        if (error instanceof RequestFailure && error.kind === 'deadline') {
          throw new GithubCodeSearchError('deadline_exceeded');
        }
        if (error instanceof GithubCodeSearchError && error.code === 'authentication_required') {
          throw error;
        }
        if (error instanceof GithubCodeSearchError && error.code === 'rate_limited') {
          addWarning(warnings, 'rate_limited');
        } else if (error instanceof GithubCodeSearchError && error.code === 'permission_denied') {
          addWarning(warnings, 'permission_denied');
        } else {
          addWarning(warnings, 'search_unavailable');
        }
      }
    }

    const matches: GithubCodeSearchMatch[] = [];
    for (const candidate of candidates) {
      try {
        const hydratedMatches = await hydrateCandidate(
          candidate,
          query,
          fetchImpl,
          token,
          context.signal,
          context.wasDeadlineExceeded,
        );
        if (hydratedMatches.length === 0) addWarning(warnings, 'candidate_without_literal_match');
        for (const match of hydratedMatches) {
          if (matches.length >= MAX_MATCHES) {
            addWarning(warnings, 'match_limit_reached');
            break;
          }
          matches.push(match);
        }
      } catch (error) {
        throwIfAborted(context.signal, context.wasDeadlineExceeded);
        if (error instanceof RequestFailure && error.kind === 'aborted') {
          throw new GithubCodeSearchError('request_aborted');
        }
        if (error instanceof RequestFailure && error.kind === 'deadline') {
          throw new GithubCodeSearchError('deadline_exceeded');
        }
        if (error instanceof GithubCodeSearchError && error.code === 'authentication_required') {
          throw error;
        }
        if (error instanceof GithubCodeSearchError && error.code === 'rate_limited') {
          addWarning(warnings, 'rate_limited');
        } else if (error instanceof GithubCodeSearchError && error.code === 'permission_denied') {
          addWarning(warnings, 'permission_denied');
        } else if (error instanceof ResponseLimitError) addWarning(warnings, 'candidate_too_large');
        else if (error instanceof TypeError) addWarning(warnings, 'candidate_not_text');
        else addWarning(warnings, 'candidate_unavailable');
      }
    }

    matches.sort((left, right) =>
      left.repository.localeCompare(right.repository) ||
      left.path.localeCompare(right.path) ||
      left.lineStart - right.lineStart ||
      left.blobSha.localeCompare(right.blobSha),
    );
    let result = buildResult(repositories, warnings, matches);
    while (
      matches.length > 0
      && serializedByteLength({ ok: true, data: result }) > MAX_SUCCESS_ENVELOPE_BYTES
    ) {
      matches.pop();
      addWarning(warnings, 'match_limit_reached');
      result = buildResult(repositories, warnings, matches);
    }
    if (serializedByteLength({ ok: true, data: result }) > MAX_SUCCESS_ENVELOPE_BYTES) {
      throw new GithubCodeSearchError('github_unavailable');
    }
    return result;
  } finally {
    context.cleanup();
  }
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function buildResult(
  repositories: readonly string[],
  warnings: readonly GithubCodeSearchWarning[],
  matches: readonly GithubCodeSearchMatch[],
): GithubCodeSearchResult {
  const status: GithubCodeSearchStatus = warnings.some((warning) =>
    warning !== 'candidate_without_literal_match'
  )
    ? 'partial'
    : matches.length === 0
      ? 'no_indexed_matches'
      : 'complete';
  return Object.freeze({
    status,
    untrusted: true,
    searchedRepositoryCount: repositories.length,
    searchedRepositories: Object.freeze([...repositories]),
    warnings: Object.freeze([...warnings]),
    matches: Object.freeze([...matches]),
  });
}
