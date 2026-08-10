import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  findDevelopmentBuildHashes,
  PackageExtensionError,
} from '../../scripts/package-extension.mjs';

test('finds every unique development build identity without source-text inspection', () => {
  const hashes = findDevelopmentBuildHashes([
    'const first = "unknown-clean-123abc 89abcdef-a1b2c3-456def";',
    'const second = "01234567-clean-abcdef unknown-clean-123abc";',
  ]);

  assert.deepEqual(hashes, [
    '01234567-clean-abcdef',
    '89abcdef-a1b2c3-456def',
    'unknown-clean-123abc',
  ]);
  assert.equal(Object.isFrozen(hashes), true);
});

test('ignores malformed, differently cased, embedded, and cross-file lookalikes', () => {
  assert.deepEqual(findDevelopmentBuildHashes([
    '0123456-clean-abcdef 012345678-clean-abcdef 01234567-dirty-abcdef',
    '01234567-clean-abcde 01234567-clean-ABCDE x01234567-clean-abcdef',
    '01234567-clean-',
    'abcdef',
  ]), []);
});

test('rejects non-string JavaScript fixtures', () => {
  assert.throws(
    () => findDevelopmentBuildHashes(['valid source', Buffer.from('01234567-clean-abcdef')]),
    (error) => error instanceof PackageExtensionError && error.code === 'bundled_javascript_invalid',
  );
});
