/**
 * @vitest-environment jsdom
 */
import assert from 'node:assert/strict';
import React, { act, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, it, vi } from 'vitest';
import { PortalProvider, usePortalContainer } from '@/ui/shadcn/portal-context';
import { PopoverContent } from '@/ui/shadcn/popover';
import { SelectContent, SelectItem } from '@/ui/shadcn/select';
import { TooltipContent } from '@/ui/shadcn/tooltip';
import {
  COLUMN_MENU_EDGE_GUARD_PX,
  COLUMN_MENU_TRIGGER_GAP_PX,
  COLUMN_MENU_WIDTH_PX,
} from '@/ui/layout-edit-constants';
import {
  bindLayoutColumnMenuDismissal,
  isInsideLayoutColumnMenuPath,
  useLayoutColumnMenuPosition,
} from '@/ui/hooks/use-layout-column-menu';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function portal(node: React.ReactNode, container?: HTMLElement) {
  const wrapped = <div data-portal-owner={container?.id ?? 'fallback'}>{node}</div>;
  return container ? createPortal(wrapped, container) : wrapped;
}

vi.mock('@radix-ui/react-popover', async () => {
  const React = await import('react');
  return {
    Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
    Portal: ({ container, children }: { container?: HTMLElement; children: React.ReactNode }) => portal(children, container),
    Content: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { sideOffset?: number }>((props, ref) => {
      const { sideOffset: _sideOffset, ...rest } = props;
      return <div ref={ref} data-primitive="popover" {...rest} />;
    }),
  };
});

vi.mock('@radix-ui/react-tooltip', async () => {
  const React = await import('react');
  return {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
    Portal: ({ container, children }: { container?: HTMLElement; children: React.ReactNode }) => portal(children, container),
    Content: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { sideOffset?: number }>((props, ref) => {
      const { sideOffset: _sideOffset, ...rest } = props;
      return <div ref={ref} data-primitive="tooltip" {...rest} />;
    }),
  };
});

vi.mock('@radix-ui/react-select', async () => {
  const React = await import('react');
  const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Root: passthrough,
    Group: passthrough,
    Value: passthrough,
    Portal: ({ container, children }: { container?: HTMLElement; children: React.ReactNode }) => portal(children, container),
    Trigger: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>((props, ref) => (
      <button ref={ref} type="button" {...props} />
    )),
    Content: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
      <div ref={ref} data-primitive="select" {...props} />
    )),
    Viewport: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
      <div ref={ref} {...props} />
    )),
    Item: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
      <div ref={ref} {...props} />
    )),
    ItemText: passthrough,
    ItemIndicator: passthrough,
    ScrollUpButton: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
      <div ref={ref} {...props} />
    )),
    ScrollDownButton: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
      <div ref={ref} {...props} />
    )),
    Label: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
      <div ref={ref} {...props} />
    )),
    Separator: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
      <div ref={ref} {...props} />
    )),
  };
});

const roots: Root[] = [];

function Probe({ label }: { label: string }) {
  const container = usePortalContainer();
  return <span data-label={label} data-owner={container?.id ?? 'none'} />;
}

function ColumnMenuPositionProbe({
  open,
  rootRef,
  triggerRef,
  onDismiss,
}: {
  open: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onDismiss: () => void;
}) {
  const position = useLayoutColumnMenuPosition({ open, rootRef, triggerRef, onDismiss });
  return <span data-position={position ? `${position.left}:${position.top}` : 'none'} />;
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
    const portalRoot = document.createElement('div');
    portalRoot.id = 'panel-root';
    document.body.appendChild(portalRoot);

    mount(
      <>
        <PopoverContent data-testid="popover" />
        <PortalProvider containerRef={{ current: portalRoot }}>
          <TooltipContent data-testid="tooltip" />
          <SelectContent data-testid="select">
            <SelectItem value="one">One</SelectItem>
          </SelectContent>
        </PortalProvider>
      </>,
    );

    assert.equal(document.body.querySelector('[data-testid="popover"]')?.closest('[data-portal-owner]')?.getAttribute('data-portal-owner'), 'fallback');
    assert.equal(portalRoot.querySelector('[data-testid="tooltip"]')?.closest('[data-portal-owner]')?.getAttribute('data-portal-owner'), 'panel-root');
    assert.equal(portalRoot.querySelector('[data-testid="select"]')?.closest('[data-portal-owner]')?.getAttribute('data-portal-owner'), 'panel-root');
  });

  it('positions layout column menu with panel-relative clamp and removes resize/scroll listeners', () => {
    const rootEl = document.createElement('div');
    const triggerEl = document.createElement('button');
    const rootRef: RefObject<HTMLDivElement | null> = { current: rootEl };
    const triggerRef: RefObject<HTMLButtonElement | null> = { current: triggerEl };
    const onDismiss = vi.fn();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    rootEl.getBoundingClientRect = () => ({ left: 100, top: 20, width: 260, height: 100, right: 360, bottom: 120, x: 100, y: 20, toJSON: () => {} });
    triggerEl.getBoundingClientRect = () => ({ left: 340, top: 40, width: 20, height: 20, right: 360, bottom: 60, x: 340, y: 40, toJSON: () => {} });

    const host = mount(
      <ColumnMenuPositionProbe
        open
        rootRef={rootRef}
        triggerRef={triggerRef}
        onDismiss={onDismiss}
      />,
    );

    assert.equal(
      host.querySelector('[data-position]')?.getAttribute('data-position'),
      `${260 - COLUMN_MENU_WIDTH_PX - COLUMN_MENU_EDGE_GUARD_PX}:${60 - 20 + COLUMN_MENU_TRIGGER_GAP_PX}`,
    );
    assert.equal(add.mock.calls.some(([type]) => type === 'resize'), true);
    assert.equal(add.mock.calls.some(([type]) => type === 'scroll'), true);

    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });

    assert.equal(remove.mock.calls.some(([type]) => type === 'resize'), true);
    assert.equal(remove.mock.calls.some(([type]) => type === 'scroll'), true);
  });
});
