import type { ToolResult } from './results';

export type ExecutionLedgerState =
  | 'authorized'
  | 'started'
  | 'committed'
  | 'failed'
  | 'unknown';

export type AgentWriteSettlement = 'none' | 'all_failed' | 'unsafe';

/** A stable, exact identity for one logical side effect. */
export type CanonicalToolEffect = readonly [string, ...string[]];

export type WriteEffectPlan<TArgs = unknown, TResult = unknown> = Readonly<{
  canonicalEffects: (args: TArgs) => readonly CanonicalToolEffect[];
  /** Select only effects that have not already been committed. */
  selectEffects?: (args: TArgs, effects: readonly CanonicalToolEffect[]) => TArgs;
  /** Produce a small, safe result when every requested effect is already committed. */
  replayResult?: (args: TArgs) => TResult;
  /** Classify a resolved tool value without inspecting transport or error text. */
  classifyResult?: (result: TResult) => 'committed' | 'failed';
  /** Most write tools enter their side effect in execute(); delegated writers mark it later. */
  startBoundary?: 'tool' | 'delegated';
}>;

export type LedgerInspection = Readonly<{
  kind: 'execute' | 'replay_call' | 'replay_effects' | 'conflict' | 'blocked';
  newEffects: readonly CanonicalToolEffect[];
  committedEffects: readonly CanonicalToolEffect[];
  state?: ExecutionLedgerState;
  result?: ToolResult;
  reason?: 'call_conflict' | 'effect_unknown' | 'effect_in_flight';
}>;

type CallReceipt = {
  toolName: string;
  argsKey: string;
  effects: readonly CanonicalToolEffect[];
  selectedEffects: readonly CanonicalToolEffect[];
  state: ExecutionLedgerState;
  result?: ToolResult;
};

type EffectReceipt = {
  state: ExecutionLedgerState;
};

/**
 * In-process facts for one background turn attempt. This deliberately avoids
 * durable state and the transcript: a service-worker restart must lose it and
 * report attempt_state_lost instead of replaying an uncertain write.
 */
export class AgentExecutionLedger {
  private readonly calls = new Map<string, CallReceipt>();
  private readonly effects = new Map<string, EffectReceipt>();

  inspect(input: Readonly<{
    callId: string;
    toolName: string;
    args: unknown;
    effects: readonly CanonicalToolEffect[];
  }>): LedgerInspection {
    const argsKey = stableJson(input.args);
    const effectKeys = uniqueEffectKeys(input.effects);
    const effects = effectKeys.map((key) => parseEffectKey(key));
    const existing = this.calls.get(input.callId);
    if (existing) {
      if (existing.toolName !== input.toolName || existing.argsKey !== argsKey) {
        return {
          kind: 'conflict',
          newEffects: [],
          committedEffects: [],
          reason: 'call_conflict',
        };
      }
      if (existing.result && (existing.state === 'committed' || existing.state === 'failed')) {
        return {
          kind: 'replay_call',
          newEffects: [],
          committedEffects: existing.effects,
          state: existing.state,
          result: existing.result,
        };
      }
      return {
        kind: 'blocked',
        newEffects: [],
        committedEffects: [],
        state: existing.state,
        reason: existing.state === 'unknown' ? 'effect_unknown' : 'effect_in_flight',
      };
    }

    const committedEffects: CanonicalToolEffect[] = [];
    const newEffects: CanonicalToolEffect[] = [];
    for (const effect of effects) {
      const receipt = this.effects.get(effectKey(effect));
      if (receipt?.state === 'unknown' || receipt?.state === 'started' || receipt?.state === 'authorized') {
        return {
          kind: 'blocked',
          newEffects: [],
          committedEffects,
          state: receipt.state,
          reason: receipt.state === 'unknown' ? 'effect_unknown' : 'effect_in_flight',
        };
      }
      if (receipt?.state === 'committed') committedEffects.push(effect);
      else newEffects.push(effect);
    }

    if (newEffects.length === 0) {
      return {
        kind: 'replay_effects',
        newEffects: [],
        committedEffects,
      };
    }
    return { kind: 'execute', newEffects, committedEffects };
  }

  authorize(input: Readonly<{
    callId: string;
    toolName: string;
    args: unknown;
    effects: readonly CanonicalToolEffect[];
    selectedEffects: readonly CanonicalToolEffect[];
  }>): void {
    const receipt: CallReceipt = {
      toolName: input.toolName,
      argsKey: stableJson(input.args),
      effects: dedupeEffects(input.effects),
      selectedEffects: dedupeEffects(input.selectedEffects),
      state: 'authorized',
    };
    this.calls.set(input.callId, receipt);
    for (const effect of receipt.selectedEffects) {
      this.effects.set(effectKey(effect), { state: 'authorized' });
    }
  }

  markStarted(callId: string): void {
    const receipt = this.requireCall(callId);
    receipt.state = 'started';
    for (const effect of receipt.selectedEffects) {
      this.effects.set(effectKey(effect), { state: 'started' });
    }
  }

  settle(callId: string, state: Extract<ExecutionLedgerState, 'committed' | 'failed' | 'unknown'>): void {
    const receipt = this.requireCall(callId);
    receipt.state = state;
    for (const effect of receipt.selectedEffects) {
      this.effects.set(effectKey(effect), { state });
    }
  }

  storeResult(callId: string, result: ToolResult): void {
    const receipt = this.requireCall(callId);
    receipt.result = result;
  }

  stateForEffect(effect: CanonicalToolEffect): ExecutionLedgerState | undefined {
    return this.effects.get(effectKey(effect))?.state;
  }

  stateForCall(callId: string): ExecutionLedgerState | undefined {
    return this.calls.get(callId)?.state;
  }

  writeSettlement(): AgentWriteSettlement {
    const writeReceipts = [...this.calls.values()].filter(
      (receipt) => receipt.selectedEffects.length > 0,
    );
    if (writeReceipts.length === 0) return 'none';
    return writeReceipts.every((receipt) => receipt.state === 'failed')
      ? 'all_failed'
      : 'unsafe';
  }

  private requireCall(callId: string): CallReceipt {
    const receipt = this.calls.get(callId);
    if (!receipt) throw new Error(`Execution ledger call is not authorized: ${callId}`);
    return receipt;
  }
}

export function effectKey(effect: CanonicalToolEffect): string {
  return stableJson(effect);
}

function dedupeEffects(effects: readonly CanonicalToolEffect[]): CanonicalToolEffect[] {
  return uniqueEffectKeys(effects).map((key) => parseEffectKey(key));
}

function uniqueEffectKeys(effects: readonly CanonicalToolEffect[]): string[] {
  return Array.from(new Set(effects.map(effectKey)));
}

function parseEffectKey(key: string): CanonicalToolEffect {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.some((part) => typeof part !== 'string')) {
    throw new TypeError('Execution ledger effect must be a string tuple.');
  }
  return parsed as unknown as CanonicalToolEffect;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Execution ledger arguments must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError('Execution ledger arguments must be JSON-compatible.');
}
