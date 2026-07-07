import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('layout edit interaction lock invariants', () => {
  it('keeps the lock owned locally by ManagerPanel and passes it to non-editor regions', () => {
    const source = read('src/ui/ManagerPanel.tsx');

    expect(source).toMatch(/const\s+interactionLocked\s*=\s*editingLayout;/);
    expect(source).toMatch(/useLayoutEffect\(\(\)\s*=>\s*\{\s*if \(!editingLayout\) return;\s*setSelected\(null\);\s*\}, \[editingLayout\]\);/);
    expect(source).toMatch(/shouldIgnorePanelShortcut\(interactionLocked,\s*e\.target\)/);
    expect(source).toMatch(/<ActiveFilterChips[\s\S]*?interactionLocked=\{interactionLocked\}[\s\S]*?\/>/);
    expect(source).toMatch(/<FloatingLocaleToggle[\s\S]*?interactionLocked=\{interactionLocked\}[\s\S]*?\/>/);
    expect(source).toMatch(/disabled=\{actionBusy\s*\|\|\s*interactionLocked\}/);
  });

  it('keeps the active-filter row mounted while collapsing it when no filters are selected', () => {
    const source = read('src/ui/ManagerPanel.tsx');
    const chips = read('src/ui/components/ActiveFilterChips.tsx');
    const motion = read('src/ui/styles/motion.css');

    expect(source).toContain("className={cn('gsm-active-filter-row', { open: hasActiveFilter })}");
    expect(source).toContain('aria-hidden={!hasActiveFilter}');
    expect(source).toContain('{...getLockedRegionProps(!hasActiveFilter)}');
    expect(source).toMatch(/<ActiveFilterChips\b[\s\S]*?\bf=\{f\}[\s\S]*?\bcount=\{total\}[\s\S]*?\binteractionLocked=\{interactionLocked\}[\s\S]*?\/>/);
    expect(source).not.toContain('{hasActiveFilter && (');
    expect(chips).not.toContain('if (active.length === 0) return null;');
    expect(motion).toContain('.gsm-active-filter-row');
    expect(motion).toContain('grid-template-rows: 0fr;');
    expect(motion).toContain('pointer-events: none;');
    expect(motion).toContain('.gsm-active-filter-row.open');
    expect(motion).toContain('border-bottom-width: 1px;');
    expect(motion).toContain('pointer-events: auto;');
  });

  it('uses semantic inert/anchor helpers instead of a global provider', () => {
    const helper = read('src/ui/interaction-lock.ts');
    const manager = read('src/ui/ManagerPanel.tsx');

    expect(helper).toContain('getLockedRegionProps');
    expect(helper).toContain("inert: ''");
    expect(helper).toContain('getLockedAnchorProps');
    expect(helper).toContain('tabIndex: -1');
    expect(helper).toContain('event.preventDefault();');
    expect(manager).not.toContain('InteractionLockProvider');
  });

  it('locks mixed toolbar controls while keeping layout edit chrome outside the lock', () => {
    const source = read('src/ui/components/Toolbar.tsx');

    expect(source).toContain("import { getLockedAnchorProps } from '@/ui/interaction-lock';");
    expect(source).toContain('disabled={layoutEditing}');
    expect(source).toContain('disabled={actionBusy || layoutEditing}');
    expect(source).toContain('{...getLockedAnchorProps(layoutEditing)}');
    expect(source).toContain('if (layoutEditing) return;');
    expect(source).toContain('{layoutEditChrome}');
  });

  it('keeps pencil edit as a single callback while ManagerPanel wires custom edit semantics', () => {
    const toolbar = read('src/ui/components/Toolbar.tsx');
    const manager = read('src/ui/ManagerPanel.tsx');
    const table = read('src/ui/components/StarsTable.tsx');
    const hook = read('src/ui/hooks/use-column-layout-editor.ts');

    expect(toolbar).toMatch(/onClick=\{onStartLayoutEdit\}/);
    expect(toolbar).not.toMatch(/onLayoutModeChange\('custom'\);\s*onStartLayoutEdit/);
    expect(manager).toMatch(/beginCustomLayoutEdit,/);
    expect(manager).toMatch(/onStartLayoutEdit=\{beginCustomLayoutEdit\}/);
    expect(manager).toMatch(/<StarsTable\b/);
    expect(table).toContain('BROWSE_LAYOUT_TABLE_OPACITY_MS');
    expect(table).toContain('data-table-head');
    expect(table).toContain('data-table-head-sentinel');
    expect(table).not.toContain('cloneElement');
    expect(hook).toMatch(/const\s+beginCustomLayoutEdit\s*=\s*\(\)\s*=>\s*\{/);
    expect(hook).toMatch(/if\s*\(!configLoaded\.current\)\s*return;/);
    expect(hook).toMatch(/preEditMode\.current\s*=\s*layoutMode;/);
    expect(hook).toContain('reportLayoutPersistenceFailure');
    expect(hook).not.toContain("authStore.update({ columnLayoutMode: edit.layoutMode })");
  });

  it('keeps storage echoes from owning the rendered browse layout after hydration', () => {
    const hook = read('src/ui/hooks/use-column-layout-editor.ts');

    expect(hook).toMatch(/const\s+configSynced\s*=\s*useRef\(false\);/);
    expect(hook).toMatch(/const\s+configLoaded\s*=\s*useRef\(false\);/);
    expect(hook).toMatch(/const\s+isFirstConfigSync\s*=\s*!configSynced\.current;/);
    expect(hook).toMatch(/if\s*\(options\.hydrate\s*&&\s*!isFirstConfigSync\)\s*return;/);
    expect(hook).toContain('options: { hydrate: boolean }');
    expect(hook).toContain('const shouldHydrateBrowseLayout = options.hydrate && isFirstConfigSync && !editingLayoutRef.current;');
    expect(hook).toContain('configSynced.current = true;');
    expect(hook).toContain('configLoaded.current = true;');
    expect(hook).toContain('setLayoutConfigReady(true);');
    expect(hook).toContain('setLayoutEditReady(true);');
    expect(hook).toContain('authStore.getConfig().then((config) => applyConfig(config, { hydrate: true }))');
    expect(hook).toContain('applyConfig(changes[CONFIG_STORAGE_KEY].newValue, { hydrate: false });');
    expect(hook).toMatch(/if \(shouldHydrateBrowseLayout\) \{\s+setRenderedBrowseLayout\(cloneColumnLayout\(nextBrowseLayout\)\);\s+setLayoutFaded\(false\);\s+\}/);
  });

  it('keeps numeric right alignment limited to default browse layout', () => {
    const manager = read('src/ui/ManagerPanel.tsx');
    const table = read('src/ui/components/StarsTable.tsx');
    const row = read('src/ui/components/StarRow.tsx');

    expect(manager).toMatch(/const\s+customColumnLayoutActive\s*=\s*editingLayout\s*\|\|\s*layoutMode\s*===\s*'custom'\s*\|\|\s*previewingCustomLayout;/);
    expect(table).toContain("'justify-end text-right': def.align === 'end' && !customColumnLayoutActive");
    expect(table).toContain('starColumnAlignStart={customColumnLayoutActive}');
    expect(table).not.toContain("'justify-end pr-3 text-right': def.align === 'end'");
    expect(row).toContain("'justify-start': starColumnAlignStart");
    expect(row).toContain("'justify-end': !starColumnAlignStart");
    expect(row).not.toContain("'justify-start': interactionLocked");
  });

  it('documents the numeric column custom-layout alignment invariant in the frontend skill', () => {
    const skill = read('.codex/skills/github-stars-frontend/SKILL.md');

    expect(skill).toContain('Numeric columns may be right-aligned only in the default browse layout.');
    expect(skill).toContain('editing, saved custom mode, and custom hover preview');
    expect(skill).toContain('Do not drive editable/custom header or row alignment directly from `COLUMN_DEFS[id].align`;');
  });

  it('disables row-grid transitions while column resizing is active', () => {
    const motion = read('src/ui/styles/motion.css');

    expect(motion).toContain('body.gsm-resizing-column [data-layout-row-grid]');
  });

  it('locks sibling regions and row-level actions without teaching them a provider', () => {
    for (const path of [
      'src/ui/components/ActiveFilterChips.tsx',
      'src/ui/components/FilterSidebar.tsx',
      'src/ui/components/FloatingLocaleToggle.tsx',
      'src/ui/components/StarRow.tsx',
    ]) {
      const source = read(path);
      expect(source).toContain('interactionLocked');
    }

    expect(read('src/ui/components/ActiveFilterChips.tsx')).toContain('getLockedRegionProps(interactionLocked)');
    expect(read('src/ui/components/FilterSidebar.tsx')).toContain('getLockedRegionProps(interactionLocked)');
    expect(read('src/ui/components/FloatingLocaleToggle.tsx')).toContain('getLockedRegionProps(interactionLocked)');
    expect(read('src/ui/components/StarRow.tsx')).toContain('busy={favoriteBusy || interactionLocked}');
  });

  it('prevents drawer keyboard and external-link escape hatches while preserving the mounted drawer', () => {
    const source = read('src/ui/components/RepoDetailPanel.tsx');

    expect(source).toContain('shouldIgnorePanelShortcut(interactionLocked, e.target)');
    expect(source).toContain('[onClose, onPrev, onNext, hasPrev, hasNext, interactionLocked]');
    expect(source).toContain('getLockedRegionProps(interactionLocked)');
    expect(source).toContain('getLockedAnchorProps(interactionLocked)');
    expect(source).toContain('disabled={!hasPrev || interactionLocked}');
    expect(source).toContain('disabled={interactionLocked}');
  });
});
