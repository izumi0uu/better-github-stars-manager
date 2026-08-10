import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

const source = readFileSync(new URL('../../src/ui/ManagerPanel.tsx', import.meta.url), 'utf8');

describe('ManagerPanel sidebar tag mutation wiring', () => {
  it('uses success-only refresh plus a separate message callback for sidebar tag mutations', () => {
    assert.match(source, /onTagMutationMessage=\{\(message\) => \{/);
    assert.match(source, /onTagMutationSuccess=\{refreshStars\}/);
    assert.doesNotMatch(source, /onTagDeleted=/);

    const messageCallback = source.match(/onTagMutationMessage=\{\(message\) => \{[\s\S]*?\}\}/)?.[0] ?? '';
    assert.ok(messageCallback, 'FilterSidebar tag mutation message callback should exist');
    assert.doesNotMatch(messageCallback, /refreshStars\(\)/);
    assert.match(messageCallback, /if \(message\) setInfo\(message\);/);
  });
});
