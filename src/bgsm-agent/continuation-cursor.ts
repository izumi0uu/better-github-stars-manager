import { canonicalJson } from '@/agent-harness/canonical-json';
import { isRunId, type RunId } from './identity';
import {
  CONTINUATION_CURSOR_TOKEN_PREFIX,
  parseContinuationCursorToken,
  type ContinuationCursorToken,
  type FrozenScopeCursor,
} from './scope';

type CursorPayload = Readonly<{
  version: 1;
  runId: RunId;
  generation: number;
  nextFrozenIndex: number;
}>;

export type ContinuationCursorAuthority = Readonly<{
  runId: RunId;
  generation: number;
  scopeCount: number;
  minimumNextFrozenIndex: number;
  authKey: string;
}>;

export async function issueContinuationCursor(
  cursor: FrozenScopeCursor,
  authKey: string,
): Promise<ContinuationCursorToken> {
  validateAuthKey(authKey);
  validateCursorPayload(cursor);
  const payload: CursorPayload = Object.freeze({ version: 1, ...cursor });
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(canonicalJson(payload)));
  const signature = await sign(encodedPayload, authKey);
  return parseContinuationCursorToken(
    `${CONTINUATION_CURSOR_TOKEN_PREFIX}${encodedPayload}.${encodeBase64Url(signature)}`,
  );
}

export async function resolveContinuationCursor(
  token: ContinuationCursorToken,
  authority: ContinuationCursorAuthority,
): Promise<FrozenScopeCursor> {
  validateAuthority(authority);
  const encoded = token.slice(CONTINUATION_CURSOR_TOKEN_PREFIX.length);
  const parts = encoded.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidCursor();
  let signature: Uint8Array;
  let payload: unknown;
  try {
    signature = decodeBase64Url(parts[1]);
    const verified = await verify(parts[0], signature, authority.authKey);
    if (!verified) throw invalidCursor();
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(parts[0])));
  } catch {
    throw invalidCursor();
  }
  validateCursorPayload(payload);
  if (
    payload.runId !== authority.runId ||
    payload.generation !== authority.generation ||
    payload.nextFrozenIndex < authority.minimumNextFrozenIndex ||
    payload.nextFrozenIndex > authority.scopeCount
  ) {
    throw invalidCursor();
  }
  return Object.freeze({
    runId: payload.runId,
    generation: payload.generation,
    nextFrozenIndex: payload.nextFrozenIndex,
  });
}

function validateAuthority(authority: ContinuationCursorAuthority): void {
  if (!isRunId(authority.runId)) throw invalidCursor();
  assertNonnegativeSafeInteger(authority.generation);
  assertNonnegativeSafeInteger(authority.scopeCount);
  assertNonnegativeSafeInteger(authority.minimumNextFrozenIndex);
  if (authority.minimumNextFrozenIndex > authority.scopeCount) throw invalidCursor();
  validateAuthKey(authority.authKey);
}

function validateCursorPayload(value: unknown): asserts value is CursorPayload | FrozenScopeCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const payloadHasVersion = 'version' in record;
  const expected = payloadHasVersion
    ? ['generation', 'nextFrozenIndex', 'runId', 'version']
    : ['generation', 'nextFrozenIndex', 'runId'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalidCursor();
  }
  if (payloadHasVersion && record.version !== 1) throw invalidCursor();
  if (!isRunId(record.runId)) throw invalidCursor();
  assertNonnegativeSafeInteger(record.generation);
  assertNonnegativeSafeInteger(record.nextFrozenIndex);
}

function validateAuthKey(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw new TypeError('Continuation cursor authority is invalid.');
  }
}

async function sign(value: string, authKey: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

async function verify(value: string, signature: Uint8Array, authKey: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    new TextEncoder().encode(value),
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCursor();
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - value.length % 4) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assertNonnegativeSafeInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidCursor();
}

function invalidCursor(): TypeError {
  return new TypeError('Continuation cursor is invalid, stale, or outside the authoritative run.');
}
