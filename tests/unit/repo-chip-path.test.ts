import { describe, expect, it } from 'vitest';
import { parseRepoFromPathname } from '@/content/repo-chip/repo-path';

describe('parseRepoFromPathname', () => {
  it('accepts repository paths', () => {
    expect(parseRepoFromPathname('/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoFromPathname('/owner/repo/issues')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('rejects GitHub top-level non-repo paths', () => {
    expect(parseRepoFromPathname('/settings/profile')).toBeNull();
    expect(parseRepoFromPathname('/topics/react')).toBeNull();
    expect(parseRepoFromPathname('/pulls/assigned')).toBeNull();
  });

  it('rejects non-repo document-like paths', () => {
    expect(parseRepoFromPathname('/about.html')).toBeNull();
    expect(parseRepoFromPathname('/owner/repo.name')).toBeNull();
  });
});
