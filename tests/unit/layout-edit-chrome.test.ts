import { readFileSync } from 'node:fs';
import React, { type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLUMN_LAYOUT } from '@/ui/column-layout';
import {
  bindLayoutColumnMenuDismissal,
  isInsideLayoutColumnMenuPath,
} from '@/ui/hooks/use-column-layout-editor';

vi.mock('react-dom', () => ({
  createPortal: (node: ReactNode) => node,
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    m: {
      toolbar: {
        columnRepository: 'Repository',
        columnDescription: 'Description',
        columnLanguage: 'Language',
        columnStars: 'Stars',
        columnUpdated: 'Updated',
        columnTags: 'Tags',
        columnFavorite: 'Favorite',
        columnNotes: 'Notes',
        lockedColumn: 'Locked',
        showRepositoryOwner: 'Show repository owner',
      },
    },
  }),
}));

function elementChildren(node: ReactNode): ReactElement[] {
  if (!React.isValidElement(node)) return [];
  return React.Children.toArray(node.props.children).filter(React.isValidElement);
}

describe('layout edit chrome interactions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the column menu open after internal item clicks', async () => {
    const { LayoutColumnMenu } = await import('@/ui/components/LayoutEditChrome');
    const onSetColumnHidden = vi.fn();
    const onSetRepositoryOwnerVisible = vi.fn();

    const menu = LayoutColumnMenu({
      container: {} as HTMLElement,
      editing: true,
      open: true,
      position: { left: 0, top: 0 },
      draftLayout: DEFAULT_COLUMN_LAYOUT,
      onSetColumnHidden,
      onSetRepositoryOwnerVisible,
    });
    const buttons = elementChildren(menu);

    buttons[1].props.onClick();

    expect(onSetColumnHidden).toHaveBeenCalledTimes(1);
    expect(onSetColumnHidden).toHaveBeenCalledWith('description', true);
    expect(Object.keys(buttons[1].props)).not.toContain('onClose');

    buttons.at(-1)?.props.onClick();
    expect(onSetRepositoryOwnerVisible).toHaveBeenCalledWith(false);
  });

  it('keeps outside-click detection scoped to layout column menu islands', () => {
    class FakeElement {
      constructor(private readonly insideMenu: boolean) {}

      closest(selector: string) {
        return selector === '[data-layout-column-menu]' && this.insideMenu ? this : null;
      }
    }

    vi.stubGlobal('Element', FakeElement);

    expect(isInsideLayoutColumnMenuPath([new FakeElement(true) as unknown as EventTarget])).toBe(true);
    expect(isInsideLayoutColumnMenuPath([new FakeElement(false) as unknown as EventTarget])).toBe(false);
    expect(isInsideLayoutColumnMenuPath([new EventTarget()])).toBe(false);
  });

  it('dismisses the column menu only for outside pointerdown and Escape events', () => {
    class FakeElement {
      constructor(private readonly insideMenu: boolean) {}

      closest(selector: string) {
        return selector === '[data-layout-column-menu]' && this.insideMenu ? this : null;
      }
    }

    vi.stubGlobal('Element', FakeElement);
    const target = new EventTarget();
    const onDismiss = vi.fn();
    const cleanup = bindLayoutColumnMenuDismissal(
      target as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
      onDismiss,
    );

    const insidePointer = new Event('pointerdown');
    Object.defineProperty(insidePointer, 'composedPath', {
      value: () => [new FakeElement(true)],
    });
    target.dispatchEvent(insidePointer);

    const outsidePointer = new Event('pointerdown');
    Object.defineProperty(outsidePointer, 'composedPath', {
      value: () => [new FakeElement(false)],
    });
    target.dispatchEvent(outsidePointer);

    const enterKey = new Event('keydown');
    Object.defineProperty(enterKey, 'key', { value: 'Enter' });
    target.dispatchEvent(enterKey);

    const escapeKey = new Event('keydown');
    Object.defineProperty(escapeKey, 'key', { value: 'Escape' });
    target.dispatchEvent(escapeKey);

    cleanup();
    target.dispatchEvent(outsidePointer);

    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('uses semantic layout-edit theme colors for the edit chrome surface', () => {
    const componentSource = readFileSync('src/ui/components/LayoutEditChrome.tsx', 'utf8');
    const themeSource = readFileSync('src/ui/styles/theme.css', 'utf8');
    const tailwindSource = readFileSync('tailwind.config.js', 'utf8');

    expect(componentSource).toContain('border-layout-edit-border bg-layout-edit');
    expect(componentSource).toContain('text-layout-edit-foreground');
    expect(componentSource).toContain('bg-layout-edit-accent');

    for (const token of [
      '--layout-edit:',
      '--layout-edit-foreground:',
      '--layout-edit-border:',
      '--layout-edit-accent:',
    ]) {
      expect(themeSource.match(new RegExp(token, 'g'))?.length).toBe(2);
    }

    expect(tailwindSource).toContain("'layout-edit':");
    expect(tailwindSource).toContain("DEFAULT: 'hsl(var(--layout-edit))'");
    expect(tailwindSource).toContain("accent: 'hsl(var(--layout-edit-accent))'");
  });
});
