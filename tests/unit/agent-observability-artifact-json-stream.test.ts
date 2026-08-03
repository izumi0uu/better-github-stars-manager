import { describe, expect, it } from 'vitest';
import {
  createAsyncTraceArtifactJsonReader,
  createTraceArtifactJsonReader,
  validateTraceArtifact,
  type TraceArtifactV1,
} from '@/agent-observability';

function artifact(): TraceArtifactV1 {
  return {
    schemaVersion: 1,
    exporterVersion: 'diagnostics-猫',
    exportedAt: 200,
    scope: { kind: 'all_retained', id: null },
    build: {
      versionHash: 'dev-hash',
      extensionVersion: '1.0.8',
      runtime: 'service_worker',
      dev: true,
    },
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
      rootOperationId: 'agent_turn:stream',
      operationKind: 'agent_turn',
      sessionId: 'session-stream',
      startedAt: 100,
      endedAt: 200,
      terminalState: 'completed',
      firstSequence: 1,
      lastSequence: 1,
      eventCount: 1,
    }],
    spans: [{
      spanId: 'agent_turn:stream:root',
      rootOperationId: 'agent_turn:stream',
      parentSpanId: null,
      spanKind: 'root',
      startedAt: 100,
      endedAt: 200,
    }],
    events: [{
      schemaVersion: 1,
      eventId: 'event-stream',
      rootOperationId: 'agent_turn:stream',
      operationKind: 'agent_turn',
      spanId: 'agent_turn:stream:root',
      parentSpanId: null,
      sequence: 1,
      wallTimeMs: 100,
      clockSegmentId: 'clock-stream',
      monotonicOffsetMs: 0,
      kind: 'root_started',
      data: {
        executionEpochId: 'epoch-stream',
        attemptId: 'attempt-stream',
        sessionId: 'session-stream',
        baseRevision: 0,
      },
    }],
    aggregates: { rootCount: 1, eventCount: 1, failedRootCount: 0 },
    integrity: { rootCount: 1, spanCount: 1, eventCount: 1 },
  };
}

describe('Agent trace artifact JSON stream', () => {
  it('round-trips the exact document through small UTF-8 bounded chunks', () => {
    const source = artifact();
    const reader = createTraceArtifactJsonReader(source);
    const chunks: string[] = [];
    for (;;) {
      const chunk = reader.read(7);
      expect(new TextEncoder().encode(chunk.jsonChunk).byteLength).toBe(chunk.byteLength);
      expect(chunk.byteLength).toBeLessThanOrEqual(7);
      chunks.push(chunk.jsonChunk);
      if (chunk.done) break;
    }

    const serialized = chunks.join('');
    expect(serialized).toBe(JSON.stringify(source));
    expect(validateTraceArtifact(JSON.parse(serialized))).toEqual(source);
  });

  it('rejects invalid limits and reads after completion', () => {
    const reader = createTraceArtifactJsonReader(artifact());
    expect(() => reader.read(0)).toThrow(/chunk limit/u);
    for (;;) {
      if (reader.read(256 * 1024).done) break;
    }
    expect(() => reader.read(4)).toThrow(/already complete/u);
  });

  it('closes an async source when a transfer is abandoned', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<string> {
      try {
        yield JSON.stringify(artifact());
      } finally {
        closed = true;
      }
    }
    const reader = createAsyncTraceArtifactJsonReader(source());
    await reader.read(16);
    await reader.cancel();
    expect(closed).toBe(true);
    await expect(reader.read(16)).rejects.toThrow(/already complete/u);
  });
});
