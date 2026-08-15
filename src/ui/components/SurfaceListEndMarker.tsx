import { cn } from '@/lib/utils';

interface SurfaceListEndMarkerProps {
  text: string;
  tone?: 'muted' | 'info' | 'warning';
  variant?: 'plain' | 'timeline';
}

/** Static data-boundary marker; never replaces an empty or error state. */
export function SurfaceListEndMarker({
  text,
  tone = 'muted',
  variant = 'plain',
}: SurfaceListEndMarkerProps) {
  return (
    <div
      data-surface-list-end={variant}
      data-surface-list-end-tone={tone}
      className={cn('min-w-0 font-mono text-[10px] tabular-nums', {
        'flex min-h-8 items-center justify-center px-3 py-2 text-center': variant === 'plain',
        'flex min-h-7 items-center gap-2': variant === 'timeline',
        'text-muted-foreground': tone === 'muted',
        'text-info': tone === 'info',
        'text-warning': tone === 'warning',
      })}
    >
      {variant === 'timeline' && (
        <span className="relative z-10 flex w-[15px] shrink-0 justify-center bg-background" aria-hidden="true">
          <span className={cn('size-[6px] rounded-full border bg-background ring-[2.5px] ring-background', {
            'border-muted-foreground/45': tone === 'muted',
            'border-info/60': tone === 'info',
            'border-warning/70': tone === 'warning',
          })} />
        </span>
      )}
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}
