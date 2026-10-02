/**
 * Spec corpus state (#1447/#1448), per node since #1591.
 *
 * Minting is recorded on each node (`Node.mintedAt`), not on the memory
 * (Holger's #1447 round-3 rulings). A new node starts unminted and has draft
 * rights: it can be renumbered, moved without leaving a `UrnAlias` (nothing
 * outside can cite a number that was never published), and bulk-replaced.
 * A memory's corpus state is derived from its nodes: DRAFT while none of its
 * live nodes is minted, MINTED once any is. Minting protects nothing by itself
 * (#1591 permanence ruling).
 */

import { GraphQLError } from 'graphql';
import type { PrismaClient } from '../generated/prisma/index.js';

export type CorpusState = 'DRAFT' | 'MINTED';

/**
 * #1591 — a memory's derived corpus state: DRAFT while no live node is minted;
 * otherwise MINTED, with `mintedAt` the latest mint time among its live nodes.
 * For a corpus backfilled as minted by the #1591 migration that is its newest
 * node's creation time, which is when that node became permanent then.
 */
export async function corpusMintStateOf(
  db: Pick<PrismaClient, 'node'>,
  memoryId: string,
): Promise<{ state: CorpusState; mintedAt: Date | null }> {
  const { _max } = await db.node.aggregate({
    where: { memoryId, deletedAt: null },
    _max: { mintedAt: true },
  });
  return { state: _max.mintedAt ? 'MINTED' : 'DRAFT', mintedAt: _max.mintedAt ?? null };
}

/**
 * #1450 — the write patch that turns a PLACEHOLDER spec into a real one.
 *
 * A placeholder is a reserved citation with no spec yet, marked by the
 * server-set `Node.isPlaceholder`, never inferred from an empty body. Writing
 * real content to it (anything but blank) is what writing the spec means, so
 * that write clears the flag and the node stays at the same citation. A write
 * that leaves the body blank (a rename, a tag) keeps it a placeholder.
 */
export function placeholderFillPatch(
  prior: { isPlaceholder?: boolean | null } | null | undefined,
  content: unknown,
): { isPlaceholder: false } | Record<string, never> {
  return prior?.isPlaceholder === true && typeof content === 'string' && content.trim() !== ''
    ? { isPlaceholder: false }
    : {};
}

/**
 * #1450 (@codex P1, PR #1452) — a placeholder stays a SPEC until it is written.
 *
 * A reserved placeholder starts with `role: 'spec'`, and a Git-restored one
 * may carry a dotted spec-family role. The governed-spec gates are
 * what keep generic writers and copy paths away from it. A write that removed
 * the role while leaving the body unwritten would turn it into an ungoverned
 * blank node that still claims to be a reserved citation, and copy paths would
 * accept it. So that write refuses: write the spec's content first, or delete
 * the placeholder.
 *
 * @throws GraphQLError `SPEC_PLACEHOLDER_ROLE_LOCKED`.
 */
export function assertPlaceholderKeepsSpecRole(
  prior: { isPlaceholder?: boolean | null; loc?: string; role: string | null } | null | undefined,
  input: { role?: string | null; content?: unknown },
): void {
  if (prior?.isPlaceholder !== true || input.role === undefined) return;
  const wasSpec = prior.role === 'spec' || (prior.role?.startsWith('spec.') ?? false);
  if (wasSpec && input.role === prior.role) return; // re-sending the stored role is not a change
  if (!wasSpec && input.role === 'spec') return; // repair a drifted role
  if (Object.keys(placeholderFillPatch(prior, input.content)).length > 0) return; // written in this same write
  throw new GraphQLError(
    `Placeholder${prior.loc ? ` "${prior.loc}"` : ''} must stay a spec until it is written: ` +
      'write its content first, or delete the placeholder.',
    { extensions: { code: 'SPEC_PLACEHOLDER_ROLE_LOCKED', ...(prior.loc ? { loc: prior.loc } : {}) } },
  );
}
