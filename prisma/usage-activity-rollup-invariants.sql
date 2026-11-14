-- #2719 slice 2: the usage-activity rollup is maintained by statement-level triggers on usage_events, so ONE mechanism
-- covers every writer (the recorder's createMany, mergeUsers' raw reassignment, the user-delete SET NULL, a later
-- soft-delete writer, a hand-run fix). Prisma can model neither the functions nor the triggers; the migration carries
-- this block byte-identically (pinned by a test).
--
-- A cell is (scope, 15-minute UTC cell): scope 'user' counts the events attributed to a user, scope 'memory' the events
-- attributed to a memory (the event's OWN memory_id, cor:dmo:080:02). An event with both ids counts in both scopes; one
-- with neither counts in none. Only live read/write events count, exactly the predicate getUsageActivity reads.
-- Every current IANA offset is a multiple of 15 minutes, so a cell never straddles a local day, week or month edge.
--
-- usage_activity_rollup_state.applies_from is the first cell the triggers maintain. Until the backfill job sets
-- complete, cells before it are NOT in the rollup and the reader answers them from usage_events.

CREATE OR REPLACE FUNCTION hadron_usage_cell(ts timestamp) RETURNS timestamp
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT date_trunc('hour', ts) + floor(extract(minute FROM ts) / 15)::int * interval '15 minutes'
$$;

-- The first cell the triggers maintain: -infinity once the backfill completed, the stored boundary before that, and
-- NULL (the triggers do nothing, the reader never uses the rollup) when no state row exists.
CREATE OR REPLACE FUNCTION hadron_usage_rollup_floor() RETURNS timestamp
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN complete THEN '-infinity'::timestamp ELSE applies_from END
  FROM usage_activity_rollup_state WHERE id = 1
$$;

CREATE OR REPLACE FUNCTION hadron_usage_rollup_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE floor_cell timestamp := hadron_usage_rollup_floor();
BEGIN
  IF floor_cell IS NULL THEN RETURN NULL; END IF;
  -- One grouped upsert per statement, rows in key order so two concurrent statements take their row locks in the
  -- same order and cannot deadlock.
  INSERT INTO usage_activity_cells (scope_kind, scope_id, cell, reads, writes)
  SELECT d.k, d.sid, d.cell, d.r, d.w FROM (
    SELECT s.k, s.sid, hadron_usage_cell(n.created_at) AS cell,
           sum((n.type = 'read')::int)::bigint AS r, sum((n.type = 'write')::int)::bigint AS w
    FROM new_rows n
    CROSS JOIN LATERAL (VALUES ('user', n.user_id), ('memory', n.memory_id)) AS s(k, sid)
    WHERE n.type IN ('read', 'write') AND n.deleted_at IS NULL AND s.sid IS NOT NULL
      AND hadron_usage_cell(n.created_at) >= floor_cell
    GROUP BY s.k, s.sid, hadron_usage_cell(n.created_at)
  ) d ORDER BY d.k, d.sid, d.cell
  ON CONFLICT (scope_kind, scope_id, cell) DO UPDATE
    SET reads = usage_activity_cells.reads + EXCLUDED.reads, writes = usage_activity_cells.writes + EXCLUDED.writes;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION hadron_usage_rollup_after_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE floor_cell timestamp := hadron_usage_rollup_floor();
BEGIN
  IF floor_cell IS NULL THEN RETURN NULL; END IF;
  INSERT INTO usage_activity_cells (scope_kind, scope_id, cell, reads, writes)
  SELECT d.k, d.sid, d.cell, d.r, d.w FROM (
    SELECT s.k, s.sid, hadron_usage_cell(o.created_at) AS cell,
           -sum((o.type = 'read')::int)::bigint AS r, -sum((o.type = 'write')::int)::bigint AS w
    FROM old_rows o
    CROSS JOIN LATERAL (VALUES ('user', o.user_id), ('memory', o.memory_id)) AS s(k, sid)
    WHERE o.type IN ('read', 'write') AND o.deleted_at IS NULL AND s.sid IS NOT NULL
      AND hadron_usage_cell(o.created_at) >= floor_cell
    GROUP BY s.k, s.sid, hadron_usage_cell(o.created_at)
  ) d ORDER BY d.k, d.sid, d.cell
  ON CONFLICT (scope_kind, scope_id, cell) DO UPDATE
    SET reads = usage_activity_cells.reads + EXCLUDED.reads, writes = usage_activity_cells.writes + EXCLUDED.writes;
  RETURN NULL;
END $$;

-- An UPDATE nets the old rows against the new: a change to type, user_id, memory_id, created_at or deleted_at moves
-- the counts, anything else nets to zero and writes nothing.
CREATE OR REPLACE FUNCTION hadron_usage_rollup_after_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE floor_cell timestamp := hadron_usage_rollup_floor();
BEGIN
  IF floor_cell IS NULL THEN RETURN NULL; END IF;
  INSERT INTO usage_activity_cells (scope_kind, scope_id, cell, reads, writes)
  SELECT d.k, d.sid, d.cell, d.r, d.w FROM (
    SELECT x.k, x.sid, x.cell, sum(x.r)::bigint AS r, sum(x.w)::bigint AS w FROM (
      SELECT s.k, s.sid, hadron_usage_cell(o.created_at) AS cell,
             -(o.type = 'read')::int AS r, -(o.type = 'write')::int AS w
      FROM old_rows o
      CROSS JOIN LATERAL (VALUES ('user', o.user_id), ('memory', o.memory_id)) AS s(k, sid)
      WHERE o.type IN ('read', 'write') AND o.deleted_at IS NULL AND s.sid IS NOT NULL
      UNION ALL
      SELECT s.k, s.sid, hadron_usage_cell(n.created_at) AS cell,
             (n.type = 'read')::int AS r, (n.type = 'write')::int AS w
      FROM new_rows n
      CROSS JOIN LATERAL (VALUES ('user', n.user_id), ('memory', n.memory_id)) AS s(k, sid)
      WHERE n.type IN ('read', 'write') AND n.deleted_at IS NULL AND s.sid IS NOT NULL
    ) x
    WHERE x.cell >= floor_cell
    GROUP BY x.k, x.sid, x.cell
    HAVING sum(x.r) <> 0 OR sum(x.w) <> 0
  ) d ORDER BY d.k, d.sid, d.cell
  ON CONFLICT (scope_kind, scope_id, cell) DO UPDATE
    SET reads = usage_activity_cells.reads + EXCLUDED.reads, writes = usage_activity_cells.writes + EXCLUDED.writes;
  RETURN NULL;
END $$;

-- TRUNCATE leaves no events, so no cells: the rollup follows the events, never the other way round.
CREATE OR REPLACE FUNCTION hadron_usage_rollup_after_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE usage_activity_cells;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS usage_events_rollup_insert ON usage_events;
CREATE TRIGGER usage_events_rollup_insert
  AFTER INSERT ON usage_events
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION hadron_usage_rollup_after_insert();

DROP TRIGGER IF EXISTS usage_events_rollup_update ON usage_events;
CREATE TRIGGER usage_events_rollup_update
  AFTER UPDATE ON usage_events
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION hadron_usage_rollup_after_update();

DROP TRIGGER IF EXISTS usage_events_rollup_delete ON usage_events;
CREATE TRIGGER usage_events_rollup_delete
  AFTER DELETE ON usage_events
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION hadron_usage_rollup_after_delete();

DROP TRIGGER IF EXISTS usage_events_rollup_truncate ON usage_events;
CREATE TRIGGER usage_events_rollup_truncate
  AFTER TRUNCATE ON usage_events
  FOR EACH STATEMENT EXECUTE FUNCTION hadron_usage_rollup_after_truncate();
