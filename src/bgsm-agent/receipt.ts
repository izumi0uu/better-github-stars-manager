export const COMMIT_RECEIPT_OUTCOMES = Object.freeze([
  'changed',
  'unchanged',
  'skipped',
  'failed',
] as const);
export type CommitReceiptOutcome = typeof COMMIT_RECEIPT_OUTCOMES[number];

export const COMMIT_RECEIPT_REASONS = Object.freeze([
  'missing',
  'tombstoned',
  'excluded_tag',
  'stale_source',
  'taxonomy_conflict',
  'no_change',
  'transaction_failure',
  'policy_failure',
] as const);
export type CommitReceiptReason = typeof COMMIT_RECEIPT_REASONS[number];
