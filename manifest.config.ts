import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

/**
 * MV3 match patterns cannot match on query strings (no `?tab=stars` patterns).
 * So both content scripts match the broad host and gate on URL inside the script:
 *  - stars-page runs only when location.search includes `tab=stars`
 *  - repo-chip  runs only on paths shaped `/{owner}/{repo}` (excluded stars/settings/etc.)
 */
export function createProductManifest() {
  return defineManifest({
  manifest_version: 3,
  name: 'Better GitHub Stars Manager',
  version: pkg.version,
  description: pkg.description,
  homepage_url: 'https://github.com/izumi0uu/better-github-stars-manager',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  permissions: ['storage', 'alarms'],
  host_permissions: [
    'https://api.github.com/*',
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://github.com/*',
    'https://openrouter.ai/*',
  ],
  optional_host_permissions: [
    'https://*/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Better GitHub Stars Manager',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  content_scripts: [
    {
      matches: ['https://github.com/*'],
      js: ['src/content/stars-page/index.tsx'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://github.com/*'],
      js: ['src/content/repo-chip/index.tsx'],
      run_at: 'document_idle',
    },
  ],
  // web_accessible_resources: needed if we ever load an iframe for the manager UI,
  // but we mount into the page DOM directly, so none required for MVP.
  web_accessible_resources: [],
  });
}

export default createProductManifest();
