import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { validateCommitMessage } from '../scripts/validate-commit-message.mjs';

function expectValid(message) {
  assert.deepEqual(validateCommitMessage(message), []);
}

function expectError(message, fragment) {
  const errors = validateCommitMessage(message);
  assert(
    errors.some((error) => error.includes(fragment)),
    `Expected an error including "${fragment}", got:\n${errors.join('\n')}`,
  );
}

describe('Commit message validation', () => {
  it('accepts a conventional commit title with Lore trailers', () => {
    expectValid(`feat(sync): harden first-run sync and tag management

Constraint: Documentation had to match already-shipped behavior without widening implementation scope
Rejected: Leave the old MVP labels in place | they described superseded checks
Confidence: high
Scope-risk: narrow
Directive: Update README and VERIFY whenever sync semantics change
Tested: Manual diff review
Not-tested: No runtime checks; this commit only changes documentation text`);
  });

  it('accepts single-line chore commits without Lore trailers', () => {
    expectValid('chore(store): update marquee promo asset');
  });

  it('accepts single-line docs commits without Lore trailers', () => {
    expectValid('docs(sync): align verification docs');
  });

  it('rejects titles without a conventional commit prefix', () => {
    expectError(`Keep verification docs aligned

Constraint: local policy
Rejected: none
Confidence: high
Scope-risk: narrow
Directive: keep format
Tested: none
Not-tested: none`, 'Conventional Commit prefix');
  });

  it('rejects titles longer than 72 characters', () => {
    expectError(`feat: make the commit title validation enforce a much longer than allowed subject line for this repository

Constraint: local policy
Rejected: none
Confidence: high
Scope-risk: narrow
Directive: keep format
Tested: none
Not-tested: none`, '72 characters or fewer');
  });

  it('rejects non-exempt messages that skip required Lore trailers', () => {
    expectError(`feat(sync): align verification docs

Constraint: docs only`, 'Missing Lore trailer: Rejected:');
  });
});
