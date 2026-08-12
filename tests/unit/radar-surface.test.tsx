/**
 * @vitest-environment jsdom
 */
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

function activity(
  id: string,
  repositoryKey: string,
  starredAt: string,
  overrides: Partial<RadarActivityPresentation> = {},
): RadarActivityPresentation {
  return {
    id,
    accountLogin: 'viewer',
    actorLogin: `actor-${id}`,
    actorAvatarUrl: `https://avatars.example/actor-${id}.png`,
    repositoryKey,
    repositoryFullName: repositoryKey,
    repositoryDisplayName: repositoryKey,
    repositoryHtmlUrl: `https://github.com/${repositoryKey}`,
    repositoryDescription: `${repositoryKey} description`,
    repositoryLanguage: 'TypeScript',
    repositoryLanguageColor: '#3178c6',
    repositoryStargazerCount: 10,
    viewerHadStarred: false,
    starredAt,
    dismissedAt: null,
    seenAt: null,
    source: 'following',
    seen: false,
    viewerHasStarred: false,
    favorite: false,
    tags: [],
    displayedStargazerCount: 10,
    ...overrides,
  };
}

function result(
  activities: RadarActivityPresentation[],
  overrides: Partial<RadarStatus> = {},
): RadarQueryResponse {
  return {
    activities,
    unseenCount: activities.reduce((count, item) => count + (item.seen ? 0 : 1), 0),
    suggestedTags: ['infra', 'ai'],
    status: status({ ...overrides, state: overrides.state ?? status().state }),
  };
}

function withProviders(element: React.ReactElement): React.ReactElement {
  return <TooltipProvider>{element}</TooltipProvider>;
}

function mount(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(withProviders(element)));
  mountedRoots.push(root);
  return container;
}

const noOp = async () => undefined;

function surfaceProps(
  overrides: Partial<React.ComponentProps<typeof RadarSurface>> = {},
): React.ComponentProps<typeof RadarSurface> {
  return {
    result: result([
      activity('one', 'owner/one', '2026-08-10T11:00:00.000Z', { viewerHasStarred: true }),
      activity('two', 'owner/two', '2026-08-10T10:00:00.000Z'),
    ]),
    loading: false,
    refreshing: false,
    error: null,
    actionError: null,
    pendingAction: null,
    view: 'feed' as const,
    sources: { following: true, self: false },
    onViewChange: vi.fn(),
    onSourceEnabledChange: vi.fn(),
    onRefresh: vi.fn(),
    onRetryQuery: vi.fn(),
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
  vi.unstubAllGlobals();
});

describe('RadarSurface', () => {
  it('keeps Feed popover and renders Projects from the same activity dataset', async () => {
    const props = surfaceProps();
    const container = mount(<RadarSurface {...props} />);

    expect(container.querySelectorAll('[data-radar-row]')).toHaveLength(2);
    expect(container.querySelector('[data-surface-list-end]')?.textContent)
      .toContain('End of 30-day window · 2 activities');
    const actorLink = container.querySelector<HTMLAnchorElement>('a[href="https://github.com/actor-one"]');
    expect(actorLink?.target).toBe('_blank');
    expect(actorLink?.rel).toBe('noreferrer');
    expect(actorLink?.querySelector('img')?.getAttribute('src')).toBe('https://avatars.example/actor-one.png');
    const feedRepositoryLink = container.querySelector<HTMLAnchorElement>(
      '[data-radar-row="one"] a[href="https://github.com/owner/one"]',
    );
    expect(feedRepositoryLink?.target).toBe('_blank');
    expect(feedRepositoryLink?.rel).toBe('noreferrer');
    feedRepositoryLink?.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await act(async () => {
      feedRepositoryLink?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 90,
        detail: 1,
      }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Quick actions for owner/one"]')
        ?.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: 320,
          clientY: 240,
          detail: 1,
        }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"][aria-label="Quick actions for owner/one"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Starred');

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const popoverRepositoryLink = dialog?.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/owner/one"]',
    );
    expect(popoverRepositoryLink?.target).toBe('_blank');
    expect(popoverRepositoryLink?.rel).toBe('noreferrer');
    const buttons = dialog?.querySelectorAll<HTMLButtonElement>('[data-radar-action-stop]') ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[1]);

    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      (container.firstChild as HTMLElement).dispatchEvent(new Event('click', { bubbles: true }));
      // Re-render through the same root with Projects as the only presentation change.
      mountedRoots.at(-1)?.render(withProviders(<RadarSurface {...props} view="projects" />));
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-radar-project]')).toHaveLength(2);
    expect(container.querySelector('[data-radar-view="projects"]')?.getAttribute('data-surface-work-canvas'))
      .toBe('following');
    expect(container.querySelectorAll('[data-radar-project-timeline]')).toHaveLength(2);
    expect(container.querySelectorAll('a[href^="https://github.com/actor-"]')).toHaveLength(4);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const projectRepositoryLink = container.querySelector<HTMLAnchorElement>(
      '[data-radar-project="owner/one"] a[href="https://github.com/owner/one"]',
    );
    expect(projectRepositoryLink?.target).toBe('_blank');
    expect(projectRepositoryLink?.rel).toBe('noreferrer');
    expect(container.querySelector('[data-radar-project-inspector][data-open="false"]')).not.toBeNull();
  });

  it('searches people before repositories, highlights source ranges, and keeps complete projects', async () => {
    const props = surfaceProps({
      result: result([
        activity('actor-hit', 'org/shared', '2026-08-10T08:00:00.000Z', { actorLogin: 'alice' }),
        activity('repo-hit', 'org/alice-tool', '2026-08-10T11:00:00.000Z', { actorLogin: 'bob' }),
        activity('project-peer', 'org/shared', '2026-08-10T07:00:00.000Z', { actorLogin: 'carol' }),
        activity('miss', 'else/unrelated', '2026-08-10T12:00:00.000Z', { actorLogin: 'dana' }),
      ]),
    });
    const container = mount(<RadarSurface {...props} />);
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search people or repositories"]');
    if (!search) throw new Error('Expected Following search input');

    await setInputValue(search, 'alice');

    const feedRows = [...container.querySelectorAll<HTMLElement>('[data-radar-row]')];
    expect(feedRows.map((row) => row.dataset.radarRow)).toEqual(['actor-hit', 'repo-hit']);
    expect(feedRows[0]?.querySelector('[data-search-match]')?.textContent).toBe('alice');
    expect(feedRows[1]?.querySelector('[data-search-match]')?.textContent).toBe('alice');
    expect(container.querySelector('[data-surface-list-end]')?.textContent)
      .toContain('End of matching results · 2');

    await act(async () => {
      mountedRoots.at(-1)?.render(withProviders(<RadarSurface {...props} view="projects" />));
      await Promise.resolve();
    });

    const projects = [...container.querySelectorAll<HTMLElement>('[data-radar-project]')];
    expect(projects.map((project) => project.dataset.radarProject)).toEqual([
      'org/shared',
      'org/alice-tool',
    ]);
    const sharedProject = projects[0];
    expect(sharedProject?.querySelector('a[href="https://github.com/alice"]')).not.toBeNull();
    expect(sharedProject?.querySelector('a[href="https://github.com/carol"]')).not.toBeNull();
    expect([...sharedProject?.querySelectorAll('[data-search-match]') ?? []]
      .map((mark) => mark.textContent)).toContain('alice');

    const clear = container.querySelector<HTMLButtonElement>('button[aria-label="Clear Following search"]');
    await act(async () => {
      clear?.click();
      await Promise.resolve();
    });
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);
    expect(container.querySelectorAll('[data-radar-project]')).toHaveLength(3);
  });

  it('keeps actor links and the overflow count as separate Project stack items', () => {
    const container = mount(<RadarSurface {...surfaceProps({
      result: result([
        activity('stack-1', 'owner/stacked', '2026-08-10T11:00:00.000Z', { actorLogin: 'alice' }),
        activity('stack-2', 'owner/stacked', '2026-08-10T10:00:00.000Z', { actorLogin: 'bob' }),
        activity('stack-3', 'owner/stacked', '2026-08-10T09:00:00.000Z', { actorLogin: 'carol' }),
        activity('stack-4', 'owner/stacked', '2026-08-10T08:00:00.000Z', { actorLogin: 'dana' }),
        activity('stack-5', 'owner/stacked', '2026-08-10T07:00:00.000Z', { actorLogin: 'erin' }),
      ]),
      view: 'projects',
    })} />);
    const stack = container.querySelector<HTMLElement>('[data-radar-project-avatar-stack]');
    const actorLinks = stack?.querySelectorAll<HTMLAnchorElement>('a[href^="https://github.com/"]') ?? [];
    const overflow = stack?.querySelector<HTMLElement>('[data-radar-project-avatar-overflow]');

    expect(stack?.querySelectorAll('[data-radar-project-avatar-slot]')).toHaveLength(4);
    expect(Array.from(actorLinks).map((link) => link.getAttribute('href'))).toEqual([
      'https://github.com/alice',
      'https://github.com/bob',
      'https://github.com/carol',
    ]);
    expect(overflow?.textContent).toBe('+2');
    expect(overflow?.matches('a, button')).toBe(false);
    expect(overflow?.closest('a, button')).toBeNull();
  });

  it('opens one in-flow Project inspector with the complete newest-first timeline', async () => {
    const newest = activity('newest', 'owner/shared', '2026-08-10T11:00:00.000Z', {
      actorLogin: 'alice',
    });
    const older = activity('older', 'owner/shared', '2026-08-10T10:00:00.000Z', {
      actorLogin: 'bob',
    });
    const other = activity('other', 'owner/other', '2026-08-10T09:00:00.000Z', {
      actorLogin: 'carol',
    });
    const container = mount(<RadarSurface {...surfaceProps({
      result: result([older, other, newest]),
      view: 'projects',
    })} />);

    const canvas = container.querySelector<HTMLElement>('[data-radar-view="projects"]');
    expect(canvas?.getAttribute('data-surface-work-canvas')).toBe('following');
    const row = container.querySelector<HTMLElement>('[data-radar-project="owner/shared"]');
    const trigger = row?.querySelector<HTMLButtonElement>('[data-radar-project-trigger]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.getAttribute('aria-controls')).toBeTruthy();
    const closedRegion = [...(row?.querySelectorAll<HTMLElement>('[data-radar-project-inspector]') ?? [])][0];
    expect(closedRegion?.getAttribute('role')).toBe('region');
    expect(closedRegion?.getAttribute('aria-labelledby')).toBe(trigger?.id);
    expect(closedRegion?.getAttribute('aria-hidden')).toBe('true');

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const openRegion = [...container.querySelectorAll<HTMLElement>('[data-radar-project-inspector]')]
      .find((candidate) => candidate.getAttribute('aria-labelledby') === trigger?.id);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(openRegion?.getAttribute('id')).toBe(trigger?.getAttribute('aria-controls'));
    expect(openRegion?.getAttribute('data-open')).toBe('true');
    expect(openRegion?.getAttribute('aria-hidden')).toBe('false');
    expect(openRegion?.querySelectorAll('[data-radar-project-timeline] time')).toHaveLength(2);
    const timelineLinks = openRegion?.querySelectorAll<HTMLAnchorElement>('[data-radar-project-timeline] a') ?? [];
    expect(Array.from(timelineLinks).map((link) => link.textContent)).toEqual(['alice', 'bob']);
    const actorSummary = row?.querySelector('[data-radar-project-actor-summary]')?.textContent ?? '';
    expect(actorSummary).toContain('alice');
    expect(actorSummary).toContain('bob');
    expect(openRegion?.textContent).not.toContain('owner/shared description');
    expect(container.querySelectorAll('[data-radar-project-inspector][data-open="true"]')).toHaveLength(1);

    const otherTrigger = container.querySelector<HTMLButtonElement>(
      '[data-radar-project="owner/other"] [data-radar-project-trigger]',
    );
    await act(async () => {
      otherTrigger?.click();
      await Promise.resolve();
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(otherTrigger?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('[data-radar-project-inspector][data-open="true"]')).toHaveLength(1);
  });

  it('exposes four Project actions and gives the tag composer Escape precedence', async () => {
    const onStar = vi.fn(noOp);
    const onSetFavorite = vi.fn(noOp);
    const onAddTag = vi.fn(noOp);
    const container = mount(<RadarSurface {...surfaceProps({
      result: result([
        activity('project', 'owner/project', '2026-08-10T11:00:00.000Z', {
          actorLogin: 'alice',
          repositoryDescription: 'A project with a useful description',
        }),
      ]),
      view: 'projects',
      onStar,
      onSetFavorite,
      onAddTag,
    })} />);
    const trigger = container.querySelector<HTMLButtonElement>('[data-radar-project-trigger]');

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const region = container.querySelector<HTMLElement>('[data-radar-project-inspector][data-open="true"]');
    const actions = region?.querySelector<HTMLElement>('[data-radar-project-actions]');
    expect(Array.from(actions?.children ?? []).map((child) => child.getAttribute('data-radar-project-action')))
      .toEqual(['star', 'favorite', 'tag', 'open']);
    expect(actions?.children).toHaveLength(4);
    expect(actions?.querySelectorAll('button, a')).toHaveLength(4);

    await act(async () => {
      actions?.querySelector<HTMLButtonElement>('[data-radar-project-action="star"]')?.click();
      actions?.querySelector<HTMLButtonElement>('[data-radar-project-action="favorite"]')?.click();
      await Promise.resolve();
    });
    expect(onStar).toHaveBeenCalledWith('owner/project', 'owner/project');
    expect(onSetFavorite).toHaveBeenCalledWith('owner/project', 'owner/project', true);

    await act(async () => {
      actions?.querySelector<HTMLButtonElement>('[data-radar-project-action="tag"]')?.click();
      await Promise.resolve();
    });
    const composer = region?.querySelector<HTMLElement>('[data-radar-project-composer]');
    const input = composer?.querySelector<HTMLInputElement>('input');
    expect(composer?.textContent).toContain('Adding a tag stars this repository first');
    expect(input).not.toBeNull();

    if (input) {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'ai');
      await act(async () => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
      expect(composer?.textContent).toContain('ai');
      expect(composer?.textContent).not.toContain('infra');
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await Promise.resolve();
      });
    }
    expect(onAddTag).toHaveBeenCalledWith('owner/project', 'owner/project', 'ai');

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(region?.querySelector('[data-radar-project-composer]')).toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(
      region?.querySelector('[data-radar-project-action="tag"]'),
    );

    await act(async () => {
      region?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Project dismissal independent from the disclosure trigger', async () => {
    const onDismiss = vi.fn(noOp);
    const container = mount(<RadarSurface {...surfaceProps({
      result: result([
        activity('new', 'owner/repo', '2026-08-10T11:00:00.000Z'),
        activity('old', 'owner/repo', '2026-08-10T10:00:00.000Z'),
      ]),
      view: 'projects',
      onDismiss,
    })} />);
    const row = container.querySelector<HTMLElement>('[data-radar-project="owner/repo"]');
    const trigger = row?.querySelector<HTMLButtonElement>('[data-radar-project-trigger]');
    expect(trigger?.querySelector('a, button, input')).toBeNull();

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      row?.querySelector<HTMLButtonElement>('[data-radar-dismiss]')?.click();
      await Promise.resolve();
    });
    expect(onDismiss).toHaveBeenCalledWith('owner/repo', ['new', 'old']);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect([...container.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.querySelector('a, button, input'))).toBe(false);
  });

  it('renders the full Project description only when the row summary is clipped', async () => {
    const description = 'A deliberately long project description that is clipped in the summary row.';
    const container = mount(<RadarSurface {...surfaceProps({
      result: result([
        activity('clip', 'owner/clip', '2026-08-10T11:00:00.000Z', {
          repositoryDescription: description,
        }),
      ]),
      view: 'projects',
    })} />);
    const summary = container.querySelector<HTMLElement>('[data-radar-project] p');
    expect(summary).not.toBeNull();
    if (summary) {
      Object.defineProperties(summary, {
        clientWidth: { configurable: true, value: 80 },
        clientHeight: { configurable: true, value: 16 },
        scrollWidth: { configurable: true, value: 320 },
        scrollHeight: { configurable: true, value: 16 },
      });
    }
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-radar-project-trigger]')?.click();
      await Promise.resolve();
    });
    const region = container.querySelector<HTMLElement>('[data-radar-project-inspector][data-open="true"]');
    expect(region?.querySelector('[data-radar-full-description]')?.textContent).toBe(description);
  });

  it('owns its controls inside the aligned Following command bar', () => {
    const onViewChange = vi.fn();
    const onSourceEnabledChange = vi.fn();
    const container = mount(<RadarSurface {...surfaceProps({
      onViewChange,
      onSourceEnabledChange,
    })} />);

    const commandBar = container.querySelector<HTMLElement>('[data-surface-command-bar="following"]');
    expect(commandBar?.querySelector('[data-surface-work-canvas="following"]')).not.toBeNull();
    expect(container.querySelector('[data-radar-view="feed"]')
      ?.getAttribute('data-surface-work-canvas')).toBe('following-feed');

    act(() => {
      Array.from(commandBar?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find((button) => button.textContent?.trim() === 'Projects')
        ?.click();
      commandBar?.querySelector<HTMLButtonElement>('[aria-label="Your own stars"]')?.click();
    });

    expect(onViewChange).toHaveBeenCalledWith('projects');
    expect(onSourceEnabledChange).toHaveBeenCalledWith('self', true);
  });

  it('uses the public GitHub avatar endpoint for legacy rows without a stored avatar', () => {
    const container = mount(<RadarSurface {...surfaceProps({
      result: result([
        activity('legacy', 'owner/legacy', '2026-08-10T11:00:00.000Z', { actorAvatarUrl: null }),
      ]),
    })} />);

    const actorLink = container.querySelector<HTMLAnchorElement>('a[href="https://github.com/actor-legacy"]');
    expect(actorLink?.querySelector('img')?.getAttribute('src'))
      .toBe('https://github.com/actor-legacy.png?size=48');
  });

  it('filters Following and Me independently without persisting self dismissals', async () => {
    const following = activity('following', 'owner/following', '2026-08-10T11:00:00.000Z');
    const own = activity('self', 'owner/self', '2026-08-10T10:00:00.000Z', {
      source: 'self',
      seen: true,
      actorLogin: 'viewer',
      actorAvatarUrl: null,
      viewerHasStarred: true,
    });
    const props = surfaceProps({ result: result([following, own]) });
    const container = mount(<RadarSurface {...props} />);

    expect(container.querySelectorAll('[data-radar-row]')).toHaveLength(1);
    expect(container.textContent).toContain('owner/following');
    expect(container.textContent).not.toContain('owner/self');

    await act(async () => {
      mountedRoots.at(-1)?.render(withProviders(
        <RadarSurface {...props} sources={{ following: true, self: true }} />,
      ));
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-radar-row]')).toHaveLength(2);

    await act(async () => {
      mountedRoots.at(-1)?.render(withProviders(
        <RadarSurface {...props} sources={{ following: false, self: true }} />,
      ));
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-radar-row]')).toHaveLength(1);
    expect(container.textContent).toContain('owner/self');
    expect(container.querySelectorAll('[data-radar-dismiss]')).toHaveLength(0);

    await act(async () => {
      mountedRoots.at(-1)?.render(withProviders(
        <RadarSurface {...props} sources={{ following: false, self: false }} />,
      ));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('No activity from selected sources');
  });

  it('marks Feed activity only after a stable fine-pointer hover', () => {
    vi.useFakeTimers();
    const onMarkSeen = vi.fn();
    const container = mount(<RadarSurface {...surfaceProps({ onMarkSeen })} />);
    const row = container.querySelector<HTMLElement>('[data-radar-row="one"]');

    expect(row?.getAttribute('data-radar-unseen')).toBe('true');
    expect(row?.textContent).toContain('Unseen activity');
    act(() => {
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(179);
    });
    expect(onMarkSeen).not.toHaveBeenCalled();

    act(() => {
      row?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      vi.advanceTimersByTime(1_000);
    });
    expect(onMarkSeen).not.toHaveBeenCalled();

    act(() => {
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(180);
    });
    expect(onMarkSeen).toHaveBeenCalledOnce();
    expect(onMarkSeen).toHaveBeenCalledWith(['one']);
  });

  it('marks Feed activity immediately from direct or focus intent but not dismissal', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    const onMarkSeen = vi.fn();
    const container = mount(<RadarSurface {...surfaceProps({ onMarkSeen })} />);
    const firstRow = container.querySelector<HTMLElement>('[data-radar-row="one"]');
    const dismiss = firstRow?.querySelector<HTMLButtonElement>('[data-radar-dismiss]');

    act(() => {
      firstRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(180);
      dismiss?.click();
    });
    expect(onMarkSeen).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Quick actions for owner/one"]')?.click();
      await Promise.resolve();
    });
    expect(onMarkSeen).toHaveBeenLastCalledWith(['one']);

    const secondActor = container.querySelector<HTMLAnchorElement>(
      '[data-radar-row="two"] a[href="https://github.com/actor-two"]',
    );
    act(() => {
      secondActor?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(onMarkSeen).toHaveBeenLastCalledWith(['two']);
    expect(onMarkSeen).toHaveBeenCalledTimes(2);
  });

  it('marks every unseen following activity in one Project intent', () => {
    const onMarkSeen = vi.fn();
    const container = mount(<RadarSurface {...surfaceProps({
      result: result([
        activity('newest', 'owner/shared', '2026-08-10T11:00:00.000Z'),
        activity('seen', 'owner/shared', '2026-08-10T10:00:00.000Z', {
          seen: true,
          seenAt: '2026-08-11T10:00:00.000Z',
        }),
        activity('oldest', 'owner/shared', '2026-08-10T09:00:00.000Z'),
      ]),
      view: 'projects',
      onMarkSeen,
    })} />);
    const row = container.querySelector<HTMLElement>('[data-radar-project-row]');
    const dismiss = row?.querySelector<HTMLButtonElement>('[data-radar-dismiss]');

    expect(row?.getAttribute('data-radar-unseen')).toBe('true');
    act(() => dismiss?.click());
    expect(onMarkSeen).not.toHaveBeenCalled();

    act(() => row?.querySelector<HTMLButtonElement>('[data-radar-project-trigger]')?.click());
    expect(onMarkSeen).toHaveBeenCalledOnce();
    expect(onMarkSeen).toHaveBeenCalledWith(['newest', 'oldest']);
  });

  it('routes Feed and Projects dismissal through the same flat mutation boundary', async () => {
    let visible = [
      activity('one', 'owner/repo', '2026-08-10T11:00:00.000Z'),
      activity('two', 'owner/repo', '2026-08-10T10:00:00.000Z'),
      activity('three', 'other/repo', '2026-08-10T09:00:00.000Z'),
    ];
    const onDismiss = vi.fn(async (_repositoryKey: string, ids: readonly string[]) => {
      visible = visible.filter((row) => !ids.includes(row.id));
    });
    const props = surfaceProps({ onDismiss, result: result(visible) });
    const container = mount(<RadarSurface {...props} />);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label*="Dismiss activity"]')?.click();
      await Promise.resolve();
    });
    expect(onDismiss).toHaveBeenCalledWith('owner/repo', ['one']);

    await act(async () => {
      mountedRoots.at(-1)?.render(withProviders(
        <RadarSurface {...props} result={result(visible)} view="projects" />,
      ));
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss owner/repo from Following"]')?.click();
      await Promise.resolve();
    });
    expect(onDismiss).toHaveBeenLastCalledWith('owner/repo', ['two']);
  });

  it('renders cooldown and partial empty states instead of claiming a successful clear', () => {
    const cooldownState = {
      ...status().state!,
      lastSuccessfulAt: null,
      nextAllowedAt: '2099-01-01T00:00:00.000Z',
      errorCode: 'rate_limited' as const,
      partialReasons: [],
    };
    const cooldown = mount(
      <RadarSurface {...surfaceProps({
        result: result([], { snapshotStatus: 'cooldown', errorCode: 'rate_limited', state: cooldownState }),
      })} />,
    );
    expect(cooldown.textContent).toContain('GitHub rate limit reached');
    expect(cooldown.textContent).not.toContain('No recent stars');

    const partialState = { ...status().state!, partialReasons: ['private_activity_omitted' as const] };
    const partial = mount(
      <RadarSurface {...surfaceProps({
        result: result([], { snapshotStatus: 'partial', state: partialState }),
      })} />,
    );
    expect(partial.textContent).toContain('Partial snapshot');
  });

  it('omits the standalone stale label while keeping stale recovery visible', () => {
    const onRefresh = vi.fn();
    const stale = mount(
      <RadarSurface {...surfaceProps({
        result: result([], { snapshotStatus: 'stale' }),
        onRefresh,
      })} />,
    );

    expect(stale.textContent).not.toContain('Stale');
    expect(stale.textContent).toContain(
      'Showing the last successful snapshot because the latest scan failed or is stale.',
    );
    expect(stale.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.disabled).toBe(false);

    const retry = [...stale.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry');
    expect(retry).toBeDefined();
    act(() => retry?.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps old rows visible while the global ribbon and list boundary report saved activity', () => {
    const props = surfaceProps({ error: 'refresh' });
    const container = mount(<RadarSurface {...props} />);
    const ribbon = mount(
      <RadarStatusRibbon
        result={props.result}
        loading={false}
        refreshing={false}
        error="refresh"
        onOpenOptions={props.onOpenOptions}
      />,
    );

    expect(container.querySelector('[data-radar-row]')).not.toBeNull();
    expect(container.querySelector('[data-surface-list-end]')?.textContent)
      .toContain('End of saved activity · 2 items');
    expect(ribbon.textContent).toContain('Couldn’t scan · showing saved activity');
  });
});

describe('Radar status and actions', () => {
  it('disables refresh during initial load and cooldown, while exposing permission recovery', () => {
    const onOpenOptions = vi.fn();
    const onSourceEnabledChange = vi.fn();
    const cooldown = mount(
      <TooltipProvider>
        <RadarSurfaceActions
          result={result([], { snapshotStatus: 'cooldown', errorCode: 'rate_limited' })}
          loading={false}
          refreshing={false}
          sources={{ following: true, self: false }}
          view="feed"
          onViewChange={vi.fn()}
          onSourceEnabledChange={onSourceEnabledChange}
          onRefresh={vi.fn()}
        />
        <RadarStatusRibbon
          result={result([], { snapshotStatus: 'error', errorCode: 'permission_denied' })}
          loading={false}
          refreshing={false}
          error={null}
          onOpenOptions={onOpenOptions}
        />
      </TooltipProvider>,
    );
    expect(cooldown.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.disabled).toBe(true);
    const selfSource = cooldown.querySelector<HTMLButtonElement>('button[aria-label="Your own stars"]');
    act(() => {
      selfSource?.click();
    });
    expect(onSourceEnabledChange).toHaveBeenCalledWith('self', true);
    [...cooldown.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Open options')
      ?.click();
    expect(onOpenOptions).toHaveBeenCalledTimes(1);
    expect(cooldown.textContent).toContain('Following needs access to your following graph');
  });
});
