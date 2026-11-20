/**
 * #4488 — an Agent's revisions as a list, and the rules for deleting one.
 *
 * A revision is a direct `revisions:rev-<N>` node of the Agent's system memory (createRevision). The slot
 * numbers are never reused (#2507): the next one is 1 + the highest EVER used, soft-deleted and archived
 * rows included. So a delete removes a revision from the list and from restore; it does not lower the
 * highest slot, and so does not free one. The list reports the slot facts a client needs to say so.
 */
import type { Prisma } from '../generated/prisma/index.js';
import { MAX_REVISION_SLOT, revisionSlotNumber } from './revisionSlot.js';

export interface AgentRevisionRow {
  revisionLoc: string;
  label: string;
  published: boolean;
  description: string | null;
  createdAt: Date;
}

export interface AgentRevisionList {
  revisions: AgentRevisionRow[];
  /** The highest slot number a revision can take. */
  slotLimit: number;
  /** The highest slot number ever used in this memory (live, soft-deleted and archived rows). 0 when none. */
  highestSlotUsed: number;
  /** slotLimit minus highestSlotUsed: the saves left before REVISION_SLOTS_EXHAUSTED. */
  slotsRemaining: number;
}

/** A live direct revision slot: `revisions:rev-<N>` exactly (not an archived tombstone, not a descendant). */
export function isLiveSlotLoc(loc: string): boolean {
  return revisionSlotNumber(loc) !== null && !loc.includes('__deleted-');
}

/** Newest first: by slot number descending (the slot order IS the save order), ties impossible. */
export async function listAgentRevisions(
  db: Prisma.TransactionClient,
  systemMemoryId: string,
  publishedRevisionLoc: string | null,
): Promise<AgentRevisionList> {
  const rows = await db.node.findMany({
    where: { memoryId: systemMemoryId, loc: { startsWith: 'revisions:rev-' } },
    select: { loc: true, name: true, description: true, createdAt: true, deletedAt: true },
  });
  let highest = 0;
  const live: Array<AgentRevisionRow & { n: number }> = [];
  for (const r of rows) {
    const n = revisionSlotNumber(r.loc);
    if (n === null) continue;
    if (n > highest) highest = n;
    if (r.deletedAt !== null || r.loc.includes('__deleted-')) continue;
    live.push({
      n,
      revisionLoc: r.loc,
      label: r.name,
      published: r.loc === publishedRevisionLoc,
      description: r.description ?? null,
      createdAt: r.createdAt,
    });
  }
  live.sort((a, b) => b.n - a.n);
  return {
    revisions: live.map(({ n: _n, ...row }) => row),
    slotLimit: MAX_REVISION_SLOT,
    highestSlotUsed: highest,
    slotsRemaining: MAX_REVISION_SLOT - highest,
  };
}
