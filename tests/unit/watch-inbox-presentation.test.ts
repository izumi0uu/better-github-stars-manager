import { describe, expect, it } from 'vitest';
import {
  countWatchReasons,
  filterWatchInboxProjection,
  formatWatchRelativeTime,
  watchReasonPresetValues,
} from '@/ui/watch-inbox-presentation';
import {
  KNOWN_NOTIFICATION_REASONS,
  type GitHubNotificationThread,
  type WatchInboxProjection,
} from '@/watch/watch-model';

const NOW = Date.parse('2026-08-05T12:00:00Z');

describe('formatWatchRelativeTime', () => {
  it.each([
    ['2026-08-05T12:00:30Z', '<1m'],
    ['2026-08-05T11:59:01Z', '<1m'],
    ['2026-08-05T11:59:00Z', '1m'],
    ['2026-08-05T11:01:00Z', '59m'],
    ['2026-08-05T11:00:00Z', '1h'],
    ['2026-08-04T12:00:00Z', '1d'],
    ['2026-07-06T12:00:00Z', '1mo'],
    ['2025-08-05T12:00:00Z', '1y'],
  ])('formats %s against an injected clock as %s', (value, expected) => {
    expect(formatWatchRelativeTime(value, NOW)).toBe(expected);
  });

  it('returns null for missing or invalid input', () => {
    expect(formatWatchRelativeTime(null, NOW)).toBeNull();
    expect(formatWatchRelativeTime('', NOW)).toBeNull();
    expect(formatWatchRelativeTime('not-a-date', NOW)).toBeNull();
    expect(formatWatchRelativeTime('2026-08-05T12:00:00Z', Number.NaN)).toBeNull();
  });
});

function thread(
  id: string,
  repositoryFullName: string,
  subjectTitle: string,
  reason: string,
): GitHubNotificationThread {
  return {
    id,
    repositoryFullName,
    repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
    reason,
    subjectType: 'Issue',
    subjectTitle,
    subjectApiUrl: null,
    subjectHtmlUrl: null,
    unread: true,
    updatedAt: `2026-08-05T0${id}:00:00Z`,
    lastReadAt: null,
    fetchedAt: '2026-08-05T12:00:00Z',
  };
}

const threads = [
  thread('1', 'owner/alpha', 'Review the parser', 'review_requested'),
  thread('2', 'owner/alpha', 'Parser follow-up', 'review_requested'),
  thread('3', 'owner/security', 'Advisory credit', 'security_advisory_credit'),
  thread('4', 'owner/future', 'Future event', 'future_reason'),
];
const projection: WatchInboxProjection = {
  threads,
  groups: [],
  unreadCount: threads.length,
  totalCount: threads.length,
};

describe('Watch inbox presentation filters', () => {
  it('counts raw reasons and keeps unknown values', () => {
    expect(countWatchReasons(threads)).toEqual([
      { reason: 'future_reason', count: 1 },
      { reason: 'review_requested', count: 2 },
      { reason: 'security_advisory_credit', count: 1 },
    ]);
    expect(watchReasonPresetValues('other', countWatchReasons(threads).map((item) => item.reason)))
      .toEqual(['future_reason']);
  });

  it('combines repository/title search with multi-reason filtering', () => {
    const filtered = filterWatchInboxProjection(projection, {
      query: 'parser',
      reasons: ['review_requested', 'future_reason'],
    });
    expect(filtered.threads.map((item) => item.id)).toEqual(['2', '1']);
    expect(filtered.groups.map((group) => group.repositoryFullName)).toEqual(['owner/alpha']);
    expect(filtered.totalCount).toBe(2);
  });

  it('searches only repository names and subject titles', () => {
    expect(filterWatchInboxProjection(projection, { query: 'issue' }).threads).toEqual([]);
    expect(filterWatchInboxProjection(projection, { query: 'review_requested' }).threads)
      .toEqual([]);
    expect(filterWatchInboxProjection(projection, { query: ' OWNER/SECURITY ' }).threads)
      .toHaveLength(1);
  });

  it('treats an empty reason selection as all and normalizes selected values', () => {
    expect(filterWatchInboxProjection(projection, { reasons: [] }).totalCount).toBe(4);
    expect(filterWatchInboxProjection(projection, {
      reasons: [' REVIEW_REQUESTED '],
    }).threads.map((item) => item.id)).toEqual(['2', '1']);
  });

  it('maps documented presets only to reasons present in the current projection', () => {
    const available = countWatchReasons(threads).map((item) => item.reason);
    expect(watchReasonPresetValues('direct', available)).toEqual(['review_requested']);
    expect(watchReasonPresetValues('security', available)).toEqual(['security_advisory_credit']);
    expect(watchReasonPresetValues('watching', available)).toEqual([]);
  });

  it('partitions every documented reason into exactly one preset', () => {
    const presets = ['direct', 'security', 'participation', 'watching'] as const;
    const partitioned = presets.flatMap((preset) => (
      watchReasonPresetValues(preset, KNOWN_NOTIFICATION_REASONS)
    ));

    expect(partitioned).toHaveLength(KNOWN_NOTIFICATION_REASONS.length);
    expect(new Set(partitioned)).toEqual(new Set(KNOWN_NOTIFICATION_REASONS));
    expect(watchReasonPresetValues('other', KNOWN_NOTIFICATION_REASONS)).toEqual([]);
    expect(watchReasonPresetValues('other', [
      ...KNOWN_NOTIFICATION_REASONS,
      'future_reason',
    ])).toEqual(['future_reason']);
  });
});
