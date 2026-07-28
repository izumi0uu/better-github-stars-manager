import { useCallback, useEffect, useRef } from 'react';

/**
 * Delayed hover open/close intent.
 * Use a non-zero closeDelayMs when the target UI is portaled (Radix Popover)
 * so the pointer can cross the trigger→content gap without snapping shut.
 */
export function useDelayedHoverIntent({
  enabled,
  delayMs,
  closeDelayMs = 0,
  onOpen,
  onClose,
}: {
  enabled: boolean;
  delayMs: number;
  /** Grace period before close; bridges portaled popovers. Default 0. */
  closeDelayMs?: number;
  onOpen: () => void;
  onClose: () => void;
}) {
  const timerIdRef = useRef<number | null>(null);
  const pendingKindRef = useRef<'open' | 'close' | null>(null);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);

  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  const clear = useCallback(() => {
    if (timerIdRef.current == null) return;
    window.clearTimeout(timerIdRef.current);
    timerIdRef.current = null;
    pendingKindRef.current = null;
  }, []);

  const schedule = useCallback((kind: 'open' | 'close', ms: number, run: () => void) => {
    clear();
    pendingKindRef.current = kind;
    timerIdRef.current = window.setTimeout(() => {
      timerIdRef.current = null;
      pendingKindRef.current = null;
      run();
    }, ms);
  }, [clear]);

  const openLater = useCallback(() => {
    if (!enabled) return;
    // Re-entering during a pending close cancels the close immediately and
    // keeps/reopens without another open delay (classic hover bridge).
    if (pendingKindRef.current === 'close') {
      clear();
      onOpenRef.current();
      return;
    }
    schedule('open', delayMs, () => onOpenRef.current());
  }, [clear, delayMs, enabled, schedule]);

  const closeLater = useCallback(() => {
    if (closeDelayMs <= 0) {
      clear();
      onCloseRef.current();
      return;
    }
    schedule('close', closeDelayMs, () => onCloseRef.current());
  }, [clear, closeDelayMs, schedule]);

  useEffect(() => {
    if (!enabled) {
      clear();
      onCloseRef.current();
    }
  }, [clear, enabled]);

  useEffect(() => clear, [clear]);

  return {
    onMouseEnter: openLater,
    onMouseLeave: closeLater,
    onFocus: openLater,
    onBlur: closeLater,
    clear,
  };
}
