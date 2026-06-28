import { readFileSync } from "node:fs";

const REQUIRED_TRAILERS = [
  "Constraint",
  "Rejected",
  "Confidence",
  "Scope-risk",
  "Directive",
  "Tested",
  "Not-tested",
];

const CONVENTIONAL_PREFIX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?:\s/i;
const SINGLE_LINE_PREFIX = /^(chore|docs)(\([^)]+\))?!?:\s/i;

export function validateCommitMessage(message) {
  const normalized = message.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  const subject = (lines[0] ?? "").trim();
  const errors = [];
  const allowsSingleLine = SINGLE_LINE_PREFIX.test(subject);

  if (!subject) {
    errors.push("Commit title is required.");
  } else {
    if (subject.length > 72) {
      errors.push(
        `Commit title must be 72 characters or fewer (got ${subject.length}).`,
      );
    }
    if (subject.endsWith(".")) {
      errors.push("Commit title must not end with a period.");
    }
    if (!CONVENTIONAL_PREFIX.test(subject)) {
      errors.push(
        "Commit title must use a Conventional Commit prefix like feat(scope): summary.",
      );
    }
  }

  if (!allowsSingleLine && (lines.length < 3 || lines[1].trim() !== "")) {
    errors.push("Commit title must be followed by a blank line.");
  }

  if (!allowsSingleLine) {
    for (const trailer of REQUIRED_TRAILERS) {
      if (!lines.some((line) => line.startsWith(`${trailer}: `))) {
        errors.push(`Missing Lore trailer: ${trailer}:`);
      }
    }
  }

  return errors;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/validate-commit-message.mjs <path>");
    process.exit(1);
  }

  const message = readFileSync(file, "utf8");
  const errors = validateCommitMessage(message);
  if (errors.length === 0) return;

  console.error(
    "Commit message does not match this repo's Conventional + Lore format:",
  );
  for (const error of errors) console.error(`- ${error}`);
  console.error("");
  console.error("Expected shape:");
  console.error("  <type(scope): summary, <=72 chars>");
  console.error("  Single-line commits are allowed for docs: and chore:");
  console.error("");
  console.error("  Constraint: ...");
  console.error("  Rejected: ...");
  console.error("  Confidence: low|medium|high");
  console.error("  Scope-risk: narrow|moderate|broad");
  console.error("  Directive: ...");
  console.error("  Tested: ...");
  console.error("  Not-tested: ...");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
