import { describe, it, expect } from 'vitest';
import { nextRevisionNumber, revisionSlotNumber } from './revisionSlot.js';
import { archivedTombstoneLoc } from './tombstoneArchive.js';
import { generateId } from './id.js';

describe('revisionSlot (#2507)', () => {
  it('reads direct slots and their archived tombstone form only', () => {
    expect(revisionSlotNumber('revisions:rev-7')).toBe(7);
    expect(revisionSlotNumber(archivedTombstoneLoc('revisions:rev-12', generateId()))).toBe(12);
  });

  it('ignores descendants, other names and malformed numbers', () => {
    for (const loc of ['revisions:rev-3:child', 'revisions:rev-', 'revisions:rev-0', 'revisions:rev-03', 'revisions:rev-1x',
      'revisions:rev-999999999999', 'revisions:other-5', 'revisions', 'x:revisions:rev-4', 'revisions:rev-2__deleted-a:b']) {
      expect(revisionSlotNumber(loc)).toBeNull();
    }
  });

  it('is 1 + the highest number, not a count', () => {
    expect(nextRevisionNumber([])).toBe(1);
    expect(nextRevisionNumber(['revisions:rev-1', 'revisions:rev-2'])).toBe(3);
    expect(nextRevisionNumber(['revisions:rev-2'])).toBe(3);
    expect(nextRevisionNumber(['revisions:rev-1', 'revisions:rev-9', 'revisions:rev-3:x'])).toBe(10);
    expect(nextRevisionNumber([archivedTombstoneLoc('revisions:rev-5', generateId()), 'revisions:rev-1'])).toBe(6);
  });
});
