import { describe, expect, it } from 'vitest';
import { DEMO_BUILD_CANARY, DEMO_FIXTURE } from '@/demo/fixtures';

function walkValues(value: unknown, visit: (key: string | null, value: unknown) => void, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    value.forEach((item) => walkValues(item, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    walkValues(child, visit, childKey);
  }
}

function expectDeeplyFrozen(value: unknown): void {
  walkValues(value, (_key, child) => {
    if (child && typeof child === 'object') expect(Object.isFrozen(child)).toBe(true);
  });
}

describe('public Demo fixture', () => {
  it('provides the required deterministic canonical coverage', () => {
    expect(DEMO_BUILD_CANARY).toBe('bgsm-public-demo-fixture-v1');
    expect(DEMO_FIXTURE.now).toBe(Date.parse('2026-08-16T12:00:00.000Z'));
    expect(DEMO_FIXTURE.account).toEqual({
      username: 'demo-scout',
      displayName: 'Mina Vale (Demo)',
      avatarUrl: DEMO_FIXTURE.avatarAssets['demo-scout'],
    });
    expect(DEMO_FIXTURE.stars.length).toBeGreaterThanOrEqual(60);
    expect(DEMO_FIXTURE.stars.filter((star) => !star.tombstone && star.viewer_has_starred !== false).length)
      .toBeGreaterThanOrEqual(60);
    expect(DEMO_FIXTURE.tagMeta).toHaveLength(10);
    expect(new Set(DEMO_FIXTURE.tagMeta.map((meta) => meta.name)).size).toBe(10);
    expect(DEMO_FIXTURE.watchThreads).toHaveLength(15);
    expect(new Set(DEMO_FIXTURE.watchThreads.map((thread) => thread.repositoryFullName)).size).toBe(4);
    expect(Object.keys(DEMO_FIXTURE.watchSubjectDetailsByThreadId)).toHaveLength(15);
    expect(DEMO_FIXTURE.radarActivities).toHaveLength(12);
    expect(DEMO_FIXTURE.recommendationBatches.length).toBeGreaterThan(1);
    expect(DEMO_FIXTURE.recommendationBatches.every((batch) => batch.length >= 6)).toBe(true);
    expect(DEMO_FIXTURE.watchState.accountLogin).toBe('demo-scout');
    expect(DEMO_FIXTURE.radarState.accountLogin).toBe('demo-scout');
    expect(DEMO_FIXTURE.recommendationState.accountLogin).toBe('demo-scout');
  });

  it('deep-freezes the canonical snapshot', () => {
    expectDeeplyFrozen(DEMO_FIXTURE);
  });


  it('contains only fictional inert navigation records and bundled local avatars', () => {
    const urls = [
      ...DEMO_FIXTURE.stars.map((star) => star.html_url),
      ...DEMO_FIXTURE.watchThreads.flatMap((thread) => [
        thread.repositoryHtmlUrl,
        thread.subjectHtmlUrl,
      ]),
      ...DEMO_FIXTURE.radarActivities.map((activity) => activity.repositoryHtmlUrl),
      ...DEMO_FIXTURE.recommendationBatches.flat().map((row) => row.repositoryHtmlUrl),
    ].filter((value): value is string => value !== null);
    expect(urls.every((url) => url === '#')).toBe(true);
    expect(urls.some((url) => url.includes('github.com'))).toBe(false);

    for (const asset of Object.values(DEMO_FIXTURE.avatarAssets)) {
      expect(asset).not.toMatch(/^https?:\/\//iu);
      expect(asset).not.toContain('githubusercontent.com');
    }
  });
});
