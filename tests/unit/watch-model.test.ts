import { describe, expect, it } from 'vitest';
import {
  filterNotificationThreads,
  groupNotificationThreads,
  KNOWN_NOTIFICATION_REASONS,
  normalizeNotificationThread,
  safeSubjectHtmlUrl,
  watchSubjectIdentity,
} from '@/watch/watch-model';
import { parseWatchThreadIds, WATCH_MAX_THREAD_ACTIONS } from '@/watch/watch-contract';

function thread(id: string, repositoryFullName: string, updatedAt: string, unread = true) {
  return normalizeNotificationThread({
    id,
    unread,
    reason: 'mention',
    updated_at: updatedAt,
    last_read_at: null,
    repository: {
      full_name: repositoryFullName,
      html_url: `https://github.com/${repositoryFullName}`,
    },
    subject: {
      title: `Thread ${id}`,
      type: 'Issue',
      url: `https://api.github.com/repos/${repositoryFullName}/issues/1`,
    },
  }, { fetchedAt: '2026-08-05T04:00:00Z' });
}

describe('Watch domain model', () => {
  it('maps only strict same-repository browser-safe subject routes', () => {
    expect(safeSubjectHtmlUrl('owner/repo', 'Issue', 'https://api.github.com/repos/owner/repo/issues/12'))
      .toBe('https://github.com/owner/repo/issues/12');
    expect(safeSubjectHtmlUrl('owner/repo', 'PullRequest', 'https://api.github.com/repos/owner/repo/issues/12'))
      .toBe('https://github.com/owner/repo/pull/12');
    expect(safeSubjectHtmlUrl('owner/repo', 'Discussion', 'https://api.github.com/repos/owner/repo/discussions/12'))
      .toBe('https://github.com/owner/repo/discussions/12');
    expect(safeSubjectHtmlUrl('owner/repo', 'Commit', 'https://api.github.com/repos/owner/repo/commits/abcdef1'))
      .toBe('https://github.com/owner/repo/commit/abcdef1');
    expect(safeSubjectHtmlUrl('owner/repo', 'Release', 'https://api.github.com/repos/owner/repo/releases/1'))
      .toBeNull();
    expect(safeSubjectHtmlUrl('owner/repo', 'Issue', 'https://evil.example/repos/owner/repo/issues/12'))
      .toBeNull();
    expect(safeSubjectHtmlUrl('owner/repo', 'Issue', 'https://api.github.com/repos/other/repo/issues/12'))
      .toBeNull();
  });

  it('rebuilds Issue/PR detail identities from matching cached notification routes only', () => {
    const issue = thread('1', 'Owner/Repo', '2026-08-05T02:00:00Z');
    expect(watchSubjectIdentity(issue)).toEqual({
      kind: 'issue',
      repositoryFullName: 'owner/repo',
      number: 1,
      apiUrl: 'https://api.github.com/repos/owner/repo/issues/1',
      htmlUrl: 'https://github.com/owner/repo/issues/1',
    });

    const pull = {
      ...issue,
      subjectType: 'PullRequest',
      subjectApiUrl: 'https://api.github.com/repos/OWNER/REPO/pulls/42',
    };
    expect(watchSubjectIdentity(pull)).toEqual({
      kind: 'pull_request',
      repositoryFullName: 'owner/repo',
      number: 42,
      apiUrl: 'https://api.github.com/repos/owner/repo/issues/42',
      htmlUrl: 'https://github.com/owner/repo/pull/42',
    });

    expect(watchSubjectIdentity({ ...issue, subjectApiUrl: 'https://evil.example/repos/owner/repo/issues/1' }))
      .toBeNull();
    expect(watchSubjectIdentity({ ...issue, subjectApiUrl: 'https://api.github.com/repos/other/repo/issues/1' }))
      .toBeNull();
    expect(watchSubjectIdentity({ ...issue, subjectApiUrl: 'https://api.github.com/repos/owner/repo/issues/1?token=secret' }))
      .toBeNull();
    expect(watchSubjectIdentity({ ...issue, subjectType: 'Release' })).toBeNull();
  });

  it('rebuilds repository links from the canonical name instead of remote HTML URLs', () => {
    const normalized = normalizeNotificationThread({
      id: 'hostile-repository-url',
      unread: true,
      reason: 'mention',
      updated_at: '2026-08-05T02:00:00Z',
      last_read_at: null,
      repository: {
        full_name: 'Owner/Repo',
        html_url: 'https://evil.example/owner/repo',
      },
      subject: {
        title: 'Safe fallback',
        type: 'Release',
        url: 'https://api.github.com/repos/owner/repo/releases/1',
      },
    }, { fetchedAt: '2026-08-05T04:00:00Z' });

    expect(normalized.repositoryHtmlUrl).toBe('https://github.com/owner/repo');
    expect(normalized.subjectHtmlUrl).toBeNull();
  });

  it('accepts only canonical GitHub avatar URLs from notification owners', () => {
    const normalizeWithAvatar = (avatarUrl: string) => normalizeNotificationThread({
      id: `avatar-${avatarUrl}`,
      unread: true,
      reason: 'mention',
      updated_at: '2026-08-05T02:00:00Z',
      last_read_at: null,
      repository: {
        full_name: 'Owner/Repo',
        html_url: 'https://github.com/Owner/Repo',
        owner: { login: 'Owner', avatar_url: avatarUrl },
      },
      subject: {
        title: 'Avatar validation',
        type: 'Issue',
        url: 'https://api.github.com/repos/owner/repo/issues/1',
      },
    }, { fetchedAt: '2026-08-05T04:00:00Z' });

    expect(normalizeWithAvatar('https://avatars.githubusercontent.com/u/1?v=4').repositoryOwnerAvatarUrl)
      .toBe('https://avatars.githubusercontent.com/u/1?v=4');
    expect(normalizeWithAvatar('https://tracker.example/pixel.png').repositoryOwnerAvatarUrl).toBeNull();
    expect(normalizeWithAvatar('javascript:alert(1)').repositoryOwnerAvatarUrl).toBeNull();
  });

  it('fills missing group owner metadata from another cached thread', () => {
    const newestLegacy = thread('newest', 'Owner/Repo', '2026-08-05T03:00:00Z');
    const olderHydrated = {
      ...thread('older', 'owner/repo', '2026-08-05T02:00:00Z'),
      repositoryOwnerLogin: 'owner',
      repositoryOwnerAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    };

    const [group] = groupNotificationThreads([newestLegacy, olderHydrated]);

    expect(group?.repositoryOwnerLogin).toBe('owner');
    expect(group?.repositoryOwnerAvatarUrl).toBe('https://avatars.githubusercontent.com/u/1?v=4');
  });

  it('groups newest first with deterministic repository and thread ties', () => {
    const groups = groupNotificationThreads([
      thread('b', 'Beta/Repo', '2026-08-05T02:00:00Z'),
      thread('a', 'beta/repo', '2026-08-05T02:00:00Z'),
      thread('c', 'alpha/repo', '2026-08-05T03:00:00Z', false),
    ]);

    expect(groups.map((group) => group.repositoryFullName)).toEqual(['alpha/repo', 'beta/repo']);
    expect(groups[1]?.threads.map((item) => item.id)).toEqual(['a', 'b']);
    expect(groupNotificationThreads(groups.flatMap((group) => group.threads), { unreadOnly: true })
      .map((group) => group.repositoryFullName)).toEqual(['beta/repo']);
  });

  it('includes all threads by default and filters unread only when requested', () => {
    const unread = thread('unread', 'owner/repo', '2026-08-05T03:00:00Z');
    const read = thread('read', 'owner/repo', '2026-08-05T02:00:00Z', false);

    expect(filterNotificationThreads([read, unread]).map((item) => item.id))
      .toEqual(['unread', 'read']);
    expect(filterNotificationThreads([read, unread], true).map((item) => item.id))
      .toEqual(['unread']);
  });

  it('keeps the current documented notification reason catalog', () => {
    expect(KNOWN_NOTIFICATION_REASONS).toEqual([
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
    ]);
  });
  it('accepts only bounded unique numeric notification thread ids', () => {
    expect(parseWatchThreadIds([' 123 ', '456'])).toEqual(['123', '456']);
    expect(parseWatchThreadIds([])).toBeNull();
    expect(parseWatchThreadIds(['123', '123'])).toBeNull();
    expect(parseWatchThreadIds(['thread-123'])).toBeNull();
    expect(parseWatchThreadIds(Array.from(
      { length: WATCH_MAX_THREAD_ACTIONS + 1 },
      (_, index) => String(index + 1),
    ))).toBeNull();
  });

});
