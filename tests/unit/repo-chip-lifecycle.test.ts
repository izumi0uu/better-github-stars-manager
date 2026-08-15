/**
 * @vitest-environment jsdom
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import type { Tag } from '@/types';

type TagResponse = { tag: Tag | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.equal(predicate(), true);
}

function createTag(fullName: string, label: string): Tag {
  return {
    full_name: fullName,
    manualTags: [label],
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: '2026-08-15T00:00:00.000Z',
    autoTagsMtime: '2026-08-15T00:00:00.000Z',
    dismissedAutoTagsMtime: '2026-08-15T00:00:00.000Z',
    notes: '',
    mtime: '2026-08-15T00:00:00.000Z',
  };
}

function renderRepoHeader(pageDocument: Document, owner: string, repo: string): void {
  pageDocument.body.innerHTML = `
    <span itemprop="author"><a>${owner}</a></span>
    <strong itemprop="name"><a data-pjax>${repo}</a></strong>
  `;
}

function retargetRepoHeader(pageDocument: Document, owner: string, repo: string): void {
  const author = pageDocument.querySelector<HTMLElement>('span[itemprop="author"] a');
  const name = pageDocument.querySelector<HTMLElement>('strong[itemprop="name"] a[data-pjax]');
  assert.ok(author);
  assert.ok(name);
  author.textContent = owner;
  name.textContent = repo;
}

function repoChips(pageDocument: Document): HTMLElement[] {
  return Array.from(pageDocument.querySelectorAll<HTMLElement>('span'))
    .filter((element) => element.shadowRoot !== null);
}

function currentChip(pageDocument: Document): HTMLElement {
  const chips = repoChips(pageDocument);
  assert.equal(chips.length, 1);
  return chips[0];
}

function chipTag(chip: HTMLElement): string | null | undefined {
  return chip.shadowRoot?.querySelector('.tag')?.textContent;
}

function mountedChipTag(pageDocument: Document): string | null | undefined {
  const chip = repoChips(pageDocument)[0];
  return chip ? chipTag(chip) : undefined;
}

function dispatchPageEvent(pageDocument: Document, type: string): void {
  const event = pageDocument.createEvent('Event');
  event.initEvent(type, false, false);
  pageDocument.dispatchEvent(event);
}

afterEach(() => {
  vi.doUnmock('@/auth/auth-store');
  vi.doUnmock('@/i18n');
  vi.doUnmock('@/utils/messaging');
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('repo chip content runtime lifecycle', () => {
  it('keeps one current chip and fences stale repository loads across navigation', async () => {
    vi.resetModules();
    const staleAlpha = deferred<TagResponse>();
    let alphaLoads = 0;
    let betaLoads = 0;
    const bgCallMock = vi.fn((type: string, payload?: { full_name?: string }) => {
      assert.equal(type, 'getTag');
      const fullName = payload?.full_name;
      if (fullName === 'alpha/repo-a') {
        alphaLoads += 1;
        return alphaLoads === 1
          ? Promise.resolve({ tag: createTag(fullName, 'alpha-current') })
          : staleAlpha.promise;
      }
      assert.equal(fullName, 'beta/repo-b');
      betaLoads += 1;
      return Promise.resolve({ tag: createTag(fullName, `beta-${betaLoads}`) });
    });

    vi.doMock('@/auth/auth-store', () => ({
      authStore: {
        getLocale: vi.fn(() => Promise.resolve('en')),
      },
    }));
    vi.doMock('@/i18n', () => ({
      messageFor: () => ({
        tagEditor: { bulkPlaceholder: 'tag-a, tag-b' },
        repoChip: {
          untagged: 'untagged',
          filterByTag: (tag: string) => `Filter by ${tag}`,
          editTags: 'Edit tags',
        },
      }),
    }));
    vi.doMock('@/utils/messaging', () => ({ bgCall: bgCallMock }));

    const frame = document.createElement('iframe');
    frame.src = 'javascript:void 0';
    document.body.appendChild(frame);
    const pageWindow = frame.contentWindow;
    assert.ok(pageWindow);
    const pageDocument = pageWindow.document;
    pageWindow.history.replaceState(null, '', '/alpha/repo-a');
    renderRepoHeader(pageDocument, 'alpha', 'repo-a');

    // The module must load after these content-runtime dependency mocks are installed.
    const { installRepoChipRuntime } = await import('@/content/repo-chip/index');
    installRepoChipRuntime(pageWindow);
    await waitFor(() => repoChips(pageDocument).length === 1);

    const firstAlpha = currentChip(pageDocument);
    assert.equal(chipTag(firstAlpha), 'alpha-current');
    dispatchPageEvent(pageDocument, 'turbo:load');
    dispatchPageEvent(pageDocument, 'turbo:render');
    await flush();
    assert.strictEqual(currentChip(pageDocument), firstAlpha);
    assert.equal(alphaLoads, 1);

    pageWindow.history.pushState(null, '', '/beta/repo-b');
    retargetRepoHeader(pageDocument, 'beta', 'repo-b');
    dispatchPageEvent(pageDocument, 'turbo:load');
    await waitFor(() => mountedChipTag(pageDocument) === 'beta-1');
    const firstBeta = currentChip(pageDocument);
    assert.equal(firstAlpha.isConnected, false);
    assert.equal(repoChips(pageDocument).length, 1);

    pageWindow.history.pushState(null, '', '/beta/repo-b?tab=issues#discussion');
    dispatchPageEvent(pageDocument, 'turbo:render');
    await waitFor(() => mountedChipTag(pageDocument) === 'beta-2');
    const queryBeta = currentChip(pageDocument);
    assert.notStrictEqual(queryBeta, firstBeta);
    assert.equal(firstBeta.isConnected, false);
    assert.equal(repoChips(pageDocument).length, 1);

    pageWindow.history.pushState(null, '', '/settings/profile');
    dispatchPageEvent(pageDocument, 'turbo:load');
    await flush();
    assert.equal(queryBeta.isConnected, false);
    assert.equal(repoChips(pageDocument).length, 0);

    pageWindow.history.pushState(null, '', '/alpha/repo-a');
    retargetRepoHeader(pageDocument, 'alpha', 'repo-a');
    dispatchPageEvent(pageDocument, 'turbo:load');
    await waitFor(() => alphaLoads === 2);
    assert.equal(repoChips(pageDocument).length, 0);

    pageWindow.history.pushState(null, '', '/beta/repo-b');
    retargetRepoHeader(pageDocument, 'beta', 'repo-b');
    dispatchPageEvent(pageDocument, 'turbo:render');
    await waitFor(() => mountedChipTag(pageDocument) === 'beta-3');
    const winningBeta = currentChip(pageDocument);

    staleAlpha.resolve({ tag: createTag('alpha/repo-a', 'alpha-stale') });
    await flush();
    assert.strictEqual(currentChip(pageDocument), winningBeta);
    assert.equal(chipTag(winningBeta), 'beta-3');
    assert.equal(repoChips(pageDocument).length, 1);

    frame.remove();
  });
});
