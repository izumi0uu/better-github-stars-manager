/**
 * @vitest-environment jsdom
 */
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWatchSubjectDetails } from '@/ui/hooks/use-watch-subject-details';
import { ExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { BackgroundCallError } from '@/utils/messaging';
import type { GitHubNotificationThread, WatchSubjectDetail } from '@/watch/watch-model';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const subjectMocks = vi.hoisted(() => ({ bgCall: vi.fn() }));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/messaging')>();
  return { ...actual, bgCall: subjectMocks.bgCall };
});

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials',
  authStore: {},
}));

type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const storageListeners: StorageListener[] = [];
const mountedRoots: MountedRoot[] = [];
const runtime = new ExtensionManagerRuntime();

const issueThread: GitHubNotificationThread = {
  id: '123',
  repositoryFullName: 'owner/repo',
  repositoryHtmlUrl: 'https://github.com/owner/repo',
  reason: 'subscribed',
  subjectType: 'Issue',
  subjectTitle: 'Issue title',
  subjectApiUrl: 'https://api.github.com/repos/owner/repo/issues/7',
  subjectHtmlUrl: 'https://github.com/owner/repo/issues/7',
  unread: true,
  updatedAt: '2026-08-05T02:00:00Z',
  lastReadAt: null,
  fetchedAt: '2026-08-05T03:00:00Z',
};

const detail: WatchSubjectDetail = {
  kind: 'issue',
  repositoryFullName: 'owner/repo',
  number: 7,
  title: 'Issue title',
  state: 'open',
  stateReason: null,
  htmlUrl: 'https://github.com/owner/repo/issues/7',
  author: {
    login: 'octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
    htmlUrl: 'https://github.com/octocat',
  },
  createdAt: '2026-08-05T01:00:00Z',
  updatedAt: '2026-08-05T02:00:00Z',
  labels: [],
  assignees: [],
  milestoneTitle: null,
  commentCount: 0,
  bodyMarkdown: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function storedCredential(tokenEncrypted: string) {
  return {
    username: 'octocat',
    tokenEncrypted,
    tokenCryptoMeta: { salt: 'salt', iv: 'iv' },
    githubCredentialStatus: 'ready',
    watchNotificationsEnabled: true,
  };
}

function SubjectProbe({ thread }: { thread: GitHubNotificationThread }) {
  const [expanded, setExpanded] = useState(false);
  const subject = useWatchSubjectDetails({ thread, expanded });
  return (
    <div>
      <button type="button" data-testid="toggle" onClick={() => setExpanded((current) => !current)}>Toggle</button>
      <button type="button" data-testid="retry" onClick={subject.retry}>Retry</button>
      <span data-testid="supported">{String(subject.supported)}</span>
      <span data-testid="status">{subject.state.status}</span>
      <span data-testid="code">{subject.state.status === 'error' ? subject.state.code ?? 'none' : 'none'}</span>
    </div>
  );
}

function Harness({ thread = issueThread }: { thread?: GitHubNotificationThread }) {
  return (
    <ManagerRuntimeProvider runtime={runtime}>
      <SubjectProbe thread={thread} />
    </ManagerRuntimeProvider>
  );
}

beforeEach(() => {
  subjectMocks.bgCall.mockReset();
  storageListeners.length = 0;
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      onChanged: {
        addListener: vi.fn((listener: StorageListener) => storageListeners.push(listener)),
        removeListener: vi.fn((listener: StorageListener) => {
          const index = storageListeners.indexOf(listener);
          if (index >= 0) storageListeners.splice(index, 1);
        }),
      },
    },
  });
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.unstubAllGlobals();
});

describe('useWatchSubjectDetails', () => {
  it('loads only after expansion, caches the settled UI state, and reloads after close/reopen', async () => {
    subjectMocks.bgCall.mockResolvedValue(detail);
    const container = mountReact(<Harness />, mountedRoots);

    expect(subjectMocks.bgCall).not.toHaveBeenCalled();
    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);
    expect(subjectMocks.bgCall).toHaveBeenCalledWith('getWatchSubjectDetail', { threadId: '123' });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('success');

    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);
    expect(subjectMocks.bgCall).toHaveBeenCalledTimes(2);
  });

  it('ignores a settled request after collapse and starts a fresh request when reopened', async () => {
    const first = deferred<WatchSubjectDetail>();
    subjectMocks.bgCall
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(detail);
    const container = mountReact(<Harness />, mountedRoots);

    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('loading');
    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);
    await act(async () => {
      first.resolve(detail);
      await first.promise;
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('loading');

    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('success');
    expect(subjectMocks.bgCall).toHaveBeenCalledTimes(2);
  });

  it('surfaces stable background error codes and retries on demand', async () => {
    subjectMocks.bgCall
      .mockRejectedValueOnce(new BackgroundCallError('permission copy', undefined, 'permission_denied'))
      .mockResolvedValueOnce(detail);
    const container = mountReact(<Harness />, mountedRoots);

    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('error');
    expect(container.querySelector('[data-testid="code"]')?.textContent).toBe('permission_denied');

    await click(container.querySelector<HTMLButtonElement>('[data-testid="retry"]')!);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('success');
  });

  it('invalidates visible details when the authoritative credential changes', async () => {
    subjectMocks.bgCall.mockResolvedValue(detail);
    const container = mountReact(<Harness />, mountedRoots);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);

    act(() => {
      storageListeners[0]?.({
        gsm_github_credentials: {
          oldValue: storedCredential('cipher-a'),
          newValue: storedCredential('cipher-b'),
        },
      }, 'local');
    });

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('error');
    expect(container.querySelector('[data-testid="code"]')?.textContent).toBe('credential_changed');
  });

  it('does not request details for unsupported notification subject types', async () => {
    const container = mountReact(
      <Harness thread={{ ...issueThread, subjectType: 'Discussion' }} />,
      mountedRoots,
    );
    await click(container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!);

    expect(container.querySelector('[data-testid="supported"]')?.textContent).toBe('false');
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('idle');
    expect(subjectMocks.bgCall).not.toHaveBeenCalled();
  });
});
