export function providerPrefixTokens(estimate: object): number | null {
  return 'providerPrefixTokens' in estimate
    && (typeof estimate.providerPrefixTokens === 'number'
      || estimate.providerPrefixTokens === null)
    ? estimate.providerPrefixTokens
    : null;
}

export function deterministicInputTokens(estimate: { inputTokens: number }): number {
  return 'deterministicInputTokens' in estimate
    && typeof estimate.deterministicInputTokens === 'number'
    ? estimate.deterministicInputTokens
    : estimate.inputTokens;
}

export function usageAdjustmentTokens(estimate: { inputTokens: number }): number {
  return Math.max(0, estimate.inputTokens - deterministicInputTokens(estimate));
}
