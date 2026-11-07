import type { Context } from './resolvers.helpers.js';

/** #2817: an hdr_app_ key, identified by the key itself (`appKeyId`), not inferred from absent fields. */
export function isAppKeyPrincipal(ctx: Context): boolean {
  return !!ctx.appKeyId && !!ctx.appId && !ctx.userId && !ctx.impersonation;
}

/**
 * The UsageEvent fields another principal's row may show: volume, never identity or content (cor:acl:090:01).
 * An ALLOWLIST (#3693 review, Gloria P2): a column not named here is dropped from another principal's row, so a
 * new identity-bearing column fails closed. Every SDL field must be in exactly one of these two lists; the
 * classification test in resolvers.usageEventsIdentity3688.test.ts fails until a new field is placed.
 */
export const USAGE_VOLUME_FIELDS = [
  'id', 'type', 'nodeLoc', 'memoryId', 'model', 'tokensIn', 'tokensOut', 'provider', 'keyOwnerType', 'costMicroCents', 'createdAt',
] as const;

/** Identity and content: null on another principal's row (appId kept only when it is the calling App's own). */
export const USAGE_IDENTITY_FIELDS = ['userId', 'sessionId', 'organizationId', 'actionArgs', 'appId'] as const;

type UsageVolumeField = (typeof USAGE_VOLUME_FIELDS)[number];

/**
 * Another principal's row as the projection returns it: the volume columns the input row has, and the identity
 * fields null (appId only the calling App's own). Any other column of the input row is absent, so a consumer that
 * reads one gets a type error, not a silent undefined (#3693 review, Gloria N1).
 */
export type VolumeOnlyUsageRow<T, S extends string | null = null> = Pick<T, Extract<keyof T, UsageVolumeField>> & {
  userId: null;
  /** Null, except where the read already discloses the session (Session.events: the parent's own id). */
  sessionId: S;
  organizationId: null;
  actionArgs: null;
  appId: string | null;
};

/**
 * cor:acl:090:01: a resource read discloses VOLUME, never another principal's identity and never the content they
 * touched. Ruling 0246 (#3688): this holds for every reader, admins and owners included. So a row that is not the
 * caller's own keeps only the volume fields above; its identity fields are null.
 *
 * A row is the caller's own when a user caller recorded it (row.userId is the caller). Those rows are own activity,
 * which the caller already knows by having performed it, so they stay whole. An App key has no own activity (#2817),
 * so every row it reads is masked; its own App's appId is the caller's own identity and stays.
 *
 * One projection for usageEvents, usageEventsPage, nodeUsage and Session.events, so the surfaces cannot drift.
 */
export function projectUsageRowsFor<T extends { userId: string | null; appId: string | null }>(
  ctx: Context,
  rows: T[],
): Array<T | VolumeOnlyUsageRow<T>> {
  // An App key carries no userId (isAppKeyPrincipal), so no row is its own.
  const self = ctx.userId;
  return rows.map((row) => {
    if (self && row.userId === self) return row;
    const masked: Record<string, unknown> = {};
    for (const field of USAGE_VOLUME_FIELDS) if (field in row) masked[field] = (row as Record<string, unknown>)[field];
    for (const field of USAGE_IDENTITY_FIELDS) masked[field] = null;
    if (ctx.appId && row.appId === ctx.appId) masked.appId = row.appId;
    return masked as VolumeOnlyUsageRow<T>;
  });
}

/**
 * #3694 / ruling 0249: a session read is a usage read, so Session.events follows cor:acl:090:01 and ruling 0246.
 *
 * - The caller's OWN session is own activity: every row stays whole, whoever recorded it (another user, or the App
 *   with no user). Own means the session is attributed to the calling user, and not under impersonation: an
 *   impersonated read has the target's userId but is not the target's activity, and the session audience already
 *   drops its self branch for it (sessionAudienceFilter).
 * - Any other readable session: the shared projection above, so another principal's rows are volume only, admins
 *   included. The one identity field restored is sessionId, which is the parent session's own id: the session read
 *   already shows it, so it adds nothing (0249: "never identity beyond what the session read itself already shows").
 */
export function projectSessionEventsFor<T extends { userId: string | null; appId: string | null; sessionId: string | null }>(
  ctx: Context,
  session: { id: string; userId: string | null },
  rows: T[],
): Array<T | VolumeOnlyUsageRow<T, string>> {
  if (ctx.userId && !ctx.impersonation && session.userId === ctx.userId) return rows;
  // Every row here has sessionId = session.id (the resolver's where), so restoring it on a masked row is exact.
  return projectUsageRowsFor(ctx, rows).map((row) =>
    row.sessionId === null ? ({ ...row, sessionId: session.id } as VolumeOnlyUsageRow<T, string>) : row,
  );
}
