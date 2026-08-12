import {
  GitHubWatchError,
  type WatchSubjectDetail,
  type WatchSubjectIdentity,
  type WatchSubjectLabel,
  type WatchSubjectPerson,
} from '@/watch/watch-model';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_BODY_CODE_UNITS = 100_000;
const MAX_COLLECTION_ITEMS = 100;
const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_WEB_ORIGIN = 'https://github.com';

type FetchLike = typeof fetch;

type RecordValue = Record<string, unknown>;

export interface FetchGitHubWatchSubjectDetailOptions {
  token: string;
  identity: WatchSubjectIdentity;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedString(value: unknown, maxCodeUnits: number): string | null {
  const normalized = nonEmptyString(value);
  return normalized && normalized.length <= maxCodeUnits ? normalized : null;
}

function exactGitHubUrl(value: unknown, expected: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.href === expected ? expected : null;
  } catch {
    return null;
  }
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function expectedPersonUrl(login: string): string {
  return `${GITHUB_WEB_ORIGIN}/${encodeURIComponent(login)}`;
}

function normalizePerson(value: unknown): WatchSubjectPerson | null {
  const input = record(value);
  const login = boundedString(input?.login, 100);
  if (!input || !login) return null;
  const htmlUrl = exactGitHubUrl(input.html_url, expectedPersonUrl(login));
  const avatarUrl = typeof input.avatar_url === 'string' ? input.avatar_url.trim() : '';
  let parsedAvatar: URL;
  try {
    parsedAvatar = new URL(avatarUrl);
  } catch {
    return null;
  }
  if (
    !htmlUrl ||
    parsedAvatar.protocol !== 'https:' ||
    parsedAvatar.username ||
    parsedAvatar.password ||
    parsedAvatar.port ||
    parsedAvatar.hash ||
    parsedAvatar.hostname.toLowerCase() !== 'avatars.githubusercontent.com' ||
    [...parsedAvatar.searchParams.keys()].some((key) => key !== 'v') ||
    parsedAvatar.searchParams.getAll('v').length > 1 ||
    (parsedAvatar.searchParams.has('v') && !/^\d+$/u.test(parsedAvatar.searchParams.get('v') ?? ''))
  ) return null;
  return { login, avatarUrl: parsedAvatar.href, htmlUrl };
}

function normalizeLabels(value: unknown): WatchSubjectLabel[] | null {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) return null;
  const labels: WatchSubjectLabel[] = [];
  for (const item of value) {
    const input = record(item);
    const name = boundedString(input?.name, 256);
    if (!input || !name || typeof input.color !== 'string' || !/^[0-9a-f]{6}$/iu.test(input.color)) {
      return null;
    }
    labels.push({ name, color: input.color.toLowerCase() });
  }
  return labels;
}

function normalizeAssignees(value: unknown): WatchSubjectPerson[] | null {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) return null;
  const assignees: WatchSubjectPerson[] = [];
  for (const item of value) {
    const person = normalizePerson(item);
    if (!person) return null;
    assignees.push(person);
  }
  return assignees;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      throw new GitHubWatchError('invalid_response');
    }
  }
  if (!response.body) throw new GitHubWatchError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GitHubWatchError('invalid_response');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof GitHubWatchError) throw error;
    throw new GitHubWatchError('invalid_response');
  }
}

function responseError(response: Response): GitHubWatchError {
  const details = { status: response.status };
  if (response.status === 401) {
    return new GitHubWatchError('authentication_required', undefined, details);
  }
  if (response.status === 403 || response.status === 429) {
    const limited = response.status === 429 ||
      response.headers.get('x-ratelimit-remaining') === '0' ||
      response.headers.has('retry-after');
    return new GitHubWatchError(
      limited ? 'rate_limited' : 'permission_denied',
      undefined,
      details,
    );
  }
  if (response.status === 404 || response.status === 410 || response.status === 301) {
    return new GitHubWatchError('subject_not_found', undefined, details);
  }
  if (response.status >= 500) {
    return new GitHubWatchError('github_unavailable', undefined, details);
  }
  return new GitHubWatchError('invalid_response', undefined, details);
}

function normalizeDetail(value: unknown, identity: WatchSubjectIdentity): WatchSubjectDetail {
  const input = record(value);
  const author = normalizePerson(input?.user);
  const labels = normalizeLabels(input?.labels);
  const assignees = normalizeAssignees(input?.assignees);
  const title = boundedString(input?.title, 1_024);
  const createdAt = normalizedTimestamp(input?.created_at);
  const updatedAt = normalizedTimestamp(input?.updated_at);
  const state = input?.state === 'open' || input?.state === 'closed' ? input.state : null;
  const validStateReasons = new Set(['completed', 'reopened', 'not_planned', 'duplicate']);
  const stateReason = input?.state_reason === null || input?.state_reason === undefined
    ? null
    : typeof input.state_reason === 'string' && validStateReasons.has(input.state_reason)
      ? input.state_reason as WatchSubjectDetail['stateReason']
      : undefined;
  const number = input?.number;
  const comments = input?.comments;
  const bodyMarkdown = input?.body === null
    ? null
    : typeof input?.body === 'string' && input.body.length <= MAX_BODY_CODE_UNITS
      ? input.body
      : undefined;
  const milestone = input?.milestone === null || input?.milestone === undefined
    ? null
    : boundedString(record(input.milestone)?.title, 256);
  const repositoryUrl = `${GITHUB_API_ORIGIN}/repos/${identity.repositoryFullName}`;
  const hasPullRequest = record(input?.pull_request) !== null;

  if (
    !input || !author || !labels || !assignees || !title || !createdAt || !updatedAt || !state ||
    stateReason === undefined || bodyMarkdown === undefined || milestone === null && input.milestone !== null && input.milestone !== undefined ||
    !Number.isSafeInteger(number) || number !== identity.number ||
    !Number.isSafeInteger(comments) || (comments as number) < 0 ||
    exactGitHubUrl(input.repository_url, repositoryUrl) === null ||
    exactGitHubUrl(input.html_url, identity.htmlUrl) === null ||
    hasPullRequest !== (identity.kind === 'pull_request')
  ) throw new GitHubWatchError('invalid_response');

  return {
    kind: identity.kind,
    repositoryFullName: identity.repositoryFullName,
    number: identity.number,
    title,
    state,
    stateReason,
    htmlUrl: identity.htmlUrl,
    author,
    createdAt,
    updatedAt,
    labels,
    assignees,
    milestoneTitle: milestone,
    commentCount: comments as number,
    bodyMarkdown,
  };
}

export async function fetchGitHubWatchSubjectDetail(
  options: FetchGitHubWatchSubjectDetailOptions,
): Promise<WatchSubjectDetail> {
  const token = options.token.trim();
  if (!token) throw new GitHubWatchError('authentication_required');
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs!))
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(options.identity.apiUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) throw responseError(response);
    const contentType = response.headers.get('content-type');
    if (!contentType?.toLowerCase().includes('json')) {
      throw new GitHubWatchError('invalid_content_type');
    }
    return normalizeDetail(await readBoundedJson(response), options.identity);
  } catch (error) {
    if (error instanceof GitHubWatchError) throw error;
    if (controller.signal.aborted) throw new GitHubWatchError('deadline_exceeded');
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new GitHubWatchError('request_aborted');
    }
    throw new GitHubWatchError('network_error');
  } finally {
    clearTimeout(timer);
  }
}
