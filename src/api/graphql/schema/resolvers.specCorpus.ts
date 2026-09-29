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
      // (@codex P1/P2s, PR #1452) Never REVIVE a deleted node as a placeholder.
      // A revival keeps everything attached to the row (text, payload, edges,
      // vectors, provenance, revision history), and each of those surfaced a
      // leak in turn. Archive the tombstone at `<loc>__deleted-<id>` instead,
      // the convention a move that overwrites a live target already uses, so
      // the placeholder is a FRESH node and the deleted spec keeps its own
      // identity and history on its still-deleted row.
      const tombstone = await tx.node.findFirst({
        where: { memoryId, loc, deletedAt: { not: null } },
        select: { id: true },
      });
      if (tombstone) {
        await tx.node.update({ where: { id: tombstone.id }, data: { loc: `${loc}__deleted-${tombstone.id}` } });
      }
      const node = await writeNodeCore(
        {
          memoryId, loc, name: name?.trim() || loc, role: 'spec', nodeType: 'info',
          // (@codex P2, PR #1452) Explicit nulls, not omissions: a create over a
          // soft-deleted node at this loc revives that row and keeps every field
          // the input omits, so a deleted spec's text would reappear inside a
          // "placeholder" that claims to have none.
          // Every authored field a node input can carry is RESET, not
          // omitted (@codex P2s, PR #1452): a create over a soft-deleted node
          // revives that row and keeps whatever the input omits, so a deleted
          // spec's text, payload and provenance would reappear inside a
          // "placeholder" that claims to have none. The test that pins this
          // compares a revived reservation to a fresh one column by column, so
          // a new node column that leaks fails it.
          content: null, abstract: null, description: null, contentType: null,
          alias: null, tags: [], data: null, properties: null,
          llmModel: null, aiAgent: null, isLink: false, objectType: null,
          // deleteNode leaves a tombstone's outgoing edges attached; an
          // explicit empty set replaces them.
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
      // Git provenance is not a node-input field, so it is reset here, in the
      // same write that marks the placeholder (@codex P2, PR #1452): a revived
      // git-synced tombstone would otherwise keep the deleted body's hash and
      // stay owned by the old repo, where sync's cleanup could delete it.
      await tx.node.update({
        where: { id: node.id },
        data: { isPlaceholder: true, contentHash: null, ownerRepo: null },
        select: { id: true },
      });
      // (@codex P1, PR #1452) Soft deletion keeps a node's vectors, and vector
      // search only checks the node's own deleted_at. A revived tombstone would
      // therefore let the placeholder rank for, and chunk search return, the
      // deleted spec's text. A placeholder has no content, so it has no vectors.
      await tx.nodeEmbedding.deleteMany({ where: { nodeId: node.id } });
      // The node as the create door built it (relations included), now marked.
      // …with the values this transaction just reset, not the ones read
      // before it (@codex P2, PR #1452): Node.ownerRepo is client-visible.
      return { ...node, isPlaceholder: true, contentHash: null, ownerRepo: null };
    });
    for (const effect of effects) effect();
    return reserved;
  },
};
