-- #4425 S1 guard — the question-role preflight (Bruce's disposition of the reverse collision:
-- #116933 narrowed by his #117220/#116976 call). The mechanical decision→question rename makes
-- `question` / `question.*` GOVERNED roles in code. Any node that already carries such a role —
-- written by anyone, any time, while the platform treated the string as inert — would be captured
-- by the governed family at deploy: uneditable and undeletable through the generic doors, with no
-- exit. Per the #4425 contract the OLD roles (`decision`, `decision.log`) are deliberately NOT
-- refused: rows that carry them become ordinary, writer-editable nodes (#4425 "Old rows" — "Rows
-- that already have role `decision` or `decision.log` are left as they are"; Acceptance 4 pins the
-- writer-edit path). The reverse collision has no such acceptance, so a deployment that would
-- capture pre-existing question/question.* rows REFUSES here, loudly, reporting what it found.
-- This file never renames, deletes, exempts or chooses a repair — the owner does.
--
-- Live AND soft-deleted rows both count: a soft-deleted row can be revived, and its capture would
-- be just as real.
--
-- REFUSAL CLASS (#3770): SQLSTATE 'HDPRF' — the refusing-preflight convention the boot protocol
-- recognizes. A deploy-time refusal resolves as alarm + serve-the-existing-schema (the entrypoint
-- marks the migration rolled back and starts the server), never the #3236 boot-brick class. A
-- rolled-back refusal is re-attempted by every later `migrate deploy`, so it re-alarms on each
-- boot until the data is repaired — loud and serving beats quiet and bricked. This file keeps the
-- convention's other half: no transaction-control statements and no CREATE INDEX CONCURRENTLY —
-- the wrapped transaction's all-or-nothing rollback is what makes "nothing was applied" true.
--
-- The guard is a census at deploy time. A `question`-role row written AFTER this migration ran is
-- written under the renamed, governed family (its own doors), so it cannot be a pre-existing
-- collision.
DO $$
DECLARE
  total bigint;
  samples text[] := ARRAY[]::text[];
  rec record;
BEGIN
  FOR rec IN
    SELECT memory_id, loc, role, deleted_at
      FROM nodes
     WHERE role = 'question' OR role LIKE 'question.%'
     ORDER BY memory_id, loc
     LIMIT 10
  LOOP
    samples := samples || format('%s / %s / %s / %s', rec.memory_id, rec.loc, rec.role,
                                 CASE WHEN rec.deleted_at IS NULL THEN 'live' ELSE 'soft-deleted' END);
  END LOOP;
  SELECT count(*) INTO total FROM nodes WHERE role = 'question' OR role LIKE 'question.%';
  IF total > 0 THEN
    RAISE EXCEPTION 'question role preflight: % node(s) already carry role ''question'' or ''question.*'' — the decision→question rename would capture them as governed questions with no exit; repair or relocate them first', total
      USING ERRCODE = 'HDPRF',
      DETAIL = array_to_string(samples, '; '),
      HINT = 'The DETAIL lists up to the first 10 offending nodes (memory / loc / role / state, in (memory, loc) order). This migration never renames, deletes, exempts or chooses a repair.';
  END IF;
END $$;
