/**
 * Pure domain contracts and normalization helpers for the GitHub Watch
 * surface.  API adapters use these helpers before a row is allowed to reach
 * storage or the UI.  The model deliberately keeps GitHub's reason/type
 * strings open-ended so a new server value is not silently discarded.
 */

export type WatchErrorCode =
  | 'authentication_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'request_aborted'
  | 'deadline_exceeded'
  | 'network_error'
  | 'github_unavailable'
  | 'invalid_content_type'
  | 'invalid_response'
  | 'invalid_pagination'
  | 'not_modified'
  | 'page_limit_exceeded'
  | 'invalid_repository'
  | 'invalid_thread'
  | 'subject_not_found'
  | 'credential_changed';

/** Stable, non-payload-bearing error surfaced by either Watch API source. */
export class GitHubWatchError extends Error {
  readonly code: WatchErrorCode;
  readonly status?: number;
  readonly page?: number;

  constructor(
    code: WatchErrorCode,
    message: string = code,
    details: { status?: number; page?: number } = {},
  ) {
    super(message);
    this.name = 'GitHubWatchError';
    this.code = code;
    this.status = details.status;
    this.page = details.page;
  }
}

export function isValidWatchHistoryPage(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** A native watched repository, reduced to the identity needed by Watch. */
export interface GitHubWatchRepository {
  full_name: string;
}

/** Normalized GitHub Inbox thread. */
export interface GitHubNotificationThread {
  id: string;
  repositoryFullName: string;
  repositoryHtmlUrl: string;
  repositoryOwnerLogin?: string | null;
  repositoryOwnerAvatarUrl?: string | null;
  reason: string;
  subjectType: string;
  subjectTitle: string;
  subjectApiUrl: string | null;
  subjectHtmlUrl: string | null;
  unread: boolean;
  updatedAt: string;
  lastReadAt: string | null;
  fetchedAt: string;
}

export type WatchSubjectKind = 'issue' | 'pull_request';

export interface WatchSubjectPerson {
  login: string;
  avatarUrl: string;
  htmlUrl: string;
}

export interface WatchSubjectLabel {
  name: string;
  color: string;
}

/** Validated identity rebuilt from one account-bound cached notification. */
export interface WatchSubjectIdentity {
  kind: WatchSubjectKind;
  repositoryFullName: string;
  number: number;
  apiUrl: string;
  htmlUrl: string;
}

/** Ephemeral, normalized Issue/PR data safe to cross the message boundary. */
export interface WatchSubjectDetail {
  kind: WatchSubjectKind;
  repositoryFullName: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  stateReason: 'completed' | 'reopened' | 'not_planned' | 'duplicate' | null;
  htmlUrl: string;
  author: WatchSubjectPerson;
  createdAt: string;
  updatedAt: string;
  labels: WatchSubjectLabel[];
  assignees: WatchSubjectPerson[];
  milestoneTitle: string | null;
  commentCount: number;
  bodyMarkdown: string | null;
}

export interface WatchNotificationGroup {
  repositoryFullName: string;
  repositoryHtmlUrl: string;
  repositoryOwnerLogin: string | null;
  repositoryOwnerAvatarUrl: string | null;
  latestUpdatedAt: string;
  threads: GitHubNotificationThread[];
}

export interface WatchInboxProjection {
  threads: GitHubNotificationThread[];
  groups: WatchNotificationGroup[];
  unreadCount: number;
  totalCount: number;
}

export interface WatchRefreshSnapshot {
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  errorCode: string | null;
}

export interface WatchScopeRefreshSnapshot extends WatchRefreshSnapshot {
  repositoryCount: number;
}

export interface WatchInboxRefreshSnapshot extends WatchRefreshSnapshot {
  lastModified: string | null;
  nextAllowedAt: string | null;
  candidateCount: number;
  matchedCount: number;
  truncated: boolean;
  /** Previous Watch-surface load; rows after this boundary are newly updated. */
  newerThan: string | null;
  /** Frozen Notifications `before` boundary for stable historical pagination. */
  historyBefore: string | null;
  historyNextPage: number | null;
  historyExhausted: boolean;
  historyErrorCode: string | null;
}

export interface GitHubWatchStateRecord {
  id: 'singleton';
  accountLogin: string;
  scope: WatchScopeRefreshSnapshot;
  inbox: WatchInboxRefreshSnapshot;
}

export interface WatchScopeSnapshot {
  repositories: GitHubWatchRepository[];
  pageCount: number;
  fetchedAt: string;
}

export interface WatchNotificationSnapshot {
  threads: GitHubNotificationThread[];
  /** Number of valid candidate threads received before live-Star filtering. */
  candidateCount: number;
  /** Number of threads remaining after live-Star filtering. */
  matchedCount: number;
  pageCount: number;
  truncated: boolean;
  /** Next page inside the frozen `before` epoch, or null when exhausted. */
  nextPage: number | null;
  notModified: boolean;
  before: string;
  fetchedAt: string;
  lastModified: string | null;
  pollIntervalSeconds: number;
}

export interface NormalizeNotificationOptions {
  fetchedAt?: string | Date | number;
}

const API_ORIGIN = 'https://api.github.com';
const WEB_ORIGIN = 'https://github.com';

// GitHub user/org names are at most 39 characters and repository names are at
// most 100. Repository names may start with punctuation (`github/.github` is a
// real example), so owner and repository grammar cannot share one expression.
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Date.parse(value))) {
    throw new GitHubWatchError('invalid_thread', `invalid ${field}`);
  }
  // Keep the server's representation.  Date parsing is only validation; exact
  // strings are useful when diagnosing GitHub's snapshot boundary.
  return value;
}

function normalizedFetchedAt(value: string | Date | number | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new GitHubWatchError('invalid_thread', 'invalid fetchedAt');
  }
  return date.toISOString();
}

/** Return a lower-case canonical `owner/repository` identity, or throw. */
export function normalizeRepositoryFullName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new GitHubWatchError('invalid_repository', 'repository full_name must be a string');
  }
  const input = value.trim();
  const parts = input.split('/');
  if (
    parts.length !== 2 ||
    parts[0]!.length === 0 ||
    parts[0]!.length > 39 ||
    parts[1]!.length === 0 ||
    parts[1]!.length > 100 ||
    !OWNER_NAME.test(parts[0]!) ||
    !REPOSITORY_NAME.test(parts[1]!) ||
    parts[1] === '.' ||
    parts[1] === '..'
  ) {
    throw new GitHubWatchError('invalid_repository', 'invalid repository full_name');
  }
  return `${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`;
}

/** Non-throwing repository identity guard useful at UI/query boundaries. */
export function canonicalRepositoryFullName(value: unknown): string | null {
  try {
    return normalizeRepositoryFullName(value);
  } catch {
    return null;
  }
}

export const normalizeRepositoryName = normalizeRepositoryFullName;
export const canonicalRepositoryName = canonicalRepositoryFullName;

/** Normalize a scope row and discard all unneeded remote fields. */
export function normalizeWatchRepository(value: unknown): GitHubWatchRepository {
  const input = record(value);
  const fullName = normalizeRepositoryFullName(input?.full_name);
  return { full_name: fullName };
}

/** Construct the only repository-page URL the Watch UI is allowed to open. */
export function repositoryHtmlUrl(fullName: unknown): string {
  return `${WEB_ORIGIN}/${normalizeRepositoryFullName(fullName)}`;
}

function apiPathSegments(value: string): string[] | null {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== API_ORIGIN || parsed.username || parsed.password || parsed.port) return null;
    if (parsed.search || parsed.hash) return null;
    const rawSegments = parsed.pathname.split('/');
    if (
      rawSegments[0] !== '' ||
      rawSegments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      return null;
    }
    const segments: string[] = [];
    for (const segment of rawSegments.slice(1)) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return null;
      }
      // Encoded separators must not become a different repository/path.
      if (decoded.includes('/') || decoded.includes('\\') || decoded === '.' || decoded === '..') return null;
      segments.push(decoded);
    }
    return segments;
  } catch {
    return null;
  }
}

function normalizedSubjectType(value: string): WatchSubjectKind | null {
  switch (value.trim().toLowerCase().replace(/[\s_-]+/gu, '')) {
    case 'issue':
      return 'issue';
    case 'pullrequest':
      return 'pull_request';
    default:
      return null;
  }
}

/**
 * Validate one cached Issue/PR subject and rebuild every URL used with the main
 * credential. The cached remote URL selects no host, query, or route directly.
 */
export function watchSubjectIdentity(
  thread: GitHubNotificationThread,
): WatchSubjectIdentity | null {
  const kind = normalizedSubjectType(thread.subjectType);
  if (!kind || !thread.subjectApiUrl) return null;
  const parts = apiPathSegments(thread.subjectApiUrl);
  if (!parts || parts.length !== 5 || parts[0] !== 'repos') return null;

  let repositoryFullName: string;
  try {
    repositoryFullName = normalizeRepositoryFullName(`${parts[1]}/${parts[2]}`);
  } catch {
    return null;
  }
  if (repositoryFullName !== canonicalRepositoryFullName(thread.repositoryFullName)) return null;

  const expectedRoute = kind === 'issue' ? 'issues' : 'pulls';
  if (parts[3]!.toLowerCase() !== expectedRoute || !/^[1-9]\d*$/u.test(parts[4]!)) return null;
  const number = Number(parts[4]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  const [owner, repository] = repositoryFullName.split('/');
  const encodedOwner = encodeURIComponent(owner!);
  const encodedRepository = encodeURIComponent(repository!);
  return {
    kind,
    repositoryFullName,
    number,
    apiUrl: `${API_ORIGIN}/repos/${encodedOwner}/${encodedRepository}/issues/${number}`,
    htmlUrl: kind === 'issue'
      ? `${WEB_ORIGIN}/${repositoryFullName}/issues/${number}`
      : `${WEB_ORIGIN}/${repositoryFullName}/pull/${number}`,
  };
}

/**
 * Map a notification API subject URL to a browser URL only when the route,
 * repository, subject type, and identifier all agree.  Unknown or hostile
 * values return null so callers can fall back to the repository page.
 */
export function safeSubjectHtmlUrl(input: {
  repositoryFullName: string;
  subjectType: string;
  subjectApiUrl: string | null | undefined;
}): string | null;
export function safeSubjectHtmlUrl(
  repositoryFullName: string,
  subjectType: string,
  subjectApiUrl: string | null | undefined,
): string | null;
export function safeSubjectHtmlUrl(
  first: {
    repositoryFullName: string;
    subjectType: string;
    subjectApiUrl: string | null | undefined;
  } | string,
  second?: string,
  third?: string | null,
): string | null {
  const repositoryFullName = typeof first === 'string' ? first : first.repositoryFullName;
  const subjectType = typeof first === 'string' ? second ?? '' : first.subjectType;
  const subjectApiUrl = typeof first === 'string' ? third : first.subjectApiUrl;
  let canonicalRepository: string;
  try {
    canonicalRepository = normalizeRepositoryFullName(repositoryFullName);
  } catch {
    return null;
  }
  if (typeof subjectApiUrl !== 'string' || subjectApiUrl.trim() === '' || typeof subjectType !== 'string') {
    return null;
  }
  const parts = apiPathSegments(subjectApiUrl);
  if (!parts || parts.length !== 5 || parts[0] !== 'repos') return null;
  let routeRepository: string;
  try {
    routeRepository = normalizeRepositoryFullName(`${parts[1]}/${parts[2]}`);
  } catch {
    return null;
  }
  if (routeRepository !== canonicalRepository) return null;

  const route = parts[3]!.toLowerCase();
  const identifier = parts[4]!;
  const type = subjectType.trim().toLowerCase();
  if (type === 'issue') {
    if (route !== 'issues' || !/^[1-9]\d*$/.test(identifier)) return null;
    return `${WEB_ORIGIN}/${canonicalRepository}/issues/${identifier}`;
  }
  if (type === 'pullrequest' || type === 'pull_request' || type === 'pull request') {
    if ((route !== 'issues' && route !== 'pulls') || !/^[1-9]\d*$/.test(identifier)) return null;
    return `${WEB_ORIGIN}/${canonicalRepository}/pull/${identifier}`;
  }
  if (type === 'discussion') {
    if (route !== 'discussions' || !/^[1-9]\d*$/.test(identifier)) return null;
    return `${WEB_ORIGIN}/${canonicalRepository}/discussions/${identifier}`;
  }
  if (type === 'commit') {
    if (route !== 'commits' || !/^[0-9a-fA-F]{7,64}$/.test(identifier)) return null;
    return `${WEB_ORIGIN}/${canonicalRepository}/commit/${identifier}`;
  }
  return null;
}

/** Positional alias used by API-source callers. */
export function deriveSubjectHtmlUrl(
  repositoryFullName: string,
  subjectType: string,
  subjectApiUrl: string | null | undefined,
): string | null {
  return safeSubjectHtmlUrl(repositoryFullName, subjectType, subjectApiUrl);
}

export const mapSubjectHtmlUrl = deriveSubjectHtmlUrl;

export interface NotificationPayloadValidationOptions extends NormalizeNotificationOptions {}

function normalizeNotificationAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.hash
      || url.hostname.toLocaleLowerCase('en-US') !== 'avatars.githubusercontent.com'
      || [...url.searchParams.keys()].some((key) => key !== 'v')
      || url.searchParams.getAll('v').length > 1
      || (url.searchParams.has('v') && !/^\d+$/u.test(url.searchParams.get('v') ?? ''))
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Normalize one raw `/notifications` row. */
export function normalizeNotificationThread(
  value: unknown,
  options: NotificationPayloadValidationOptions = {},
): GitHubNotificationThread {
  const input = record(value);
  if (!input || !nonEmptyString(input.id)) {
    throw new GitHubWatchError('invalid_thread', 'notification id is required');
  }
  const repository = record(input.repository);
  const subject = record(input.subject);
  if (!repository || !subject) {
    throw new GitHubWatchError('invalid_thread', 'notification repository and subject are required');
  }
  let repositoryFullName: string;
  try {
    repositoryFullName = normalizeRepositoryFullName(repository.full_name);
  } catch {
    throw new GitHubWatchError('invalid_thread', 'invalid notification repository');
  }
  if (!nonEmptyString(subject.title) || !nonEmptyString(input.reason) || !nonEmptyString(subject.type)) {
    throw new GitHubWatchError('invalid_thread', 'notification title, reason, and type are required');
  }
  if (typeof input.unread !== 'boolean') {
    throw new GitHubWatchError('invalid_thread', 'notification unread must be boolean');
  }
  const updatedAt = normalizedTimestamp(input.updated_at, 'updated_at');
  let lastReadAt: string | null = null;
  if (input.last_read_at !== undefined && input.last_read_at !== null) {
    lastReadAt = normalizedTimestamp(input.last_read_at, 'last_read_at');
  }
  let subjectApiUrl: string | null = null;
  if (input.subject && Object.prototype.hasOwnProperty.call(subject, 'url')) {
    if (subject.url !== null && subject.url !== undefined && typeof subject.url !== 'string') {
      throw new GitHubWatchError('invalid_thread', 'notification subject url must be string or null');
    }
    subjectApiUrl = typeof subject.url === 'string' ? subject.url : null;
  }
  // Rebuild from the validated repository name instead of trusting a remote URL.
  const repositoryUrl = repositoryHtmlUrl(repositoryFullName);
  const subjectType = subject.type.trim();
  const repositoryOwner = record(repository.owner);
  return {
    id: input.id.trim(),
    repositoryFullName,
    repositoryHtmlUrl: repositoryUrl,
    repositoryOwnerLogin: typeof repositoryOwner?.login === 'string'
      ? repositoryOwner.login.toLocaleLowerCase('en-US')
      : null,
    repositoryOwnerAvatarUrl: normalizeNotificationAvatarUrl(repositoryOwner?.avatar_url),
    reason: input.reason.trim(),
    subjectType,
    subjectTitle: subject.title.trim(),
    subjectApiUrl,
    subjectHtmlUrl: safeSubjectHtmlUrl({
      repositoryFullName,
      subjectType,
      subjectApiUrl,
    }),
    unread: input.unread,
    updatedAt,
    lastReadAt,
    fetchedAt: normalizedFetchedAt(options.fetchedAt),
  };
}

export const normalizeGitHubNotification = normalizeNotificationThread;

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stable newest-first ordering; IDs provide a deterministic tie breaker. */
export function sortNotificationThreads(
  threads: Iterable<GitHubNotificationThread>,
): GitHubNotificationThread[] {
  return Array.from(threads).sort((left, right) => {
    const time = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
    if (time !== 0) return time;
    return left.id.localeCompare(right.id);
  });
}

/** Deduplicate by thread id, retaining the newest deterministic representation. */
export function dedupeNotificationThreads(
  threads: Iterable<GitHubNotificationThread>,
): GitHubNotificationThread[] {
  const byId = new Map<string, GitHubNotificationThread>();
  for (const thread of threads) {
    const current = byId.get(thread.id);
    if (!current) {
      byId.set(thread.id, thread);
      continue;
    }
    const currentTime = timestampValue(current.updatedAt);
    const nextTime = timestampValue(thread.updatedAt);
    if (nextTime > currentTime || (nextTime === currentTime && JSON.stringify(thread) < JSON.stringify(current))) {
      byId.set(thread.id, thread);
    }
  }
  return sortNotificationThreads(byId.values());
}

export function filterNotificationThreads(
  threads: Iterable<GitHubNotificationThread>,
  unreadOnly = false,
): GitHubNotificationThread[] {
  const selected = unreadOnly ? Array.from(threads).filter((thread) => thread.unread) : Array.from(threads);
  return sortNotificationThreads(selected);
}

export const filterWatchNotifications = filterNotificationThreads;

/** Group threads by canonical repository, newest group first. */
export function groupNotificationThreads(
  threads: Iterable<GitHubNotificationThread>,
  options: { unreadOnly?: boolean } = {},
): WatchNotificationGroup[] {
  const selected = filterNotificationThreads(threads, options.unreadOnly ?? false);
  const groups = new Map<string, WatchNotificationGroup>();
  for (const thread of selected) {
    const group = groups.get(thread.repositoryFullName);
    if (group) {
      group.threads.push(thread);
      if (timestampValue(thread.updatedAt) > timestampValue(group.latestUpdatedAt)) {
        group.latestUpdatedAt = thread.updatedAt;
      }
      group.repositoryOwnerLogin ??= thread.repositoryOwnerLogin ?? null;
      group.repositoryOwnerAvatarUrl ??= thread.repositoryOwnerAvatarUrl ?? null;
    } else {
      groups.set(thread.repositoryFullName, {
        repositoryFullName: thread.repositoryFullName,
        repositoryHtmlUrl: thread.repositoryHtmlUrl,
        repositoryOwnerLogin: thread.repositoryOwnerLogin ?? null,
        repositoryOwnerAvatarUrl: thread.repositoryOwnerAvatarUrl ?? null,
        latestUpdatedAt: thread.updatedAt,
        threads: [thread],
      });
    }
  }
  return Array.from(groups.values()).sort((left, right) => {
    const time = timestampValue(right.latestUpdatedAt) - timestampValue(left.latestUpdatedAt);
    if (time !== 0) return time;
    return left.repositoryFullName.localeCompare(right.repositoryFullName);
  });
}

export const groupWatchNotifications = groupNotificationThreads;

export function projectWatchInbox(
  threads: Iterable<GitHubNotificationThread>,
  options: { unreadOnly?: boolean } = {},
): WatchInboxProjection {
  const selected = filterNotificationThreads(threads, options.unreadOnly ?? false);
  return {
    threads: selected,
    groups: groupNotificationThreads(selected),
    unreadCount: selected.reduce((count, thread) => count + Number(thread.unread), 0),
    totalCount: selected.length,
  };
}

export const queryWatchInbox = projectWatchInbox;

/**
 * GitHub's `reason` explains why a notification reached the authenticated
 * user's Inbox; it is not a locally inferred tag or proof of current state.
 * Keep unknown values persisted for forward compatibility.
 * @see https://docs.github.com/en/rest/activity/notifications#about-notification-reasons
 */
export const KNOWN_NOTIFICATION_REASONS = [
  'approval_requested',
  'assign',
  'author',
  'comment',
  'ci_activity',
  'invitation',
  'manual',
  'member_feature_requested',
  'mention',
  'review_requested',
  'security_advisory_credit',
  'security_alert',
  'state_change',
  'subscribed',
  'team_mention',
] as const;

export const KNOWN_NOTIFICATION_SUBJECT_TYPES = [
  'Issue',
  'PullRequest',
  'Discussion',
  'Commit',
  'Release',
] as const;

export function notificationReasonLabel(reason: string): string {
  const value = reason.trim();
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function notificationSubjectTypeLabel(type: string): string {
  const value = type.trim();
  if (!value) return 'Unknown';
  if (value.toLowerCase() === 'pullrequest' || value.toLowerCase() === 'pull_request') return 'Pull Request';
  return value.replace(/[_-]+/g, ' ');
}
