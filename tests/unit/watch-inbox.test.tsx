/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WatchInbox } from '@/ui/components/WatchInbox';
import type { GitHubNotificationThread } from '@/watch/watch-model';
import type { WatchInboxQueryResponse } from '@/watch/watch-contract';
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
      latestUpdatedAt: item.updatedAt,
      threads: [item],
    })),
    unreadCount: overrides.unreadCount ?? threads.length,
    totalCount: overrides.totalCount ?? threads.length,
    status: overrides.status ?? {
      accountLogin: 'idah',
      hasMainToken: true,
      hasNotificationsToken: true,
      credentialSource: 'main',
      refreshing: false,
      scopeStatus: 'fresh',
      inboxStatus: 'fresh',
      state: {
        id: 'singleton',
        accountLogin: 'idah',
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
        },
      },
    },
  };
}

const mountedRoots: MountedRoot[] = [];

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

function renderInbox(props: Partial<React.ComponentProps<typeof WatchInbox>> = {}) {
  return mountReact(
    <WatchInbox
      result={result()}
      loading={false}
      refreshing={false}
      error={null}
      unreadOnly
      onUnreadOnlyChange={vi.fn()}
      onRefresh={vi.fn()}
      onRetryQuery={vi.fn()}
      onOpenOptions={vi.fn()}
      {...props}
    />,
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
    setupResult.status.credentialSource = null;

    const container = renderInbox({ result: setupResult, onOpenOptions });
    const settings = findButtonByText(container, 'Open options');
    expect(settings).not.toBeNull();

    await click(settings!);
    expect(onOpenOptions).toHaveBeenCalledOnce();
  });

  it('routes a terminal permission failure to the supplied recovery callback', async () => {
    const onOpenOptions = vi.fn();
    const permissionResult = result();
    permissionResult.groups = [];
    permissionResult.threads = [];
    permissionResult.status.scopeStatus = 'error';
    permissionResult.status.inboxStatus = 'scope_unavailable';
    permissionResult.status.state!.scope.lastSuccessfulAt = null;
    permissionResult.status.state!.scope.errorCode = 'permission_denied';

    const container = renderInbox({ result: permissionResult, onOpenOptions });
    const settings = findButtonByText(container, 'Open options');
    expect(settings).not.toBeNull();

    await click(settings!);
    expect(onOpenOptions).toHaveBeenCalledOnce();
  });

  it('keeps Stars, tags, Gist, and sync available during Inbox credential failure', async () => {
    const onOpenOptions = vi.fn();
    const permissionResult = result();
    permissionResult.status.inboxStatus = 'error';
    permissionResult.status.state!.inbox.errorCode = 'permission_denied';

    const container = renderInbox({ result: permissionResult, onOpenOptions });
    expect(container.textContent).toContain('Watch is paused');
    expect(container.textContent).toContain('Stars');
    expect(container.textContent).toContain('tags');
    expect(container.textContent).toContain('Gist');
    expect(container.textContent).toContain('sync');

    await click(findButtonByText(container, 'Open options'));
    expect(onOpenOptions).toHaveBeenCalledOnce();
  });

  it('keeps the last successful rows visible while Watch is stale', () => {
    const staleResult = result();
    staleResult.status.scopeStatus = 'stale';
    staleResult.status.inboxStatus = 'stale';
    staleResult.status.state!.scope.errorCode = 'network';
    staleResult.status.state!.inbox.errorCode = 'network';

    const container = renderInbox({ result: staleResult });

    expect(container.textContent).toContain('Thread 0');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
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
          latestUpdatedAt: unreadThread.updatedAt,
          threads: [unreadThread, readThread],
        }],
        unreadCount: 1,
        totalCount: 2,
      }),
    });
    const link = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Open on GitHub: Thread 0"]',
    );
    const reason = link?.querySelector('code');
    const updated = link?.querySelector('time');
    const repository = container
      .querySelector('[aria-label="Collapse owner/repo-0"]')
      ?.closest('section');
    const unreadPill = Array.from(repository?.querySelectorAll('span') ?? [])
      .find((element) => element.textContent === '1 unread');

    expect(reason?.textContent).toBe('future_reason');
    expect(reason?.getAttribute('title')).toBe('future_reason');
    expect(unreadPill).toBeDefined();
    expect(link?.href).toBe('https://github.com/owner/repo-0/issues/1');
    expect(link?.target).toBe('_blank');
    expect(link?.relList.contains('noreferrer')).toBe(true);
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
    const link = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Open on GitHub: Thread 0"]',
    );
    const descriptionId = link?.getAttribute('aria-describedby');
    const description = descriptionId
      ? container.ownerDocument.getElementById(descriptionId)
      : null;

    expect(link?.href).toBe('https://github.com/owner/repo-0');
    expect(description).not.toBeNull();
    expect(description?.textContent).toContain('FutureType. future_reason.');
  });

  it('uses separate accessible group controls and lazily mounts later thread groups', async () => {
    const threads = Array.from({ length: 9 }, (_, index) => thread(index));
    const container = renderInbox({ result: result({ threads }) });

    expect(container.querySelector('summary')).toBeNull();
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label'))
      .toBe('Inbox thread filter');
    expect(container.textContent).toContain('Thread 7');
    expect(container.textContent).not.toContain('Thread 8');

    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand owner/repo-8"]',
    );
    expect(expand).not.toBeNull();
    expect(expand?.getAttribute('aria-expanded')).toBe('false');
    await click(expand!);

    expect(container.textContent).toContain('Thread 8');
    expect(expand?.getAttribute('aria-expanded')).toBe('true');
    expect(expand?.getAttribute('aria-label')).toBe('Collapse owner/repo-8');
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
    const search = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search repositories and threads"]',
    );
    if (!search) throw new Error('Expected Watch search input');

    await setInputValue(search, 'SECURITY-CENTER');

    expect(container.textContent).toContain('Dependency alert');
    expect(container.textContent).not.toContain('Prepare the changelog');
    expect(container.textContent).not.toContain('Review requested for navigation');
    expect(container.querySelector('header')?.textContent).toContain('1 thread');

    await setInputValue(search, 'requested for NAVIGATION');

    expect(container.textContent).toContain('Review requested for navigation');
    expect(container.textContent).not.toContain('Dependency alert');

    await setInputValue(search, 'no such repository or thread');

    expect(container.textContent).toContain(
      'No threads match the current Watch search and reason filters.',
    );
    expect(container.textContent).not.toContain('No unread threads in the latest Watch snapshot.');
    expect(container.querySelector('header')?.textContent).toContain('0 threads');
  });

  it('temporarily reveals matching lazy groups and restores their collapsed state', async () => {
    const threads = Array.from({ length: 9 }, (_, index) => thread(index));
    const container = renderInbox({ result: result({ threads }) });
    const search = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search repositories and threads"]',
    );
    if (!search) throw new Error('Expected Watch search input');

    expect(container.textContent).not.toContain('Thread 8');
    await setInputValue(search, 'Thread 8');

    expect(container.textContent).toContain('Thread 8');
    expect(container.querySelector('[aria-label="Collapse owner/repo-8"]')?.hasAttribute('disabled'))
      .toBe(true);

    await setInputValue(search, '');

    expect(container.textContent).not.toContain('Thread 8');
    expect(container.querySelector('[aria-label="Expand owner/repo-8"]')?.hasAttribute('disabled'))
      .toBe(false);
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
    expect(container.querySelector('header')?.textContent).toContain('3 threads');

    await click(findButtonByText(popover, 'Direct'));

    expect(container.textContent).toContain('Mention one');
    expect(container.textContent).toContain('Mention two');
    expect(container.textContent).toContain('Review request');
    expect(container.textContent).not.toContain('Security alert');
    expect(container.textContent).not.toContain('Future event');
  });

  it('moves focus with Arrow Up/Down/Home/End across visible thread links only', async () => {
    const first = thread(0, { subjectTitle: 'First visible thread' });
    const collapsed = thread(1, { subjectTitle: 'Collapsed thread' });
    const last = thread(2, { subjectTitle: 'Last visible thread' });
    const container = renderInbox({ result: result({ threads: [first, collapsed, last] }) });
    const collapseMiddle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse owner/repo-1"]',
    );
    if (!collapseMiddle) throw new Error('Expected middle repository collapse control');
    await click(collapseMiddle);

    const firstLink = container.querySelector<HTMLAnchorElement>(
      'a[data-watch-thread][aria-label="Open on GitHub: First visible thread"]',
    );
    const lastLink = container.querySelector<HTMLAnchorElement>(
      'a[data-watch-thread][aria-label="Open on GitHub: Last visible thread"]',
    );
    if (!firstLink || !lastLink) throw new Error('Expected visible Watch thread links');
    expect(container.querySelector(
      'a[data-watch-thread][aria-label="Open on GitHub: Collapsed thread"]',
    )).toBeNull();

    firstLink.focus();
    keydown(firstLink, 'ArrowDown');
    expect(document.activeElement).toBe(lastLink);

    keydown(lastLink, 'ArrowUp');
    expect(document.activeElement).toBe(firstLink);

    keydown(firstLink, 'End');
    expect(document.activeElement).toBe(lastLink);

    keydown(lastLink, 'Home');
    expect(document.activeElement).toBe(firstLink);
  });
});
