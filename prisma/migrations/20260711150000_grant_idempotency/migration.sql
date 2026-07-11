-- Grant idempotency for at-least-once payment webhooks (hadrontool-billing):
-- one ledger row per (source_type, source_id). NULL-source rows (manual
-- grants, adjustments) are unaffected — Postgres unique indexes treat NULLs
-- as distinct. See src/lib/metering grantCredits (P2002 ⇒ return existing).

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_entries_source_type_source_id_key" ON "credit_ledger_entries"("source_type", "source_id");
