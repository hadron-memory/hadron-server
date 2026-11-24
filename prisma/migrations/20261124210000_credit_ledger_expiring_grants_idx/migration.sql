-- #5011 (Billing A4, cor:dmo:170:10): grant expiry is enforced. The settlement probe (does an organization hold a grant
-- that expired and has no settlement?) runs on every creditBalance read and, after Billing A3, on every launch; the
-- hourly job searches every expired grant. Only grants carry an expiry, so this partial index holds expiring grants
-- alone: the probe is one range per organization and the job scans the small index whole (gate ruling 10.2, option b;
-- Billing A6 adds the owner_user_id twin).
--
-- expand-safe: the previous image runs against this schema (an index only; no column, constraint or data change).
--
-- Built CONCURRENTLY, so writes to credit_ledger_entries are not blocked while it builds. CONCURRENTLY cannot run inside
-- a transaction block, and `prisma migrate deploy` sends a migration file as ONE simple query, which Postgres runs as an
-- implicit transaction only when it holds several statements (SQLSTATE 25001). So this file must stay a single
-- statement: add nothing else here (the 20261014040000 pattern).
--
-- A failed CONCURRENTLY build leaves an INVALID index under this name, which IF NOT EXISTS would then skip. If
-- `\d credit_ledger_entries` ever shows it INVALID, drop it and re-run this statement by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_ledger_entries_expiring_grants_idx
  ON credit_ledger_entries (organization_id, expires_at) WHERE expires_at IS NOT NULL;
