/**
 * Draft spec corpora (#1447, contract
 * https://github.com/hadron-memory/hadron-server/issues/1447#issuecomment-5895948862).
 *
 * A spec corpus is DRAFT or MINTED. Draft is chosen only when the memory is
 * created (`createMemory(draftCorpus: true)`), and minting turns it into a
 * minted corpus once, one-way, for the whole memory. Every memory that exists
 * today, and every memory created without asking for draft, is minted.
 *
 * Inside a draft corpus a spec's citation is not yet permanent: specs can be
 * renumbered, moved and deleted, and a move records NO `UrnAlias`, because
 * nothing outside the corpus can cite a draft number (#1448). After minting,
 * the ordinary rules apply unchanged.
 *
 * This module is the ONE definition of "is this memory a draft corpus?", so
 * the relaxations (alias skipping here, the #1204 move/delete gate when it
 * lands) all consult the same predicate.
 */

import { GraphQLError } from 'graphql';

export type CorpusState = 'DRAFT' | 'MINTED';

/** Whether this memory is a draft spec corpus. */
export function isDraftCorpus(memory: { corpusDraft: boolean }): boolean {
  return memory.corpusDraft;
}

/** The GraphQL `Memory.corpusState` projection of the stored flag. */
export function corpusStateOf(memory: { corpusDraft: boolean }): CorpusState {
  return isDraftCorpus(memory) ? 'DRAFT' : 'MINTED';
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
 * #1450 (@codex P1s, PR #1452) — a placeholder never leaves draft corpora.
 *
 * A placeholder is a reserved citation with no spec written; minting refuses
 * while any remain, so a minted corpus has none. Any path that puts a node
 * into a memory that is NOT a draft (a clone or extract into a brand-new,
 * therefore minted, memory; a merge or move into a minted one) would publish a
 * citation with no spec behind it, so it refuses instead. Write the spec (its
 * content) or delete the placeholder first.
 *
 * `moveNodeSubtree` keeps its own typed SubtreeMovePlaceholderError (mapped on
 * both move surfaces); every other copy or relocation path calls this.
 *
 * @throws GraphQLError `SPEC_PLACEHOLDER_OUTSIDE_DRAFT` naming the first placeholder.
 */
export function assertNoPlaceholdersLeaveDraft(
  nodes: ReadonlyArray<{ loc: string; isPlaceholder?: boolean | null }>,
  destination: { isDraft: boolean; memoryId?: string },
): void {
  if (destination.isDraft) return;
  const placeholder = nodes.find((n) => n.isPlaceholder === true);
  if (!placeholder) return;
  throw new GraphQLError(
    `Cannot copy or move placeholder "${placeholder.loc}" into a memory that is not a draft spec corpus: ` +
      'write the spec (its content) or delete the placeholder first.',
    {
      extensions: {
        code: 'SPEC_PLACEHOLDER_OUTSIDE_DRAFT',
        loc: placeholder.loc,
        ...(destination.memoryId ? { memoryId: destination.memoryId } : {}),
      },
    },
  );
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
