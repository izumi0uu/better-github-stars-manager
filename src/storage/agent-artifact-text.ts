const UTF8_ENCODER = new TextEncoder();

export type AgentArtifactTextChunk = Readonly<{
  payload: string;
  byteLength: number;
}>;

export function splitUtf8Chunks(
  content: string,
  maxBytes: number,
): AgentArtifactTextChunk[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('Artifact chunk byte budget must be a positive safe integer.');
  }
  if (content.length === 0) return [];
  const chunks: AgentArtifactTextChunk[] = [];
  let parts: string[] = [];
  let bytes = 0;
  for (const character of content) {
    const characterBytes = UTF8_ENCODER.encode(character).byteLength;
    if (characterBytes > maxBytes) {
      throw new RangeError('Artifact chunk byte budget cannot fit one UTF-8 code point.');
    }
    if (bytes > 0 && bytes + characterBytes > maxBytes) {
      chunks.push({ payload: parts.join(''), byteLength: bytes });
      parts = [];
      bytes = 0;
    }
    parts.push(character);
    bytes += characterBytes;
  }
  if (parts.length > 0) chunks.push({ payload: parts.join(''), byteLength: bytes });
  return chunks;
}

export function takeUtf8Prefix(
  value: string,
  maxBytes: number,
): Readonly<{ value: string; byteLength: number; characterLength: number }> {
  let byteLength = 0;
  let characterLength = 0;
  const characters: string[] = [];
  for (const character of value) {
    const characterBytes = UTF8_ENCODER.encode(character).byteLength;
    if (byteLength + characterBytes > maxBytes) break;
    characters.push(character);
    byteLength += characterBytes;
    characterLength += character.length;
  }
  return { value: characters.join(''), byteLength, characterLength };
}

export function isStringBoundary(value: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) return false;
  if (offset === 0 || offset === value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

export function utf8BoundaryAtOrBefore(
  value: string,
  requestedByteOffset: number,
): Readonly<{ characterOffset: number; byteOffset: number }> {
  let characterOffset = 0;
  let byteOffset = 0;
  for (const character of value) {
    const nextByteOffset = byteOffset + utf8CodePointByteLength(character);
    if (nextByteOffset > requestedByteOffset) break;
    characterOffset += character.length;
    byteOffset = nextByteOffset;
  }
  return { characterOffset, byteOffset };
}

export function countCodePoints(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

export function takeCodePointSuffix(value: string, maximumCharacters: number): string {
  if (maximumCharacters <= 0 || value.length === 0) return '';
  let start = value.length;
  let count = 0;
  while (start > 0 && count < maximumCharacters) {
    start -= 1;
    const unit = value.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) {
      const previous = value.charCodeAt(start - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
    }
    count += 1;
  }
  return value.slice(start);
}

function utf8CodePointByteLength(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
