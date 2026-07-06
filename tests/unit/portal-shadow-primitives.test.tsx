/**
 * @vitest-environment jsdom
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, it, vi } from 'vitest';
import { PortalProvider, usePortalContainer } from '@/ui/shadcn/portal-context';
import {
  bindLayoutColumnMenuDismissal,
  isInsideLayoutColumnMenuPath,
} from '@/ui/hooks/use-layout-column-menu';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function Probe({ label }: { label: string }) {
  const container = usePortalContainer();
  return <span data-label={label} data-owner={container?.id ?? 'none'} />;
}

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  roots.push(root);
  return host;
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('portal and shadow primitive invariants', () => {
  it('returns the nearest portal provider container and falls back to undefined', () => {
    const outer = document.createElement('div');
    outer.id = 'outer-portal';
    const inner = document.createElement('div');
    inner.id = 'inner-portal';
    const outerRef: RefObject<HTMLElement | null> = { current: outer };
    const innerRef: RefObject<HTMLElement | null> = { current: inner };

    const host = mount(
      <>
        <Probe label="fallback" />
        <PortalProvider containerRef={outerRef}>
          <Probe label="outer" />
          <PortalProvider containerRef={innerRef}>
            <Probe label="inner" />
          </PortalProvider>
        </PortalProvider>
      </>,
    );

    assert.equal(host.querySelector('[data-label="fallback"]')?.getAttribute('data-owner'), 'none');
    assert.equal(host.querySelector('[data-label="outer"]')?.getAttribute('data-owner'), 'outer-portal');
    assert.equal(host.querySelector('[data-label="inner"]')?.getAttribute('data-owner'), 'inner-portal');
  });

  it('treats portaled layout-column-menu descendants as inside dismissal boundaries', () => {
    const menu = document.createElement('div');
    menu.dataset.layoutColumnMenu = 'true';
    const child = document.createElement('button');
    menu.appendChild(child);

    assert.equal(isInsideLayoutColumnMenuPath([child]), true);
    assert.equal(isInsideLayoutColumnMenuPath([document.createElement('button')]), false);
  });

  it('dismisses layout column menu on outside pointerdown and Escape, and cleans listeners', () => {
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        assert.equal(listeners.get(type), listener);
        listeners.delete(type);
      }),
    };
    const onDismiss = vi.fn();
    const cleanup = bindLayoutColumnMenuDismissal(target, onDismiss);

    const menu = document.createElement('div');
    menu.dataset.layoutColumnMenu = 'true';
    const insidePointer = {
      composedPath: () => [menu],
    } as unknown as PointerEvent;
    listeners.get('pointerdown')?.(insidePointer);
    assert.equal(onDismiss.mock.calls.length, 0);

    const outsidePointer = {
      composedPath: () => [document.body],
    } as unknown as PointerEvent;
    listeners.get('pointerdown')?.(outsidePointer);
    listeners.get('keydown')?.(new KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(onDismiss.mock.calls.length, 2);

    cleanup();
    assert.equal(target.removeEventListener.mock.calls.length, 2);
    assert.equal(listeners.size, 0);
  });

  it('keeps Radix primitives wired to the shared portal container with fallback behavior', () => {
    const popover = readFileSync('src/ui/shadcn/popover.tsx', 'utf8');
    const tooltip = readFileSync('src/ui/shadcn/tooltip.tsx', 'utf8');
    const select = readFileSync('src/ui/shadcn/select.tsx', 'utf8');

    assert.match(popover, /const container = usePortalContainer\(\);/);
    assert.match(popover, /<PopoverPrimitive\.Portal container=\{container\}>\{content\}<\/PopoverPrimitive\.Portal>/);
    assert.match(popover, /<PopoverPrimitive\.Portal>\{content\}<\/PopoverPrimitive\.Portal>/);
    assert.match(tooltip, /const container = usePortalContainer\(\);/);
    assert.match(tooltip, /<TooltipPrimitive\.Portal container=\{container\}>\{content\}<\/TooltipPrimitive\.Portal>/);
    assert.match(tooltip, /<TooltipPrimitive\.Portal>\{content\}<\/TooltipPrimitive\.Portal>/);
    assert.match(select, /const container = usePortalContainer\(\);/);
    assert.match(select, /<SelectPrimitive\.Portal container=\{container\}>/);
  });

  it('positions layout column menu with panel-relative clamp and removes resize/scroll listeners', () => {
    const source = readFileSync('src/ui/hooks/use-layout-column-menu.ts', 'utf8');
    assert.match(source, /Math\.max\(\s*COLUMN_MENU_EDGE_GUARD_PX,/);
    assert.match(source, /rootRect\.width - COLUMN_MENU_WIDTH_PX - COLUMN_MENU_EDGE_GUARD_PX/);
    assert.match(source, /top: triggerRect\.bottom - rootRect\.top \+ COLUMN_MENU_TRIGGER_GAP_PX/);
    assert.match(source, /window\.addEventListener\('resize', updatePosition\);/);
    assert.match(source, /window\.addEventListener\('scroll', updatePosition, true\);/);
    assert.match(source, /window\.removeEventListener\('resize', updatePosition\);/);
    assert.match(source, /window\.removeEventListener\('scroll', updatePosition, true\);/);
  });
});
