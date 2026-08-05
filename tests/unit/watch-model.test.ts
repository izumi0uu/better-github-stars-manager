import { describe, expect, it } from 'vitest';
import {
  groupNotificationThreads,
  KNOWN_NOTIFICATION_REASONS,
  normalizeNotificationThread,
  safeSubjectHtmlUrl,
} from '@/watch/watch-model';

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
});
