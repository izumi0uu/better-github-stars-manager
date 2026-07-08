/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingLocaleToggle } from '@/ui/components/FloatingLocaleToggle';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const sendMessage = vi.fn();

function mountToggle() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<FloatingLocaleToggle drawerOpen={false} />);
  });
  mountedRoots.push(root);
  return { container };
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function devClearButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((item) => item.textContent?.includes('Clear') || item.textContent?.includes('Confirm'));
  if (!(button instanceof HTMLButtonElement)) throw new Error('Expected clear-local button');
  return button;
}

beforeEach(() => {
  sendMessage.mockReset();
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
    },
  });
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('FloatingLocaleToggle', () => {
  it('surfaces dev clear failure and clears the error on retry intent', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'network-down' });
    const { container } = mountToggle();

    await click(devClearButton(container));
    expect(container.textContent).toContain('Confirm clear');

    await click(devClearButton(container));
    expect(container.textContent).toContain('Clear failed: network-down');
    expect(sendMessage.mock.calls.map((call) => call[0])).toContainEqual({ type: 'devClearLocalData' });

    await click(devClearButton(container));
    expect(container.textContent).toContain('Confirm clear');
    expect(container.textContent).not.toContain('network-down');
  });
});
