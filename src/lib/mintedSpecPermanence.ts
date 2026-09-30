/**
 * #1468 — a spec in a mint-stamped corpus is permanent.
 *
 * "Permanent at mint" (#1447 contract §5, D-2026-09-23-004) is ENFORCED, not
 * only documented (Holger, team chat #4181): once a corpus has been minted,
 * no path may remove one of its specs. Replacing a minted spec is done by
 * superseding it, which keeps the old citation resolvable.
 *
 * WHICH corpora (Holger, team chat #4370): only a corpus stamped by the
 * `mintSpecCorpus` flow, i.e. `Memory.corpusMintedAt` is set. This is
 * deliberately NARROWER than `specCorpus.ts`'s MINTED state
 * (`corpusDraft = false`): every ordinary memory defaults to that, including
 * the live platform specs corpus, which never passed through the mint flow and
 * is outside this guard unless it is later stamped through an authorized flow.
 * A draft corpus is never stamped, so draft removals stay allowed.
 *
 * WHICH nodes: anything carrying the spec marker (`hasSpecMarker` — a `spec`
 * tag or a `spec`/`spec.*` role; both are plaintext at rest even in encrypted
 * memories).
 *
 * Race safety against a concurrent mint. The mint fences with Memory
 * `FOR UPDATE`, then every node row `FOR UPDATE` with a 500ms lock timeout
 * that turns into a retryable `SPEC_CORPUS_BUSY` (`fenceCorpusForMint`). This
 * guard takes the opposite, cooperating order that node writers use: the
 * scope's node rows `FOR UPDATE` (sorted by id), THEN the memory row
 * `FOR SHARE`, and reads `corpus_minted_at` under that lock. Either the mint
 * committed first (the guard sees the stamp and refuses), or the guard holds
 * rows the mint needs (the mint times out and retries after this removal —
 * which was then a legitimate draft removal), or the guard holds the memory
 * row (the mint waits and then fences the post-removal corpus). Locking the
 * rows first also stops a concurrent edit from adding a spec marker between
 * the check and the removal.
 *
 * Callers pass the COMPLETE set of rows the operation removes from the memory
 * (subtree descendants and, for hard deletes, tombstones), inside the same
 * transaction as the removal, after any address/subtree locks they already
 * take (so no row can join the scope afterwards).
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { hasSpecMarker } from './specMint.js';

/** The one error every minted-spec removal refusal raises. */
export const SPEC_MINTED_PERMANENT = 'SPEC_MINTED_PERMANENT';

/** How many offending locs a refusal names in its message and extensions. */
const NAMED_LOC_CAP = 10;

/** Build the typed refusal: names the specs (capped) and supersede as the way forward. */
export function mintedSpecRemovalError(memoryId: string, locs: string[], op: string): GraphQLError {
  const named = locs.slice(0, NAMED_LOC_CAP);
  const more = locs.length > named.length ? ` (and ${locs.length - named.length} more)` : '';
  return new GraphQLError(
    `Refused to ${op}: ${named.map((l) => `"${l}"`).join(', ')}${more} ` +
      `${locs.length === 1 ? 'is a spec' : 'are specs'} in a minted corpus, and minted specs are permanent. ` +
      'Supersede a spec to replace it.',
    { extensions: { code: SPEC_MINTED_PERMANENT, memoryId, locs: named, count: locs.length, op } },
  );
}

/**
 * Lock the given node rows, then refuse if removing them would remove a spec
 * from a mint-stamped corpus. Run inside the removal's transaction, before the
 * write.
 *
 * `nodeIds` must all belong to `memoryId` (the memory the operation removes
 * them FROM). Rows that have since left the memory are ignored here; the
 * caller's own concurrency checks own that case.
 *
 * @throws GraphQLError `SPEC_MINTED_PERMANENT` when the corpus is stamped and
 *   any locked row carries the spec marker.
 */
export async function assertNoMintedSpecRemoval(
  tx: Prisma.TransactionClient,
  memoryId: string,
  nodeIds: readonly string[],
  op: string,
): Promise<void> {
  if (nodeIds.length === 0) return;
  const ids = [...new Set(nodeIds)].sort();
  // Node rows first (id order, the global multi-row order), then the markers
  // re-read under those locks.
  const rows = await tx.$queryRaw<Array<{ id: string; loc: string; tags: string[]; role: string | null }>>`
    SELECT id, loc, tags, role FROM nodes
    WHERE id = ANY(${ids}::text[]) AND memory_id = ${memoryId}
    ORDER BY id FOR UPDATE`;
  const specs = rows.filter((r) => hasSpecMarker({ tags: r.tags ?? [], role: r.role }));
  // No spec in scope: nothing this guard protects, and no memory lock taken.
  if (specs.length === 0) return;
  const [memory] = await tx.$queryRaw<Array<{ corpus_minted_at: Date | null }>>`
    SELECT corpus_minted_at FROM memories WHERE id = ${memoryId} FOR SHARE`;
  if (!memory || memory.corpus_minted_at === null) return;
  throw mintedSpecRemovalError(memoryId, specs.map((s) => s.loc).sort(), op);
}
