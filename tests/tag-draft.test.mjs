import assert from 'node:assert/strict';
import {
  mergeTagNames,
  normalizeTagNames,
  sameTagNames,
} from '../src/ui/components/tag-draft.ts';

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('Tag draft helpers:');

test('normalize trims blanks and dedupes case-insensitively', () => {
  assert.deepEqual(
    normalizeTagNames([' ai ', '', 'AI', 'agent', 'Agent ']),
    ['ai', 'agent'],
  );
});

test('merge appends only new tags and keeps existing order', () => {
  assert.deepEqual(
    mergeTagNames(['ai', 'agent'], ['AI', 'tools', 'agent']),
    ['ai', 'agent', 'tools'],
  );
});

test('sameTagNames is order-sensitive for dirty checks', () => {
  assert.equal(sameTagNames(['ai', 'agent'], ['ai', 'agent']), true);
  assert.equal(sameTagNames(['agent', 'ai'], ['ai', 'agent']), false);
});

console.log('\n✅ Tag draft helper tests passed');
