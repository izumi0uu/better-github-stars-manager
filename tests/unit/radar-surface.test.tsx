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
  const repositoryTopic = `topic-${repositoryKey.split('/').at(-1)}`;
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
    repositoryOwnerLogin: repositoryKey.split('/')[0] ?? null,
    repositoryOwnerAvatarUrl: null,
    repositoryTopics: [repositoryTopic],
    viewerHadStarred: false,
    starredAt: '2026-08-10T10:00:00.000Z',
    dismissedAt: null,
    seenAt: null,
    source: 'following',
    seen: false,
    viewerHasStarred: false,
    favorite: false,
    tags: [],
    suggestedTags: [repositoryTopic, 'shared-topic'],
    displayedStargazerCount: 10,
  };
}

function radarResult(): RadarQueryResponse {
  const activities = [activity('one', 'owner/one'), activity('two', 'owner/two')];
  return {
    activities,
    unseenCount: 2,
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
  ignored: RecommendationQueryResponse['ignored'] = [],
  rows: RecommendationQueryResponse['recommendations'] = [recommendation()],
): RecommendationQueryResponse {
  return {
    recommendations: rows,
    ignored,
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
    onUnstar: vi.fn(noOp),
    onIgnore: vi.fn(noOp),
    onRestoreIgnored: vi.fn(noOp),
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

  it('scopes topic suggestions and tag mutations to the selected repository', async () => {
    const onAddTag = vi.fn(noOp);
    const container = mount(<RadarSurface {...surfaceProps({ onAddTag })} />);
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Quick actions for owner/two"]',
    );

    await act(async () => { trigger?.click(); });
    const suggestionGroup = document.body.querySelector('[aria-label="Suggested tags"]');
    const suggestions = Array.from(suggestionGroup?.querySelectorAll<HTMLButtonElement>('button') ?? []);

    expect(suggestions.map((button) => button.textContent)).toEqual(['topic-two', 'shared-topic']);
    expect(document.body.textContent).not.toContain('topic-one');
    await act(async () => { suggestions[0]?.click(); });
    expect(onAddTag).toHaveBeenCalledWith('owner/two', 'owner/two', 'topic-two');
  });

  it('does not expose applied repository topics as suggested tags', async () => {
    const result = radarResult();
    result.activities[1] = { ...result.activities[1]!, tags: ['topic-two'] };
    const container = mount(<RadarSurface {...surfaceProps({ result })} />);
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Quick actions for owner/two"]',
    );

    await act(async () => { trigger?.click(); });
    const suggestionGroup = document.body.querySelector('[aria-label="Suggested tags"]');
    const suggestions = Array.from(suggestionGroup?.querySelectorAll<HTMLButtonElement>('button') ?? []);

    expect(suggestions.map((button) => button.textContent)).toEqual(['shared-topic']);
  });

  it('changes a starred Following quick action into an enabled Unstar action', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const onStar = vi.fn(noOp);
    const onUnstar = vi.fn(noOp);
    let result = radarResult();
    const render = () => act(() => root.render(
      <TooltipProvider>
        <RadarSurface {...surfaceProps({ result, onStar, onUnstar })} />
      </TooltipProvider>,
    ));

    render();
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Quick actions for owner/two"]',
    );
    await act(async () => { trigger?.click(); });
    const starButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim().startsWith('Star on GitHub'));
    await act(async () => { starButton?.click(); });
    expect(onStar).toHaveBeenCalledWith('owner/two', 'owner/two');

    result = {
      ...result,
      activities: result.activities.map((activity, index) => (
        index === 1 ? { ...activity, viewerHasStarred: true } : activity
      )),
    };
    render();
    const unstarButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim().startsWith('Unstar on GitHub'));

    expect(unstarButton?.disabled).toBe(false);
    await act(async () => { unstarButton?.click(); });
    expect(onUnstar).toHaveBeenCalledWith('owner/two', 'owner/two');
  });

  it('keeps the Following project action bar opaque and allows Unstar', async () => {
    const result = radarResult();
    result.activities[0] = {
      ...result.activities[0]!,
      viewerHasStarred: true,
      favorite: true,
    };
    const onUnstar = vi.fn(noOp);
    const container = mount(<RadarSurface {...surfaceProps({
      result,
      view: 'projects',
      onUnstar,
    })} />);
    const projectTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show details for owner/one"]',
    );

    await act(async () => { projectTrigger?.click(); });
    const actionBar = container.querySelector('[data-radar-project-actions]');
    const unstarButton = actionBar?.querySelector<HTMLButtonElement>(
      '[data-radar-project-action="star"]',
    );
    const favoriteButton = actionBar?.querySelector<HTMLButtonElement>(
      '[data-radar-project-action="favorite"]',
    );

    expect(actionBar?.classList.contains('bg-card')).toBe(true);
    expect(unstarButton?.classList.contains('bg-background')).toBe(true);
    expect(favoriteButton?.classList.contains('bg-background')).toBe(true);
    expect(unstarButton?.getAttribute('aria-label')).toBe('Unstar on GitHub');
    expect(unstarButton?.disabled).toBe(false);
    await act(async () => { unstarButton?.click(); });
    expect(onUnstar).toHaveBeenCalledWith('owner/one', 'owner/one');
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
  it('ignores a recommendation row and reports the repository key', async () => {
    const onIgnore = vi.fn(noOp);
    const container = mount(<RadarSurface {...surfaceProps({
      discoverView: 'for-you',
      onIgnore,
    })} />);
    const row = container.querySelector('[data-recommendation-row="candidate/tool"]');
    const ignoreButton = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="Never recommend Candidate/Tool again"]',
    );

    expect(ignoreButton).not.toBeNull();
    await act(async () => { ignoreButton?.click(); });
    expect(onIgnore).toHaveBeenCalledWith('candidate/tool', 'Candidate/Tool');
  });

  it('collapses the ignored list and restores a repository', async () => {
    const onRestoreIgnored = vi.fn(noOp);
    const ignored = [{
      id: 'viewer:one/repo',
      accountLogin: 'viewer',
      repositoryKey: 'one/repo',
      repositoryFullName: 'One/Repo',
      ignoredAt: '2026-08-10T11:00:00.000Z',
    }];
    const container = mount(<RadarSurface {...surfaceProps({
      discoverView: 'for-you',
      recommendations: recommendationResult({}, ignored),
      onRestoreIgnored,
    })} />);
    const section = container.querySelector('[data-radar-ignored-section]');
    const toggle = section?.querySelector<HTMLButtonElement>('button');

    expect(toggle?.textContent).toContain('1 ignored repository');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(section?.textContent).not.toContain('One/Repo');
    await act(async () => { toggle?.click(); });
    expect(section?.textContent).toContain('One/Repo');

    const restore = section?.querySelector<HTMLButtonElement>(
      'button[aria-label="Recommend One/Repo again"]',
    );
    expect(restore).not.toBeNull();
    await act(async () => { restore?.click(); });
    expect(onRestoreIgnored).toHaveBeenCalledWith('one/repo');
  });

  it('renders repository owner avatars on Following feed rows', () => {
    const avatarActivity = activity('one', 'owner/one');
    avatarActivity.repositoryOwnerAvatarUrl = 'https://avatars.githubusercontent.com/u/1?v=4';
    const container = mount(<RadarSurface {...surfaceProps({
      result: { ...radarResult(), activities: [avatarActivity], unseenCount: 1 },
    })} />);
    const avatar = container.querySelector('img[data-repository-avatar]');
    expect(avatar?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/1?v=4');
  });

  it('falls back to a square colored initial when a For You avatar fails to load', () => {
    const container = mount(<RadarSurface {...surfaceProps({ discoverView: 'for-you' })} />);
    const img = container.querySelector('img[src^="https://github.com/candidate.png"]');
    expect(img).not.toBeNull();
    act(() => { img?.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img[src^="https://github.com/candidate.png"]')).toBeNull();
    const fallback = container.querySelector('[data-avatar-color] .gsm-repository-avatar-fallback');
    expect(fallback?.textContent).toBe('C');
  });

  it('keeps hook order stable when switching between Following and For You', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const following = () => (
      <TooltipProvider>
        <RadarSurface {...surfaceProps({ discoverView: 'following' })} />
      </TooltipProvider>
    );
    const forYou = () => (
      <TooltipProvider>
        <RadarSurface {...surfaceProps({ discoverView: 'for-you' })} />
      </TooltipProvider>
    );
    act(() => root.render(following()));
    act(() => root.render(forYou()));
    expect(container.querySelector('[data-radar-discover-view="for-you"]')).not.toBeNull();
    act(() => root.render(following()));
    expect(container.querySelector('[data-radar-discover-view="following"]')).not.toBeNull();
  });

  it('keeps hook order stable when the radar result arrives after an empty first render', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(
      <TooltipProvider>
        <RadarSurface {...surfaceProps({ result: null })} />
      </TooltipProvider>,
    ));
    act(() => root.render(
      <TooltipProvider>
        <RadarSurface {...surfaceProps()} />
      </TooltipProvider>,
    ));
    expect(container.querySelector('[data-radar-surface]')).not.toBeNull();
  });

  it('keeps the ignored list reachable when every recommendation is dismissed', () => {
    const ignored = [{
      id: 'viewer:one/repo',
      accountLogin: 'viewer',
      repositoryKey: 'one/repo',
      repositoryFullName: 'One/Repo',
      ignoredAt: '2026-08-10T11:00:00.000Z',
    }];
    const container = mount(<RadarSurface {...surfaceProps({
      discoverView: 'for-you',
      recommendations: recommendationResult({}, ignored, []),
    })} />);
    expect(container.querySelector('[data-radar-ignored-section]')).not.toBeNull();
    expect(container.querySelector('[data-radar-ignored-section]')?.textContent)
      .toContain('1 ignored repository');
  });

  it('re-renders across every Following early-return state without hook-order errors', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const emptyState = {
      ...radarResult(),
      activities: [],
      unseenCount: 0,
      status: status({ state: { ...status().state!, activityCount: 0 } }),
    };
    const states: Array<Partial<React.ComponentProps<typeof RadarSurface>>> = [
      { result: null },
      {},
      { result: { ...radarResult(), status: status({ hasMainToken: false }) } },
      {},
      {
        result: {
          ...emptyState,
          status: status({ snapshotStatus: 'error', state: { ...status().state!, lastSuccessfulAt: null, activityCount: 0 } }),
        },
      },
      {},
      { result: { ...emptyState, status: status({ snapshotStatus: 'never_loaded' }) } },
      {},
      { result: { ...emptyState, status: status({ snapshotStatus: 'cooldown' }) } },
      {},
      { result: emptyState },
      {},
      { discoverView: 'for-you' },
      {},
    ];
    for (const state of states) {
      act(() => root.render(
        <TooltipProvider>
          <RadarSurface {...surfaceProps(state)} />
        </TooltipProvider>,
      ));
    }
    expect(container.querySelector('[data-radar-surface]')).not.toBeNull();
    expect(container.querySelector('[data-radar-discover-view="following"]')).not.toBeNull();
  });

  it('dismisses the saved-recommendations warning banner manually', async () => {
    const container = mount(<RadarSurface {...surfaceProps({
      discoverView: 'for-you',
      recommendations: recommendationResult({ snapshotStatus: 'stale' }),
    })} />);
    const banner = container.querySelector('[data-radar-saved-banner]');
    expect(banner?.textContent).toContain('Showing saved recommendations');
    const dismiss = banner?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(dismiss).not.toBeNull();

    await act(async () => { dismiss?.click(); });
    expect(container.querySelector('[data-radar-saved-banner]')).toBeNull();
  });

  it('keeps the fresh summary banner without a dismiss control', () => {
    const container = mount(<RadarSurface {...surfaceProps({ discoverView: 'for-you' })} />);
    const banner = container.querySelector('[data-radar-saved-banner]');
    expect(banner?.textContent).toContain('1 recommendation');
    expect(banner?.querySelector('button')).toBeNull();
  });

  it('dismisses the Following partial snapshot notice', async () => {
    const partialResult = radarResult();
    partialResult.status = status({
      snapshotStatus: 'partial',
      state: {
        ...status().state!,
        partialReasons: ['following_scan_truncated'],
      },
    });
    const container = mount(<RadarSurface {...surfaceProps({ result: partialResult })} />);
    const banner = container.querySelector('[data-radar-partial-banner]');
    expect(banner?.textContent).toContain('Partial results');
    const dismiss = banner?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(dismiss).not.toBeNull();

    await act(async () => { dismiss?.click(); });
    expect(container.querySelector('[data-radar-partial-banner]')).toBeNull();
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
    const ribbon = container.querySelector('[data-radar-status="fresh"]');
    expect(ribbon?.classList.contains('bg-card')).toBe(true);
    expect(ribbon?.classList.contains('bg-success/[0.07]')).toBe(false);
  });
});
