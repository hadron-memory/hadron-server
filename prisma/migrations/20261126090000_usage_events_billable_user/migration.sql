-- #5020 (Billing A13, cor:dmo:170:05): a unit of AI spend can name a PERSON as its billable account, beside the
-- organization it could already name. `billable_user_id` is the owner of the work when that owner is a person; it is not
-- `user_id`, the user the work was done for. Nullable with no default; existing rows keep what they have (no backfill).
--
-- usage_events is the append-only, high-volume firehose, so nothing here scans it (#2944 precedent): the column is a
-- catalog-only change, and the foreign key and the CHECK are added NOT VALID (a brief lock, checked on new writes from
-- then on). 20261126090100 and 20261126090200 validate them, each alone, and 20261126090300 builds the index CONCURRENTLY.
ALTER TABLE "usage_events" ADD COLUMN "billable_user_id" TEXT;

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_billable_user_id_fkey" FOREIGN KEY ("billable_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- A unit names at most one billable account: an organization, a person, or none (a platform admin's test of the
-- platform's own configuration). The same statement is in prisma/post-push.sql.
ALTER TABLE "usage_events" ADD CONSTRAINT "chk_usage_event_one_billable" CHECK (num_nonnulls("organization_id", "billable_user_id") <= 1) NOT VALID;
