import { describe, expect, it } from 'vitest';
import {
  countCodePoints,
  isStringBoundary,
  splitUtf8Chunks,
  takeCodePointSuffix,
  takeUtf8Prefix,
  utf8BoundaryAtOrBefore,
} from '@/storage/agent-artifact-text';

describe('Agent artifact UTF-8 helpers', () => {
  it('splits without cutting multibyte code points', () => {
    expect(splitUtf8Chunks('ab😀é', 4)).toEqual([
      { payload: 'ab', byteLength: 2 },
      { payload: '😀', byteLength: 4 },
      { payload: 'é', byteLength: 2 },
    ]);
  });

  it('rejects a byte budget that cannot contain the next code point', () => {
    expect(() => splitUtf8Chunks('a', 0)).toThrow(/positive safe integer/i);
    expect(() => splitUtf8Chunks('😀', 1)).toThrow(/one UTF-8 code point/i);
  });

  it('takes a byte-bounded prefix and reports UTF-16 character length', () => {
    expect(takeUtf8Prefix('a😀é', 5)).toEqual({
      value: 'a😀',
      byteLength: 5,
      characterLength: 3,
    });
  });

  it('rounds byte positions down to the previous code-point boundary', () => {
    expect(utf8BoundaryAtOrBefore('a😀b', 3)).toEqual({
      characterOffset: 1,
      byteOffset: 1,
    });
    expect(utf8BoundaryAtOrBefore('a😀b', 5)).toEqual({
      characterOffset: 3,
      byteOffset: 5,
    });
  });

  it('counts and slices Unicode code points without returning half a surrogate pair', () => {
    expect(countCodePoints('a😀é')).toBe(3);
    expect(takeCodePointSuffix('a😀é', 2)).toBe('😀é');
    expect(isStringBoundary('a😀b', 1)).toBe(true);
    expect(isStringBoundary('a😀b', 2)).toBe(false);
    expect(isStringBoundary('a😀b', 3)).toBe(true);
  });
});
