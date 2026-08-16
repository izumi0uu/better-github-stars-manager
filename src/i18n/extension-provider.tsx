import { useMemo, type ReactNode } from 'react';
import { I18nProvider } from '@/i18n';
import { createExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';

export function ExtensionI18nProvider({ children }: { children: ReactNode }) {
  const source = useMemo(() => createExtensionManagerRuntime(), []);
  return <I18nProvider source={source}>{children}</I18nProvider>;
}
