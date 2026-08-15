/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerSurfaceTabs } from '@/ui/components/ManagerSurfaceTabs';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class SurfaceTabsResizeObserver {
  static instances: SurfaceTabsResizeObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    SurfaceTabsResizeObserver.instances.push(this);
  }

  emit(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

const mountedRoots: Root[] = [];

function mountTabs({ disabled = false } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSurfaceChange = vi.fn();
  act(() => {
    root.render(
      <ManagerSurfaceTabs
        surface="watch"
        watchUnreadCount={7}
        radarUnseenCount={4}
        disabled={disabled}
        onSurfaceChange={onSurfaceChange}
      />,
    );
  });
  mountedRoots.push(root);
  return { container, root, onSurfaceChange };
}

beforeEach(() => {
  SurfaceTabsResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', SurfaceTabsResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function offsetLeft(this: HTMLElement) {
    if (this.id === 'gsm-watch-surface-tab') return 48;
    if (this.id === 'gsm-radar-surface-tab') return 112;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function offsetWidth(this: HTMLElement) {
    if (this.id === 'gsm-watch-surface-tab') return 64;
    if (this.id === 'gsm-radar-surface-tab') return 72;
    return 48;
  });
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
    mountedRoots.length = 0;
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ManagerSurfaceTabs', () => {
  it('owns indicator measurement, keyboard focus navigation, and observer cleanup', () => {
    const { container, root, onSurfaceChange } = mountTabs();
    const watch = container.querySelector<HTMLButtonElement>('#gsm-watch-surface-tab');
    const radar = container.querySelector<HTMLButtonElement>('#gsm-radar-surface-tab');
    const indicator = container.querySelector<HTMLElement>('.gsm-surface-indicator');
    const observer = SurfaceTabsResizeObserver.instances[0];

    expect(indicator?.style.width).toBe('64px');
    if (!observer) throw new Error('Expected ManagerSurfaceTabs to create a ResizeObserver');
    expect(indicator?.style.transform).toBe('translateX(48px)');
    expect(observer.observe).toHaveBeenCalledTimes(3);

    act(() => {
      watch?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onSurfaceChange).toHaveBeenCalledWith('radar');
    expect(document.activeElement).toBe(radar);

    act(() => root.unmount());
    mountedRoots.length = 0;
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('preserves the layout-edit disabled state for every surface tab', () => {
    const { container } = mountTabs({ disabled: true });
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    expect(tabs).toHaveLength(3);
    expect(tabs.every((tab) => tab.disabled)).toBe(true);
  });
});
