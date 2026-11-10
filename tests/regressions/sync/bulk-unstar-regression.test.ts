import { describe, expect, it, vi } from 'vitest';
import { bulkUnstarRepositories } from '@/stars/bulk-unstar';

describe('bulk unstar execution', () => {
  it('commits only completed remote operations and leaves remaining repositories retryable', async () => {
    const unstar = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('GH_RATE_LIMIT'));
    const commit = vi.fn().mockResolvedValue(undefined);
    const result = await bulkUnstarRepositories(['octocat/one', 'octocat/two', 'octocat/three'], {
      assertCurrent: async () => {}, unstar, commit,
    });
    expect(result).toEqual({ succeeded: ['octocat/one'], failed: [{ fullName: 'octocat/two', error: 'GH_RATE_LIMIT' }], notAttempted: ['octocat/three'] });
    expect(commit.mock.calls).toEqual([['octocat/one']]);
    expect(unstar).toHaveBeenCalledTimes(2);
  });

  it('does not commit or continue when the account changes during a remote request', async () => {
    let current = true;
    const commit = vi.fn();
    const unstar = vi.fn(async () => { current = false; });
    const result = await bulkUnstarRepositories(['octocat/one', 'octocat/two'], {
      assertCurrent: async () => { if (!current) throw new Error('GITHUB_CREDENTIAL_CHANGED'); }, unstar, commit,
    });
    expect(result.failed[0].error).toBe('GITHUB_CREDENTIAL_CHANGED');
    expect(result.notAttempted).toEqual(['octocat/two']);
    expect(unstar).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([[], ['octocat/one', 'OCTOCAT/one'], ['invalid'], Array.from({ length: 101 }, (_, i) => `octocat/repo-${i}`)].map((names) => ({ names })))('rejects an invalid batch before any mutation', async ({ names }) => {
    const unstar = vi.fn();
    await expect(bulkUnstarRepositories(names, { assertCurrent: async () => {}, unstar, commit: vi.fn() })).rejects.toThrow('INVALID_UNSTAR_BATCH');
    expect(unstar).not.toHaveBeenCalled();
  });
});
