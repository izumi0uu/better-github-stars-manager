import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const backgroundSource = readFileSync(new URL('../../src/background/index.ts', import.meta.url), 'utf8');

export function caseBlock(name: string, nextName?: string): string {
  const start = backgroundSource.indexOf(`case '${name}': {`);
  const end = nextName
    ? backgroundSource.indexOf(`case '${nextName}':`, start + 1)
    : backgroundSource.indexOf('  } catch', start + 1);
  assert.notEqual(start, -1, `${name} case block should exist`);
  assert.notEqual(end, -1, `${nextName ?? 'catch'} boundary should exist after ${name}`);
  return backgroundSource.slice(start, end);
}
