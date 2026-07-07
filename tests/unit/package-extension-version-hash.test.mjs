import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

const source = () => readFileSync('scripts/package-extension.mjs', 'utf8');

describe('package extension version hash extraction', () => {
  it('keeps the version hash regex global for matchAll scanning', () => {
    const code = source();
    const match = code.match(/const versionHashPattern = (\/.*\/)([a-z]*);/);

    assert.ok(match, 'versionHashPattern declaration is present');
    assert.ok(match[2].includes('g'), 'versionHashPattern must be global for String.matchAll');
    assert.doesNotThrow(() => {
      [...'12345678-clean-abcdef unknown-clean-abcdef'.matchAll(new RegExp(
        '\\b(?:[0-9a-f]{8}|unknown)-(?:clean|[0-9a-f]{6})-[0-9a-f]{6}\\b',
        match[2],
      ))];
    });
  });
});
