import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const backgroundSource = readFileSync(new URL('../../src/background/index.ts', import.meta.url), 'utf8');

export function caseBlock(name: string, nextName?: string): string {
  const start = findCase(name);
  const end = nextName
    ? findCase(nextName, start + 1)
    : backgroundSource.indexOf('  } catch', start + 1);
  assert.notEqual(start, -1, `${name} case block should exist`);
  assert.notEqual(end, -1, `${nextName ?? 'catch'} boundary should exist after ${name}`);
  return backgroundSource.slice(start, end);
}

function findCase(name: string, from = 0): number {
  const singleQuoted = backgroundSource.indexOf(`case '${name}':`, from);
  const doubleQuoted = backgroundSource.indexOf(`case "${name}":`, from);
  if (singleQuoted === -1) return doubleQuoted;
  if (doubleQuoted === -1) return singleQuoted;
  return Math.min(singleQuoted, doubleQuoted);
}
