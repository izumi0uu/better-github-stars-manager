import { describe, expect, it } from 'vitest';
import {
  buildDevTraceEvent,
  DEV_TRACE_SCHEMA_VERSION,
  parseTraceArtifactJson,
  validateTraceArtifact,
  type DevTraceEvent,
  type TraceArtifactV1,
} from '@/agent-observability';

function event(sequence = 1): DevTraceEvent {
  return buildDevTraceEvent({
    eventId: `event-${sequence}`,
    rootOperationId: 'root-1',
    operationKind: 'agent_turn',
    spanId: 'span-1',
    parentSpanId: null,
    sequence,
    wallTimeMs: 100 + sequence,
    clockSegmentId: 'clock-1',
    monotonicOffsetMs: sequence,
  }, {
    kind: 'provider_error',
    data: {
      requestId: 'provider-request-1',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
      code: 'rate_limited',
      status: 429,
      retryable: true,
      overflow: false,
    },
  });
}

function artifact(events: readonly DevTraceEvent[] = [event()]): TraceArtifactV1 {
  return {
    schemaVersion: 1,
    exporterVersion: '1.0.0',
    exportedAt: 200,
    scope: { kind: 'all_retained', id: null },
    build: { versionHash: 'dev-hash', extensionVersion: '1.0.8', runtime: 'dev_page', dev: true },
    completeness: {
      retainedFromMs: 100,
      retainedToMs: 200,
      evictedRootCount: 0,
      droppedEventCount: 0,
      truncatedFieldCount: 0,
      unknownEventCount: 0,
      activeBeforeTracing: false,
      sequenceGaps: [],
    },
    roots: [{
      rootOperationId: 'root-1',
      operationKind: 'agent_turn',
      sessionId: 'session-1',
      startedAt: 100,
      endedAt: 200,
      terminalState: 'failed',
      firstSequence: events[0]?.sequence ?? 1,
      lastSequence: events.at(-1)?.sequence ?? 1,
      eventCount: events.length,
    }],
    spans: [{
      spanId: 'span-1',
      rootOperationId: 'root-1',
      parentSpanId: null,
      spanKind: 'provider',
      startedAt: 100,
      endedAt: 200,
    }],
    events,
    aggregates: { rootCount: 1, eventCount: events.length, failedRootCount: 1 },
    integrity: { rootCount: 1, spanCount: 1, eventCount: events.length },
  };
}

describe('Agent observability contracts', () => {
  it('accepts organize analysis as a Provider request kind', () => {
    const organize = event();
    const artifactValue = artifact([{
      ...organize,
      data: { ...organize.data, requestKind: 'organize_analysis' },
    }]);

    expect(() => validateTraceArtifact(artifactValue)).not.toThrow();
  });

  it('builds frozen events from an allowlist instead of copying arbitrary source fields', () => {
    const source = {
      requestId: 'provider-request-2',
      requestKind: 'turn' as const,
      providerStep: 2,
      requestAttempt: 3,
      code: 'provider_error',
      status: 401,
      retryable: false,
      overflow: false,
      apiKey: 'sk-secret-value-that-must-not-appear',
      prompt: 'private prompt',
      baseUrl: 'https://relay.example.com/v1',
      headers: { Authorization: 'Bearer hidden' },
    };
    const built = buildDevTraceEvent({
      eventId: 'event-1',
      rootOperationId: 'root-1',
      operationKind: 'agent_turn',
      spanId: 'span-1',
      parentSpanId: null,
      sequence: 1,
      wallTimeMs: 1,
      clockSegmentId: 'clock-1',
      monotonicOffsetMs: 0,
    }, { kind: 'provider_error', data: source });

    expect(built.schemaVersion).toBe(DEV_TRACE_SCHEMA_VERSION);
    expect(built.data).toEqual({
      requestId: 'provider-request-2',
      requestKind: 'turn',
      providerStep: 2,
      requestAttempt: 3,
      code: 'provider_error',
      status: 401,
      retryable: false,
      overflow: false,
    });
    expect(JSON.stringify(built)).not.toMatch(/sk-secret|private prompt|relay\.example|Authorization/);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.data)).toBe(true);
  });

  it('keeps rejected-attempt and disconnect evidence metadata-only', () => {
    const envelope = {
      eventId: 'event-lifecycle',
      rootOperationId: 'root-1',
      operationKind: 'agent_turn' as const,
      spanId: 'span-1',
      parentSpanId: null,
      sequence: 1,
      wallTimeMs: 101,
      clockSegmentId: 'clock-1',
      monotonicOffsetMs: 1,
    };
    const rejectedSource = {
      reason: 'identity_conflict' as const,
      prompt: 'private conflicting prompt',
    };
    const rejected = buildDevTraceEvent(envelope, {
      kind: 'attempt_rejected',
      data: rejectedSource,
    });
    const disconnectedSource = {
      connectionEpochId: 'connection-1',
      lastDeliverySequence: 0,
      attemptState: 'rejected' as const,
      rawError: 'private transport error',
    };
    const disconnected = buildDevTraceEvent({ ...envelope, eventId: 'event-disconnect', sequence: 2 }, {
      kind: 'port_disconnected',
      data: disconnectedSource,
    });

    expect(rejected.data).toEqual({ reason: 'identity_conflict' });
    expect(disconnected.data).toEqual({
      connectionEpochId: 'connection-1',
      lastDeliverySequence: 0,
      attemptState: 'rejected',
    });
    expect(JSON.stringify([rejected, disconnected])).not.toMatch(/private|prompt|rawError/u);
  });

  it('validates result acknowledgement revision semantics and strips unrelated UI state', () => {
    const envelope = {
      eventId: 'event-acknowledgement',
      rootOperationId: 'root-1',
      operationKind: 'agent_turn' as const,
      spanId: 'span-1',
      parentSpanId: null,
      sequence: 1,
      wallTimeMs: 101,
      clockSegmentId: 'clock-1',
      monotonicOffsetMs: 1,
    };
    const source = {
      disposition: 'applied' as const,
      appliedRevision: 4,
      assistantMessage: 'private reply',
    };
    const applied = buildDevTraceEvent(envelope, {
      kind: 'result_acknowledged',
      data: source,
    });

    expect(applied.data).toEqual({ disposition: 'applied', appliedRevision: 4 });
    expect(JSON.stringify(applied)).not.toContain('private reply');
    for (const disposition of ['no_transition', 'transition_rejected', 'detached'] as const) {
      expect(buildDevTraceEvent(envelope, {
        kind: 'result_acknowledged',
        data: { disposition, appliedRevision: null },
      }).data).toEqual({ disposition, appliedRevision: null });
    }
    expect(() => buildDevTraceEvent(envelope, {
      kind: 'result_acknowledged',
      data: { disposition: 'transition_rejected', appliedRevision: 4 },
    })).toThrow(/revision does not match/u);
    expect(() => buildDevTraceEvent(envelope, {
      kind: 'result_acknowledged',
      data: { disposition: 'applied', appliedRevision: null },
    })).toThrow(/revision does not match/u);
  });

  it('keeps OrganizeJobRun batch and Provider attempt evidence metadata-only', () => {
    const envelope = {
      eventId: 'event-organize-attempt',
      rootOperationId: 'root-organize',
      operationKind: 'organize_job' as const,
      spanId: 'span-organize-attempt',
      parentSpanId: 'span-organize-batch',
      sequence: 1,
      wallTimeMs: 101,
      clockSegmentId: 'clock-1',
      monotonicOffsetMs: 1,
    };
    const source = {
      runId: 'run:v1:organize-contract',
      generation: 0,
      batchStart: 0,
      batchEnd: 25,
      attempt: 2 as const,
      state: 'failed' as const,
      requestBytes: 2_048,
      requestedOutputTokens: 1_024,
      inputTokens: 800,
      outputTokens: 100,
      totalTokens: 900,
      reasonCode: 'invalid_or_failed',
      repositoryName: 'private-owner/private-repository',
      tag: 'private-tag',
      rawError: 'Bearer private-provider-token',
      requestBody: { private: true },
    };

    const built = buildDevTraceEvent(envelope, {
      kind: 'organize_provider_attempt',
      data: source,
    });

    expect(built.data).toEqual({
      runId: 'run:v1:organize-contract',
      generation: 0,
      batchStart: 0,
      batchEnd: 25,
      attempt: 2,
      state: 'failed',
      requestBytes: 2_048,
      requestedOutputTokens: 1_024,
      inputTokens: 800,
      outputTokens: 100,
      totalTokens: 900,
      reasonCode: 'invalid_or_failed',
    });
    expect(JSON.stringify(built)).not.toMatch(
      /private-owner|private-repository|private-tag|private-provider-token|requestBody/u,
    );
  });

  it('keeps OrganizeJobRun watchdog evidence separate from chat timeouts and metadata-only', () => {
    const envelope = {
      eventId: 'event-organize-watchdog',
      rootOperationId: 'root-organize',
      operationKind: 'organize_job' as const,
      spanId: 'span-organize-root',
      parentSpanId: null,
      sequence: 1,
      wallTimeMs: 101,
      clockSegmentId: 'clock-1',
      monotonicOffsetMs: 1,
    };
    const source = {
      watchdog: 'organize_wall_deadline' as const,
      state: 'armed' as const,
      limitMs: 300_000,
      repositoryName: 'private-owner/private-repository',
      taskInstruction: 'private task instruction',
    };

    const built = buildDevTraceEvent(envelope, {
      kind: 'watchdog_state',
      data: source,
    });

    expect(built.data).toEqual({
      watchdog: 'organize_wall_deadline',
      state: 'armed',
      limitMs: 300_000,
    });
    expect(JSON.stringify(built)).not.toMatch(/private-owner|private-repository|private task/u);
  });

  it('keeps OrganizeJobRun Apply and receipt evidence count-only', () => {
    const envelope = {
      eventId: 'event-organize-receipt',
      rootOperationId: 'root-organize',
      operationKind: 'organize_job' as const,
      spanId: 'span-organize-receipt',
      parentSpanId: 'root-organize:root',
      sequence: 1,
      wallTimeMs: 101,
      clockSegmentId: 'clock-1',
      monotonicOffsetMs: 1,
    };
    const source = {
      applyId: 'organize-apply:receipt-contract',
      state: 'available' as const,
      total: 3,
      changed: 2,
      unchanged: 0,
      skipped: 1,
      failed: 0,
      rowOffset: null,
      rowCount: 0,
      nextRowOffset: null,
      filter: null,
      repositoryName: 'private-owner/private-repository',
      approvedTags: ['private-tag'],
      leaseToken: 'private-lease',
      rawReceipt: { secret: true },
    };

    const built = buildDevTraceEvent(envelope, {
      kind: 'organize_receipt_state',
      data: source,
    });

    expect(built.data).toEqual({
      applyId: 'organize-apply:receipt-contract',
      state: 'available',
      total: 3,
      changed: 2,
      unchanged: 0,
      skipped: 1,
      failed: 0,
      rowOffset: null,
      rowCount: 0,
      nextRowOffset: null,
      filter: null,
    });
    expect(JSON.stringify(built)).not.toMatch(
      /private-owner|private-repository|private-tag|private-lease|rawReceipt/u,
    );
  });

  it('rejects inconsistent OrganizeJobRun selection, Apply, and receipt coordinates', () => {
    const envelope = {
      eventId: 'event-organize-invalid',
      rootOperationId: 'root-organize',
      operationKind: 'organize_job' as const,
      spanId: 'span-organize',
      parentSpanId: null,
      sequence: 1,
      wallTimeMs: 101,
      clockSegmentId: 'clock-1',
      monotonicOffsetMs: 1,
    };
    expect(() => buildDevTraceEvent(envelope, {
      kind: 'organize_selection_state',
      data: {
        runId: 'run:v1:organize',
        generation: 1,
        previousRevision: 3,
        revision: 3,
        mode: 'partial',
        affectedRepositories: 1,
        selectedRepositories: 1,
        selectedActions: 1,
      },
    })).toThrow(/revision must advance/u);
    expect(() => buildDevTraceEvent(envelope, {
      kind: 'organize_apply_state',
      data: {
        applyId: 'apply-1',
        executionId: null,
        revision: null,
        state: 'attempt_started',
        total: null,
        settled: null,
        changed: null,
        unchanged: null,
        skipped: null,
        failed: null,
      },
    })).toThrow(/execution identity/u);
    expect(() => buildDevTraceEvent(envelope, {
      kind: 'organize_receipt_state',
      data: {
        applyId: 'apply-1',
        state: 'page_delivered',
        total: 1,
        changed: 1,
        unchanged: 0,
        skipped: 0,
        failed: 0,
        rowOffset: null,
        rowCount: 1,
        nextRowOffset: null,
        filter: 'all',
      },
    })).toThrow(/page coordinates/u);
  });

  it('accepts additive artifact fields but rejects broken identities and ordering', () => {
    const valid = { ...artifact(), futureField: { ignored: true } };
    expect(validateTraceArtifact(valid)).toBe(valid);

    const duplicateEvents = [event(1), { ...event(2), eventId: 'event-1' }];
    expect(() => validateTraceArtifact(artifact(duplicateEvents))).toThrow(/duplicate event ID/i);

    const reversedEvents = [event(2), event(1)];
    expect(() => validateTraceArtifact(artifact(reversedEvents))).toThrow(/strictly increasing/i);

    const unknownSpan = artifact([{ ...event(), spanId: 'missing-span' }]);
    expect(() => validateTraceArtifact(unknownSpan)).toThrow(/unknown span/i);
  });

  it('rejects corrupt, unsupported, and oversized serialized artifacts precisely', () => {
    expect(() => parseTraceArtifactJson('{')).toThrow(/not valid JSON/i);
    expect(() => parseTraceArtifactJson(JSON.stringify({ ...artifact(), schemaVersion: 2 })))
      .toThrow(/unsupported/i);
    expect(() => parseTraceArtifactJson(JSON.stringify(artifact()), 4)).toThrow(/size limit/i);
  });
});
