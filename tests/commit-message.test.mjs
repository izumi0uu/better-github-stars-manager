import assert from "node:assert/strict";
import { validateCommitMessage } from "../scripts/validate-commit-message.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function expectValid(message) {
  assert.deepEqual(validateCommitMessage(message), []);
}

function expectError(message, fragment) {
  const errors = validateCommitMessage(message);
  assert(
    errors.some((error) => error.includes(fragment)),
    `Expected an error including "${fragment}", got:\n${errors.join("\n")}`,
  );
}

console.log("Commit message validation:");

test("accepts a conventional commit title with Lore trailers", () => {
  expectValid(`feat(sync): harden first-run sync and tag management

Constraint: Documentation had to match already-shipped behavior without widening implementation scope
Rejected: Leave the old MVP labels in place | they described superseded checks
Confidence: high
Scope-risk: narrow
Directive: Update README and VERIFY whenever sync semantics change
Tested: Manual diff review
Not-tested: No runtime checks; this commit only changes documentation text`);
});

test("accepts single-line chore commits without Lore trailers", () => {
  expectValid(`chore(store): update marquee promo asset`);
});

test("accepts single-line docs commits without Lore trailers", () => {
  expectValid(`docs(sync): align verification docs`);
});

test("rejects titles without a conventional commit prefix", () => {
  expectError(`Keep verification docs aligned

Constraint: local policy
Rejected: none
Confidence: high
Scope-risk: narrow
Directive: keep format
Tested: none
Not-tested: none`, "Conventional Commit prefix");
});

test("rejects titles longer than 72 characters", () => {
  expectError(`feat: make the commit title validation enforce a much longer than allowed subject line for this repository

Constraint: local policy
Rejected: none
Confidence: high
Scope-risk: narrow
Directive: keep format
Tested: none
Not-tested: none`, "72 characters or fewer");
});

test("rejects non-exempt messages that skip required Lore trailers", () => {
  expectError(`feat(sync): align verification docs

Constraint: docs only`, "Missing Lore trailer: Rejected:");
});

console.log("\n✅ Commit message tests passed");
