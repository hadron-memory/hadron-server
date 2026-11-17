/**
 * #2622/#992: every chat-message writer that preserves (loc, seq) — the
 * allocator core, moveNode, clone, extract, the MCP inline writers — routes
 * its write through `mapChatSeqConflict`, and the wrapped sites a real
 * request cannot reach (clone/extract land rows in a fresh memory) are
 * unreachable by input BY DESIGN. The wrapper's own behavior is therefore
 * pinned HERE, directly, so no wrap depends on an accident of reachability
 * for its coverage: the exact P2002 shapes it maps, what it passes through
 * untouched, and the typed refusal it answers with.
 *
 * The P2002 target spellings are the two real ones (probed on a live
 * constraint violation; see the detector pins in chatSeqUnique.test.ts).
 * No database: the mapper's contract is error-in → error-out.
 */
import { describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/index.js';
import {
  CHAT_SEQ_CONFLICT_MESSAGE,
  mapChatSeqConflict,
} from './prismaErrors.js';

const p2002 = (target: unknown) =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002', clientVersion: '6.19.2', meta: { target },
  } as never);

const OURS_BY_NAME = () => p2002('nodes_chat_message_seq_unique_idx');
const OURS_BY_COLUMNS = () =>
  p2002(['memory_id', 'split_part(loc', `':messages:'::text`, '1)', 'seq']);

describe('#992 — mapChatSeqConflict (the wrap every chat-message writer shares)', () => {
  it('maps the constraint\'s P2002 to the typed refusal, under both real target spellings', async () => {
    for (const make of [OURS_BY_NAME, OURS_BY_COLUMNS]) {
      let typed: unknown;
      try {
        await mapChatSeqConflict(() => Promise.reject(make()));
      } catch (e) {
        typed = e;
      }
      expect(typed).toBeInstanceOf(GraphQLError);
      expect((typed as GraphQLError).extensions?.code).toBe('CHAT_MESSAGE_SEQ_CONFLICT');
      expect((typed as GraphQLError).message).toBe(CHAT_SEQ_CONFLICT_MESSAGE);
    }
  });

  it('passes a successful write\'s value through untouched', async () => {
    await expect(mapChatSeqConflict(async () => 'written')).resolves.toBe('written');
  });

  it('rethrows someone else\'s P2002 identically (same object, no wrapping)', async () => {
    const otherUnique = p2002(['loc', 'memory_id']);
    let rethrown: unknown;
    try {
      await mapChatSeqConflict(() => Promise.reject(otherUnique));
    } catch (e) {
      rethrown = e;
    }
    expect(rethrown).toBe(otherUnique);
  });

  it('rethrows a non-Prisma error identically', async () => {
    const boom = new Error('connection reset');
    let rethrown: unknown;
    try {
      await mapChatSeqConflict(() => Promise.reject(boom));
    } catch (e) {
      rethrown = e;
    }
    expect(rethrown).toBe(boom);
  });

  it('never carries raw diagnostics in the typed refusal', async () => {
    let typed: unknown;
    try {
      await mapChatSeqConflict(() => Promise.reject(OURS_BY_NAME()));
    } catch (e) {
      typed = e;
    }
    const text = JSON.stringify((typed as GraphQLError).message);
    expect(text).not.toMatch(/P2002|nodes_chat_message_seq_unique_idx|Prisma/i);
  });
});
