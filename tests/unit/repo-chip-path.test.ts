import { describe, expect, it } from 'vitest';
import { parseRepoFromPathname } from '@/content/repo-chip/repo-path';

describe('parseRepoFromPathname', () => {
  it('accepts repository paths', () => {
    expect(parseRepoFromPathname('/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoFromPathname('/owner/repo/issues')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoFromPathname('/owner/owner.github.io')).toEqual({ owner: 'owner', repo: 'owner.github.io' });
  });

  it('rejects GitHub top-level non-repo paths', () => {
    expect(parseRepoFromPathname('/settings/profile')).toBeNull();
    expect(parseRepoFromPathname('/topics/react')).toBeNull();
    expect(parseRepoFromPathname('/pulls/assigned')).toBeNull();
  });

  it('rejects non-repo document-like top-level paths', () => {
    expect(parseRepoFromPathname('/about.html')).toBeNull();
  });
});
