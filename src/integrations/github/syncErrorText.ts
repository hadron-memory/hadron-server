/**
 * #4731 (Rook's LOW on #4719, Anita's F2): a sync's failure text is stored on the memory (`sync_error`) and returned to its
 * caller, so it must not carry infrastructure detail. A driver or Prisma connection failure names `host:port` ("connect
 * ECONNREFUSED 10.0.0.5:5432", Prisma P1001), and the sync-run lock's own connect is one such failure.
 *
 * Fixed text for an INFRASTRUCTURE fault (a Prisma client error, a Node system error with a syscall, a Postgres error with
 * a SQLSTATE) plus its code; every other error keeps its own message, because the sync's operator-facing refusals (an invalid
 * source, a review required, a git failure's fixed text) are written to be read and carry no host.
 */

export const INTERNAL_SYNC_FAILURE = 'sync failed (internal)';

type Faultish = { name?: unknown; code?: unknown; syscall?: unknown; errno?: unknown; severity?: unknown };

/** The fixed text for an infrastructure fault, or null when the error is not one (keep its message). */
export function infrastructureFaultText(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const e = error as Faultish;
  const code = typeof e.code === 'string' ? e.code : undefined;
  const infrastructure =
    (typeof e.name === 'string' && e.name.startsWith('PrismaClient'))
    || typeof e.syscall === 'string'
    || typeof e.severity === 'string'
    || (code !== undefined && /^(P\d{4}|[0-9A-Z]{5})$/.test(code));
  if (!infrastructure) return null;
  return code !== undefined && /^\w{1,32}$/.test(code) ? `${INTERNAL_SYNC_FAILURE} (${code})` : INTERNAL_SYNC_FAILURE;
}

/** What a failed sync stores in `sync_error` and returns as `error`. */
export function syncFailureText(error: unknown): string {
  return infrastructureFaultText(error) ?? (error as Error).message;
}
