import {
  MAX_TRACE_ARTIFACT_BYTES,
  parseTraceArtifactJson,
} from '@/agent-observability/contracts';
import {
  DEV_ARTIFACT_WORKER_MARKER,
  type ArtifactWorkerErrorCode,
  type ArtifactWorkerRequest,
  type ArtifactWorkerResponse,
} from './artifact-worker-protocol';

type ParseState = {
  chunks: string[];
  bytes: number;
  maxBytes: number;
  cancelled: boolean;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
};

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ArtifactWorkerRequest>) => void) | null;
  postMessage(message: ArtifactWorkerResponse): void;
};
const states = new Map<string, ParseState>();

scope.onmessage = (message) => {
  const request = message.data;
  if (request.type === 'artifact_parse_cancel') {
    const state = states.get(request.jobId);
    if (state) {
      state.cancelled = true;
      void state.reader?.cancel().catch(() => undefined);
    }
    states.delete(request.jobId);
    return;
  }
  if (request.type === 'artifact_parse_start') {
    if (!validLimit(request.maxBytes)) {
      postError(request.jobId, 'too_large', 'Trace artifact size limit is invalid.');
      return;
    }
    states.set(request.jobId, createParseState(request.maxBytes));
    return;
  }
  if (request.type === 'artifact_parse_file') {
    void parseFile(request.jobId, request.file, request.maxBytes);
    return;
  }

  const state = states.get(request.jobId);
  if (!state) {
    postError(
      request.jobId,
      'worker_failed',
      `${DEV_ARTIFACT_WORKER_MARKER}: Trace artifact parse job is not active.`,
    );
    return;
  }
  const bytes = utf8Bytes(request.jsonChunk);
  if (state.bytes + bytes > state.maxBytes) {
    states.delete(request.jobId);
    postError(request.jobId, 'too_large', 'Trace artifact exceeds the size limit.');
    return;
  }
  state.bytes += bytes;
  state.chunks.push(request.jsonChunk);
  if (request.done) finish(request.jobId, state);
};

async function parseFile(jobId: string, file: File, maxBytes: number): Promise<void> {
  if (!validLimit(maxBytes) || file.size > maxBytes) {
    postError(jobId, 'too_large', 'Trace artifact exceeds the size limit.');
    return;
  }
  const state = createParseState(maxBytes);
  states.set(jobId, state);
  try {
    const reader = file.stream().getReader();
    state.reader = reader;
    if (state.cancelled || states.get(jobId) !== state) {
      await reader.cancel();
      return;
    }
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read();
      if (state.cancelled || states.get(jobId) !== state) return;
      if (next.done) break;
      state.bytes += next.value.byteLength;
      if (state.bytes > maxBytes) {
        await reader.cancel();
        throw new TypeError('Trace artifact exceeds the size limit.');
      }
      state.chunks.push(decoder.decode(next.value, { stream: true }));
    }
    state.chunks.push(decoder.decode());
    state.reader = null;
    finish(jobId, state);
  } catch (error) {
    states.delete(jobId);
    if (state.cancelled) return;
    postClassifiedError(jobId, error);
  }
}

function finish(jobId: string, state: ParseState): void {
  if (state.cancelled || states.get(jobId) !== state) return;
  states.delete(jobId);
  try {
    const serialized = state.chunks.join('');
    state.chunks.splice(0);
    const artifact = parseTraceArtifactJson(serialized, state.maxBytes);
    scope.postMessage({ type: 'artifact_parse_result', jobId, artifact });
  } catch (error) {
    state.chunks.splice(0);
    postClassifiedError(jobId, error);
  }
}

function postClassifiedError(jobId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Trace artifact worker failed.';
  let code: ArtifactWorkerErrorCode = 'invalid_artifact';
  if (/size limit|exceeds/iu.test(message)) code = 'too_large';
  else if (/not valid JSON/iu.test(message)) code = 'invalid_json';
  else if (/schema version is unsupported/iu.test(message)) code = 'unsupported_schema';
  postError(jobId, code, message);
}

function postError(jobId: string, code: ArtifactWorkerErrorCode, message: string): void {
  scope.postMessage({ type: 'artifact_parse_error', jobId, code, message });
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TRACE_ARTIFACT_BYTES;
}

function createParseState(maxBytes: number): ParseState {
  return { chunks: [], bytes: 0, maxBytes, cancelled: false, reader: null };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
