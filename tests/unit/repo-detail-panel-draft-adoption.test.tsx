/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactElement } from 'react';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { ExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import {
  cleanupMountedRootsAndBody,
  click,
  fakeStar,
  fakeTag,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];
const runtime = new ExtensionManagerRuntime();

function withRuntime(element: ReactElement): ReactElement {
  return <ManagerRuntimeProvider runtime={runtime}>{element}</ManagerRuntimeProvider>;
}
const sendMessageMock = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation((message: { type?: string }) => {
    if (message.type === 'listExcluded') return new Promise(() => {});
    return Promise.resolve({ ok: true });
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: sendMessageMock },
  });
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.unstubAllGlobals();
});

describe('repository detail editor ownership', () => {

  it('preserves dirty drafts across refreshes and resets both drafts on repository navigation', async () => {
    const commonProps = {
      selectedTags: [],
      onToggleTag: vi.fn(),
      onDataChanged: vi.fn(),
      onClose: vi.fn(),
      onPrev: vi.fn(),
      onNext: vi.fn(),
      hasPrev: false,
      hasNext: false,
    };
    const container = mountReact(withRuntime(
      <RepoDetailPanel
        {...commonProps}
        star={fakeStar()}
        tag={fakeTag({ manualTags: ['ui'], notes: 'initial note' })}
      />,
    ), mountedRoots);

    await click(removeTagButton(container));
    await setTextareaValue(notesTextarea(container), 'local note');

    await renderPanel(
      <RepoDetailPanel
        {...commonProps}
        star={fakeStar({ stargazers_count: 1300 })}
        tag={fakeTag({ manualTags: ['ui'], notes: 'initial note' })}
      />,
    );

    expect(visibleTags(container)).toEqual([]);
    expect(notesTextarea(container).value).toBe('local note');

    await renderPanel(
      <RepoDetailPanel
        {...commonProps}
        star={fakeStar({ stargazers_count: 1300 })}
        tag={fakeTag({ manualTags: ['server'], notes: 'server note' })}
      />,
    );

    expect(visibleTags(container)).toEqual([]);
    expect(notesTextarea(container).value).toBe('local note');

    await renderPanel(
      <RepoDetailPanel
        {...commonProps}
        star={fakeStar({ full_name: 'owner/next' })}
        tag={fakeTag({
          full_name: 'owner/next',
          manualTags: ['next'],
          notes: 'next note',
        })}
      />,
    );

    expect(visibleTags(container)).toEqual(['next']);
    expect(notesTextarea(container).value).toBe('next note');
  });

  it('adopts authoritative tag and note refreshes while their drafts are clean', async () => {
    const commonProps = {
      star: fakeStar(),
      selectedTags: [],
      onToggleTag: vi.fn(),
      onClose: vi.fn(),
      onPrev: vi.fn(),
      onNext: vi.fn(),
      hasPrev: false,
      hasNext: false,
    };
    const container = mountReact(withRuntime(
      <RepoDetailPanel
        {...commonProps}
        tag={fakeTag({ manualTags: ['ui'], notes: 'initial note' })}
      />,
    ), mountedRoots);

    await renderPanel(
      <RepoDetailPanel
        {...commonProps}
        tag={fakeTag({ manualTags: ['server'], notes: 'server note' })}
      />,
    );

    expect(visibleTags(container)).toEqual(['server']);
    expect(notesTextarea(container).value).toBe('server note');
  });

  it('ignores pending editor completions after repository navigation', async () => {
    const pendingRemove = deferred<{ ok: true }>();
    const pendingNotes = deferred<{ ok: true }>();
    sendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === 'listExcluded') return new Promise(() => {});
      if (message.type === 'removeVisibleTag') return pendingRemove.promise;
      if (message.type === 'setNotes') return pendingNotes.promise;
      return Promise.resolve({ ok: true });
    });
    const onDataChanged = vi.fn();
    const onMeaningfulAction = vi.fn();
    const commonProps = {
      selectedTags: [],
      onToggleTag: vi.fn(),
      onDataChanged,
      onMeaningfulAction,
      onClose: vi.fn(),
      onPrev: vi.fn(),
      onNext: vi.fn(),
      hasPrev: false,
      hasNext: false,
    };
    const container = mountReact(withRuntime(
      <RepoDetailPanel
        {...commonProps}
        star={fakeStar()}
        tag={fakeTag({ manualTags: ['shared'], notes: 'repo A note' })}
      />,
    ), mountedRoots);

    await setTextareaValue(notesTextarea(container), 'pending repo A note');
    await click(notesSaveButton(container));
    await click(removeTagButton(container));
    await renderPanel(
      <RepoDetailPanel
        {...commonProps}
        star={fakeStar({ full_name: 'owner/repo-b' })}
        tag={fakeTag({
          full_name: 'owner/repo-b',
          manualTags: ['shared', 'repo-b'],
          notes: 'repo B note',
        })}
      />,
    );

    await act(async () => {
      pendingRemove.resolve({ ok: true });
      pendingNotes.resolve({ ok: true });
      await Promise.all([pendingRemove.promise, pendingNotes.promise]);
      await Promise.resolve();
    });

    expect(visibleTags(container)).toEqual(['shared', 'repo-b']);
    expect(notesTextarea(container).value).toBe('repo B note');
    expect(onDataChanged).not.toHaveBeenCalled();
    expect(onMeaningfulAction).not.toHaveBeenCalled();
  });

  it('retains the note draft and returns to idle when saving fails', async () => {
    sendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === 'listExcluded') return new Promise(() => {});
      if (message.type === 'setNotes') return Promise.resolve({ ok: false, error: 'NOTE_SAVE_FAILED' });
      return Promise.resolve({ ok: true });
    });
    const container = mountReact(withRuntime(
      <RepoDetailPanel
        star={fakeStar()}
        tag={fakeTag({ notes: 'initial note' })}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        hasPrev={false}
        hasNext={false}
      />,
    ), mountedRoots);

    await setTextareaValue(notesTextarea(container), 'unsaved note');
    const save = notesSaveButton(container);
    await click(save);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(notesTextarea(container).value).toBe('unsaved note');
    expect(save.disabled).toBe(false);
  });
});

async function renderPanel(element: ReactElement) {
  await act(async () => {
    mountedRoots[0].render(withRuntime(element));
    await Promise.resolve();
  });
}

function removeTagButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button[title="Remove tag"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Missing tag remove button');
  return button;
}

function visibleTags(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button[title="Remove tag"]')].map(
    (button) => button.parentElement?.textContent ?? '',
  );
}

function notesTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing notes textarea');
  return textarea;
}

function notesSaveButton(container: HTMLElement): HTMLButtonElement {
  const section = notesTextarea(container).parentElement;
  const button = [...(section?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((candidate) => candidate.textContent?.trim() === 'Save');
  if (!button) throw new Error('Missing notes save button');
  return button;
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}
