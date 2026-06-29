#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveExecutablePath } from './puppeteer-runtime.mjs';

try {
  const executablePath = await resolveExecutablePath();

  assert.equal(typeof executablePath, 'string');
  assert.ok(executablePath.length > 0, 'expected a non-empty browser executable path');

  console.log('✓ puppeteer runtime resolves a concrete executable path');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  assert.match(
    message,
    /pnpm exec puppeteer browsers install chrome|PUPPETEER_EXECUTABLE_PATH/,
  );
  console.log('✓ puppeteer runtime reports actionable browser-install guidance');
}
