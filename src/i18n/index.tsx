import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_LOCALE } from "@/preferences";
import type { Locale } from "@/types";
import type { ManagerRuntime } from '@/runtime/manager-runtime';
import { messages, type MessageCatalog } from './messages';

export type { MessageCatalog } from './messages';
export type { WatchStatusProgressField, WatchStatusTextPart } from './messages';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => Promise<void>;
  m: MessageCatalog;
}

const I18nContext = createContext<I18nValue>({
  locale: "en",
  setLocale: async () => {},
  m: messages.en,
});

export function getMessages(locale: Locale): MessageCatalog {
  return messages[locale] ?? messages.en;
}

export const messageFor = getMessages;

type I18nPreferenceSource = Pick<ManagerRuntime, 'readPreferences' | 'updatePreferences' | 'subscribe'>;

export function I18nProvider({
  children,
  source,
}: {
  children: ReactNode;
  source?: I18nPreferenceSource;
}) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    let cancelled = false;
    if (!source) {
      setLocaleState(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
      return () => {
        cancelled = true;
      };
    }
    const syncLocale = () => {
      void source.readPreferences()
        .then((preferences) => {
          if (!cancelled) setLocaleState(preferences.locale);
        })
        .catch(() => {});
    };
    syncLocale();
    const unsubscribe = source.subscribe((event) => {
      if (event.kind === 'preferences' || event.kind === 'reset') syncLocale();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  const setLocale = async (next: Locale) => {
    setLocaleState(next);
    if (source) await source.updatePreferences({ locale: next });
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale, m: getMessages(locale) }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
