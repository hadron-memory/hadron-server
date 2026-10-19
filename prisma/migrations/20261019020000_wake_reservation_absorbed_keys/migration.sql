-- #2069 — the wake keys a reservation absorbed; an earlier proof of the same wake is not charged a second allowance.
ALTER TABLE "app_wake_reservations" ADD COLUMN "absorbed_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
