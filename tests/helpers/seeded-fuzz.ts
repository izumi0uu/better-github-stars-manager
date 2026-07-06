export interface FuzzCaseConfig {
  seed: string;
  cases: number[];
  totalCases: number;
  singleCase: number | null;
}

export class SeededRng {
  private state: number;

  constructor(seed: string | number) {
    this.state = hashSeed(String(seed));
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let next = this.state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    if (max < min) throw new Error(`Invalid rng range: ${min}..${max}`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Cannot pick from an empty array');
    return items[this.int(0, items.length - 1)];
  }

  maybe<T>(value: T, probability = 0.5): T | null {
    return this.bool(probability) ? value : null;
  }

  subset<T>(items: readonly T[], max = items.length): T[] {
    const shuffled = this.shuffle(items);
    return shuffled.slice(0, this.int(0, Math.min(max, items.length)));
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

export function createRng(suiteSeed: string, caseIndex: number): SeededRng {
  return new SeededRng(`${suiteSeed}:${caseIndex}`);
}

export function fuzzCases(prefix: string, defaultSeed: string, defaultCases: number): FuzzCaseConfig {
  const seed = env(`${prefix}_SEED`) ?? env('FUZZ_SEED') ?? defaultSeed;
  const single = parseOptionalInt(env(`${prefix}_CASE`));
  const count = parsePositiveInt(env(`${prefix}_CASES`) ?? env('FUZZ_CASES'), defaultCases);
  const cases = single === null ? Array.from({ length: count }, (_value, index) => index) : [single];
  return { seed, cases, totalCases: count, singleCase: single };
}

export function replayCommand(prefix: string, seed: string, caseIndex: number, file: string): string {
  return `${prefix}_SEED=${shellValue(seed)} ${prefix}_CASE=${caseIndex} corepack pnpm exec vitest run ${file}`;
}

export function fuzzFailure(params: {
  suite: string;
  prefix: string;
  seed: string;
  caseIndex: number;
  file: string;
  invariant: string;
  trace?: unknown;
  expected?: unknown;
  actual?: unknown;
}): string {
  const lines = [
    `[${params.suite}] invariant failed: ${params.invariant}`,
    `seed: ${params.seed}`,
    `case: ${params.caseIndex}`,
    `replay: ${replayCommand(params.prefix, params.seed, params.caseIndex, params.file)}`,
  ];
  if ('expected' in params) lines.push(`expected: ${stableStringify(params.expected)}`);
  if ('actual' in params) lines.push(`actual: ${stableStringify(params.actual)}`);
  if ('trace' in params) lines.push(`trace: ${stableStringify(params.trace)}`);
  return lines.join('\n');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForJson(value), null, 2);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = parseInteger(value);
  if (parsed < 0) throw new Error(`Invalid fuzz case index: ${value}`);
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInteger(value);
  if (parsed <= 0) throw new Error(`Invalid fuzz case count: ${value}`);
  return parsed;
}

function parseInteger(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid fuzz integer: ${value}`);
  return Number(value);
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortForJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

function shellValue(value: string): string {
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
