/**
 * Loc validation shared by the GraphQL `upsertNode` resolver and the MCP
 * tool surface. Each colon-separated segment must contain only ASCII
 * letters, digits, hyphens, or underscores — same rule the portal's
 * client-side hint advertises.
 *
 * Throws `InvalidLocError` (typed; the GraphQL resolver layer wraps it
 * as `GraphQLError` with `extensions.code: 'InvalidLocError'`).
 */

const SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export class InvalidLocError extends Error {
  constructor(public loc: string, public segment?: string) {
    const detail = segment !== undefined && segment !== loc
      ? ` (segment "${segment}")`
      : '';
    super(`Invalid loc "${loc}"${detail}: each colon-separated segment must contain only letters, digits, hyphens, or underscores.`);
    this.name = 'InvalidLocError';
  }
}

export function validateLoc(loc: string): void {
  if (!loc) {
    throw new InvalidLocError(loc);
  }
  const parts = loc.split(':');
  for (const p of parts) {
    if (!SEGMENT_RE.test(p)) {
      throw new InvalidLocError(loc, p);
    }
  }
}
