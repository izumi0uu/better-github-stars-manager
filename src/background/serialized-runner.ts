export type SerializedJobKind = 'stars-sync' | 'progress';

export type SerializedRunOptions = {
  signal?: AbortSignal;
  kind?: SerializedJobKind;
};

export interface SerializedRunner {
  run<T>(fn: () => Promise<T>, options?: SerializedRunOptions): Promise<T>;
  isRunning(kind?: SerializedJobKind): boolean;
}

export function createSerializedRunner(): SerializedRunner {
  let inFlight: Promise<unknown> | null = null;
  const pendingByKind = new Map<SerializedJobKind, number>();

  const run = async <T>(
    fn: () => Promise<T>,
    options: SerializedRunOptions = {},
  ): Promise<T> => {
    if (options.kind) {
      pendingByKind.set(options.kind, (pendingByKind.get(options.kind) ?? 0) + 1);
    }
    const previous = inFlight;
    const p = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException('Operation aborted.', 'AbortError');
      }
      return fn();
    });
    inFlight = p;
    try {
      return await p;
    } finally {
      if (inFlight === p) inFlight = null;
      if (options.kind) {
        const remaining = (pendingByKind.get(options.kind) ?? 1) - 1;
        if (remaining === 0) pendingByKind.delete(options.kind);
        else pendingByKind.set(options.kind, remaining);
      }
    }
  };

  return {
    run,
    isRunning: (kind) => kind ? (pendingByKind.get(kind) ?? 0) > 0 : inFlight != null,
  };
}
