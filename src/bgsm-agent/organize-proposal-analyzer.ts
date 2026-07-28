import type {
  ModelProvider,
  ModelResponse,
  ModelToolChoice,
  PreparedModelRequest,
} from '@/agent-harness/provider';
import { AgentProviderError } from '@/agent-harness/provider';
import type { AgentToolDefinition } from '@/agent-harness/tools';
import { canonicalJson } from '@/agent-harness/canonical-json';
import {
  emitAgentExecutionTrace,
  traceAgentProviderError,
  traceAgentProviderStreamEvent,
  type AgentExecutionTraceSink,
  type AgentTraceProviderIdentity,
  type AgentTraceProviderRequestIdentity,
} from '@/agent-harness/trace';
import {
  ANALYZER_OUTPUT_TOKENS_DEFAULT,
  ANALYZER_OUTPUT_TOKENS_HARD_LIMIT,
} from './policy';
import {
  ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME,
  validateAnalyzerBatchProposal,
  type AnalyzerBatchProposal,
} from './proposal';
import type { RunId } from './identity';
import type { ScopeFingerprintV1 } from './scope';
import type { SemanticRepositoryDto, SemanticTaxonomyDto } from './semantic-dto';
import type { BudgetExhaustionReason, ProviderActualTokenTelemetry } from './policy';

export const MAX_ANALYZER_TASK_INSTRUCTION_BYTES = 4_096;
export const MAX_ANALYZER_RETRY_DETAIL_BYTES = 512;

export type SemanticAnalyzerBatch = Readonly<{
  version: 1;
  runId: RunId;
  generation: number;
  scopeFingerprint: ScopeFingerprintV1;
  taskInstruction: string;
  repositories: readonly SemanticRepositoryDto[];
  taxonomy: SemanticTaxonomyDto;
}>;

export type PreparedAnalyzerAttempt = Readonly<{
  attempt: 1 | 2;
  batch: SemanticAnalyzerBatch;
  requestedOutputTokens: number;
  serializedRequestBody: string;
  serializedRequestBytes: number;
  execute(signal?: AbortSignal): Promise<AnalyzerAttemptSuccess>;
}>;

export type AnalyzerAttemptSuccess = Readonly<{
  proposal: AnalyzerBatchProposal;
  telemetry: ProviderActualTokenTelemetry;
}>;

export type AnalyzerReservationDecision =
  | Readonly<{ status: 'admitted'; signal?: AbortSignal }>
  | Readonly<{ status: 'budget_exhausted'; reason: BudgetExhaustionReason }>;

export type AnalyzerRunResult =
  | Readonly<{ status: 'success'; value: AnalyzerAttemptSuccess; attempts: 1 | 2 }>
  | Readonly<{
      status: 'analysis_failed';
      attempts: 2;
      firstError: AnalyzerAttemptError;
      secondError: AnalyzerAttemptError;
    }>
  | Readonly<{
      status: 'budget_exhausted';
      attempts: 0 | 1;
      reason: BudgetExhaustionReason;
    }>;

export class AnalyzerAttemptError extends Error {
  readonly causeValue: unknown;
  readonly failureKind: 'output_contract' | 'provider';

  constructor(
    message: string,
    causeValue?: unknown,
    failureKind: 'output_contract' | 'provider' = 'output_contract',
  ) {
    super(message);
    this.name = 'AnalyzerAttemptError';
    this.causeValue = causeValue;
    this.failureKind = failureKind;
  }
}

export function analyzerOutputTokensForRepositoryCount(
  maximum: number,
  repositoryCount: number,
): number {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new TypeError('Analyzer maximum output tokens must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(repositoryCount) || repositoryCount <= 0 || repositoryCount > 50) {
    throw new TypeError('Analyzer repository count must be between one and 50.');
  }
  return Math.min(maximum, 512 + 160 * repositoryCount);
}

export function shouldSplitAnalyzerFailure(
  result: Extract<AnalyzerRunResult, { status: 'analysis_failed' }>,
): boolean {
  return [result.firstError, result.secondError].every((error) => {
    if (error.failureKind === 'output_contract') return true;
    const cause = error.causeValue;
    return cause instanceof AgentProviderError && [
      'context_overflow',
      'provider_request_too_large',
      'provider_response_too_large',
    ].includes(cause.code);
  });
}

const ANALYZER_TOOL: AgentToolDefinition = Object.freeze({
  name: ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME,
  description: 'Submit the semantic-tag classification for every repository in this batch.',
  risk: 'suggest',
  parameters: {
    type: 'object',
    properties: {
      version: { const: 1 },
      runId: { type: 'string' },
      generation: { type: 'integer', minimum: 0 },
      scopeFingerprint: { type: 'string' },
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            frozenIndex: { type: 'integer', minimum: 0 },
            repositoryId: { type: 'string', minLength: 1 },
            sourceFingerprint: { type: 'string' },
            classifications: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              items: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      kind: { enum: ['add_existing_tag', 'propose_new_tag'] },
                      tag: { type: 'string', minLength: 1 },
                      evidence: { type: 'string', minLength: 1 },
                    },
                    required: ['kind', 'tag', 'evidence'],
                    additionalProperties: false,
                  },
                  {
                    type: 'object',
                    properties: {
                      kind: { enum: ['unchanged', 'insufficient_evidence'] },
                      evidence: { type: 'string', minLength: 1 },
                    },
                    required: ['kind', 'evidence'],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ['frozenIndex', 'repositoryId', 'sourceFingerprint', 'classifications'],
          additionalProperties: false,
        },
      },
    },
    required: ['version', 'runId', 'generation', 'scopeFingerprint', 'rows'],
    additionalProperties: false,
  },
});

export class OrganizeProposalAnalyzer {
  readonly requestedOutputTokens: number;
  readonly toolChoice: Exclude<ModelToolChoice, 'auto'>;
  private readonly provider: ModelProvider;
  private readonly trace?: AgentExecutionTraceSink;
  private readonly traceProvider?: AgentTraceProviderIdentity;
  private readonly now: () => number;
  private readonly createRequestId: () => string;

  constructor(input: Readonly<{
    provider: ModelProvider;
    requestedOutputTokens?: number;
    toolChoice?: 'required' | Readonly<{ name: typeof ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME }>;
    trace?: AgentExecutionTraceSink;
    traceProvider?: AgentTraceProviderIdentity;
    now?: () => number;
    createRequestId?: () => string;
  }>) {
    if (typeof input.provider.prepare !== 'function') {
      throw new AnalyzerAttemptError('Provider does not support exact prepared-request accounting.');
    }
    const requestedOutputTokens = input.requestedOutputTokens ?? ANALYZER_OUTPUT_TOKENS_DEFAULT;
    if (
      !Number.isSafeInteger(requestedOutputTokens) ||
      requestedOutputTokens <= 0 ||
      requestedOutputTokens > ANALYZER_OUTPUT_TOKENS_HARD_LIMIT
    ) {
      throw new RangeError('Analyzer output budget must be between 1 and 8192 tokens.');
    }
    const toolChoice = input.toolChoice ?? { name: ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME };
    if (typeof toolChoice === 'object' && toolChoice.name !== ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME) {
      throw new TypeError('Analyzer named tool choice must select its sole proposal tool.');
    }
    this.provider = input.provider;
    this.requestedOutputTokens = requestedOutputTokens;
    this.toolChoice = toolChoice;
    this.trace = input.trace;
    this.traceProvider = input.traceProvider;
    this.now = input.now ?? Date.now;
    this.createRequestId = input.createRequestId ?? organizeAnalyzerTraceId;
  }

  requestedOutputTokensForRepositoryCount(repositoryCount: number): number {
    return analyzerOutputTokensForRepositoryCount(this.requestedOutputTokens, repositoryCount);
  }

  prepareAttempt(
    batch: SemanticAnalyzerBatch,
    attempt: 1 | 2 = 1,
    retryDetail?: string,
  ): PreparedAnalyzerAttempt {
    validateBatch(batch);
    if (attempt === 1 && retryDetail !== undefined) {
      throw new TypeError('Initial analyzer attempts cannot carry retry metadata.');
    }
    const retry = attempt === 2
      ? Object.freeze({
          attempt: 2,
          previousResult: 'invalid_or_failed',
          instruction: boundUtf8(
            retryDetail?.trim() || 'Return exactly one schema-valid proposal tool call.',
            MAX_ANALYZER_RETRY_DETAIL_BYTES,
          ),
        })
      : null;
    const messages = [
      {
        role: 'system' as const,
        content: 'Classify each repository once. Use only the declared proposal tool. Do not write data.',
      },
      {
        role: 'user' as const,
        content: canonicalJson(Object.freeze({ batch, retry })),
      },
    ];
    const requestIdentity = Object.freeze({
      requestId: `provider_request:${this.createRequestId()}`,
      requestKind: 'organize_analysis',
      providerStep: null,
      requestAttempt: attempt,
    }) satisfies AgentTraceProviderRequestIdentity;
    const requestTiming: { startedAt: number | null } = { startedAt: null };
    const requestedOutputTokens = this.requestedOutputTokensForRepositoryCount(batch.repositories.length);
    const prepared = this.provider.prepare!({
      messages,
      tools: [ANALYZER_TOOL],
      toolChoice: this.toolChoice,
      maxOutputTokens: requestedOutputTokens,
      onStreamEvent: (event) => {
        if (requestTiming.startedAt === null) return;
        traceAgentProviderStreamEvent(
          this.trace,
          event,
          requestIdentity,
          requestTiming.startedAt,
          this.now,
        );
      },
    });
    return exposePreparedAttempt(
      prepared,
      batch,
      attempt,
      requestedOutputTokens,
      {
        trace: this.trace,
        traceProvider: this.traceProvider,
        requestIdentity,
        now: this.now,
        requestTiming,
        fallbackHistoryBytes: new TextEncoder().encode(canonicalJson(messages)).byteLength,
      },
    );
  }

  async analyzeWithSingleRetry(
    batch: SemanticAnalyzerBatch,
    reserve: (
      attempt: PreparedAnalyzerAttempt,
    ) => AnalyzerReservationDecision | Promise<AnalyzerReservationDecision>,
  ): Promise<AnalyzerRunResult> {
    const first = this.prepareAttempt(batch, 1);
    const firstReservation = await reserve(first);
    if (firstReservation.status === 'budget_exhausted') {
      return Object.freeze({ status: 'budget_exhausted', attempts: 0, reason: firstReservation.reason });
    }
    try {
      const value = await first.execute(firstReservation.signal);
      return Object.freeze({ status: 'success', value, attempts: 1 });
    } catch (error) {
      const firstError = normalizeAttemptError(error);
      if (firstReservation.signal?.aborted) throw firstError;
      const second = this.prepareAttempt(batch, 2, firstError.message);
      const secondReservation = await reserve(second);
      if (secondReservation.status === 'budget_exhausted') {
        return Object.freeze({
          status: 'budget_exhausted',
          attempts: 1,
          reason: secondReservation.reason,
        });
      }
      try {
        const value = await second.execute(secondReservation.signal);
        return Object.freeze({ status: 'success', value, attempts: 2 });
      } catch (secondError) {
        return Object.freeze({
          status: 'analysis_failed',
          attempts: 2,
          firstError,
          secondError: normalizeAttemptError(secondError),
        });
      }
    }
  }
}

function exposePreparedAttempt(
  prepared: PreparedModelRequest,
  batch: SemanticAnalyzerBatch,
  attempt: 1 | 2,
  requestedOutputTokens: number,
  tracing: Readonly<{
    trace?: AgentExecutionTraceSink;
    traceProvider?: AgentTraceProviderIdentity;
    requestIdentity: AgentTraceProviderRequestIdentity;
    now: () => number;
    requestTiming: { startedAt: number | null };
    fallbackHistoryBytes: number;
  }>,
): PreparedAnalyzerAttempt {
  return Object.freeze({
    attempt,
    batch,
    requestedOutputTokens,
    serializedRequestBody: prepared.serializedRequestBody,
    serializedRequestBytes: prepared.serializedRequestBytes,
    async execute(signal?: AbortSignal): Promise<AnalyzerAttemptSuccess> {
      const requestStartedAt = tracing.trace ? tracing.now() : 0;
      tracing.requestTiming.startedAt = requestStartedAt;
      if (tracing.traceProvider) {
        emitAgentExecutionTrace(tracing.trace, {
          kind: 'provider_request_prepared',
          ...tracing.requestIdentity,
          ...tracing.traceProvider,
          requestBytes: prepared.inspection?.serializedRequestBytes ?? prepared.serializedRequestBytes,
          historyBytes: prepared.inspection?.serializedHistoryBytes ?? tracing.fallbackHistoryBytes,
          estimatedInputTokens: null,
          maxOutputTokens: requestedOutputTokens,
        });
      }
      let response: ModelResponse;
      try {
        response = await prepared.execute(signal);
      } catch (error) {
        traceAgentProviderError(tracing.trace, error, tracing.requestIdentity);
        throw normalizeAttemptError(error);
      } finally {
        tracing.requestTiming.startedAt = null;
      }
      if (response.usage) {
        emitAgentExecutionTrace(tracing.trace, {
          kind: 'provider_usage',
          ...tracing.requestIdentity,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          source: 'provider',
        });
      }
      emitAgentExecutionTrace(tracing.trace, {
        kind: 'provider_finished',
        ...tracing.requestIdentity,
        finishReason: response.finishReason || 'unknown',
        durationMs: Math.max(0, tracing.now() - requestStartedAt),
      });
      return Object.freeze({
        proposal: parseAnalyzerResponse(response),
        telemetry: normalizeTelemetry(response),
      });
    },
  });
}

function parseAnalyzerResponse(response: ModelResponse): AnalyzerBatchProposal {
  if (response.refusal !== undefined || response.finishReason !== 'tool_calls') {
    throw new AnalyzerAttemptError('Analyzer response did not finish with one proposal tool call.');
  }
  if (response.content?.trim()) {
    throw new AnalyzerAttemptError('Analyzer response mixed prose with the proposal tool call.');
  }
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length !== 1) {
    throw new AnalyzerAttemptError('Analyzer response must contain exactly one tool call.');
  }
  const [call] = response.toolCalls;
  if (!call || !call.id.trim() || call.name !== ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME) {
    throw new AnalyzerAttemptError('Analyzer response used an invalid proposal tool call.');
  }
  try {
    validateAnalyzerBatchProposal(call.arguments);
  } catch (error) {
    throw new AnalyzerAttemptError('Analyzer proposal arguments failed schema validation.', error);
  }
  return deepFreeze(call.arguments);
}

function validateBatch(batch: SemanticAnalyzerBatch): void {
  if (!batch.taskInstruction.trim() || batch.taskInstruction.trim() !== batch.taskInstruction) {
    throw new TypeError('Analyzer task instruction must be trimmed and nonempty.');
  }
  if (new TextEncoder().encode(batch.taskInstruction).byteLength > MAX_ANALYZER_TASK_INSTRUCTION_BYTES) {
    throw new RangeError('Analyzer task instruction exceeds 4096 UTF-8 bytes.');
  }
  if (!Array.isArray(batch.repositories) || batch.repositories.length === 0 || batch.repositories.length > 50) {
    throw new RangeError('Analyzer batch must contain between one and 50 repositories.');
  }
  const indices = new Set<number>();
  const ids = new Set<string>();
  for (const repository of batch.repositories) {
    if (indices.has(repository.frozenIndex) || ids.has(repository.repositoryId)) {
      throw new TypeError('Analyzer repository DTOs must be unique.');
    }
    indices.add(repository.frozenIndex);
    ids.add(repository.repositoryId);
  }
}

function normalizeTelemetry(response: ModelResponse): ProviderActualTokenTelemetry {
  return Object.freeze({
    inputTokens: response.usage?.inputTokens ?? null,
    outputTokens: response.usage?.outputTokens ?? null,
    totalTokens: response.usage?.totalTokens ?? null,
  });
}

function normalizeAttemptError(error: unknown): AnalyzerAttemptError {
  if (error instanceof AnalyzerAttemptError) return error;
  return new AnalyzerAttemptError('Analyzer provider attempt failed.', error, 'provider');
}

function boundUtf8(value: string, maximum: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximum) return value;
  let result = '';
  for (const codePoint of value) {
    if (encoder.encode(result + codePoint).byteLength > maximum) break;
    result += codePoint;
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function organizeAnalyzerTraceId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
