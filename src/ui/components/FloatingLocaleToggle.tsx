import { useEffect, useState } from 'react';
import { getMessages, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { bgCall } from '@/utils/messaging';
import { DEV, VERSION_HASH } from '@/dev';
import type { Locale } from '@/types';

const LOCALES: { value: Locale; short: string; name: string }[] = [
  { value: 'en', short: 'EN', name: getMessages('en').localeName },
  { value: 'zh-CN', short: '中文', name: getMessages('zh-CN').localeName },
];

export function FloatingLocaleToggle({ drawerOpen }: { drawerOpen: boolean }) {
  const { locale, setLocale, m } = useI18n();
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  const clearLocalData = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    try {
      await bgCall('devClearLocalData');
      window.setTimeout(() => window.location.reload(), 150);
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  return (
    <div
      className={cn(
        'gsm-z-floating absolute bottom-4 transition-[right] duration-200',
        {
          'right-4 md:right-[356px]': drawerOpen,
          'right-4': !drawerOpen,
        },
      )}
    >
      <div className="flex items-center gap-2 rounded-full border border-border bg-background/90 px-2 py-1.5 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <span className="rounded-full bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning">
          {m.dev.version(VERSION_HASH)}
        </span>
        {DEV && (
          <button
            type="button"
            disabled={clearing}
            onClick={() => void clearLocalData()}
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-60',
              {
                'bg-destructive text-destructive-foreground hover:bg-destructive/90': confirmClear,
                'text-muted-foreground hover:bg-destructive/10 hover:text-destructive': !confirmClear,
              },
            )}
            title={confirmClear ? m.dev.confirmClearLocalData : m.dev.clearLocalData}
          >
            {clearing
              ? m.dev.clearingLocalData
              : confirmClear
                ? m.dev.confirmClearLocalData
                : m.dev.clearLocalData}
          </button>
        )}
        <span className="pl-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {m.options.languageLabel}
        </span>
        <div
          role="group"
          aria-label={m.options.languageLabel}
          className="inline-flex rounded-full bg-muted p-0.5"
        >
          {LOCALES.map((entry) => {
            const active = locale === entry.value;
            return (
              <button
                key={entry.value}
                type="button"
                aria-pressed={active}
                title={active ? m.common.current(entry.name) : entry.name}
                onClick={() => {
                  if (!active) void setLocale(entry.value);
                }}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                  {
                    'bg-primary text-primary-foreground shadow-sm': active,
                    'text-muted-foreground hover:bg-background hover:text-foreground': !active,
                  },
                )}
              >
                {entry.short}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
