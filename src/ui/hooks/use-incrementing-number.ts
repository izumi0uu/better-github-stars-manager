import { useEffect, useState } from 'react';

const DEFAULT_INCREMENT_INTERVAL_MS = 60;

export function useIncrementingNumber(
  target: number,
  enabled: boolean,
  intervalMs = DEFAULT_INCREMENT_INTERVAL_MS,
): number {
  const [value, setValue] = useState(target);

  useEffect(() => {
    if (!enabled || target < value) {
      setValue(target);
      return;
    }
    if (value >= target) return;
    const timer = window.setTimeout(() => {
      setValue((current) => Math.min(target, current + 1));
    }, intervalMs);
    return () => window.clearTimeout(timer);
  }, [enabled, intervalMs, target, value]);

  return value;
}
