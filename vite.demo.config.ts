import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const FORBIDDEN_DEMO_IMPORTS = [
  '/src/auth/',
  '/src/background/',
  '/src/bgsm-agent/',
  '/src/content/',
  '/src/dev-agent/',
  '/src/agent-harness/',
  '/src/agent-observability/',
  '/src/onboarding/',
  '/src/options/',
  '/src/popup/',
  '/src/sync/',
  '/src/upgrades/',
  '/src/ui/ManagerPanel.tsx',
  '/src/ui/components/Agent',
  '/src/ui/hooks/use-bgsm-agent',
  '/src/store-rating.ts',
  '/src/utils/messaging.ts',
  '/manifest.config.ts',
  '/vite.config.ts',
] as const;


function normalizedModulePath(id: string): string {
  return id.replace(/^\0/u, '').split('?')[0]!.replaceAll('\\', '/');
}

function isForbiddenDemoModule(id: string): boolean {
  const modulePath = normalizedModulePath(id);
  if (!modulePath.includes('/src/') && !modulePath.endsWith('/manifest.config.ts') && !modulePath.endsWith('/vite.config.ts')) {
    return false;
  }
  if (modulePath.includes('/src/storage/')) {
    return !modulePath.endsWith('/src/storage/tag-shape.ts');
  }
  if (modulePath.includes('/src/api/')) {
    return !modulePath.endsWith('/src/api/errors.ts');
  }
  return FORBIDDEN_DEMO_IMPORTS.some((fragment) => modulePath.includes(fragment));
}

function demoImportBoundaryPlugin(): Plugin {
  return {
    name: 'gsm-demo-import-boundary',
    generateBundle(_options, bundle) {
      const forbidden = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          if (isForbiddenDemoModule(id)) forbidden.add(normalizedModulePath(id));
        }
      }
      if (forbidden.size === 0) return;
      this.error(`Standalone Demo imported forbidden runtime modules:\n${[...forbidden].sort().join('\n')}`);
    },
  };
}

function demoRootHtmlPlugin(): Plugin {
  return {
    enforce: 'post',
    name: 'gsm-demo-root-html',
    generateBundle(_options, bundle) {
      const nestedHtml = bundle['demo/index.html'];
      if (!nestedHtml || nestedHtml.type !== 'asset') {
        this.error('Standalone Demo HTML entry was not emitted at demo/index.html.');
      }
      delete bundle['demo/index.html'];
      nestedHtml.fileName = 'index.html';
      bundle['index.html'] = nestedHtml;
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [react(), demoImportBoundaryPlugin(), demoRootHtmlPlugin()],
  define: {
    __GSM_DEV__: JSON.stringify(false),
    __GSM_DEV_UI_VISIBLE__: JSON.stringify(false),
    __GSM_VERSION_HASH__: JSON.stringify('demo'),
    __GSM_STORE_TARGET__: JSON.stringify('none'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist-demo',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./demo/index.html', import.meta.url)),
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
});
