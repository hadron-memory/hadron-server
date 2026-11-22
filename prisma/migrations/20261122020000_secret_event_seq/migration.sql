-- #4875 (F8 of #4814): a monotonic per-row sequence on secret_events, so events written in one transaction (which can share an `at`
-- microsecond, and whose UUIDv7 ids are random inside one millisecond) have a recoverable order. Reads order (at, seq).
--
-- Expand-safe: additive. ADD COLUMN ... BIGSERIAL fills every existing row from the DDL's own sequence, so no event row is UPDATEd
-- (the append-only trigger secret_event_append_only is untouched, and it covers this column like every other). The previous image
-- never names the column, and the default fills it on its inserts. Existing rows get values in physical order: among ties that predate
-- this migration the order is arbitrary, and nothing claims otherwise. Indexes are unchanged: (at) still leads, and a tie sorts in memory.
ALTER TABLE "secret_events" ADD COLUMN "seq" BIGSERIAL NOT NULL;
