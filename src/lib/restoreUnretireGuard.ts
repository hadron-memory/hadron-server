/**
 * #3587 (ruling 0220) — a snapshot restore must not un-retire a minted spec.
 *
 * `restoreRevision` writes the snapshot's tags over the live rows. A snapshot taken before a retirement carries no
 * `superseded` tag, so restoring it would drop the tag from a spec that carries it now. This check refuses that
 * restore, naming the specs, before anything is soft-deleted or written.
 *
 * It is a NEW rule keyed on each node's own mint record (cor:dmo:120:09, 120:08): `Node.mintedAt`, in a memory that is
 * not encrypted (120:00). It is deliberately NOT gated on `isMintedSpecPermanenceEnforced()` and never reads
 * `Memory.corpusMintedAt`; the two disabled #1591 guards stay as they are.
 *
 * What it does not do (ruling 0220 / the gate): protect a `superseded-by*` edge, refuse a restore that tombstones a
 * retired spec by omitting it, guard `restoreNode` or `restoreNodeRevision`, or restore the abstract.
 *
 * The rows at the snapshot's locs are read AFTER the advisory locks and under `FOR NO KEY UPDATE` (id order; the strength a soft delete takes, so an in-flight edge insert onto one of these rows, which holds `KEY SHARE`, is not made to wait: #4313 pins that window), live and
 * tombstoned alike, so a retirement that committed first is seen, and one still holding its row is waited for.
 * Run it inside the restore's transaction.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from './bootPrompt.js';

export const SUPERSEDED_TAG = 'superseded';
export const RESTORE_WOULD_UNRETIRE_SPEC = 'RESTORE_WOULD_UNRETIRE_SPEC';
const LOC_LIST_CAP = 10;

/**
 * The tags a snapshot entry holds. A missing field is `[]` (as the restore itself reads it), an array of strings is
 * itself, and anything else is malformed: revision data is JSON a system-memory writer can edit, and a string must
 * never be read as "keeps superseded" by a substring match.
 */
export function snapshotTagsOf(entry: { tags?: unknown }): string[] {
  const tags = entry.tags;
  if (tags === undefined || tags === null) return [];
  if (Array.isArray(tags) && tags.every((t) => typeof t === 'string')) return tags as string[];
  throw new Error('Revision snapshot holds malformed node tags');
}

export function restoreWouldUnretireError(revisionLoc: string, memoryId: string, locs: string[]): GraphQLError {
  const sorted = [...locs].sort();
  return new GraphQLError(
    `Refused to restore ${revisionLoc}: it would drop \`${SUPERSEDED_TAG}\` from ${sorted.length} minted spec(s); nothing was written.`,
    { extensions: { code: RESTORE_WOULD_UNRETIRE_SPEC, memoryId, locs: sorted.slice(0, LOC_LIST_CAP), count: sorted.length } },
  );
}

export async function assertRestoreKeepsRetirement(
  tx: Prisma.TransactionClient,
  args: {
    memoryId: string;
    revisionLoc: string;
    snapshotNodes: Array<Record<string, unknown>>;
    /** Read unlocked: encryption is one-way, so a stale `false` can only over-refuse. */
    isEncrypted: boolean;
  },
): Promise<void> {
  // Validate every entry first so a malformed one fails the same way whatever the live rows are.
  const snapshotTags = new Map<string, string[]>();
  for (const n of args.snapshotNodes) {
    if (typeof n.loc !== 'string' || n.loc === '') continue;
    snapshotTags.set(n.loc, snapshotTagsOf(n as { tags?: unknown }));
  }
  if (args.isEncrypted || snapshotTags.size === 0) return;

  const rows = await tx.$queryRaw<Array<{ id: string; loc: string; tags: string[] | null; mintedAt: Date | null }>>`
    SELECT id, loc, tags, minted_at AS "mintedAt" FROM nodes
    WHERE memory_id = ${args.memoryId}
      AND loc = ANY(${[...snapshotTags.keys()]}::text[])
      AND node_type <> ${COMPILED_BOOT_PROMPT_NODE_TYPE}
    ORDER BY id FOR NO KEY UPDATE`;
  const offending = rows
    .filter((r) => r.mintedAt !== null && (r.tags ?? []).includes(SUPERSEDED_TAG) && !snapshotTags.get(r.loc)!.includes(SUPERSEDED_TAG))
    .map((r) => r.loc);
  if (offending.length > 0) throw restoreWouldUnretireError(args.revisionLoc, args.memoryId, offending);
}
