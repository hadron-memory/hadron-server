/**
 * Loc validation shared by the GraphQL `upsertNode` resolver and the MCP
 * tool surface. A "loc" is a `:`-separated path inside a memory (e.g.,
 * `review:sort-imports`); each `:`-separated piece is an atom that must
 * satisfy the spec 021 D9 charset.
 *
 * **What this function does NOT do**: it does NOT enforce FR-019
 * reserved-word rejection. Node locs legitimately use type-name words
 * (`review`, `prompt`, `record`, etc.) as nesting namespaces (e.g.,
 * `review:sort-imports`); rejecting those would break the existing
 * authoring convention. Reserved-word rejection happens at
 * **entity-create boundaries** (createMemory, createAgent, createApp)
 * via `validateUserSlug` in `src/lib/urn.ts`, which validates the slug
 * as a stand-alone identifier rather than as a loc atom.
 *
 * Throws `InvalidLocError` (typed; the GraphQL resolver layer wraps it
 * as `GraphQLError` with `extensions.code: 'InvalidLocError'`).
 */

// Spec 021 FR-016 charset — loosened from the pre-021 `[a-zA-Z0-9_-]+`
// rule to allow dots inside atoms (so e.g. domain-name-style slug pieces
// like `a.b.c` work uniformly with the URN parser).
const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

// Spec 021 FR-017 — per-atom length cap. Matches the URN parser.
const SEGMENT_MAX_LENGTH = 64;

export class InvalidLocError extends Error {
  constructor(
    public readonly loc: string,
    public readonly segment?: string,
    public readonly reason: 'empty' | 'invalid-charset' | 'too-long' = 'invalid-charset',
  ) {
    super(messageFor(loc, segment, reason));
    this.name = 'InvalidLocError';
  }
}

function messageFor(
  loc: string,
  segment: string | undefined,
  reason: 'empty' | 'invalid-charset' | 'too-long',
): string {
  if (reason === 'empty') {
    return `Invalid loc: loc cannot be empty.`;
  }
  const detail = segment !== undefined && segment !== loc
    ? ` (segment "${segment}")`
    : '';
  if (reason === 'too-long') {
    return `Invalid loc "${loc}"${detail}: each ":"-separated segment must be ≤ ${SEGMENT_MAX_LENGTH} characters.`;
  }
  return `Invalid loc "${loc}"${detail}: each ":"-separated segment must use letters, digits, dots, underscores, or hyphens, and must start and end with a letter or digit.`;
}

export function validateLoc(loc: string): void {
  if (!loc) {
    throw new InvalidLocError(loc, undefined, 'empty');
  }
  const parts = loc.split(':');
  for (const p of parts) {
    if (p.length === 0) {
      // Empty atom from leading/trailing/consecutive `:`.
      throw new InvalidLocError(loc, p, 'invalid-charset');
    }
    if (p.length > SEGMENT_MAX_LENGTH) {
      throw new InvalidLocError(loc, p, 'too-long');
    }
    if (!SEGMENT_RE.test(p)) {
      throw new InvalidLocError(loc, p, 'invalid-charset');
    }
  }
}
