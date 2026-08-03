import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  beginCustomLayoutEditTransition,
  COLUMN_DEFS,
  columnShiftTransforms,
  completeBrowseLayoutTransition,
  clearColumnWidths,
  DEFAULT_COLUMN_LAYOUT,
  browseLayoutTransition,
  dragInsertIndex,
  fitColumnWidthsToContainer,
  gridTemplateFor,
  hiddenColumnIdsInCanonicalOrder,
  hideColumn,
  INITIAL_CUSTOM_COLUMN_LAYOUT,
  isColumnHideIntent,
  layoutsEqual,
  moveColumn,
  normalizeColumnLayout,
  normalizeColumnLayoutMode,
  normalizeStoredColumnLayoutPreference,
  resizeSnapshot,
  restoreColumn,
  tableMinWidthFor,
  trayInsertIndex,
  visibleColumnIds,
  widthsFromRects,
  type ColumnRect,
} from '@/ui/column-layout';
import {
  BROWSE_LAYOUT_FADE_DELAY_MS,
  BROWSE_LAYOUT_TABLE_OPACITY_MS,
  COLUMN_GAP_PX,
  COLUMN_HIDE_INTENT_DISTANCE_PX,
  COLUMN_MENU_WIDTH_PX,
  LAYOUT_EDIT_CSS_VARS,
  LAYOUT_MODE_TABLE_PREPARE_MS,
  LAYOUT_MODE_TABLE_TRANSITION_MS,
  LAYOUT_PREVIEW_HOVER_DELAY_MS,
  RESTORE_FLASH_ANIMATION_MS,
  RESTORE_FLASH_DELAY_MS,
  RESTORE_FLASH_DURATION_MS,
  TRAY_RESTORE_HEADER_BUFFER_PX,
} from '@/ui/layout-edit-constants';
import { messageFor } from '@/i18n';

describe('column layout editing', () => {
  const rects: ColumnRect[] = [
    { id: 'repository', left: 0, width: 180, mid: 90 },
    { id: 'description', left: 188, width: 220, mid: 298 },
    { id: 'language', left: 416, width: 80, mid: 456 },
    { id: 'starAction', left: 504, width: 32, mid: 520 },
    { id: 'favorite', left: 544, width: 28, mid: 558 },
    { id: 'notes', left: 580, width: 20, mid: 590 },
  ];

  it('starts custom layout equivalent to default until the user saves a change', () => {
    expect(INITIAL_CUSTOM_COLUMN_LAYOUT).toEqual(DEFAULT_COLUMN_LAYOUT);
  });

  it('registers repository creation time as an unlocked layout column', () => {
    expect(DEFAULT_COLUMN_LAYOUT.order).toEqual([
      'repository',
      'description',
      'language',
      'stars',
      'updated',
      'created',
      'tags',
      'starAction',
      'favorite',
      'notes',
    ]);
    expect(COLUMN_DEFS.created.locked).toBeUndefined();
    expect(COLUMN_DEFS.created.label(messageFor('en'))).toBe('Created');
    expect(COLUMN_DEFS.created.label(messageFor('zh-CN'))).toBe('创建');
  });

  it('keeps layout edit interaction constants explicit and reusable', () => {
    expect(LAYOUT_PREVIEW_HOVER_DELAY_MS).toBeGreaterThan(BROWSE_LAYOUT_FADE_DELAY_MS);
    expect(BROWSE_LAYOUT_TABLE_OPACITY_MS).toBe(160);
    expect(LAYOUT_MODE_TABLE_PREPARE_MS).toBe(32);
    expect(LAYOUT_MODE_TABLE_TRANSITION_MS).toBe(180);
    expect(TRAY_RESTORE_HEADER_BUFFER_PX).toBeLessThan(COLUMN_HIDE_INTENT_DISTANCE_PX);
    expect(COLUMN_MENU_WIDTH_PX).toBe(208);
    expect(LAYOUT_EDIT_CSS_VARS.columnMenuWidth).toBe(`${COLUMN_MENU_WIDTH_PX}px`);
  });

  it('keeps restore flash JS timing aligned with the CSS animation timeline', () => {
    expect(RESTORE_FLASH_DURATION_MS).toBe(RESTORE_FLASH_ANIMATION_MS + RESTORE_FLASH_DELAY_MS);
    expect(LAYOUT_EDIT_CSS_VARS.restoreFlashAnimation).toBe(`${RESTORE_FLASH_ANIMATION_MS}ms`);
    expect(LAYOUT_EDIT_CSS_VARS.restoreFlashDelay).toBe(`${RESTORE_FLASH_DELAY_MS}ms`);
  });

  it('keeps layout edit CSS variables aligned with TypeScript constants', () => {
    const themeCss = readFileSync('src/ui/styles/theme.css', 'utf8');
    const motionCss = readFileSync('src/ui/styles/motion.css', 'utf8');

    expect(themeCss).toContain(`--gsm-column-menu-width: ${LAYOUT_EDIT_CSS_VARS.columnMenuWidth};`);
    expect(themeCss).toContain(`--gsm-duration-flash: ${LAYOUT_EDIT_CSS_VARS.restoreFlashAnimation};`);
    expect(themeCss).toContain(`--gsm-delay-flash: ${LAYOUT_EDIT_CSS_VARS.restoreFlashDelay};`);
    expect(motionCss).toContain('animation: gsm-flash-col var(--gsm-duration-flash) var(--gsm-ease-linearized) var(--gsm-delay-flash);');
  });

  it('keeps shared UI utility tokens available to popup, options, and shadow-root UI', () => {
    const themeCss = readFileSync('src/ui/styles/theme.css', 'utf8');
    const motionCss = readFileSync('src/ui/styles/motion.css', 'utf8');
    const utilitiesCss = readFileSync('src/ui/styles/utilities.css', 'utf8');

    for (const token of [
      '--gsm-z-sticky: 10;',
      '--gsm-z-floating: 20;',
      '--gsm-z-preview: 30;',
      '--gsm-z-overlay: 50;',
      '--gsm-z-popover: 50;',
      '--gsm-z-layout-popover: 70;',
      '--gsm-z-drag-ghost: 80;',
    ]) {
      expect(themeCss).toContain(token);
    }

    expect(motionCss).toContain('z-index: var(--gsm-z-drag-ghost);');

    for (const utility of [
      '.gsm-z-sticky',
      '.gsm-z-floating',
      '.gsm-z-preview',
      '.gsm-z-overlay',
      '.gsm-z-popover',
      '.gsm-z-layout-popover',
      '.gsm-meta-label',
      '.gsm-helper-text',
      '.gsm-muted-count',
      '.gsm-muted-count-soft',
      '.gsm-progress-count',
      '.gsm-inline-progress-count',
    ]) {
      expect(utilitiesCss).toContain(utility);
    }
  });

  it('normalizes stored layout preferences and drops invalid or locked hidden columns', () => {
    const stored = normalizeStoredColumnLayoutPreference({
      order: ['tags', 'missing', 'repository', 'tags'],
      hidden: ['favorite', 'description', 'description', 'missing'],
    });

    expect(stored).toEqual({
      order: ['tags', 'repository', 'description', 'language', 'stars', 'updated', 'created', 'starAction', 'favorite', 'notes'],
      hidden: ['description'],
    });
  });

  it('normalizes old saved layouts by inserting created before locked action columns', () => {
    expect(normalizeColumnLayout({
      order: ['repository', 'description', 'language', 'stars', 'updated', 'tags', 'favorite', 'notes'],
      hidden: [],
    }).order).toEqual([
      'repository',
      'description',
      'language',
      'stars',
      'updated',
      'tags',
      'created',
      'starAction',
      'favorite',
      'notes',
    ]);
  });

  it('stores default-equivalent custom layout as null', () => {
    expect(normalizeStoredColumnLayoutPreference(DEFAULT_COLUMN_LAYOUT)).toBeNull();
  });

  it('keeps default order and hidden as custom when explicit widths exist', () => {
    expect(normalizeStoredColumnLayoutPreference({
      ...DEFAULT_COLUMN_LAYOUT,
      widths: { repository: 260 },
    })).toEqual({
      ...DEFAULT_COLUMN_LAYOUT,
      widths: { repository: 260 },
    });
  });

  it('normalizes widths while preserving old order-and-hidden-only layouts', () => {
    expect(normalizeColumnLayout({
      ...DEFAULT_COLUMN_LAYOUT,
      widths: {
        repository: 260,
        description: Number.NaN,
        favorite: 300,
        tags: -1,
        language: 20,
      },
    })).toEqual({
      ...DEFAULT_COLUMN_LAYOUT,
      widths: {
        repository: 260,
        language: 64,
      },
    });

    expect(normalizeStoredColumnLayoutPreference({
      ...DEFAULT_COLUMN_LAYOUT,
      hidden: ['language'],
    })).toEqual({
      ...DEFAULT_COLUMN_LAYOUT,
      hidden: ['language'],
    });
  });

  it('normalizes layout mode and duplicate hidden ids', () => {
    expect(normalizeColumnLayoutMode('custom')).toBe('custom');
    expect(normalizeColumnLayoutMode('wat')).toBe('default');
    expect(normalizeColumnLayout({
      order: [...DEFAULT_COLUMN_LAYOUT.order],
      hidden: ['tags', 'tags', 'notes'],
    }).hidden).toEqual(['tags']);
  });

  it('hides and restores unlocked columns without removing locked action columns', () => {
    const hidden = hideColumn(DEFAULT_COLUMN_LAYOUT, 'description');

    expect(visibleColumnIds(hidden)).not.toContain('description');
    expect(visibleColumnIds(hidden).slice(-3)).toEqual(['starAction', 'favorite', 'notes']);

    const restored = restoreColumn(hidden, 'description');

    expect(visibleColumnIds(restored)).toEqual(DEFAULT_COLUMN_LAYOUT.order);
  });

  it('preserves explicit hidden column widths through hide and restore', () => {
    const layout = normalizeColumnLayout({
      ...DEFAULT_COLUMN_LAYOUT,
      widths: { description: 240, tags: 180 },
    });
    const hidden = hideColumn(layout, 'description');
    const restored = restoreColumn(hidden, 'description');

    expect(hidden.widths?.description).toBe(240);
    expect(restored.widths?.description).toBe(240);
    expect(visibleColumnIds(restored)).toEqual(DEFAULT_COLUMN_LAYOUT.order);
  });

  it('lists hidden tray columns in canonical order rather than hide order', () => {
    const hidden = hideColumn(hideColumn(hideColumn(hideColumn(DEFAULT_COLUMN_LAYOUT, 'tags'), 'created'), 'description'), 'language');

    expect(hidden.hidden).toEqual(['tags', 'created', 'description', 'language']);
    expect(hiddenColumnIdsInCanonicalOrder(hidden)).toEqual(['description', 'language', 'created', 'tags']);
  });

  it('keeps locked columns at the end when reordering', () => {
    const moved = moveColumn(DEFAULT_COLUMN_LAYOUT, 'language', DEFAULT_COLUMN_LAYOUT.order.length);

    expect(visibleColumnIds(moved).slice(-4)).toEqual(['language', 'starAction', 'favorite', 'notes']);
  });

  it('restores tray columns at an explicit insertion point before locked columns', () => {
    const hidden = hideColumn(DEFAULT_COLUMN_LAYOUT, 'tags');
    const restored = restoreColumn(hidden, 'tags', 1);

    expect(visibleColumnIds(restored).slice(0, 3)).toEqual(['repository', 'tags', 'description']);
    expect(visibleColumnIds(restored).slice(-3)).toEqual(['starAction', 'favorite', 'notes']);
  });

  it('detects drag-out hide intent only beyond the configured header boundary', () => {
    expect(isColumnHideIntent(188 + COLUMN_HIDE_INTENT_DISTANCE_PX - 1, 100, 188)).toBe(false);
    expect(isColumnHideIntent(188 + COLUMN_HIDE_INTENT_DISTANCE_PX + 1, 100, 188)).toBe(true);
    expect(isColumnHideIntent(100 - COLUMN_HIDE_INTENT_DISTANCE_PX - 1, 100, 188)).toBe(true);
  });

  it('clamps header and tray insertion before locked columns', () => {
    expect(dragInsertIndex(rects, 'language', 900)).toBe(2);
    expect(trayInsertIndex(rects, 900)).toBe(3);
  });

  it('computes live transform shifts for sibling columns while dragging', () => {
    const shifts = columnShiftTransforms(rects, 'language', 0, COLUMN_GAP_PX);

    expect(shifts.repository).toBe(88);
    expect(shifts.description).toBe(88);
    expect(shifts.starAction).toBeUndefined();
    expect(shifts.favorite).toBeUndefined();
    expect(shifts.notes).toBeUndefined();
  });

  it('builds px grid templates, full snapshots, and shared min width from measured columns', () => {
    const fullRects: ColumnRect[] = [
      { id: 'repository', left: 0, width: 180, mid: 90 },
      { id: 'description', left: 188, width: 220, mid: 298 },
      { id: 'language', left: 416, width: 80, mid: 456 },
      { id: 'stars', left: 504, width: 64, mid: 536 },
      { id: 'updated', left: 576, width: 84, mid: 618 },
      { id: 'created', left: 668, width: 84, mid: 710 },
      { id: 'tags', left: 760, width: 160, mid: 840 },
      { id: 'starAction', left: 928, width: 32, mid: 944 },
      { id: 'favorite', left: 968, width: 28, mid: 982 },
      { id: 'notes', left: 1004, width: 20, mid: 1014 },
    ];
    const snapshot = widthsFromRects(fullRects);
    const layout = normalizeColumnLayout({ ...DEFAULT_COLUMN_LAYOUT, widths: snapshot });

    expect(snapshot).toEqual({
      repository: 180,
      description: 220,
      language: 80,
      stars: 64,
      updated: 84,
      created: 84,
      tags: 160,
    });
    expect(gridTemplateFor(layout)).toContain('180px 220px 80px');
    expect(tableMinWidthFor(layout)).toBe(180 + 220 + 80 + 64 + 84 + 84 + 160 + 32 + 28 + 20 + 24 + 9 * COLUMN_GAP_PX);
  });

  it('resizes a frozen snapshot by changing only the active column', () => {
    const snapshot = widthsFromRects(rects);
    const resized = resizeSnapshot(snapshot, 'description', 40);

    expect(resized).toEqual({
      ...snapshot,
      description: 260,
    });
  });

  it('resets widths without changing order or hidden state and includes widths in equality', () => {
    const layout = hideColumn(moveColumn({
      ...DEFAULT_COLUMN_LAYOUT,
      widths: { repository: 260, description: 220 },
    }, 'tags', 1), 'language');
    const cleared = clearColumnWidths(layout);

    expect(cleared.order).toEqual(layout.order);
    expect(cleared.hidden).toEqual(layout.hidden);
    expect(cleared.widths).toBeUndefined();
    expect(layoutsEqual(DEFAULT_COLUMN_LAYOUT, { ...DEFAULT_COLUMN_LAYOUT, widths: { repository: 260 } })).toBe(false);
  });

  it('fits an explicit snapshot to the panel by shrinking modified unlocked columns only', () => {
    const layout = normalizeColumnLayout({
      ...DEFAULT_COLUMN_LAYOUT,
      widths: {
        repository: 300,
        description: 300,
        language: 80,
        stars: 64,
        updated: 84,
        created: 84,
        tags: 200,
      },
    });
    const minWidth = tableMinWidthFor(layout);
    expect(minWidth).toBeDefined();

    const fitted = fitColumnWidthsToContainer(layout, minWidth! - 100);
    expect(tableMinWidthFor(fitted)).toBeLessThanOrEqual(minWidth! - 99);
    expect(fitted.widths?.repository).toBeLessThan(300);
    expect(fitted.widths?.description).toBeLessThan(300);
    expect(fitted.widths?.language).toBe(80);
  });

  it('settles the browse transition without leaving the table faded when layouts already match', () => {
    const transition = browseLayoutTransition(DEFAULT_COLUMN_LAYOUT, DEFAULT_COLUMN_LAYOUT, {
      editing: false,
      prefersReducedMotion: false,
    });

    expect(transition).toEqual({ kind: 'settled' });
  });

  it('settles without a second fade when applying an already-previewed custom layout', () => {
    const customLayout = hideColumn(DEFAULT_COLUMN_LAYOUT, 'description');
    const transition = browseLayoutTransition(customLayout, customLayout, {
      editing: false,
      prefersReducedMotion: false,
    });

    expect(transition).toEqual({ kind: 'settled' });
  });

  it('switches browse layout instantly when reduced motion is enabled', () => {
    const target = hideColumn(DEFAULT_COLUMN_LAYOUT, 'description');
    const transition = browseLayoutTransition(target, DEFAULT_COLUMN_LAYOUT, {
      editing: false,
      prefersReducedMotion: true,
    });

    expect(transition).toEqual({ kind: 'instant', renderedLayout: target });
    if (transition.kind === 'instant') {
      expect(transition.renderedLayout).not.toBe(target);
    }
  });

  it('uses a fade for browse layout changes and completes with opacity restored', () => {
    const target = hideColumn(DEFAULT_COLUMN_LAYOUT, 'description');
    const transition = browseLayoutTransition(target, DEFAULT_COLUMN_LAYOUT, {
      editing: false,
      prefersReducedMotion: false,
    });
    const completed = completeBrowseLayoutTransition(target);

    expect(transition).toEqual({ kind: 'fade', delayMs: BROWSE_LAYOUT_FADE_DELAY_MS });
    expect(completed).toEqual({ renderedLayout: target, faded: false });
    expect(completed.renderedLayout).not.toBe(target);
  });

  it('ignores browse layout transitions while editing owns the rendered layout', () => {
    const target = hideColumn(DEFAULT_COLUMN_LAYOUT, 'description');
    const transition = browseLayoutTransition(target, DEFAULT_COLUMN_LAYOUT, {
      editing: true,
      prefersReducedMotion: false,
    });

    expect(transition).toEqual({ kind: 'idle' });
  });

  it('prepares pencil edit as an immediate custom-layout edit transition', () => {
    const customLayout = hideColumn(moveColumn(DEFAULT_COLUMN_LAYOUT, 'tags', 1), 'description');
    const transition = beginCustomLayoutEditTransition(customLayout);

    expect(transition).toEqual({
      layoutMode: 'custom',
      preEditMode: 'custom',
      draftLayout: customLayout,
      renderedLayout: customLayout,
      previewingCustomLayout: false,
      layoutFaded: false,
      editingLayout: true,
    });
    expect(transition.draftLayout).not.toBe(customLayout);
    expect(transition.renderedLayout).not.toBe(customLayout);
    expect(transition.renderedLayout).not.toBe(transition.draftLayout);
  });
});
