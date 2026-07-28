import { describe, expect, it } from 'vitest';
import type {
  DevTraceEvent,
  DevTraceEventDataByKind,
  DevTraceEventKind,
  TraceArtifactV1,
} from '@/agent-observability';
import { createAgentDiagnosticReport } from '@/dev-agent/diagnostic-report';

function event<K extends DevTraceEventKind>(
  sequence: number,
  kind: K,
  data: DevTraceEventDataByKind[K],
): DevTraceEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    rootOperationId: 'agent_turn:report',
    operationKind: 'agent_turn',
    spanId: 'agent_turn:report:root',
    parentSpanId: null,
    sequence,
    wallTimeMs: 1_000 + sequence * 10,
    clockSegmentId: 'clock-report',
    monotonicOffsetMs: sequence * 10,
    kind,
    data,
  };
}

function reportArtifact(): TraceArtifactV1 {
  const events: DevTraceEvent[] = [
    event(1, 'root_started', {
      executionEpochId: 'epoch-report',
      attemptId: 'attempt-report',
      sessionId: 'session-report',
      baseRevision: 1,
    }),
    event(2, 'context_preflight', {
      requestId: 'provider:report',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
      workingWindowTokens: 8_192,
      reserveTokens: 1_024,
      estimatedInputTokens: 7_500,
      requestBytes: 30_000,
      historyBytes: 20_000,
      decision: 'irreducible',
      reasonCode: 'active_turn_too_large',
    }),
    event(3, 'provider_request_prepared', {
      requestId: 'provider:report',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
      providerClass: 'custom',
      protocol: 'responses',
      modelCapabilityRevision: 'capability:1',
      requestBytes: 30_000,
      historyBytes: 20_000,
      estimatedInputTokens: 7_500,
      maxOutputTokens: 1_024,
    }),
    event(4, 'provider_response_started', {
      requestId: 'provider:report',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
      latencyMs: 240,
    }),
    event(5, 'provider_stream_item', {
      requestId: 'provider:report',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
      streamClass: 'text',
      utf8Bytes: 96,
    }),
    event(6, 'provider_usage', {
      requestId: 'provider:report',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
      inputTokens: 7_200,
      outputTokens: 80,
      totalTokens: 7_280,
      source: 'provider',
    }),
    event(7, 'provider_error', {
      requestId: 'provider:report',
      requestKind: 'turn',
      providerStep: 0,
      requestAttempt: 1,
      code: 'context_length_exceeded',
      status: 400,
      retryable: false,
      overflow: true,
    }),
    event(8, 'tool_queued', {
      providerStep: 0,
      toolName: 'search_starred_repositories',
      toolClass: 'read',
      risk: 'read',
      toolCallId: 'tool:report',
    }),
    event(9, 'tool_authorized', {
      providerStep: 0,
      toolName: 'search_starred_repositories',
      toolCallId: 'tool:report',
      decision: 'allow',
    }),
    event(10, 'tool_started', {
      providerStep: 0,
      toolName: 'search_starred_repositories',
      toolCallId: 'tool:report',
      attempt: 1,
    }),
    event(11, 'tool_result_admitted', {
      providerStep: 0,
      toolName: 'search_starred_repositories',
      toolCallId: 'tool:report',
      originalBytes: 20_000,
      admittedBytes: 8_000,
      reduction: 'structural',
    }),
    event(12, 'tool_completed', {
      providerStep: 0,
      toolName: 'search_starred_repositories',
      toolCallId: 'tool:report',
      outcome: 'error',
      durationMs: 50,
    }),
    event(13, 'watchdog_state', {
      watchdog: 'stream_idle',
      state: 'expired',
      limitMs: 15_000,
    }),
    event(14, 'root_terminal', {
      state: 'failed',
      reasonCode: 'provider_failure',
      durationMs: 140,
    }),
  ];
  return {
    schemaVersion: 1,
    exporterVersion: 'test-exporter',
    exportedAt: 2_000,
    scope: { kind: 'all_retained', id: null },
    build: {
      versionHash: 'test-build',
      extensionVersion: '1.0.8',
      runtime: 'service_worker',
      dev: true,
    },
    completeness: {
      retainedFromMs: 1_000,
      retainedToMs: 2_000,
      evictedRootCount: 0,
      droppedEventCount: 2,
      truncatedFieldCount: 0,
      unknownEventCount: 0,
      activeBeforeTracing: false,
      sequenceGaps: [],
    },
    roots: [{
      rootOperationId: 'agent_turn:report',
      operationKind: 'agent_turn',
      sessionId: 'session-report',
      startedAt: 1_000,
      endedAt: 1_140,
      terminalState: 'failed',
      firstSequence: 1,
      lastSequence: 14,
      eventCount: 14,
    }],
    spans: [{
      spanId: 'agent_turn:report:root',
      rootOperationId: 'agent_turn:report',
      parentSpanId: null,
      spanKind: 'root',
      startedAt: 1_000,
      endedAt: 1_140,
    }],
    events,
    aggregates: { rootCount: 1, eventCount: 14, failedRootCount: 1 },
    integrity: { rootCount: 1, spanCount: 1, eventCount: 14 },
  };
}

describe('Agent-readable diagnostic report', () => {
  it('groups Provider, context, and tool evidence while retaining actionable failure codes', () => {
    const report = createAgentDiagnosticReport(reportArtifact());

    expect(report.summary).toEqual(expect.objectContaining({
      status: 'failed',
      providerRequestCount: 1,
      providerErrorCount: 1,
      toolCallCount: 1,
    }));
    expect(report.providerRequests[0]).toEqual(expect.objectContaining({
      requestId: 'provider:report',
      state: 'error',
      timing: { firstResponseMs: 240, totalDurationMs: 40 },
      stream: { itemCount: 1, utf8Bytes: 96, classes: { text: 1 } },
      usage: { inputTokens: 7_200, outputTokens: 80, totalTokens: 7_280, source: 'provider' },
      outcome: {
        finishReason: null,
        errorCode: 'context_length_exceeded',
        httpStatus: 400,
        retryable: false,
        overflow: true,
      },
    }));
    expect(report.toolCalls[0]).toEqual(expect.objectContaining({
      toolCallId: 'tool:report',
      authorization: 'allow',
      result: expect.objectContaining({
        originalBytes: 20_000,
        admittedBytes: 8_000,
        reduction: 'structural',
        outcome: 'error',
      }),
    }));
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'operation_terminal_failure',
      'provider_request_failed',
      'context_irreducible',
      'tool_failed',
      'watchdog_expired',
      'trace_events_dropped',
    ]));
  });

  it('declares privacy exclusions and supports a selected-root projection', () => {
    const report = createAgentDiagnosticReport(reportArtifact(), 'agent_turn:report');
    const serialized = JSON.stringify(report);

    expect(report.scope).toEqual({ kind: 'root', id: 'agent_turn:report' });
    expect(report.privacy).toEqual({
      credentialsIncluded: false,
      rawCaptureIncluded: false,
      retainedTraceFieldsAreBoundedAndRedacted: true,
    });
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('authorizationHeader');
  });
});
