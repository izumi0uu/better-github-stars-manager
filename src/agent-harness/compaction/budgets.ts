import type { AgentModelContextCapability } from '@/types';
import {
  estimateContext,
  estimateContextWithUsage,
  type ContextEstimate,
  type ContextEstimateInput,
  type ContextUsageEstimate,
  type ProviderUsageAnchor,
} from './estimator';

export const SUMMARY_MAX_OUTPUT_TOKENS = 1024;
export const SUMMARY_SAFETY_TOKENS = 1024;
export const DEFAULT_CONTEXT_SAFETY_RESERVE_TOKENS = 4_096;
export const MAX_CONTEXT_COMPACTION_RESERVE_TOKENS = 16_384;
export const MAX_CONTEXT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_CONTEXT_RESULT_MEMORY_CEILING_BYTES = 64 * 1024;
export const CONTEXT_BUDGET_POLICY_REVISION = 'cbp:v2';

export type ContextBudgetPolicy = {
  providerWindow: number;
  workingWindow: number;
  requestedOutputTokens: number;
  safetyReserveTokens: number;
  compactionReserveTokens: number;
  softLimit: number;
  hardLimit: number;
  keepRecentTokens: number;
  summaryMaxOutputTokens: number;
  summaryInputCap: number;
  memoryResultCeilingBytes: number;
  capabilitySource: AgentModelContextCapability['source'];
  capabilityRevision: string;
  policyRevision: string;
  /** Compatibility aliases while call sites migrate to v2 terminology. */
  effectiveWindow: number;
  recentHistoryTarget: number;
};

export type ContextBudgetProfile = ContextBudgetPolicy;

function syntheticCapability(contextWindow: number): AgentModelContextCapability {
  return {
    schemaVersion: 1,
    contextWindow,
    maxOutputTokens: Math.min(8_192, contextWindow),
    source: 'user-declared',
    sourceRevision: 'compatibility-fixture',
    capabilityRevision: `mcc:v1:compat:${contextWindow}`,
  };
}

export const CONTEXT_PROFILE_8192 = resolveContextBudgetPolicy({
  capability: syntheticCapability(8_192),
  requestedOutputTokens: 1_024,
  safetyReserveTokens: 1_024,
});

export const CONTEXT_PROFILE_32768 = resolveContextBudgetPolicy({
  capability: syntheticCapability(32_768),
  requestedOutputTokens: 1_024,
  safetyReserveTokens: 4_096,
});

export function resolveEffectiveContextWindow(value?: number | null): number {
  if (value == null) throw new TypeError('Model context capability is unresolved.');
  assertPositiveInteger(value, 'contextWindow');
  return value;
}

export function resolveContextBudgetProfile(value?: number | null): ContextBudgetPolicy {
  return resolveContextBudgetPolicy({
    capability: syntheticCapability(resolveEffectiveContextWindow(value)),
    requestedOutputTokens: 1_024,
  });
}

export function resolveContextBudgetPolicy(input: Readonly<{
  capability: AgentModelContextCapability;
  requestedOutputTokens: number;
  configuredWorkingWindow?: number | null;
  safetyReserveTokens?: number;
  memoryResultCeilingBytes?: number;
}>): ContextBudgetPolicy {
  validateCapability(input.capability);
  assertPositiveInteger(input.requestedOutputTokens, 'requestedOutputTokens');
  const providerWindow = input.capability.contextWindow;
  const configured = normalizeOptionalWindow(input.configuredWorkingWindow);
  const workingWindow = configured === null ? providerWindow : Math.min(providerWindow, configured);
  const requestedOutputTokens = Math.min(
    input.requestedOutputTokens,
    input.capability.maxOutputTokens,
  );
  const safetyReserveTokens = input.safetyReserveTokens === undefined
    ? Math.min(DEFAULT_CONTEXT_SAFETY_RESERVE_TOKENS, Math.max(1_024, Math.floor(workingWindow / 64)))
    : input.safetyReserveTokens;
  assertPositiveInteger(safetyReserveTokens, 'safetyReserveTokens');
  const hardLimit = workingWindow - requestedOutputTokens - safetyReserveTokens;
  if (hardLimit <= 0) throw new RangeError('Context capability cannot fit output and safety reserves.');
  const compactionReserveTokens = Math.min(
    MAX_CONTEXT_COMPACTION_RESERVE_TOKENS,
    Math.max(4_096, Math.floor(workingWindow / 8)),
  );
  const softLimit = Math.max(0, hardLimit - compactionReserveTokens);
  const keepRecentTokens = Math.min(MAX_CONTEXT_KEEP_RECENT_TOKENS, Math.floor(softLimit / 2));
  const summaryInputCap = Math.max(
    0,
    workingWindow - SUMMARY_MAX_OUTPUT_TOKENS - safetyReserveTokens,
  );
  const memoryResultCeilingBytes = input.memoryResultCeilingBytes
    ?? DEFAULT_CONTEXT_RESULT_MEMORY_CEILING_BYTES;
  assertPositiveInteger(memoryResultCeilingBytes, 'memoryResultCeilingBytes');
  const policyRevision = [
    CONTEXT_BUDGET_POLICY_REVISION,
    input.capability.capabilityRevision,
    workingWindow,
    requestedOutputTokens,
    safetyReserveTokens,
    memoryResultCeilingBytes,
  ].join(':');
  return Object.freeze({
    providerWindow,
    workingWindow,
    requestedOutputTokens,
    safetyReserveTokens,
    compactionReserveTokens,
    softLimit,
    hardLimit,
    keepRecentTokens,
    summaryMaxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    summaryInputCap,
    memoryResultCeilingBytes,
    capabilitySource: input.capability.source,
    capabilityRevision: input.capability.capabilityRevision,
    policyRevision,
    effectiveWindow: workingWindow,
    recentHistoryTarget: keepRecentTokens,
  });
}

function validateCapability(capability: AgentModelContextCapability): void {
  if (capability.schemaVersion !== 1) throw new TypeError('Unsupported context capability schema.');
  assertPositiveInteger(capability.contextWindow, 'contextWindow');
  assertPositiveInteger(capability.maxOutputTokens, 'maxOutputTokens');
  if (capability.maxOutputTokens > capability.contextWindow) {
    throw new RangeError('Model maximum output cannot exceed its context window.');
  }
  if (!capability.capabilityRevision || !capability.sourceRevision) {
    throw new TypeError('Context capability revisions must be nonempty.');
  }
}

function normalizeOptionalWindow(value: number | null | undefined): number | null {
  if (value == null) return null;
  assertPositiveInteger(value, 'configuredWorkingWindow');
  return value;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

export function shouldCompact(
  estimate: ContextEstimate,
  profile: ContextBudgetPolicy,
): boolean {
  return estimate.inputTokens >= profile.softLimit;
}

export function isWithinHardLimit(
  estimate: ContextEstimate,
  profile: Pick<ContextBudgetProfile, 'hardLimit'>,
): boolean {
  return estimate.inputTokens <= profile.hardLimit;
}

export type ContextPreflight = (ContextEstimate | ContextUsageEstimate) & {
  accepted: boolean;
};

export function preflightContextRequest(
  input: ContextEstimateInput & { latestUsage?: ProviderUsageAnchor | null },
  profile: Pick<ContextBudgetProfile, 'hardLimit'>,
): ContextPreflight {
  const estimate = input.latestUsage === undefined
    ? estimateContext(input)
    : estimateContextWithUsage(input);
  return {
    ...estimate,
    accepted: isWithinHardLimit(estimate, profile),
  };
}

export function isWithinSummaryInputCap(
  inputTokens: number,
  profile: Pick<ContextBudgetProfile, 'summaryInputCap'>,
): boolean {
  return inputTokens <= profile.summaryInputCap;
}

export function isSummaryRequestWithinEffectiveWindow(
  inputTokens: number,
  profile: Pick<ContextBudgetPolicy, 'workingWindow' | 'safetyReserveTokens'>,
): boolean {
  return (
    inputTokens + SUMMARY_MAX_OUTPUT_TOKENS + SUMMARY_SAFETY_TOKENS <=
    profile.workingWindow - profile.safetyReserveTokens
  );
}
