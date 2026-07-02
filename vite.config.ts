import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import manifest from './manifest.config';

function git(args: string[], fallback = ''): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function versionHash(): string {
  if (process.env.GSM_VERSION_HASH) return process.env.GSM_VERSION_HASH;
  const commit = git(['rev-parse', '--short=8', 'HEAD'], 'unknown');
  const dirty = git(['status', '--short']);
  if (!dirty) return commit;
  const diff = git(['diff', '--binary', 'HEAD']);
  const suffix = createHash('sha1').update(`${diff}\n${dirty}`).digest('hex').slice(0, 8);
  return `${commit}-${suffix}`;
}

export default defineConfig(({ mode }) => {
  const DEV = mode !== 'production' || process.env.GSM_DEV === 'true';

  return {
    plugins: [react(), crx({ manifest })],
    define: {
      __GSM_DEV__: JSON.stringify(DEV),
      __GSM_VERSION_HASH__: JSON.stringify(versionHash()),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        // Dexie needs to not be split in a way that breaks content-script contexts
        output: { chunkFileNames: 'assets/[name]-[hash].js' },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      hmr: { port: 5173 },
    },
  };
});
