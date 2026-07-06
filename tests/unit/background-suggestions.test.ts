import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

const source = readFileSync(new URL('../../src/background/index.ts', import.meta.url), 'utf8');

function caseBlock(name: string, nextName?: string): string {
  const start = source.indexOf(`case '${name}': {`);
  const end = nextName
    ? source.indexOf(`case '${nextName}':`, start + 1)
    : source.indexOf('  } catch', start + 1);
  assert.notEqual(start, -1, `${name} case block should exist`);
  assert.notEqual(end, -1, `${nextName ?? 'catch'} boundary should exist after ${name}`);
  return source.slice(start, end);
}

describe('background suggestion mutation contract', () => {
  it('deduplicates single-repo accepted suggestions and broadcasts after the write', () => {
    const block = caseBlock('acceptSuggestions', 'suggestTags');

    assert.match(block, /const existing = \(await idbTagStore\.get\(req\.full_name\)\)\?\.tags \?\? \[\];/);
    assert.match(block, /const merged = Array\.from\(new Set\(\[\.\.\.existing, \.\.\.req\.toAdd\]\)\);/);
    assert.match(block, /await idbTagStore\.setTags\(req\.full_name, merged\);/);
    assert.ok(
      block.indexOf('await idbTagStore.setTags(req.full_name, merged)') < block.indexOf('broadcastDataChanged()'),
      'acceptSuggestions should write before broadcasting dataChanged',
    );
    assert.equal(block.match(/broadcastDataChanged\(\)/g)?.length, 1);
    assert.match(block, /return \{ ok: true, data: \{ tags: merged \} \};/);
  });

  it('counts only batch suggestion rows that add at least one new tag', () => {
    const block = caseBlock('acceptSuggestionsBatch');

    assert.match(block, /if \(item\.toAdd\.length === 0\) continue;/);
    assert.match(block, /const existing = \(await idbTagStore\.get\(item\.full_name\)\)\?\.tags \?\? \[\];/);
    assert.match(block, /const merged = Array\.from\(new Set\(\[\.\.\.existing, \.\.\.item\.toAdd\]\)\);/);
    assert.match(block, /if \(merged\.length !== existing\.length\) \{/);
    assert.match(block, /await idbTagStore\.setTags\(item\.full_name, merged\);/);
    assert.match(block, /n\+\+;/);
    assert.ok(
      block.indexOf('if (merged.length !== existing.length)') < block.indexOf('n++'),
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
