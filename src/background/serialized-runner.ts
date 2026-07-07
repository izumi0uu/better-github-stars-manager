export interface SerializedRunner {
  run<T>(fn: () => Promise<T>): Promise<T>;
  isRunning(): boolean;
}

export function createSerializedRunner(): SerializedRunner {
  let inFlight: Promise<unknown> | null = null;

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = inFlight;
    const p = (previous ? previous.catch(() => {}) : Promise.resolve()).then(fn);
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
