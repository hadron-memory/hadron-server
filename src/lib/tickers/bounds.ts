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
/** The closed grant-name list (cor:agt:080:24). One value today. */
export const APP_GRANT_NAMES = ['ticker.subscribe-workers'] as const;
export type AppGrantName = (typeof APP_GRANT_NAMES)[number];
export const GRANT_SUBSCRIBE_WORKERS: AppGrantName = 'ticker.subscribe-workers';

/** The GraphQL enum spells the grant name as an identifier; the column keeps the dotted form. */
export const GRANT_ENUM_TO_NAME: Record<string, AppGrantName> = { TICKER_SUBSCRIBE_WORKERS: 'ticker.subscribe-workers' };
export const GRANT_NAME_TO_ENUM: Record<AppGrantName, string> = { 'ticker.subscribe-workers': 'TICKER_SUBSCRIBE_WORKERS' };
