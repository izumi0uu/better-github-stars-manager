import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    exclude: [
      'tests/verify-*.ts',
      'tests/puppeteer-runtime.test.mjs',
      'tests/smoke.test.mjs',
    ],
    restoreMocks: true,
    clearMocks: true,
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
