import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, it } from 'vitest';
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
 * - Only parsed member-access expressions count: `.key`, `?.key`, and computed
 *   string or no-substitution template names. Bare identifiers, type references,
 *   comments, and literal text are not reads; expressions inside JSX and template
 *   substitutions are scanned normally.
 *
 * Known bound: matching member names without their namespace means a key can be
 * credited to an unrelated member of the same name, so this catches abandoned
 * keys rather than proving each individual read. Label objects are threaded
 * through typed aliases, props, and hand-written interfaces that drop the surface
 * name. Resolving those namespaces or dynamic computed names needs a type-aware
 * pass, not just syntax.
 */

const ROOT = process.cwd();
const PRODUCT_ROOT = 'src';
const CATALOG_DIR = path.join('src', 'i18n');
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx']);

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

function collectMemberNames(
  source: string,
  file: string,
  accessed: Set<string> = new Set<string>(),
): ReadonlySet<string> {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    path.extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      accessed.add(node.name.text);
    } else if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        accessed.add(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return accessed;
}

function readMemberNames(files: readonly string[]): ReadonlySet<string> {
  const accessed = new Set<string>();
  for (const file of files) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    collectMemberNames(source, file, accessed);
  }
  return accessed;
}

describe('catalog member-access detection', () => {
  it.each(['sample.ts', 'sample.tsx'])('collects real static member names in %s', (file) => {
    const source = [
      'labels.title;',
      'labels?.subtitle;',
      'labels["caption"];',
      "labels['description'];",
      'labels[`summary`];',
      'labels?.["hint"];',
      'labels?.[`tooltip`];',
      'labels.title;',
    ].join('\n');

    assert.deepEqual(
      [...collectMemberNames(source, file)].sort(),
      ['caption', 'description', 'hint', 'subtitle', 'summary', 'title', 'tooltip'],
    );
  });

  it('parses TypeScript assertions as expressions rather than JSX', () => {
    assert.deepEqual(
      [...collectMemberNames('(<Labels>labels).heading;', 'sample.ts')],
      ['heading'],
    );
  });

  it('collects expressions within JSX and template substitutions, not their literal text', () => {
    const source = [
      'const view = <span title="labels.attributeText" aria-label={labels.accessibleName}>',
      '  labels.childText {labels.visibleName}',
      '</span>;',
      'const text = `labels.templateHead ${labels.interpolatedName} labels.templateTail`;',
    ].join('\n');

    assert.deepEqual(
      [...collectMemberNames(source, 'sample.tsx')].sort(),
      ['accessibleName', 'interpolatedName', 'visibleName'],
    );
  });

  it.each([
    ['line comments', '// labels.commentName'],
    ['block comments', '/* labels.commentName */'],
    ['single-quoted strings', "const text = 'labels.quotedName';"],
    ['double-quoted strings', 'const text = "labels.quotedName";'],
    ['template text', 'const text = `labels.templateName`;'],
    ['regular expressions', 'const pattern = /labels.regexName/;'],
    ['type references', 'type Label = Labels.typeName;'],
    ['dynamic computed names', 'labels[key]; labels[`prefix${key}`];'],
  ])('does not credit %s as member reads', (_kind, source) => {
    assert.deepEqual([...collectMemberNames(source, 'sample.ts')], []);
  });
});

describe('i18n catalog surface', () => {
  let files: readonly string[];
  let accessed: ReadonlySet<string>;

  beforeAll(() => {
    files = productFiles();
    accessed = readMemberNames(files);
  });

  it('has no leaf message key that no product surface reads', () => {
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
    assert.ok(files.length > 200, `expected a populated product tree, found ${files.length} files`);
    assert.ok(files.every((file) => !file.startsWith('tests')), 'test sources must not count as reads');

    assert.ok(accessed.has('agentPanel'), 'product catalog reads were not scanned');
    assert.ok(
      !accessed.has('gsmCatalogSurfaceProbeOnlyInThisTest'),
      'the scan must not observe identifiers that live only in test sources',
    );
  });
});
