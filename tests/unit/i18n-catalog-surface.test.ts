import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { messages } from '@/i18n/messages';

/**
 * TypeScript proves every referenced key exists and that both locales declare the
 * same keys. It cannot prove the opposite direction, so an unreferenced key stays
 * invisible in the product while still costing a translation per locale, and it
 * rots silently.
 *
 * This is the narrow boundary the file protects: the translated surface equals the
 * read surface. It is a static scan because catalog reads happen across hundreds
 * of components and no single runtime path exercises them all.
 *
 * Two deliberate scoping rules keep it honest:
 *
 * - Only product source counts. Scanning `tests` would let a test satisfy the
 *   contract for a key no shipped surface reads.
 * - Only member access counts. Reads reach the catalog through `m.surface.key`,
 *   a typed surface alias such as `MessageCatalog['agentPanel']`, or a hand-written
 *   label interface that copies a subset of keys, so the shape they share is
 *   `.key`. A bare identifier of the same name — a local variable, a parameter, a
 *   comment word — is not a read.
 *
 * Known bound: matching `.key` without its namespace means a key can be credited
 * to an unrelated member of the same name, so this catches abandoned keys rather
 * than proving each individual read. Requiring the full `surface.key` path would
 * flag about 10% of the catalog falsely, because label objects are threaded
 * through props and hand-written interfaces that drop the surface name. Tightening
 * this needs a type-aware pass, not a stricter regex.
 */

const ROOT = process.cwd();
const PRODUCT_ROOT = 'src';
const CATALOG_DIR = path.join('src', 'i18n');
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx']);
const MEMBER_ACCESS = /\.([A-Za-z_$][A-Za-z0-9_$]*)/g;

function leafKeys(value: unknown, trail: readonly string[] = []): readonly string[][] {
  if (!value || typeof value !== 'object') return trail.length > 0 ? [[...trail]] : [];
  return Object.entries(value).flatMap(([key, child]) => (
    typeof child === 'object' && child !== null
      ? leafKeys(child, [...trail, key])
      : [[...trail, key]]
  ));
}

function productFiles(directory: string = PRODUCT_ROOT): readonly string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    // The catalog declares every key, so it can never be its own consumer.
    if (relative === CATALOG_DIR) return [];
    if (entry.isDirectory()) return productFiles(relative);
    return SCANNED_EXTENSIONS.has(path.extname(entry.name)) ? [relative] : [];
  });
}

function readMemberNames(): ReadonlySet<string> {
  const accessed = new Set<string>();
  for (const file of productFiles()) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(MEMBER_ACCESS)) accessed.add(match[1]!);
  }
  return accessed;
}

describe('i18n catalog surface', () => {
  it('has no leaf message key that no product surface reads', () => {
    const accessed = readMemberNames();
    const unread = leafKeys(messages.en)
      .filter((trail) => !accessed.has(trail[trail.length - 1]!))
      .map((trail) => trail.join('.'))
      .sort();

    assert.deepEqual(
      unread,
      [],
      `These catalog keys are read by no product surface. Delete them, or wire them `
      + `into the surface that needs them; every one costs a translation per locale.\n`
      + unread.map((key) => `  - ${key}`).join('\n'),
    );
  });

  it('scans product source and rejects a read that only tests perform', () => {
    // Guards the scan itself. A broken walk, a wrong extension filter, or a scope
    // that leaked into tests would make the contract above vacuously true, so
    // assert on a name the product reads and one only this file mentions.
    const files = productFiles();
    assert.ok(files.length > 200, `expected a populated product tree, found ${files.length} files`);
    assert.ok(files.every((file) => !file.startsWith('tests')), 'test sources must not count as reads');

    const accessed = readMemberNames();
    assert.ok(accessed.has('agentPanel'), 'product catalog reads were not scanned');
    assert.ok(
      !accessed.has('gsmCatalogSurfaceProbeOnlyInThisTest'),
      'the scan must not observe identifiers that live only in test sources',
    );
  });
});
