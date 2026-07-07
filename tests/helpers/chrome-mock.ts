export function response(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

export function createChromeMock() {
  const state: Record<string, unknown> = {};
  const listeners = new Set<
    (changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void
  >();
  let rejectNextSet: Error | null = null;

  return {
    rejectNextSet(error: Error) {
      rejectNextSet = error;
    },
    api: {
      storage: {
        local: {
          async get(key: string) {
            return { [key]: state[key] };
          },
          async set(next: Record<string, unknown>) {
            if (rejectNextSet) {
              const error = rejectNextSet;
              rejectNextSet = null;
              throw error;
            }
            const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
            for (const [key, value] of Object.entries(next)) {
              changes[key] = { oldValue: state[key], newValue: value };
              state[key] = value;
            }
            for (const listener of listeners) listener(changes, 'local');
          },
          async clear() {
            const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
            for (const key of Object.keys(state)) {
              changes[key] = { oldValue: state[key], newValue: undefined };
              delete state[key];
            }
            for (const listener of listeners) listener(changes, 'local');
          },
        },
        onChanged: {
          addListener(listener: (changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void) {
            listeners.add(listener);
          },
          removeListener(listener: (changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void) {
            listeners.delete(listener);
          },
        },
      },
    },
  };
}
