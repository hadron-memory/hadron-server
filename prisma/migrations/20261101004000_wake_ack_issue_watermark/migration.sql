-- #3022: accepted issue identity must not move the actual acknowledgement/floor clock.
-- Additive and nullable: an old writer omits this column; readers fall back to acked_at.
ALTER TABLE "worker_wake_acks" ADD COLUMN "issued_at" TIMESTAMP(3);
