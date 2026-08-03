/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDelayedHoverIntent } from '@/ui/hooks/use-delayed-hover-intent';
import {
  cleanupMountedRootsAndBody,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];

function Harness({
  enabled,
  delayMs = 20,
  closeDelayMs = 0,
  onOpen,
  onClose,
}: {
  enabled: boolean;
  delayMs?: number;
  closeDelayMs?: number;
  onOpen: () => void;
  onClose: () => void;
}) {
  const intent = useDelayedHoverIntent({
    enabled,
    delayMs,
    closeDelayMs,
    onOpen,
    onClose,
  });
  return (
    <button
      type="button"
      onMouseEnter={intent.onMouseEnter}
      onMouseLeave={intent.onMouseLeave}
      onFocus={intent.onFocus}
      onBlur={intent.onBlur}
    >
      Preview
    </button>
  );
}

describe('useDelayedHoverIntent', () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanupMountedRootsAndBody(mountedRoots);
  });

  it('closes an already-open preview when the intent becomes disabled', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
      root.render(<Harness enabled onOpen={onOpen} onClose={onClose} />);
    });
    const button = container.querySelector('button') as HTMLButtonElement;

    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(20);
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    onClose.mockClear();

    act(() => {
      root.render(<Harness enabled={false} onOpen={onOpen} onClose={onClose} />);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('bridges the leave→enter gap with closeDelayMs without snapping shut', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
      root.render(
        <Harness
          enabled
          delayMs={20}
          closeDelayMs={100}
          onOpen={onOpen}
          onClose={onClose}
        />,
      );
    });
    const button = container.querySelector('button') as HTMLButtonElement;

    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(20);
    });
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => {
      button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      // Still inside the close grace window.
      vi.advanceTimersByTime(40);
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(100);
    });

    expect(onClose).not.toHaveBeenCalled();
    // Re-enter during pending close re-asserts open immediately (no second delay).
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
