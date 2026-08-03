import type { AgentProviderConnectionFailureDetails } from '@/agent-harness/provider-registry';

export const RAW_CAPTURE_FIELD_MAX_BYTES = 256 * 1024;
export const RAW_CAPTURE_EVENT_MAX_BYTES = 512 * 1024;
export const RAW_CAPTURE_ROOT_MAX_BYTES = 16 * 1024 * 1024;
export const RAW_CAPTURE_PENDING_QUEUE_MAX_BYTES = 2 * 1024 * 1024;

const REDACTION_MARKER = '[REDACTED]';
const KNOWN_SECRET_PATTERNS = [
  /\b(?:sk-(?:proj-|ant-api\d*-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu,
  /(?:^|\n)(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*:[^\r\n]*/giu,
  /(?:^|\\n)(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*:[^"\\\r\n]*/giu,
] as const;

export type RawCaptureField = Readonly<{
  text: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
  configuredSecretMatches: number;
  knownPatternMatches: number;
}>;

export function buildRawCaptureField(
  text: string,
  configuredSecrets: readonly string[],
  maxBytes = RAW_CAPTURE_FIELD_MAX_BYTES,
): RawCaptureField {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > RAW_CAPTURE_FIELD_MAX_BYTES) {
    throw new TypeError('Raw capture field limit is invalid.');
  }
  const originalBytes = utf8Bytes(text);
  const scrubbed = scrubRawCaptureText(text, configuredSecrets);
  const truncatedText = truncateUtf8(scrubbed.text, maxBytes);
  return Object.freeze({
    text: truncatedText,
    originalBytes,
    retainedBytes: utf8Bytes(truncatedText),
    truncated: truncatedText !== scrubbed.text,
    configuredSecretMatches: scrubbed.configuredSecretMatches,
    knownPatternMatches: scrubbed.knownPatternMatches,
  });
}

export function scrubRawCaptureText(
  text: string,
  configuredSecrets: readonly string[],
): Readonly<{
  text: string;
  configuredSecretMatches: number;
  knownPatternMatches: number;
}> {
  let result = text;
  let configuredSecretMatches = 0;
  const uniqueSecrets = [...new Set(configuredSecrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of uniqueSecrets) {
    const parts = result.split(secret);
    const matches = parts.length - 1;
    if (matches === 0) continue;
    configuredSecretMatches += matches;
    result = parts.join(REDACTION_MARKER);
  }

  let knownPatternMatches = 0;
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      knownPatternMatches += 1;
      return REDACTION_MARKER;
    });
  }
  return Object.freeze({ text: result, configuredSecretMatches, knownPatternMatches });
}

export function scrubAgentProviderConnectionFailure(
  failure: AgentProviderConnectionFailureDetails,
  configuredSecrets: readonly string[],
): AgentProviderConnectionFailureDetails {
  return Object.freeze({
    ...failure,
    code: scrubRawCaptureText(failure.code, configuredSecrets).text,
    message: scrubRawCaptureText(failure.message, configuredSecrets).text,
  });
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('UTF-8 limit is invalid.');
  if (utf8Bytes(value) <= maxBytes) return value;
  let retained = '';
  let retainedBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8Bytes(codePoint);
    if (retainedBytes + codePointBytes > maxBytes) break;
    retained += codePoint;
    retainedBytes += codePointBytes;
  }
  return retained;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
