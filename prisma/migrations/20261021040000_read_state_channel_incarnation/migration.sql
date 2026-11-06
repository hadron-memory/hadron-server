-- #2181: which Channel incarnation a stored read cursor was last raised under. Additive and nullable; no backfill
-- (NULL = legacy / unknown, never presented as current).
ALTER TABLE "channel_read_states" ADD COLUMN IF NOT EXISTS "channel_incarnation" INTEGER;
