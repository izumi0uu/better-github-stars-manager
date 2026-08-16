import { createRoot } from 'react-dom/client';
import { authStore } from '@/auth/auth-store';
import { ExtensionI18nProvider } from '@/i18n/extension-provider';
import '@/ui/styles/index.css';
import { Popup } from './Popup';
import { signalRecommendationEntry } from '@/utils/recommendation-entry';

const root = document.getElementById('root')!;

// Apply persisted theme to documentElement (popup is the extension's own page,
// so toggling <html>.dark is safe here — unlike the stars-page content script).
authStore.getTheme().then((t) => {
  document.documentElement.classList.toggle('dark', t === 'dark');
});

signalRecommendationEntry();

createRoot(root).render(
  <ExtensionI18nProvider>
    <Popup />
  </ExtensionI18nProvider>,
);
