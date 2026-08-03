import {
  ANALYZER_OUTPUT_TOKENS_HARD_LIMIT,
  FROZEN_SCOPE_PAGE_DEFAULT,
  FROZEN_SCOPE_PAGE_HARD_LIMIT,
  selectBudgetExhaustionReason,
  validateRunBudget,
  validateRunBudgetUsage,
  type BudgetExhaustionReason,
  type ProviderAttemptReservation,
  type RunBudget,
  type RunBudgetUsage,
} from './policy';

export type BatchAdmission =
  | Readonly<{ status: 'complete' }>
  | Readonly<{ status: 'budget_exhausted'; reason: BudgetExhaustionReason }>
  | Readonly<{ status: 'admitted'; windowSize: number }>;

export type BatchReservation =
  | Readonly<{ status: 'complete' }>
  | Readonly<{ status: 'budget_exhausted'; reason: BudgetExhaustionReason }>
  | Readonly<{ status: 'reserved'; usage: RunBudgetUsage; windowSize: number }>;

export type AttemptReservation =
  | Readonly<{ status: 'budget_exhausted'; reason: BudgetExhaustionReason }>
  | Readonly<{ status: 'reserved'; reservation: ProviderAttemptReservation }>;

export function admitNextBatch(input: Readonly<{
  budget: RunBudget;
  usage: RunBudgetUsage;
  now: number;
  nextFrozenIndex: number;
  frozenScopeCount: number;
  requestedWindowSize?: number;
  nextAttemptRequestedOutputTokens: number;
}>): BatchAdmission {
  validateCommon(input.budget, input.usage, input.now);
  assertNonnegativeSafeInteger(input.nextFrozenIndex, 'nextFrozenIndex');
  assertNonnegativeSafeInteger(input.frozenScopeCount, 'frozenScopeCount');
  if (input.nextFrozenIndex > input.frozenScopeCount) {
    throw new RangeError('nextFrozenIndex exceeds FrozenScope count.');
  }
  validateRequestedOutputTokens(input.nextAttemptRequestedOutputTokens);
  if (input.nextFrozenIndex === input.frozenScopeCount) return Object.freeze({ status: 'complete' });

  const reason = exhaustedReason({
    budget: input.budget,
    usage: input.usage,
    now: input.now,
    prospectiveRequestedOutputTokens: input.nextAttemptRequestedOutputTokens,
  });
  if (reason) return Object.freeze({ status: 'budget_exhausted', reason });

  const requested = input.requestedWindowSize ?? FROZEN_SCOPE_PAGE_DEFAULT;
  assertPositiveSafeInteger(requested, 'requestedWindowSize');
  const remainingPositions = input.budget.maxConsumedFrozenPositions -
    input.usage.consumedFrozenPositions;
  const remainingScope = input.frozenScopeCount - input.nextFrozenIndex;
  return Object.freeze({
    status: 'admitted',
    windowSize: Math.min(
      requested,
      FROZEN_SCOPE_PAGE_HARD_LIMIT,
      remainingPositions,
      remainingScope,
    ),
  });
}

export function reserveAnalyzerBatch(input: Parameters<typeof admitNextBatch>[0]): BatchReservation {
  const admission = admitNextBatch(input);
  if (admission.status !== 'admitted') return admission;
  const usage = Object.freeze({
    ...input.usage,
    analyzerBatches: input.usage.analyzerBatches + 1,
  });
  validateRunBudgetUsage(usage);
  return Object.freeze({ status: 'reserved', usage, windowSize: admission.windowSize });
}

export function reserveProviderAttempt(input: Readonly<{
  budget: RunBudget;
  usage: RunBudgetUsage;
  now: number;
  serializedRequestBytes: number;
  requestedOutputTokens: number;
}>): AttemptReservation {
  validateCommon(input.budget, input.usage, input.now);
  assertPositiveSafeInteger(input.serializedRequestBytes, 'serializedRequestBytes');
  validateRequestedOutputTokens(input.requestedOutputTokens);
  const reason = exhaustedReason({
    budget: input.budget,
    usage: input.usage,
    now: input.now,
    prospectiveRequestBytes: input.serializedRequestBytes,
    prospectiveRequestedOutputTokens: input.requestedOutputTokens,
    includeBatchLimits: false,
  });
  if (reason) return Object.freeze({ status: 'budget_exhausted', reason });
  const usage = Object.freeze({
    ...input.usage,
    firstAnalyzerRequestAt: input.usage.firstAnalyzerRequestAt ?? input.now,
    providerAttempts: input.usage.providerAttempts + 1,
    serializedOutboundRequestBytes:
      input.usage.serializedOutboundRequestBytes + input.serializedRequestBytes,
    requestedOutputTokens: input.usage.requestedOutputTokens + input.requestedOutputTokens,
  });
  const reservation: ProviderAttemptReservation = Object.freeze({
    reservedAt: input.now,
    serializedRequestBytes: input.serializedRequestBytes,
    requestedOutputTokens: input.requestedOutputTokens,
    previousUsage: input.usage,
    usage,
  });
  return Object.freeze({ status: 'reserved', reservation });
}

export function consumeFrozenPositions(
  budget: RunBudget,
  usage: RunBudgetUsage,
  count: number,
): RunBudgetUsage {
  validateRunBudget(budget);
  validateRunBudgetUsage(usage);
  assertNonnegativeSafeInteger(count, 'consumed position count');
  if (usage.consumedFrozenPositions + count > budget.maxConsumedFrozenPositions) {
    throw new RangeError('Consumed FrozenScope positions exceed the immutable RunBudget.');
  }
  return Object.freeze({
    ...usage,
    consumedFrozenPositions: usage.consumedFrozenPositions + count,
  });
}

export function absoluteAnalyzerDeadline(
  budget: RunBudget,
  usage: RunBudgetUsage,
): number | null {
  validateRunBudget(budget);
  validateRunBudgetUsage(usage);
  return usage.firstAnalyzerRequestAt === null
    ? null
    : usage.firstAnalyzerRequestAt + budget.wallDeadlineMs;
}

function exhaustedReason(input: Readonly<{
  budget: RunBudget;
  usage: RunBudgetUsage;
  now: number;
  prospectiveRequestBytes?: number;
  prospectiveRequestedOutputTokens?: number;
  includeBatchLimits?: boolean;
}>): BudgetExhaustionReason | null {
  const deadline = absoluteAnalyzerDeadline(input.budget, input.usage);
  const includeBatchLimits = input.includeBatchLimits ?? true;
  return selectBudgetExhaustionReason({
    wall_deadline: deadline !== null && input.now >= deadline,
    consumed_positions: includeBatchLimits &&
      input.usage.consumedFrozenPositions >= input.budget.maxConsumedFrozenPositions,
    analyzer_batches: includeBatchLimits &&
      input.usage.analyzerBatches >= input.budget.maxAnalyzerBatches,
    provider_attempts: input.usage.providerAttempts >= input.budget.maxProviderAttempts,
    outbound_request_bytes: input.prospectiveRequestBytes === undefined
      ? input.usage.serializedOutboundRequestBytes >= input.budget.maxSerializedOutboundRequestBytes
      : input.usage.serializedOutboundRequestBytes + input.prospectiveRequestBytes >
        input.budget.maxSerializedOutboundRequestBytes,
    requested_output_tokens: input.prospectiveRequestedOutputTokens === undefined
      ? input.usage.requestedOutputTokens >= input.budget.maxRequestedOutputTokens
      : input.usage.requestedOutputTokens + input.prospectiveRequestedOutputTokens >
        input.budget.maxRequestedOutputTokens,
  });
}

function validateCommon(budget: RunBudget, usage: RunBudgetUsage, now: number): void {
  validateRunBudget(budget);
  validateRunBudgetUsage(usage);
  assertNonnegativeSafeInteger(now, 'now');
}

function validateRequestedOutputTokens(value: number): void {
  assertPositiveSafeInteger(value, 'requestedOutputTokens');
  if (value > ANALYZER_OUTPUT_TOKENS_HARD_LIMIT) {
    throw new RangeError('Analyzer requested output tokens exceed the per-attempt hard limit.');
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
