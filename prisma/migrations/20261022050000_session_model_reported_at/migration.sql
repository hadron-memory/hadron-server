-- #2252: when a session last self-reported its model. Additive and nullable: no
-- default, no backfill, so every existing session keeps NULL (never reported).
ALTER TABLE "sessions" ADD COLUMN "model_reported_at" TIMESTAMP(3);
