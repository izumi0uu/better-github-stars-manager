import { createRoot } from 'react-dom/client';
import { authStore } from '@/auth/auth-store';
import { I18nProvider } from '@/i18n';
import '@/ui/styles/index.css';
import { AgentDiagnostics } from './AgentDiagnostics';

const root = document.getElementById('root')!;

if (typeof chrome !== 'undefined' && chrome.storage?.local !== undefined) {
  authStore.getTheme().then((theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  });
} else {
  document.documentElement.classList.toggle(
    'dark',
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );
}

createRoot(root).render(
  <I18nProvider>
    <AgentDiagnostics />
  </I18nProvider>,
);
