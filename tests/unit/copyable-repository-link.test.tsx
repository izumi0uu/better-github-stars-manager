/** @vitest-environment jsdom */
import { act } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyableRepositoryLink } from '@/ui/components/CopyableRepositoryLink';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { RadarFeedRow } from '@/ui/components/RadarActivityRows';
import type {
  ManagerLinkResource,
  ManagerResourcePolicy,
  ManagerRuntime,
} from '@/runtime/manager-runtime';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { I18nProvider, getMessages } from '@/i18n';
import type { RadarActivityPresentation } from '@/radar/radar-model';
import {
  cleanupMountedRootsAndBody,
  fakeStar,
  fakeTag,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];

const writeTextMock = vi.fn(async () => undefined);

function stubClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  });
}

function clearClipboard() {
  delete (navigator as { clipboard?: unknown }).clipboard;
}

const repositoryResource: ManagerLinkResource = {
  kind: 'repository',
  fullName: 'acme/widgets',
  remoteUrl: 'https://github.com/acme/widgets',
};

function createRuntime(
  resources: Partial<ManagerResourcePolicy> = {},
): ManagerRuntime {
  const policy: ManagerResourcePolicy = {
    resolveImage: () => null,
    resolveLink: ({ remoteUrl }) => remoteUrl,
    onBlockedLink: () => {},
    ...resources,
  };
  return {
    resources: policy,
    now: () => 0,
    subscribe: () => () => {},
    readPreferences: async () => ({}),
    updatePreferences: async () => ({}),
    listExcludedTags: async () => [],
  } as unknown as ManagerRuntime;
}

function renderLink(
  element: ReactElement,
  runtime?: ManagerRuntime,
): HTMLDivElement {
  const wrapped = runtime
    ? <ManagerRuntimeProvider runtime={runtime}>{element}</ManagerRuntimeProvider>
    : element;
  return mountReact(wrapped, mountedRoots);
}
async function clickCopy(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}


function radarActivity(): RadarActivityPresentation {
  return {
    id: 'one',
    accountLogin: 'viewer',
    actorLogin: 'actor-one',
    actorAvatarUrl: null,
    repositoryKey: 'owner/one',
    repositoryFullName: 'owner/one',
    repositoryDisplayName: 'owner/one',
    repositoryHtmlUrl: 'https://github.com/owner/one',
    repositoryDescription: 'owner/one description',
    repositoryLanguage: 'TypeScript',
    repositoryLanguageColor: '#3178c6',
    repositoryStargazerCount: 10,
    repositoryOwnerLogin: 'owner',
    repositoryOwnerAvatarUrl: null,
    repositoryTopics: ['topic-one'],
    viewerHadStarred: false,
    starredAt: '2026-08-10T10:00:00.000Z',
    dismissedAt: null,
    seenAt: null,
    source: 'following',
    seen: true,
    viewerHasStarred: false,
    favorite: false,
    tags: [],
    suggestedTags: [],
    displayedStargazerCount: 10,
  };
}

describe('CopyableRepositoryLink behavior', () => {
  beforeEach(() => {
    writeTextMock.mockReset();
    vi.useFakeTimers();
    stubClipboard();
  });

  afterEach(() => {
    cleanupMountedRootsAndBody(mountedRoots);
    clearClipboard();
    vi.useRealTimers();
  });

  it('copies the complete resolved repository URL, never the display label', async () => {
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
    );
    const anchor = container.querySelector<HTMLAnchorElement>('a');
    expect(anchor?.getAttribute('href')).toBe('https://github.com/acme/widgets');
    expect(anchor?.target).toBe('_blank');
    await clickCopy(container.querySelector<HTMLButtonElement>('button')!);
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith('https://github.com/acme/widgets');
    expect(writeTextMock).not.toHaveBeenCalledWith('acme/widgets');
  });

  it('copies the runtime-resolved URL when the resource policy overrides it', async () => {
    const runtime = createRuntime({ resolveLink: () => 'https://github.com/policy/resolved' });
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
      runtime,
    );
    await clickCopy(container.querySelector<HTMLButtonElement>('button')!);
    expect(writeTextMock).toHaveBeenCalledWith('https://github.com/policy/resolved');
  });

  it('shows a bounded localized success state, then reverts to the copy icon', async () => {
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
    );
    const copyButton = container.querySelector<HTMLButtonElement>('button')!;
    await clickCopy(copyButton);
    expect(container.querySelector('span[role="status"]')?.textContent)
      .toBe(getMessages('en').common.copied);
    expect(copyButton.querySelector('.success-check-path')).not.toBeNull();

    act(() => { vi.advanceTimersByTime(1999); });
    expect(container.querySelector('span[role="status"]')?.textContent)
      .toBe(getMessages('en').common.copied);
    expect(copyButton.querySelector('.success-check-path')).not.toBeNull();

    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector('span[role="status"]')?.textContent).toBe('');
    expect(copyButton.querySelector('.success-check-path')).toBeNull();
  });
  it('clears the pending timer on a subsequent copy attempt', async () => {
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
    );
    const copyButton = container.querySelector<HTMLButtonElement>('button')!;
    await clickCopy(copyButton);
    act(() => { vi.advanceTimersByTime(1200); });
    await clickCopy(copyButton);
    expect(writeTextMock).toHaveBeenCalledTimes(2);

    // t=2100: the first timer (armed at t=0 for 2000ms) would have reset the
    // state if it had not been cleared by the second copy attempt.
    act(() => { vi.advanceTimersByTime(900); });
    expect(container.querySelector('span[role="status"]')?.textContent)
      .toBe(getMessages('en').common.copied);

    // t=3200: the second attempt's timer (armed at t=1200) fires.
    act(() => { vi.advanceTimersByTime(1100); });
    expect(container.querySelector('span[role="status"]')?.textContent).toBe('');
  });


  it('clears the success timer on unmount', async () => {
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
    );
    await clickCopy(container.querySelector<HTMLButtonElement>('button')!);
    expect(vi.getTimerCount()).toBe(1);
    cleanupMountedRootsAndBody(mountedRoots);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never claims success when the runtime blocks the link', async () => {
    const runtime = createRuntime({ resolveLink: () => null });
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
      runtime,
    );
    const anchor = container.querySelector<HTMLAnchorElement>('a');
    expect(anchor?.getAttribute('href')).toBe('#');
    await clickCopy(container.querySelector<HTMLButtonElement>('button')!);
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(container.querySelector('span[role="status"]')?.textContent).toBe('');
  });

  it('does not show success when the clipboard write fails', async () => {
    writeTextMock.mockRejectedValueOnce(new Error('denied'));
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
    );
    await clickCopy(container.querySelector<HTMLButtonElement>('button')!);
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('span[role="status"]')?.textContent).toBe('');
  });

  it('does not show success when the clipboard API is unavailable', async () => {
    clearClipboard();
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
    );
    await clickCopy(container.querySelector<HTMLButtonElement>('button')!);
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(container.querySelector('span[role="status"]')?.textContent).toBe('');
  });

  it('exposes a localized accessible name on a keyboard-activatable button', () => {
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>,
    );
    const copyButton = container.querySelector<HTMLButtonElement>('button')!;
    expect(copyButton.type).toBe('button');
    expect(copyButton.getAttribute('aria-label')).toBe(getMessages('en').common.copyRepository);
    expect(copyButton.getAttribute('title')).toBe(getMessages('en').common.copyRepository);
  });

  it('does not trigger the parent row action when copying', async () => {
    const onParentClick = vi.fn();
    const container = mountReact(
      <div onClick={onParentClick}>
        <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>
      </div>,
      mountedRoots,
    );
    await clickCopy(container.querySelector<HTMLButtonElement>('button')!);
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('disables the copy control when the owning overlay is locked', async () => {
    const container = renderLink(
      <CopyableRepositoryLink resource={repositoryResource} disabled>acme/widgets</CopyableRepositoryLink>,
    );
    const copyButton = container.querySelector<HTMLButtonElement>('button')!;
    expect(copyButton.disabled).toBe(true);
    await clickCopy(copyButton);
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it('renders the localized status and accessible name for Chinese', async () => {
    const zh = getMessages('zh-CN');
    expect(zh.common.copyRepository).toBe('复制仓库链接');
    expect(zh.common.copied).toBe('已复制');
    const zhSource = {
      readPreferences: async () => ({ locale: 'zh-CN' }),
      updatePreferences: async () => {},
      subscribe: () => () => {},
    } as unknown as Parameters<typeof I18nProvider>[0]['source'];
    const container = mountReact(
      <I18nProvider source={zhSource}>
        <CopyableRepositoryLink resource={repositoryResource}>acme/widgets</CopyableRepositoryLink>
      </I18nProvider>,
      mountedRoots,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const copyButton = container.querySelector<HTMLButtonElement>('button')!;
    expect(copyButton.getAttribute('aria-label')).toBe('复制仓库链接');
    await clickCopy(copyButton);
    expect(container.querySelector('span[role="status"]')?.textContent).toBe('已复制');
  });
});

describe('drawer and popup integration', () => {
  beforeEach(() => {
    writeTextMock.mockReset();
    vi.useRealTimers();
    stubClipboard();
  });

  afterEach(() => {
    cleanupMountedRootsAndBody(mountedRoots);
    clearClipboard();
  });

  it('copies the complete repository URL from the RepoDetailPanel drawer', async () => {
    const container = mountReact(
      <ManagerRuntimeProvider runtime={createRuntime()}>
        <RepoDetailPanel
          star={fakeStar()}
          tag={fakeTag()}
          selectedTags={[]}
          onToggleTag={vi.fn()}
          onClose={vi.fn()}
          onPrev={vi.fn()}
          onNext={vi.fn()}
          hasPrev={false}
          hasNext={false}
        />
      </ManagerRuntimeProvider>,
      mountedRoots,
    );
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://github.com/owner/repo"]');
    expect(link).not.toBeNull();
    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy repository URL"]');
    expect(copyButton).not.toBeNull();
    await clickCopy(copyButton!);
    expect(writeTextMock).toHaveBeenCalledWith('https://github.com/owner/repo');
  });

  it('disables the drawer copy control while interaction-locked', async () => {
    const container = mountReact(
      <ManagerRuntimeProvider runtime={createRuntime()}>
        <RepoDetailPanel
          star={fakeStar()}
          tag={fakeTag()}
          selectedTags={[]}
          onToggleTag={vi.fn()}
          onClose={vi.fn()}
          onPrev={vi.fn()}
          onNext={vi.fn()}
          hasPrev={false}
          hasNext={false}
          interactionLocked
        />
      </ManagerRuntimeProvider>,
      mountedRoots,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy repository URL"]');
    expect(copyButton?.disabled).toBe(true);
    expect(container.querySelector('a[aria-disabled="true"]')).not.toBeNull();
  });

  it('copies the repository URL from the Radar quick-actions popover header', async () => {
    const noOp = async () => undefined;
    mountReact(
      <RadarFeedRow
        searchResult={{
          activity: radarActivity(),
          relevance: 0,
          actorRanges: [],
          repositoryRanges: [],
        }}
        open
        onOpenChange={vi.fn()}
        pendingAction={null}
        actionError={null}
        onStar={vi.fn(noOp)}
        onUnstar={vi.fn(noOp)}
        onSetFavorite={vi.fn(noOp)}
        onAddTag={vi.fn(noOp)}
        onDismiss={vi.fn()}
        onMarkSeen={vi.fn()}
      />,
      mountedRoots,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const copyButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy repository URL"]',
    );
    expect(copyButton).not.toBeNull();
    await clickCopy(copyButton!);
    expect(writeTextMock).toHaveBeenCalledWith('https://github.com/owner/one');
  });
});
