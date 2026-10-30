-- #992 (cor:agt:020:04): per-chat message-seq uniqueness — collision
-- preflight + partial unique index. The body below is prisma/chat-seq-invariants.sql
-- VERBATIM (pinned by src/lib/chatSeqUnique.test.ts): production runs
-- migrations, never post-push.sql, so the two must not drift.

-- #992 (cor:agt:020:04): per-chat seq uniqueness for canonical chat
-- messages, as a partial unique index Prisma's schema language cannot model.
--
-- IDENTITY: the chat a message belongs to is derived from the message's own
-- loc — (memory_id, split_part(loc, ':messages:', 1)) — the same
-- classification every transcript reader uses (memoryId + the
-- '<root>:messages:' loc prefix + node_type). It is NOT keyed on
-- message_channel_id: the #1430 backfill and ensureChannelWithRoot's
-- adoption sweep both skip soft-deleted rows, a clone carries no stamp at
-- all (cloneNode copies seq, never message_channel_id), and a chat that
-- predates its Channel row has none either — a stamp-keyed constraint would
-- be vacuous against exactly the direct-write corruption class that
-- produced #992. Splitting on the FIRST ':messages:' is structural: every
-- append mints '<root>:messages:<msgNum>-…', and the reader's
-- startsWith('<root>:messages:') prefix test defines this same identity.
--
-- SCOPE: node_type = 'chat-message' (the team-chat message kind; the only
-- writer is the channel append core — ordinary chatbot transcripts are
-- 'record' and keep cor:cht:050:02's colliding-seq legality) AND seq IS NOT
-- NULL (counterless rows are never allocated) AND loc contains the literal
-- ':messages:' separator (no LIKE metacharacters). Soft-deleted rows COUNT:
-- a deleted message's seq is never reusable (cor:agt:020:04's delete/revive
-- cycle), so — unlike the #1430 scan index — there is NO deleted_at filter
-- here.

-- Preflight (#992 delivery order step 2): refuse to install on a colliding
-- set, REPORTING the collisions — never renumbering, deleting, exempting or
-- choosing a repair. The count-then-create race is closed by the
-- CREATE UNIQUE INDEX below: a row that lands between the two statements
-- fails the create, so installation still refuses safely.
DO $$
DECLARE
  collision record;
  groups bigint;
BEGIN
  FOR collision IN
    SELECT memory_id,
           split_part(loc, ':messages:', 1) AS chat_root,
           seq,
           count(*) AS rows,
           (array_agg(id ORDER BY created_at))[1:5] AS sample_ids
    FROM nodes
    WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc LIKE '%:messages:%'
    GROUP BY memory_id, split_part(loc, ':messages:', 1), seq
    HAVING count(*) > 1
    LIMIT 10
  LOOP
    RAISE WARNING 'chat seq uniqueness preflight: memory % chat % seq % has % colliding rows (e.g. %)',
      collision.memory_id, collision.chat_root, collision.seq, collision.rows, collision.sample_ids;
  END LOOP;

  SELECT count(*) INTO groups FROM (
    SELECT 1 FROM nodes
    WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc LIKE '%:messages:%'
    GROUP BY memory_id, split_part(loc, ':messages:', 1), seq
    HAVING count(*) > 1
  ) colliding;
  IF groups > 0 THEN
    RAISE EXCEPTION 'chat seq uniqueness preflight: % colliding (chat, seq) group(s) remain — apply the approved repair first; refusing to create the unique index', groups
      USING HINT = 'The warnings above list up to 10 colliding groups (memory, chat root, seq, sample ids). This migration never renumbers, deletes, exempts or chooses a repair.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "nodes_chat_message_seq_unique_idx"
  ON nodes (memory_id, split_part(loc, ':messages:', 1), seq)
  WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc LIKE '%:messages:%';
