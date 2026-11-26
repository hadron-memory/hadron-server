-- #5014 (Billing A6, cor:dmo:170:10): the owner_user_id twin of credit_ledger_entries_expiring_grants_idx (#5011, A4). A person's
-- ledger is settled by the same probe on every creditBalance read and by the hourly job, so it needs the same partial index:
-- expiring grants alone, one range per owner.
--
-- expand-safe: an index only; no column, constraint or data change.
--
-- Built CONCURRENTLY, so writes to credit_ledger_entries are not blocked while it builds. CONCURRENTLY cannot run inside
-- a transaction block, and `prisma migrate deploy` sends a migration file as ONE simple query, which Postgres runs as an
-- implicit transaction only when it holds several statements (SQLSTATE 25001). So this file must stay a single
-- statement: add nothing else here (the 20261125140000 pattern).
--
-- A failed CONCURRENTLY build leaves an INVALID index under this name, which IF NOT EXISTS would then skip. If
-- `\d credit_ledger_entries` ever shows it INVALID, drop it and re-run this statement by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_ledger_entries_person_expiring_grants_idx
  ON credit_ledger_entries (owner_user_id, expires_at) WHERE expires_at IS NOT NULL;
