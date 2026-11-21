// Ticker bounds and closed lists — #1747, cor:agt:080:05. One place, so the
// resolver, the CHECK constraint (prisma/ticker-invariants.sql) and the tests agree.

export const TICKER_MAX_CADENCE_SECONDS = 86_400;
export const TICKER_HARD_FLOOR_SECONDS = 60;
export const TICKER_CAP_CEILING = 100;
export const TICKER_NAME_MAX = 100;
export const TICKER_CHANNELS_MAX = 200;

export const TICKER_DEFAULTS = {
  minCadenceSeconds: 120,
  selfSubscribeCadenceSeconds: 600,
  liveCap: 20,
} as const;

export const TICKER_RELEVANCE = ['ALL', 'MENTIONS'] as const;
export const MENTION_WAKE = ['IMMEDIATE', 'OFF'] as const;
export const SUBSCRIPTION_END_REASONS = ['UNSUBSCRIBED', 'WORKER_RETIRED', 'TICKER_DELETED'] as const;
/**
 * The closed grant-name list (cor:agt:080:24); #3308 stages staffing/member grants before enforcement.
 *
 * It is written in four places that must agree, and `src/lib/tickers/grantNames3341.test.ts` pins them:
 * this list, the GraphQL `AppGrantName` enum (+ the two maps below), `prisma/ticker-invariants.sql` (a fresh
 * database) and the newest migration that rewrites `chk_app_grants_shape` (a migrated database). To add a name,
 * change all four and add a NEW migration; never edit an applied one.
 *
 * Rollout and rollback (#3341, from #3339/#3308):
 * - Order: deploy A (the names exist, nothing enforces them), a person who manages the App gives the grants
 *   with grantApp, then deploy B (enforcement). The migration creates no grant rows.
 * - Rolling back the SERVER is safe until a row with a new name exists. Once one does, an older server cannot
 *   serialize it (its GraphQL enum lacks the value). Revoking keeps the row, so delete such rows before an
 *   older server serves the App. Rolling back the CHECK itself fails while such rows exist.
 * - Clients: an exhaustive switch over `AppGrantName` (the CLI, the portal) needs the two new values before
 *   it reads a grant that carries them.
 * - Lock duration: `ADD CONSTRAINT ... CHECK` takes ACCESS EXCLUSIVE on `app_grants` and scans every row to
 *   validate it. The table holds at most one live row per App, worker and name, so it is small and the scan is
 *   short. If it ever grows large, add the CHECK `NOT VALID` and `VALIDATE CONSTRAINT` separately (the second
 *   step takes only SHARE UPDATE EXCLUSIVE). This note evaluates; it authorizes no production DDL.
 */
export const APP_GRANT_NAMES = ['ticker.subscribe-workers', 'workers.staff', 'app.members'] as const;
export type AppGrantName = (typeof APP_GRANT_NAMES)[number];
export const GRANT_SUBSCRIBE_WORKERS: AppGrantName = 'ticker.subscribe-workers';

/** The GraphQL enum spells the grant name as an identifier; the column keeps the dotted form. */
export const GRANT_NAME_TO_ENUM: Record<AppGrantName, string> = { 'ticker.subscribe-workers': 'TICKER_SUBSCRIBE_WORKERS', 'workers.staff': 'WORKERS_STAFF', 'app.members': 'APP_MEMBERS' };
/** The inverse of GRANT_NAME_TO_ENUM, derived so the two cannot drift (#3341); the type of that map makes it complete. */
export const GRANT_ENUM_TO_NAME: Record<string, AppGrantName> = Object.fromEntries(
  (Object.entries(GRANT_NAME_TO_ENUM) as Array<[AppGrantName, string]>).map(([name, wire]) => [wire, name]),
);
