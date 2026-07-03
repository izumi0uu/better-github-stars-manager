import { type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Columns3, EyeOff, GripVertical, RotateCcw, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/shadcn/button';
import {
  COLUMN_DEFS,
  COLUMN_IDS,
  type ColumnId,
  type ColumnLayout,
} from '@/ui/column-layout';
import { LAYOUT_EDIT_CSS_VARS } from '@/ui/layout-edit-constants';

export type LayoutDragGhostState = {
  label: string;
  hint: string;
  x: number;
  y: number;
  hideIntent: boolean;
};

export function LayoutColumnMenu({
  container,
  editing,
  open,
  position,
  draftLayout,
  onSetColumnHidden,
  onClose,
}: {
  container: HTMLElement | null;
  editing: boolean;
  open: boolean;
  position: { left: number; top: number } | null;
  draftLayout: ColumnLayout;
  onSetColumnHidden: (id: ColumnId, hidden: boolean) => void;
  onClose: () => void;
}) {
  const { m } = useI18n();
  if (!editing || !open || !position || !container) return null;

  return createPortal(
    <div
      role="menu"
      data-layout-column-menu
      className="gsm-z-layout-popover absolute rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={{
        left: position.left,
        top: position.top,
        width: `var(--gsm-column-menu-width, ${LAYOUT_EDIT_CSS_VARS.columnMenuWidth})`,
      }}
    >
      {COLUMN_IDS.map((id) => {
        const def = COLUMN_DEFS[id];
        const label = def.label(m);
        const checked = !draftLayout.hidden.includes(id);
        return (
          <button
            key={id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={checked}
            disabled={def.locked}
            onClick={() => {
              onSetColumnHidden(id, checked);
              onClose();
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-default disabled:opacity-55',
              { 'text-foreground': checked },
            )}
          >
            <span className={cn('grid size-3.5 place-items-center rounded border border-border', { 'bg-primary text-primary-foreground': checked })}>
              {checked && <Check className="size-3" />}
            </span>
            <span className="flex-1 truncate">{label}</span>
            {def.locked && <span className="gsm-muted-count">{m.toolbar.lockedColumn}</span>}
          </button>
        );
      })}
    </div>,
    container,
  );
}

export function LayoutEditChrome({
  editing,
  draftLayout,
  hiddenTrayColumns,
  trayOpen,
  trayDropReady,
  dropReadyLabel,
  editColumnsButtonRef,
  onToggleColumnMenu,
  onReset,
  onSave,
  onCancel,
  onBeginTrayDrag,
  onRestoreHiddenColumn,
}: {
  editing: boolean;
  draftLayout: ColumnLayout;
  hiddenTrayColumns: ColumnId[];
  trayOpen: boolean;
  trayDropReady: boolean;
  dropReadyLabel: string | null;
  editColumnsButtonRef: RefObject<HTMLButtonElement>;
  onToggleColumnMenu: () => void;
  onReset: () => void;
  onSave: () => void;
  onCancel: () => void;
  onBeginTrayDrag: (e: ReactPointerEvent<HTMLElement>, id: ColumnId) => void;
  onRestoreHiddenColumn: (id: ColumnId) => void;
}) {
  const { m } = useI18n();

  return (
    <div
      className={cn('gsm-edit-chrome-wrap', { open: editing })}
      aria-hidden={!editing}
    >
      <div>
        <div className="flex flex-wrap items-center gap-2 border-b border-primary bg-primary/10 px-3 py-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <span className="gsm-edit-dot size-2 rounded-full bg-primary" />
            {m.toolbar.editingLayout}
          </span>
          <div className="relative" data-layout-column-menu>
            <Button
              ref={editColumnsButtonRef}
              variant="ghost"
              size="sm"
              disabled={!editing}
              onClick={onToggleColumnMenu}
              title={m.toolbar.columnsButtonTitle}
            >
              <Columns3 className="size-3.5" data-icon="inline-start" />
              {m.toolbar.columnsButton}
              {draftLayout.hidden.length > 0 && (
                <span className="gsm-muted-count ml-0.5 rounded-full bg-muted px-1.5 py-0.5 tabular-nums">
                  {draftLayout.hidden.length}
                </span>
              )}
            </Button>
          </div>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" disabled={!editing} onClick={onReset}>
            <RotateCcw className="size-3.5" data-icon="inline-start" />
            {m.toolbar.resetLayout}
          </Button>
          <Button size="sm" disabled={!editing} onClick={onSave}>
            <Check className="size-3.5" data-icon="inline-start" />
            {m.common.save}
          </Button>
          <Button variant="outline" size="sm" disabled={!editing} onClick={onCancel}>
            <X className="size-3.5" data-icon="inline-start" />
            {m.common.cancel}
          </Button>
        </div>
        <div className={cn('gsm-tray-zone', { open: trayOpen })}>
          <div>
            <div
              className={cn(
                'flex min-h-9 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground',
                { 'gsm-tray-drop-ready bg-destructive/10 text-destructive': trayDropReady },
              )}
            >
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <EyeOff className="size-3.5" />
                {m.toolbar.hiddenColumns(draftLayout.hidden.length)}
              </span>
              {trayDropReady ? (
                <span className="font-semibold text-destructive">{dropReadyLabel}</span>
              ) : (
                hiddenTrayColumns.map((id) => {
                  const label = COLUMN_DEFS[id].label(m);
                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={!editing}
                      onPointerDown={(e) => onBeginTrayDrag(e, id)}
                      onClick={() => onRestoreHiddenColumn(id)}
                      title={m.toolbar.restoreColumn(label)}
                      className="gsm-tray-chip gsm-helper-text gsm-touch-target inline-flex h-6 touch-none items-center gap-1 rounded-full border border-dashed border-muted-foreground/45 bg-background px-2 transition-colors hover:border-primary hover:border-solid hover:bg-accent hover:text-foreground disabled:pointer-events-none"
                    >
                      <EyeOff className="size-3" />
                      {label}
                      <span className="gsm-muted-count opacity-60">+</span>
                    </button>
                  );
                })
              )}
              {!trayDropReady && <span className="gsm-muted-count ml-auto">{m.toolbar.hiddenColumnsTip}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LayoutDragGhost({ ghost }: { ghost: LayoutDragGhostState | null }) {
  if (!ghost) return null;

  return (
    <div
      className="gsm-drag-ghost"
      data-hide={ghost.hideIntent ? 'true' : 'false'}
      style={{ left: ghost.x, top: ghost.y }}
    >
      <GripVertical className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{ghost.label}</span>
      <span className="gsm-drag-ghost-hint">{ghost.hint}</span>
    </div>
  );
}
