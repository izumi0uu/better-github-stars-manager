import { cn } from '@/lib/utils';

/**
 * Success checkmark shown briefly inside a toolbar action button after it
 * succeeds (spinner → ✓ → fallback). A bare themed icon: the path "draws" via
 * the .success-check-path stroke-dashoffset animation (see styles.css), so the
 * tick appears to be drawn rather than just fading in. Uses currentColor (no
 * forced text-* class) so it inherits the button's contrasting text color:
 * primary-foreground on the primary Sync button, foreground on ghost buttons.
 * Forcing text-primary collided with bg-primary and made the tick invisible.
 */
function SuccessCheck({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <svg
      role="status"
      aria-label="Done"
      viewBox="0 0 24 24"
      fill="none"
      className={cn('size-4', className)}
      {...props}
    >
      <path
        className="success-check-path"
        d="M4 12L10 18L20 6"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export { SuccessCheck };
