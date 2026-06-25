import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * key={phase} remounts children so mount-triggered animations (e.g.
 * SuccessCheck stroke draw) replay on each state change; .gsm-action-icon-in
 * provides the fade-in transition.
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
