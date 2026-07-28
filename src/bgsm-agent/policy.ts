export const FROZEN_SCOPE_PAGE_DEFAULT = 25;
export const FROZEN_SCOPE_PAGE_HARD_LIMIT = 50;
export const ANALYZER_OUTPUT_TOKENS_DEFAULT = 4_096;
export const ANALYZER_OUTPUT_TOKENS_HARD_LIMIT = 8_192;
// Kept as compatibility exports for callers that still validate safe-integer counts.
// OrganizeJobRun job totals are bounded by the frozen scope and budgets, not by a 100-row policy cap.
export const ACTIONABLE_PROPOSAL_ROW_HARD_LIMIT = Number.MAX_SAFE_INTEGER;
export const APPLY_CHUNK_ROW_LIMIT = 100;
export const PROPOSAL_REVIEW_PAGE_HARD_LIMIT = 100;
export const TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT = 5;
export const MAX_SEMANTIC_TAG_NAME_BYTES = 256;
export const MAX_SEMANTIC_EVIDENCE_BYTES = 1_024;

export type RunBudget = Readonly<{
  wallDeadlineMs: number;
  maxConsumedFrozenPositions: number;
  maxAnalyzerBatches: number;
  maxProviderAttempts: number;
  maxSerializedOutboundRequestBytes: number;
  maxRequestedOutputTokens: number;
}>;

export type RunBudgetUsage = Readonly<{
  firstAnalyzerRequestAt: number | null;
  consumedFrozenPositions: number;
  analyzerBatches: number;
  providerAttempts: number;
  serializedOutboundRequestBytes: number;
  requestedOutputTokens: number;
}>;

export type ProviderActualTokenTelemetry = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type ProviderAttemptReservation = Readonly<{
  reservedAt: number;
  serializedRequestBytes: number;
  requestedOutputTokens: number;
  previousUsage: RunBudgetUsage;
  usage: RunBudgetUsage;
}>;

export const BUDGET_EXHAUSTION_REASON_PRIORITY = Object.freeze([
  'wall_deadline',
  'consumed_positions',
  'analyzer_batches',
  'provider_attempts',
  'outbound_request_bytes',
  'requested_output_tokens',
] as const);

export type BudgetExhaustionReason = typeof BUDGET_EXHAUSTION_REASON_PRIORITY[number];

const PRODUCTION_RUN_BUDGET_VALUES: RunBudget = {
  wallDeadlineMs: 300_000,
  maxConsumedFrozenPositions: 500,
  maxAnalyzerBatches: 20,
  maxProviderAttempts: 24,
  maxSerializedOutboundRequestBytes: 8_388_608,
  maxRequestedOutputTokens: 32_000,
};

export function createProductionRunBudget(): RunBudget {
  return Object.freeze({ ...PRODUCTION_RUN_BUDGET_VALUES });
}

export function createLowerTestRunBudget(overrides: Partial<RunBudget>): RunBudget {
  const budget = { ...PRODUCTION_RUN_BUDGET_VALUES, ...overrides };
  validateRunBudget(budget);
  for (const key of Object.keys(PRODUCTION_RUN_BUDGET_VALUES) as (keyof RunBudget)[]) {
    if (budget[key] > PRODUCTION_RUN_BUDGET_VALUES[key]) {
      throw new RangeError(`Test RunBudget cannot raise ${key}.`);
    }
  }
  return Object.freeze(budget);
}

export function createEmptyRunBudgetUsage(): RunBudgetUsage {
  return Object.freeze({
    firstAnalyzerRequestAt: null,
    consumedFrozenPositions: 0,
    analyzerBatches: 0,
    providerAttempts: 0,
    serializedOutboundRequestBytes: 0,
    requestedOutputTokens: 0,
  });
}

export function validateRunBudget(value: unknown): asserts value is RunBudget {
  if (!isRecord(value)) throw new TypeError('RunBudget must be an object.');
  assertExactKeys(value, Object.keys(PRODUCTION_RUN_BUDGET_VALUES));
  for (const key of Object.keys(PRODUCTION_RUN_BUDGET_VALUES) as (keyof RunBudget)[]) {
    assertPositiveSafeInteger(value[key], `RunBudget.${key}`);
  }
}

export function validateRunBudgetUsage(value: unknown): asserts value is RunBudgetUsage {
  if (!isRecord(value)) throw new TypeError('RunBudgetUsage must be an object.');
  assertExactKeys(value, [
    'firstAnalyzerRequestAt',
    'consumedFrozenPositions',
    'analyzerBatches',
    'providerAttempts',
    'serializedOutboundRequestBytes',
    'requestedOutputTokens',
  ]);
  const firstAnalyzerRequestAt = value.firstAnalyzerRequestAt;
  if (
    firstAnalyzerRequestAt !== null &&
    (!Number.isSafeInteger(firstAnalyzerRequestAt) || (firstAnalyzerRequestAt as number) < 0)
  ) {
    throw new TypeError('RunBudgetUsage.firstAnalyzerRequestAt must be null or a nonnegative safe integer.');
  }
  for (const key of [
    'consumedFrozenPositions',
    'analyzerBatches',
    'providerAttempts',
    'serializedOutboundRequestBytes',
    'requestedOutputTokens',
  ] as const) {
    assertNonnegativeSafeInteger(value[key], `RunBudgetUsage.${key}`);
  }
}

export function validateProviderAttemptReservation(
  value: unknown,
): asserts value is ProviderAttemptReservation {
  if (!isRecord(value)) throw new TypeError('Provider attempt reservation must be an object.');
  assertExactKeys(value, [
    'reservedAt',
    'serializedRequestBytes',
    'requestedOutputTokens',
    'previousUsage',
    'usage',
  ]);
  assertNonnegativeSafeInteger(value.reservedAt, 'Provider reservation reservedAt');
  assertPositiveSafeInteger(value.serializedRequestBytes, 'Provider reservation serializedRequestBytes');
  assertPositiveSafeInteger(value.requestedOutputTokens, 'Provider reservation requestedOutputTokens');
  if (value.requestedOutputTokens > ANALYZER_OUTPUT_TOKENS_HARD_LIMIT) {
    throw new RangeError('Provider reservation requestedOutputTokens exceeds the hard limit.');
  }
  validateRunBudgetUsage(value.previousUsage);
  validateRunBudgetUsage(value.usage);
  const previous = value.previousUsage;
  const next = value.usage;
  if (
    !isMonotonicRunBudgetUsage(previous, next) ||
    next.providerAttempts !== previous.providerAttempts + 1 ||
    next.serializedOutboundRequestBytes !==
      previous.serializedOutboundRequestBytes + value.serializedRequestBytes ||
    next.requestedOutputTokens !== previous.requestedOutputTokens + value.requestedOutputTokens ||
    next.consumedFrozenPositions !== previous.consumedFrozenPositions ||
    next.analyzerBatches !== previous.analyzerBatches ||
    next.firstAnalyzerRequestAt !== (previous.firstAnalyzerRequestAt ?? value.reservedAt)
  ) {
    throw new TypeError('Provider attempt reservation must atomically reserve one attempt, exact bytes, and requested tokens.');
  }
}

export function validateProviderActualTokenTelemetry(
  value: unknown,
): asserts value is ProviderActualTokenTelemetry {
  if (!isRecord(value)) throw new TypeError('Provider actual-token telemetry must be an object.');
  assertExactKeys(value, ['inputTokens', 'outputTokens', 'totalTokens']);
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (value[field] !== null) assertNonnegativeSafeInteger(value[field], `Telemetry.${field}`);
  }
}

export function isMonotonicRunBudgetUsage(
  previous: RunBudgetUsage,
  next: RunBudgetUsage,
): boolean {
  validateRunBudgetUsage(previous);
  validateRunBudgetUsage(next);
  if (
    previous.firstAnalyzerRequestAt !== null &&
    next.firstAnalyzerRequestAt !== previous.firstAnalyzerRequestAt
  ) {
    return false;
  }
  if (previous.firstAnalyzerRequestAt === null && next.firstAnalyzerRequestAt !== null) {
    if (next.firstAnalyzerRequestAt < 0) return false;
  }
  return (
    next.consumedFrozenPositions >= previous.consumedFrozenPositions &&
    next.analyzerBatches >= previous.analyzerBatches &&
    next.providerAttempts >= previous.providerAttempts &&
    next.serializedOutboundRequestBytes >= previous.serializedOutboundRequestBytes &&
    next.requestedOutputTokens >= previous.requestedOutputTokens
  );
}

export function selectBudgetExhaustionReason(
  exhausted: Readonly<Record<BudgetExhaustionReason, boolean>>,
): BudgetExhaustionReason | null {
  return BUDGET_EXHAUSTION_REASON_PRIORITY.find((reason) => exhausted[reason]) ?? null;
}

export type ProviderReservationResult =
  | Readonly<{ status: 'reserved'; reservation: ProviderAttemptReservation }>
  | Readonly<{ status: 'budget_exhausted'; reason: BudgetExhaustionReason }>;

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Unexpected contract keys: ${actual.join(', ')}.`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
}

function assertNonnegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
