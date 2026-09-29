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
