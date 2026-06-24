import assert from 'node:assert/strict';
import {
  isImeComposing,
  shouldIgnoreImeAction,
} from '../src/ui/hooks/use-ime-input.ts';

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('IME helpers:');

test('detects the native composition flag', () => {
  assert.equal(isImeComposing({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isImeComposing({ nativeEvent: { isComposing: false } }), false);
  assert.equal(isImeComposing({ nativeEvent: {} }), false);
  assert.equal(isImeComposing(undefined), false);
});

test('blocks submit-like actions while composition is still active', () => {
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
});

console.log('\n✅ IME helper tests passed');
