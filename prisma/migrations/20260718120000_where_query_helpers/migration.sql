-- Migration: where_query_helpers
-- Spec: cor:api:090 (structured/faceted node query — #719).
--
-- Adds the value-cast guard functions the `where` predicate compiler emits
-- (src/lib/retrieval/nodeWhere.ts), plus GIN indexes on the queryable JSONB
-- columns. The stored-value (LHS) side of a number/datetime comparison always
-- routes through a guard, so unparseable stored data yields NULL and the row
-- drops out instead of raising a cast error — a search must never 500 on bad
-- data. Bounds (the RHS) are validated in the compiler; the datetime bound is
-- ALSO wrapped in hadron_safe_timestamptz as defense-in-depth, while the number
-- bound is a validated JS number cast `::numeric`.
--
-- Mirrored in prisma/post-push.sql (dev/test DBs are `db push`-managed and never
-- run migrations) — keep the two definitions in lockstep. Prisma models neither
-- plpgsql functions nor GIN(jsonb_path_ops), so there is no schema.prisma change
-- and a bare `db push` would not create these (hence the post-push.sql mirror).
--
-- Wrapped in BEGIN/COMMIT per the repo migration convention.

BEGIN;

-- text -> numeric, NULL on anything Postgres numeric input rejects.
-- IMMUTABLE: numeric parsing is deterministic (no session dependence).
CREATE OR REPLACE FUNCTION hadron_safe_numeric(input text)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  RETURN input::numeric;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- text -> timestamptz, NULL on unparseable input. STABLE (not IMMUTABLE):
-- timestamptz input without an explicit offset is interpreted in the session
-- TimeZone, so the result is only constant within a single statement.
CREATE OR REPLACE FUNCTION hadron_safe_timestamptz(input text)
RETURNS timestamptz
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  RETURN input::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- GIN(jsonb_path_ops) accelerates `@>` containment (the `contains` operator, and
-- a future eq->containment rewrite). Range / `#>>` extraction predicates scan —
-- acceptable, latency is an explicit non-goal for this surface (#719).
CREATE INDEX IF NOT EXISTS nodes_properties_gin ON nodes USING gin (properties jsonb_path_ops);
CREATE INDEX IF NOT EXISTS nodes_data_gin ON nodes USING gin (data jsonb_path_ops);

COMMIT;
