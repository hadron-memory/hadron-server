-- #1201 — govern authored kinds by what a write PRODUCES, not by where it lands.
--
-- Two halves, and they are the same decision seen from both ends:
--
--   1. ADD `nodes.role` — an open string carrying what a node is FOR. The
--      platform reads a small CLOSED subset (src/lib/governedRole.ts) and
--      ignores every other value. Deliberately NOT an enum: the field is open
--      to agent builders, and only the governed subset is closed. No default,
--      no backfill — NULL means "no role", which is what every existing row is.
--
--   2. DROP `memories.protected_locs`, added one day earlier by
--      20260917010000_memory_protected_locs. Its justification was
--      extensibility-as-data ("a protectedLocs update per memory, no code
--      change"); kind-specific doors delete that, because a new governed kind
--      now needs a new GraphQL field regardless. And the axis was wrong: a task
--      node is dangerous because it is RUNNABLE, not because of where it sits.
--
-- Data loss: NONE. The column shipped empty-by-default and no memory ever
-- declared anything (verified before writing this), so this is a revert rather
-- than a migration. The `IS DISTINCT FROM '{}'` guard below turns that from a
-- claim into a check: if any row DID carry a declaration, this fails loudly
-- instead of discarding it silently.
DO $$
DECLARE declared_count integer;
BEGIN
  SELECT count(*) INTO declared_count
  FROM memories
  WHERE protected_locs IS DISTINCT FROM '{}'::text[];

  IF declared_count > 0 THEN
    RAISE EXCEPTION
      'memories.protected_locs is not empty (% row(s)) — #1201 assumed zero declarations. Resolve those rows before dropping the column.',
      declared_count;
  END IF;
END $$;

ALTER TABLE "nodes" ADD COLUMN "role" TEXT;

ALTER TABLE "memories" DROP COLUMN "protected_locs";

-- `Node.role` joins the CURATED revision subset (#620). It is in there for a
-- specific reason rather than for parity: the escalation path #1202 exists for
-- is CLEARING a governed role, and a history that cannot show the role cannot
-- show the un-governing. NULL on every existing row, exactly as for a legacy
-- pre-#620 snapshot.
ALTER TABLE "node_revisions" ADD COLUMN "role" TEXT;
