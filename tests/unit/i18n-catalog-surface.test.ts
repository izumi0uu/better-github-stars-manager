import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { messages } from '@/i18n/messages';

/**
 * Static source scan, not a copy assertion. TypeScript already proves that every
 * referenced key exists and that both locales declare the same keys; it cannot
 * prove the opposite direction. An unreferenced key is invisible in the product
 * yet still has to be translated for every locale the extension ships, so it
 * rots silently. This is the narrow boundary this file protects: the translated
 * surface equals the used surface.
 */

const ROOT = process.cwd();
const SOURCE_ROOTS = ['src', 'tests', 'scripts'] as const;
const CATALOG_DIR = path.join('src', 'i18n');
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs']);
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

function leafKeys(value: unknown, trail: readonly string[] = []): readonly string[][] {
  if (!value || typeof value !== 'object') return trail.length > 0 ? [[...trail]] : [];
  return Object.entries(value).flatMap(([key, child]) => (
    typeof child === 'object' && child !== null
      ? leafKeys(child, [...trail, key])
      : [[...trail, key]]
  ));
}

function sourceFiles(directory: string): readonly string[] {
  const absolute = path.join(ROOT, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(relative);
    }
    return SCANNED_EXTENSIONS.has(path.extname(entry.name)) ? [relative] : [];
  });
}

function referencedIdentifiers(): ReadonlySet<string> {
  const found = new Set<string>();
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(root)) {
      // The catalog declares every key, so it can never be its own consumer.
      if (file.startsWith(CATALOG_DIR + path.sep)) continue;
      for (const match of readFileSync(path.join(ROOT, file), 'utf8').matchAll(IDENTIFIER)) {
        found.add(match[0]);
      }
    }
  }
  return found;
}

describe('i18n catalog surface', () => {
  it('has no leaf message key that the product never reads', () => {
    const referenced = referencedIdentifiers();
    const unreferenced = leafKeys(messages.en)
      .filter((trail) => !referenced.has(trail[trail.length - 1]!))
      .map((trail) => trail.join('.'))
      .sort();

    assert.deepEqual(
      unreferenced,
      [],
      `These catalog keys are never read outside ${CATALOG_DIR}. Delete them, or reference `
      + `them from the surface that needs them; every one costs a translation per locale.\n`
      + unreferenced.map((key) => `  - ${key}`).join('\n'),
    );
  });

  it('scans a source tree that actually contains the catalog consumers', () => {
    // Guards the scan itself: a broken walk or extension filter would make the
    // contract above vacuously true.
    const files = SOURCE_ROOTS.flatMap((root) => sourceFiles(root));
    assert.ok(files.length > 500, `expected a populated source tree, found ${files.length} files`);
    assert.ok(referencedIdentifiers().has('agentPanel'), 'catalog surface names were not scanned');
  });
});
