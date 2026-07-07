import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import {
  COLUMN_MENU_EDGE_GUARD_PX,
  COLUMN_MENU_TRIGGER_GAP_PX,
  COLUMN_MENU_WIDTH_PX,
} from '@/ui/layout-edit-constants';

export function isInsideLayoutColumnMenuPath(path: readonly EventTarget[]) {
  return path.some((node) => (
    node instanceof Element &&
    node.closest('[data-layout-column-menu]') !== null
  ));
}

export function bindLayoutColumnMenuDismissal(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  onDismiss: () => void,
) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onDismiss();
  };
  const onPointerDown = (e: PointerEvent) => {
    if (isInsideLayoutColumnMenuPath(e.composedPath())) return;
    onDismiss();
  };

  target.addEventListener('keydown', onKey);
  target.addEventListener('pointerdown', onPointerDown);

  return () => {
    target.removeEventListener('keydown', onKey);
    target.removeEventListener('pointerdown', onPointerDown);
  };
}

export function useLayoutColumnMenuPosition({
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
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    return bindLayoutColumnMenuDismissal(window, onDismiss);
  }, [onDismiss, open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const root = rootRef.current;
      const trigger = triggerRef.current;
      if (!root || !trigger) return;
      const rootRect = root.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      setPosition({
        left: Math.max(
          COLUMN_MENU_EDGE_GUARD_PX,
          Math.min(
            triggerRect.left - rootRect.left,
            rootRect.width - COLUMN_MENU_WIDTH_PX - COLUMN_MENU_EDGE_GUARD_PX,
          ),
        ),
        top: triggerRect.bottom - rootRect.top + COLUMN_MENU_TRIGGER_GAP_PX,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, rootRef, triggerRef]);

  return position;
}
