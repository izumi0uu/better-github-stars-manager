import type {
  ModelProvider,
  ModelResponse,
  ModelToolChoice,
  PreparedModelRequest,
} from '@/agent-harness/provider';
import { AgentProviderError } from '@/agent-harness/provider';
import {
  createAgentTurnLiveness,
  publicAgentLivenessTimeoutMessage,
  type AgentProviderRequestLiveness,
} from '@/agent-harness/liveness';
import type { AgentToolDefinition } from '@/agent-harness/tools';
import type { ModelStreamEvent } from '@/agent-harness/provider-stream';
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
  validateOrganizeTagPolicySnapshot,
} from './policy';
import {
  ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME,
  validateAnalyzerBatchProposal,
  type AnalyzerBatchProposal,
} from './proposal';
import type { RunId } from './identity';
import type { ScopeFingerprint } from './scope';
import type { SemanticRepositoryDto, SemanticTaxonomyDto } from './semantic-dto';
import type { BudgetExhaustionReason, ProviderActualTokenTelemetry } from './policy';
import type { OrganizeTagPolicySnapshot } from '@/types';

export const MAX_ANALYZER_TASK_INSTRUCTION_BYTES = 4_096;
export const MAX_ANALYZER_RETRY_DETAIL_BYTES = 1_024;
const MAX_ANALYZER_RETRY_INDEXES_PER_FIELD = 64;

export type AnalyzerRejectionCode =
  | 'response'
  | 'tool_call_count'
  | 'mixed_content'
  | 'row_coverage'
  | 'row_identity'
  | 'batch_identity'
  | 'classification'
  | 'schema';

export type AnalyzerRetryDiagnostic = Readonly<{
  category: 'response_contract' | 'proposal_contract';
  rejectionCode: AnalyzerRejectionCode;
  expectedRowCount: number;
  receivedRowCount: number | null;
  batchIdentityMismatch: boolean;
  missingFrozenIndexes: readonly number[];
  duplicateFrozenIndexes: readonly number[];
  unexpectedFrozenIndexes: readonly number[];
  identityMismatchFrozenIndexes: readonly number[];
  schemaViolation: string | null;
  truncated: boolean;
}>;

export type SemanticAnalyzerBatch = Readonly<{
  version: 1;
  runId: RunId;
  generation: number;
  scopeFingerprint: ScopeFingerprint;
  taskInstruction: string;
  tagPolicy: OrganizeTagPolicySnapshot;
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
      attempts: 0 | 1 | 2;
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
  readonly diagnostic: AnalyzerRetryDiagnostic | null;

  constructor(
    message: string,
    causeValue?: unknown,
    failureKind: 'output_contract' | 'provider' = 'output_contract',
    diagnostic: AnalyzerRetryDiagnostic | null = null,
  ) {
    super(message);
    this.name = 'AnalyzerAttemptError';
    this.causeValue = causeValue;
    this.failureKind = failureKind;
    this.diagnostic = diagnostic;
  }
}

class AnalyzerPreparationError extends AnalyzerAttemptError {
  constructor(causeValue: unknown) {
    super('Analyzer Provider request preparation failed.', causeValue, 'provider');
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

export function canDegradeAnalyzerFailure(
  result: Extract<AnalyzerRunResult, { status: 'analysis_failed' }>,
): boolean {
  return [result.firstError, result.secondError]
    .every((error) => error.failureKind === 'output_contract');
}

function analyzerToolForBatch(batch: SemanticAnalyzerBatch): AgentToolDefinition {
  const actionableClassification = {
    type: 'object',
    properties: {
      kind: { enum: ['add_existing_tag', 'propose_new_tag'] },
      tag: { type: 'string', minLength: 1 },
      evidence: { type: 'string', minLength: 1 },
    },
    required: ['kind', 'tag', 'evidence'],
    additionalProperties: false,
  };
  const nonActionableClassification = {
    type: 'object',
    properties: {
      kind: { enum: ['unchanged', 'insufficient_evidence'] },
      evidence: { type: 'string', minLength: 1 },
    },
    required: ['kind', 'evidence'],
    additionalProperties: false,
  };
  return deepFreeze({
    name: ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME,
    description: 'Submit the semantic-tag classification for every repository in this batch.',
    risk: 'suggest',
    parameters: {
      type: 'object',
      properties: {
        version: { const: batch.version },
        runId: { const: batch.runId },
        generation: { const: batch.generation },
        scopeFingerprint: { const: batch.scopeFingerprint },
        rows: {
          type: 'array',
          minItems: batch.repositories.length,
          maxItems: batch.repositories.length,
          items: {
            type: 'object',
            properties: {
              frozenIndex: { type: 'integer', minimum: 0 },
              repositoryId: { type: 'string', minLength: 1 },
              sourceFingerprint: { type: 'string' },
              classifications: {
                oneOf: [
                  {
                    type: 'array',
                    minItems: 1,
                    maxItems: batch.tagPolicy.maxTagsPerRepo,
                    items: actionableClassification,
                  },
                  {
                    type: 'array',
                    minItems: 1,
                    maxItems: 1,
                    items: nonActionableClassification,
                  },
                ],
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
}

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
    previousError?: AnalyzerAttemptError,
    onProgress?: (completedRows: number) => void,
  ): PreparedAnalyzerAttempt {
    validateBatch(batch);
    if (attempt === 1 && previousError !== undefined) {
      throw new TypeError('Initial analyzer attempts cannot carry retry metadata.');
    }
    const retryCorrection = previousError?.failureKind === 'provider'
      ? null
      : sanitizeRetryDiagnostic(previousError?.diagnostic, batch);
    const retry = attempt === 2
      ? Object.freeze({
          attempt: 2,
          previousResult: previousError?.failureKind === 'provider'
            ? 'provider_error'
            : 'invalid_output_contract',
          instruction: retryCorrection
            ? 'Correct every listed violation in retry.correction and return exactly one proposal tool call for the unchanged batch.'
            : 'Retry the unchanged batch and return exactly one proposal tool call.',
          correction: retryCorrection,
        })
      : null;
    const messages = [
      {
        role: 'system' as const,
        content: 'Classify each repository exactly once. Use only the declared proposal tool. When retry.correction is present, correct every listed violation for the unchanged batch. Do not write data.',
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
    const streamLiveness: { current: AgentProviderRequestLiveness | null } = { current: null };
    const rowProgress = new StreamedProposalRowProgress(batch.repositories.length, onProgress);
    const requestedOutputTokens = this.requestedOutputTokensForRepositoryCount(batch.repositories.length);
    let prepared: PreparedModelRequest;
    try {
      prepared = this.provider.prepare!({
        messages,
        tools: [analyzerToolForBatch(batch)],
        toolChoice: this.toolChoice,
        maxOutputTokens: requestedOutputTokens,
        onStreamEvent: (event) => {
          streamLiveness.current?.observeStreamEvent(event);
          rowProgress.observe(event);
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
    } catch (error) {
      throw new AnalyzerPreparationError(error);
    }
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
        streamLiveness,
        fallbackHistoryBytes: new TextEncoder().encode(canonicalJson(messages)).byteLength,
      },
    );
  }

  async analyzeWithSingleRetry(
    batch: SemanticAnalyzerBatch,
    reserve: (
      attempt: PreparedAnalyzerAttempt,
    ) => AnalyzerReservationDecision | Promise<AnalyzerReservationDecision>,
    onProgress?: (completedRows: number) => void,
  ): Promise<AnalyzerRunResult> {
    let progressHighWater = 0;
    const reportProgress = onProgress
      ? (completedRows: number) => {
          if (completedRows <= progressHighWater) return;
          progressHighWater = completedRows;
          onProgress(completedRows);
        }
      : undefined;
    let first: PreparedAnalyzerAttempt;
    try {
      first = this.prepareAttempt(batch, 1, undefined, reportProgress);
    } catch (error) {
      if (!(error instanceof AnalyzerPreparationError)) throw error;
      return analysisFailed(0, error, error);
    }
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
      let second: PreparedAnalyzerAttempt;
      try {
        second = this.prepareAttempt(batch, 2, firstError, reportProgress);
      } catch (secondError) {
        if (!(secondError instanceof AnalyzerPreparationError)) throw secondError;
        return analysisFailed(1, firstError, secondError);
      }
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
        return analysisFailed(2, firstError, normalizeAttemptError(secondError));
      }
    }
  }
}

function analysisFailed(
  attempts: 0 | 1 | 2,
  firstError: AnalyzerAttemptError,
  secondError: AnalyzerAttemptError,
): Extract<AnalyzerRunResult, { status: 'analysis_failed' }> {
  return Object.freeze({ status: 'analysis_failed', attempts, firstError, secondError });
}

class StreamedProposalRowProgress {
  private toolIndex: number | null = null;
  private readonly rows: StreamedRowsArrayCounter;

  constructor(maximumRows: number, onProgress?: (completedRows: number) => void) {
    this.rows = new StreamedRowsArrayCounter(maximumRows, onProgress);
  }

  observe(event: ModelStreamEvent): void {
    if (
      event.type === 'tool_call_start'
      && this.toolIndex === null
      && event.name === ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME
    ) {
      this.toolIndex = event.index;
      return;
    }
    if (event.type === 'tool_call_arguments_delta' && event.index === this.toolIndex) {
      this.rows.push(event.delta);
    }
  }
}

class StreamedRowsArrayCounter {
  private readonly stack: Array<'object' | 'array'> = [];
  private inString = false;
  private escaped = false;
  private stringToken = '';
  private rowsKeyState: 'none' | 'key' | 'colon' = 'none';
  private rowsArrayDepth: number | null = null;
  private directRowDepth: number | null = null;
  private completedRows = 0;

  constructor(
    private readonly maximumRows: number,
    private readonly onProgress?: (completedRows: number) => void,
  ) {}

  push(delta: string): void {
    for (const character of delta) this.consume(character);
  }

  private consume(character: string): void {
    if (this.inString) {
      if (this.escaped) {
        this.stringToken += character;
        this.escaped = false;
        return;
      }
      if (character === '\\') {
        this.stringToken += character;
        this.escaped = true;
        return;
      }
      if (character === '"') {
        this.inString = false;
        if (
          this.rowsArrayDepth === null
          && this.stack.length === 1
          && this.stack[0] === 'object'
          && decodeJsonString(this.stringToken) === 'rows'
        ) {
          this.rowsKeyState = 'key';
        }
        this.stringToken = '';
        return;
      }
      this.stringToken += character;
      return;
    }

    if (/\s/u.test(character)) return;
    if (this.rowsArrayDepth === null && this.rowsKeyState === 'key') {
      if (character === ':') {
        this.rowsKeyState = 'colon';
        return;
      }
      this.rowsKeyState = 'none';
    } else if (this.rowsArrayDepth === null && this.rowsKeyState === 'colon') {
      if (character === '[' && this.stack.length === 1 && this.stack[0] === 'object') {
        this.stack.push('array');
        this.rowsArrayDepth = this.stack.length;
        this.rowsKeyState = 'none';
        return;
      }
      this.rowsKeyState = 'none';
    }

    if (character === '"') {
      this.inString = true;
      this.stringToken = '';
      return;
    }
    if (character === '{') {
      if (this.rowsArrayDepth !== null && this.stack.length === this.rowsArrayDepth) {
        this.directRowDepth = this.stack.length + 1;
      }
      this.stack.push('object');
      return;
    }
    if (character === '[') {
      this.stack.push('array');
      return;
    }
    if (character === '}') {
      if (this.stack.at(-1) !== 'object') return;
      if (this.directRowDepth === this.stack.length) {
        this.directRowDepth = null;
        if (this.completedRows < this.maximumRows) {
          this.completedRows += 1;
          this.onProgress?.(this.completedRows);
        }
      }
      this.stack.pop();
      return;
    }
    if (character === ']') {
      if (this.stack.at(-1) !== 'array') return;
      const closingRows = this.rowsArrayDepth === this.stack.length;
      this.stack.pop();
      if (closingRows) this.rowsArrayDepth = null;
    }
  }
}

function decodeJsonString(token: string): string | null {
  try {
    const value = JSON.parse(`"${token}"`);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
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
    streamLiveness: { current: AgentProviderRequestLiveness | null };
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
      const liveness = createAgentTurnLiveness({ signal });
      const requestLiveness = liveness.beginProviderRequest();
      tracing.streamLiveness.current = requestLiveness;
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
        response = await prepared.execute(requestLiveness.signal);
        requestLiveness.observeResponse();
      } catch (error) {
        const effectiveError = liveness.timeoutReason
          ? new AgentProviderError(
              'timeout',
              publicAgentLivenessTimeoutMessage(liveness.timeoutReason),
            )
          : error;
        traceAgentProviderError(tracing.trace, effectiveError, tracing.requestIdentity);
        throw normalizeAttemptError(effectiveError);
      } finally {
        if (tracing.streamLiveness.current === requestLiveness) {
          tracing.streamLiveness.current = null;
        }
        requestLiveness.finish();
        liveness.dispose();
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
        proposal: parseAnalyzerResponse(response, batch),
        telemetry: normalizeTelemetry(response),
      });
    },
  });
}

function parseAnalyzerResponse(
  response: ModelResponse,
  batch: SemanticAnalyzerBatch,
): AnalyzerBatchProposal {
  if (response.refusal !== undefined || response.finishReason !== 'tool_calls') {
    throw responseContractError(
      batch,
      'response',
      'Analyzer response did not finish with one proposal tool call.',
      undefined,
      null,
      'Response must finish with exactly one proposal tool call.',
    );
  }
  if (response.content?.trim()) {
    throw responseContractError(
      batch,
      'mixed_content',
      'Analyzer response mixed prose with the proposal tool call.',
      undefined,
      analyzerRowCount(response.toolCalls?.[0]?.arguments),
      'Response must not contain prose outside the proposal tool call.',
    );
  }
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length !== 1) {
    throw responseContractError(
      batch,
      'tool_call_count',
      'Analyzer response must contain exactly one tool call.',
      undefined,
      analyzerRowCount(response.toolCalls?.[0]?.arguments),
      'Response must contain exactly one proposal tool call.',
    );
  }
  const [call] = response.toolCalls;
  if (!call || !call.id.trim() || call.name !== ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME) {
    throw responseContractError(
      batch,
      'response',
      'Analyzer response used an invalid proposal tool call.',
      undefined,
      analyzerRowCount(call?.arguments),
      'Response must use the declared proposal tool with a nonempty call ID.',
    );
  }
  try {
    validateAnalyzerBatchProposal(call.arguments);
  } catch (error) {
    const rejectionCode = analyzerSchemaRejectionCode(error);
    throw new AnalyzerAttemptError(
      'Analyzer proposal arguments failed schema validation.',
      error,
      'output_contract',
      proposalContractDiagnostic(
        call.arguments,
        batch,
        'Proposal tool arguments did not match the declared schema.',
        rejectionCode,
      ) ?? responseContractDiagnostic(
        batch,
        rejectionCode,
        analyzerRowCount(call.arguments),
        'Proposal tool arguments did not match the declared schema.',
      ),
    );
  }
  validateProposalAgainstBatch(call.arguments, batch);
  return deepFreeze(call.arguments);
}

function validateProposalAgainstBatch(
  proposal: AnalyzerBatchProposal,
  batch: SemanticAnalyzerBatch,
): void {
  const diagnostic = proposalContractDiagnostic(proposal, batch);
  if (!diagnostic) return;

  throw new AnalyzerAttemptError(
    'Analyzer proposal did not preserve the immutable batch contract.',
    undefined,
    'output_contract',
    diagnostic,
  );
}

function proposalContractDiagnostic(
  value: unknown,
  batch: SemanticAnalyzerBatch,
  schemaViolation: string | null = null,
  schemaRejectionCode: AnalyzerRejectionCode | null = null,
): AnalyzerRetryDiagnostic | null {
  if (!isRecord(value) || !Array.isArray(value.rows)) return null;
  const expectedByIndex = new Map(
    batch.repositories.map((repository) => [repository.frozenIndex, repository] as const),
  );
  const receivedCounts = new Map<number, number>();
  const unexpectedFrozenIndexes: number[] = [];
  const identityMismatchFrozenIndexes: number[] = [];
  let classificationLimitExceeded = false;
  let diagnosticIndexesTruncated = false;

  for (const row of value.rows) {
    if (
      isRecord(row)
      && Array.isArray(row.classifications)
      && row.classifications.length > batch.tagPolicy.maxTagsPerRepo
    ) {
      classificationLimitExceeded = true;
    }
    if (!isRecord(row) || !isNonnegativeSafeInteger(row.frozenIndex)) continue;
    const frozenIndex = row.frozenIndex;
    const expected = expectedByIndex.get(frozenIndex);
    if (!expected) {
      if (appendBoundedDiagnosticIndex(unexpectedFrozenIndexes, frozenIndex)) {
        diagnosticIndexesTruncated = true;
      }
      continue;
    }
    receivedCounts.set(frozenIndex, (receivedCounts.get(frozenIndex) ?? 0) + 1);
    if (
      row.repositoryId !== expected.repositoryId
      || row.sourceFingerprint !== expected.sourceFingerprint
    ) {
      if (appendBoundedDiagnosticIndex(identityMismatchFrozenIndexes, frozenIndex)) {
        diagnosticIndexesTruncated = true;
      }
    }
  }

  const missingFrozenIndexes = [...expectedByIndex.keys()]
    .filter((frozenIndex) => !receivedCounts.has(frozenIndex));
  const duplicateFrozenIndexes = [...receivedCounts]
    .filter(([, count]) => count > 1)
    .map(([frozenIndex]) => frozenIndex);
  const batchIdentityMismatch = (
    value.runId !== batch.runId
    || value.generation !== batch.generation
    || value.scopeFingerprint !== batch.scopeFingerprint
  );
  const rowCoverageMismatch = (
    value.rows.length !== batch.repositories.length
    || missingFrozenIndexes.length > 0
    || duplicateFrozenIndexes.length > 0
    || unexpectedFrozenIndexes.length > 0
  );
  if (
    schemaViolation === null
    && !batchIdentityMismatch
    && value.rows.length === batch.repositories.length
    && missingFrozenIndexes.length === 0
    && duplicateFrozenIndexes.length === 0
    && unexpectedFrozenIndexes.length === 0
    && identityMismatchFrozenIndexes.length === 0
    && !classificationLimitExceeded
  ) {
    return null;
  }

  return createRetryDiagnostic({
    category: 'proposal_contract',
    rejectionCode: batchIdentityMismatch
      ? 'batch_identity'
      : rowCoverageMismatch
        ? 'row_coverage'
        : identityMismatchFrozenIndexes.length > 0
          ? 'row_identity'
          : classificationLimitExceeded
            ? 'classification'
            : schemaRejectionCode ?? 'schema',
    expectedRowCount: batch.repositories.length,
    receivedRowCount: value.rows.length,
    batchIdentityMismatch,
    missingFrozenIndexes,
    duplicateFrozenIndexes,
    unexpectedFrozenIndexes,
    identityMismatchFrozenIndexes,
    schemaViolation: schemaViolation
      ?? (batchIdentityMismatch
        ? 'Proposal run, generation, or scope identity did not match the unchanged batch.'
        : classificationLimitExceeded
          ? 'Proposal classifications exceeded the snapshotted per-repository tag limit.'
          : null),
  }, diagnosticIndexesTruncated);
}

function responseContractError(
  batch: SemanticAnalyzerBatch,
  rejectionCode: AnalyzerRejectionCode,
  message: string,
  causeValue?: unknown,
  receivedRowCount: number | null = null,
  schemaViolation: string | null = null,
): AnalyzerAttemptError {
  return new AnalyzerAttemptError(
    message,
    causeValue,
    'output_contract',
    responseContractDiagnostic(batch, rejectionCode, receivedRowCount, schemaViolation),
  );
}

function responseContractDiagnostic(
  batch: SemanticAnalyzerBatch,
  rejectionCode: AnalyzerRejectionCode = 'response',
  receivedRowCount: number | null = null,
  schemaViolation: string | null = null,
): AnalyzerRetryDiagnostic {
  return createRetryDiagnostic({
    category: 'response_contract',
    rejectionCode,
    expectedRowCount: batch.repositories.length,
    receivedRowCount,
    batchIdentityMismatch: false,
    missingFrozenIndexes: [],
    duplicateFrozenIndexes: [],
    unexpectedFrozenIndexes: [],
    identityMismatchFrozenIndexes: [],
    schemaViolation,
  });
}

function createRetryDiagnostic(
  input: Omit<AnalyzerRetryDiagnostic, 'truncated'>,
  initiallyTruncated = false,
): AnalyzerRetryDiagnostic {
  const diagnostic = {
    ...input,
    missingFrozenIndexes: sortedUniqueIntegers(input.missingFrozenIndexes),
    duplicateFrozenIndexes: sortedUniqueIntegers(input.duplicateFrozenIndexes),
    unexpectedFrozenIndexes: sortedUniqueIntegers(input.unexpectedFrozenIndexes),
    identityMismatchFrozenIndexes: sortedUniqueIntegers(input.identityMismatchFrozenIndexes),
    truncated: initiallyTruncated,
  };
  if (utf8ByteLength(JSON.stringify(diagnostic)) <= MAX_ANALYZER_RETRY_DETAIL_BYTES) {
    return deepFreeze(diagnostic);
  }

  diagnostic.truncated = true;
  const lists = [
    diagnostic.missingFrozenIndexes,
    diagnostic.duplicateFrozenIndexes,
    diagnostic.unexpectedFrozenIndexes,
    diagnostic.identityMismatchFrozenIndexes,
  ];
  while (utf8ByteLength(JSON.stringify(diagnostic)) > MAX_ANALYZER_RETRY_DETAIL_BYTES) {
    const longest = lists.reduce((current, candidate) => (
      candidate.length > current.length ? candidate : current
    ));
    if (longest.length === 0) break;
    longest.pop();
  }
  if (utf8ByteLength(JSON.stringify(diagnostic)) > MAX_ANALYZER_RETRY_DETAIL_BYTES) {
    diagnostic.schemaViolation = null;
  }
  return deepFreeze(diagnostic);
}

function sanitizeRetryDiagnostic(
  value: unknown,
  batch: SemanticAnalyzerBatch,
): AnalyzerRetryDiagnostic {
  if (!isRecord(value)) return responseContractDiagnostic(batch);
  const missing = boundedSafeIntegerArray(value.missingFrozenIndexes);
  const duplicate = boundedSafeIntegerArray(value.duplicateFrozenIndexes);
  const unexpected = boundedSafeIntegerArray(value.unexpectedFrozenIndexes);
  const identityMismatch = boundedSafeIntegerArray(value.identityMismatchFrozenIndexes);
  const category = value.category === 'proposal_contract' ? 'proposal_contract' : 'response_contract';
  return createRetryDiagnostic({
    category,
    rejectionCode: controlledRetryRejectionCode(value.rejectionCode, category),
    expectedRowCount: batch.repositories.length,
    receivedRowCount: isNonnegativeSafeInteger(value.receivedRowCount)
      ? value.receivedRowCount
      : null,
    batchIdentityMismatch: value.batchIdentityMismatch === true,
    missingFrozenIndexes: missing.values,
    duplicateFrozenIndexes: duplicate.values,
    unexpectedFrozenIndexes: unexpected.values,
    identityMismatchFrozenIndexes: identityMismatch.values,
    schemaViolation: controlledRetryViolation(value.schemaViolation),
  }, missing.truncated || duplicate.truncated || unexpected.truncated || identityMismatch.truncated);
}

function controlledRetryRejectionCode(
  value: unknown,
  category: AnalyzerRetryDiagnostic['category'],
): AnalyzerRejectionCode {
  switch (value) {
    case 'response':
    case 'tool_call_count':
    case 'mixed_content':
    case 'row_coverage':
    case 'row_identity':
    case 'batch_identity':
    case 'classification':
    case 'schema':
      return value;
    default:
      return category === 'proposal_contract' ? 'schema' : 'response';
  }
}

function analyzerSchemaRejectionCode(error: unknown): AnalyzerRejectionCode {
  const message = error instanceof Error ? error.message : '';
  return [
    'Analyzer row classifications',
    'Unchanged or insufficient-evidence rows',
    'Analyzer non-actionable classification',
    'Analyzer classification',
    'Analyzer classifications',
  ].some((prefix) => message.startsWith(prefix))
    ? 'classification'
    : 'schema';
}

function controlledRetryViolation(value: unknown): string | null {
  switch (value) {
    case 'Response must finish with exactly one proposal tool call.':
    case 'Response must not contain prose outside the proposal tool call.':
    case 'Response must contain exactly one proposal tool call.':
    case 'Response must use the declared proposal tool with a nonempty call ID.':
    case 'Proposal tool arguments did not match the declared schema.':
    case 'Proposal run, generation, or scope identity did not match the unchanged batch.':
      return value;
    default:
      return null;
  }
}

function boundedSafeIntegerArray(
  value: unknown,
): Readonly<{ values: number[]; truncated: boolean }> {
  if (!Array.isArray(value)) return { values: [], truncated: false };
  const values: number[] = [];
  const inspectedLength = Math.min(value.length, MAX_ANALYZER_RETRY_INDEXES_PER_FIELD);
  for (let index = 0; index < inspectedLength; index += 1) {
    const candidate = value[index];
    if (!isNonnegativeSafeInteger(candidate)) continue;
    values.push(candidate);
  }
  return { values, truncated: value.length > inspectedLength };
}

function appendBoundedDiagnosticIndex(values: number[], value: number): boolean {
  if (values.includes(value)) return false;
  if (values.length >= MAX_ANALYZER_RETRY_INDEXES_PER_FIELD) return true;
  values.push(value);
  return false;
}

function sortedUniqueIntegers(values: readonly number[]): number[] {
  return [...new Set(values.filter(Number.isSafeInteger))].sort((left, right) => left - right);
}

function analyzerRowCount(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const rows = value.rows;
  return Array.isArray(rows) ? rows.length : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateBatch(batch: SemanticAnalyzerBatch): void {
  validateOrganizeTagPolicySnapshot(batch.tagPolicy);
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
