/**
 * Agent session-revision slots (`revisions:rev-N`, written by createRevision).
 *
 * The next number is the highest N EVER used in the memory plus one, never a count of live rows:
 * a count collides with a live `rev-N` once a middle revision is deleted (#2507), and a name must
 * not be reused for a different snapshot after its row is soft-deleted (#2507 ruling).
 */

/** The highest slot the parser reads: 15 digits, below Number.MAX_SAFE_INTEGER. The allocator never emits past it. */
export const MAX_REVISION_SLOT = 999_999_999_999_999;

export class RevisionSlotsExhaustedError extends Error {
  constructor() {
    super(`Revision slots are exhausted: rev-${MAX_REVISION_SLOT} is already used.`);
    this.name = 'RevisionSlotsExhaustedError';
  }
}

/** A DIRECT slot: `revisions:rev-<N>`, or that loc archived by `archivedTombstoneLoc` (`…__deleted-<id>`). No descendants, no other shapes. */
const SLOT_LOC = /^revisions:rev-([1-9][0-9]{0,14})(?:__deleted-[^:]+)?$/;

/** The N of a direct revision slot loc, or null for anything else (descendants, other names, malformed numbers). */
export function revisionSlotNumber(loc: string): number | null {
  const m = SLOT_LOC.exec(loc);
  return m ? Number(m[1]) : null;
}

/**
 * 1 + the highest slot number among `locs` (live, soft-deleted and archived rows alike); 1 when none.
 * Throws RevisionSlotsExhaustedError rather than emit a slot `revisionSlotNumber` would not read back.
 */
export function nextRevisionNumber(locs: Iterable<string>): number {
  let max = 0;
  for (const loc of locs) {
    const n = revisionSlotNumber(loc);
    if (n !== null && n > max) max = n;
  }
  if (max >= MAX_REVISION_SLOT) throw new RevisionSlotsExhaustedError();
  return max + 1;
}
