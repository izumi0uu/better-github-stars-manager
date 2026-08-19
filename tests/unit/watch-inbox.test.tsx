/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const virtualScrollToIndex = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number;
    getItemKey: (index: number) => string | number;
  }) => ({
    getTotalSize: () => count * 37,
    getVirtualItems: () => Array.from(
      { length: Math.min(count, 12) },
      (_, index) => ({ index, start: index * 37, size: 37, key: getItemKey(index) }),
    ),
    measureElement: vi.fn(),
    scrollToIndex: virtualScrollToIndex,
  }),
}));
import { WatchInbox } from '@/ui/components/WatchInbox';
import { WatchStatusRibbon } from '@/ui/components/WatchStatusRibbon';
import { ExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import type { GitHubNotificationThread, WatchSubjectDetail } from '@/watch/watch-model';
import type { WatchInboxQueryResponse } from '@/watch/watch-contract';
import type { Locale } from '@/types';
import { watchGroupContentSignature } from '@/ui/watch-inbox-presentation';
import { getMessages } from '@/i18n';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  setInputValue,
  type MountedRoot,
} from './test-utils';

function thread(
  index: number,
  overrides: Partial<GitHubNotificationThread> = {},
): GitHubNotificationThread {
  const repositoryFullName = `owner/repo-${index}`;
  return {
    id: String(index),
    repositoryFullName,
    repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
    reason: index === 0 ? 'future_reason' : 'subscribed',
    subjectType: 'Issue',
    subjectTitle: `Thread ${index}`,
    subjectApiUrl: `https://api.github.com/repos/${repositoryFullName}/issues/1`,
    subjectHtmlUrl: `https://github.com/${repositoryFullName}/issues/1`,
    unread: true,
    updatedAt: '2026-08-05T00:00:00Z',
    lastReadAt: null,
    fetchedAt: '2026-08-05T00:00:00Z',
    ...overrides,
  };
}

function result(overrides: Partial<WatchInboxQueryResponse> = {}): WatchInboxQueryResponse {
  const threads = overrides.threads ?? [thread(0)];
  return {
    threads,
    groups: overrides.groups ?? threads.map((item) => ({
      repositoryFullName: item.repositoryFullName,
      repositoryHtmlUrl: item.repositoryHtmlUrl,
      repositoryOwnerLogin: item.repositoryOwnerLogin ?? null,
      repositoryOwnerAvatarUrl: item.repositoryOwnerAvatarUrl ?? null,
      latestUpdatedAt: item.updatedAt,
      threads: [item],
    })),
    unreadCount: overrides.unreadCount ?? threads.length,
    totalCount: overrides.totalCount ?? threads.length,
    status: overrides.status ?? {
      accountLogin: 'octocat',
      hasMainToken: true,
      hasNotificationsToken: true,
      refreshing: false,
      refreshPhase: null,
      scopeStatus: 'fresh',
      inboxStatus: 'fresh',
      state: {
        id: 'singleton',
        accountLogin: 'octocat',
        scope: {
          lastAttemptAt: '2026-08-05T00:00:00Z',
          lastSuccessfulAt: '2026-08-05T00:00:00Z',
          errorCode: null,
          repositoryCount: threads.length,
        },
        inbox: {
          lastAttemptAt: '2026-08-05T00:00:00Z',
          lastSuccessfulAt: '2026-08-05T00:00:00Z',
          errorCode: null,
          lastModified: null,
          nextAllowedAt: null,
          candidateCount: threads.length,
          matchedCount: threads.length,
          truncated: false,
          newerThan: null,
          historyBefore: '2026-08-05T00:00:00Z',
          historyNextPage: null,
          historyExhausted: true,
          historyErrorCode: null,
          scanId: null,
          scanStatus: 'complete',
          scanStartedAt: null,
          scanPageCount: 1,
          lastConvergedAt: '2026-08-05T00:00:00Z',
        },
      },
    },
  };
}

const mountedRoots: MountedRoot[] = [];
const runtime = new ExtensionManagerRuntime();

function subjectDetail(): WatchSubjectDetail {
  return {
    kind: 'issue' as const,
    repositoryFullName: 'owner/repo-0',
    number: 1,
    title: 'Thread 0',
    state: 'open' as const,
    stateReason: null,
    htmlUrl: 'https://github.com/owner/repo-0/issues/1',
    author: {
      login: 'octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      htmlUrl: 'https://github.com/octocat',
    },
    createdAt: '2026-08-04T00:00:00Z',
    updatedAt: '2026-08-05T00:00:00Z',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [{
      login: 'hubot',
      avatarUrl: 'https://avatars.githubusercontent.com/u/2',
      htmlUrl: 'https://github.com/hubot',
    }],
    milestoneTitle: 'Inbox',
    commentCount: 2,
    bodyMarkdown: [
      '# Summary',
      '',
      'Use **safe Markdown** and [the docs](https://example.com/docs).',
      '',
      '![blocked image](https://attacker.example/pixel.png)',
      '',
      '<script>window.__markdown_injected__ = true</script>',
      '',
      '[blocked link](javascript:alert(1))',
      '',
      '- first item',
      '- second item',
    ].join('\n'),
  };
}

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.unstubAllGlobals();
  virtualScrollToIndex.mockClear();
});

function renderInbox(props: Partial<React.ComponentProps<typeof WatchInbox>> = {}) {
  return mountReact(
    <ManagerRuntimeProvider runtime={runtime}>
      <WatchInbox
        result={result()}
        newerThan={null}
        loading={false}
        refreshing={false}
        loadingOlder={false}
        loadOlderError={false}
        error={null}
        unreadOnly
        onUnreadOnlyChange={vi.fn()}
        onRefresh={vi.fn()}
        onRetryQuery={vi.fn()}
        onLoadOlder={vi.fn()}
        onOpenOptions={vi.fn()}
        onOpenMainTokenOptions={vi.fn()}
        actionPending={null}
        actionError={null}
        onMarkThreadsRead={vi.fn()}
        onMarkThreadsDone={vi.fn()}
        {...props}
      />
    </ManagerRuntimeProvider>,
    mountedRoots,
  );
}

function findButtonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Expected button labelled "${text}"`);
  return button;
}

function findReasonControl(
  popover: HTMLElement,
  reason: string,
): { control: HTMLButtonElement; row: HTMLElement } {
  const label = Array.from(popover.querySelectorAll<HTMLElement>('*'))
    .find((candidate) => (
      candidate.children.length === 0 && candidate.textContent?.trim() === reason
    ));
  if (!label) throw new Error(`Expected raw reason "${reason}"`);

  let row: HTMLElement | null = label;
  while (row && row !== popover) {
    const control = row.querySelector<HTMLButtonElement>('[role="checkbox"]');
    if (control) return { control, row };
    row = row.parentElement;
  }
  throw new Error(`Expected checkbox for reason "${reason}"`);
}

function keydown(target: HTMLElement, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  }));
}

describe('WatchInbox', () => {
  it('owns search and inbox actions inside the aligned Watch command bar', async () => {
    const onUnreadOnlyChange = vi.fn();
    const onRefresh = vi.fn();
    const container = renderInbox({ onUnreadOnlyChange, onRefresh });
    const commandBar = container.querySelector<HTMLElement>('[data-surface-command-bar="watch"]');

    expect(commandBar?.querySelector('input[name="watch-search"]')).not.toBeNull();
    expect(commandBar?.querySelector('[data-surface-work-canvas="watch"]')).not.toBeNull();
    expect(container.querySelector('[data-watch-thread-list]')
      ?.closest('[data-surface-work-canvas="watch"]')).not.toBeNull();
    expect(container.querySelector('[data-surface-list-end="timeline"]')?.textContent)
      .toContain('All caught up · 1 thread');

    await click(findButtonByText(commandBar!, 'All'));
    const refresh = Array.from(commandBar?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.getAttribute('aria-label')?.includes('Refresh'));
    if (!refresh) throw new Error('Expected Watch refresh control');
    await click(refresh);

    expect(onUnreadOnlyChange).toHaveBeenCalledWith(false);
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it('switches between timeline and repository views without losing thread rows', async () => {
    const first = thread(1, {
      repositoryFullName: 'owner/shared-repository',
      updatedAt: '2026-08-05T12:00:00Z',
    });
    const second = thread(2, {
      repositoryFullName: 'owner/shared-repository',
      updatedAt: '2026-08-04T12:00:00Z',
    });
    const container = renderInbox({ result: result({ threads: [first, second] }) });
    const viewGroup = container.querySelector<HTMLElement>('[role="group"][aria-label="View"]');
    if (!viewGroup) throw new Error('Expected Watch view selector');

    expect(container.querySelector('[data-watch-thread-list]')?.getAttribute('data-watch-view'))
      .toBe('timeline');
    expect(container.querySelectorAll('[data-watch-day]')).toHaveLength(2);

    await click(findButtonByText(viewGroup, 'Repository'));

    expect(container.querySelector('[data-watch-thread-list]')?.getAttribute('data-watch-view'))
      .toBe('repository');
    expect(viewGroup.querySelector<HTMLButtonElement>('button:nth-of-type(2)')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(container.querySelectorAll('[data-watch-day]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-watch-repository="owner/shared-repository"]'))
      .toHaveLength(1);
    expect(container.querySelectorAll('[data-watch-thread-row]')).toHaveLength(2);

    await click(findButtonByText(viewGroup, 'Timeline'));
    expect(container.querySelector('[data-watch-thread-list]')?.getAttribute('data-watch-view'))
      .toBe('timeline');
  });

  it('keeps manual refresh available during a converged polling cooldown', async () => {
    const cooldown = result();
    cooldown.status.inboxStatus = 'cooldown';
    cooldown.status.state!.inbox.nextAllowedAt = '2026-08-05T00:01:00Z';
    const onRefresh = vi.fn();
    const container = renderInbox({ result: cooldown, onRefresh });
    const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.getAttribute('aria-label') === 'Refresh Watch inbox');

    expect(refresh?.disabled).toBe(false);
    await click(refresh!);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('uses an info tone while the full Inbox scan has more pages', () => {
    const scanning = result();
    scanning.status.state!.inbox.truncated = true;
    scanning.status.state!.inbox.historyNextPage = 11;
    scanning.status.state!.inbox.historyExhausted = false;
    scanning.status.state!.inbox.scanId = 'scan-1';
    scanning.status.state!.inbox.scanStatus = 'scanning';
    scanning.status.state!.inbox.scanStartedAt = '2026-08-05T00:00:00Z';
    scanning.status.state!.inbox.scanPageCount = 10;
    const container = renderInbox({ result: scanning });
    const marker = container.querySelector<HTMLElement>('[data-surface-list-end="timeline"]');

    expect(marker?.textContent).toContain('Current scan boundary · earlier Inbox threads remain');
    expect(marker?.getAttribute('data-surface-list-end-tone')).toBe('info');
  });

  it('groups threads by day and marks only updates after the prior visible load', () => {
    const timelineResult = result({
      threads: [
        thread(1, { updatedAt: '2026-08-05T12:00:00Z' }),
        thread(2, { updatedAt: '2026-08-04T12:00:00Z' }),
      ],
    });
    const container = renderInbox({
      result: timelineResult,
      newerThan: '2026-08-05T11:30:00Z',
    });

    expect(Array.from(container.querySelectorAll('[data-watch-day]'), (node) => (
      node.getAttribute('data-watch-day')
    ))).toEqual(['2026-08-05', '2026-08-04']);
    expect(container.querySelector('[data-watch-thread-row="1"]')?.getAttribute('data-watch-new'))
      .toBe('true');
    expect(container.querySelector('[data-watch-thread-row="2"]')?.hasAttribute('data-watch-new'))
      .toBe(false);
    expect(container.textContent).toContain('New');
  });

  it('loads history when intersection arrives after the scroll that revealed the sentinel', async () => {
    let revealSentinel = () => {};
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        revealSentinel = () => callback([{ isIntersecting: true }]);
      }
      observe() {}
      disconnect() {}
    });
    const paged = result();
    paged.status.state!.inbox.truncated = true;
    paged.status.state!.inbox.historyNextPage = 11;
    paged.status.state!.inbox.historyExhausted = false;
    paged.status.state!.inbox.scanId = 'scan-1';
    paged.status.state!.inbox.scanStatus = 'scanning';
    paged.status.state!.inbox.scanStartedAt = '2026-08-05T00:00:00Z';
    paged.status.state!.inbox.scanPageCount = 10;
    const onLoadOlder = vi.fn();

    const container = renderInbox({ result: paged, onLoadOlder });
    await act(async () => { await Promise.resolve(); });
    expect(onLoadOlder).not.toHaveBeenCalled();

    await act(async () => { window.dispatchEvent(new Event('scroll')); });
    expect(onLoadOlder).not.toHaveBeenCalled();
    await act(async () => { revealSentinel(); });

    expect(container.querySelector('[data-watch-history-sentinel="more"]')).not.toBeNull();
    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it('keeps failed historical loads retryable without hiding saved rows', async () => {
    const paged = result();
    paged.status.state!.inbox.truncated = true;
    paged.status.state!.inbox.historyNextPage = 11;
    paged.status.state!.inbox.historyExhausted = false;
    paged.status.state!.inbox.scanId = 'scan-1';
    paged.status.state!.inbox.scanStatus = 'partial';
    paged.status.state!.inbox.scanStartedAt = '2026-08-05T00:00:00Z';
    paged.status.state!.inbox.scanPageCount = 10;
    const onLoadOlder = vi.fn();
    const container = renderInbox({ result: paged, loadOlderError: true, onLoadOlder });

    expect(container.textContent).toContain('Your saved timeline is unchanged.');
    expect(container.textContent).toContain('Thread 0');
    await click(findButtonByText(container, 'Retry'));
    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it('distinguishes a query failure from missing main-token setup', () => {
    const retry = vi.fn();
    const container = renderInbox({ result: null, error: 'query', onRetryQuery: retry });

    expect(container.textContent).toContain('The Watch snapshot could not be loaded.');
    expect(container.textContent).not.toContain('Add Watching: read');
  });

  it('routes missing main-credential setup to the supplied recovery callback', async () => {
    const onOpenOptions = vi.fn();
    const setupResult = result();
    setupResult.status.hasMainToken = false;
    setupResult.status.hasNotificationsToken = false;

    const container = renderInbox({ result: setupResult, onOpenOptions });
    const settings = findButtonByText(container, 'Open options');
    expect(settings).not.toBeNull();

    await click(settings!);
    expect(onOpenOptions).toHaveBeenCalledOnce();
  });

  it('keeps Inbox setup available when watched-membership enumeration fails', async () => {
    const onRefresh = vi.fn();
    const permissionResult = result();
    permissionResult.groups = [];
    permissionResult.threads = [];
    permissionResult.status.scopeStatus = 'error';
    permissionResult.status.inboxStatus = 'never_loaded';
    permissionResult.status.state!.scope.lastSuccessfulAt = null;
    permissionResult.status.state!.scope.errorCode = 'permission_denied';
    permissionResult.status.state!.inbox.lastSuccessfulAt = null;

    const container = renderInbox({ result: permissionResult, onRefresh });
    const refresh = findButtonByText(container, 'Refresh Watch inbox');

    await click(refresh);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Refresh to scan your complete GitHub Notifications inbox');
  });

  it('keeps stale rows visible and exposes credential recovery in the status ribbon', async () => {
    const onOpenOptions = vi.fn();
    const permissionResult = result();
    permissionResult.status.inboxStatus = 'error';
    permissionResult.status.state!.inbox.errorCode = 'permission_denied';

    const inbox = renderInbox({ result: permissionResult });
    const ribbon = mountReact(
      <WatchStatusRibbon
        result={permissionResult}
        loading={false}
        refreshing={false}
        error={null}
        onOpenOptions={onOpenOptions}
      />,
      mountedRoots,
    );
    expect(inbox.textContent).toContain('Thread 0');
    expect(ribbon.textContent).toContain('Classic PAT authorization required');
    expect(ribbon.textContent).not.toContain('permission_denied');

    await click(findButtonByText(ribbon, 'Open options'));
    expect(onOpenOptions).toHaveBeenCalledOnce();
  });

  it('keeps the last successful rows visible while the status ribbon reports staleness', () => {
    const staleResult = result();
    staleResult.status.inboxStatus = 'stale';
    staleResult.status.state!.inbox.errorCode = 'network';

    const inbox = renderInbox({ result: staleResult });
    const ribbon = mountReact(
      <WatchStatusRibbon
        result={staleResult}
        loading={false}
        refreshing={false}
        error={null}
      />,
      mountedRoots,
    );

    expect(inbox.textContent).toContain('Thread 0');
    expect(ribbon.querySelector('[role="status"]')).not.toBeNull();
    expect(ribbon.textContent).toContain('Couldn’t refresh · showing saved rows');
    const boundary = inbox.querySelector('[data-surface-list-end="timeline"]');
    expect(boundary?.textContent).toContain('End of saved snapshot · 1 thread');
    expect(boundary?.textContent).not.toContain('full Inbox scan incomplete');
  });

  it('renders durable full-scan progress in the status ribbon', () => {
    const scanning = result();
    scanning.status.state!.inbox.scanId = 'scan-1';
    scanning.status.state!.inbox.scanStatus = 'scanning';
    scanning.status.state!.inbox.scanStartedAt = '2026-08-05T00:00:00Z';
    scanning.status.state!.inbox.scanPageCount = 10;
    scanning.status.state!.inbox.candidateCount = 500;

    const ribbon = mountReact(
      <WatchStatusRibbon
        result={scanning}
        loading={false}
        refreshing={true}
        error={null}
      />,
      mountedRoots,
    );

    expect(ribbon.querySelector('[data-watch-status="scanning"]')).not.toBeNull();
    expect(ribbon.textContent).toContain('Scanning full Inbox · 500 threads found across 10 pages');
  });

  it('keeps the ribbon mounted while refresh phases and scan counters advance', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const render = (next: WatchInboxQueryResponse, refreshing: boolean) => act(() => root.render(
      <WatchStatusRibbon
        result={next}
        loading={false}
        refreshing={refreshing}
        error={null}
      />,
    ));

    const scanningResult = (count: number, pages: number) => {
      const next = result();
      next.status.refreshing = true;
      next.status.refreshPhase = 'inbox';
      next.status.state!.inbox.scanId = 'scan-1';
      next.status.state!.inbox.scanStatus = 'scanning';
      next.status.state!.inbox.scanStartedAt = '2026-08-05T00:00:00Z';
      next.status.state!.inbox.scanPageCount = pages;
      next.status.state!.inbox.candidateCount = count;
      return next;
    };

    const scope = result();
    scope.status.refreshing = true;
    scope.status.refreshPhase = 'scope';
    render(scope, true);
    const ribbon = container.querySelector<HTMLElement>('[role="status"]');
    expect(ribbon?.dataset.watchRefreshPhase).toBe('scope');
    expect(container.textContent).toContain('Syncing watched repositories · showing saved Inbox');
    expect(container.querySelector('[data-watch-status-text]')?.classList
      .contains('gsm-watch-status-text-phase')).toBe(true);

    const scanning = scanningResult(10, 1);
    render(scanning, true);
    expect(container.querySelector('[role="status"]')).toBe(ribbon);
    expect(ribbon?.dataset.watchRefreshPhase).toBe('inbox');
    expect(container.textContent).toContain('Scanning full Inbox · 10 threads found across 1 page');

    const progressed = scanningResult(20, 2);
    render(progressed, true);
    expect(container.querySelector('[role="status"]')).toBe(ribbon);
    expect(Array.from(container.querySelectorAll('[data-watch-progress-number]'))
      .map((node) => [node.getAttribute('data-watch-progress-field'), node.textContent]))
      .toEqual([['count', '20'], ['pages', '2']]);
    expect(container.querySelectorAll('.gsm-watch-status-number-update')).toHaveLength(2);

    render(scanningResult(20, 3), true);
    expect(Array.from(container.querySelectorAll('[data-watch-progress-number]'))
      .map((node) => [
        node.getAttribute('data-watch-progress-field'),
        node.classList.contains('gsm-watch-status-number-update'),
      ])).toEqual([['count', false], ['pages', true]]);

    render(scanningResult(30, 3), true);
    expect(Array.from(container.querySelectorAll('[data-watch-progress-number]'))
      .map((node) => [
        node.getAttribute('data-watch-progress-field'),
        node.classList.contains('gsm-watch-status-number-update'),
      ])).toEqual([['count', true], ['pages', false]]);

    render(result(), false);
    expect(container.querySelector('[role="status"]')).toBe(ribbon);
    expect(ribbon?.dataset.watchRefreshPhase).toBeUndefined();
  });

  it('preserves locale-specific Watch scan counter order', () => {
    const renderMessage = (locale: Locale) => {
      const parts = getMessages(locale).watch.statusScanning(20, 3);
      return {
        fields: parts.flatMap((part) => typeof part === 'string' ? [] : [part.field]),
        text: parts.map((part) => typeof part === 'string' ? part : String(part.value)).join(''),
      };
    };

    expect(renderMessage('en')).toEqual({
      fields: ['count', 'pages'],
      text: 'Scanning full Inbox · 20 threads found across 3 pages',
    });
    expect(renderMessage('zh-CN')).toEqual({
      fields: ['pages', 'count'],
      text: '正在完整扫描收件箱 · 已扫描 3 页，找到 20 个 thread',
    });
  });

  it('does not label a converged head refresh as another full scan', () => {
    const ribbon = mountReact(
      <WatchStatusRibbon
        result={result()}
        loading={false}
        refreshing
        error={null}
      />,
      mountedRoots,
    );

    expect(ribbon.textContent).toContain('Refreshing Inbox · showing saved rows');
    expect(ribbon.textContent).not.toContain('Scanning full Inbox');
  });

  it('dismisses a warning status ribbon with the close control', async () => {
    const staleResult = result();
    staleResult.status.inboxStatus = 'stale';

    const ribbon = mountReact(
      <WatchStatusRibbon
        result={staleResult}
        loading={false}
        refreshing={false}
        error={null}
      />,
      mountedRoots,
    );
    expect(ribbon.textContent).toContain('Couldn’t refresh · showing saved rows');
    const dismiss = ribbon.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(dismiss).not.toBeNull();

    await act(async () => { dismiss?.click(); });
    expect(ribbon.querySelector('[data-watch-status]')).toBeNull();
  });

  it('shows a new warning after a previously dismissed warning changes identity', async () => {
    const staleResult = result();
    staleResult.status.scopeStatus = 'stale';
    staleResult.status.inboxStatus = 'stale';
    const onOpenOptions = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const render = (next: WatchInboxQueryResponse) => act(() => root.render(
      <WatchStatusRibbon
        result={next}
        loading={false}
        refreshing={false}
        error={null}
        onOpenOptions={onOpenOptions}
      />,
    ));

    render(staleResult);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);
    expect(container.querySelector('[data-watch-status]')).toBeNull();

    const credentialResult = result();
    credentialResult.status.inboxStatus = 'error';
    credentialResult.status.state!.inbox.errorCode = 'permission_denied';
    render(credentialResult);

    expect(container.textContent).toContain('Classic PAT authorization required');
    await click(findButtonByText(container, 'Open options'));
    expect(onOpenOptions).toHaveBeenCalledOnce();
  });

  it('renders the repository owner avatar in group headers', () => {
    const withAvatar = thread(0, {
      repositoryOwnerAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    });
    const container = renderInbox({ result: result({ threads: [withAvatar] }) });
    const avatar = container.querySelector('img[data-repository-avatar]');
    expect(avatar?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/1?v=4');
  });

  it('renders raw reason metadata, the repository unread count, and a safe GitHub link', () => {
    const unreadThread = thread(0);
    const readThread = thread(0, {
      id: 'read-thread',
      subjectTitle: 'Read thread',
      subjectApiUrl: 'https://api.github.com/repos/owner/repo-0/issues/2',
      subjectHtmlUrl: 'https://github.com/owner/repo-0/issues/2',
      unread: false,
    });
    const container = renderInbox({
      result: result({
        threads: [unreadThread, readThread],
        groups: [{
          repositoryFullName: unreadThread.repositoryFullName,
          repositoryHtmlUrl: unreadThread.repositoryHtmlUrl,
          repositoryOwnerLogin: unreadThread.repositoryOwnerLogin ?? null,
          repositoryOwnerAvatarUrl: unreadThread.repositoryOwnerAvatarUrl ?? null,
          latestUpdatedAt: unreadThread.updatedAt,
          threads: [unreadThread, readThread],
        }],
        unreadCount: 1,
        totalCount: 2,
      }),
    });
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: Thread 0"]',
    );
    const reason = disclosure?.querySelector('code');
    const updated = disclosure?.querySelector('time');
    const repository = container
      .querySelector('[aria-label="Collapse owner/repo-0"]')
      ?.closest('section');
    const unreadPill = Array.from(repository?.querySelectorAll('span') ?? [])
      .find((element) => element.textContent === '1 unread');

    expect(reason?.textContent).toBe('future_reason');
    expect(reason?.getAttribute('title')).toBe('future_reason');
    expect(unreadPill).toBeDefined();
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure?.getAttribute('aria-controls')).toBeTruthy();
    expect(updated?.dateTime).toBe('2026-08-05T00:00:00Z');
    expect(updated?.title).toBe(new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date('2026-08-05T00:00:00Z')));
    expect(updated?.textContent).toMatch(/^(?:<1m|\d+(?:mo|[mhdy]))$/);
  });

  it('falls back to the repository page and exposes unknown metadata as its description', () => {
    const unknownThread = thread(0, {
      subjectType: 'FutureType',
      subjectApiUrl: 'https://api.github.com/repos/owner/repo-0/releases/1',
      subjectHtmlUrl: null,
    });
    const container = renderInbox({ result: result({ threads: [unknownThread] }) });
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: Thread 0"]',
    );
    const descriptionId = disclosure?.getAttribute('aria-describedby');
    const description = descriptionId
      ? container.ownerDocument.getElementById(descriptionId)
      : null;

    expect(description).not.toBeNull();
    expect(description?.textContent).toContain('FutureType. future_reason.');
  });

  it('expands notification details and routes row actions without opening GitHub', async () => {
    const onMarkThreadsRead = vi.fn();
    const onMarkThreadsDone = vi.fn();
    const container = renderInbox({ onMarkThreadsRead, onMarkThreadsDone });
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: Thread 0"]',
    );
    if (!disclosure) throw new Error('Expected Watch thread disclosure');

    await click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    const detailsId = disclosure.getAttribute('aria-controls');
    const details = detailsId ? document.getElementById(detailsId) : null;
    expect(details?.getAttribute('role')).toBe('region');
    expect(details?.textContent).toContain('future_reason');
    expect(details?.textContent).toContain('Unread');

    await click(findButtonByText(details!, 'Mark as read'));
    await click(findButtonByText(details!, 'Mark as done'));
    expect(onMarkThreadsRead).toHaveBeenCalledWith(['0']);
    expect(onMarkThreadsDone).toHaveBeenCalledWith(['0']);

    const open = details?.querySelector<HTMLAnchorElement>('a[href="https://github.com/owner/repo-0/issues/1"]');
    expect(open?.textContent).toContain('Open Issue in GitHub');
    expect(open?.target).toBe('_blank');
    expect(open?.relList.contains('noreferrer')).toBe(true);
  });

  it('loads supported Issue details on expansion without blocking notification actions', async () => {
    const detail = subjectDetail();
    const { promise: request, resolve: resolveRequest } = Promise.withResolvers<WatchSubjectDetail>();
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, data: await request })) },
      storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    const onMarkThreadsRead = vi.fn();
    const container = renderInbox({ onMarkThreadsRead });
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: Thread 0"]',
    );
    if (!disclosure) throw new Error('Expected Watch thread disclosure');

    await click(disclosure);
    expect(container.querySelector('[data-watch-subject-detail="loading"]')).not.toBeNull();
    expect(findButtonByText(container, 'Mark as read').disabled).toBe(false);
    await act(async () => {
      resolveRequest(detail);
      await request;
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    });

    const loaded = container.querySelector('[data-watch-subject-detail="success"]');
    expect(loaded?.textContent).toContain('Open');
    expect(loaded?.textContent).toContain('#1');
    expect(loaded?.textContent).toContain('by @octocat');
    expect(loaded?.textContent).toContain('2 comments');
    expect(loaded?.textContent).toContain('Milestone: Inbox');
    expect(loaded?.textContent).toContain('Assigned to @hubot');
    expect(loaded?.textContent).toContain('bug');
    expect(loaded?.querySelector('h1')?.textContent).toBe('Summary');
    expect(loaded?.querySelector('[data-streamdown="strong"]')?.textContent).toBe('safe Markdown');
    const external = loaded?.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]');
    expect(external?.target).toBe('_blank');
    expect(external?.relList.contains('noreferrer')).toBe(true);
    expect(loaded?.querySelector('img')).toBeNull();
    expect(loaded?.querySelector('script')).toBeNull();
    expect(loaded?.querySelector('a[href^="javascript:"]')).toBeNull();
    const markdown = loaded?.querySelector<HTMLElement>('[data-watch-subject-body="preview"]');
    expect(markdown?.classList.contains('gsm-watch-subject-markdown-preview')).toBe(true);
    await click(findButtonByText(container, 'Mark as read'));
    expect(onMarkThreadsRead).toHaveBeenCalledWith(['0']);
  });

  it('expands overflowing Markdown inside a bounded body region and collapses it again', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(108);
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, data: subjectDetail() })) },
      storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    const container = renderInbox();
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: Thread 0"]',
    );
    if (!disclosure) throw new Error('Expected Watch thread disclosure');

    await click(disclosure);
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    });

    const show = findButtonByText(container, 'Show full description');
    const bodyId = show.getAttribute('aria-controls');
    const body = bodyId ? document.getElementById(bodyId) : null;
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(body?.getAttribute('data-watch-subject-body')).toBe('preview');
    expect(body?.classList.contains('gsm-watch-subject-markdown-faded')).toBe(true);

    await click(show);
    const collapse = findButtonByText(container, 'Collapse description');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(body?.getAttribute('data-watch-subject-body')).toBe('expanded');
    expect(body?.classList.contains('gsm-watch-subject-markdown-expanded')).toBe(true);

    await click(collapse);
    expect(findButtonByText(container, 'Show full description').getAttribute('aria-expanded')).toBe('false');
    expect(body?.getAttribute('data-watch-subject-body')).toBe('preview');
  });

  it.each([
    {
      code: 'authentication_required',
      expected: 'saved GitHub Classic PAT was rejected',
    },
    {
      code: 'permission_denied',
      expected: 'GitHub Classic PAT needs the repo scope',
    },
  ])('offers focused Options recovery for $code detail failures', async ({ code, expected }) => {
    const { promise: request, resolve: resolveRequest } = Promise.withResolvers<void>();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => {
          await request;
          return {
            ok: false,
            error: 'generic background copy',
            code,
          };
        }),
      },
      storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    const onOpenMainTokenOptions = vi.fn();
    const container = renderInbox({ onOpenMainTokenOptions });
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: Thread 0"]',
    );
    if (!disclosure) throw new Error('Expected Watch thread disclosure');

    await click(disclosure);
    await act(async () => {
      resolveRequest();
      await request.catch(() => undefined);
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    });

    const details = container.querySelector<HTMLElement>('[data-watch-subject-detail="error"]');
    expect(details?.textContent).toContain(expected);
    expect(findButtonByText(details!, 'Open options')).not.toBeNull();
    expect(findButtonByText(details!, 'Retry')).not.toBeNull();

    await click(findButtonByText(details!, 'Open options'));
    expect(onOpenMainTokenOptions).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('future_reason');
    expect(findButtonByText(container, 'Mark as done').disabled).toBe(false);
    expect(container.querySelector('a[href="https://github.com/owner/repo-0/issues/1"]')).not.toBeNull();
  });

  it('keeps non-permission detail failures retry-only', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: false,
          error: 'GitHub rate-limited this detail request. Retry later.',
          code: 'rate_limited',
        })),
      },
      storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    const container = renderInbox();
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: Thread 0"]',
    );
    if (!disclosure) throw new Error('Expected Watch thread disclosure');

    await click(disclosure);
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    });

    const details = container.querySelector<HTMLElement>('[data-watch-subject-detail="error"]');
    expect(details?.textContent).toContain('GitHub rate-limited this detail request');
    expect(findButtonByText(details!, 'Retry')).not.toBeNull();
    expect(Array.from(details?.querySelectorAll('button') ?? [])
      .some((button) => button.textContent?.trim() === 'Open options')).toBe(false);
  });
  it('routes bulk actions to one visible repository group, never the global inbox', async () => {
    const repositoryUnread = thread(0, {
      repositoryFullName: 'owner/repository-a',
      repositoryHtmlUrl: 'https://github.com/owner/repository-a',
    });
    const repositoryRead = thread(1, {
      repositoryFullName: 'owner/repository-a',
      repositoryHtmlUrl: 'https://github.com/owner/repository-a',
      unread: false,
    });
    const otherRepository = thread(2, {
      repositoryFullName: 'owner/repository-b',
      repositoryHtmlUrl: 'https://github.com/owner/repository-b',
    });
    const onMarkThreadsRead = vi.fn();
    const onMarkThreadsDone = vi.fn();
    const container = renderInbox({
      result: result({
        threads: [repositoryUnread, repositoryRead, otherRepository],
        groups: [{
          repositoryFullName: 'owner/repository-a',
          repositoryHtmlUrl: 'https://github.com/owner/repository-a',
          repositoryOwnerLogin: 'owner',
          repositoryOwnerAvatarUrl: null,
          latestUpdatedAt: repositoryUnread.updatedAt,
          threads: [repositoryUnread, repositoryRead],
        }, {
          repositoryFullName: 'owner/repository-b',
          repositoryHtmlUrl: 'https://github.com/owner/repository-b',
          repositoryOwnerLogin: 'owner',
          repositoryOwnerAvatarUrl: null,
          latestUpdatedAt: otherRepository.updatedAt,
          threads: [otherRepository],
        }],
        unreadCount: 2,
        totalCount: 3,
      }),
      onMarkThreadsRead,
      onMarkThreadsDone,
    });
    const search = container.querySelector<HTMLInputElement>('input[name="watch-search"]');
    if (!search) throw new Error('Expected Watch search input');
    await setInputValue(search, 'Thread 0');
    const commandBar = container.querySelector<HTMLElement>('[data-surface-command-bar="watch"]');
    const repository = container.querySelector<HTMLElement>(
      '[data-watch-repository="owner/repository-a"]',
    );
    if (!repository) throw new Error('Expected repository-scoped Watch actions');

    expect(commandBar?.textContent).not.toContain('Mark all as read');
    expect(commandBar?.textContent).not.toContain('Mark all as done');
    await click(findButtonByText(repository, 'Mark all as read'));
    await click(findButtonByText(repository, 'Mark all as done'));

    expect(onMarkThreadsRead).toHaveBeenCalledWith(['0']);
    expect(onMarkThreadsDone).toHaveBeenCalledWith(['0']);
    expect(onMarkThreadsRead).not.toHaveBeenCalledWith(['2']);
    expect(onMarkThreadsDone).not.toHaveBeenCalledWith(expect.arrayContaining(['2']));
  });

  it('scopes repeated repository headers and bulk actions to each timeline day', async () => {
    const repositoryFullName = 'owner/repeated-repository';
    const newest = thread(0, {
      id: 'newest-day',
      repositoryFullName,
      repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
      updatedAt: '2026-08-05T12:00:00Z',
    });
    const older = thread(1, {
      id: 'older-day',
      repositoryFullName,
      repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
      updatedAt: '2026-08-04T12:00:00Z',
    });
    const repositoryGroup = {
      repositoryFullName,
      repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
      repositoryOwnerLogin: 'owner',
      repositoryOwnerAvatarUrl: null,
      latestUpdatedAt: newest.updatedAt,
      threads: [newest, older],
    };
    const onMarkThreadsRead = vi.fn();
    const container = renderInbox({
      result: result({
        threads: repositoryGroup.threads,
        groups: [repositoryGroup],
        unreadCount: 2,
        totalCount: 2,
      }),
      collapsedRepositories: {
        [repositoryFullName]: watchGroupContentSignature(repositoryGroup.threads),
      },
      onMarkThreadsRead,
    });
    const dailyRepositories = container.querySelectorAll<HTMLElement>(
      `[data-watch-repository="${repositoryFullName}"]`,
    );

    expect(dailyRepositories).toHaveLength(2);
    expect(container.querySelectorAll('button[data-watch-thread]')).toHaveLength(0);
    for (const dailyRepository of dailyRepositories) {
      expect(dailyRepository.textContent).toContain('1 thread');
      expect(dailyRepository.textContent).not.toContain('2 threads');
      expect(dailyRepository.textContent).toContain('1 unread');
      expect(dailyRepository.textContent).not.toContain('2 unread');
    }

    const firstDateRepository = dailyRepositories.item(0);
    if (!firstDateRepository) throw new Error('Expected the first daily repository row');
    await click(findButtonByText(firstDateRepository, 'Mark all as read'));

    expect(onMarkThreadsRead).toHaveBeenCalledOnce();
    expect(onMarkThreadsRead).toHaveBeenCalledWith(['newest-day']);
  });

  it('shows pending state only on the matching repository action and disables conflicts', () => {
    const first = thread(0, {
      repositoryFullName: 'owner/repository-a',
      repositoryHtmlUrl: 'https://github.com/owner/repository-a',
    });
    const second = thread(1, {
      repositoryFullName: 'owner/repository-b',
      repositoryHtmlUrl: 'https://github.com/owner/repository-b',
    });
    const container = renderInbox({
      result: result({ threads: [first, second] }),
      actionPending: { action: 'read', threadIds: ['0'] },
      actionError: 'done',
    });
    const firstRepository = container.querySelector<HTMLElement>(
      '[data-watch-repository="owner/repository-a"]',
    );
    const secondRepository = container.querySelector<HTMLElement>(
      '[data-watch-repository="owner/repository-b"]',
    );
    if (!firstRepository || !secondRepository) throw new Error('Expected both Watch repositories');

    expect(findButtonByText(firstRepository, 'Marking as read…').disabled).toBe(true);
    expect(findButtonByText(firstRepository, 'Mark all as done').disabled).toBe(true);
    expect(findButtonByText(secondRepository, 'Mark all as read').disabled).toBe(true);
    expect(secondRepository.textContent).not.toContain('Marking as read…');
    const error = container.querySelector('[aria-live="polite"]');
    expect(error?.textContent).toContain('Couldn’t mark the selected notifications as done.');
  });

  it('defaults repository groups open, excludes collapsed threads, and closes disclosures', async () => {
    const threads = Array.from({ length: 9 }, (_, index) => thread(index));
    const onCollapseChange = vi.fn();
    const container = renderInbox({
      result: result({ threads }),
      onRepositoryCollapseChange: onCollapseChange,
    });

    expect(container.querySelector('summary')).toBeNull();
    const disclosureSelector =
      'button[data-watch-thread][aria-label="Notification details: Thread 8"]';
    const disclosure = container.querySelector<HTMLButtonElement>(disclosureSelector);
    if (!disclosure) throw new Error('Expected Watch thread disclosure');
    await click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');

    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse owner/repo-8"]',
    );
    expect(collapse).not.toBeNull();
    expect(collapse?.getAttribute('aria-expanded')).toBe('true');
    await click(collapse!);

    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand owner/repo-8"]',
    );
    expect(expand?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector(disclosureSelector)).toBeNull();
    expect(onCollapseChange).toHaveBeenCalledWith(
      'owner/repo-8',
      watchGroupContentSignature([threads[8]]),
    );
    const collapsedRepository = container.querySelector<HTMLElement>(
      '[data-watch-repository="owner/repo-8"]',
    );
    if (!collapsedRepository) throw new Error('Expected collapsed Watch repository');
    expect(findButtonByText(collapsedRepository, 'Mark all as read').disabled).toBe(false);
    expect(findButtonByText(collapsedRepository, 'Mark all as done').disabled).toBe(false);

    await click(expand!);
    expect(container.querySelector(disclosureSelector)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('searches repository names and thread titles, then shows a filter-specific empty state', async () => {
    const release = thread(0, {
      repositoryFullName: 'acme/release-tools',
      subjectTitle: 'Prepare the changelog',
      reason: 'subscribed',
    });
    const security = thread(1, {
      repositoryFullName: 'acme/security-center',
      subjectTitle: 'Dependency alert',
      reason: 'security_alert',
    });
    const review = thread(2, {
      repositoryFullName: 'team/frontend',
      subjectTitle: 'Review requested for navigation',
      reason: 'review_requested',
    });
    const container = renderInbox({
      result: result({ threads: [release, security, review] }),
    });
    const search = container.querySelector<HTMLInputElement>('input[name="watch-search"]');
    if (!search) throw new Error('Expected Watch search input');

    await setInputValue(search, 'SECURITY-CENTER');

    expect(container.textContent).toContain('Dependency alert');
    expect(container.textContent).not.toContain('Prepare the changelog');
    expect(container.textContent).not.toContain('Review requested for navigation');

    await setInputValue(search, 'requested for NAVIGATION');

    expect(container.textContent).toContain('Review requested for navigation');
    expect(container.textContent).not.toContain('Dependency alert');

    await setInputValue(search, 'no such repository or thread');

    expect(container.textContent).toContain(
      'No threads match the current Watch search and reason filters.',
    );
    expect(container.textContent).not.toContain('No unread threads in the currently saved Inbox.');
  });

  it('temporarily reveals matching persisted groups and restores their collapsed state', async () => {
    const threads = Array.from({ length: 9 }, (_, index) => thread(index));
    const container = renderInbox({
      result: result({ threads }),
      collapsedRepositories: {
        'owner/repo-8': watchGroupContentSignature([threads[8]]),
      },
    });
    const search = container.querySelector<HTMLInputElement>('input[name="watch-search"]');
    if (!search) throw new Error('Expected Watch search input');

    expect(container.querySelector(
      'button[data-watch-thread][aria-label="Notification details: Thread 8"]',
    )).toBeNull();
    await setInputValue(search, 'Thread 8');

    expect(container.querySelector('[aria-label="Collapse owner/repo-8"]')?.hasAttribute('disabled'))
      .toBe(true);
    expect(container.querySelector(
      'button[data-watch-thread][aria-label="Notification details: Thread 8"]',
    )).not.toBeNull();

    await setInputValue(search, '');

    expect(container.querySelector('[aria-label="Expand owner/repo-8"]')?.hasAttribute('disabled'))
      .toBe(false);
    expect(container.querySelector(
      'button[data-watch-thread][aria-label="Notification details: Thread 8"]',
    )).toBeNull();
  });

  it('auto-expands updated repository content and clears the stale collapse record', () => {
    const current = thread(0, { updatedAt: '2026-08-06T00:00:00Z' });
    const previous = { ...current, updatedAt: '2026-08-05T00:00:00Z' };
    const onCollapseChange = vi.fn();
    const container = renderInbox({
      result: result({ threads: [current] }),
      collapsedRepositories: {
        'owner/repo-0': watchGroupContentSignature([previous]),
      },
      onRepositoryCollapseChange: onCollapseChange,
    });

    expect(container.querySelector('[aria-label="Collapse owner/repo-0"]')).not.toBeNull();
    expect(container.querySelector('[data-watch-repository="owner/repo-0"]')
      ?.classList.contains('gsm-watch-auto-expanded')).toBe(true);
    expect(onCollapseChange).toHaveBeenCalledWith('owner/repo-0', null);
  });

  it('shows raw reason facets with counts, supports multi-select, and applies presets', async () => {
    const mentionOne = thread(0, {
      repositoryFullName: 'acme/alpha',
      subjectTitle: 'Mention one',
      reason: 'mention',
    });
    const mentionTwo = thread(1, {
      repositoryFullName: 'acme/beta',
      subjectTitle: 'Mention two',
      reason: 'mention',
    });
    const security = thread(2, {
      repositoryFullName: 'acme/security',
      subjectTitle: 'Security alert',
      reason: 'security_alert',
    });
    const review = thread(3, {
      repositoryFullName: 'acme/review',
      subjectTitle: 'Review request',
      reason: 'review_requested',
    });
    const future = thread(4, {
      repositoryFullName: 'acme/future',
      subjectTitle: 'Future event',
      reason: 'future_reason',
    });
    const container = renderInbox({
      result: result({ threads: [mentionOne, mentionTwo, security, review, future] }),
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Notification reasons"]',
    );
    if (!trigger) throw new Error('Expected notification reason filter');
    await click(trigger);

    const contentId = trigger.getAttribute('aria-controls');
    const popover = contentId ? document.getElementById(contentId) : null;
    if (!popover) throw new Error('Expected notification reason popover');

    const mention = findReasonControl(popover, 'mention');
    const securityAlert = findReasonControl(popover, 'security_alert');
    const unknown = findReasonControl(popover, 'future_reason');
    expect(mention.row.textContent).toContain('2 threads');
    expect(securityAlert.row.textContent).toContain('1 thread');
    expect(unknown.row.textContent).toContain('1 thread');

    await click(mention.control);
    await click(securityAlert.control);

    expect(trigger.getAttribute('aria-label')).toBe('Notification reasons, 2 selected');
    expect(container.textContent).toContain('Mention one');
    expect(container.textContent).toContain('Mention two');
    expect(container.textContent).toContain('Security alert');
    expect(container.textContent).not.toContain('Review request');
    expect(container.textContent).not.toContain('Future event');
    expect(container.querySelectorAll('button[data-watch-thread]')).toHaveLength(3);

    await click(findButtonByText(popover, 'Direct'));

    expect(container.textContent).toContain('Mention one');
    expect(container.textContent).toContain('Mention two');
    expect(container.textContent).toContain('Review request');
    expect(container.textContent).not.toContain('Security alert');
    expect(container.textContent).not.toContain('Future event');
  });

  it('bounds the browser path by flat virtual rows for four skewed repositories', () => {
    const groups = Array.from({ length: 4 }, (_, repositoryIndex) => {
      const repositoryFullName = `owner/large-${repositoryIndex}`;
      const repositoryThreads = Array.from({ length: 200 }, (_, threadIndex) => thread(
        repositoryIndex * 200 + threadIndex,
        { repositoryFullName, repositoryHtmlUrl: `https://github.com/${repositoryFullName}` },
      ));
      return {
        repositoryFullName,
        repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
        repositoryOwnerLogin: 'owner',
        repositoryOwnerAvatarUrl: null,
        latestUpdatedAt: repositoryThreads[0].updatedAt,
        threads: repositoryThreads,
      };
    });
    const allThreads = groups.flatMap((group) => group.threads);
    const container = renderInbox({
      result: result({ threads: allThreads, groups }),
      scrollElement: document.createElement('div'),
    });

    expect(allThreads).toHaveLength(800);
    expect(container.querySelectorAll('button[data-watch-thread]').length).toBeLessThanOrEqual(11);
    expect(container.querySelectorAll('[data-watch-repository]').length).toBeLessThanOrEqual(1);
  });

  it('scrolls an unmounted adjacent logical thread into the virtual window', async () => {
    const repositoryFullName = 'owner/keyboard-window';
    const repositoryThreads = Array.from({ length: 30 }, (_, index) => thread(index, {
      repositoryFullName,
      repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
      updatedAt: `2026-08-05T00:00:${String(index).padStart(2, '0')}Z`,
    }));
    const container = renderInbox({
      result: result({
        threads: repositoryThreads,
        groups: [{
          repositoryFullName,
          repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
          repositoryOwnerLogin: 'owner',
          repositoryOwnerAvatarUrl: null,
          latestUpdatedAt: repositoryThreads[29].updatedAt,
          threads: repositoryThreads,
        }],
      }),
      scrollElement: document.createElement('div'),
    });
    const mountedThreads = container.querySelectorAll<HTMLButtonElement>('button[data-watch-thread]');
    const lastMounted = mountedThreads[mountedThreads.length - 1];
    if (!lastMounted) throw new Error('Expected a bounded virtual thread window');

    lastMounted.focus();
    await act(async () => keydown(lastMounted, 'ArrowDown'));

    expect(virtualScrollToIndex).toHaveBeenCalledWith(12, { align: 'auto' });
  });

  it('moves focus with Arrow Up/Down/Home/End across visible thread disclosures only', async () => {
    const first = thread(0, { subjectTitle: 'First visible thread' });
    const collapsed = thread(1, { subjectTitle: 'Collapsed thread' });
    const last = thread(2, { subjectTitle: 'Last visible thread' });
    const container = renderInbox({ result: result({ threads: [first, collapsed, last] }) });
    const collapseMiddle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse owner/repo-1"]',
    );
    if (!collapseMiddle) throw new Error('Expected middle repository collapse control');
    await click(collapseMiddle);

    const firstButton = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: First visible thread"]',
    );
    const lastButton = container.querySelector<HTMLButtonElement>(
      'button[data-watch-thread][aria-label="Notification details: Last visible thread"]',
    );
    if (!firstButton || !lastButton) throw new Error('Expected visible Watch thread disclosures');
    expect(container.querySelector(
      'button[data-watch-thread][aria-label="Notification details: Collapsed thread"]',
    )).toBeNull();

    firstButton.focus();
    keydown(firstButton, 'ArrowDown');
    expect(document.activeElement).toBe(lastButton);

    keydown(lastButton, 'ArrowUp');
    expect(document.activeElement).toBe(firstButton);

    keydown(firstButton, 'End');
    expect(document.activeElement).toBe(lastButton);

    keydown(lastButton, 'Home');
    expect(document.activeElement).toBe(firstButton);
  });
});
