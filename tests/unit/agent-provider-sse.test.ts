import { describe, expect, it, vi } from 'vitest';
import {
  decodeSseStream,
  type SseDecodeOptions,
  type SseEvent,
} from '@/agent-harness/sse';
import { AgentProviderError } from '@/agent-harness/provider';

const encoder = new TextEncoder();

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

async function collect(
  chunks: Uint8Array[],
  options?: SseDecodeOptions,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of decodeSseStream(streamFromChunks(chunks), options)) {
    events.push(event);
  }
  return events;
}

describe('bounded SSE decoding', () => {
  it('decodes every byte boundary including split multibyte UTF-8', async () => {
    const fixture = bytes('data: 雪😀\n\ndata: done\n\n');
    for (let split = 0; split <= fixture.byteLength; split += 1) {
      await expect(collect([
        fixture.slice(0, split),
        fixture.slice(split),
      ])).resolves.toEqual([
        { data: '雪😀' },
        { data: 'done' },
      ]);
    }
  });

  it('supports LF, CRLF and CR framing, comments, multiline data and EOF dispatch', async () => {
    const result = await collect([
      bytes(': ignored\r\nevent: token\r\nid: 7\r\nretry: 25\r\ndata: first\r\n'),
      bytes('data: second\r\nunknown: value\r\n\r\ndata: tail'),
    ]);
    expect(result).toEqual([
      { data: 'first\nsecond', event: 'token', id: '7', retry: 25 },
      { data: 'tail', id: '7' },
    ]);

    await expect(collect([bytes('data: one\r\rdata: two\n\ndata: three')]))
      .resolves.toEqual([{ data: 'one' }, { data: 'two' }, { data: 'three' }]);
  });

  it('ignores comments and metadata-only blocks but dispatches an empty data field', async () => {
    await expect(collect([bytes(': comment\n\nevent: ping\nid: x\n\ndata:\n\n')]))
      .resolves.toEqual([{ data: '', id: 'x' }]);
  });

  it('preserves newlines between empty and non-empty data fields', async () => {
    await expect(collect([bytes('data:\ndata: x\n\n')]))
      .resolves.toEqual([{ data: '\nx' }]);
  });

  it('accepts exact total response bytes and rejects one byte over', async () => {
    const fixture = bytes('data: ok\n\n');
    const exact = { maxResponseBytes: fixture.byteLength, maxEventDataBytes: 2, maxEvents: 1 };
    await expect(collect([fixture], { limits: exact })).resolves.toEqual([{ data: 'ok' }]);

    const error = await collect([fixture], {
      limits: { ...exact, maxResponseBytes: fixture.byteLength - 1 },
    }).then(() => null, (reason: unknown) => reason as AgentProviderError);
    expect(error).toMatchObject({ code: 'provider_response_too_large' });
    expect(error?.message).not.toContain('ok');
  });

  it('accepts exact event data bytes including separators and rejects one byte over', async () => {
    const fixture = bytes('data: 雪\ndata: x\n\n');
    await expect(collect([fixture], {
      limits: { maxResponseBytes: fixture.byteLength, maxEventDataBytes: 5, maxEvents: 1 },
    })).resolves.toEqual([{ data: '雪\nx' }]);

    await expect(collect([fixture], {
      limits: { maxResponseBytes: fixture.byteLength, maxEventDataBytes: 4, maxEvents: 1 },
    })).rejects.toMatchObject({ code: 'provider_response_too_large' });
  });

  it('accepts the exact event count and rejects the next event', async () => {
    const fixture = bytes('data: a\n\ndata: b\n\n');
    await expect(collect([fixture], {
      limits: { maxResponseBytes: fixture.byteLength, maxEventDataBytes: 1, maxEvents: 2 },
    })).resolves.toHaveLength(2);

    await expect(collect([fixture], {
      limits: { maxResponseBytes: fixture.byteLength, maxEventDataBytes: 1, maxEvents: 1 },
    })).rejects.toMatchObject({ code: 'provider_response_too_large' });
  });

  it('fails invalid and truncated UTF-8 without echoing provider data', async () => {
    for (const fixture of [
      Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff]),
      Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe9, 0x9b]),
    ]) {
      const error = await collect([fixture]).then(
        () => null,
        (reason: unknown) => reason as AgentProviderError,
      );
      expect(error).toBeInstanceOf(AgentProviderError);
      expect(error).toMatchObject({ code: 'parse_error' });
      expect(error?.message).toBe('Provider stream is not valid UTF-8.');
    }
  });

  it('rejects invalid resource limits with a bounded protocol error', async () => {
    await expect(collect([bytes('data: x\n\n')], {
      limits: { maxEvents: 0 },
    })).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('cancels the reader and rejects AbortError when the caller aborts a pending read', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel,
    });
    const iterator = decodeSseStream(stream, { signal: controller.signal });
    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels the reader when the consumer stops before EOF', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('data: first\n\n'));
      },
      cancel,
    });
    for await (const event of decodeSseStream(stream)) {
      expect(event.data).toBe('first');
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });
});
