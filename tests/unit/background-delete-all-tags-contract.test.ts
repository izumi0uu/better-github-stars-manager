import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { backgroundSource, caseBlock } from '../helpers/background-case-block';

describe('background deleteAllTags contract', () => {
  it('declares and handles deleteAllTags as a first-class request', () => {
    const block = caseBlock('deleteAllTags', 'acceptSuggestions');

    assert.match(backgroundSource, /\|\s*\{\s*type:\s*["']deleteAllTags["']\s*\}/);
    assert.match(block, /const r = await run\(\(\) => idbTagStore\.deleteAllTags\(\)\);/);
    assert.match(block, /return \{ ok: true, data: r \};/);
  });

  it('broadcasts dataChanged once after the bulk store call', () => {
    const block = caseBlock('deleteAllTags', 'acceptSuggestions');

    assert.ok(
      block.indexOf('run(() => idbTagStore.deleteAllTags())') < block.indexOf('broadcastDataChanged()'),
      'bulk delete should complete before broadcasting dataChanged',
    );
    assert.equal(block.match(/broadcastDataChanged\(\)/g)?.length, 1);
  });
});
