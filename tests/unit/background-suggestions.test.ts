import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { caseBlock } from '../helpers/background-case-block';

describe('background suggestion mutation contract', () => {
  it('deduplicates single-repo suggestions without reviving excluded tags', () => {
    const block = caseBlock('acceptSuggestions', 'suggestTags');

    assert.match(block, /await idbTagStore\.listExcluded\(\)/);
    assert.match(
      block,
      /const existing = manualTagNames\(existingTag\)\s*\.filter\(\(name\) => !excludedTagKeys\.has\(canonicalTagKey\(name\)\)\);/,
    );
    assert.match(
      block,
      /const additions = req\.toAdd\s*\.filter\(\(name\) => !excludedTagKeys\.has\(canonicalTagKey\(name\)\)\);/,
    );
    assert.match(block, /const merged = addTagNames\(existing, additions\);/);
    assert.match(block, /const tags = await run\(async \(\) => \{/);
    assert.match(block, /await idbTagStore\.setTags\(req\.full_name, merged\);/);
    assert.match(
      block,
      /return visibleTagNames\(await idbTagStore\.get\(req\.full_name\)\);/,
    );
    assert.ok(
      block.indexOf('await idbTagStore.setTags(req.full_name, merged)') < block.indexOf('broadcastDataChanged()'),
      'acceptSuggestions should write before broadcasting dataChanged',
    );
    assert.equal(block.match(/broadcastDataChanged\(\)/g)?.length, 1);
    assert.match(block, /data:\s*\{ tags \}/);
  });

  it('counts only batch rows with a new non-excluded suggestion', () => {
    const block = caseBlock('acceptSuggestionsBatch');

    assert.match(block, /if \(item\.toAdd\.length === 0\) continue;/);
    assert.match(
      block,
      /const existing = manualTagNames\(\s*await idbTagStore\.get\(item\.full_name\),?\s*\)\.filter\(\(name\) => !excludedTagKeys\.has\(canonicalTagKey\(name\)\)\);/,
    );
    assert.match(
      block,
      /const additions = item\.toAdd\s*\.filter\(\(name\) => !excludedTagKeys\.has\(canonicalTagKey\(name\)\)\);/,
    );
    assert.match(block, /const merged = addTagNames\(existing, additions\);/);
    assert.match(block, /if \(merged\.length !== existing\.length\) \{/);
    assert.match(block, /await idbTagStore\.setTags\(item\.full_name, merged\);/);
    assert.match(block, /const n = await run\(async \(\) => \{/);
    assert.match(block, /let updated = 0;/);
    assert.match(block, /updated\+\+;/);
    assert.match(block, /return updated;/);
    assert.ok(
      block.indexOf('if (merged.length !== existing.length)') < block.indexOf('updated++'),
      'batch count should increment only for rows with new tags',
    );
    assert.ok(
      block.indexOf('await idbTagStore.setTags(item.full_name, merged)') < block.indexOf('broadcastDataChanged()'),
      'batch suggestions should finish writes before broadcasting dataChanged',
    );
    assert.equal(block.match(/broadcastDataChanged\(\)/g)?.length, 1);
    assert.match(block, /return \{ ok: true, data: \{ count: n \} \};/);
  });
});
