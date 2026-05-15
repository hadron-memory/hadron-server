// URN parser — spec 021-urn-composition.
//
// This module exposes TWO parser surfaces:
//
//   1) **Legacy parser** (`parseUrnInput`, `validateUrnType`, `formatUrn`) —
//      the spec-003/007 surface in use across most of the server. Accepts
//      pre-021 single-`:` grammar. Preserved for callers that haven't
//      migrated yet; the `parseFor` gate dispatches to it for rows whose
//      `urn_normalized_at IS NULL` (pre-migration rows) per FR-032.
//
//   2) **Canonical-form parser** (`parseUrn`, `toParserCanonical`, etc.) —
//      the spec-021 surface. Handles the new `::`-hierarchy grammar and the
//      D11 parser-layer canonical-form rewrites (cats 1, 4). Cats 2 and 3
//      require DB access and live in a resolver-layer module that consumes
//      `ParsedUrn` objects from this parser.
//
// Contracts: spec-kits/specs/021-urn-composition/contracts/parser.md,
// spec-kits/specs/021-urn-composition/contracts/slug-validation.md.

// ============================================================================
// D1 type registry (canonical, locked)
// ============================================================================

/** Core URN types per D1. */
const CORE_TYPES = [
  'agent', 'app', 'app-user', 'ai-config', 'asset', 'edge',
  'license', 'memory', 'node', 'org', 'platform', 'reference',
  'session', 'subscription', 'usage', 'user',
] as const;

/** Node types per D1. */
const NODE_TYPES = [
  'abstract', 'partial', 'parent', 'plan', 'prompt', 'record',
  'task', 'review',
] as const;

/** Node roles per D1 (also valid as `urn:<role>:...` per D11 cat 2). */
const NODE_ROLES = [
  'chat', 'chat-message', 'config', 'conversation', 'event',
  'goal', 'stage',
] as const;

/** Node parts per D1. */
const NODE_PARTS = ['condition', 'data'] as const;

/** All URN types recognized after `urn:`. */
const URN_TYPES = [
  ...CORE_TYPES,
  ...NODE_TYPES,
  ...NODE_ROLES,
  ...NODE_PARTS,
] as const;

const URN_TYPE_SET = new Set<string>(URN_TYPES);

export type UrnType = (typeof URN_TYPES)[number];

/** Memory-role markers per D4 (slug-validation reserves their prefixes). */
const ROLE_MARKERS = ['system', 'app-mem', 'app-user', 'group-mem', 'priv'] as const;

/**
 * Slug-reserved-word list per FR-019 — a SUPERSET of UrnType. Includes:
 *   - the D1 type registry (including `loc`, which is deprecated as a URN
 *     type per FR-021 but still reserved as a slug to future-proof the
 *     namespace),
 *   - the D4 role-marker prefixes.
 * Case-insensitive: store lowercased here, compare lowercased.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set<string>([
  ...URN_TYPES,
  'loc', // deprecated URN type; still reserved as a slug
  ...ROLE_MARKERS,
].map(w => w.toLowerCase()));

/** D11 alias categories tracked in `ParsedUrn.parserRewrites`. */
export type AliasCategory =
  | 'source-install-memory'     // D11 cat 1 — parser layer
  | 'node-role-polymorphism'    // D11 cat 2 — resolver layer
  | 'path-slug-shortening'      // D11 cat 3 — resolver layer
  | 'type-marker-optionality';  // D11 cat 4 — parser layer

/** Type-marker words that may appear inside path-segments per D2 / FR-005. */
const TYPE_MARKERS: ReadonlySet<string> = new Set(['app', 'agent', 'memory']);

// ============================================================================
// Error types
// ============================================================================

export type UrnParseErrorReason =
  | 'unknown-type'             // type after `urn:` is not in the UrnType registry
  | 'malformed-grammar'        // structural parse failure not covered by a more specific reason
  | 'empty-segment'            // a `::` produced an empty path-segment
  | 'trailing-double-colon'    // URN ends with `::`
  | 'reserved-word-slug'       // a slug equals a reserved word per FR-019
  | 'invalid-charset'          // a slug violates FR-016's charset
  | 'slug-too-long'            // a slug exceeds FR-017's 64-char limit
  | 'loc-segment-rejected'     // URN contains a `loc:` segment per FR-021
  | 'invalid-segment-shape';   // a path-segment violates FR-020's internal-`:` count rules

export class UrnParseError extends Error {
  constructor(
    public readonly input: string,
    public readonly reason: UrnParseErrorReason,
    public readonly offendingSegment?: string,
  ) {
    super(messageFor(input, reason, offendingSegment));
    this.name = 'UrnParseError';
  }
}

function messageFor(
  input: string,
  reason: UrnParseErrorReason,
  offending: string | undefined,
): string {
  // Human-readable per Constitution Principle III: state what failed AND
  // (where actionable) what the user can do about it.
  const cite = offending ? ` (offending: "${offending}")` : '';
  switch (reason) {
    case 'unknown-type':
      return `URN "${input}" uses an unknown type. The type segment after "urn:" must be one of the registered types.`;
    case 'malformed-grammar':
      return `URN "${input}" does not match the expected "urn:<type>:<path>" grammar${cite}.`;
    case 'empty-segment':
      return `URN "${input}" contains an empty path-segment (caused by "::::" or similar). Each "::"-separated piece must be non-empty.`;
    case 'trailing-double-colon':
      return `URN "${input}" ends with "::". Remove the trailing separator.`;
    case 'reserved-word-slug':
      return `Slug${cite} is a reserved word and cannot be used. Reserved words are URN type names (agent, app, memory, …) and memory role markers (system, app-user, priv, …). Pick a different name.`;
    case 'invalid-charset':
      return `Slug${cite} contains characters outside the allowed set. Slugs may use letters, digits, dots, underscores, and hyphens; they must start and end with a letter or digit.`;
    case 'slug-too-long':
      return `Slug${cite} exceeds the 64-character limit. Pick a shorter name.`;
    case 'loc-segment-rejected':
      return `URN "${input}" contains a "loc:" segment. The "loc:" prefix is deprecated; rewrite the URN using the current grammar.`;
    case 'invalid-segment-shape':
      return `URN path-segment${cite} has the wrong number of ":"-separated parts for its position. See FR-020 internal-":" shape rules.`;
  }
}

// ============================================================================
// Public surface: canonical-form parser (spec 021)
// ============================================================================

export interface ParsedUrn {
  /** The URN type after `urn:` — always a member of the D1 registry. */
  type: UrnType;
  /**
   * `::`-separated pieces of the URN path, in order (D9.4: "path-segment").
   * Each path-segment may itself contain `:`-separated slug atoms.
   */
  pathSegments: string[];
  /**
   * The canonical-form URN AFTER parser-layer rewrites (cats 1, 4 only).
   * The resolver layer may further rewrite this to apply cats 2 and 3.
   */
  parserCanonical: string;
  /** The original input as supplied to `parseUrn`. */
  inputForm: string;
  /** D11 categories that fired during parser-layer rewrites (cats 1, 4 only). */
  parserRewrites: AliasCategory[];
  /**
   * True when the input shape suggests cat 2 (node-role polymorphism) or
   * cat 3 (path/slug shortening) may need to fire downstream. Cats 2 and 3
   * require DB context; the resolver layer (server-side only) consumes this
   * flag.
   */
  needsResolverCanonicalization: boolean;
}

/**
 * Parse a URN string. Returns a `ParsedUrn` with parser-layer canonicalization
 * applied (D11 cats 1, 4). Throws `UrnParseError` on any acceptance-rule
 * violation (D1 registry, D2 grammar, D9 slug rules, D8 `loc:` deprecation).
 */
export function parseUrn(input: string): ParsedUrn {
  // Error precedence per FR-021: `loc:` rejection wins over `unknown-type`.
  // Detect `loc:` segments BEFORE the type-registry check.
  if (containsLocSegment(input)) {
    throw new UrnParseError(input, 'loc-segment-rejected');
  }

  const prefixMatch = input.match(/^urn:([a-z][a-z0-9-]*):(.+)$/);
  if (!prefixMatch) {
    throw new UrnParseError(input, 'malformed-grammar');
  }

  const type = prefixMatch[1];
  if (!URN_TYPE_SET.has(type)) {
    throw new UrnParseError(input, 'unknown-type');
  }

  const path = prefixMatch[2];

  // Trailing `::` check before splitting.
  if (path.endsWith('::')) {
    throw new UrnParseError(input, 'trailing-double-colon');
  }

  // Split on `::` to get path-segments.
  const rawSegments = path.split('::');
  if (rawSegments.some(s => s.length === 0)) {
    throw new UrnParseError(input, 'empty-segment');
  }

  // Validate each segment's slug atoms (charset + length only — reserved-
  // word check happens after cat 4 stripping below so type markers don't
  // trip on themselves).
  for (const segment of rawSegments) {
    validatePathSegment(segment);
  }

  // === Parser-layer rewrites ===

  const parserRewrites: AliasCategory[] = [];

  // Cat 4: type-marker optionality. Strip type markers from positionally-
  // determinable hierarchy positions. Run first so subsequent steps see a
  // normalized shape AND so the reserved-word check doesn't trip on type-
  // marker atoms.
  const { segments: cat4Segments, fired: cat4Fired } = stripTypeMarkers(rawSegments);
  if (cat4Fired) {
    parserRewrites.push('type-marker-optionality');
  }

  // Reject reserved words at non-structural positions. Role-marker words
  // (system, app-mem, app-user, priv, group-mem) are legitimate ONLY at
  // the FINAL hierarchy segment of a memory URN (FR-012). Type-marker
  // words (app, agent, memory) were stripped by cat 4 at segment-start;
  // anything that survives as a bare atom is a user slug at the wrong
  // position.
  rejectReservedWordsAtIllegalPositions(input, type, cat4Segments);

  // Cat 1: source/installation memory. When the installing-org segment
  // equals the author-org segment (after cat 4's strip), rewrite the
  // install-by-self URN to the definition URN.
  const { segments: cat1Segments, fired: cat1Fired } = collapseSelfInstall(
    type as UrnType,
    cat4Segments,
  );
  if (cat1Fired) {
    parserRewrites.push('source-install-memory');
  }

  // === Resolver-layer flag ===
  // True if the URN shape suggests cat 2 or cat 3 may apply. The parser
  // can't tell for sure without DB context, so it flags conservatively.
  const needsResolverCanonicalization =
    needsCat2(type as UrnType, cat1Segments) ||
    needsCat3(type as UrnType, cat1Segments);

  const parserCanonical = `urn:${type}:${cat1Segments.join('::')}`;

  return {
    type: type as UrnType,
    pathSegments: cat1Segments,
    parserCanonical,
    inputForm: input,
    parserRewrites,
    needsResolverCanonicalization,
  };
}

/** True if the input string contains a `loc:` segment anywhere. */
function containsLocSegment(input: string): boolean {
  // `urn:loc:...` OR `loc:...` at the start OR `::loc:...` mid-path.
  return /(^|::|urn:)loc:/.test(input);
}

/**
 * Validate a `::`-separated path-segment. PARSING-time validation: enforces
 * FR-016 charset and FR-017 length on each slug atom inside the segment,
 * but DOES NOT enforce FR-019 reserved-word rejection — role-marker atoms
 * (`system`, `app-user`, `priv`, …) and type-name atoms appear LEGITIMATELY
 * inside URN paths, so rejecting them at parse time would be wrong. The
 * reserved-word check happens at entity-CREATE boundaries via
 * `validateUserSlug`, not here.
 */
function validatePathSegment(segment: string): void {
  const atoms = segment.split(':');
  for (const atom of atoms) {
    validateAtomShape(atom);
  }
}

/**
 * Parse-time slug-atom shape check: FR-016 charset + FR-017 length only.
 * Reserved-word rejection is FR-019 and lives in `validateUserSlug`.
 */
function validateAtomShape(slug: string): void {
  if (slug.length === 0) {
    throw new UrnParseError(slug, 'invalid-charset', slug);
  }
  if (slug.length > 64) {
    throw new UrnParseError(slug, 'slug-too-long', slug);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(slug)) {
    throw new UrnParseError(slug, 'invalid-charset', slug);
  }
}

/**
 * Entity-CREATE-time slug validation per FR-016 + FR-017 + FR-019. Used at
 * GraphQL `createMemory` / `createAgent` / `createApp` / `upsertNode`
 * boundaries and at MCP-tool create paths. Throws `UrnParseError` on any
 * violation, including reserved-word collision.
 *
 * This is the function that prevents a user from naming their memory
 * `system`, `app-user`, etc. — at parse time those words may be legitimate
 * structurally (role markers at the final segment of a memory URN); at
 * entity-create time they are unconditionally rejected.
 */
export function validateUserSlug(slug: string): void {
  validateAtomShape(slug);
  if (RESERVED_SLUGS.has(slug.toLowerCase())) {
    throw new UrnParseError(slug, 'reserved-word-slug', slug);
  }
}

/** URN types that identify a node (vs a memory / agent / app / org / etc.). */
const NODE_URN_TYPES: ReadonlySet<string> = new Set<string>([
  'node',
  ...NODE_TYPES,
  ...NODE_ROLES,
  ...NODE_PARTS,
]);

/**
 * Position-aware reserved-word rejection during URN parsing.
 * Role-marker words (system, app-mem, app-user, priv, group-mem) appear
 * legitimately at specific structural positions:
 *
 *   - Memory URN: role-marker is the FINAL hierarchy segment (FR-012).
 *     Minimum 3 segments (need agent context above).
 *   - Node URN (urn:node:... or any node-role / node-type / node-part):
 *     role-marker is the SECOND-TO-LAST hierarchy segment (the leaf is
 *     the node loc beneath the memory role).
 *
 * Anywhere else, a reserved-word atom is a user-created slug at the
 * wrong position and the URN is malformed.
 */
function rejectReservedWordsAtIllegalPositions(
  input: string,
  type: string,
  segments: string[],
): void {
  const finalIdx = segments.length - 1;
  // Where a role-marker is structurally allowed for this URN type.
  let roleMarkerIdx: number | null;
  let minSegments: number;
  if (type === 'memory') {
    roleMarkerIdx = finalIdx; // final segment
    minSegments = 3;          // need org + agent + role
  } else if (NODE_URN_TYPES.has(type)) {
    roleMarkerIdx = finalIdx - 1; // second-to-last (leaf is below)
    minSegments = 4;              // need org + (app | agent) + agent + role + leaf — at least 4 with definition shape; node URN MUST have at least one segment after the role marker.
    // Refinement: only require >=2 path-segments if the URN has a leaf.
    // Node URNs always have a leaf, so `length-1` is leaf, `length-2` is role-marker.
    minSegments = Math.min(minSegments, segments.length);
  } else {
    roleMarkerIdx = null; // no structural role-marker position for this type
    minSegments = 0;
  }

  // For node URNs, the leaf segment is the node's intra-memory loc — a
  // free-form path that may legitimately contain atoms named after URN
  // types (e.g., `review:sort-imports`). Skip the reserved-word check
  // there.
  const leafIsNodeLoc = NODE_URN_TYPES.has(type);

  for (let i = 0; i < segments.length; i++) {
    if (leafIsNodeLoc && i === finalIdx) continue; // node loc: free-form

    const atoms = segments[i].split(':');
    for (let j = 0; j < atoms.length; j++) {
      const atom = atoms[j];
      const lower = atom.toLowerCase();
      if (!RESERVED_SLUGS.has(lower)) continue;

      // Allowed: role-marker at its structural position, first atom of
      // that segment (followed optionally by a `:<param>` atom for the
      // parameterized variants — app-user / priv / group-mem).
      const isRoleMarkerPosition =
        roleMarkerIdx !== null &&
        i === roleMarkerIdx &&
        j === 0 &&
        segments.length >= minSegments &&
        (ROLE_MARKERS as readonly string[]).includes(lower);
      if (isRoleMarkerPosition) continue;

      throw new UrnParseError(input, 'reserved-word-slug', atom);
    }
  }
}

/**
 * Cat 4 — strip optional type markers (`app:`, `agent:`, `memory:`) from
 * each path-segment where the marker is positionally determinable.
 *
 * Strategy: a marker at the front of a segment is dropped if the marker
 * word matches a known type and the following atom is a non-marker slug.
 * Markers can stack (e.g., `agent:hadronmemory.com:coding-agent` has the
 * `agent:` marker prefixing an author-org and slug). We only strip ONCE
 * per segment to avoid greedy collapse of legitimate slugs that happen to
 * share names with markers (handled by FR-019 reserved-word rejection on
 * the validator side, but defense-in-depth here).
 */
function stripTypeMarkers(segments: string[]): {
  segments: string[];
  fired: boolean;
} {
  let fired = false;
  const out = segments.map(segment => {
    const atoms = segment.split(':');
    // Only strip a leading marker that's at position 0 of a segment.
    if (atoms.length >= 2 && TYPE_MARKERS.has(atoms[0])) {
      fired = true;
      return atoms.slice(1).join(':');
    }
    return segment;
  });
  return { segments: out, fired };
}

/**
 * Cat 1 — collapse install-by-self URN to definition URN when the installing
 * org equals the author org.
 *
 * Recognized shapes (after cat 4):
 *   urn:memory:<org>::<org>:<slug>::<role>   ->   urn:memory:<org>::<slug>::<role>
 *   urn:agent:<org>::<org>:<slug>            ->   urn:agent:<org>::<slug>
 */
function collapseSelfInstall(
  type: UrnType,
  segments: string[],
): { segments: string[]; fired: boolean } {
  if ((type !== 'memory' && type !== 'agent') || segments.length < 2) {
    return { segments, fired: false };
  }

  const orgSeg = segments[0];
  const installSeg = segments[1];

  // installSeg should be `<author-org>:<slug>` for an install-by-self.
  const installAtoms = installSeg.split(':');
  if (installAtoms.length !== 2) {
    return { segments, fired: false };
  }

  const [authorOrg /*, slug */] = installAtoms;

  if (authorOrg !== orgSeg) {
    return { segments, fired: false };
  }

  // Self-install detected: collapse to definition URN.
  const collapsed = [orgSeg, installAtoms[1], ...segments.slice(2)];
  return { segments: collapsed, fired: true };
}

/**
 * Cat 2 (node-role polymorphism) — does this URN's shape suggest a
 * resolver-layer rewrite to `urn:<role>:...`?
 *
 * Conservatively: `urn:node:...` URNs ALWAYS need a resolver check (the
 * resolver looks up the addressed node's `role`; if set, rewrites to
 * `urn:<role>:...`).
 */
function needsCat2(type: UrnType, _segments: string[]): boolean {
  return type === 'node';
}

/**
 * Cat 3 (path/slug shortening) — does this URN's shape suggest a
 * resolver-layer rewrite to a fully-qualified path?
 *
 * Cat 3 applies to AGENT install URNs only. The install slot (the final
 * hierarchy segment of a 3-segment agent URN) is `<author-org>:<slug>` in
 * canonical form; if it's just `<slug>` (single atom, not a role-marker),
 * that's a shortening that needs DB lookup to expand.
 *
 * Memory URNs do NOT trigger cat 3: the per-agent memory's URN inherits
 * the agent's identity from the path (the install pivot disambiguates the
 * agent), so the agent slot inside a memory URN does NOT carry author-org.
 * See examples.md in the design discussion for the worked memory shape.
 */
function needsCat3(type: UrnType, segments: string[]): boolean {
  // Only agent install URNs (3+ hierarchy segments, where the install slot
  // is the final segment).
  if (type !== 'agent') return false;
  if (segments.length < 3) return false;

  const installSlot = segments[segments.length - 1];
  const atoms = installSlot.split(':');
  if (atoms.length === 1) {
    // A single-atom install slot is a candidate for cat 3 expansion
    // (shortened form). Role-markers don't appear in agent URNs at this
    // position, so no carve-out needed.
    return true;
  }
  return false;
}

/** True if `parseUrn(input).parserCanonical === input` (no rewrites needed). */
export function isParserCanonical(input: string): boolean {
  try {
    const parsed = parseUrn(input);
    return parsed.parserCanonical === input && parsed.parserRewrites.length === 0;
  } catch {
    return false;
  }
}

/**
 * Convenience: parse the input and return its parser-layer canonical form
 * (cats 1, 4 applied). Throws `UrnParseError` on parse failure. Note that
 * resolver-layer canonicalization (cats 2, 3) is NOT applied here — see
 * the resolver module for that.
 */
export function toParserCanonical(input: string): string {
  return parseUrn(input).parserCanonical;
}

// ============================================================================
// Per-row gate (FR-032)
// ============================================================================

/** Minimal row shape for `parseFor` — just needs `urn` and the migration gate. */
export interface UrnRow {
  urn: string;
  urnNormalizedAt: Date | null;
}

/**
 * Per-row parser dispatch (FR-032 migration gate). Reads `urnNormalizedAt`
 * to decide which parser handles the row:
 *   - `urnNormalizedAt IS NOT NULL` → new canonical-form parser
 *   - `urnNormalizedAt IS NULL`     → legacy parser
 *
 * Returns a thin `{ canonical, isLegacy }` envelope. Callers that need the
 * full `ParsedUrn` should call `parseUrn(row.urn)` directly after confirming
 * `row.urnNormalizedAt !== null`.
 */
export function parseFor(row: UrnRow): { canonical: string; isLegacy: boolean } {
  if (row.urnNormalizedAt !== null) {
    return { canonical: parseUrn(row.urn).parserCanonical, isLegacy: false };
  }
  // Legacy path: return the row's urn as-is. The legacy parser's
  // `parseUrnInput` strips the `urn:<type>:` prefix and returns the bare
  // value; for `parseFor` we want the FULL URN string, so just return as-is.
  return { canonical: row.urn, isLegacy: true };
}

// ============================================================================
// Legacy parser surface (preserved for backward-compat callers)
// ============================================================================

/** Legacy types accepted by `parseUrnInput`. Pre-021. */
const LEGACY_URN_TYPES = ['org', 'memory', 'agent', 'app', 'node'] as const;
type LegacyUrnType = (typeof LEGACY_URN_TYPES)[number] | 'loc' | 'unknown';

export interface LegacyParsedUrn {
  type: LegacyUrnType;
  value: string;
}

/**
 * Legacy: parse a URN input string, stripping the `urn:<type>:` or `loc:`
 * prefix. Returns the type and bare value. Unprefixed inputs are returned
 * as type `'unknown'` for backwards compatibility. Used by callers that
 * predate spec 021; new code SHOULD use `parseUrn` instead.
 */
export function parseUrnInput(input: string): LegacyParsedUrn {
  const match = input.match(/^urn:(org|memory|agent|app|node):(.+)$/);
  if (match) return { type: match[1] as LegacyUrnType, value: match[2] };
  const locMatch = input.match(/^loc:(.+)$/);
  if (locMatch) return { type: 'loc', value: locMatch[1] };
  return { type: 'unknown', value: input };
}

/** Format a bare value as a typed URN string for display/output. */
export function formatUrn(type: string, value: string): string {
  return `urn:${type}:${value}`;
}

/**
 * Legacy: validate that a parsed URN matches the expected type. Returns an
 * error message string if mismatched, or null if ok. Type `'unknown'`
 * (unprefixed input) is always accepted for backwards compatibility.
 */
export function validateUrnType(
  parsed: LegacyParsedUrn,
  expected: LegacyUrnType,
): string | null {
  if (parsed.type === 'unknown') return null;
  if (parsed.type === expected) return null;
  // loc is accepted where node is expected (legacy behavior).
  if (parsed.type === 'loc' && expected === 'node') return null;
  return `Expected ${expected} URN (urn:${expected}:...), got urn:${parsed.type}:...`;
}
