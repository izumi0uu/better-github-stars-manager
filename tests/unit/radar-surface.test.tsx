/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RadarStatusRibbon,
  RadarSurface,
  RadarSurfaceActions,
} from '@/ui/components/RadarSurface';
import type { RadarQueryResponse, RadarStatus } from '@/radar/radar-contract';
import type { RadarActivityPresentation } from '@/radar/radar-model';
import type {
  RecommendationQueryResponse,
  RecommendationRecord,
} from '@/recommendations/recommendation-model';
import { cleanupMountedRootsAndBody, setInputValue } from './test-utils';
import { TooltipProvider } from '@/ui/shadcn/tooltip';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function status(overrides: Partial<RadarStatus> = {}): RadarStatus {
  return {
    accountLogin: 'viewer',
    hasMainToken: true,
    refreshing: false,
    snapshotStatus: 'fresh',
    errorCode: null,
    state: {
      id: 'singleton',
      accountLogin: 'viewer',
      lastAttemptAt: '2026-08-10T12:00:00.000Z',
      lastSuccessfulAt: '2026-08-10T12:00:00.000Z',
      errorCode: null,
      nextAllowedAt: null,
      activityCount: 2,
      followingCount: 3,
      scannedFollowingCount: 3,
      batchCount: 1,
      partialReasons: [],
      rateLimitRemaining: 4_000,
      rateLimitResetAt: null,
    },
    ...overrides,
  };
}

function activity(id: string, repositoryKey: string): RadarActivityPresentation {
  return {
    id,
    accountLogin: 'viewer',
    actorLogin: `actor-${id}`,
    actorAvatarUrl: null,
    repositoryKey,
    repositoryFullName: repositoryKey,
    repositoryDisplayName: repositoryKey,
    repositoryHtmlUrl: `https://github.com/${repositoryKey}`,
    repositoryDescription: `${repositoryKey} description`,
    repositoryLanguage: 'TypeScript',
    repositoryLanguageColor: '#3178c6',
    repositoryStargazerCount: 10,
    viewerHadStarred: false,
    starredAt: '2026-08-10T10:00:00.000Z',
    dismissedAt: null,
    seenAt: null,
    source: 'following',
    seen: false,
    viewerHasStarred: false,
    favorite: false,
    tags: [],
    displayedStargazerCount: 10,
  };
}

function radarResult(): RadarQueryResponse {
  const activities = [activity('one', 'owner/one'), activity('two', 'owner/two')];
  return {
    activities,
    unseenCount: 2,
    suggestedTags: ['infra', 'ai'],
    status: status(),
  };
}

function recommendation(): RecommendationRecord {
  return {
    id: 'candidate/tool',
    accountLogin: 'viewer',
    repositoryKey: 'candidate/tool',
    repositoryFullName: 'Candidate/Tool',
    repositoryHtmlUrl: 'https://github.com/candidate/tool',
    description: 'A focused TypeScript developer tool',
    language: 'TypeScript',
    stargazerCount: 1234,
    topics: ['developer-tools', 'typescript', 'productivity'],
    owner: 'candidate',
    name: 'tool',
    pushedAt: '2026-08-10T08:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    fork: false,
    archived: false,
    score: 101,
    reason: {
      kind: 'topic',
      value: 'developer-tools',
      seedRepositoryKey: 'seed/repo',
      seedRepositoryFullName: 'Seed/Repo',
    },
    fetchedAt: '2026-08-10T12:00:00.000Z',
  };
}

function recommendationResult(
  overrides: Partial<RecommendationQueryResponse['status']> = {},
): RecommendationQueryResponse {
  return {
    recommendations: [recommendation()],
    status: {
      accountLogin: 'viewer',
      hasMainToken: true,
      refreshing: false,
      snapshotStatus: 'fresh',
      errorCode: null,
      state: {
        id: 'singleton',
        accountLogin: 'viewer',
        lastAttemptAt: '2026-08-10T12:00:00.000Z',
        lastSuccessfulAt: '2026-08-10T12:00:00.000Z',
        errorCode: null,
        nextAllowedAt: null,
        candidateCount: 1,
        seedCount: 2,
        queryCount: 2,
        rateLimitRemaining: 8,
        rateLimitResetAt: null,
      },
      ...overrides,
    },
  };
}

function mount(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<TooltipProvider>{element}</TooltipProvider>));
  mountedRoots.push(root);
  return container;
}

const noOp = async () => undefined;

function surfaceProps(
  overrides: Partial<React.ComponentProps<typeof RadarSurface>> = {},
): React.ComponentProps<typeof RadarSurface> {
  return {
    result: radarResult(),
    recommendations: recommendationResult(),
    discoverView: 'following',
    loading: false,
    recommendationLoading: false,
    refreshing: false,
    recommendationRefreshing: false,
    error: null,
    recommendationError: null,
    actionError: null,
    pendingAction: null,
    view: 'feed',
    sources: { following: true, self: false },
    onDiscoverViewChange: vi.fn(),
    onViewChange: vi.fn(),
    onSourceEnabledChange: vi.fn(),
    onRefresh: vi.fn(),
    onRefreshRecommendations: vi.fn(),
    onRetryQuery: vi.fn(),
    onRetryRecommendations: vi.fn(),
    onOpenOptions: vi.fn(),
    onStar: vi.fn(noOp),
    onSetFavorite: vi.fn(noOp),
    onAddTag: vi.fn(noOp),
    onDismiss: vi.fn(noOp),
    onMarkSeen: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.useRealTimers();
});

describe('RadarSurface', () => {
  it('keeps the Following feed and command controls intact', () => {
    const container = mount(<RadarSurface {...surfaceProps()} />);

    expect(container.querySelectorAll('[data-radar-row]')).toHaveLength(2);
    expect(container.querySelector('[data-surface-command-bar="following"]')).not.toBeNull();
    expect(container.querySelector('[data-radar-discover-view="following"]')).not.toBeNull();
    expect(container.textContent).toContain('End of 30-day window · 2 activities');
    expect(container.querySelector('[data-radar-view="for-you"]')).toBeNull();
  });

  it('switches Discover views with click and arrow-key tab semantics', async () => {
    const onDiscoverViewChange = vi.fn();
    const container = mount(<RadarSurface {...surfaceProps({ onDiscoverViewChange })} />);
    const forYouTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes('For You'));

    await act(async () => { forYouTab?.click(); });
    expect(onDiscoverViewChange).toHaveBeenCalledWith('for-you');

    const followingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes('Following'));
    await act(async () => {
      followingTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onDiscoverViewChange).toHaveBeenLastCalledWith('for-you');
  });

  it('renders repository identity and topics without annotation controls', () => {
    const container = mount(<RadarSurface {...surfaceProps({ discoverView: 'for-you' })} />);
    const row = container.querySelector('[data-recommendation-row="candidate/tool"]');
    const avatar = row?.querySelector<HTMLImageElement>('img');

    expect(row?.textContent).toContain('Candidate/Tool');
    expect(avatar?.src).toBe('https://github.com/candidate.png?size=64');
    expect(avatar?.alt).toBe('');
    expect(row?.textContent).toContain('developer-tools');
    expect(row?.textContent).toContain('typescript');
    expect(row?.textContent).toContain('+1');
    expect(row?.textContent).not.toContain('Not in your stars');
    expect(row?.textContent).not.toContain('Starring updates GitHub first');
    expect(row?.textContent).toContain('Because you starred Seed/Repo');
    expect(row?.textContent).toContain('shared topic · developer-tools');
    expect(row?.querySelector('a[href="https://github.com/candidate/tool"]')).not.toBeNull();
    expect(row?.querySelector('[data-radar-project-action="favorite"]')).toBeNull();
    expect(row?.textContent).not.toContain('Add tag');
    expect(container.querySelector('a[href="https://github.com/trending"]')).not.toBeNull();
  });

  it('runs New batch from the command bar and keeps saved rows visible while refreshing', async () => {
    const onRefreshRecommendations = vi.fn();
    const container = mount(<RadarSurface {...surfaceProps({
      discoverView: 'for-you',
      recommendationRefreshing: true,
      onRefreshRecommendations,
    })} />);
    const commandBar = container.querySelector('[data-surface-command-bar="for-you"]');
    const button = commandBar?.querySelector<HTMLButtonElement>('button[aria-label="Refreshing recommendations…"]');

    expect(button?.disabled).toBe(true);
    expect(container.querySelectorAll('[data-recommendation-row]')).toHaveLength(1);
    expect(container.textContent).toContain('Refreshing · showing saved recommendations');

    const idle = mount(<RadarSurface {...surfaceProps({
      discoverView: 'for-you',
      onRefreshRecommendations,
    })} />);
    const newBatch = idle.querySelector<HTMLButtonElement>('button[aria-label="New batch"]');
    expect(newBatch?.textContent).toContain('New batch');
    await act(async () => { newBatch?.click(); });
    expect(onRefreshRecommendations).toHaveBeenCalledTimes(1);
  });

  it('filters For You rows and reports an empty search state', async () => {
    const container = mount(<RadarSurface {...surfaceProps({ discoverView: 'for-you' })} />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search recommendations"]');
    expect(input).not.toBeNull();

    await act(async () => { setInputValue(input!, 'missing'); });
    expect(container.textContent).toContain('No recommendations match “missing”.');
  });

  it('preserves saved recommendations across stale and refresh error states', () => {
    const stale = recommendationResult({ snapshotStatus: 'stale', errorCode: 'network_error' });
    const container = mount(<RadarSurface {...surfaceProps({
      discoverView: 'for-you',
      recommendations: stale,
      recommendationError: 'refresh',
    })} />);

    expect(container.querySelectorAll('[data-recommendation-row]')).toHaveLength(1);
    expect(container.textContent).toContain('Showing saved recommendations');
    expect(container.textContent).toContain('End of saved recommendations · 1');
  });

  it('shows a concise Star action and preserves the repository mutation payload', async () => {
    const onStar = vi.fn(noOp);
    const container = mount(<RadarSurface {...surfaceProps({ discoverView: 'for-you', onStar })} />);
    const row = container.querySelector('[data-recommendation-row="candidate/tool"]');
    const starButton = row?.querySelector<HTMLButtonElement>('button[aria-label="Star Candidate/Tool on GitHub"]');

    expect(starButton?.textContent).toBe('Star');
    await act(async () => { starButton?.click(); });
    expect(onStar).toHaveBeenCalledWith('candidate/tool', 'Candidate/Tool');
  });

  it('renders helper text only for a failed recommendation action', () => {
    const normal = mount(<RadarSurface {...surfaceProps({ discoverView: 'for-you' })} />);
    expect(normal.querySelector('[data-recommendation-row="candidate/tool"] [role="alert"]')).toBeNull();

    const failed = mount(<RadarSurface {...surfaceProps({
      discoverView: 'for-you',
      actionError: { repositoryKey: 'candidate/tool', message: 'failed' },
    })} />);
    expect(failed.querySelector('[data-recommendation-row="candidate/tool"] [role="alert"]')?.textContent)
      .toContain('Action failed: failed');
  });
});

describe('RadarSurfaceActions', () => {
  it('disables refresh during cooldown', () => {
    const result = radarResult();
    const cooled: RadarQueryResponse = {
      ...result,
      status: status({ snapshotStatus: 'cooldown' }),
    };
    const container = mount(<RadarSurfaceActions
      result={cooled}
      loading={false}
      view="feed"
      refreshing={false}
      sources={{ following: true, self: false }}
      onViewChange={vi.fn()}
      onRefresh={vi.fn()}
      onSourceEnabledChange={vi.fn()}
    />);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.disabled).toBe(true);
  });
});

describe('RadarStatusRibbon', () => {
  it('announces a fresh Following snapshot', () => {
    const container = mount(<RadarStatusRibbon
      result={radarResult()}
      loading={false}
      refreshing={false}
      error={null}
      onOpenOptions={vi.fn()}
    />);
    expect(container.textContent).toContain('2 activities · 3 following');
  });
});
