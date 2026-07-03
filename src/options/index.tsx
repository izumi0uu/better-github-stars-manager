import { createRoot } from 'react-dom/client';
import { authStore } from '@/auth/auth-store';
import { I18nProvider } from '@/i18n';
import '@/ui/styles/index.css';
import { Options } from './Options';

const root = document.getElementById('root')!;

// Apply persisted theme to documentElement (options is the extension's own page).
authStore.getTheme().then((t) => {
  document.documentElement.classList.toggle('dark', t === 'dark');
});

createRoot(root).render(
  <I18nProvider>
    <Options />
  </I18nProvider>,
);
