import { messageFor } from '@/i18n';
import type { Locale } from '@/types';

export function applyFabLabel(btn: HTMLButtonElement, locale: Locale): boolean {
  if (!document.getElementById('gsm-fab')) return false;
  const label = messageFor(locale).popup.title;
  btn.setAttribute('data-tip', label);
  btn.setAttribute('aria-label', label);
  return true;
}
