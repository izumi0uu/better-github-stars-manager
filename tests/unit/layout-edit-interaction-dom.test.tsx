/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutEditChrome } from '@/ui/components/LayoutEditChrome';
import {
  LayoutOverflowIndicator,
  LayoutResizeFeedbackOverlay,
  StarsTable,
} from '@/ui/components/StarsTable';
import {
  LayoutResizeSurface,
  layoutResizeOverlayFromRects,
  paintLayoutResizeLive,
  layoutViewportFromMeasurements,
} from '@/ui/layout-resize-surface';
import { RepoDetailPanel } from '@/ui/components/RepoDetailPanel';
import { DEFAULT_COLUMN_LAYOUT } from '@/ui/column-layout';
import { getMessages } from '@/i18n';
import type { Star, Tag } from '@/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function fakeStar(): Star {
  return {
    full_name: 'owner/repo',
    html_url: 'https://github.com/owner/repo',
    description: 'A repository',
    language: 'TypeScript',
    stargazers_count: 1200,
    topics: ['react'],
    archived: false,
    fork: false,
    created_at: '2024-01-01T00:00:00Z',
    pushed_at: '2024-02-01T00:00:00Z',
    starred_at: '2024-03-01T00:00:00Z',
    tombstone: false,
    synced_at: '2024-03-02T00:00:00Z',
  };
}

function fakeTag(): Tag {
  return {
    full_name: 'owner/repo',
    tags: ['ui'],
    notes: 'draft',
    mtime: '2024-03-02T00:00:00Z',
  };
}

function mount(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mountedRoots.push(root);
  return { container, root };
}

function keydown(target: Window | HTMLElement, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function pendingChromeMessage() {
  return new Promise<never>(() => {});
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`Expected ${label} button to render`);
  return button;
}

function findExactButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Expected ${label} button to render`);
  return button;
}

function findButtonByAriaLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label);
  if (!button) throw new Error(`Expected ${label} button to render`);
  return button;
}

function findNotesTextarea(): HTMLTextAreaElement {
  const textarea = document.querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Expected notes textarea to render');
  return textarea;
}

function rect({ left, top, width, height }: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('layout edit interaction lock mounted DOM behavior', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(pendingChromeMessage),
      },
    });
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots) root.unmount();
      mountedRoots.length = 0;
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('prevents drawer keyboard shortcuts while locked and while typing', () => {
    const onClose = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { root } = mount(
      <RepoDetailPanel
        star={fakeStar()}
        tag={fakeTag()}
        selectedTags={['ui']}
        onToggleTag={vi.fn()}
        onDataChanged={vi.fn()}
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev
        hasNext
        interactionLocked
      />,
    );

    act(() => {
      keydown(window, 'Escape');
      keydown(window, '[');
      keydown(window, ']');
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <RepoDetailPanel
          star={fakeStar()}
          tag={fakeTag()}
          selectedTags={['ui']}
          onToggleTag={vi.fn()}
          onDataChanged={vi.fn()}
          onClose={onClose}
          onPrev={onPrev}
          onNext={onNext}
          hasPrev
          hasNext
          interactionLocked={false}
        />,
      );
    });

    const notes = findNotesTextarea();
    act(() => {
      keydown(notes, 'Escape');
      keydown(window, 'Escape');
      keydown(window, '[');
      keydown(window, ']');
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('keeps layout edit chrome actions live except during active resize', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const onReset = vi.fn();
    const onFit = vi.fn();
    const onResetWidths = vi.fn();
    const onToggleColumnMenu = vi.fn();
    const { container, root } = mount(
      <LayoutEditChrome
        editing
        draftLayout={{ ...DEFAULT_COLUMN_LAYOUT, hidden: ['language'] }}
        resizeColumnLabel="Repository"
        layoutResize={null}
        tableWidth={864}
        panelWidth={720}
        overflowPx={144}
        hiddenTrayColumns={['language']}
        trayOpen
        trayDropReady={false}
        dropReadyLabel={null}
        editColumnsButtonRef={createRef<HTMLButtonElement>()}
        onToggleColumnMenu={onToggleColumnMenu}
        onFitWidths={onFit}
        onResetWidths={onResetWidths}
        onReset={onReset}
        onSave={onSave}
        onCancel={onCancel}
        onBeginTrayDrag={vi.fn()}
        onRestoreHiddenColumn={vi.fn()}
      />,
    );

    const save = findButton(container, 'Save');
    const cancel = findButton(container, 'Cancel');
    const reset = findExactButton(container, 'Reset');

    act(() => {
      reset.click();
      save.click();
      cancel.click();
    });

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <LayoutEditChrome
          editing
          draftLayout={{ ...DEFAULT_COLUMN_LAYOUT, hidden: ['language'] }}
          resizeColumnLabel="Repository"
          layoutResize={{ liveWidth: 248, delta: 8, atDefaultWidth: false, atMinWidth: false }}
          tableWidth={872}
          panelWidth={720}
          overflowPx={152}
          hiddenTrayColumns={['language']}
          trayOpen
          trayDropReady={false}
          dropReadyLabel={null}
          editColumnsButtonRef={createRef<HTMLButtonElement>()}
          onToggleColumnMenu={onToggleColumnMenu}
          onFitWidths={onFit}
          onResetWidths={onResetWidths}
          onReset={onReset}
          onSave={onSave}
          onCancel={onCancel}
          onBeginTrayDrag={vi.fn()}
          onRestoreHiddenColumn={vi.fn()}
        />,
      );
    });

    expect(findButton(container, 'Columns').disabled).toBe(true);
    expect(findButton(container, 'Fit width').disabled).toBe(true);
    expect(findButton(container, 'Reset widths').disabled).toBe(true);
    expect(findExactButton(container, 'Reset').disabled).toBe(true);
    expect(findButton(container, 'Save').disabled).toBe(true);
    expect(findButton(container, 'Cancel').disabled).toBe(true);
    const trayChip = container.querySelector('.gsm-tray-chip');
    expect(trayChip).toBeInstanceOf(HTMLButtonElement);
    expect((trayChip as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders resize overlay badges and overflow chip only when metrics are present', () => {
    const { container, root } = mount(
      <div className="relative">
        <LayoutResizeFeedbackOverlay
          overlay={{ top: 12, left: 24, width: 180, right: 204, defaultRight: 180, height: 240 }}
          resize={{
            defaultWidth: 156,
            liveWidth: 180,
            delta: 24,
            atDefaultWidth: false,
            snappedToDefault: false,
            atMinWidth: false,
          }}
        />
        <LayoutOverflowIndicator overflowPx={56} />
      </div>,
    );

    expect(container.querySelector('[data-layout-resize-overlay]')).not.toBeNull();
    expect(container.textContent).toContain('Default 156px');
    expect(container.textContent).toContain('180px');
    expect(container.textContent).toContain('+24px');
    expect(container.textContent).toContain('current column only');
    expect(container.querySelector<HTMLElement>('.gsm-col-hilite')?.style.top).toBe('12px');
    expect(container.querySelector<HTMLElement>('.gsm-delta-badge')?.style.top).toBe('244px');
    expect(container.querySelector('[data-layout-overflow-edge]')).not.toBeNull();
    expect(container.querySelector('[data-layout-overflow-chip]')).toBeNull();

    act(() => {
      root.render(
        <div className="relative">
          <LayoutResizeFeedbackOverlay overlay={null} resize={null} />
          <LayoutOverflowIndicator overflowPx={0} />
        </div>,
      );
    });

    expect(container.querySelector('[data-layout-resize-overlay]')).toBeNull();
    expect(container.querySelector('[data-layout-overflow-chip]')).toBeNull();
  });

  it('measures resize overlay height from the visible stage, not the virtualized shell', () => {
    const overlay = layoutResizeOverlayFromRects({
      shellRect: { left: 10, top: -120, bottom: 1880, width: 1200 },
      stageRect: { top: 80, bottom: 500 },
      activeRect: { left: 210, width: 260 },
      defaultWidth: 240,
    });

    expect(overlay).toEqual({
      top: 200,
      left: 200,
      width: 260,
      right: 460,
      defaultRight: 440,
      height: 420,
    });
  });

  it('derives overflow from the same visible stage width even without explicit table min width', () => {
    expect(layoutViewportFromMeasurements({
      panelWidth: 720,
      headerScrollWidth: 960,
      headerRectWidth: 940,
      tableMinWidth: undefined,
    })).toEqual({
      panelWidth: 720,
      tableWidth: 960,
      overflowPx: 240,
    });

    expect(layoutViewportFromMeasurements({
      panelWidth: 720,
      headerScrollWidth: 700,
      headerRectWidth: 700,
      tableMinWidth: 880,
    })).toEqual({
      panelWidth: 720,
      tableWidth: 880,
      overflowPx: 160,
    });
  });

  it('keeps resize handles visibly discoverable before hover or focus', () => {
    const utilitiesCss = readFileSync('src/ui/styles/utilities.css', 'utf8');
    const handleRule = utilitiesCss.match(/\.gsm-resize-handle::after \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const hoverRule = utilitiesCss.match(/\.gsm-resize-handle:hover::after,[\s\S]*?\n  \}/)?.[0] ?? '';

    expect(handleRule).toContain('opacity: 0.45;');
    expect(hoverRule).toContain('opacity: 1;');
  });

  it('keeps layout edit header controls accessible from keyboard', () => {
    const scrollRef = createRef<HTMLDivElement>();
    const headerRef = createRef<HTMLDivElement>();
    const onMoveColumnByKeyboard = vi.fn();
    const onResizeColumnByKeyboard = vi.fn();
    const onAutoFitColumnWidth = vi.fn();
    const m = getMessages('en');
    const { container } = mount(
      <div ref={scrollRef}>
        <StarsTable
          rows={[]}
          loading={false}
          phase="idle"
          tagsByFullName={new Map()}
          selectedTags={[]}
          selectedFullName={null}
          visibleColumns={['repository', 'description', 'favorite', 'notes']}
          gridTemplateColumns="180px 240px 28px 20px"
          tableMinWidth={468}
          interactionLocked={false}
          layoutEdit={{
            editing: true,
            faded: false,
            draggedColumnId: null,
            draggedColumnHideIntent: false,
            columnShifts: {},
            flashedColumn: null,
            trayCaretX: null,
            onBeginColumnDrag: vi.fn(),
            onMoveColumnByKeyboard,
          }}
          layoutResize={null}
          scrollRef={scrollRef}
          headerRef={headerRef}
          onSelect={vi.fn()}
          onToggleTag={vi.fn()}
          onToggleFavorite={vi.fn(async () => {})}
          onBeginColumnResize={vi.fn()}
          onResizeColumnByKeyboard={onResizeColumnByKeyboard}
          onAutoFitColumnWidth={onAutoFitColumnWidth}
        />
      </div>,
    );

    const dragRepository = findButtonByAriaLabel(
      container,
      m.toolbar.dragColumnTitle(m.toolbar.columnRepository),
    );
    const resizeRepository = findButtonByAriaLabel(
      container,
      m.toolbar.resizeColumnTitle(m.toolbar.columnRepository),
    );

    expect(dragRepository.textContent).toContain(m.toolbar.dragColumnTitle(m.toolbar.columnRepository));
    expect(resizeRepository.textContent).toContain(m.toolbar.resizeColumnTitle(m.toolbar.columnRepository));
    expect(container.querySelector(`[aria-label="${m.toolbar.dragColumnTitle(m.toolbar.columnFavorite)}"]`)).toBeNull();
    expect(container.querySelector(`[aria-label="${m.toolbar.resizeColumnTitle(m.toolbar.columnNotes)}"]`)).toBeNull();

    const dragRight = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    const dragLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    const resizeRight = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    const resizeLeftLarge = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
      shiftKey: true,
    });
    const autoFit = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    act(() => {
      dragRepository.dispatchEvent(dragRight);
      dragRepository.dispatchEvent(dragLeft);
      resizeRepository.dispatchEvent(resizeRight);
      resizeRepository.dispatchEvent(resizeLeftLarge);
      resizeRepository.dispatchEvent(autoFit);
    });

    expect(dragRight.defaultPrevented).toBe(true);
    expect(resizeRight.defaultPrevented).toBe(true);
    expect(autoFit.defaultPrevented).toBe(true);
    expect(onMoveColumnByKeyboard).toHaveBeenNthCalledWith(1, 'repository', 1);
    expect(onMoveColumnByKeyboard).toHaveBeenNthCalledWith(2, 'repository', -1);
    expect(onResizeColumnByKeyboard).toHaveBeenNthCalledWith(1, 'repository', 1, false);
    expect(onResizeColumnByKeyboard).toHaveBeenNthCalledWith(2, 'repository', -1, true);
    expect(onAutoFitColumnWidth).toHaveBeenCalledWith('repository');
  });


  it('paints resize moves from cached surface geometry without per-move DOM reads or row queries', () => {
    const panelRoot = document.createElement('div');
    const shell = document.createElement('div');
    const stage = document.createElement('div');
    const header = document.createElement('div');
    const row = document.createElement('div');
    const activeCell = document.createElement('span');
    const readout = document.createElement('span');
    const hilite = document.createElement('span');
    const rail = document.createElement('span');
    const refGuide = document.createElement('span');
    const liveGuide = document.createElement('span');
    const pxBadge = document.createElement('span');
    const deltaBadge = document.createElement('span');
    activeCell.dataset.headerCol = 'repository';
    readout.dataset.layoutWidthReadout = '';
    row.dataset.layoutRowGrid = '';
    hilite.className = 'gsm-col-hilite';
    rail.className = 'gsm-stable-rail';
    refGuide.className = 'gsm-guide-v gsm-guide-v-ref';
    liveGuide.className = 'gsm-guide-v';
    pxBadge.className = 'gsm-px-badge';
    deltaBadge.className = 'gsm-delta-badge';
    header.append(activeCell);
    shell.append(header, row, hilite, rail, refGuide, liveGuide, pxBadge, deltaBadge);
    panelRoot.append(readout, shell);
    document.body.append(panelRoot, stage);

    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    const shellRect = vi.fn(() => rect({ left: 10, top: 0, width: 500, height: 420 }));
    const stageRect = vi.fn(() => rect({ left: 10, top: 20, width: 300, height: 220 }));
    const cellRect = vi.fn(() => rect({ left: 22, top: 0, width: 240, height: 28 }));
    shell.getBoundingClientRect = shellRect;
    stage.getBoundingClientRect = stageRect;
    activeCell.getBoundingClientRect = cellRect;
    const rowQuery = vi.spyOn(shell, 'querySelectorAll');

    const surface = new LayoutResizeSurface();
    surface.configure({
      visibleColumns: ['repository', 'description', 'language'],
      tableShell: shell,
      readoutRoot: panelRoot,
      header,
      stage,
      m: getMessages('en'),
    });
    surface.measureStart({
      id: 'repository',
      pointerId: 1,
      startX: 100,
      startWidth: 240,
      defaultWidth: 240,
      minWidth: 180,
      frozenWidths: { repository: 240, description: 280, language: 80 },
      liveWidths: { repository: 240, description: 280, language: 80 },
      liveWidth: 240,
      delta: 0,
      snappedToDefault: false,
      atDefaultWidth: true,
      atMinWidth: false,
    });
    surface.refreshLiveNodes();
    shellRect.mockClear();
    stageRect.mockClear();
    cellRect.mockClear();
    rowQuery.mockClear();

    surface.paint({
      id: 'repository',
      pointerId: 1,
      startX: 100,
      startWidth: 240,
      defaultWidth: 240,
      minWidth: 180,
      frozenWidths: { repository: 240, description: 280, language: 80 },
      liveWidths: { repository: 320, description: 280, language: 80 },
      liveWidth: 320,
      delta: 80,
      snappedToDefault: false,
      atDefaultWidth: false,
      atMinWidth: false,
    });

    expect(shellRect).not.toHaveBeenCalled();
    expect(stageRect).not.toHaveBeenCalled();
    expect(cellRect).not.toHaveBeenCalled();
    expect(rowQuery).not.toHaveBeenCalled();
    expect(row.style.gridTemplateColumns).toBe('320px 280px 80px');
    expect(liveGuide.style.left).toBe('332px');
    expect(readout.textContent).toContain('Repository 320px');
  });



  it('keeps cancel baseline stable when geometry is refreshed after live paint', () => {
    const shell = document.createElement('div');
    const stage = document.createElement('div');
    const header = document.createElement('div');
    const row = document.createElement('div');
    const activeCell = document.createElement('span');
    activeCell.dataset.headerCol = 'repository';
    row.dataset.layoutRowGrid = '';
    header.style.gridTemplateColumns = '240px 280px 80px';
    header.style.minWidth = '624px';
    row.style.gridTemplateColumns = '240px 280px 80px';
    row.style.minWidth = '624px';
    header.append(activeCell);
    shell.append(header, row);
    document.body.append(shell, stage);

    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    const rowQuery = vi.spyOn(shell, 'querySelectorAll');
    shell.getBoundingClientRect = vi.fn(() => rect({ left: 10, top: 0, width: 500, height: 420 }));
    stage.getBoundingClientRect = vi.fn(() => rect({ left: 10, top: 20, width: 300, height: 220 }));
    activeCell.getBoundingClientRect = vi.fn(() => rect({ left: 22, top: 0, width: 320, height: 28 }));

    const resize = {
      id: 'repository' as const,
      pointerId: 1,
      startX: 100,
      startWidth: 240,
      defaultWidth: 240,
      minWidth: 180,
      frozenWidths: { repository: 240, description: 280, language: 80 },
      liveWidths: { repository: 320, description: 280, language: 80 },
      liveWidth: 320,
      delta: 80,
      snappedToDefault: false,
      atDefaultWidth: false,
      atMinWidth: false,
    };

    const surface = new LayoutResizeSurface();
    surface.configure({
      visibleColumns: ['repository', 'description', 'language'],
      tableShell: shell,
      readoutRoot: null,
      header,
      stage,
      m: getMessages('en'),
    });
    surface.measureStart(resize);
    rowQuery.mockClear();
    surface.paint(resize);
    expect(header.style.gridTemplateColumns).toBe('320px 280px 80px');

    surface.refreshGeometry(resize);
    expect(rowQuery).not.toHaveBeenCalled();

    surface.cleanup('cancel');
    expect(header.style.gridTemplateColumns).toBe('240px 280px 80px');
    expect(header.style.minWidth).toBe('624px');
    expect(row.style.gridTemplateColumns).toBe('240px 280px 80px');
    expect(row.style.minWidth).toBe('624px');
  });

  it('refreshes newly visible row grids only on explicit virtualization invalidation', () => {
    const shell = document.createElement('div');
    const stage = document.createElement('div');
    const header = document.createElement('div');
    const rowA = document.createElement('div');
    const rowB = document.createElement('div');
    const activeCell = document.createElement('span');
    activeCell.dataset.headerCol = 'repository';
    rowA.dataset.layoutRowGrid = '';
    rowB.dataset.layoutRowGrid = '';
    header.append(activeCell);
    shell.append(header, rowA);
    document.body.append(shell, stage);

    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    shell.getBoundingClientRect = vi.fn(() => rect({ left: 10, top: 0, width: 500, height: 420 }));
    stage.getBoundingClientRect = vi.fn(() => rect({ left: 10, top: 20, width: 300, height: 220 }));
    activeCell.getBoundingClientRect = vi.fn(() => rect({ left: 22, top: 0, width: 240, height: 28 }));

    const surface = new LayoutResizeSurface();
    surface.configure({
      visibleColumns: ['repository', 'description', 'language'],
      tableShell: shell,
      readoutRoot: null,
      header,
      stage,
      m: getMessages('en'),
    });
    const resize = {
      id: 'repository' as const,
      pointerId: 1,
      startX: 100,
      startWidth: 240,
      defaultWidth: 240,
      minWidth: 180,
      frozenWidths: { repository: 240, description: 280, language: 80 },
      liveWidths: { repository: 320, description: 280, language: 80 },
      liveWidth: 320,
      delta: 80,
      snappedToDefault: false,
      atDefaultWidth: false,
      atMinWidth: false,
    };
    surface.measureStart(resize);
    surface.paint(resize);
    expect(rowA.style.gridTemplateColumns).toBe('320px 280px 80px');
    expect(rowB.style.gridTemplateColumns).toBe('');

    shell.append(rowB);
    surface.refreshVisibleRows();

    expect(rowB.style.gridTemplateColumns).toBe('320px 280px 80px');
    expect(rowB.style.minWidth).toBe(rowA.style.minWidth);
  });

  it('paints live resize metrics through the DOM without requiring a React render per pointer move', () => {
    const panelRoot = document.createElement('div');
    const shell = document.createElement('div');
    const stage = document.createElement('div');
    const header = document.createElement('div');
    const row = document.createElement('div');
    const activeCell = document.createElement('span');
    const readout = document.createElement('span');
    const hilite = document.createElement('span');
    const rail = document.createElement('span');
    const refGuide = document.createElement('span');
    const liveGuide = document.createElement('span');
    const pxBadge = document.createElement('span');
    const deltaBadge = document.createElement('span');
    activeCell.dataset.headerCol = 'repository';
    readout.dataset.layoutWidthReadout = '';
    row.dataset.layoutRowGrid = '';
    hilite.className = 'gsm-col-hilite';
    rail.className = 'gsm-stable-rail';
    refGuide.className = 'gsm-guide-v gsm-guide-v-ref';
    liveGuide.className = 'gsm-guide-v';
    pxBadge.className = 'gsm-px-badge';
    deltaBadge.className = 'gsm-delta-badge';
    header.append(activeCell);
    shell.append(header, row, hilite, rail, refGuide, liveGuide, pxBadge, deltaBadge);
    panelRoot.append(readout, shell);
    document.body.append(panelRoot, stage);

    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    shell.getBoundingClientRect = vi.fn(() => rect({ left: 10, top: 0, width: 500, height: 420 }));
    stage.getBoundingClientRect = vi.fn(() => rect({ left: 10, top: 20, width: 300, height: 220 }));
    activeCell.getBoundingClientRect = vi.fn(() => rect({ left: 22, top: 0, width: 320, height: 28 }));

    paintLayoutResizeLive({
      resize: {
        id: 'repository',
        pointerId: 1,
        startX: 100,
        startWidth: 240,
        defaultWidth: 240,
        minWidth: 180,
        frozenWidths: { repository: 240, description: 280, language: 80 },
        liveWidths: { repository: 320, description: 280, language: 80 },
        liveWidth: 320,
        delta: 80,
        snappedToDefault: false,
        atDefaultWidth: false,
        atMinWidth: false,
      },
      visibleColumns: ['repository', 'description', 'language'],
      tableShell: shell,
      readoutRoot: panelRoot,
      header,
      stage,
      m: getMessages('en'),
    });

    expect(header.style.gridTemplateColumns).toBe('320px 280px 80px');
    expect(row.style.gridTemplateColumns).toBe('320px 280px 80px');
    expect(header.style.minWidth).toBe(row.style.minWidth);
    expect(hilite.style.left).toBe('12px');
    expect(liveGuide.style.left).toBe('332px');
    expect(pxBadge.textContent).toBe('320px');
    expect(deltaBadge.textContent).toContain('+80px');
    expect(readout.textContent).toContain('Repository 320px');

    expect(shell.querySelector('[data-layout-live-overflow-edge]')).not.toBeNull();
    expect(shell.querySelector('[data-layout-live-overflow-chip]')).toBeNull();

    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 900 });
    paintLayoutResizeLive({
      resize: {
        id: 'repository',
        pointerId: 1,
        startX: 100,
        startWidth: 240,
        defaultWidth: 240,
        minWidth: 180,
        frozenWidths: { repository: 240, description: 280, language: 80 },
        liveWidths: { repository: 240, description: 280, language: 80 },
        liveWidth: 240,
        delta: 0,
        snappedToDefault: false,
        atDefaultWidth: true,
        atMinWidth: false,
      },
      visibleColumns: ['repository', 'description', 'language'],
      tableShell: shell,
      readoutRoot: panelRoot,
      header,
      stage,
      m: getMessages('en'),
    });

    expect(shell.querySelector('[data-layout-live-overflow-edge]')).toBeNull();
    expect(shell.querySelector('[data-layout-live-overflow-chip]')).toBeNull();
  });
});
