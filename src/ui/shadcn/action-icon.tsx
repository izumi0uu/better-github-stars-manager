import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Single-slot icon that animates on state change. `phase` is a string identity
 * of the current visual state (e.g. 'idle' | 'busy' | 'ok', or a sort direction,
 * or 'confirm'). Whenever `phase` changes, React remounts the child (because of
 * `key={phase}`), so any mount-triggered animation inside it — notably
 * `SuccessCheck`'s stroke-draw — replays every time. A short fade+scale-in
 * (`.gsm-action-icon-in`) softens the swap into a gentle transition.
 *
 * This replaces the earlier crossfade approach (IconSwap), which overlaid the
 * outgoing icon as a second absolutely-positioned layer. That layer fought the
 * success-check's own draw animation (two unsynchronized timelines → "flashes
 * twice") and, because it reused the same ReactNode, prevented the draw from
 * replaying on repeat successes. One mounted layer + key remount is simpler and
 * correct: the old icon just unmounts (instant, imperceptible at this size) and
 * the new one fades in.
 *
 * For static icon swaps (sort arrow, theme sun/moon, delete Trash2↔Check) the
 * fade-in alone reads as a clean morph; for the success check, the draw replays.
 * The fade is opacity-only — no scale — so different-shaped swaps (trash↔check)
 * don't read as squeezed/stretched (see styles.css .gsm-action-icon-in).
 */
function ActionIcon({ phase, children, className }: { phase: string; children: ReactNode; className?: string }) {
  return (
    <span
      key={phase}
      className={cn('gsm-action-icon-in inline-flex items-center justify-center', className)}
    >
      {children}
    </span>
  );
}

export { ActionIcon };
