import { describe, expect, it } from 'vitest';
import { nextOpenUnstarFullName } from '@/ui/unstar-popover-state';

describe('unstar popover state', () => {
  it('opens the requested repo and replaces any existing popup', () => {
    expect(nextOpenUnstarFullName(null, 'owner/one', 'owner/one')).toBe('owner/one');
    expect(nextOpenUnstarFullName('owner/one', 'owner/two', 'owner/two')).toBe('owner/two');
  });

  it('ignores stale close events from a popup that is no longer current', () => {
    expect(nextOpenUnstarFullName('owner/two', null, 'owner/one')).toBe('owner/two');
  });

  it('closes the current popup when the close source matches', () => {
    expect(nextOpenUnstarFullName('owner/two', null, 'owner/two')).toBeNull();
  });
});
