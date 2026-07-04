import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  mergeTagNames,
  normalizeTagNames,
  sameTagNames,
  shouldAdoptIncomingTagDraft,
  shouldAdoptIncomingTextDraft,
} from '../../src/ui/components/tag-draft.ts';

describe('Tag draft helpers', () => {
  it('normalize trims blanks and dedupes case-insensitively', () => {
    assert.deepEqual(
      normalizeTagNames([' ai ', '', 'AI', 'agent', 'Agent ']),
      ['ai', 'agent'],
    );
  });

  it('merge appends only new tags and keeps existing order', () => {
    assert.deepEqual(
      mergeTagNames(['ai', 'agent'], ['AI', 'tools', 'agent']),
      ['ai', 'agent', 'tools'],
    );
  });

  it('sameTagNames is order-sensitive for dirty checks', () => {
    assert.equal(sameTagNames(['ai', 'agent'], ['ai', 'agent']), true);
    assert.equal(sameTagNames(['agent', 'ai'], ['ai', 'agent']), false);
  });

  it('incoming notes only replace the local draft when the user has not diverged', () => {
    assert.equal(shouldAdoptIncomingTextDraft('saved', 'saved', 'server'), true);
    assert.equal(shouldAdoptIncomingTextDraft('local edit', 'saved', 'server'), false);
    assert.equal(shouldAdoptIncomingTextDraft('saved', 'saved', 'saved'), false);
    assert.equal(shouldAdoptIncomingTextDraft('saved', 'saved', ''), true);
  });

  it('incoming tags only replace the local draft when the user has not diverged', () => {
    assert.equal(
      shouldAdoptIncomingTagDraft(['saved'], ['saved'], ['server']),
      true,
    );
    assert.equal(
      shouldAdoptIncomingTagDraft(['local-edit'], ['saved'], ['server']),
      false,
    );
    assert.equal(
      shouldAdoptIncomingTagDraft(['saved'], ['saved'], ['saved']),
      false,
    );
    assert.equal(shouldAdoptIncomingTagDraft(['saved'], ['saved'], []), true);
  });
});
