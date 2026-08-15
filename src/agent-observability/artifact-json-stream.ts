import type { TraceArtifact } from './contracts';

export type TraceArtifactJsonChunk = Readonly<{
  jsonChunk: string;
  byteLength: number;
  done: boolean;
}>;

export type TraceArtifactJsonReader = Readonly<{
  read(maxBytes: number): TraceArtifactJsonChunk;
}>;

export type AsyncTraceArtifactJsonReader = Readonly<{
  read(maxBytes: number): Promise<TraceArtifactJsonChunk>;
  cancel(): Promise<void>;
}>;

/**
 * Serializes an artifact incrementally so the Port never needs a second full
 * JSON string or an array containing every output chunk.
 */
export function createTraceArtifactJsonReader(
  artifact: TraceArtifact,
): TraceArtifactJsonReader {
  const segments = traceArtifactJsonSegments(artifact);
  let pending = '';
  let exhausted = false;

  const advance = (): void => {
    while (!pending && !exhausted) {
      const next = segments.next();
      if (next.done) {
        exhausted = true;
        return;
      }
      pending = next.value;
    }
  };

  return Object.freeze({
    read(maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
        throw new TypeError('Trace artifact chunk limit is invalid.');
      }
      if (exhausted && !pending) {
        throw new TypeError('Trace artifact reader is already complete.');
      }

      const parts: string[] = [];
      let byteLength = 0;
      advance();
      while (pending && byteLength < maxBytes) {
        const taken = takeUtf8Prefix(pending, maxBytes - byteLength);
        if (!taken.prefix) break;
        parts.push(taken.prefix);
        byteLength += taken.byteLength;
        pending = taken.remainder;
        advance();
      }

      return Object.freeze({
        jsonChunk: parts.join(''),
        byteLength,
        done: exhausted && !pending,
      });
    },
  });
}

export function createAsyncTraceArtifactJsonReader(
  source: AsyncIterable<string>,
): AsyncTraceArtifactJsonReader {
  const segments = source[Symbol.asyncIterator]();
  let pending = '';
  let exhausted = false;
  let cancelled = false;

  const advance = async (): Promise<void> => {
    while (!pending && !exhausted) {
      const next = await segments.next();
      if (next.done) {
        exhausted = true;
        return;
      }
      pending = next.value;
    }
  };

  return Object.freeze({
    async read(maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
        throw new TypeError('Trace artifact chunk limit is invalid.');
      }
      if (cancelled || (exhausted && !pending)) {
        throw new TypeError('Trace artifact reader is already complete.');
      }

      const parts: string[] = [];
      let byteLength = 0;
      await advance();
      while (pending && byteLength < maxBytes) {
        const taken = takeUtf8Prefix(pending, maxBytes - byteLength);
        if (!taken.prefix) break;
        parts.push(taken.prefix);
        byteLength += taken.byteLength;
        pending = taken.remainder;
        await advance();
      }

      return Object.freeze({
        jsonChunk: parts.join(''),
        byteLength,
        done: exhausted && !pending,
      });
    },
    async cancel() {
      if (cancelled || (exhausted && !pending)) return;
      cancelled = true;
      pending = '';
      exhausted = true;
      await segments.return?.();
    },
  });
}

function* traceArtifactJsonSegments(artifact: TraceArtifact): Generator<string> {
  yield '{"schemaVersion":';
  yield JSON.stringify(artifact.schemaVersion);
  yield ',"exporterVersion":';
  yield JSON.stringify(artifact.exporterVersion);
  yield ',"exportedAt":';
  yield JSON.stringify(artifact.exportedAt);
  yield ',"scope":';
  yield JSON.stringify(artifact.scope);
  yield ',"build":';
  yield JSON.stringify(artifact.build);
  yield ',"completeness":';
  yield JSON.stringify(artifact.completeness);
  yield ',"roots":';
  yield* jsonArraySegments(artifact.roots);
  yield ',"spans":';
  yield* jsonArraySegments(artifact.spans);
  yield ',"events":';
  yield* jsonArraySegments(artifact.events);
  yield ',"aggregates":';
  yield JSON.stringify(artifact.aggregates);
  yield ',"integrity":';
  yield JSON.stringify(artifact.integrity);
  yield '}';
}

function* jsonArraySegments(values: readonly unknown[]): Generator<string> {
  yield '[';
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) yield ',';
    yield JSON.stringify(values[index]);
  }
  yield ']';
}

function takeUtf8Prefix(
  value: string,
  maxBytes: number,
): Readonly<{ prefix: string; remainder: string; byteLength: number }> {
  let codeUnits = 0;
  let byteLength = 0;
  for (const codePoint of value) {
    const nextBytes = utf8CodePointBytes(codePoint);
    if (byteLength + nextBytes > maxBytes) break;
    byteLength += nextBytes;
    codeUnits += codePoint.length;
  }
  return {
    prefix: value.slice(0, codeUnits),
    remainder: value.slice(codeUnits),
    byteLength,
  };
}

function utf8CodePointBytes(codePoint: string): number {
  const value = codePoint.codePointAt(0)!;
  if (value <= 0x7f) return 1;
  if (value <= 0x7ff) return 2;
  if (value <= 0xffff) return 3;
  return 4;
}
