-- #155: DCR-minted OAuth clients expire when unused (Rico's plan 6407153990, R220).
-- Additive column; NULL means the client never expires.
ALTER TABLE "oauth_clients" ADD COLUMN "expires_at" TIMESTAMP(3);

-- Backfill only live DCR clients, from DEPLOY time rather than created_at: a
-- created_at + 30d backfill would let the GC collect every client older than
-- 37 days on its first run, including ones whose long-lived keys are in use.
-- Seeded and hand-made clients ('test', 'e2e-review') stay NULL. The column is
-- UTC wall time without a zone (Prisma's TIMESTAMP(3)), hence AT TIME ZONE.
UPDATE "oauth_clients"
   SET "expires_at" = (now() AT TIME ZONE 'UTC') + interval '30 days'
 WHERE "client_id" LIKE 'dcr\_%' AND "deleted_at" IS NULL;
