import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Heart, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/shadcn/button';
import cubbyStaticUrl from '@/ui/assets/index-agent-static.png?url';
import cubbyWorkingUrl from '@/ui/assets/index-agent-working.gif?url';

const HEART_INDICES = [0, 1, 2, 3, 4] as const;
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function rootActiveElement(node: HTMLElement | null): Element | null {
  const root = node?.getRootNode();
  if (root instanceof Document || root instanceof ShadowRoot) return root.activeElement;
  return document.activeElement;
}

function supportsHeartPreview(event: ReactPointerEvent<HTMLElement>): boolean {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return false;
  return typeof window.matchMedia !== 'function'
    || window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export function StoreRatingPrompt({
  open,
  storeLabel,
  ratingUrl,
  onRate,
  onLater,
  onNever,
}: {
  open: boolean;
  storeLabel: string;
  ratingUrl: string;
  onRate: () => void;
  onLater: () => void;
  onNever: () => void;
}) {
  const { m } = useI18n();
  const [hoveredHeart, setHoveredHeart] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const ratingLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (!open) {
      setHoveredHeart(0);
      return;
    }
    const activeElement = rootActiveElement(dialogRef.current);
    const restoreFocus = activeElement instanceof HTMLElement ? activeElement : null;
    ratingLinkRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onLater();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      const current = rootActiveElement(dialogRef.current);
      if (!first || !last) return;
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      restoreFocus?.focus();
    };
  }, [onLater, open]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-[calc(var(--gsm-z-overlay)+1)] grid items-end justify-items-end bg-background/35 p-3 sm:p-5"
      data-testid="store-rating-prompt"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gsm-store-rating-title"
        aria-describedby="gsm-store-rating-description gsm-store-rating-note"
        className="relative w-full max-w-[380px] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
      >
        <button
          type="button"
          onClick={onLater}
          aria-label={m.common.close}
          className="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
        >
          <X className="size-4" aria-hidden="true" />
        </button>

        <div className="flex items-start gap-3 pr-8">
          <picture className="block size-12 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
            <source
              media="(prefers-reduced-motion: reduce)"
              srcSet={cubbyStaticUrl}
            />
            <img
              src={cubbyWorkingUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="block size-full object-cover [image-rendering:pixelated]"
            />
          </picture>
          <div className="min-w-0">
            <h2 id="gsm-store-rating-title" className="text-sm font-semibold leading-snug">
              {m.manager.storeRatingPromptTitle}
            </h2>
            <p
              id="gsm-store-rating-description"
              className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground"
            >
              {m.manager.storeRatingPromptBody}
            </p>
          </div>
        </div>

        <a
          ref={ratingLinkRef}
          href={ratingUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={m.manager.storeRatingPromptLinkLabel(storeLabel)}
          className="mt-4 flex w-full flex-col items-center gap-2 rounded-lg border border-favorite/25 bg-favorite/5 px-4 py-3 outline-none transition-colors hover:border-favorite/45 hover:bg-favorite/10 focus-visible:ring-2 focus-visible:ring-favorite focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
          data-testid="store-rating-link"
          onClick={onRate}
          onPointerLeave={() => setHoveredHeart(0)}
        >
          <span className="flex items-center gap-1.5" aria-hidden="true">
            {HEART_INDICES.map((index) => {
              const active = index < hoveredHeart;
              return (
                <span
                  key={index}
                  data-heart-index={index + 1}
                  data-active={active ? 'true' : 'false'}
                  className="inline-flex"
                  onPointerEnter={(event) => {
                    if (supportsHeartPreview(event)) setHoveredHeart(index + 1);
                  }}
                >
                  <Heart
                    className={cn(
                      'size-7 transition-colors motion-reduce:transition-none',
                      {
                        'fill-current text-favorite duration-0': active,
                        'text-muted-foreground/40 [transition-duration:var(--gsm-duration-fast)]': !active,
                      },
                    )}
                  />
                </span>
              );
            })}
          </span>
          <span
            id="gsm-store-rating-note"
            className="text-center text-xs font-medium text-foreground"
          >
            {m.manager.storeRatingPromptStoreNote(storeLabel)}
          </span>
        </a>

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onNever}>
            {m.manager.storeRatingPromptNever}
          </Button>
          <Button variant="outline" onClick={onLater}>
            {m.manager.storeRatingPromptLater}
          </Button>
        </div>
      </div>
    </div>
  );
}
