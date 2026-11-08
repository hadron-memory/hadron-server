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
--
-- REPORTING (Joshua BLIND P2, #2622 fix head): `prisma migrate deploy` does
-- not reliably surface server WARNING/NOTICE lines, so the samples also ride
-- the EXCEPTION itself (USING DETAIL) — the refusal carries its own evidence
-- wherever the error text goes. The WARNINGs stay for contexts that do
-- surface notices.
--
-- RESERVED-SEGMENT CENSUS (same seat finding): an address whose loc contains
-- a `messages` SEGMENT folds its transcript into an ANCESTOR's chat identity
-- (split on the FIRST ':messages:') while the allocator scans its own prefix
-- — the ambiguity refuseReservedChatAddressSegment exists to prevent. The
-- census refuses installation while any such address EXISTS: the runtime
-- guard would otherwise convert each of its posts into a typed refusal with
-- no deploy-time signal. The repair is a rename (an owner-approved data
-- repair); this migration never renames, deletes, exempts or chooses one.
DO $$
DECLARE
  collision record;
  groups bigint;
  collision_samples text;
  reserved_channels bigint;
  reserved_channel_samples text;
  reserved_rows bigint;
  reserved_row_samples text;
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
    SELECT string_agg(format('%s / chat %s / seq %s: %s rows (e.g. %s)',
      memory_id, chat_root, seq, rows, sample_ids), '; ')
    INTO collision_samples FROM (
      SELECT memory_id, split_part(loc, ':messages:', 1) AS chat_root, seq,
             count(*) AS rows, (array_agg(id ORDER BY created_at))[1:5] AS sample_ids
      FROM nodes
      WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc LIKE '%:messages:%'
      GROUP BY memory_id, split_part(loc, ':messages:', 1), seq
      HAVING count(*) > 1
      LIMIT 10
    ) s;
    RAISE EXCEPTION 'chat seq uniqueness preflight: % colliding (chat, seq) group(s) remain — apply the approved repair first; refusing to create the unique index', groups
      USING DETAIL = collision_samples,
      HINT = 'The DETAIL (and the warnings above, where surfaced) list up to 10 colliding groups (memory, chat root, seq, sample ids). This migration never renumbers, deletes, exempts or chooses a repair.';
  END IF;

  -- Reserved-segment census, class 1: CHAT Channel addresses carrying a
  -- `messages` segment (the exact predicate of the runtime guard —
  -- loc.split(':').includes('messages'), here as a segment test).
  SELECT count(*) INTO reserved_channels FROM channels
  WHERE kind = 'CHAT' AND (':' || loc || ':') LIKE '%:messages:%';
  IF reserved_channels > 0 THEN
    SELECT string_agg(format('%s: %s', id, loc), '; ')
    INTO reserved_channel_samples FROM (
      SELECT id, loc FROM channels
      WHERE kind = 'CHAT' AND (':' || loc || ':') LIKE '%:messages:%'
      ORDER BY created_at LIMIT 10
    ) s;
    RAISE EXCEPTION 'chat seq uniqueness preflight: % CHAT Channel address(es) contain a reserved "messages" segment — rename them first; refusing to create the unique index', reserved_channels
      USING DETAIL = reserved_channel_samples,
      HINT = 'Such an address folds its transcript into an ancestor chat''s identity (the index splits on the FIRST '':messages:''), so the runtime guard refuses every post to it. The repair is an owner-approved rename; this migration never renames, deletes, exempts or chooses a repair.';
  END IF;

  -- Reserved-segment census, class 2: chat-message rows whose loc carries a
  -- SECOND ':messages:' separator — the folded-row shape such an address (or
  -- a pre-guard direct write) produced.
  SELECT count(*) INTO reserved_rows FROM nodes
  WHERE node_type = 'chat-message' AND loc LIKE '%:messages:%:messages:%';
  IF reserved_rows > 0 THEN
    SELECT string_agg(format('%s: %s', memory_id, loc), '; ')
    INTO reserved_row_samples FROM (
      SELECT memory_id, loc FROM nodes
      WHERE node_type = 'chat-message' AND loc LIKE '%:messages:%:messages:%'
      ORDER BY created_at LIMIT 10
    ) s;
    RAISE EXCEPTION 'chat seq uniqueness preflight: % chat-message row(s) sit under a nested ":messages:" separator — move or repair them first; refusing to create the unique index', reserved_rows
      USING DETAIL = reserved_row_samples,
      HINT = 'A second separator folds the row into an ancestor chat''s identity (the index splits on the FIRST '':messages:''). The repair is an owner-approved data repair; this migration never renumbers, deletes, exempts or chooses one.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "nodes_chat_message_seq_unique_idx"
  ON nodes (memory_id, split_part(loc, ':messages:', 1), seq)
  WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc LIKE '%:messages:%';
