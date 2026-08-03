export type SerializedRunOptions = {
  signal?: AbortSignal;
};

export interface SerializedRunner {
  run<T>(fn: () => Promise<T>, options?: SerializedRunOptions): Promise<T>;
  isRunning(): boolean;
}

export function createSerializedRunner(): SerializedRunner {
  let inFlight: Promise<unknown> | null = null;

  const run = async <T>(
    fn: () => Promise<T>,
    options: SerializedRunOptions = {},
  ): Promise<T> => {
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
    }
  };

  return {
    run,
    isRunning: () => inFlight != null,
  };
}
