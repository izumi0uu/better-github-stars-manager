import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readMaybe(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

describe('table head sticky contract', () => {
  it('keeps one real sticky table head with a stuck-state sentinel', () => {
    const tableSource = [
      readMaybe('src/ui/ManagerPanel.tsx'),
      readMaybe('src/ui/components/StarsTable.tsx'),
    ].join('\n');
    const motionSource = readMaybe('src/ui/styles/motion.css');

    expect(tableSource).toContain('data-table-head');
    expect(tableSource).toContain('data-table-head-sentinel');
    expect(tableSource).toContain('IntersectionObserver');
    expect(tableSource).toContain('sticky top-0');
    expect(tableSource).not.toContain('cloneElement');
    expect(motionSource).toContain('.gsm-table-head-stuck');
  });
});
