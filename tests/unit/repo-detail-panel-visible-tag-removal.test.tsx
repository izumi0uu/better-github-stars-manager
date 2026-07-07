/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import {
  cleanupMountedRootsAndBody,
  click,
  fakeStar,
  fakeTag,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];

function removeButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button[title="Remove tag"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Expected visible tag remove button');
  return button;
}

describe('RepoDetailPanel visible tag removal', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn((message: { type?: string }) => {
          if (message.type === 'listExcluded') return Promise.resolve({ ok: true, data: [] });
          if (message.type === 'removeVisibleTag') return Promise.resolve({ ok: false, error: 'remove failed' });
          return Promise.resolve({ ok: true });
        }),
      },
    });
  });

  afterEach(() => {
    cleanupMountedRootsAndBody(mountedRoots);
    vi.unstubAllGlobals();
  });

  it('keeps auto-only chips visible and skips data refresh when persistent removal fails', async () => {
    const onDataChanged = vi.fn();
    const container = mountReact(
      <RepoDetailPanel
        star={fakeStar()}
        tag={fakeTag({ manualTags: [], autoTags: ['auto'] })}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onDataChanged={onDataChanged}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        hasPrev={false}
        hasNext={false}
      />,
      mountedRoots,
    );

    await click(removeButton(container));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'removeVisibleTag',
      full_name: 'owner/repo',
      name: 'auto',
    });
    expect(onDataChanged).not.toHaveBeenCalled();
    expect(container.textContent).toContain('auto');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('remove failed');
  });

  it('clears a visible tag removal error when the selected repo changes', async () => {
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
    const container = mountReact(
      <RepoDetailPanel
        {...commonProps}
        star={fakeStar()}
        tag={fakeTag({ manualTags: [], autoTags: ['auto'] })}
      />,
      mountedRoots,
    );

    await click(removeButton(container));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('remove failed');

    await act(async () => {
      mountedRoots[0].render(
        <RepoDetailPanel
          {...commonProps}
          star={fakeStar({ full_name: 'owner/next' })}
          tag={fakeTag({ full_name: 'owner/next', manualTags: [], autoTags: ['next'] })}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('next');
  });
});
