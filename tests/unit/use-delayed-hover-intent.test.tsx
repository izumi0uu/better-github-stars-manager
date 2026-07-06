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
  onOpen,
  onClose,
}: {
  enabled: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const intent = useDelayedHoverIntent({
    enabled,
    delayMs: 20,
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
});
