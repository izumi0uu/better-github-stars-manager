import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

const source = readFileSync(new URL('../../src/background/index.ts', import.meta.url), 'utf8');

describe('background deleteAllTags contract', () => {
  it('declares and handles deleteAllTags as a first-class request', () => {
    assert.match(source, /\|\s*\{\s*type:\s*'deleteAllTags'\s*\}/);
    assert.match(source, /case 'deleteAllTags': \{/);
    assert.match(source, /const r = await run\(\(\) => idbTagStore\.deleteAllTags\(\)\);/);
    assert.match(source, /return \{ ok: true, data: r \};/);
  });

  it('broadcasts dataChanged once after the bulk store call', () => {
    const block = source.match(/case 'deleteAllTags': \{[\s\S]*?\n      \}/)?.[0] ?? '';
    assert.ok(block, 'deleteAllTags case block should exist');
    assert.ok(
      block.indexOf('run(() => idbTagStore.deleteAllTags())') < block.indexOf('broadcastDataChanged()'),
      'bulk delete should complete before broadcasting dataChanged',
    );
    assert.equal(block.match(/broadcastDataChanged\(\)/g)?.length, 1);
  });
});
