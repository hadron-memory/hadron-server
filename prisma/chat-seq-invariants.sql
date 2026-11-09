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
-- REPORTING (Joshua BLIND P2, #2622 follow-up): `prisma migrate deploy` does
-- not reliably surface server WARNING/NOTICE lines, so the samples also ride
-- the EXCEPTION itself (USING DETAIL) — the refusal carries its own evidence
-- wherever the error text goes. The WARNINGs stay for contexts that do
-- surface notices.
DO $$
DECLARE
  collision record;
  groups bigint;
  collision_samples text;
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
END $$;

-- Reserved-segment preflight (#992, Diego BLIND P2): a chat ROOT whose own
-- address carries a `messages` segment (`ops:messages:alerts`) is folded by the
-- index into an ANCESTOR's identity (`ops`), while the allocator scans the
-- root's own prefix, so its posts would be refused permanently once the index
-- exists. Report such existing Channels and nested transcripts and refuse to
-- install; the repair (relocating the address) is the owner's choice — this
-- file never renames, deletes or exempts. New Channels are refused at the
-- address boundary (LOC_RESERVED_SEGMENT), so after this check none can appear.
-- Only rows the index covers (seq IS NOT NULL) count: a counterless message is
-- outside the index and cannot collide, so it never blocks installation.
DO $$
DECLARE
  offender record;
  total bigint;
  offender_samples text;
BEGIN
  FOR offender IN
    SELECT 'channel' AS kind, memory_id, loc AS chat_root, 1::bigint AS rows
    FROM channels
    WHERE 'messages' = ANY (string_to_array(loc, ':'))
    UNION ALL
    SELECT 'nested-transcript', memory_id, split_part(loc, ':messages:', 1), count(*)
    FROM nodes
    WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc ~ ':messages:(.*:)?messages:'
    GROUP BY memory_id, split_part(loc, ':messages:', 1)
    LIMIT 10
  LOOP
    RAISE WARNING 'chat seq uniqueness preflight: % in memory % at % uses the reserved "messages" loc segment (% row(s))',
      offender.kind, offender.memory_id, offender.chat_root, offender.rows;
  END LOOP;

  SELECT (SELECT count(*) FROM channels WHERE 'messages' = ANY (string_to_array(loc, ':')))
       + (SELECT count(*) FROM nodes WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc ~ ':messages:(.*:)?messages:')
    INTO total;
  IF total > 0 THEN
    SELECT string_agg(format('%s in memory %s at %s', kind, memory_id, chat_root), '; ')
    INTO offender_samples FROM (
      SELECT 'channel' AS kind, memory_id, loc AS chat_root
      FROM channels
      WHERE 'messages' = ANY (string_to_array(loc, ':'))
      UNION ALL
      SELECT 'nested-transcript', memory_id, split_part(loc, ':messages:', 1)
      FROM nodes
      WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc ~ ':messages:(.*:)?messages:'
      GROUP BY memory_id, split_part(loc, ':messages:', 1)
      LIMIT 10
    ) s;
    RAISE EXCEPTION 'chat seq uniqueness preflight: % Channel/transcript row(s) use the reserved "messages" loc segment — relocate them under an approved repair first; refusing to create the unique index', total
      USING DETAIL = offender_samples,
      HINT = 'The DETAIL (and the warnings above, where surfaced) list up to 10 offenders. This migration never renames, deletes, exempts or chooses a repair.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "nodes_chat_message_seq_unique_idx"
  ON nodes (memory_id, split_part(loc, ':messages:', 1), seq)
  WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc LIKE '%:messages:%';
