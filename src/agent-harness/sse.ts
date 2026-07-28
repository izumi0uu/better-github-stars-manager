import {
  AgentProviderError,
  MAX_PROVIDER_RESPONSE_BYTES,
} from './provider';

export const MAX_SSE_EVENT_DATA_BYTES = 256 * 1024;
export const MAX_SSE_EVENTS = 4_096;

export type SseEvent = Readonly<{
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}>;

export type SseDecodeLimits = Readonly<{
  maxResponseBytes: number;
  maxEventDataBytes: number;
  maxEvents: number;
}>;

export type SseDecodeOptions = Readonly<{
  signal?: AbortSignal;
  limits?: Partial<SseDecodeLimits>;
}>;

const DEFAULT_LIMITS: SseDecodeLimits = {
  maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
  maxEventDataBytes: MAX_SSE_EVENT_DATA_BYTES,
  maxEvents: MAX_SSE_EVENTS,
};

export async function* decodeSseStream(
  stream: ReadableStream<Uint8Array>,
  options: SseDecodeOptions = {},
): AsyncGenerator<SseEvent> {
  const limits = resolveLimits(options.limits);
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const pending: SseEvent[] = [];
  let totalBytes = 0;
  let eventCount = 0;
  let line = '';
  let skipLeadingLf = false;
  let data = '';
  let dataBytes = 0;
  let hasDataField = false;
  let eventType = '';
  let lastEventId: string | undefined;
  let retry: number | undefined;
  let reachedEof = false;
  let cancellationRequested = false;

  const cancelReader = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    void reader.cancel().catch(() => undefined);
  };

  const dispatch = () => {
    if (!hasDataField) {
      eventType = '';
      retry = undefined;
      return;
    }
    eventCount += 1;
    if (eventCount > limits.maxEvents) {
      throw tooLarge('Provider stream exceeds the event-count limit.');
    }
    pending.push({
      data,
      ...(eventType ? { event: eventType } : {}),
      ...(lastEventId === undefined ? {} : { id: lastEventId }),
      ...(retry === undefined ? {} : { retry }),
    });
    data = '';
    dataBytes = 0;
    hasDataField = false;
    eventType = '';
    retry = undefined;
  };

  const appendData = (value: string) => {
    const valueBytes = encoder.encode(value).byteLength;
    const separatorBytes = hasDataField ? 1 : 0;
    if (dataBytes + separatorBytes + valueBytes > limits.maxEventDataBytes) {
      throw tooLarge('Provider stream event exceeds the data-byte limit.');
    }
    if (separatorBytes === 1) data += '\n';
    data += value;
    dataBytes += separatorBytes + valueBytes;
    hasDataField = true;
  };

  const processLine = (value: string) => {
    if (value === '') {
      dispatch();
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon === -1 ? value : value.slice(0, colon);
    let fieldValue = colon === -1 ? '' : value.slice(colon + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    switch (field) {
      case 'data':
        appendData(fieldValue);
        break;
      case 'event':
        eventType = fieldValue;
        break;
      case 'id':
        if (!fieldValue.includes('\0')) lastEventId = fieldValue;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(fieldValue)) {
          const parsed = Number(fieldValue);
          if (Number.isSafeInteger(parsed)) retry = parsed;
        }
        break;
      default:
        break;
    }
  };

  const processText = (text: string) => {
    for (const character of text) {
      if (character === '\r') {
        processLine(line);
        line = '';
        skipLeadingLf = true;
        continue;
      }
      if (character === '\n') {
        if (skipLeadingLf) {
          skipLeadingLf = false;
        } else {
          processLine(line);
          line = '';
        }
        continue;
      }
      skipLeadingLf = false;
      line += character;
    }
  };

  try {
    while (true) {
      const next = await readWithAbort(reader, options.signal, cancelReader);
      if (next.done) {
        reachedEof = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new AgentProviderError(
          'protocol_error',
          'Provider stream returned a non-byte chunk.',
        );
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > limits.maxResponseBytes) {
        throw tooLarge('Provider stream exceeds the response-byte limit.');
      }
      try {
        processText(decoder.decode(next.value, { stream: true }));
      } catch (error) {
        if (error instanceof AgentProviderError) throw error;
        throw invalidUtf8();
      }
      while (pending.length > 0) yield pending.shift()!;
    }

    try {
      processText(decoder.decode());
    } catch (error) {
      if (error instanceof AgentProviderError) throw error;
      throw invalidUtf8();
    }
    if (line !== '') processLine(line);
    dispatch();
    while (pending.length > 0) yield pending.shift()!;
  } finally {
    if (!reachedEof) cancelReader();
    try {
      reader.releaseLock();
    } catch {
      // A cancellation can settle after the generator has released ownership.
    }
  }
}

function resolveLimits(overrides: Partial<SseDecodeLimits> | undefined): SseDecodeLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AgentProviderError(
        'protocol_error',
        `Provider stream ${name} must be a positive safe integer.`,
      );
    }
  }
  return limits;
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  cancelReader: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    cancelReader();
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cancelReader();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function invalidUtf8(): AgentProviderError {
  return new AgentProviderError('parse_error', 'Provider stream is not valid UTF-8.');
}

function tooLarge(message: string): AgentProviderError {
  return new AgentProviderError('provider_response_too_large', message);
}
