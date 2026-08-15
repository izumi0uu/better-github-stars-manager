/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreRatingPrompt } from '@/ui/components/StoreRatingPrompt';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];

function pointerEvent(type: string, pointerType: string): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

function renderPrompt(overrides: Partial<Parameters<typeof StoreRatingPrompt>[0]> = {}) {
  const props = {
    open: true,
    storeLabel: 'Chrome Web Store',
    ratingUrl: 'https://example.com/reviews',
    onRate: vi.fn(),
    onLater: vi.fn(),
    onNever: vi.fn(),
    ...overrides,
  };
  const container = mountReact(<StoreRatingPrompt {...props} />, mountedRoots);
  return { container, props };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    media: '(hover: hover) and (pointer: fine)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.unstubAllGlobals();
});

describe('store rating prompt', () => {
  it('renders one accessible bottom-right store action with the Cubby animation', () => {
    const { container } = renderPrompt();
    const overlay = container.querySelector('[data-testid="store-rating-prompt"]');
    const dialog = container.querySelector('[role="dialog"]');
    const link = container.querySelector('[data-testid="store-rating-link"]');

    expect(overlay?.classList.contains('items-end')).toBe(true);
    expect(overlay?.classList.contains('justify-items-end')).toBe(true);
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('gsm-store-rating-title');
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link?.getAttribute('href')).toBe('https://example.com/reviews');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('aria-label')).toContain('Chrome Web Store');
    expect(container.querySelectorAll('[data-heart-index]')).toHaveLength(5);
    expect(container.querySelector('picture img')?.getAttribute('src')).toContain('index-agent-working.gif');
    expect(document.activeElement).toBe(link);
  });

  it('previews hearts cumulatively for fine pointers and clears on leave', () => {
    const { container } = renderPrompt();
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="store-rating-link"]');
    const hearts = [...container.querySelectorAll<HTMLElement>('[data-heart-index]')];
    if (!link || hearts.length !== 5) throw new Error('Missing rating hearts');

    act(() => {
      hearts[2].dispatchEvent(pointerEvent('pointerover', 'mouse'));
    });
    expect(hearts.map((heart) => heart.dataset.active)).toEqual([
      'true', 'true', 'true', 'false', 'false',
    ]);

    act(() => {
      hearts[4].dispatchEvent(pointerEvent('pointerover', 'touch'));
    });
    expect(hearts.map((heart) => heart.dataset.active)).toEqual([
      'true', 'true', 'true', 'false', 'false',
    ]);

    act(() => {
      link.dispatchEvent(pointerEvent('pointerout', 'mouse'));
    });
    expect(hearts.map((heart) => heart.dataset.active)).toEqual([
      'false', 'false', 'false', 'false', 'false',
    ]);
  });

  it('routes store, later, never, close, and Escape actions without a local rating value', async () => {
    const { container, props } = renderPrompt();
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="store-rating-link"]');
    if (!link) throw new Error('Missing rating link');
    link.addEventListener('click', (event) => event.preventDefault());

    await act(async () => {
      link.click();
      await Promise.resolve();
    });
    expect(props.onRate).toHaveBeenCalledTimes(1);

    const buttons = [...container.querySelectorAll('button')];
    const never = buttons.find((button) => button.textContent?.trim() === 'Never remind me');
    const later = buttons.find((button) => button.textContent?.trim() === 'Later');
    const close = buttons.find((button) => button.getAttribute('aria-label') === 'Close');
    if (!never || !later || !close) throw new Error('Missing rating prompt action');

    await click(never);
    await click(later);
    await click(close);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(props.onNever).toHaveBeenCalledTimes(1);
    expect(props.onLater).toHaveBeenCalledTimes(3);
    expect(container.querySelector('input')).toBeNull();
  });
});
