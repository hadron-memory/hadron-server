-- #994 — Worker.slug: the URN atom for `hrn:worker:<root>:<app-slug>:<slug>`.
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

ALTER TABLE "workers" ADD COLUMN "slug" TEXT;

-- Backfill, mirroring `deriveSlugFromName` (urn-lib-js src/slug.ts) STEP FOR
-- STEP so an existing row gets the same slug the runtime would mint for it:
--   1. trim, lowercase
--   2. every run of out-of-charset characters -> a single '-'
--   3. strip leading/trailing '.', '_', '-'
--   4. cap at 64 chars (MAX_ATOM_LEN), then strip trailing punctuation again
--   5. nothing usable survived -> the 'worker' fallback (the JS path throws
--      `empty-derived-slug`; the server catches it and falls back the same way,
--      because a name like "!!!" is legal and must stay castable)
-- Ties are broken by (created_at, id) — the oldest casting keeps the bare base,
-- matching the runtime's first-free-wins order. The suffix is applied with the
-- same room-trimming the runtime uses, so `base-N` never exceeds 64 chars.
WITH derived AS (
  SELECT
    id,
    app_id,
    created_at,
    COALESCE(
      NULLIF(
        regexp_replace(
          left(
            regexp_replace(
              regexp_replace(
                regexp_replace(lower(btrim("name")), '[^a-z0-9._-]+', '-', 'g'),
                '^[._-]+', ''),
              '[._-]+$', ''),
            64),
          '[._-]+$', ''),
        ''),
      'worker') AS base
  FROM "workers"
), numbered AS (
  SELECT
    id,
    base,
    row_number() OVER (PARTITION BY app_id, base ORDER BY created_at, id) AS n
  FROM derived
)
UPDATE "workers" w
SET "slug" = CASE
  WHEN n.n = 1 THEN n.base
  ELSE regexp_replace(left(n.base, 64 - length('-' || n.n::text)), '[._-]+$', '')
       || '-' || n.n::text
END
FROM numbered n
WHERE w.id = n.id;

ALTER TABLE "workers" ALTER COLUMN "slug" SET NOT NULL;

-- Not filtered on retirement, exactly like `workers_app_name_uniq`: a retired
-- worker's URN must keep resolving (PR trailers and chat archives reference it),
-- so its slug is reserved as permanently as its name.
CREATE UNIQUE INDEX "workers_app_slug_uniq" ON "workers" ("app_id", "slug");
