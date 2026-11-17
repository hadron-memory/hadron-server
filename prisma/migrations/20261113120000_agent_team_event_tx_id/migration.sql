-- #4084 (Glen's blind P2 on hadron-server#4089) — a commit-safe position for agent_team_events. `created_at` is stamped
-- when a row is written, not when its transaction commits, so a reader advancing by (created_at, id) can pass an event
-- that commits later and never see it. `tx_id` is the writing transaction's id, set by the database; a transaction id
-- below a reader snapshot's xmin is final. Additive only (expand).
--
-- Two steps on purpose: a constant default is metadata-only (no table rewrite, existing rows read '0' and sort first,
-- by created_at then id, exactly as before); the volatile default then applies to new rows only. The end state is the
-- one schema.prisma describes (nullable xid8, DEFAULT pg_current_xact_id()), so `migrate diff` shows no drift.
ALTER TABLE "agent_team_events" ADD COLUMN IF NOT EXISTS "tx_id" xid8 DEFAULT '0'::xid8;
ALTER TABLE "agent_team_events" ALTER COLUMN "tx_id" SET DEFAULT pg_current_xact_id();

