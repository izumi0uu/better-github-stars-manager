import {
  MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES,
} from './const';

export type ToolResult<TData = unknown> =
  | { ok: true; data: TData }
  | { ok: false; error: { code: string; message: string } };

export type ToolResultLimits = Readonly<{
  successBytes?: number;
  errorBytes?: number;
}>;

export type SerializedToolResult = Readonly<{
  result: ToolResult;
  serialized: string;
  byteLength: number;
  fallbackReason?: 'serialization_failed' | 'too_large';
}>;

const encoder = new TextEncoder();
const MAX_ERROR_CODE_BYTES = 128;
const MAX_ERROR_MESSAGE_BYTES = 3 * 1024;

const SERIALIZATION_FAILED_RESULT = errorToolResult(
  'tool_result_serialization_failed',
  'Tool result could not be serialized safely.',
);
const TOO_LARGE_RESULT = errorToolResult(
  'tool_result_too_large',
  'Tool result exceeded the configured byte limit.',
);

export class ToolResultLimitError extends Error {
  constructor() {
    super('Configured limit cannot contain the required tool-result fallback.');
    this.name = 'ToolResultLimitError';
  }
}

export function okToolResult<TData>(data: TData): ToolResult<TData> {
  return { ok: true, data };
}

export function errorToolResult(code: string, message: string): ToolResult<never> {
  return { ok: false, error: { code, message } };
}

export function serializeBoundedToolResult(
  candidate: ToolResult,
  limits: ToolResultLimits = {},
): SerializedToolResult {
  const successLimit = normalizeLimit(
    limits.successBytes,
    MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES,
  );
  const errorLimit = normalizeLimit(
    limits.errorBytes,
    MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  );

  let normalized: ToolResult;
  try {
    normalized = candidate.ok ? candidate : sanitizeErrorResult(candidate);
  } catch {
    return {
      ...serializeFallback(SERIALIZATION_FAILED_RESULT),
      fallbackReason: 'serialization_failed',
    };
  }
  const measured = serializeOnce(normalized);
  if (!measured) {
    return {
      ...serializeFallback(SERIALIZATION_FAILED_RESULT),
      fallbackReason: 'serialization_failed',
    };
  }
  const limit = normalized.ok ? successLimit : errorLimit;
  if (measured.byteLength <= limit) {
    return { result: normalized, ...measured };
  }
  return { ...serializeFallback(TOO_LARGE_RESULT), fallbackReason: 'too_large' };
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let result = '';
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (byteLength + characterBytes > maxBytes) break;
    result += character;
    byteLength += characterBytes;
  }
  return result;
}

function serializeFallback(result: ToolResult): SerializedToolResult {
  const measured = serializeOnce(result);
  if (!measured || measured.byteLength > MAX_GENERIC_TOOL_ERROR_RESULT_BYTES) {
    throw new ToolResultLimitError();
  }
  return { result, ...measured };
}

function sanitizeErrorResult(result: Extract<ToolResult, { ok: false }>): ToolResult {
  return errorToolResult(
    truncateUtf8(safeString(result.error?.code), MAX_ERROR_CODE_BYTES),
    truncateUtf8(safeString(result.error?.message), MAX_ERROR_MESSAGE_BYTES),
  );
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'Unavailable error detail.';
  }
}

function serializeOnce(value: ToolResult): { serialized: string; byteLength: number } | null {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return null;
    return { serialized, byteLength: encoder.encode(serialized).byteLength };
  } catch {
    return null;
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid byte limit.');
  return value;
}
