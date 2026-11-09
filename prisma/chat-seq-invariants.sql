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
--
-- RE-APPLICATION (#2622 follow-up): applied databases checksum a landed
-- migration, so when this file's reporting changed the current text rode a
-- NEW migration (20261109060000_chat_seq_preflight_detail) instead of
-- editing 20261027193000_team_chat_seq_unique. In an environment that
-- already applied the landed migration the censuses re-run and pass (the
-- unique index itself enforces the collision one; the reserved-segment one
-- is the deploy boundary for pre-guard data), and the index create is
-- SKIPPED by the catalog gate at the end. A fresh environment builds the
-- index with exactly the landed DDL text.

-- Preflight (#992 delivery order step 2): refuse to install on a colliding
-- set, REPORTING the collisions — never renumbering, deleting, exempting or
-- choosing a repair. The count-then-create race is closed by the index
-- create below: a row that lands between the two statements fails the
-- create, so installation still refuses safely.
--
-- REPORTING (#2622 follow-up): `prisma migrate deploy` does not reliably
-- surface server WARNING/NOTICE lines, so the samples also ride the
-- EXCEPTION itself (USING DETAIL) — the refusal carries its own evidence
-- wherever the error text goes. The WARNINGs stay for contexts that do
-- surface notices.
--
-- REFUSAL CLASS (#3770): both refusals raise SQLSTATE 'HDPRF' — the
-- refusing-preflight convention the boot protocol recognizes. A deploy-time
-- refusal then resolves as alarm + serve-the-existing-schema (the entrypoint
-- marks the migration rolled back and starts the server), never the #3236
-- boot-brick class. The trade-off is deliberate: a rolled-back refusal is
-- re-attempted by every later `migrate deploy`, so it re-alarms on each boot
-- until the data is repaired — loud and serving beats quiet and bricked.
--
-- This file keeps the convention's other half: no transaction-control
-- STATEMENTS (BEGIN/COMMIT/ROLLBACK as statements) and no CREATE INDEX
-- CONCURRENTLY — the wrapped transaction's all-or-nothing rollback is what
-- makes "nothing was applied" true. The PL/pgSQL BEGIN/END inside the DO
-- blocks below are language block boundaries, not transaction control; the
-- convention's checker (the #3772 migration scanner) tokenizes and ignores
-- dollar-quoted bodies on exactly that distinction.
--
-- Both censuses make ONE ordered pass over the data and derive the count,
-- the WARNING lines and the DETAIL samples from the same rows: the samples
-- are deterministic (memory, chat, seq order; created_at,id tiebreak inside
-- a group), and a count-without-samples DETAIL (which would be NULL and
-- turn the refusal into a confusing error) is impossible by construction.
DO $$
DECLARE
  collision record;
  groups bigint := 0;
  listed bigint := 0;
  samples text[] := ARRAY[]::text[];
BEGIN
  FOR collision IN
    SELECT memory_id,
           split_part(loc, ':messages:', 1) AS chat_root,
           seq,
           count(*) AS rows,
           (array_agg(id ORDER BY created_at, id))[1:5] AS sample_ids
    FROM nodes
    WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc LIKE '%:messages:%'
    GROUP BY memory_id, split_part(loc, ':messages:', 1), seq
    HAVING count(*) > 1
    ORDER BY memory_id, chat_root, seq
  LOOP
    groups := groups + 1;
    IF listed < 10 THEN
      listed := listed + 1;
      samples := samples || format('%s / chat %s / seq %s: %s rows (e.g. %s)',
        collision.memory_id, collision.chat_root, collision.seq, collision.rows, collision.sample_ids);
      RAISE WARNING 'chat seq uniqueness preflight: memory % chat % seq % has % colliding rows (e.g. %)',
        collision.memory_id, collision.chat_root, collision.seq, collision.rows, collision.sample_ids;
    END IF;
  END LOOP;
  IF groups > 0 THEN
    RAISE EXCEPTION 'chat seq uniqueness preflight: % colliding (chat, seq) group(s) remain — apply the approved repair first; refusing to create the unique index', groups
      USING ERRCODE = 'HDPRF',
      DETAIL = array_to_string(samples, '; '),
      HINT = 'The DETAIL (and the warnings above, where surfaced) list the first 10 colliding groups in (memory, chat, seq) order, as memory / chat root / seq / rows / sample ids. This migration never renumbers, deletes, exempts or chooses a repair.';
  END IF;
END $$;

-- Reserved-segment preflight (#992): a chat ROOT whose own address carries a
-- `messages` segment (`ops:messages:alerts`) is folded by the index into an
-- ANCESTOR's identity (`ops`), while the allocator scans the root's own
-- prefix, so its posts would be refused permanently once the index exists.
-- Report such existing Channels and nested transcripts and refuse to
-- install; the repair (relocating the address) is the owner's choice — this
-- file never renames, deletes or exempts. New Channels are refused at the
-- address boundary (LOC_RESERVED_SEGMENT), so after this check none can appear.
-- Only rows the index covers (seq IS NOT NULL) count: a counterless message is
-- outside the index and cannot collide, so it never blocks installation.
--
-- The census (and the runtime guard it mirrors) refuse a `messages` segment
-- ANYWHERE in a Channel address — deliberately wider than the index's actual
-- fold: a LEADING segment (`messages:foo`) does not fold, because the index
-- separator needs the leading colon. Refusing it is the conservative
-- direction — such an address is at minimum confusing, and installation
-- never proceeds past a refusal that reports exactly what to relocate.
DO $$
DECLARE
  offender record;
  total bigint := 0;
  listed bigint := 0;
  samples text[] := ARRAY[]::text[];
BEGIN
  FOR offender IN
    SELECT kind, memory_id, chat_root, rows FROM (
      SELECT 'channel'::text AS kind, memory_id, loc AS chat_root, 1::bigint AS rows
      FROM channels
      WHERE 'messages' = ANY (string_to_array(loc, ':'))
      UNION ALL
      SELECT 'nested-transcript', memory_id, split_part(loc, ':messages:', 1), count(*)
      FROM nodes
      WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc ~ ':messages:(.*:)?messages:'
      GROUP BY memory_id, split_part(loc, ':messages:', 1)
    ) offenders
    ORDER BY kind, memory_id, chat_root
  LOOP
    total := total + offender.rows;
    IF listed < 10 THEN
      listed := listed + 1;
      samples := samples || format('%s in memory %s at %s (%s row(s))',
        offender.kind, offender.memory_id, offender.chat_root, offender.rows);
      RAISE WARNING 'chat seq uniqueness preflight: % in memory % at % uses the reserved "messages" loc segment (% row(s))',
        offender.kind, offender.memory_id, offender.chat_root, offender.rows;
    END IF;
  END LOOP;
  IF total > 0 THEN
    RAISE EXCEPTION 'chat seq uniqueness preflight: % Channel/transcript row(s) use the reserved "messages" loc segment — relocate them under an approved repair first; refusing to create the unique index', total
      USING ERRCODE = 'HDPRF',
      DETAIL = array_to_string(samples, '; '),
      HINT = 'The DETAIL (and the warnings above, where surfaced) list the first 10 offending addresses in (kind, memory, address) order. This migration never renames, deletes, exempts or chooses a repair.';
  END IF;
END $$;

-- Install. Gated on the catalog rather than CREATE … IF NOT EXISTS: the IF
-- NOT EXISTS form still locks the table before discovering the name, so a
-- `migrate deploy` at boot would queue behind writers to take a lock it
-- never needed. Where the index already exists (every environment that
-- applied 20261027193000) the create is skipped entirely; where it does not
-- (fresh databases), this is byte-for-byte the landed DDL. CREATE INDEX
-- CONCURRENTLY is not an option here: the boot runner wraps each migration
-- in a transaction, and CONCURRENTLY cannot run inside one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'nodes_chat_message_seq_unique_idx'
  ) THEN
    EXECUTE $ddl$CREATE UNIQUE INDEX "nodes_chat_message_seq_unique_idx"
      ON nodes (memory_id, split_part(loc, ':messages:', 1), seq)
      WHERE node_type = 'chat-message' AND seq IS NOT NULL AND loc LIKE '%:messages:%'$ddl$;
  END IF;
END $$;
