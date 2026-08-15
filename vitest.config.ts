import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __GSM_DEV__: 'true',
    __GSM_DEV_UI_VISIBLE__: 'true',
    __GSM_VERSION_HASH__: '"test"',
    __GSM_STORE_TARGET__: '"none"',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'tests/**/*.test.mjs'],
    exclude: [
      'tests/manual/verify-*.ts',
      'tests/runtime/puppeteer-runtime.test.mjs',
      'tests/runtime/smoke.test.mjs',
    ],
    restoreMocks: true,
    clearMocks: true,
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
