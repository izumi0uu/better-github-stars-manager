export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set(), false) ?? 'null';
}

function serializeCanonical(
  input: unknown,
  ancestors: Set<object>,
  arrayEntry: boolean,
): string | undefined {
  let value = input;
  if (value && typeof value === 'object') {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') value = toJSON.call(value);
  }
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'bigint') throw new TypeError('BigInt is not valid canonical JSON.');
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return arrayEntry ? 'null' : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  if (ancestors.has(value)) throw new TypeError('Cyclic value is not valid canonical JSON.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = Array.from({ length: value.length }, (_, index) =>
        serializeCanonical(index in value ? value[index] : undefined, ancestors, true) ?? 'null');
      return `[${entries.join(',')}]`;
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const serialized = serializeCanonical(
        (value as Record<string, unknown>)[key],
        ancestors,
        false,
      );
      if (serialized !== undefined) entries.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}
