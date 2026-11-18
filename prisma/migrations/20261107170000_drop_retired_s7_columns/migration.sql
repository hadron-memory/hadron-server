-- #3695 (refs #3606, #2130): physically remove the four columns #3606 phase 1 retired but kept.
-- Phase 1 (#3611) stopped reading and writing them; the production count under the one-time grant
-- was 0 isolated rows and 0 standby Apps. `worker_wake_settings.exempt_ended_at` STAYS (clearPause
-- still writes it).
--
-- ROLLBACK: after this migration NO pre-drop image can serve, phase 1 included: its Prisma client
-- selects every scalar column, so an unselected read fails with P2022. Recovery is the reverse DDL
-- (run as the owner) BEFORE rolling the image back:
--   ALTER TABLE apps ADD COLUMN delivery_standby_enabled BOOLEAN NOT NULL DEFAULT false;
--   ALTER TABLE worker_wake_settings ADD COLUMN isolated_until TIMESTAMP(3),
--     ADD COLUMN isolated_at TIMESTAMP(3), ADD COLUMN isolated_by_user_id TEXT;
-- Plain DROP COLUMN (the 20261029120000 precedent): loud on an unexpected shape.

ALTER TABLE "apps" DROP COLUMN "delivery_standby_enabled";

ALTER TABLE "worker_wake_settings"
  DROP COLUMN "isolated_until",
  DROP COLUMN "isolated_at",
  DROP COLUMN "isolated_by_user_id";
