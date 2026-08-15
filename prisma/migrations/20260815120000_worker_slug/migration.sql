-- #991 — Worker.slug: the URN atom for `hrn:worker:<root>:<app-slug>:<slug>`.
--
-- The slug is DERIVED from `Worker.name` and iterated to uniqueness within the
-- App. It exists because a worker's NAME cannot be the URN atom: cor:agt:020:02
-- leaves names unconstrained, and PR #979 deliberately allows two names to share
-- one slugified token ("Mary Jane" / "Mary-Jane"), so a name-derived URN would
-- stop resolving to exactly one worker (cor:urn:010:02).
--
-- `workers_app_slug_uniq` is a SECOND uniqueness on a table whose spec says it
-- keeps only one. The distinction that makes it legal: it NEVER REFUSES a cast.
-- The mint advances to `-2`/`-3`/… instead of erroring, so the name collision
-- (`workers_app_name_uniq` → WORKER_NAME_TAKEN) remains the only allocation
-- primitive a caller can observe. The index is a race guard, not a gate.
--
-- NOTE: the backfill block below is DUPLICATED VERBATIM in prisma/pre-push.sql,
-- which is what prepares `db push`-managed dev/test databases (they have no
-- migration history — see CLAUDE.md "Local Postgres setup"). Both are idempotent
-- and guard on the column's absence, so whichever runs first wins and the other
-- is a no-op. Change one, change the other.

ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "slug" TEXT;

-- Backfill. Two things this must get right:
--
--  1. Derivation parity with the RUNTIME (`deriveSlugFromName`, urn-lib-js
--     src/slug.ts), step for step, or a migrated row gets a different URN than
--     the same name would mint today:
--       trim → lowercase → out-of-charset runs to '-' → strip leading/trailing
--       '._-' → cap at 64 (MAX_ATOM_LEN) → strip trailing again → fall back to
--       'worker' when nothing usable survives (a name like '!!!' is legal and
--       must stay castable, so the JS path's `empty-derived-slug` throw is
--       caught and falls back the same way).
--     Pinned by a cross-language test (resolvers.workerUrn.test.ts).
--
--  2. Allocation against EVERY slug already assigned in the App — not merely
--     against rows sharing a base. A generated suffix can equal another row's
--     base: an App may legally hold `Iris`, `Iris!`, and `Iris-2`, whose bases
--     are `iris`, `iris`, and `iris-2`. Ranking each base independently hands
--     `iris-2` to both the second and third row, and the unique index below then
--     ABORTS the migration. So this walks rows in (app, created_at, id) order —
--     the runtime's first-free-wins order — and probes the rows already written,
--     exactly as `nextFreeWorkerSlug` probes the taken set.
DO $$
DECLARE
  w         RECORD;
  base      TEXT;
  candidate TEXT;
  n         INT;
BEGIN
  FOR w IN
    SELECT id, app_id, name FROM workers WHERE slug IS NULL
    ORDER BY app_id, created_at, id
  LOOP
    base := COALESCE(
      NULLIF(
        regexp_replace(
          left(
            regexp_replace(
              regexp_replace(
                regexp_replace(lower(btrim(w.name)), '[^a-z0-9._-]+', '-', 'g'),
                '^[._-]+', ''),
              '[._-]+$', ''),
            64),
          '[._-]+$', ''),
        ''),
      'worker');

    n := 1;
    candidate := base;
    -- Probe against slugs already ASSIGNED in this App (this loop's earlier
    -- iterations included), so cross-base collisions resolve rather than clash.
    WHILE EXISTS (
      SELECT 1 FROM workers x WHERE x.app_id = w.app_id AND x.slug = candidate
    ) LOOP
      n := n + 1;
      -- Trim the base by the suffix's length so `base-N` still fits the 64-char
      -- atom cap; an over-long atom would compose into a URN the parser rejects.
      candidate := regexp_replace(
        left(base, 64 - length('-' || n::text)), '[._-]+$', ''
      ) || '-' || n::text;
    END LOOP;

    UPDATE workers SET slug = candidate WHERE id = w.id;
  END LOOP;
END $$;

ALTER TABLE "workers" ALTER COLUMN "slug" SET NOT NULL;

-- Not filtered on retirement, exactly like `workers_app_name_uniq`: a retired
-- worker's URN must keep resolving (PR trailers and chat archives reference it),
-- so its slug is reserved as permanently as its name.
CREATE UNIQUE INDEX IF NOT EXISTS "workers_app_slug_uniq" ON "workers" ("app_id", "slug");
