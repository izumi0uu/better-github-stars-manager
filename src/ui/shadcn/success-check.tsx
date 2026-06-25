import { cn } from '@/lib/utils';

/**
 * Success checkmark: path stroke-dashoffset draw animation; uses currentColor to
 * inherit the button text color (a forced text-* would clash with the bg and hide the tick).
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
