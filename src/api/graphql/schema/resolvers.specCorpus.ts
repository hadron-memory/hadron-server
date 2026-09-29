// Draft spec corpora (#1447): the server-owned spec-corpus operations.
//
// #1450 — reserveSpecCitation. Contract:
// https://github.com/hadron-memory/hadron-server/issues/1447#issuecomment-5895948862 §4.
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { withoutRequestCaches } from './resolvers.helpers.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';

export const specCorpusMutations = {
  /**
   * Reserve a citation in a DRAFT spec corpus as a PLACEHOLDER: a spec node
   * (`role: 'spec'`, `nodeType: 'info'`) at `loc`, marked by the server-set
   * `Node.isPlaceholder`, never by an empty body. Links can point at it, so
   * backlinks work, and the placeholders still left are the corpus's to-do
   * list; minting refuses while any remain. Writing real content to it through
   * `updateSpecNode` turns it into a real spec at the same citation.
   *
   * It writes through the spec door's own create path (the `spec` governed
   * kind), so every other gate applies unchanged: memory write access (an
   * unreadable memory is concealed as not found), mint-or-refuse at a live loc,
   * Channel address protection. Only a draft corpus accepts a reservation,
   * which is what keeps placeholders out of minted corpora.
   *
   * The draft check reads the memory row FOR SHARE AFTER the node write, inside
   * the same transaction: node then memory is the order moves use (the reverse
   * deadlocks against a merge fold), a concurrent mint's row lock serializes
   * with it, and the check never answers for a memory the caller cannot write.
   *
   * @throws GraphQLError `SPEC_CORPUS_NOT_DRAFT` when the memory is minted.
   */
  reserveSpecCitation: async (
    _: unknown,
    { memoryRef, loc, name }: { memoryRef: string; loc: string; name?: string | null },
    ctx: Context,
  ) => {
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    const effects: Array<() => void> = [];
    const reserved = await ctx.db.$transaction(async (tx) => {
      const node = await writeNodeCore(
        {
          memoryId, loc, name: name?.trim() || loc, role: 'spec', nodeType: 'info',
          // (@codex P2, PR #1452) Explicit nulls, not omissions: a create over a
          // soft-deleted node at this loc revives that row and keeps every field
          // the input omits, so a deleted spec's text would reappear inside a
          // "placeholder" that claims to have none.
          content: null, abstract: null, description: null,
          // (@codex P2, PR #1452) deleteNode leaves a tombstone's outgoing
          // edges attached, and a revival keeps them unless told otherwise:
          // an explicit empty set replaces them, so the placeholder starts
          // with no relationships.
          edges: [],
        },
        withoutRequestCaches(ctx, tx),
        'create',
        {
          ownsKind: 'spec',
          governedContext: 'node-write',
          concealUnreadable: { entity: 'memory', ref: memoryRef },
          transaction: { tx, pooledDb: ctx.db, afterCommit: (effect) => effects.push(effect) },
        },
      );
      const [memory] = await tx.$queryRaw<Array<{ corpus_draft: boolean }>>`
        SELECT corpus_draft FROM memories WHERE id = ${memoryId} FOR SHARE
      `;
      if (!memory?.corpus_draft) {
        throw new GraphQLError(
          'Only a draft spec corpus can reserve a citation: this memory is minted, where a citation is permanent once written. Create the spec directly instead.',
          { extensions: { code: 'SPEC_CORPUS_NOT_DRAFT', memoryId } },
        );
      }
      await tx.node.update({ where: { id: node.id }, data: { isPlaceholder: true }, select: { id: true } });
      // The node as the create door built it (relations included), now marked.
      return { ...node, isPlaceholder: true };
    });
    for (const effect of effects) effect();
    return reserved;
  },
};
