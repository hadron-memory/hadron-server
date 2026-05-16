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

/**
 * Canonical URN type — the full D1 registry. Used by the spec-021 parser
 * (`parseUrn`, `ParsedUrn`). For backward-compatibility, the legacy
 * `UrnType` symbol below preserves its old meaning (the small pre-021
 * union including `'loc'` and `'unknown'`); callers MUST migrate to
 * `CanonicalUrnType` when adopting the new parser.
 */
export type CanonicalUrnType = (typeof URN_TYPES)[number];

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
  // (where actionable) what the user can do about it. When the offending
  // atom IS the full input (entity-create boundary calling
  // validateUserSlug), skip the parenthetical citation — it would
  // duplicate the slug awkwardly in the error message.
  const cite = offending && offending !== input ? ` (offending: "${offending}")` : '';
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
  type: CanonicalUrnType;
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
 *
 * **Case sensitivity**: per D9 spec, URN slug storage is case-sensitive.
 * `urn:agent:org::Coding-Agent` and `urn:agent:org::coding-agent` are
 * DIFFERENT URNs and parse to distinct `parserCanonical` values. The
 * reserved-word check is the only case-insensitive part (FR-018). URN
 * equality is byte-exact; callers comparing user-supplied URNs MUST NOT
 * fold case unless they also normalize at create time.
 */
export function parseUrn(input: string): ParsedUrn {
  // Reject `urn:loc:...` (canonical loc URN) and bare `loc:...` (the legacy
  // sugar from 2026-04-06) upfront so the dedicated `loc-segment-rejected`
  // reason wins over `unknown-type` / `malformed-grammar`. Per FR-021 the
  // `loc:` vocabulary is deprecated entirely; either form is a signal the
  // caller is using a pre-021 convention and should rewrite. We deliberately
  // restrict this check to inputs that LEAD with a `loc:` prefix —
  // arbitrary free-form strings containing the substring `loc:` are NOT
  // matched here (they'd fall through to `malformed-grammar`).
  if (/^(urn:)?loc:/i.test(input)) {
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

  // Embedded `loc:` segments inside the path (e.g.,
  // `urn:memory:org::loc:foo::system`) are deprecated per FR-021. This
  // check runs on the path-only (not the full input) so it can't
  // misfire on the URN's prefix.
  if (/(^|::)loc:/.test(path)) {
    throw new UrnParseError(input, 'loc-segment-rejected');
  }

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
  // trip on themselves). Errors propagate with the FULL URN as `input` so
  // logging/telemetry preserves context.
  for (const segment of rawSegments) {
    validatePathSegment(input, segment);
  }

  // === Parser-layer rewrites ===

  const parserRewrites: AliasCategory[] = [];

  // Cat 4: type-marker optionality. Strip type markers from positionally-
  // determinable hierarchy positions. Run first so subsequent steps see a
  // normalized shape AND so the reserved-word check doesn't trip on type-
  // marker atoms.
  //
  // **Skip node-leaf segments.** For node URNs the final segment is the
  // node loc (free-form intra-memory path); a leaf that happens to begin
  // with `app:` / `agent:` / `memory:` is a legitimate node loc, NOT a
  // type-marker to strip. Codex review on PR #124 caught that the
  // previous version mangled such locs silently.
  const { segments: cat4Segments, fired: cat4Fired } = stripTypeMarkers(
    rawSegments,
    type,
  );
  if (cat4Fired) {
    parserRewrites.push('type-marker-optionality');
  }

  // Enforce FR-020 internal-`:` shape rules per path-segment position
  // (after cat 4 strip, so type-marker atoms are no longer in the count).
  rejectInvalidSegmentShapes(input, type, cat4Segments);

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
    type as CanonicalUrnType,
    cat4Segments,
  );
  if (cat1Fired) {
    parserRewrites.push('source-install-memory');
  }

  // === Resolver-layer flag ===
  // True if the URN shape suggests cat 2 or cat 3 may apply. The parser
  // can't tell for sure without DB context, so it flags conservatively.
  const needsResolverCanonicalization =
    needsCat2(type as CanonicalUrnType, cat1Segments) ||
    needsCat3(type as CanonicalUrnType, cat1Segments);

  const parserCanonical = `urn:${type}:${cat1Segments.join('::')}`;

  return {
    type: type as CanonicalUrnType,
    pathSegments: cat1Segments,
    parserCanonical,
    inputForm: input,
    parserRewrites,
    needsResolverCanonicalization,
  };
}

/**
 * Validate a `::`-separated path-segment. PARSING-time validation: enforces
 * FR-016 charset and FR-017 length on each slug atom inside the segment,
 * but DOES NOT enforce FR-019 reserved-word rejection — role-marker atoms
 * (`system`, `app-user`, `priv`, …) and type-name atoms appear LEGITIMATELY
 * inside URN paths, so rejecting them at parse time would be wrong. The
 * reserved-word check happens at entity-CREATE boundaries via
 * `validateUserSlug`, not here.
 *
 * `input` is the full URN being parsed; threaded through so any
 * `UrnParseError` carries the full URN as `error.input` (not just the
 * offending atom) for downstream logging/telemetry.
 */
function validatePathSegment(input: string, segment: string): void {
  const atoms = segment.split(':');
  for (const atom of atoms) {
    validateAtomShape(input, atom);
  }
}

/**
 * Parse-time slug-atom shape check: FR-016 charset + FR-017 length only.
 * Reserved-word rejection is FR-019 and lives in `validateUserSlug`.
 *
 * `input` is the full URN being parsed; preserved in the thrown
 * `UrnParseError.input` so callers can recover the original URN that
 * failed. The `offendingSegment` field carries the atom-level detail.
 */
function validateAtomShape(input: string, atom: string): void {
  if (atom.length === 0) {
    // An empty atom is a structural failure (leading/trailing/consecutive
    // `:` inside a path-segment), not a charset issue. Reported as
    // invalid-segment-shape per FR-020.
    throw new UrnParseError(input, 'invalid-segment-shape', atom);
  }
  if (atom.length > 64) {
    throw new UrnParseError(input, 'slug-too-long', atom);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(atom)) {
    throw new UrnParseError(input, 'invalid-charset', atom);
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
  // At entity-create time the "input" being validated IS the slug; pass
  // it as both `input` and `offendingSegment` so error.input has the slug
  // for callers logging the create attempt.
  validateAtomShape(slug, slug);
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
 * Enforce FR-020 internal-`:` shape rules per path-segment position.
 *
 * Per D9.5, each path-segment position has a bounded internal-`:` count
 * (i.e., slug-atom count - 1):
 *
 *   - Org segment (always position 0): 0 internal `:` (single slug atom).
 *   - App segment: 0 or 1. (After cat 4 strip the `app:` marker is gone,
 *     so the segment is just `<app-slug>` — 0 internal `:`. We tolerate 1
 *     defensively for forward compatibility.)
 *   - Agent path-segment: 0, 1, or 2 (`<slug>`, `<author-org>:<slug>`, or
 *     `<author-org>:<sub>:<slug>`).
 *   - Memory role-marker segment: 0 or 1 (`system` / `app-mem` / `app-user:<id>`).
 *   - Node leaf-path: unbounded (free-form node loc).
 *
 * This function makes conservative checks: org segment must have exactly
 * 1 atom; intermediate segments must have ≤ 3 atoms; the leaf has no
 * cap. Violations throw `invalid-segment-shape`.
 */
function rejectInvalidSegmentShapes(
  input: string,
  type: string,
  segments: string[],
): void {
  const finalIdx = segments.length - 1;
  const isNodeUrn = NODE_URN_TYPES.has(type);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const atomCount = segment.split(':').length;
    if (i === 0) {
      // Org segment: exactly one atom.
      if (atomCount !== 1) {
        throw new UrnParseError(input, 'invalid-segment-shape', segment);
      }
      continue;
    }
    if (isNodeUrn && i === finalIdx) {
      // Leaf is the node loc: unbounded.
      continue;
    }
    // Intermediate segments: cap at 3 atoms to bound parser work and
    // catch malformed paths like `urn:agent:org::a:b:c:d:e` early.
    if (atomCount > 3) {
      throw new UrnParseError(input, 'invalid-segment-shape', segment);
    }
  }
}

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
  // Where a role-marker is structurally allowed for this URN type, AND the
  // minimum total segment count below which a role-marker has no valid
  // structural position (it would leave no room for org + agent context).
  let roleMarkerIdx: number | null;
  let minSegments: number;
  if (type === 'memory') {
    // Memory URN role-marker is the FINAL segment. Minimum shapes:
    //   urn:memory:org::agent::role           (3 segments)
    //   urn:memory:org::app::agent::role      (4 segments)
    roleMarkerIdx = finalIdx;
    minSegments = 3;
  } else if (NODE_URN_TYPES.has(type)) {
    // Node URN role-marker is the SECOND-TO-LAST segment (leaf is the node
    // loc beneath the memory role). Minimum shapes:
    //   urn:<role>:org::agent::role::leaf           (4 segments, definition)
    //   urn:<role>:org::app::agent::role::leaf      (5 segments, installed)
    roleMarkerIdx = finalIdx - 1;
    minSegments = 4;
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
function stripTypeMarkers(
  segments: string[],
  urnType: string,
): {
  segments: string[];
  fired: boolean;
} {
  let fired = false;
  // The leaf segment of a node URN is the node loc — free-form intra-
  // memory path. NEVER strip there; a node loc that begins with `app:`
  // or `agent:` is a legitimate user path, not a type marker.
  const isNodeUrn = NODE_URN_TYPES.has(urnType);
  const lastIdx = segments.length - 1;
  const out = segments.map((segment, i) => {
    if (isNodeUrn && i === lastIdx) return segment;
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
 * The install pivot's position depends on URN shape:
 *
 *   Bare agent definition / install (urn:agent:):
 *     urn:agent:<org>::<org>:<slug>            -> urn:agent:<org>::<slug>
 *     urn:agent:<org>::<app>::<org>:<slug>     -> urn:agent:<org>::<app>::<slug>
 *
 *   Bare memory (urn:memory:):
 *     urn:memory:<org>::<org>:<slug>::<role>            -> urn:memory:<org>::<slug>::<role>
 *     urn:memory:<org>::<app>::<org>:<slug>::<role>     -> urn:memory:<org>::<app>::<slug>::<role>
 *
 * The detection scans every intermediate segment (positions 1..N-1 for an
 * agent URN; 1..N-2 for a memory URN where the final segment is a role-
 * marker) for the install-by-self shape `<author-org>:<slug>` where
 * `<author-org>` equals `segments[0]`. The first such match collapses.
 */
function collapseSelfInstall(
  type: CanonicalUrnType,
  segments: string[],
): { segments: string[]; fired: boolean } {
  if ((type !== 'memory' && type !== 'agent') || segments.length < 2) {
    return { segments, fired: false };
  }
  const orgSeg = segments[0];
  // For memory URNs, the final segment is the role marker — exclude it
  // from the scan. For agent URNs, the install pivot CAN be the final
  // segment (definition shape `urn:agent:org::slug` has just 2 segments
  // total and isn't an install; install shape `urn:agent:org::app::author:slug`
  // has the pivot at the last segment).
  const lastScanIdx =
    type === 'memory' ? segments.length - 2 : segments.length - 1;
  for (let i = 1; i <= lastScanIdx; i++) {
    const atoms = segments[i].split(':');
    if (atoms.length !== 2) continue;
    if (atoms[0] !== orgSeg) continue;
    // Self-install detected at position `i`: collapse to `<slug>`.
    const collapsed = [
      ...segments.slice(0, i),
      atoms[1],
      ...segments.slice(i + 1),
    ];
    return { segments: collapsed, fired: true };
  }
  return { segments, fired: false };
}

/**
 * Cat 2 (node-role polymorphism) — does this URN's shape suggest a
 * resolver-layer rewrite to `urn:<role>:...`?
 *
 * Conservatively: `urn:node:...` URNs ALWAYS need a resolver check (the
 * resolver looks up the addressed node's `role`; if set, rewrites to
 * `urn:<role>:...`).
 */
function needsCat2(type: CanonicalUrnType, _segments: string[]): boolean {
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
function needsCat3(type: CanonicalUrnType, segments: string[]): boolean {
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
 *
 *   - `urnNormalizedAt IS NOT NULL` → row is canonical. Parse with the new
 *     parser and return its `parserCanonical`.
 *   - `urnNormalizedAt IS NULL`     → row is pre-021 legacy shape. Parse
 *     with the legacy parser (`parseUrnInput`) to validate it's a
 *     well-formed legacy URN, then return the row's URN string unchanged.
 *     The full URN string is what callers want to surface; the legacy
 *     parser is invoked here so a malformed legacy URN surfaces as an
 *     error at the gate rather than at every downstream consumer.
 *
 * Returns a `{ canonical, isLegacy }` envelope. Callers that need the
 * full `ParsedUrn` for migrated rows should call `parseUrn(row.urn)`
 * directly after confirming `row.urnNormalizedAt !== null`.
 */
export function parseFor(row: UrnRow): { canonical: string; isLegacy: boolean } {
  if (row.urnNormalizedAt !== null) {
    // Migrated row: stored URN MUST equal its parserCanonical (FR-031
    // says canonical form is what gets persisted). Return row.urn — not
    // parseUrn().parserCanonical — so a drift between the stored value
    // and the parser's idea of canonical surfaces here rather than
    // silently masking the bug at every downstream consumer. parseUrn
    // still runs (we throw on parse failure); we just don't replace
    // the stored value.
    const parsed = parseUrn(row.urn);
    if (parsed.parserCanonical !== row.urn) {
      // Stored URN drifted from canonical — likely a write bypassed the
      // canonicalizer. Surface immediately rather than mask.
      throw new UrnParseError(row.urn, 'malformed-grammar');
    }
    return { canonical: row.urn, isLegacy: false };
  }
  // Legacy path: actually validate the URN, don't just call parseUrnInput
  // (which never throws). Codex review on PR #124 caught that the
  // previous version still accepted garbage like `not-a-urn` because
  // parseUrnInput returns `{ type: 'unknown', ... }` for any unmatched
  // input.
  //
  // For a pre-migration row to be readable, its URN MUST start with
  // `urn:<type>:` where <type> is one of the spec-003/007 legacy types
  // (org / memory / agent / app / node). Anything else is corrupt data
  // and should surface at the gate.
  const legacy = parseUrnInput(row.urn);
  if (legacy.type === 'unknown') {
    throw new UrnParseError(row.urn, 'malformed-grammar');
  }
  return { canonical: row.urn, isLegacy: true };
}

// ============================================================================
// Legacy parser surface (preserved for backward-compat callers)
// ============================================================================

/** Legacy types accepted by `parseUrnInput`. Pre-021. */
const LEGACY_URN_TYPES = ['org', 'memory', 'agent', 'app', 'node'] as const;
type LegacyUrnType = (typeof LEGACY_URN_TYPES)[number] | 'loc' | 'unknown';

/**
 * Backward-compat alias for the pre-spec-021 `UrnType` symbol. Preserves
 * the small legacy union for callers that haven't migrated to the spec-021
 * parser. New code SHOULD use `CanonicalUrnType` instead.
 */
export type UrnType = LegacyUrnType;

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
