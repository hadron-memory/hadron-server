/**
 * #4447 / #4850: the team metrics dials (Holger, 2026-11-18, R2: A), retunable without a contract change. Kept in a module with
 * no imports so the SDL (src/api/graphql/schema/typeDefs.ts) states the same numbers the code enforces.
 */
export const METRICS_IDS_CAP = 200;
const DAY_MS = 24 * 3_600_000;
export const METRICS_MAX_WINDOW_DAYS = 31;
export const METRICS_DEFAULT_WINDOW_DAYS = 7;
export const METRICS_MAX_WINDOW_MS = METRICS_MAX_WINDOW_DAYS * DAY_MS;
export const METRICS_DEFAULT_WINDOW_MS = METRICS_DEFAULT_WINDOW_DAYS * DAY_MS;
/** Groups listed per level (owners; projects per owner; started projects), one more is read to learn there were more. */
export const METRICS_GROUP_CAP = 200;
