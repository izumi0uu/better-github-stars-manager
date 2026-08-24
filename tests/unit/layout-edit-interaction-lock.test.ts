import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('layout edit interaction lock invariants', () => {
  it('derives the lock from edit mode and passes it to every non-editor region', () => {
    // Child locked rendering (inert/disabled) is covered behaviorally by
    // layout-edit-interaction-render.test.tsx; no suite mounts ManagerWorkspace,
    // so the app-level wiring that turns edit mode into the lock is asserted here.
    const source = read('src/ui/ManagerWorkspace.tsx');

    expect(source).toMatch(/const\s+interactionLocked\s*=\s*editingLayout;/);
    expect(source).toContain('layoutEditing={editingLayout}');
    expect(source.match(/<StarsTable[\s\S]*?\/>/)?.[0] ?? '').toContain('interactionLocked={interactionLocked}');
    expect(source.match(/<FilterSidebar[\s\S]*?\/>/)?.[0] ?? '').toContain('interactionLocked={interactionLocked}');
    expect(source).toMatch(/<ActiveFilterChips[\s\S]*?interactionLocked=\{interactionLocked\}[\s\S]*?\/>/);
    expect(source).toMatch(/<FloatingLocaleToggle[\s\S]*?interactionLocked=\{interactionLocked\}[\s\S]*?\/>/);
    expect(source.match(/<RepoDetailPanel[\s\S]*?\/>/)?.[0] ?? '').toContain('interactionLocked={interactionLocked}');
  });

  it('clears the selected repo and unstar popover when layout editing begins', () => {
    // Interaction invariant: entering edit mode must not leave the detail drawer
    // or unstar popover open over the editor. No behavioral suite mounts
    // ManagerWorkspace, so the effect wiring is asserted directly.
    const source = read('src/ui/ManagerWorkspace.tsx');

    expect(source).toMatch(
      /useLayoutEffect\([\s\S]*?if \(!editingLayout\) return;[\s\S]*?setSelected\(null\);[\s\S]*?closeUnstarPopover\(\);/,
    );
  });

  it('replays the helper-text flash motion on every update', () => {
    // jsdom cannot run CSS animations, so the animation contract is asserted as
    // CSS structure plus the remount key that replays it per update. Helper text
    // content and dismiss behavior are covered by manager-panel-unstar and
    // manager-sidebar-tag-message tests.
    const source = read('src/ui/ManagerWorkspace.tsx');
    const motion = read('src/ui/styles/motion.css');

    expect(source).toContain('key={helperInfoKey(displayedInfo, unstarFeedback)}');
    expect(source).toContain('gsm-helper-text-update');
    expect(motion).toContain('.gsm-helper-text-update');
    expect(motion).toContain('gsm-flash-col var(--gsm-duration-flash) var(--gsm-ease-linearized) var(--gsm-delay-flash);');
  });

  it('keeps the active-filter row mounted while collapsing it when no filters are selected', () => {
    // The row must stay mounted (aria-hidden) so the grid-rows collapse can
    // animate; jsdom cannot measure grid-template-rows, so the collapse CSS is
    // asserted structurally.
    const source = read('src/ui/ManagerWorkspace.tsx');
    const motion = read('src/ui/styles/motion.css');

    expect(source).toContain("className={cn('gsm-active-filter-row', { open: hasActiveFilter })}");
    expect(source).toContain('aria-hidden={!hasActiveFilter}');
    expect(source).toContain('{...getLockedRegionProps(!hasActiveFilter)}');
    expect(motion).toContain('.gsm-active-filter-row');
    expect(motion).toContain('grid-template-rows: 0fr;');
    expect(motion).toContain('pointer-events: none;');
    expect(motion).toContain('.gsm-active-filter-row.open');
    expect(motion).toContain('border-bottom-width: 1px;');
    expect(motion).toContain('pointer-events: auto;');
  });

  it('animates browse/edit mode as one table-shell transition without grid-track motion', () => {
    // The transition phase lifecycle is covered behaviorally by
    // layout-editor-config-sync.test.tsx; this keeps the CSS contract that the
    // shell animates opacity/transform only — never grid-template-columns or a
    // blanket `transition: all` — plus the attribute the selectors key on.
    const table = read('src/ui/components/StarsTable.tsx');
    const motion = read('src/ui/styles/motion.css');
    const transitionGridRule = motion.match(
      /\.gsm-layout-table-shell\[data-layout-mode-transition='entering'\] \.gsm-layout-grid\s*\{([^}]*)\}/,
    )?.[1] ?? '';
    const layoutGridRule = motion.match(/\.gsm-layout-grid\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(table).toContain('data-layout-mode-transition={layoutModeTransitionPhase}');
    expect(motion).toContain(".gsm-layout-table-shell[data-layout-mode-transition='pre-enter']");
    expect(motion).toContain('@keyframes gsm-layout-mode-table-enter');
    expect(motion).toContain('animation: gsm-layout-mode-table-enter var(--gsm-table-opacity-duration) var(--gsm-ease-enter) both;');
    expect(transitionGridRule).not.toContain('grid-template-columns');
    expect(transitionGridRule).not.toMatch(/transition:\s*all/);
    expect(layoutGridRule).not.toContain('grid-template-columns');
    expect(layoutGridRule).not.toMatch(/transition:\s*all/);
  });

  it('disables row-grid transitions while column resizing is active', () => {
    // Perf invariant: live column resize must not animate row grids. jsdom cannot
    // prove which properties a browser transitions, so the body-scoped rule is
    // asserted structurally: the row-grid selector must sit in the rule whose
    // declaration overrides transition-property to none.
    const motion = read('src/ui/styles/motion.css');
    const rowGridResizeRule = motion.match(
      /body\.gsm-resizing-column\s*\[data-layout-row-grid\][\s\S]*?\{([^}]*)\}/,
    )?.[1] ?? '';

    expect(motion).toContain('body.gsm-resizing-column [data-layout-row-grid]');
    expect(rowGridResizeRule).toContain('transition-property: none !important;');
  });

  it('locks the filter sidebar and row actions without teaching them a provider', () => {
    // ActiveFilterChips and FloatingLocaleToggle locked rendering is covered by
    // layout-edit-interaction-render.test.tsx; FilterSidebar and StarRow have no
    // behavioral suite rendering them locked, so their wiring is asserted here.
    expect(read('src/ui/components/FilterSidebar.tsx')).toContain('getLockedRegionProps(interactionLocked)');
    expect(read('src/ui/components/StarRow.tsx')).toContain('busy={favoriteBusy || interactionLocked}');
  });
});
