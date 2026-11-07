import type { Context } from './resolvers.helpers.js';

/** #2817: an hdr_app_ key, identified by the key itself (`appKeyId`), not inferred from absent fields. */
export function isAppKeyPrincipal(ctx: Context): boolean {
  return !!ctx.appKeyId && !!ctx.appId && !ctx.userId && !ctx.impersonation;
}

/**
 * cor:acl:090:01: a resource read discloses VOLUME, never another principal's identity and never the content they
 * touched. Ruling 0246 (#3688): this holds for every reader, admins and owners included. So a row that is not the
 * caller's own carries no user, session or organization, no other App, and no action arguments; the volumes stay.
 *
 * A row is the caller's own when a user caller recorded it (row.userId is the caller). Those rows are own activity,
 * which the caller already knows by having performed it, so they stay whole. An App key has no own activity (#2817),
 * so every row it reads is masked; its own App's appId is the caller's own identity and stays.
 *
 * One projection for usageEvents, usageEventsPage and nodeUsage, so the surfaces cannot drift.
 */
export function projectUsageRowsFor<T extends { userId: string | null; appId: string | null }>(ctx: Context, rows: T[]): T[] {
  // An App key carries no userId (isAppKeyPrincipal), so no row is its own.
  const self = ctx.userId;
  return rows.map((row) => (self && row.userId === self ? row : {
    ...row,
    userId: null,
    sessionId: null,
    organizationId: null,
    actionArgs: null,
    appId: ctx.appId && row.appId === ctx.appId ? row.appId : null,
  }));
}
