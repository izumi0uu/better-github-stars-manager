/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Radar } from '@/ui/components/Radar';
import { RadarCommandBarActions } from '@/ui/components/RadarCommandBar';
import { RadarStatusRibbon } from '@/ui/components/RadarStatusRibbon';
import type { RadarQueryResponse, RadarStatus } from '@/radar/radar-contract';
import type { RadarActivityPresentation } from '@/radar/radar-model';
import type {
  RecommendationQueryResponse,
  RecommendationRecord,
} from '@/recommendations/recommendation-model';
import { cleanupMountedRootsAndBody, setInputValue } from './test-utils';
import { TooltipProvider } from '@/ui/shadcn/tooltip';

const virtualizerSpies = vi.hoisted(() => ({
  measureElement: vi.fn(),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      start: index * 100,
    })),
    measureElement: virtualizerSpies.measureElement,
  }),
}));

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
  overrides: Partial<React.ComponentProps<typeof Radar>> = {},
): React.ComponentProps<typeof Radar> {
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
    recommendationFavorites: {},
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
  virtualizerSpies.measureElement.mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Radar', () => {
  it('keeps the Following feed and command controls intact', () => {
    const container = mount(<Radar {...surfaceProps()} />);

    expect(container.querySelectorAll('[data-radar-row]')).toHaveLength(2);
    expect(container.querySelector('[data-surface-command-bar="following"]')).not.toBeNull();
    expect(container.querySelector('[data-radar-discover-view="following"]')).not.toBeNull();
    expect(container.textContent).toContain('End of 30-day window · 2 activities');
    expect(container.querySelector('[data-radar-view="for-you"]')).toBeNull();
  });

  it('keeps the Following command bar mounted and defers loading copy to the ribbon', () => {
    const container = mount(<Radar {...surfaceProps({ loading: true, result: null })} />);
    const ribbon = mount(
      <RadarStatusRibbon
        result={null}
        loading
        refreshing={false}
        error={null}
        onOpenOptions={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-surface-command-bar="following"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Loading…');
    expect(ribbon.querySelector('[data-radar-status="loading"]')).not.toBeNull();
    expect(ribbon.textContent).toContain('Loading…');
  });

  it('keeps the For You command bar mounted while the cold recommendation query resolves', () => {
    const container = mount(<Radar {...surfaceProps({
      discoverView: 'for-you',
      recommendationLoading: true,
      recommendations: null,
    })} />);

    expect(container.querySelector('[data-surface-command-bar="for-you"]')).not.toBeNull();
    expect(container.querySelector('[data-radar-discover-view="for-you"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Loading…');
  });


  it('keeps dismiss separate from seen intent and restores focus after removal', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const onDismiss = vi.fn(noOp);
    const onMarkSeen = vi.fn();
    const initialResult = radarResult();
    const baseProps = surfaceProps({ onDismiss, onMarkSeen });
    let nextFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const render = (
      result: RadarQueryResponse,
      pendingAction: React.ComponentProps<typeof Radar>['pendingAction'],
    ) => act(() => root.render(
      <TooltipProvider>
        <Radar {...baseProps} result={result} pendingAction={pendingAction} />
      </TooltipProvider>,
    ));

    render(initialResult, null);
    const firstDismiss = container.querySelector<HTMLButtonElement>('[data-radar-dismiss]');
    expect(firstDismiss).not.toBeNull();
    act(() => firstDismiss?.click());

    expect(onMarkSeen).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledWith('owner/one', ['one']);

    render(initialResult, { kind: 'dismiss', repositoryKey: 'owner/one' });
    render({
      ...initialResult,
      activities: initialResult.activities.slice(1),
      unseenCount: 1,
    }, null);
    act(() => {
      const callback = nextFrame;
      nextFrame = null;
      callback?.(0);
    });

    const remainingDismiss = container.querySelector<HTMLButtonElement>('[data-radar-dismiss]');
    expect(remainingDismiss).not.toBeNull();
    expect(document.activeElement).toBe(remainingDismiss);
  });

  it('preserves keyed virtual activity and project rows with measurement indices', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const scrollElement = document.createElement('div');
    const initialResult = radarResult();
    const reversedResult = {
      ...initialResult,
      activities: [...initialResult.activities].reverse(),
    };
    const reorderedProjectResult = {
      ...initialResult,
      activities: initialResult.activities.map((row) => ({
        ...row,
        starredAt: row.id === 'one'
          ? '2026-08-09T10:00:00.000Z'
          : '2026-08-11T10:00:00.000Z',
      })),
    };
    const baseProps = surfaceProps({ scrollElement });
    const render = (result: RadarQueryResponse, view: 'feed' | 'projects') => act(() => root.render(
      <TooltipProvider>
        <Radar {...baseProps} result={result} view={view} />
      </TooltipProvider>,
    ));

    render(initialResult, 'feed');
    const activityWrapper = container
      .querySelector('[data-radar-row="one"]')
      ?.closest<HTMLElement>('[data-index]');
    expect(activityWrapper?.dataset.index).toBe('0');
    expect(container.querySelectorAll('[data-index]')).toHaveLength(2);
    expect(virtualizerSpies.measureElement).toHaveBeenCalled();

    render(reversedResult, 'feed');
    expect(container.querySelector('[data-radar-row="one"]')?.closest('[data-index]'))
      .toBe(activityWrapper);
    expect(activityWrapper?.dataset.index).toBe('1');

    render(initialResult, 'projects');
    const projectWrapper = container
      .querySelector('[data-radar-project="owner/one"]')
      ?.closest<HTMLElement>('[data-index]');
    expect(projectWrapper?.dataset.index).toBe('0');

    render(reorderedProjectResult, 'projects');
    expect(container.querySelector('[data-radar-project="owner/one"]')?.closest('[data-index]'))
      .toBe(projectWrapper);
    expect(projectWrapper?.dataset.index).toBe('1');
  });

  it('scopes topic suggestions and tag mutations to the selected repository', async () => {
    const onAddTag = vi.fn(noOp);
    const container = mount(<Radar {...surfaceProps({ onAddTag })} />);
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
    const container = mount(<Radar {...surfaceProps({ result })} />);
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
        <Radar {...surfaceProps({ result, onStar, onUnstar })} />
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
    const container = mount(<Radar {...surfaceProps({
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
    const container = mount(<Radar {...surfaceProps({ onDiscoverViewChange })} />);
    const forYouTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes('For You'));

    await act(async () => { forYouTab?.click(); });
    expect(onDiscoverViewChange).toHaveBeenCalledWith('for-you');
    onDiscoverViewChange.mockClear();


    const followingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes('Following'));
    await act(async () => {
      followingTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onDiscoverViewChange).toHaveBeenCalledTimes(1);
    expect(onDiscoverViewChange).toHaveBeenCalledWith('for-you');
  });

  it('renders repository identity, topics, and annotation controls', () => {
    const container = mount(<Radar {...surfaceProps({ discoverView: 'for-you' })} />);
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
    expect(row?.querySelector('[data-recommendation-action="favorite"]')).not.toBeNull();
    expect(row?.querySelector('[data-recommendation-action="tag"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://github.com/trending"]')).not.toBeNull();
  });

  it('favorites and tags a recommendation with exact repository identity', async () => {
    const onSetFavorite = vi.fn(noOp);
    const onAddTag = vi.fn(noOp);
    const container = mount(<Radar {...surfaceProps({
      discoverView: 'for-you',
      onSetFavorite,
      onAddTag,
    })} />);
    const row = container.querySelector('[data-recommendation-row="candidate/tool"]');
    const favorite = row?.querySelector<HTMLButtonElement>('[data-recommendation-action="favorite"]');
    const tag = row?.querySelector<HTMLButtonElement>('[data-recommendation-action="tag"]');

    expect(favorite?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { favorite?.click(); });
    expect(onSetFavorite).toHaveBeenCalledWith('candidate/tool', 'Candidate/Tool', true);
    const favorited = mount(<Radar {...surfaceProps({
      discoverView: 'for-you',
      recommendationFavorites: { 'candidate/tool': true },
    })} />).querySelector<HTMLButtonElement>(
      '[data-recommendation-row="candidate/tool"] [data-recommendation-action="favorite"]',
    );
    expect(favorited?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => { tag?.click(); });
    const suggestions = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-recommendation-tag-composer="candidate/tool"] [aria-label="Suggested tags"] button'),
    );
    expect(suggestions.map((button) => button.textContent)).toContain('developer-tools');
    await act(async () => { suggestions[0]?.click(); });
    expect(onAddTag).toHaveBeenCalledWith('candidate/tool', 'Candidate/Tool', suggestions[0]?.textContent);
  });
  it('ignores a recommendation row and reports the repository key', async () => {
    const onIgnore = vi.fn(noOp);
    const container = mount(<Radar {...surfaceProps({
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
    const container = mount(<Radar {...surfaceProps({
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
    const container = mount(<Radar {...surfaceProps({
      result: { ...radarResult(), activities: [avatarActivity], unseenCount: 1 },
    })} />);
    const avatar = container.querySelector('img[data-repository-avatar]');
    expect(avatar?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/1?v=4');
  });

  it('falls back to a square colored initial when a For You avatar fails to load', () => {
    const container = mount(<Radar {...surfaceProps({ discoverView: 'for-you' })} />);
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
        <Radar {...surfaceProps({ discoverView: 'following' })} />
      </TooltipProvider>
    );
    const forYou = () => (
      <TooltipProvider>
        <Radar {...surfaceProps({ discoverView: 'for-you' })} />
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
        <Radar {...surfaceProps({ result: null })} />
      </TooltipProvider>,
    ));
    act(() => root.render(
      <TooltipProvider>
        <Radar {...surfaceProps()} />
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
    const container = mount(<Radar {...surfaceProps({
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
    const states: Array<Partial<React.ComponentProps<typeof Radar>>> = [
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
          <Radar {...surfaceProps(state)} />
        </TooltipProvider>,
      ));
    }
    expect(container.querySelector('[data-radar-surface]')).not.toBeNull();
    expect(container.querySelector('[data-radar-discover-view="following"]')).not.toBeNull();
  });

  it('dismisses the saved-recommendations warning banner manually', async () => {
    const container = mount(<Radar {...surfaceProps({
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
    const container = mount(<Radar {...surfaceProps({ discoverView: 'for-you' })} />);
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
    const container = mount(<Radar {...surfaceProps({ result: partialResult })} />);
    const banner = container.querySelector('[data-radar-partial-banner]');
    expect(banner?.textContent).toContain('Partial results');
    const dismiss = banner?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(dismiss).not.toBeNull();

    await act(async () => { dismiss?.click(); });
    expect(container.querySelector('[data-radar-partial-banner]')).toBeNull();
  });

  it('runs New batch from the command bar and keeps saved rows visible while refreshing', async () => {
    const onRefreshRecommendations = vi.fn();
    const container = mount(<Radar {...surfaceProps({
      discoverView: 'for-you',
      recommendationRefreshing: true,
      onRefreshRecommendations,
    })} />);
    const commandBar = container.querySelector('[data-surface-command-bar="for-you"]');
    const button = commandBar?.querySelector<HTMLButtonElement>('button[aria-label="Refreshing recommendations…"]');

    expect(button?.disabled).toBe(true);
    expect(container.querySelectorAll('[data-recommendation-row]')).toHaveLength(1);
    expect(container.textContent).toContain('Refreshing · showing saved recommendations');

    const idle = mount(<Radar {...surfaceProps({
      discoverView: 'for-you',
      onRefreshRecommendations,
    })} />);
    const newBatch = idle.querySelector<HTMLButtonElement>('button[aria-label="New batch"]');
    expect(newBatch?.textContent).toContain('New batch');
    await act(async () => { newBatch?.click(); });
    expect(onRefreshRecommendations).toHaveBeenCalledTimes(1);
  });

  it('filters For You rows and reports an empty search state', async () => {
    const container = mount(<Radar {...surfaceProps({ discoverView: 'for-you' })} />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search recommendations"]');
    expect(input).not.toBeNull();

    await act(async () => { setInputValue(input!, 'missing'); });
    expect(container.textContent).toContain('No recommendations match “missing”.');
  });

  it('preserves saved recommendations across stale and refresh error states', () => {
    const stale = recommendationResult({ snapshotStatus: 'stale', errorCode: 'network_error' });
    const container = mount(<Radar {...surfaceProps({
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
    const container = mount(<Radar {...surfaceProps({ discoverView: 'for-you', onStar })} />);
    const row = container.querySelector('[data-recommendation-row="candidate/tool"]');
    const starButton = row?.querySelector<HTMLButtonElement>('button[aria-label="Star Candidate/Tool on GitHub"]');

    expect(starButton?.textContent).toBe('Star');
    await act(async () => { starButton?.click(); });
    expect(onStar).toHaveBeenCalledWith('candidate/tool', 'Candidate/Tool');
  });

  it('renders helper text only for a failed recommendation action', () => {
    const normal = mount(<Radar {...surfaceProps({ discoverView: 'for-you' })} />);
    expect(normal.querySelector('[data-recommendation-row="candidate/tool"] [role="alert"]')).toBeNull();

    const failed = mount(<Radar {...surfaceProps({
      discoverView: 'for-you',
      actionError: { repositoryKey: 'candidate/tool', message: 'failed' },
    })} />);
    expect(failed.querySelector('[data-recommendation-row="candidate/tool"] [role="alert"]')?.textContent)
      .toContain('Action failed: failed');
  });
});

describe('RadarCommandBarActions', () => {
  it('disables refresh during cooldown', () => {
    const result = radarResult();
    const cooled: RadarQueryResponse = {
      ...result,
      status: status({ snapshotStatus: 'cooldown' }),
    };
    const container = mount(<RadarCommandBarActions
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
