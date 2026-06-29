import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  isImeComposing,
  shouldIgnoreImeAction,
} from '../../src/ui/hooks/use-ime-input.ts';

describe('IME helpers', () => {
  it('detects the native composition flag', () => {
    assert.equal(isImeComposing({ nativeEvent: { isComposing: true } }), true);
    assert.equal(isImeComposing({ nativeEvent: { isComposing: false } }), false);
    assert.equal(
      isImeComposing({ nativeEvent: { inputType: 'insertCompositionText' } }),
      true,
    );
    assert.equal(isImeComposing({ nativeEvent: {} }), false);
    assert.equal(isImeComposing(undefined), false);
  });

  it('blocks submit-like actions while composition is still active', () => {
    const composingRef = { current: true };
    assert.equal(shouldIgnoreImeAction({}, composingRef), true);

    composingRef.current = false;
    assert.equal(
      shouldIgnoreImeAction({ nativeEvent: { isComposing: true } }, composingRef),
      true,
    );
    assert.equal(
      shouldIgnoreImeAction({ nativeEvent: { isComposing: false } }, composingRef),
      false,
    );
    assert.equal(
      shouldIgnoreImeAction({ nativeEvent: { keyCode: 229 } }, composingRef),
      true,
    );
  });
});
