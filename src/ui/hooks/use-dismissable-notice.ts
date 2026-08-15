import { useEffect, useState } from 'react';

/**
 * Session-local dismissal for conditional notice bars. Dismissing hides the
 * bar until the underlying condition leaves (e.g. a successful refresh), at
 * which point the dismissal resets for the next occurrence.
 */
export function useDismissableNotice(dismissable: boolean, identity?: string | null) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
  }, [dismissable, identity]);
  return {
    dismissed,
    dismiss: () => {
      if (dismissable) setDismissed(true);
    },
  };
}
