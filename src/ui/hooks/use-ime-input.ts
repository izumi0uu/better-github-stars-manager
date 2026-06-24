import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CompositionEvent } from 'react';

type ImeTextControl = HTMLInputElement | HTMLTextAreaElement;
type CompositionAwareEvent = { nativeEvent?: unknown };

export function isImeComposing(event?: CompositionAwareEvent | null): boolean {
  if (!event || typeof event.nativeEvent !== 'object' || event.nativeEvent === null) {
    return false;
  }
  return Boolean(
    'isComposing' in event.nativeEvent &&
      (event.nativeEvent as { isComposing?: boolean }).isComposing,
  );
}

export function shouldIgnoreImeAction(
  event?: CompositionAwareEvent | null,
  composingRef?: { current: boolean },
): boolean {
  return Boolean(composingRef?.current) || isImeComposing(event);
}

export function useImeBufferedInput(
  value: string,
  onCommit?: (value: string) => void,
) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    if (!composingRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    setDraft(next);
    onCommit?.(next);
  };

  const handleChange = (event: ChangeEvent<ImeTextControl>) => {
    const next = event.target.value;
    setDraft(next);
    if (!composingRef.current && !isImeComposing(event)) onCommit?.(next);
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = (event: CompositionEvent<ImeTextControl>) => {
    composingRef.current = false;
    const next = event.currentTarget.value;
    setDraft(next);
    onCommit?.(next);
  };

  return {
    value: draft,
    commit,
    composingRef,
    inputProps: {
      value: draft,
      onChange: handleChange,
      onCompositionStart: handleCompositionStart,
      onCompositionEnd: handleCompositionEnd,
    },
  };
}
