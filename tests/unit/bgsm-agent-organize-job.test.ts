import { describe, expect, it, vi } from 'vitest';
import {
  AgentProviderError,
  type AgentExecutionTraceEvent,
} from '@/agent-harness';
import { isAgentLivenessManagedSignal } from '@/agent-harness/liveness';
import type { ModelProvider, ModelResponse } from '@/agent-harness/provider';
import { createOpenAIResponsesProvider } from '@/agent-harness/providers/openai-responses';
import { createAnthropicMessagesProvider } from '@/agent-harness/providers/anthropic';
import {
  analyzerOutputTokensForRepositoryCount,
  AnalyzerAttemptError,
  canDegradeAnalyzerFailure,
  MAX_ANALYZER_RETRY_DETAIL_BYTES,
  OrganizeProposalAnalyzer,
  shouldSplitAnalyzerFailure,
  type SemanticAnalyzerBatch,
} from '@/bgsm-agent/organize-proposal-analyzer';
import {
  createOrganizeJobRunAnalysisState,
  createOrganizeProposal,
  finalizeAnalyzerBatch,
  finalizeAnalysisFailure,
  finalizeLocalOnlyBatch,
  planNextBatch,
  retryBlockedOrganizeJobRunAnalysis,
  resumeOrganizeJobRunAnalysisState,
  reserveRunProviderAttempt,
  type OrganizeJobRunAnalysisState,
  type OrganizeJobRunPagePosition,
} from '@/bgsm-agent/organize-job';
import {
  issueContinuationCursor,
  resolveContinuationCursor,
} from '@/bgsm-agent/continuation-cursor';
import { parseProposalId, parseRunId } from '@/bgsm-agent/identity';
import {
  createEmptyRunBudgetUsage,
  createLowerTestRunBudget,
  createOrganizeTagPolicySnapshot,
  createProductionRunBudget,
  reconcileOrganizeTagCoverage,
} from '@/bgsm-agent/policy';
import {
  parseSourceFingerprint,
  parseTaxonomyFingerprint,
  type AnalyzerBatchProposalRow,
} from '@/bgsm-agent/proposal';
import {
  createFrozenScope,
  createFrozenScopeCursor,
  parseScopeFingerprint,
} from '@/bgsm-agent/scope';
import {
  buildSemanticPolicyTaxonomyFromStorage,
  buildSemanticRepositoryDto,
  buildSemanticTaxonomyFromStorage,
  buildSemanticTaxonomyDto,
  fingerprintSemanticTaxonomy,
} from '@/bgsm-agent/semantic-dto';
import { sourceFingerprint, taxonomyFingerprint } from '@/bgsm-agent/source-fingerprint';
import { loadFrozenScopePage } from '@/bgsm-agent/organize-scope-reader';
import {
  admitNextBatch,
  reserveAnalyzerBatch,
  reserveProviderAttempt,
} from '@/bgsm-agent/run-budget';
import type { Star, Tag, TagMeta } from '@/types';

const DIGEST = 'A'.repeat(43);
const RUN_ID = parseRunId('run:v1:test');
const PROPOSAL_ID = parseProposalId('proposal:v1:test');
const SCOPE_FINGERPRINT = parseScopeFingerprint(`fs:${DIGEST}`);
const SOURCE_FINGERPRINT = parseSourceFingerprint(`sf:v1:${DIGEST}`);
const TAXONOMY_FINGERPRINT = parseTaxonomyFingerprint(`tf:v1:${DIGEST}`);

describe('semantic DTOs and fingerprints', () => {
  it('omits notes/storage-only fields and keeps fingerprint inclusion explicit', async () => {
    const firstTag = tag({ notes: 'private-note', favorite: true });
    const secondTag = tag({ notes: 'changed-private-note', favorite: false });
    const first = await buildSemanticRepositoryDto({
      frozenIndex: 0, star: star(), tag: firstTag, excludedTagNames: [],
    });
    const second = await buildSemanticRepositoryDto({
      frozenIndex: 0, star: star(), tag: secondTag, excludedTagNames: [],
    });

    expect(JSON.stringify(first)).not.toContain('private-note');
    expect(JSON.stringify(first)).not.toContain('favorite');
    expect(JSON.stringify(first)).not.toContain('dismissedAutoTags');
    expect(JSON.stringify(first)).not.toContain('dismissedAutomatic');
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(await sourceFingerprint(star({ description: 'changed' }), firstTag))
      .not.toBe(first.sourceFingerprint);
  });

  it('filters excluded co-tags from provider-visible repository layers without changing local state', async () => {
    const stored = tag({
      manualTags: ['infra', 'hidden-manual'],
      autoTags: ['runtime', 'ｈｉｄｄｅｎ－ａｕｔｏ'],
    });
    const dto = await buildSemanticRepositoryDto({
      frozenIndex: 0,
      star: star(),
      tag: stored,
      excludedTagNames: ['HIDDEN-MANUAL', 'hidden-auto'],
    });
    expect(dto.tags).toEqual({ manual: ['infra'], automatic: ['runtime'] });
    expect(stored.manualTags).toEqual(['infra', 'hidden-manual']);
    expect(stored.autoTags).toEqual(['runtime', 'ｈｉｄｄｅｎ－ａｕｔｏ']);
  });

  it('sorts and bounds the visible taxonomy deterministically', async () => {
    const dto = buildSemanticTaxonomyDto([
      { meta: tagMeta({ name: 'Zeta' }), usageCount: 1 },
      { meta: tagMeta({ name: 'alpha', excluded: true }), usageCount: 3 },
    ]);
    expect(dto.entries.map((entry) => entry.name)).toEqual(['Zeta']);
    expect(await fingerprintSemanticTaxonomy(dto)).toMatch(/^tf:v1:/u);
    const reversed = { ...dto, entries: [...dto.entries].reverse() };
    expect(await fingerprintSemanticTaxonomy(reversed)).toBe(
      await fingerprintSemanticTaxonomy(dto),
    );
  });

  it('includes visible tags without TagMeta in the same authoritative fingerprint projection', async () => {
    const tags = [
      tag({
        manualTags: ['Legacy'],
        autoTags: ['AutoOnly'],
        manualTagsMtime: '2026-01-01T00:00:00Z',
        autoTagsMtime: '2026-02-01T00:00:00Z',
      }),
      tag({
        full_name: 'owner/other',
        manualTags: ['legacy'],
        autoTags: [],
        manualTagsMtime: '2026-03-01T00:00:00Z',
      }),
    ];
    const dto = buildSemanticTaxonomyFromStorage([], tags);
    expect(dto.entries).toEqual([
      {
        name: 'AutoOnly',
        exists: true,
        usageCount: 1,
        excluded: false,
        dimension: null,
        sourceMtime: '2026-02-01T00:00:00Z',
      },
      {
        name: 'legacy',
        exists: true,
        usageCount: 2,
        excluded: false,
        dimension: null,
        sourceMtime: '2026-03-01T00:00:00Z',
      },
    ]);
    expect(await fingerprintSemanticTaxonomy(dto)).toBe(
      await taxonomyFingerprint([], tags),
    );
    const merged = buildSemanticTaxonomyFromStorage([
      tagMeta({
        name: 'LEGACY',
        excluded: true,
        dimension: 'topic',
        mtime: '2026-04-01T00:00:00Z',
      }),
    ], tags);
    expect(merged.entries.find((entry) => entry.name === 'LEGACY')).toBeUndefined();
    const policy = buildSemanticPolicyTaxonomyFromStorage([
      tagMeta({
        name: 'LEGACY',
        excluded: true,
        dimension: 'topic',
        mtime: '2026-04-01T00:00:00Z',
      }),
    ], tags);
    expect(policy.entries.find((entry) => entry.name === 'LEGACY')).toEqual({
      name: 'LEGACY',
      exists: true,
      usageCount: 2,
      excluded: true,
      dimension: 'topic',
      sourceMtime: '2026-04-01T00:00:00Z',
    });
  });
});

describe('FrozenScope pagination and continuation', () => {
  it('advances by examined positions while returning only bounded note-free DTOs', async () => {
    const scope = frozenScope(['a/a', 'b/b', 'c/c']);
    const load = vi.fn(async () => new Map([
      ['a/a', { star: star({ full_name: 'a/a' }), tag: tag({ full_name: 'a/a' }) }],
      ['c/c', { star: star({ full_name: 'c/c', tombstone: true }), tag: null }],
    ]));
    const page = await loadFrozenScopePage({
      runId: RUN_ID,
      generation: 1,
      frozenScope: scope,
      cursor: createFrozenScopeCursor(RUN_ID, 1, 0),
      excludedTagNames: [],
      load,
    });
    expect(page.positions.map((position) => position.kind)).toEqual([
      'live',
      'missing',
      'tombstoned',
    ]);
    expect(page.nextCursor.nextFrozenIndex).toBe(3);
  });

  it('authenticates opaque cursors and rejects tampering, rollback, and cross-run use', async () => {
    const token = await issueContinuationCursor(
      createFrozenScopeCursor(RUN_ID, 2, 7),
      'controller-secret',
    );
    await expect(resolveContinuationCursor(token, {
      runId: RUN_ID,
      generation: 2,
      scopeCount: 10,
      minimumNextFrozenIndex: 7,
      authKey: 'controller-secret',
    })).resolves.toMatchObject({ nextFrozenIndex: 7 });
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}` as typeof token;
    await expect(resolveContinuationCursor(tampered, {
      runId: RUN_ID,
      generation: 2,
      scopeCount: 10,
      minimumNextFrozenIndex: 7,
      authKey: 'controller-secret',
    })).rejects.toThrow(/invalid/u);
    await expect(resolveContinuationCursor(token, {
      runId: RUN_ID,
      generation: 2,
      scopeCount: 10,
      minimumNextFrozenIndex: 8,
      authKey: 'controller-secret',
    })).rejects.toThrow(/invalid/u);
  });
});

describe('immutable RunBudget admission', () => {
  it('admits exact limits, blocks plus one, and reserves bytes/tokens atomically', () => {
    const budget = createLowerTestRunBudget({
      maxProviderAttempts: 2,
      maxSerializedOutboundRequestBytes: 10,
      maxRequestedOutputTokens: 8,
    });
    const empty = createEmptyRunBudgetUsage();
    const first = reserveProviderAttempt({
      budget,
      usage: empty,
      now: 100,
      serializedRequestBytes: 5,
      requestedOutputTokens: 4,
    });
    expect(first.status).toBe('reserved');
    if (first.status !== 'reserved') throw new Error('expected reservation');
    const second = reserveProviderAttempt({
      budget,
      usage: first.reservation.usage,
      now: 101,
      serializedRequestBytes: 5,
      requestedOutputTokens: 4,
    });
    expect(second.status).toBe('reserved');
    if (second.status !== 'reserved') throw new Error('expected reservation');
    expect(second.reservation.usage).toMatchObject({
      firstAnalyzerRequestAt: 100,
      providerAttempts: 2,
      serializedOutboundRequestBytes: 10,
      requestedOutputTokens: 8,
    });
    expect(reserveProviderAttempt({
      budget,
      usage: second.reservation.usage,
      now: 102,
      serializedRequestBytes: 1,
      requestedOutputTokens: 1,
    })).toEqual({ status: 'budget_exhausted', reason: 'provider_attempts' });
  });

  it('uses frozen reason priority and blocks work at the absolute deadline', () => {
    const budget = createLowerTestRunBudget({
      wallDeadlineMs: 10,
      maxConsumedFrozenPositions: 1,
      maxAnalyzerBatches: 1,
      maxProviderAttempts: 1,
      maxSerializedOutboundRequestBytes: 1,
      maxRequestedOutputTokens: 1,
    });
    const usage = {
      firstAnalyzerRequestAt: 10,
      consumedFrozenPositions: 1,
      analyzerBatches: 1,
      providerAttempts: 1,
      serializedOutboundRequestBytes: 1,
      requestedOutputTokens: 1,
    } as const;
    expect(admitNextBatch({
      budget,
      usage,
      now: 20,
      nextFrozenIndex: 0,
      frozenScopeCount: 2,
      nextAttemptRequestedOutputTokens: 1,
    })).toEqual({ status: 'budget_exhausted', reason: 'wall_deadline' });
  });

  it('counts one batch for a page and clamps positions before a read', () => {
    const budget = createLowerTestRunBudget({ maxConsumedFrozenPositions: 3 });
    const result = reserveAnalyzerBatch({
      budget,
      usage: createEmptyRunBudgetUsage(),
      now: 0,
      nextFrozenIndex: 0,
      frozenScopeCount: 10,
      requestedWindowSize: 50,
      nextAttemptRequestedOutputTokens: 4_096,
    });
    expect(result).toMatchObject({ status: 'reserved', windowSize: 3 });
    if (result.status === 'reserved') expect(result.usage.analyzerBatches).toBe(1);
  });

  it('allows attempts and retries within the already-admitted final batch', () => {
    const budget = createLowerTestRunBudget({
      maxAnalyzerBatches: 1,
      maxProviderAttempts: 2,
      maxRequestedOutputTokens: 2,
    });
    const usage = {
      ...createEmptyRunBudgetUsage(),
      analyzerBatches: 1,
    };
    expect(reserveProviderAttempt({
      budget,
      usage,
      now: 1,
      serializedRequestBytes: 1,
      requestedOutputTokens: 1,
    }).status).toBe('reserved');
  });
});

describe('OrganizeProposalAnalyzer', () => {
  it('scales output reservation down with split batch size', () => {
    expect(analyzerOutputTokensForRepositoryCount(4_096, 25)).toBe(4_096);
    expect(analyzerOutputTokensForRepositoryCount(4_096, 12)).toBe(2_432);
    expect(analyzerOutputTokensForRepositoryCount(4_096, 6)).toBe(1_472);
    expect(analyzerOutputTokensForRepositoryCount(4_096, 1)).toBe(672);
  });

  it('requires exact provider preparation and one strict named tool call', async () => {
    expect(() => new OrganizeProposalAnalyzer({
      provider: { async generate() { return {}; } },
    })).toThrow(/prepared-request/u);

    const response = analyzerResponse([analyzerRow(0, 'a/a')]);
    const provider = preparedProvider([response]);
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    const prepared = analyzer.prepareAttempt(analyzerBatch(['a/a']));
    const request = JSON.parse(prepared.serializedRequestBody) as {
      tools: Array<{ name: string }>;
      toolChoice: { name: string };
    };
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].name).toBe('submit_semantic_tag_batch_proposal');
    expect(request.toolChoice.name).toBe('submit_semantic_tag_batch_proposal');
    await expect(prepared.execute()).resolves.toMatchObject({
      proposal: { rows: [{ frozenIndex: 0 }] },
    });
  });

  it('binds the proposal schema to the immutable batch and its exact row count', () => {
    const batch = analyzerBatch(['a/a', 'b/b'], {
      maxTagsPerRepo: 2,
      minTopicRepoCount: 3,
    });
    const prepared = new OrganizeProposalAnalyzer({ provider: preparedProvider([]) })
      .prepareAttempt(batch);
    const request = JSON.parse(prepared.serializedRequestBody) as {
      tools: Array<{
        parameters: {
          properties: {
            version: { const: unknown };
            runId: { const: unknown };
            generation: { const: unknown };
            scopeFingerprint: { const: unknown };
            rows: {
              minItems: number;
              maxItems: number;
              items: {
                properties: {
                  classifications: {
                    oneOf: Array<{
                      minItems: number;
                      maxItems: number;
                      items: { properties: { kind: { enum: string[] } } };
                    }>;
                  };
                };
              };
            };
          };
        };
      }>;
    };
    const properties = request.tools[0]!.parameters.properties;

    expect(properties.version.const).toBe(batch.version);
    expect(properties.runId.const).toBe(batch.runId);
    expect(properties.generation.const).toBe(batch.generation);
    expect(properties.scopeFingerprint.const).toBe(batch.scopeFingerprint);
    expect(properties.rows).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(properties.rows.items.properties.classifications.oneOf).toMatchObject([
      {
        minItems: 1,
        maxItems: 2,
        items: { properties: { kind: { enum: ['add_existing_tag', 'propose_new_tag'] } } },
      },
      {
        minItems: 1,
        maxItems: 1,
        items: { properties: { kind: { enum: ['unchanged', 'insufficient_evidence'] } } },
      },
    ]);
  });

  it('rejects provider output above the snapshotted per-repository tag limit', async () => {
    const batch = analyzerBatch(['a/a'], {
      maxTagsPerRepo: 2,
      minTopicRepoCount: 3,
    });
    const row = {
      ...analyzerRow(0, 'a/a'),
      classifications: ['infra', 'backend', 'tooling'].map((tag) => ({
        kind: 'propose_new_tag' as const,
        tag,
        evidence: `${tag} evidence.`,
      })),
    };
    const response: ModelResponse = {
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'call-over-limit',
        name: 'submit_semantic_tag_batch_proposal',
        arguments: analyzerProposal([row]),
      }],
    };
    const prepared = new OrganizeProposalAnalyzer({ provider: preparedProvider([response]) })
      .prepareAttempt(batch);

    await expect(prepared.execute()).rejects.toMatchObject({
      failureKind: 'output_contract',
      diagnostic: {
        rejectionCode: 'classification',
        schemaViolation: 'Proposal classifications exceeded the snapshotted per-repository tag limit.',
      },
    });
  });

  it('uses a silent Responses prepared request for one validated proposal tool call', async () => {
    const proposal = analyzerProposal([analyzerRow(0, 'a/a')]);
    const argumentsText = JSON.stringify(proposal);
    let sentBody = '';
    const provider = createOpenAIResponsesProvider({
      model: 'gpt-5-mini',
      apiKey: 'test-key',
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = String(init?.body);
        return responsesFunctionCallResponse({
          callId: 'call-proposal',
          name: 'submit_semantic_tag_batch_proposal',
          argumentsText,
        });
      }) as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    const prepared = analyzer.prepareAttempt(analyzerBatch(['a/a']));
    const request = JSON.parse(prepared.serializedRequestBody) as {
      store: boolean;
      tools: Array<{ name: string }>;
      tool_choice: { name: string };
    };
    expect(request.store).toBe(false);
    expect(request.tools[0]?.name).toBe('submit_semantic_tag_batch_proposal');
    expect(request.tool_choice.name).toBe('submit_semantic_tag_batch_proposal');
    expect(prepared.serializedRequestBytes).toBe(
      new TextEncoder().encode(prepared.serializedRequestBody).byteLength,
    );

    await expect(prepared.execute()).resolves.toMatchObject({
      proposal: { rows: [{ frozenIndex: 0, repositoryId: 'a/a' }] },
    });
    expect(sentBody).toBe(prepared.serializedRequestBody);
  });

  it('uses progress-aware liveness for analyzer Provider requests', async () => {
    let managedSignal = false;
    const response = analyzerResponse([analyzerRow(0, 'a/a')]);
    const provider: ModelProvider = {
      async generate() {
        throw new Error('generate should not be used');
      },
      prepare(input) {
        const serializedRequestBody = JSON.stringify(input);
        return {
          serializedRequestBody,
          serializedRequestBytes: new TextEncoder().encode(serializedRequestBody).byteLength,
          async execute(signal) {
            managedSignal = isAgentLivenessManagedSignal(signal);
            input.onStreamEvent?.({ type: 'response_start' });
            return response;
          },
        };
      },
    };

    const analyzer = new OrganizeProposalAnalyzer({ provider });
    await expect(analyzer.prepareAttempt(analyzerBatch(['a/a'])).execute()).resolves.toMatchObject({
      proposal: { rows: [{ frozenIndex: 0, repositoryId: 'a/a' }] },
    });
    expect(managedSignal).toBe(true);
  });

  it('reports each completed proposal row from fragmented streamed tool arguments', async () => {
    const batch = analyzerBatch(['a/a', 'b/b']);
    const response = analyzerResponse([
      analyzerRow(0, 'a/a'),
      analyzerRow(1, 'b/b'),
    ]);
    const argumentsText = JSON.stringify(response.toolCalls?.[0]?.arguments);
    const firstRowEnd = argumentsText.indexOf('},{"frozenIndex"') + 1;
    expect(firstRowEnd).toBeGreaterThan(0);
    const provider: ModelProvider = {
      async generate() {
        throw new Error('generate should not be used');
      },
      prepare(input) {
        const serializedRequestBody = JSON.stringify(input);
        return {
          serializedRequestBody,
          serializedRequestBytes: new TextEncoder().encode(serializedRequestBody).byteLength,
          async execute() {
            input.onStreamEvent?.({ type: 'response_start' });
            input.onStreamEvent?.({
              type: 'tool_call_start',
              index: 0,
              id: 'call-progress',
              name: 'submit_semantic_tag_batch_proposal',
            });
            input.onStreamEvent?.({
              type: 'tool_call_arguments_delta',
              index: 0,
              delta: argumentsText.slice(0, 17),
            });
            input.onStreamEvent?.({
              type: 'tool_call_arguments_delta',
              index: 0,
              delta: argumentsText.slice(17, firstRowEnd),
            });
            input.onStreamEvent?.({
              type: 'tool_call_arguments_delta',
              index: 0,
              delta: argumentsText.slice(firstRowEnd),
            });
            return response;
          },
        };
      },
    };
    const progress: number[] = [];

    const result = await new OrganizeProposalAnalyzer({ provider }).analyzeWithSingleRetry(
      batch,
      () => ({ status: 'admitted' }),
      (completedRows) => progress.push(completedRows),
    );

    expect(result.status).toBe('success');
    expect(progress).toEqual([1, 2]);
  });

  it('uses a silent Anthropic prepared request for one validated proposal tool call', async () => {
    const proposal = analyzerProposal([analyzerRow(0, 'a/a')]);
    const argumentsText = JSON.stringify(proposal);
    let sentBody = '';
    const provider = createAnthropicMessagesProvider({
      model: 'claude-sonnet-4-5',
      apiKey: 'test-key',
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = String(init?.body);
        return anthropicToolUseResponse({
          callId: 'toolu-proposal',
          name: 'submit_semantic_tag_batch_proposal',
          argumentsText,
        });
      }) as typeof fetch,
      hostPermissionCheck: async () => true,
      validateRuntimeIdentity: async () => true,
    });
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    const prepared = analyzer.prepareAttempt(analyzerBatch(['a/a']));
    const request = JSON.parse(prepared.serializedRequestBody) as {
      stream: boolean;
      tools: Array<{ name: string }>;
      tool_choice: { type: string; name: string };
    };
    expect(request.stream).toBe(true);
    expect(request.tools[0]?.name).toBe('submit_semantic_tag_batch_proposal');
    expect(request.tool_choice).toEqual({
      type: 'tool',
      name: 'submit_semantic_tag_batch_proposal',
    });
    expect(prepared.serializedRequestBytes).toBe(
      new TextEncoder().encode(prepared.serializedRequestBody).byteLength,
    );

    await expect(prepared.execute()).resolves.toMatchObject({
      proposal: { rows: [{ frozenIndex: 0, repositoryId: 'a/a' }] },
    });
    expect(sentBody).toBe(prepared.serializedRequestBody);
  });

  it('retries once with the identical batch and reports a second executed failure', async () => {
    const provider = preparedProvider([
      { finishReason: 'stop', content: 'prose' },
      { finishReason: 'tool_calls', toolCalls: [] },
    ]);
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    const bodies: string[] = [];
    const result = await analyzer.analyzeWithSingleRetry(analyzerBatch(['a/a']), (attempt) => {
      bodies.push(attempt.serializedRequestBody);
      return { status: 'admitted' };
    });
    expect(result.status).toBe('analysis_failed');
    expect(bodies).toHaveLength(2);
    const payloads = bodies.map((body) => JSON.parse(body) as {
      messages: Array<{ content: string }>;
    });
    const firstContent = JSON.parse(payloads[0].messages[1].content) as { batch: unknown; retry: null };
    const secondContent = JSON.parse(payloads[1].messages[1].content) as {
      batch: unknown;
      retry: {
        previousResult: string;
        correction: { category: string; expectedRowCount: number } | null;
        instruction: string;
      };
    };
    expect(secondContent.batch).toEqual(firstContent.batch);
    expect(firstContent.retry).toBeNull();
    expect(secondContent.retry).toMatchObject({
      previousResult: 'invalid_output_contract',
      correction: {
        category: 'response_contract',
        expectedRowCount: 1,
        rejectionCode: 'response',
      },
    });
    expect(secondContent.retry.instruction).toContain('Correct every listed violation');
    if (result.status !== 'analysis_failed') throw new Error('expected analyzer failure');
    expect(result.firstError.diagnostic?.rejectionCode).toBe('response');
    expect(result.secondError.diagnostic?.rejectionCode).toBe('tool_call_count');
    expect(shouldSplitAnalyzerFailure(result)).toBe(true);
    expect(canDegradeAnalyzerFailure(result)).toBe(true);
  });

  it('returns synchronous request-size preparation failures without reserving Provider budget', async () => {
    let preparations = 0;
    let reservations = 0;
    const provider: ModelProvider = {
      async generate() {
        throw new Error('generate should not be used');
      },
      prepare() {
        preparations += 1;
        throw new AgentProviderError(
          'provider_request_too_large',
          'prepared analyzer request exceeded the Provider boundary',
        );
      },
    };

    const result = await new OrganizeProposalAnalyzer({ provider }).analyzeWithSingleRetry(
      analyzerBatch(['a/a', 'b/b']),
      () => {
        reservations += 1;
        return { status: 'admitted' };
      },
    );

    expect(result.status).toBe('analysis_failed');
    if (result.status !== 'analysis_failed') throw new Error('expected analyzer failure');
    expect(result.attempts).toBe(0);
    expect(result.firstError).toMatchObject({
      failureKind: 'provider',
      causeValue: { code: 'provider_request_too_large' },
    });
    expect(result.secondError).toBe(result.firstError);
    expect(shouldSplitAnalyzerFailure(result)).toBe(true);
    expect(canDegradeAnalyzerFailure(result)).toBe(false);
    expect(preparations).toBe(1);
    expect(reservations).toBe(0);
  });

  it('does not normalize local batch validation failures as Provider failures', async () => {
    let preparations = 0;
    let reservations = 0;
    const provider: ModelProvider = {
      async generate() {
        throw new Error('generate should not be used');
      },
      prepare() {
        preparations += 1;
        throw new Error('prepare should not be reached');
      },
    };
    const invalidBatch = {
      ...analyzerBatch(['a/a']),
      taskInstruction: ' Classify repositories.',
    };

    await expect(new OrganizeProposalAnalyzer({ provider }).analyzeWithSingleRetry(
      invalidBatch,
      () => {
        reservations += 1;
        return { status: 'admitted' };
      },
    )).rejects.toThrow('Analyzer task instruction must be trimmed and nonempty.');
    expect(preparations).toBe(0);
    expect(reservations).toBe(0);
  });

  it('returns a retry preparation failure after charging only the executed first attempt', async () => {
    let preparations = 0;
    let reservations = 0;
    const provider: ModelProvider = {
      async generate() {
        throw new Error('generate should not be used');
      },
      prepare() {
        preparations += 1;
        if (preparations === 2) {
          throw new AgentProviderError(
            'provider_request_too_large',
            'retry request exceeded the Provider boundary',
          );
        }
        return {
          serializedRequestBody: '{}',
          serializedRequestBytes: 2,
          async execute() {
            return { finishReason: 'stop', content: 'invalid' };
          },
        };
      },
    };

    const result = await new OrganizeProposalAnalyzer({ provider }).analyzeWithSingleRetry(
      analyzerBatch(['a/a', 'b/b']),
      () => {
        reservations += 1;
        return { status: 'admitted' };
      },
    );

    expect(result.status).toBe('analysis_failed');
    if (result.status !== 'analysis_failed') throw new Error('expected analyzer failure');
    expect(result.attempts).toBe(1);
    expect(result.firstError).toMatchObject({ failureKind: 'output_contract' });
    expect(result.secondError).toMatchObject({
      failureKind: 'provider',
      causeValue: { code: 'provider_request_too_large' },
    });
    expect(shouldSplitAnalyzerFailure(result)).toBe(true);
    expect(canDegradeAnalyzerFailure(result)).toBe(false);
    expect(preparations).toBe(2);
    expect(reservations).toBe(1);
  });

  it('classifies response and proposal rejections with bounded host-authored codes', async () => {
    const batch = analyzerBatch(['a/a']);
    const mixedClassification = analyzerResponse([{
      ...analyzerRow(0, 'a/a'),
      classifications: [
        { kind: 'unchanged' as const, evidence: 'No change.' },
        { kind: 'add_existing_tag' as const, tag: 'infra', evidence: 'Relevant.' },
      ],
    } as never]);
    const extraKey = analyzerResponse([analyzerRow(0, 'a/a')]);
    extraKey.toolCalls![0]!.arguments = {
      ...analyzerProposal([analyzerRow(0, 'a/a')]),
      modelAuthoredExtra: 'must-not-be-repeated',
    };
    const cases: Array<readonly [ModelResponse, string]> = [
      [{ ...analyzerResponse([analyzerRow(0, 'a/a')]), content: 'prose' }, 'mixed_content'],
      [{ finishReason: 'tool_calls', toolCalls: [] }, 'tool_call_count'],
      [mixedClassification, 'classification'],
      [extraKey, 'schema'],
    ];

    for (const [response, rejectionCode] of cases) {
      const error = await new OrganizeProposalAnalyzer({ provider: preparedProvider([response]) })
        .prepareAttempt(batch)
        .execute()
        .then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(AnalyzerAttemptError);
      expect(error).toMatchObject({
        failureKind: 'output_contract',
        diagnostic: { rejectionCode },
      });
      expect(JSON.stringify((error as AnalyzerAttemptError).diagnostic))
        .not.toContain('must-not-be-repeated');
    }
  });

  it('retries a schema-valid proposal that omitted one repository with exact coverage diagnostics', async () => {
    const batch = analyzerBatch(['a/a', 'b/b', 'c/c']);
    const provider = preparedProvider([
      analyzerResponse([analyzerRow(0, 'a/a'), analyzerRow(2, 'c/c')]),
      analyzerResponse([
        analyzerRow(0, 'a/a'),
        analyzerRow(1, 'b/b'),
        analyzerRow(2, 'c/c'),
      ]),
    ]);
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    const bodies: string[] = [];

    const result = await analyzer.analyzeWithSingleRetry(batch, (attempt) => {
      bodies.push(attempt.serializedRequestBody);
      return { status: 'admitted' };
    });

    expect(result).toMatchObject({ status: 'success', attempts: 2 });
    const request = JSON.parse(bodies[1]!) as { messages: Array<{ content: string }> };
    const content = JSON.parse(request.messages[1]!.content) as {
      retry: {
        correction: {
          category: string;
          expectedRowCount: number;
          receivedRowCount: number | null;
          missingFrozenIndexes: number[];
          duplicateFrozenIndexes: number[];
          unexpectedFrozenIndexes: number[];
          identityMismatchFrozenIndexes: number[];
          truncated: boolean;
        };
      };
    };
    expect(content.retry.correction).toMatchObject({
      category: 'proposal_contract',
      rejectionCode: 'row_coverage',
      expectedRowCount: 3,
      receivedRowCount: 2,
      missingFrozenIndexes: [1],
      duplicateFrozenIndexes: [],
      unexpectedFrozenIndexes: [],
      identityMismatchFrozenIndexes: [],
      truncated: false,
    });
    expect(new TextEncoder().encode(JSON.stringify(content.retry.correction)).byteLength)
      .toBeLessThanOrEqual(MAX_ANALYZER_RETRY_DETAIL_BYTES);
  });

  it('reports duplicate frozen indexes even when strict proposal validation also rejects them', async () => {
    const batch = analyzerBatch(['a/a', 'b/b']);
    const provider = preparedProvider([
      analyzerResponse([analyzerRow(0, 'a/a'), analyzerRow(0, 'b/b')]),
      analyzerResponse([analyzerRow(0, 'a/a'), analyzerRow(1, 'b/b')]),
    ]);
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    const bodies: string[] = [];

    const result = await analyzer.analyzeWithSingleRetry(batch, (attempt) => {
      bodies.push(attempt.serializedRequestBody);
      return { status: 'admitted' };
    });

    expect(result).toMatchObject({ status: 'success', attempts: 2 });
    const request = JSON.parse(bodies[1]!) as { messages: Array<{ content: string }> };
    const content = JSON.parse(request.messages[1]!.content) as {
      retry: {
        correction: {
          category: string;
          missingFrozenIndexes: number[];
          duplicateFrozenIndexes: number[];
          schemaViolation: string;
        };
      };
    };
    expect(content.retry.correction).toMatchObject({
      category: 'proposal_contract',
      rejectionCode: 'row_coverage',
      missingFrozenIndexes: [1],
      duplicateFrozenIndexes: [0],
      schemaViolation: 'Proposal tool arguments did not match the declared schema.',
    });
  });

  it('bounds unique model-authored diagnostic indexes before retry serialization', async () => {
    const response = analyzerResponse(Array.from(
      { length: 500 },
      (_, index) => analyzerRow(index + 1, `model/repo-${index}`),
    ));
    const error = await new OrganizeProposalAnalyzer({ provider: preparedProvider([response]) })
      .prepareAttempt(analyzerBatch(['a/a']))
      .execute()
      .then(() => null, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(AnalyzerAttemptError);
    const diagnostic = (error as AnalyzerAttemptError).diagnostic;
    expect(diagnostic?.unexpectedFrozenIndexes).toHaveLength(64);
    expect(diagnostic?.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength)
      .toBeLessThanOrEqual(MAX_ANALYZER_RETRY_DETAIL_BYTES);
  });

  it('re-sanitizes and bounds diagnostics at the retry prompt boundary', () => {
    const batch = analyzerBatch(['a/a']);
    const largeIndexes = Array.from(
      { length: 100 },
      (_, index) => Number.MAX_SAFE_INTEGER - index,
    );
    const externalError = new AnalyzerAttemptError(
      'external output failure',
      undefined,
      'output_contract',
      {
        category: 'proposal_contract',
        rejectionCode: 'model-authored-rejection' as never,
        expectedRowCount: 999,
        receivedRowCount: 999,
        batchIdentityMismatch: true,
        missingFrozenIndexes: largeIndexes,
        duplicateFrozenIndexes: largeIndexes,
        unexpectedFrozenIndexes: largeIndexes,
        identityMismatchFrozenIndexes: largeIndexes,
        schemaViolation: 'model-authored secret diagnostic',
        truncated: false,
      },
    );

    const prepared = new OrganizeProposalAnalyzer({ provider: preparedProvider([]) })
      .prepareAttempt(batch, 2, externalError);
    const request = JSON.parse(prepared.serializedRequestBody) as {
      messages: Array<{ content: string }>;
    };
    const retryContent = request.messages[1]!.content;
    const content = JSON.parse(retryContent) as {
      retry: { correction: { expectedRowCount: number; truncated: boolean } };
    };

    expect(content.retry.correction.expectedRowCount).toBe(1);
    expect((content.retry.correction as { rejectionCode?: unknown }).rejectionCode).toBe('schema');
    expect(content.retry.correction.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(content.retry.correction)).byteLength)
      .toBeLessThanOrEqual(MAX_ANALYZER_RETRY_DETAIL_BYTES);
    expect(retryContent).not.toContain('model-authored secret diagnostic');
  });

  it('retries repository identity drift without echoing model-authored field values', async () => {
    const batch = analyzerBatch(['a/a']);
    const invalid = analyzerResponse([analyzerRow(0, 'wrong/model-authored-value')]);
    const provider = preparedProvider([
      invalid,
      analyzerResponse([analyzerRow(0, 'a/a')]),
    ]);
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    const bodies: string[] = [];

    const result = await analyzer.analyzeWithSingleRetry(batch, (attempt) => {
      bodies.push(attempt.serializedRequestBody);
      return { status: 'admitted' };
    });

    expect(result).toMatchObject({ status: 'success', attempts: 2 });
    const request = JSON.parse(bodies[1]!) as { messages: Array<{ content: string }> };
    const retryContent = request.messages[1]!.content;
    const content = JSON.parse(retryContent) as {
      retry: { correction: { identityMismatchFrozenIndexes: number[] } };
    };
    expect(content.retry.correction.identityMismatchFrozenIndexes).toEqual([0]);
    expect((content.retry.correction as { rejectionCode?: unknown }).rejectionCode).toBe('row_identity');
    expect(retryContent).not.toContain('wrong/model-authored-value');
  });

  it('retries batch identity drift without echoing model-authored identity values', async () => {
    const invalid = analyzerResponse([analyzerRow(0, 'a/a')]);
    invalid.toolCalls![0]!.arguments = {
      ...analyzerProposal([analyzerRow(0, 'a/a')]),
      runId: parseRunId('run:v1:model-authored-secret'),
    };
    const provider = preparedProvider([
      invalid,
      analyzerResponse([analyzerRow(0, 'a/a')]),
    ]);
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    const bodies: string[] = [];

    const result = await analyzer.analyzeWithSingleRetry(analyzerBatch(['a/a']), (attempt) => {
      bodies.push(attempt.serializedRequestBody);
      return { status: 'admitted' };
    });

    expect(result).toMatchObject({ status: 'success', attempts: 2 });
    const request = JSON.parse(bodies[1]!) as { messages: Array<{ content: string }> };
    const retryContent = request.messages[1]!.content;
    const content = JSON.parse(retryContent) as {
      retry: { correction: { batchIdentityMismatch: boolean; schemaViolation: string } };
    };
    expect(content.retry.correction).toMatchObject({
      rejectionCode: 'batch_identity',
      batchIdentityMismatch: true,
      schemaViolation: 'Proposal run, generation, or scope identity did not match the unchanged batch.',
    });
    expect(retryContent).not.toContain('model-authored-secret');
  });

  it('does not reserve a retry after the admitted attempt is aborted', async () => {
    const controller = new AbortController();
    const provider = preparedProvider([{ finishReason: 'stop', content: 'invalid' }]);
    const analyzer = new OrganizeProposalAnalyzer({ provider });
    let reservations = 0;
    await expect(analyzer.analyzeWithSingleRetry(analyzerBatch(['a/a']), () => {
      reservations += 1;
      controller.abort();
      return { status: 'admitted', signal: controller.signal };
    })).rejects.toBeInstanceOf(Error);
    expect(reservations).toBe(1);
  });

  it('emits a content-free Provider lifecycle for a successful organize analysis request', async () => {
    const events: AgentExecutionTraceEvent[] = [];
    let now = 100;
    const response = analyzerResponse([analyzerRow(0, 'a/a')]);
    response.usage = { inputTokens: 30, outputTokens: 10, totalTokens: 40 };
    const provider: ModelProvider = {
      async generate() {
        throw new Error('generate should not be used');
      },
      prepare(input) {
        const serializedRequestBody = JSON.stringify(input);
        return {
          serializedRequestBody,
          serializedRequestBytes: new TextEncoder().encode(serializedRequestBody).byteLength,
          inspection: {
            serializedHistoryBytes: 300,
            serializedRequestBytes: 500,
            historyByteLimit: 1_000,
            requestByteLimit: 2_000,
            accepted: true,
          },
          async execute() {
            input.onStreamEvent?.({ type: 'response_start' });
            input.onStreamEvent?.({
              type: 'tool_call_arguments_delta',
              index: 0,
              delta: '{"rows":[]}',
            });
            return response;
          },
        };
      },
    };
    const analyzer = new OrganizeProposalAnalyzer({
      provider,
      trace: { emit: (event) => events.push(event) },
      traceProvider: {
        providerClass: 'custom',
        protocol: 'responses',
        modelCapabilityRevision: 'mcc:test',
      },
      now: () => now += 10,
      createRequestId: () => 'organize-success',
    });

    await expect(analyzer.prepareAttempt(analyzerBatch(['a/a'])).execute()).resolves.toMatchObject({
      telemetry: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    });

    expect(events.map((event) => event.kind)).toEqual([
      'provider_request_prepared',
      'provider_response_started',
      'provider_stream_item',
      'provider_usage',
      'provider_finished',
    ]);
    expect(events.every((event) => (
      !('requestId' in event)
      || (
        event.requestId === 'provider_request:organize-success'
        && event.requestKind === 'organize_analysis'
        && event.providerStep === null
        && event.requestAttempt === 1
      )
    ))).toBe(true);
    expect(events[0]).toMatchObject({ requestBytes: 500, historyBytes: 300 });
    expect(JSON.stringify(events)).not.toContain('rows');
  });

  it('traces the original Provider failure and the successful retry as separate attempts', async () => {
    const events: AgentExecutionTraceEvent[] = [];
    const bodies: string[] = [];
    let preparation = 0;
    const provider: ModelProvider = {
      async generate() {
        throw new Error('generate should not be used');
      },
      prepare(input) {
        preparation += 1;
        const current = preparation;
        const serializedRequestBody = JSON.stringify(input);
        bodies.push(serializedRequestBody);
        return {
          serializedRequestBody,
          serializedRequestBytes: new TextEncoder().encode(serializedRequestBody).byteLength,
          async execute() {
            if (current === 1) {
              throw new AgentProviderError('http_error', 'rate limited', 429);
            }
            return analyzerResponse([analyzerRow(0, 'a/a')]);
          },
        };
      },
    };
    const requestIds = ['organize-attempt-1', 'organize-attempt-2'];
    const analyzer = new OrganizeProposalAnalyzer({
      provider,
      trace: { emit: (event) => events.push(event) },
      traceProvider: {
        providerClass: 'openai',
        protocol: 'responses',
        modelCapabilityRevision: 'mcc:test',
      },
      createRequestId: () => requestIds.shift() ?? 'unexpected',
    });

    await expect(analyzer.analyzeWithSingleRetry(
      analyzerBatch(['a/a']),
      () => ({ status: 'admitted' }),
    )).resolves.toMatchObject({ status: 'success', attempts: 2 });

    expect(events.filter((event) => event.kind === 'provider_request_prepared'))
      .toMatchObject([{ requestAttempt: 1 }, { requestAttempt: 2 }]);
    expect(events.find((event) => event.kind === 'provider_error')).toMatchObject({
      requestId: 'provider_request:organize-attempt-1',
      requestKind: 'organize_analysis',
      requestAttempt: 1,
      code: 'http_error',
      status: 429,
      retryable: true,
    });
    expect(events.find((event) => event.kind === 'provider_finished')).toMatchObject({
      requestId: 'provider_request:organize-attempt-2',
      requestAttempt: 2,
    });
    const secondRequest = JSON.parse(bodies[1]!) as { messages: Array<{ content: string }> };
    const retryContent = JSON.parse(secondRequest.messages[1]!.content) as {
      retry: { previousResult: string; correction: unknown };
    };
    expect(retryContent.retry).toMatchObject({
      previousResult: 'provider_error',
      correction: null,
    });
    expect(secondRequest.messages[1]!.content).not.toContain('rate limited');
  });

  it('keeps development trace failures outside the analyzer result', async () => {
    const analyzer = new OrganizeProposalAnalyzer({
      provider: preparedProvider([analyzerResponse([analyzerRow(0, 'a/a')])]),
      trace: { emit: () => { throw new Error('observer failed'); } },
      traceProvider: {
        providerClass: 'openai',
        protocol: 'responses',
        modelCapabilityRevision: 'mcc:test',
      },
    });

    await expect(analyzer.prepareAttempt(analyzerBatch(['a/a'])).execute()).resolves.toMatchObject({
      proposal: { rows: [{ repositoryId: 'a/a' }] },
    });
  });
});

describe('OrganizeJobRun scheduler and row universes', () => {
  it('carries completed analysis into a fresh-budget continuation generation', () => {
    const ids = ['a/a', 'b/b'];
    const budget = createLowerTestRunBudget({ maxAnalyzerBatches: 1 });
    const taxonomy = buildSemanticTaxonomyFromStorage([], [tag({ manualTags: ['infra'] })]);
    let state = plannedState(analysisState(ids, budget), 1);
    state = finalizeAnalyzerBatch({
      state,
      positions: [livePosition(0, ids[0])],
      proposal: analyzerProposal([analyzerRow(0, ids[0])]),
      taxonomy,
      taxonomyFingerprint: TAXONOMY_FINGERPRINT,
    }).state;
    const exhausted = planNextBatch({
      state,
      now: 1,
      nextAttemptRequestedOutputTokens: 1,
    });
    expect(exhausted.status).toBe('budget_exhausted');
    if (exhausted.status !== 'budget_exhausted') throw new Error('expected exhaustion');

    const nextRunId = parseRunId('run:v1:continuation');
    const nextProposalId = parseProposalId('proposal:v1:continuation');
    const resumed = resumeOrganizeJobRunAnalysisState({
      previous: exhausted.state,
      runId: nextRunId,
      generation: 2,
      proposalId: nextProposalId,
      budget: createProductionRunBudget(),
    });

    expect(resumed).toMatchObject({
      runId: nextRunId,
      generation: 2,
      proposalId: nextProposalId,
      startFrozenIndex: 0,
      nextFrozenIndex: 1,
      pendingBatchEndFrozenIndex: null,
      status: 'analyzing',
      usage: createEmptyRunBudgetUsage(),
    });
    expect(resumed.analyzedFrozenPositions).toEqual(exhausted.state.analyzedFrozenPositions);
    expect(resumed.nonActionableAnalysisOutcomes).toEqual(exhausted.state.nonActionableAnalysisOutcomes);
    expect(resumed.actionableProposalRows).toEqual([
      expect.objectContaining({
        proposalRowId: `${nextProposalId}:row:0`,
        frozenIndex: 0,
        repositoryId: 'a/a',
      }),
    ]);

    const planned = plannedState(resumed, 1);
    const completed = finalizeAnalyzerBatch({
      state: planned,
      positions: [livePosition(1, ids[1])],
      proposal: {
        ...analyzerProposal([analyzerRow(1, ids[1])]),
        runId: nextRunId,
        generation: 2,
      },
      taxonomy,
      taxonomyFingerprint: TAXONOMY_FINGERPRINT,
    }).state;
    expect(completed).toMatchObject({
      status: 'review',
      nextFrozenIndex: 2,
    });
    expect(createOrganizeProposal(completed).rows).toHaveLength(2);
  });

  it('keeps a budget-blocked attempt unconsumed at the page start', () => {
    let state = analysisState(['a/a'], createLowerTestRunBudget({ maxProviderAttempts: 1 }));
    const planned = planNextBatch({
      state,
      now: 0,
      nextAttemptRequestedOutputTokens: 1,
    });
    expect(planned.status).toBe('batch');
    if (planned.status !== 'batch') throw new Error('expected batch');
    state = planned.batch.state;
    const first = reserveRunProviderAttempt({
      state,
      now: 1,
      attempt: { serializedRequestBytes: 1, requestedOutputTokens: 1 },
    });
    expect(first.status).toBe('reserved');
    if (first.status !== 'reserved') throw new Error('expected reservation');
    const blocked = reserveRunProviderAttempt({
      state: first.state,
      now: 2,
      attempt: { serializedRequestBytes: 1, requestedOutputTokens: 1 },
    });
    expect(blocked).toMatchObject({
      status: 'budget_exhausted',
      nextFrozenIndex: 0,
      state: { usage: { consumedFrozenPositions: 0 } },
    });
  });

  it('blocks a failed analysis page and resumes from its failed suffix', () => {
    const first = plannedState(analysisState(['a/a', 'b/b']), 2);
    const local = finalizeLocalOnlyBatch(first, [
      { frozenIndex: 0, repositoryId: 'a/a', kind: 'missing' },
      { frozenIndex: 1, repositoryId: 'b/b', kind: 'tombstoned' },
    ]);
    expect(local.state.usage.consumedFrozenPositions).toBe(2);
    expect(local.state.nonActionableAnalysisOutcomes.map((row) => row.kind)).toEqual([
      'missing',
      'tombstoned',
    ]);

    const failedState = plannedState(analysisState(['a/a']), 1);
    const failed = finalizeAnalysisFailure(failedState, [livePosition(0, 'a/a')]);
    expect(failed.state.nonActionableAnalysisOutcomes[0].kind).toBe('analysis_failed');
    expect(failed.state.actionableProposalRows).toHaveLength(0);
    expect(failed.state).toMatchObject({
      status: 'analysis_blocked',
      stopReason: 'analysis_failed',
      nextFrozenIndex: 1,
    });
    expect(planNextBatch({
      state: failed.state,
      now: 1,
      nextAttemptRequestedOutputTokens: 1,
    }).status).toBe('stopped');
    expect(() => createOrganizeProposal(failed.state)).toThrow(/complete.*without analysis failures/u);

    const sameRunRetry = retryBlockedOrganizeJobRunAnalysis(failed.state);
    expect(sameRunRetry).toMatchObject({
      runId: failed.state.runId,
      generation: failed.state.generation,
      proposalId: failed.state.proposalId,
      status: 'analyzing',
      nextFrozenIndex: 0,
      usage: failed.state.usage,
      analyzedFrozenPositions: [],
      nonActionableAnalysisOutcomes: [],
    });

    const resumed = resumeOrganizeJobRunAnalysisState({
      previous: failed.state,
      runId: parseRunId('run:v1:retry-failure'),
      generation: 2,
      proposalId: parseProposalId('proposal:v1:retry-failure'),
      budget: createProductionRunBudget(),
    });
    expect(resumed).toMatchObject({
      status: 'analyzing',
      nextFrozenIndex: 0,
      analyzedFrozenPositions: [],
      nonActionableAnalysisOutcomes: [],
    });
  });

  it('rejects finalization that attempts to consume beyond the admitted clamp', () => {
    const state = plannedState(analysisState(['a/a', 'b/b']), 1);
    expect(() => finalizeLocalOnlyBatch(state, [
      { frozenIndex: 0, repositoryId: 'a/a', kind: 'missing' },
      { frozenIndex: 1, repositoryId: 'b/b', kind: 'missing' },
    ])).toThrow(/admitted immutable window/u);
  });

  it('accepts add_existing_tag for a visible taxonomy name without TagMeta', async () => {
    const state = plannedState(analysisState(['a/a']), 1);
    const taxonomy = buildSemanticTaxonomyFromStorage([], [tag({ manualTags: ['infra'] })]);
    const result = finalizeAnalyzerBatch({
      state,
      positions: [livePosition(0, 'a/a')],
      proposal: analyzerProposal([analyzerRow(0, 'a/a')]),
      taxonomy,
      taxonomyFingerprint: await fingerprintSemanticTaxonomy(taxonomy),
    });
    expect(result.state.actionableProposalRows).toHaveLength(1);
    expect(result.state.actionableProposalRows[0].actions[0]).toMatchObject({
      kind: 'add_existing_tag',
      tag: 'infra',
    });
  });

  it('reconciles taxonomy collisions locally without blocking the whole run', async () => {
    const state = plannedState(analysisState(['a/a', 'b/b', 'c/c', 'd/d']), 4);
    const policyTaxonomy = buildSemanticPolicyTaxonomyFromStorage([
      tagMeta({ name: 'old-test', excluded: true }),
    ], [tag({ manualTags: ['infra'] })]);
    const taxonomyFingerprint = await fingerprintSemanticTaxonomy(policyTaxonomy);
    // The analyzer never sees excluded names, so proposing one as "new" (or
    // adding it as "existing") is reachable from a schema-valid, compliant
    // model response. It must degrade per row, never to an internal_error.
    const result = finalizeAnalyzerBatch({
      state,
      positions: [
        livePosition(0, 'a/a'),
        livePosition(1, 'b/b'),
        livePosition(2, 'c/c'),
        livePosition(3, 'd/d'),
      ],
      proposal: {
        ...analyzerProposal([]),
        rows: [
          {
            frozenIndex: 0,
            repositoryId: 'a/a',
            sourceFingerprint: SOURCE_FINGERPRINT,
            classifications: [{
              kind: 'propose_new_tag',
              tag: 'OLD-TEST',
              evidence: 'Collides with an entry the analyzer cannot see.',
            }],
          },
          {
            frozenIndex: 1,
            repositoryId: 'b/b',
            sourceFingerprint: SOURCE_FINGERPRINT,
            classifications: [{
              kind: 'add_existing_tag',
              tag: 'old-test',
              evidence: 'Targets a non-visible excluded entry.',
            }],
          },
          {
            frozenIndex: 2,
            repositoryId: 'c/c',
            sourceFingerprint: SOURCE_FINGERPRINT,
            classifications: [{
              kind: 'propose_new_tag',
              tag: 'brand-new',
              evidence: 'Novel topic.',
            }],
          },
          {
            frozenIndex: 3,
            repositoryId: 'd/d',
            sourceFingerprint: SOURCE_FINGERPRINT,
            classifications: [{
              kind: 'propose_new_tag',
              tag: 'INFRA',
              evidence: 'Existing taxonomy name with the wrong action kind.',
            }],
          },
        ],
      },
      taxonomy: policyTaxonomy,
      taxonomyFingerprint,
    });

    expect(result.state.nonActionableAnalysisOutcomes).toEqual([
      { frozenIndex: 0, repositoryId: 'a/a', kind: 'unchanged' },
      { frozenIndex: 1, repositoryId: 'b/b', kind: 'unchanged' },
    ]);
    expect(result.state.actionableProposalRows).toMatchObject([
      { frozenIndex: 2, repositoryId: 'c/c' },
      {
        frozenIndex: 3,
        repositoryId: 'd/d',
        actions: [{ kind: 'add_existing_tag', tag: 'infra' }],
      },
    ]);
    expect(result.state).toMatchObject({
      status: 'review',
      stopReason: 'scope_complete',
    });
    expect(result.nextFrozenIndex).toBe(4);
  });

  it('reconciles canonical tag coverage across all analyzer pages before review', () => {
    const ids = ['a/a', 'b/b', 'c/c', 'd/d'];
    const tagPolicy = { maxTagsPerRepo: 2, minTopicRepoCount: 3 };
    const taxonomy = buildSemanticTaxonomyDto([]);
    const action = (tag: string) => ({
      kind: 'propose_new_tag' as const,
      tag,
      evidence: `${tag} evidence.`,
    });
    let state = plannedState(analysisState(ids, createProductionRunBudget(), tagPolicy), 2);
    state = finalizeAnalyzerBatch({
      state,
      positions: [livePosition(0, ids[0]), livePosition(1, ids[1])],
      proposal: analyzerProposal([
        { ...analyzerRow(0, ids[0]), classifications: [action('Shared'), action('Rare')] },
        { ...analyzerRow(1, ids[1]), classifications: [action('shared')] },
      ]),
      taxonomy,
      taxonomyFingerprint: TAXONOMY_FINGERPRINT,
    }).state;
    expect(state.status).toBe('analyzing');

    state = plannedState(state, 2);
    state = finalizeAnalyzerBatch({
      state,
      positions: [livePosition(2, ids[2]), livePosition(3, ids[3])],
      proposal: analyzerProposal([
        { ...analyzerRow(2, ids[2]), classifications: [action('SHARED')] },
        { ...analyzerRow(3, ids[3]), classifications: [action('rare')] },
      ]),
      taxonomy,
      taxonomyFingerprint: TAXONOMY_FINGERPRINT,
    }).state;

    expect(state.status).toBe('review');
    expect(state.actionableProposalRows.map((row) => ({
      frozenIndex: row.frozenIndex,
      tags: row.actions.map((entry) => entry.tag),
    }))).toEqual([
      { frozenIndex: 0, tags: ['Shared'] },
      { frozenIndex: 1, tags: ['shared'] },
      { frozenIndex: 2, tags: ['SHARED'] },
    ]);
    expect(state.nonActionableAnalysisOutcomes).toEqual([
      { frozenIndex: 3, repositoryId: 'd/d', kind: 'insufficient_evidence' },
    ]);
    expect(state.analyzedFrozenPositions[3]?.classification).toBe('non_actionable');
    expect(JSON.stringify(createOrganizeProposal(state))).not.toContain('Rare');
  });

  it('counts canonical tag coverage at most once per repository', () => {
    const action = (tag: string) => ({
      kind: 'propose_new_tag' as const,
      tag,
      evidence: 'Evidence.',
    });
    const reconciled = reconcileOrganizeTagCoverage([
      { repositoryId: 'a/a', actions: [action('Shared'), action('shared')] },
      { repositoryId: 'b/b', actions: [action('SHARED')] },
    ], createOrganizeTagPolicySnapshot({ minTopicRepoCount: 3 }));

    expect(reconciled).toEqual([[], []]);
    expect(createOrganizeTagPolicySnapshot(undefined)).toEqual({
      maxTagsPerRepo: 5,
      minTopicRepoCount: 3,
    });
    expect(createOrganizeTagPolicySnapshot({
      maxTagsPerRepo: 50,
      minTopicRepoCount: '4',
    })).toEqual({
      maxTagsPerRepo: 5,
      minTopicRepoCount: 4,
    });
  });

  it('analyzes all actionable rows beyond 100 before entering review', () => {
    const ids = Array.from({ length: 102 }, (_, index) => `owner/repo-${index}`);
    let state = analysisState(ids);
    const taxonomy = buildSemanticTaxonomyDto([
      { meta: tagMeta({ name: 'infra' }), usageCount: 1 },
    ]);
    for (const start of [0, 50]) {
      state = plannedState(state, 50);
      const positions = ids.slice(start, start + 50).map((id, offset) =>
        livePosition(start + offset, id));
      const proposal = analyzerProposal(positions.map((position) =>
        analyzerRow(position.frozenIndex, position.repositoryId)));
      state = finalizeAnalyzerBatch({
        state,
        positions,
        proposal,
        taxonomy,
        taxonomyFingerprint: TAXONOMY_FINGERPRINT,
      }).state;
    }
    state = plannedState(state, 2);
    const suffix = [livePosition(100, ids[100]), livePosition(101, ids[101])];
    const result = finalizeAnalyzerBatch({
      state,
      positions: suffix,
      proposal: analyzerProposal(suffix.map((position) =>
        analyzerRow(position.frozenIndex, position.repositoryId))),
      taxonomy,
      taxonomyFingerprint: TAXONOMY_FINGERPRINT,
    });
    expect(result).toMatchObject({ continuationRequired: false, nextFrozenIndex: 102 });
    expect(result.state).toMatchObject({
      status: 'review',
      stopReason: 'scope_complete',
      usage: { consumedFrozenPositions: 102 },
    });
    expect(result.state.actionableProposalRows).toHaveLength(102);
    expect(result.state.analyzedFrozenPositions).toHaveLength(102);
    expect(createOrganizeProposal(result.state).rows).toHaveLength(102);
  });

  it('refuses review and proposal creation before the frozen scope is fully covered', () => {
    const state = analysisState(['a/a', 'b/b']);
    expect(() => createOrganizeProposal(state)).toThrow(/complete.*without analysis failures/u);
    const suffixOnly = createOrganizeJobRunAnalysisState({
      runId: RUN_ID,
      generation: 1,
      proposalId: PROPOSAL_ID,
      frozenScope: frozenScope(['a/a', 'b/b']),
      budget: createProductionRunBudget(),
      startFrozenIndex: 2,
    });
    expect(() => planNextBatch({
      state: suffixOnly,
      now: 0,
      nextAttemptRequestedOutputTokens: 1,
    })).toThrow(/complete FrozenScope coverage/u);
  });
});

function analysisState(
  ids: readonly string[],
  budget = createProductionRunBudget(),
  tagPolicy = { maxTagsPerRepo: 5, minTopicRepoCount: 1 },
): OrganizeJobRunAnalysisState {
  return createOrganizeJobRunAnalysisState({
    runId: RUN_ID,
    generation: 1,
    proposalId: PROPOSAL_ID,
    frozenScope: frozenScope(ids),
    tagPolicy,
    budget,
  });
}

function plannedState(state: OrganizeJobRunAnalysisState, windowSize: number): OrganizeJobRunAnalysisState {
  const decision = planNextBatch({
    state,
    now: 0,
    requestedWindowSize: windowSize,
    nextAttemptRequestedOutputTokens: 1,
  });
  if (decision.status !== 'batch') throw new Error('expected planned batch');
  return decision.batch.state;
}

function frozenScope(ids: readonly string[]) {
  return createFrozenScope({
    kind: 'all_live_stars',
    label: 'All stars',
    filterSnapshot: '',
    repositoryIds: ids,
    capturedAt: 1,
    fingerprint: SCOPE_FINGERPRINT,
  });
}

function livePosition(frozenIndex: number, repositoryId: string): OrganizeJobRunPagePosition {
  return {
    frozenIndex,
    repositoryId,
    kind: 'live',
    repository: {
      frozenIndex,
      repositoryId,
      sourceFingerprint: SOURCE_FINGERPRINT,
      fullName: repositoryId,
      description: '',
      language: null,
      topics: [],
      stargazersCount: 0,
      pushedAt: null,
      createdAt: null,
      fork: false,
      archived: false,
      starredAt: '2026-01-01T00:00:00.000Z',
      tags: { manual: [], automatic: [] },
    },
  };
}

function analyzerBatch(
  ids: readonly string[],
  tagPolicy = { maxTagsPerRepo: 5, minTopicRepoCount: 1 },
): SemanticAnalyzerBatch {
  return {
    version: 1,
    runId: RUN_ID,
    generation: 1,
    scopeFingerprint: SCOPE_FINGERPRINT,
    taskInstruction: 'Classify repositories.',
    tagPolicy,
    repositories: ids.map((id, index) =>
      (livePosition(index, id) as Extract<OrganizeJobRunPagePosition, { kind: 'live' }>).repository),
    taxonomy: buildSemanticTaxonomyDto([
      { meta: tagMeta({ name: 'infra' }), usageCount: 1 },
    ]),
  };
}

function analyzerRow(frozenIndex: number, repositoryId: string) {
  return {
    frozenIndex,
    repositoryId,
    sourceFingerprint: SOURCE_FINGERPRINT,
    classifications: [{ kind: 'add_existing_tag' as const, tag: 'infra', evidence: 'Relevant.' }],
  };
}

function analyzerProposal(rows: readonly AnalyzerBatchProposalRow[]) {
  return {
    version: 1 as const,
    runId: RUN_ID,
    generation: 1,
    scopeFingerprint: SCOPE_FINGERPRINT,
    rows,
  };
}

function analyzerResponse(rows: readonly AnalyzerBatchProposalRow[]): ModelResponse {
  return {
    finishReason: 'tool_calls',
    toolCalls: [{
      id: 'call-1',
      name: 'submit_semantic_tag_batch_proposal',
      arguments: analyzerProposal(rows),
    }],
  };
}

function preparedProvider(responses: ModelResponse[]): ModelProvider {
  const queue = [...responses];
  return {
    async generate() {
      return queue.shift() ?? {};
    },
    prepare(input) {
      const serializedRequestBody = JSON.stringify(input);
      return {
        serializedRequestBody,
        serializedRequestBytes: new TextEncoder().encode(serializedRequestBody).byteLength,
        async execute() {
          return queue.shift() ?? {};
        },
      };
    },
  };
}

function responsesFunctionCallResponse(input: {
  callId: string;
  name: string;
  argumentsText: string;
}): Response {
  const itemId = 'fc_organize_proposal';
  const events = [
    {
      type: 'response.created',
      response: { id: 'resp_organize_proposal', status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      response_id: 'resp_organize_proposal',
      output_index: 0,
      item: {
        id: itemId,
        type: 'function_call',
        call_id: input.callId,
        name: input.name,
        arguments: '',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      response_id: 'resp_organize_proposal',
      item_id: itemId,
      output_index: 0,
      delta: input.argumentsText,
    },
    {
      type: 'response.function_call_arguments.done',
      response_id: 'resp_organize_proposal',
      item_id: itemId,
      output_index: 0,
      arguments: input.argumentsText,
    },
    {
      type: 'response.output_item.done',
      response_id: 'resp_organize_proposal',
      output_index: 0,
      item: {
        id: itemId,
        type: 'function_call',
        status: 'completed',
        call_id: input.callId,
        name: input.name,
        arguments: input.argumentsText,
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_organize_proposal',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function anthropicToolUseResponse(input: {
  callId: string;
  name: string;
  argumentsText: string;
}): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_organize_proposal',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: input.callId, name: input.name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: input.argumentsText },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: 'message_stop' },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function star(overrides: Partial<Star> = {}): Star {
  return {
    full_name: 'owner/repo',
    html_url: 'https://github.com/owner/repo',
    description: 'Description',
    language: 'TypeScript',
    stargazers_count: 42,
    topics: ['tooling'],
    pushed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2025-01-01T00:00:00.000Z',
    fork: false,
    archived: false,
    starred_at: '2026-01-02T00:00:00.000Z',
    tombstone: false,
    synced_at: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

function tag(overrides: Partial<Tag> = {}): Tag {
  return {
    full_name: 'owner/repo',
    manualTags: ['infra'],
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: '1',
    autoTagsMtime: '1',
    dismissedAutoTagsMtime: '1',
    notes: '',
    favorite: false,
    mtime: '1',
    ...overrides,
  };
}

function tagMeta(overrides: Partial<TagMeta> = {}): TagMeta {
  return {
    name: 'infra',
    dimension: null,
    color: null,
    mtime: '1',
    excluded: false,
    ...overrides,
  };
}
