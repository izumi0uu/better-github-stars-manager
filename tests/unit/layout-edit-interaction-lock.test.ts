import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('layout edit interaction lock invariants', () => {
  it('keeps the lock owned locally by ManagerPanel and passes it to non-editor regions', () => {
    const source = read('src/ui/ManagerPanel.tsx');

    expect(source).toContain('const interactionLocked = editingLayout;');
    expect(source).toContain('shouldIgnorePanelShortcut(interactionLocked, e.target)');
    expect(source).toContain('<ActiveFilterChips f={f} count={total} interactionLocked={interactionLocked} />');
    expect(source).toContain('interactionLocked={interactionLocked}');
    expect(source).toContain('<FloatingLocaleToggle drawerOpen={!!selectedStar} interactionLocked={interactionLocked} />');
    expect(source).toContain('disabled={actionBusy || interactionLocked}');
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
