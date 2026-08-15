import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  managerSurfaceFromNavigation,
  type ManagerSurface,
} from '@/ui/manager-surface';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const SURFACE_COUNT_BADGE_CLASS = 'inline-grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none tabular-nums text-primary-foreground';

type ManagerSurfaceTabsProps = {
  surface: ManagerSurface;
  watchUnreadCount: number;
  radarUnseenCount: number;
  disabled: boolean;
  onSurfaceChange: (surface: ManagerSurface) => void;
};

export const ManagerSurfaceTabs = memo(function ManagerSurfaceTabs({
  surface,
  watchUnreadCount,
  radarUnseenCount,
  disabled,
  onSurfaceChange,
}: ManagerSurfaceTabsProps) {
  const { m } = useI18n();
  const starsTabRef = useRef<HTMLButtonElement | null>(null);
  const watchTabRef = useRef<HTMLButtonElement | null>(null);
  const radarTabRef = useRef<HTMLButtonElement | null>(null);
  const [surfaceIndicator, setSurfaceIndicator] = useState({ left: 0, width: 0 });
  const starsSurface = surface === 'stars';
  const watchSurface = surface === 'watch';

  useIsomorphicLayoutEffect(() => {
    const tabRefs: Record<ManagerSurface, RefObject<HTMLButtonElement | null>> = {
      stars: starsTabRef,
      watch: watchTabRef,
      radar: radarTabRef,
    };
    const activeTab = tabRefs[surface].current;
    if (!activeTab) return;
    const updateIndicator = () => {
      setSurfaceIndicator({ left: activeTab.offsetLeft, width: activeTab.offsetWidth });
    };
    updateIndicator();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateIndicator);
    for (const tabRef of Object.values(tabRefs)) {
      if (tabRef.current) observer.observe(tabRef.current);
    }
    return () => observer.disconnect();
  }, [radarUnseenCount, surface, watchUnreadCount]);

  const handleSurfaceKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: ManagerSurface,
  ) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = managerSurfaceFromNavigation(
      current,
      event.key as 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
    );
    onSurfaceChange(next);
    const target: Record<ManagerSurface, HTMLButtonElement | null> = {
      stars: starsTabRef.current,
      watch: watchTabRef.current,
      radar: radarTabRef.current,
    };
    target[next]?.focus();
  };

  return (
    <div
      className="relative flex h-[52px] shrink-0 self-stretch max-[768px]:hidden"
      role="tablist"
      aria-label={m.manager.surfaceNavigation}
      data-coach-target="surface-tabs"
    >
      <button
        ref={starsTabRef}
        id="gsm-stars-surface-tab"
        type="button"
        role="tab"
        aria-selected={starsSurface}
        aria-controls="gsm-stars-surface-panel"
        tabIndex={starsSurface ? 0 : -1}
        disabled={disabled}
        onKeyDown={(event) => handleSurfaceKeyDown(event, 'stars')}
        onClick={() => onSurfaceChange('stars')}
        className={cn('relative inline-flex h-full items-center gap-1 px-1 text-[12px] font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring min-[1025px]:gap-1.5 min-[1025px]:px-3 min-[1025px]:text-[13px]', {
          'text-foreground': starsSurface,
        })}
      >
        {m.watch.starsSurface}
      </button>
      <button
        ref={watchTabRef}
        id="gsm-watch-surface-tab"
        type="button"
        role="tab"
        aria-selected={watchSurface}
        aria-controls="gsm-watch-surface-panel"
        aria-label={watchUnreadCount > 0
          ? m.watch.watchSurfaceUnread(watchUnreadCount)
          : m.watch.watchSurface}
        tabIndex={watchSurface ? 0 : -1}
        disabled={disabled}
        onKeyDown={(event) => handleSurfaceKeyDown(event, 'watch')}
        onClick={() => onSurfaceChange('watch')}
        className={cn('relative inline-flex h-full items-center gap-1 px-1 text-[12px] font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring min-[1025px]:gap-1.5 min-[1025px]:px-3 min-[1025px]:text-[13px]', {
          'text-foreground': watchSurface,
        })}
      >
        {m.watch.watchSurface}
        {watchUnreadCount > 0 && (
          <span
            aria-hidden="true"
            data-watch-unread-badge
            className={SURFACE_COUNT_BADGE_CLASS}
          >
            {watchUnreadCount > 99 ? '99+' : watchUnreadCount}
          </span>
        )}
      </button>
      <button
        ref={radarTabRef}
        id="gsm-radar-surface-tab"
        type="button"
        role="tab"
        aria-selected={surface === 'radar'}
        aria-controls="gsm-radar-surface-panel"
        aria-label={radarUnseenCount > 0
          ? m.radar.surfaceUnseen(radarUnseenCount)
          : m.radar.surface}
        tabIndex={surface === 'radar' ? 0 : -1}
        disabled={disabled}
        onKeyDown={(event) => handleSurfaceKeyDown(event, 'radar')}
        onClick={() => onSurfaceChange('radar')}
        className={cn('relative inline-flex h-full items-center gap-1 px-1 text-[12px] font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring min-[1025px]:gap-1.5 min-[1025px]:px-3 min-[1025px]:text-[13px]', {
          'text-foreground': surface === 'radar',
        })}
      >
        {m.radar.surface}
        {radarUnseenCount > 0 && (
          <span
            aria-hidden="true"
            data-radar-unseen-badge
            className={SURFACE_COUNT_BADGE_CLASS}
          >
            {radarUnseenCount > 99 ? '99+' : radarUnseenCount}
          </span>
        )}
      </button>
      <span
        className="gsm-surface-indicator pointer-events-none absolute -bottom-px h-0.5 rounded-full bg-foreground"
        style={{
          width: surfaceIndicator.width,
          transform: `translateX(${surfaceIndicator.left}px)`,
          opacity: surfaceIndicator.width > 0 ? 1 : 0,
        }}
        aria-hidden="true"
      />
    </div>
  );
});
