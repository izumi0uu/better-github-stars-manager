import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type SurfaceWorkCanvasVariant = 'watch' | 'following' | 'following-feed';

interface SurfaceWorkCanvasProps extends HTMLAttributes<HTMLDivElement> {
  variant: SurfaceWorkCanvasVariant;
}

/** Keeps activity surfaces readable on ultrawide screens without constraining the app shell. */
export function SurfaceWorkCanvas({
  variant,
  className,
  ...props
}: SurfaceWorkCanvasProps) {
  return (
    <div
      {...props}
      data-surface-work-canvas={variant}
      className={cn('mx-auto w-full min-w-0', {
        'max-w-[var(--gsm-surface-canvas-watch)]': variant === 'watch',
        'max-w-[var(--gsm-surface-canvas-following)]': variant === 'following',
        'max-w-[var(--gsm-surface-canvas-following-feed)]': variant === 'following-feed',
      }, className)}
    />
  );
}
