import { useCallback, useEffect, useRef } from 'react';

export function useDelayedHoverIntent({
  enabled,
  delayMs,
  onOpen,
  onClose,
}: {
  enabled: boolean;
  delayMs: number;
  onOpen: () => void;
  onClose: () => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);

  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  const clear = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const openLater = useCallback(() => {
    if (!enabled) return;
    clear();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onOpenRef.current();
    }, delayMs);
  }, [clear, delayMs, enabled]);

  const close = useCallback(() => {
    clear();
    onCloseRef.current();
  }, [clear]);

  useEffect(() => {
    if (!enabled) {
      clear();
      onCloseRef.current();
    }
  }, [clear, enabled]);

  useEffect(() => clear, [clear]);

  return {
    onMouseEnter: openLater,
    onMouseLeave: close,
    onFocus: openLater,
    onBlur: close,
    clear,
  };
}
