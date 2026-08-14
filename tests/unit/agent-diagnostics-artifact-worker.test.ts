/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceArtifact } from '@/agent-observability';
import type {
  ArtifactWorkerRequest,
  ArtifactWorkerResponse,
} from '@/dev-agent/artifact-worker-protocol';

function artifact(): TraceArtifact {
  return {
    schemaVersion: 1,
    exporterVersion: 'worker-test',
    exportedAt: 1,
    scope: { kind: 'all_retained', id: null },
    build: {
      versionHash: 'worker-test',
      extensionVersion: '1.0.8',
      runtime: 'dev_page',
      dev: true,
    },
    completeness: {
      retainedFromMs: null,
      retainedToMs: null,
      evictedRootCount: 0,
      droppedEventCount: 0,
      truncatedFieldCount: 0,
      unknownEventCount: 0,
      activeBeforeTracing: false,
      sequenceGaps: [],
    },
    roots: [],
    spans: [],
    events: [],
    aggregates: { rootCount: 0, eventCount: 0, failedRootCount: 0 },
    integrity: { rootCount: 0, spanCount: 0, eventCount: 0 },
  };
}

let posted: ArtifactWorkerResponse[] = [];

beforeEach(async () => {
  posted = [];
  vi.resetModules();
  vi.stubGlobal('postMessage', (message: ArtifactWorkerResponse) => posted.push(message));
  await import('@/dev-agent/artifact-worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  (globalThis as unknown as { onmessage: unknown }).onmessage = null;
});

function send(message: ArtifactWorkerRequest): void {
  const handler = (globalThis as unknown as {
    onmessage: ((event: MessageEvent<ArtifactWorkerRequest>) => void) | null;
  }).onmessage;
  if (!handler) throw new TypeError('Artifact worker handler is unavailable.');
  handler({ data: message } as MessageEvent<ArtifactWorkerRequest>);
}

describe('Agent diagnostics artifact worker', () => {
  it('assembles bounded live chunks and returns only a validated artifact', () => {
    const serialized = JSON.stringify(artifact());
    send({ type: 'artifact_parse_start', jobId: 'live', maxBytes: 10_000 });
    send({
      type: 'artifact_parse_chunk',
      jobId: 'live',
      jsonChunk: serialized.slice(0, 20),
      done: false,
    });
    expect(posted).toEqual([]);
    send({
      type: 'artifact_parse_chunk',
      jobId: 'live',
      jsonChunk: serialized.slice(20),
      done: true,
    });
    expect(posted).toEqual([{
      type: 'artifact_parse_result',
      jobId: 'live',
      artifact: artifact(),
    }]);
  });

  it('classifies invalid JSON and enforces the cumulative byte limit', () => {
    send({ type: 'artifact_parse_start', jobId: 'invalid', maxBytes: 10 });
    send({ type: 'artifact_parse_chunk', jobId: 'invalid', jsonChunk: '{', done: true });
    expect(posted.at(-1)).toEqual(expect.objectContaining({
      type: 'artifact_parse_error',
      jobId: 'invalid',
      code: 'invalid_json',
    }));

    send({ type: 'artifact_parse_start', jobId: 'large', maxBytes: 4 });
    send({ type: 'artifact_parse_chunk', jobId: 'large', jsonChunk: '12345', done: false });
    expect(posted.at(-1)).toEqual(expect.objectContaining({
      type: 'artifact_parse_error',
      jobId: 'large',
      code: 'too_large',
    }));
  });

  it('does not publish a result for a cancelled live parse', () => {
    const serialized = JSON.stringify(artifact());
    send({ type: 'artifact_parse_start', jobId: 'cancelled', maxBytes: 10_000 });
    send({
      type: 'artifact_parse_chunk',
      jobId: 'cancelled',
      jsonChunk: serialized.slice(0, 20),
      done: false,
    });
    send({ type: 'artifact_parse_cancel', jobId: 'cancelled' });
    send({
      type: 'artifact_parse_chunk',
      jobId: 'cancelled',
      jsonChunk: serialized.slice(20),
      done: true,
    });
    expect(posted.at(-1)).toEqual(expect.objectContaining({
      type: 'artifact_parse_error',
      jobId: 'cancelled',
      code: 'worker_failed',
    }));
    expect(posted).not.toContainEqual(expect.objectContaining({
      type: 'artifact_parse_result',
      jobId: 'cancelled',
    }));
  });
});
