// URN parser — spec 021-urn-composition.
//
// Scheme prefix (issue #239): `hrn:` is canonical; the legacy `urn:` scheme
// is accepted on input forever. See the "Scheme prefix" section below.
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
// Scheme prefix (issue #239)
// ============================================================================
//
// `hrn:` (Hadron Resource Name, AWS-`arn:`-style) is the CANONICAL scheme
// prefix. `urn:` is the legacy scheme, accepted on input forever — there is
// no deprecation window and no plan for one. Every parser entry point in
// this module accepts both; every emission path composes `hrn:`.

/** The canonical scheme prefix composed on every emission path. */
export const CANONICAL_SCHEME = 'hrn';

/** The legacy scheme prefix, accepted on input forever (issue #239). */
export const LEGACY_SCHEME = 'urn';

const SCHEME_PREFIX_RE = /^(?:hrn|urn):/;

/** True when the input leads with a scheme prefix (`hrn:` or legacy `urn:`). */
export function hasSchemePrefix(input: string): boolean {
  return SCHEME_PREFIX_RE.test(input);
}

/**
 * Rewrite a leading legacy `urn:` scheme to canonical `hrn:`. Inputs without
 * a scheme prefix (bare URNs) and already-canonical inputs pass through.
 */
export function normalizeScheme(input: string): string {
  return input.startsWith('urn:') ? `hrn:${input.slice(4)}` : input;
}

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

/**
 * Memory-role markers per D4 (slug-validation reserves their prefixes).
 *
 * `anon` (issue #352) marks an anonymous, pre-signup session memory — the
 * ephemeral `class='app'` bucket created before `linkMemoryToUser` promotes
 * it to a registered per-user (`app-user`) memory. Spec-021 had no equivalent;
 * it is a first-class marker because anonymous sessions are a first-class
 * concept (`Memory.anonymousExpiresAt`, the anon→user promotion path).
 */
const ROLE_MARKERS = ['system', 'app-mem', 'app-user', 'group-mem', 'priv', 'anon'] as const;

/**
 * Memory-role markers that may appear as the FINAL hierarchy segment of a
 * memory URN (parameterized variants — `app-user`, `priv`, `group-mem`, `anon`
 * — carry a trailing `:<id>`). Exported so the GraphQL resolver layer shares a
 * single source of truth instead of re-listing the markers inline (the
 * re-listing is how #318 silently missed `user`/`anon`).
 */
export const MEMORY_ROLE_MARKERS: readonly string[] = ROLE_MARKERS;

/**
 * Convert a **bare legacy** single-colon memory URN to canonical `::`
 * hierarchy, preserving the `marker:id` boundary for role-marker memories.
 *
 *   `org:agent:app-user:id` → `org::agent::app-user:id`  (NOT `…::app-user::id`)
 *   `org:agent:anon:id`     → `org::agent::anon:id`
 *   `org:specs`             → `org::specs`               (no marker)
 *
 * Input MUST be the bare legacy form (no `hrn:`/`urn:` prefix, single-colon
 * separators — e.g. the output of `normalizeUrnForLookup`). Returns the bare
 * canonical path; callers wrap with the scheme/type prefix (via
 * `formatCanonicalUrn`) as needed.
 */
export function legacyMemoryUrnToCanonical(bareLegacyUrn: string): string {
  const parts = bareLegacyUrn.split(':');
  let markerIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (MEMORY_ROLE_MARKERS.includes(parts[i])) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx < 0) return parts.join('::');
  const beforeMarker = parts.slice(0, markerIdx).join('::');
  const marker = parts[markerIdx];
  const afterMarker = parts.slice(markerIdx + 1).join(':');
  return afterMarker
    ? `${beforeMarker}::${marker}:${afterMarker}`
    : `${beforeMarker}::${marker}`;
}

/**
 * Extract an agent's slug path from its URN, stripping the leading org
 * segment. Robust to BOTH the legacy single-colon (`org:slug`) and the
 * canonical double-colon (`org::slug`) agent-URN forms — an agent whose URN
 * has been normalized (`urnNormalizedAt`) is stored canonical, and a bare
 * `agentUrn.split(':').slice(1)` would emit a leading colon (`:slug`) and
 * mangle any URN composed from it.
 *
 * Used when composing runtime memory URNs as
 * `${org.urn}:${agentSlug}:<role-marker>:<id>` (#352 review). Reuses
 * `normalizeUrnForLookup` to collapse `::`→`:` first, so the same
 * single-colon split works for either form (and for multi-segment install
 * shapes, matching the prior legacy behavior).
 */
export function agentSlugFromUrn(agentUrn: string): string {
  return normalizeUrnForLookup(agentUrn).split(':').slice(1).join(':');
}

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
  | 'type-marker-optionality'   // D11 cat 4 — parser layer
  | 'legacy-urn-scheme';        // issue #239 — `urn:` scheme rewritten to `hrn:`

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
  | 'slug-not-lowercase'       // a NEW slug contains uppercase (create/rename only; #575)
  | 'slug-too-long'            // a slug exceeds FR-017's 64-char limit
  | 'loc-segment-rejected'     // URN contains a `loc:` segment per FR-021
  | 'invalid-segment-shape'    // a path-segment violates FR-020's internal-`:` count rules
  | 'empty-bare-value'         // formatCanonicalUrn called with empty bareValue (spec 027 FR-005)
  | 'already-prefixed-bare-value' // formatCanonicalUrn bareValue starts with `urn:` (spec 027)
  | 'org-urn-not-bare';        // an org slug carried a scheme prefix or `:` separator (#376)

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

// ============================================================================
// API-boundary qualification (spec 022)
// ============================================================================

/**
 * The entity-type the caller expected the URN to address. Drives the
 * minimum-segment-count rule for `assertFullyQualifiedUrn`. Memory / agent /
 * app URNs need `org + slug` (2 hierarchy segments); node URNs need
 * `org + memory + loc` (3 segments); org URNs need just `org` (1).
 *
 * Spec: 022 / contracts/urn-qualification.md.
 */
export type ExpectedUrnType = 'org' | 'memory' | 'agent' | 'app' | 'node' | 'edge' | 'user';

const MIN_HIERARCHY_SEGMENTS: Record<ExpectedUrnType, number> = {
  org: 1,
  memory: 2,
  agent: 2,
  app: 2,
  node: 3,
  // Spec 037: edges are memory-scoped, loc-addressed peers of nodes — same
  // `<org>::<memory>::<loc>` shape, distinguished only by the type word.
  edge: 3,
  // A user URN is `hrn:user:<handle>` — a single hierarchy segment (the
  // handle), like an org. Users are keyed by their unique handle, not an
  // org-scoped slug; a handle-less user has no URN.
  user: 1,
};

const MIN_SEGMENTS_HINT: Record<ExpectedUrnType, string> = {
  org: '1 hierarchy segment (e.g., "acme.com")',
  memory: '2 hierarchy segments (org::memory, e.g., "acme.com::mmdata")',
  agent: '2 hierarchy segments (org::agent-slug, e.g., "acme.com::coding-agent")',
  app: '2 hierarchy segments (org::app-slug, e.g., "acme.com::dev-app")',
  node: '3 hierarchy segments (org::memory::loc, e.g., "acme.com::mmdata::review:sort-imports")',
  edge: '3 hierarchy segments (org::memory::loc, e.g., "acme.com::mmdata::intro:next")',
  user: '1 hierarchy segment (the handle, e.g., "holger")',
};

/**
 * Node-role types from spec 021 D1 that alias for `urn:node:` per D11 cat 2.
 * A caller passing `urn:prompt:org::mem::loc` where `expectedType='node'` is
 * legitimate; passing `urn:org:foo` where `expectedType='memory'` is not.
 */
const NODE_ROLE_ALIASES: ReadonlySet<string> = new Set<string>([
  'abstract', 'partial', 'parent', 'plan', 'prompt', 'record',
  'task', 'review', 'chat', 'chat-message', 'config', 'conversation',
  'event', 'goal', 'stage', 'condition', 'data',
]);

/**
 * Thrown at the API boundary (MCP tool handlers, GraphQL resolvers,
 * `hadron-client` SDK call sites) when a non-ID-shaped input fails the
 * URN-qualification rule. The error code is `URN_NOT_QUALIFIED` in both
 * GraphQL `extensions.code` and MCP tool error results.
 *
 * Message follows Constitution Principle III: states the offending value
 * AND the canonical-form fix template. `offendingValue` is exposed as a
 * structured field so logging / telemetry can render it without parsing
 * the message. `parseCause` chains the underlying `UrnParseError` when
 * the prefixed-form input failed the grammar parser.
 *
 * Spec: 022 / contracts/urn-qualification.md.
 */
export class UrnNotQualifiedError extends Error {
  public readonly offendingValue: string;
  public readonly expectedType: ExpectedUrnType | undefined;
  public readonly parseCause: UrnParseError | undefined;

  constructor(
    offendingValue: string,
    cause?: UrnParseError,
    expectedType?: ExpectedUrnType,
  ) {
    const fixHint = expectedType
      ? `Expected a ${expectedType} URN with at least ${MIN_SEGMENTS_HINT[expectedType]}.`
      : 'Use the canonical form "<org>::<memory>[::path]" — org and memory slugs are mandatory at the API boundary.';
    super(`URN "${offendingValue}" is not fully qualified. ${fixHint}`);
    this.name = 'UrnNotQualifiedError';
    this.offendingValue = offendingValue;
    this.expectedType = expectedType;
    this.parseCause = cause;
  }
}

/**
 * Normalize a bare URN body (after `urn:<type>:` prefix stripping) so it
 * matches the form stored in the DB. Spec 021's per-row migration is
 * incremental: pre-migrated rows store the legacy single-`:` form
 * (`<org>:<slug>`); migrated rows store the canonical `::` form. During
 * the migration window the DB has a mix. Callers that lookup by URN
 * SHOULD normalize input to the legacy form, which matches every
 * unmigrated row + the spec 022 entityRef tests' fixture shape; the
 * migration plan (spec 021 T067–T073) will revisit the lookup layer
 * once every row is canonical.
 *
 * For canonical-form input (`acme.com::mmdata`), this returns the
 * legacy-form equivalent (`acme.com:mmdata`). For legacy-form input,
 * passthrough.
 *
 * Spec: 021 migration window + 022 entityRef-helper compatibility.
 */
export function normalizeUrnForLookup(bareUrn: string): string {
  return bareUrn.includes('::') ? bareUrn.split('::').join(':') : bareUrn;
}

/**
 * Split a fully-qualified node URN into its memory URN and the loc within
 * that memory. Accepts both bare and `urn:<type>:`-prefixed inputs, and
 * both canonical `::` and legacy `:` mixed-grammar forms.
 *
 * **Self-validating**: this function calls `assertFullyQualifiedUrn(
 * input, 'node')` internally and throws `UrnNotQualifiedError` on
 * malformed inputs. Callers that have already validated MAY redundantly
 * pre-check; the cost is one extra regex scan. The internal validation
 * exists because the function is exported and the previous draft
 * documented qualification as a "precondition" — a sharp edge for
 * call sites added outside the validated MCP tool handlers reviewed
 * for spec 022.
 *
 * The returned `memoryUrn` is the bare form (`<org>:<memorySlug>`) — the
 * shape stored in `Memory.urn` — so it can be passed directly to
 * `resolveMemoryRef` / `findFirst({urn})`.
 *
 * Spec: 022 / contracts/signature-collapse.md.
 */
export function splitNodeUrn(input: string): { memoryUrn: string; loc: string } {
  // Self-validate: every spec-022 caller has already passed through
  // assertFullyQualifiedUrn, but the check is cheap and guards future
  // call sites added outside the spec-022-reviewed tool handlers.
  assertFullyQualifiedUrn(input, 'node');

  // Strip `hrn:<type>:` / legacy `urn:<type>:` prefix if present.
  const prefixMatch = input.match(/^(?:hrn|urn):[a-z][a-z0-9-]*:(.+)$/);
  const path = prefixMatch ? prefixMatch[1] : input;

  // Canonical form: hierarchy separated by `::`. First segment is org,
  // second is memorySlug, the rest is the loc path. Within the loc, `:`
  // atoms preserve their meaning.
  if (path.includes('::')) {
    const segments = path.split('::');
    const memoryUrn = `${segments[0]}:${segments[1]}`;
    const loc = segments.slice(2).join(':');
    return { memoryUrn, loc };
  }

  // Bare / legacy form: split on `:` atoms. The first two atoms form the
  // memory URN; everything after is the loc.
  const atoms = path.split(':');
  const memoryUrn = `${atoms[0]}:${atoms[1]}`;
  const loc = atoms.slice(2).join(':');
  return { memoryUrn, loc };
}

/**
 * Reject inputs that are intended as URNs but lack the fully-qualified shape
 * for `expectedType`. Throws `UrnNotQualifiedError` on failure.
 *
 * **Two input shapes accepted**:
 *   - **Prefixed** (`urn:<type>:<path>`): parsed by spec-021 `parseUrn`, which
 *     gives canonical `pathSegments.length`. The type marker MUST match
 *     `expectedType` (with node-role aliases per D11 cat 2 — e.g.,
 *     `urn:prompt:` is accepted where `expectedType='node'`).
 *   - **Bare** (`<org>:<memory>[:<loc>...]`): the URN-prefix-less form spec-021
 *     D7 / spec-022 FR-007 still accept at the API boundary. Path-segment count
 *     uses splitMixedGrammar semantics (prefer `::`, fall back to `:`).
 *
 * **Pre-condition**: callers MUST filter out ID-shape inputs via `isId()`
 * (`hadron-server/src/lib/entityRef/shape.ts`) before invoking this helper.
 * The qualification rule does NOT apply to ID-shape values per spec 007.
 *
 * Spec: 022 / contracts/urn-qualification.md.
 */
export function assertFullyQualifiedUrn(
  input: string,
  expectedType: ExpectedUrnType,
): void {
  // Strip the optional `urn:<type>:` prefix and capture the type marker.
  // Both canonical (`::` hierarchy) and legacy (`:`-only) prefixed forms
  // are accepted at the API boundary per spec 021 D7 / FR-005 — this
  // helper checks SHAPE (segment count + structural integrity), not
  // full canonical grammar. parseUrn is the right tool for the deeper
  // grammar checks; qualification is the upstream gate.
  let path = input;
  let prefixType: string | null = null;
  const prefixMatch = input.match(/^(?:hrn|urn):([a-z][a-z0-9-]*):(.+)$/);
  if (prefixMatch) {
    prefixType = prefixMatch[1];
    path = prefixMatch[2];
  } else if (hasSchemePrefix(input)) {
    // Malformed prefix shape (e.g., `hrn::foo`, `urn:`). The prefix
    // regex captures any well-formed type marker; anything else is
    // structurally broken.
    throw new UrnNotQualifiedError(input, undefined, expectedType);
  }

  // `loc:` prefix is deprecated entirely per spec 021 FR-021. Even
  // though the spec-022 type set doesn't include 'loc', we surface
  // a uniform qualification error rather than letting it fall through
  // to a type-mismatch error with confusing wording.
  if (prefixType === 'loc') {
    throw new UrnNotQualifiedError(input, undefined, expectedType);
  }

  // Type-marker consistency: explicit prefix MUST match expectedType.
  // Exception: node-role aliases per spec 021 D11 cat 2 (e.g.,
  // `urn:prompt:` is a legitimate alias for `urn:node:`).
  if (prefixType !== null && prefixType !== expectedType) {
    const isNodeRoleAlias =
      expectedType === 'node' && NODE_ROLE_ALIASES.has(prefixType);
    if (!isNodeRoleAlias) {
      throw new UrnNotQualifiedError(input, undefined, expectedType);
    }
  }

  // Reject three-or-more consecutive colons upfront: `:::` is a structural
  // failure mode that the `::`-then-`:`-fallback split can't reliably
  // detect (it leaves a segment with a leading `:` rather than an empty
  // segment).
  if (/:{3,}/.test(path)) {
    throw new UrnNotQualifiedError(input, undefined, expectedType);
  }

  // Mixed-grammar split: prefer `::` (canonical hierarchy separator per
  // spec 021 D2), fall back to `:` for legacy single-colon URNs still
  // flowing through during the migration window.
  const segments = path.includes('::') ? path.split('::') : path.split(':');
  if (segments.some(s => s.length === 0)) {
    // Leading / trailing / consecutive separators — structurally malformed.
    throw new UrnNotQualifiedError(input, undefined, expectedType);
  }
  if (segments.length < MIN_HIERARCHY_SEGMENTS[expectedType]) {
    throw new UrnNotQualifiedError(input, undefined, expectedType);
  }
}

// ============================================================================
// Internal parser helpers
// ============================================================================

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
      return `URN "${input}" uses an unknown type. The type segment after the scheme prefix ("hrn:" or legacy "urn:") must be one of the registered types.`;
    case 'malformed-grammar':
      return `URN "${input}" does not match the expected "hrn:<type>:<path>" grammar${cite} (legacy "urn:" scheme also accepted).`;
    case 'empty-segment':
      return `URN "${input}" contains an empty path-segment (caused by "::::" or similar). Each "::"-separated piece must be non-empty.`;
    case 'trailing-double-colon':
      return `URN "${input}" ends with "::". Remove the trailing separator.`;
    case 'reserved-word-slug':
      return `Slug${cite} is a reserved word and cannot be used. Reserved words are URN type names (agent, app, memory, …) and memory role markers (system, app-user, priv, …). Pick a different name.`;
    case 'invalid-charset':
      return `Slug${cite} contains characters outside the allowed set. Slugs may use letters, digits, dots, underscores, and hyphens; they must start and end with a letter or digit.`;
    case 'slug-not-lowercase':
      return `Slug "${input}" must be lowercase. URN lookups are case-sensitive, so "${input}" and "${input.toLowerCase()}" would be distinct entities — use "${input.toLowerCase()}".`;
    case 'slug-too-long':
      return `Slug${cite} exceeds the 64-character limit. Pick a shorter name.`;
    case 'loc-segment-rejected':
      return `URN "${input}" contains a "loc:" segment. The "loc:" prefix is deprecated; rewrite the URN using the current grammar.`;
    case 'invalid-segment-shape':
      return `URN path-segment${cite} has the wrong number of ":"-separated parts for its position. See FR-020 internal-":" shape rules.`;
    case 'empty-bare-value':
      return `formatCanonicalUrn called with empty bareValue. A bare URN value MUST contain at least one slug atom.`;
    case 'already-prefixed-bare-value':
      return `formatCanonicalUrn bareValue${cite} starts with a scheme prefix ("hrn:" or "urn:"). Pass the bare value (no "hrn:<type>:" prefix); the wrapper composes the prefix itself.`;
    case 'org-urn-not-bare':
      return `Organization URN "${input}" must be a bare slug — no scheme prefix ("hrn:"/"urn:") and no ":" separator. The Organization.urn field returns the canonical "hrn:org:<slug>" form on read; submit only the bare "<slug>" (e.g. "acme.com").`;
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
  if (/^((urn|hrn):)?loc:/i.test(input)) {
    throw new UrnParseError(input, 'loc-segment-rejected');
  }

  const prefixMatch = input.match(/^(hrn|urn):([a-z][a-z0-9-]*):(.+)$/);
  if (!prefixMatch) {
    throw new UrnParseError(input, 'malformed-grammar');
  }
  const legacySchemeUsed = prefixMatch[1] === LEGACY_SCHEME;

  const type = prefixMatch[2];
  if (!URN_TYPE_SET.has(type)) {
    throw new UrnParseError(input, 'unknown-type');
  }

  const path = prefixMatch[3];

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

  // Issue #239: legacy `urn:` scheme normalizes to canonical `hrn:`.
  // Tracked as a rewrite category so canonical-form-logger observability
  // covers legacy-scheme usage, even though `urn:` is accepted forever.
  if (legacySchemeUsed) {
    parserRewrites.push('legacy-urn-scheme');
  }

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

  const parserCanonical = `${CANONICAL_SCHEME}:${type}:${cat1Segments.join('::')}`;

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
 * Deliberately case-LENIENT (the charset allows `A-Z`): this runs on the
 * read/parse path, so tightening it to lowercase-only would make any existing
 * uppercase URN fail to resolve. The lowercase-only rule (#575) is enforced at
 * the CREATE/RENAME boundary in `validateUserSlug` instead — do not move it here.
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
 *
 * #575: a NEW slug must also be **lowercase**. URN lookups are case-sensitive
 * (`normalizeUrnForLookup` collapses `::`→`:` but does NOT lowercase), so an
 * uppercase slug would make `Acme` and `acme` distinct entities and force
 * callers to remember exact casing. This is a CREATE/RENAME-only rule — the
 * parse path (`validateAtomShape` / `validatePathSegment`) stays case-lenient
 * so any pre-existing uppercase URN still resolves (Postel's law; mirrors the
 * reserved-word split, where parse is lenient and create is strict).
 */
export function validateUserSlug(slug: string): void {
  // At entity-create time the "input" being validated IS the slug; pass
  // it as both `input` and `offendingSegment` so error.input has the slug
  // for callers logging the create attempt.
  validateAtomShape(slug, slug);
  // Reserved-word check first (case-insensitive), so a reserved word like
  // `Agent` still reports `reserved-word-slug` rather than the case error.
  if (RESERVED_SLUGS.has(slug.toLowerCase())) {
    throw new UrnParseError(slug, 'reserved-word-slug', slug);
  }
  // #575 — lowercase-canonical. validateAtomShape's charset is deliberately
  // case-lenient (read path); enforce the case rule only here, at create/rename.
  if (/[A-Z]/.test(slug)) {
    throw new UrnParseError(slug, 'slug-not-lowercase', slug);
  }
}

/**
 * Validate an organization slug at create / rename boundaries (#376).
 *
 * `Organization.urn` stores the BARE slug (`acme.com`, `personal-holger`).
 * `propagateOrgUrnRename` relies on the invariant that an org URN never itself
 * contains a `:`, so `<orgUrn>:` is an unambiguous prefix boundary on every
 * denormalized child Memory/Agent/App URN. A scheme-prefixed or
 * colon-containing value — e.g. the canonical `hrn:org:<slug>` that the
 * `Organization.urn` field resolver EMITS on read — would cascade a corrupt
 * prefix into every child URN. Reject it up front (with a precise message
 * pointing at the read/write asymmetry that caused hadron-portal#394) rather
 * than 500 from downstream URN composition.
 *
 * Layered on `validateUserSlug`: a leading `:` / scheme prefix is reported
 * with the org-specific `org-urn-not-bare` message; everything else
 * (charset, length, reserved words) reuses the shared slug rules.
 */
export function validateOrgSlug(slug: string): void {
  if (hasSchemePrefix(slug) || slug.includes(':')) {
    throw new UrnParseError(slug, 'org-urn-not-bare', slug);
  }
  validateUserSlug(slug);
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
  const isNodeUrn = NODE_URN_TYPES.has(urnType);
  const lastIdx = segments.length - 1;
  const out = segments.map((segment, i) => {
    // Index 0 is the org segment — it can NEVER carry a type marker
    // (the type is already in the URN's `urn:<type>:` prefix). Skipping
    // here prevents malformed inputs like `urn:agent:app:org::slug` from
    // being silently canonicalized to `urn:agent:org::slug` (Copilot
    // review on hadron-client PR #9). The first segment must reach
    // `rejectInvalidSegmentShapes` un-stripped so the
    // first-segment-must-be-one-atom rule actually fires for malformed
    // inputs.
    if (i === 0) return segment;
    // The leaf segment of a node URN is the node loc — free-form intra-
    // memory path. NEVER strip there; a node loc that begins with `app:`
    // or `agent:` is a legitimate user path, not a type marker.
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
// Install-URN composition — spec 021 D10 (R2) / FR-008 / FR-009 / US1
//
// When an Agent is installed into an org (the data model's `App` is the
// install primitive), the install gets an R2 canonical URN that embeds
// the author-org as a sub-path of the installed URN:
//
//   urn:agent:<installing-org>::<app-slug>::<author-org>:<agent-slug>
//
// Two orgs installing same-slug agents from different authors produce
// distinct URNs that differ at the author-org segment.
// ============================================================================

/**
 * Compose the R2 canonical install URN for an Agent installed in an App.
 *
 * Inputs MUST be 2-segment URNs (org + slug each) — the only shape the
 * current data model produces. Multi-segment inputs are rejected
 * deliberately: the FR-009 install form expects single-segment app and
 * agent slots, and tolerating multi-segment inputs would silently emit
 * a non-canonical URN whose shape doesn't match the contract in
 * GraphQL's `App.installedAgentUrn` docstring.
 *
 * Tolerant of grammar shape during the spec-021 migration window:
 *   - `appUrn` may be `urn:app:<org>::<slug>` (spec-021 canonical),
 *     `urn:app:<org>:<slug>` (legacy with `urn:app:` prefix), or
 *     `<org>:<slug>` (legacy bare slug-path).
 *   - `agentUrn` may be `urn:agent:<author-org>::<slug>` (spec-021
 *     canonical), `urn:agent:<author-org>:<slug>` (legacy with prefix),
 *     or `<author-org>:<slug>` (legacy bare).
 *
 * Output is the canonical install URN after parser-layer rewrites
 * (D11 cats 1, 4 applied — e.g., install-by-self collapses when the
 * installing org equals the author org).
 *
 * Throws if either input is empty, has the wrong type prefix, or
 * doesn't have exactly 2 segments (one org, one slug).
 */
export function composeInstalledAgentUrn(appUrn: string, agentUrn: string): string {
  const appPath = stripPrefixOrThrow(appUrn, 'app');
  const agentPath = stripPrefixOrThrow(agentUrn, 'agent');

  const appSegments = splitMixedGrammar(appPath);
  const agentSegments = splitMixedGrammar(agentPath);

  if (appSegments.length !== 2) {
    throw new Error(
      `composeInstalledAgentUrn: appUrn must have exactly <org>::<slug> shape (2 segments); got "${appUrn}" (${appSegments.length} segments)`,
    );
  }
  if (agentSegments.length !== 2) {
    throw new Error(
      `composeInstalledAgentUrn: agentUrn must have exactly <author-org>::<slug> shape (2 segments); got "${agentUrn}" (${agentSegments.length} segments)`,
    );
  }

  // R2 shape per FR-009: installing-org / app-slug / author-org:agent-slug.
  // The author-org and agent-slug are joined into a SINGLE path-segment
  // by `:` so the canonical author URN's path (`<author-org>:<agent-slug>`)
  // appears verbatim as a sub-path of the installed URN.
  const [installingOrg, appSlug] = appSegments;
  const [authorOrg, agentSlug] = agentSegments;

  const raw = `hrn:agent:${installingOrg}::${appSlug}::${authorOrg}:${agentSlug}`;

  // Run the parser to apply D11 cats 1 + 4 canonicalization. If the
  // installing org equals the author org (install-by-self), cat 1
  // collapses the duplicated org segment.
  return toParserCanonical(raw);
}

/** Strip `hrn:<expected>:` / `urn:<expected>:` prefix if present; reject wrong-type prefixes. */
function stripPrefixOrThrow(urn: string, expectedType: 'app' | 'agent'): string {
  if (!urn) {
    throw new Error(`composeInstalledAgentUrn: ${expectedType} URN is empty`);
  }
  const normalized = normalizeScheme(urn);
  if (normalized.startsWith(`hrn:${expectedType}:`)) {
    return normalized.slice(`hrn:${expectedType}:`.length);
  }
  if (hasSchemePrefix(urn)) {
    throw new Error(
      `composeInstalledAgentUrn: expected hrn:${expectedType}: prefix; got "${urn}"`,
    );
  }
  return urn;
}

/**
 * Split a slug-path on `::` if present, else on `:`. Bridges the spec-021
 * canonical grammar (`::`-separated) and the legacy single-`:` grammar
 * during the migration window. Output is always a list of path-segments.
 *
 * Legacy `org:slug` → ['org', 'slug']
 * Canonical `org::slug` → ['org', 'slug']
 * Canonical `org::app-slug::author:agent` → ['org', 'app-slug', 'author:agent']
 */
function splitMixedGrammar(path: string): string[] {
  if (path.includes('::')) return path.split('::');
  return path.split(':');
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
    // Scheme-tolerant compare (issue #239): rows written before the hrn:
    // cut-over store the legacy `urn:` scheme; that is NOT canonical-form
    // drift. Any other mismatch still surfaces immediately.
    if (parsed.parserCanonical !== normalizeScheme(row.urn)) {
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

/** Legacy types accepted by `parseUrnInput`. Pre-021 (+ `user`, spec cor:urn:010:01; + `edge`, spec 037 / #473). */
const LEGACY_URN_TYPES = ['org', 'memory', 'agent', 'app', 'node', 'edge', 'user'] as const;
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
  const match = input.match(/^(?:hrn|urn):(org|memory|agent|app|node|edge|user):(.+)$/);
  if (match) return { type: match[1] as LegacyUrnType, value: match[2] };
  const locMatch = input.match(/^loc:(.+)$/);
  if (locMatch) return { type: 'loc', value: locMatch[1] };
  return { type: 'unknown', value: input };
}

/** Format a bare value as a typed URN string for display/output. */
export function formatUrn(type: string, value: string): string {
  return `${CANONICAL_SCHEME}:${type}:${value}`;
}

/**
 * Compose and canonicalize a full URN from an entity type and a bare-stored
 * value. The bare value is whatever the entity's `urn` column persists —
 * single-colon hierarchy (legacy / pre-migration rows) or canonical `::`
 * hierarchy (post-migration rows). The output is always the spec-021
 * canonical-form URN with the `urn:<type>:` prefix.
 *
 * Use this from MCP output paths (and any other surface that emits URNs to
 * external consumers) instead of `formatUrn`, which is a dumb prepender
 * that preserves whatever hierarchy shape the stored value already had.
 *
 * Pre-migration bare values (e.g. `acme.com:dev`) are accepted and
 * canonicalized; post-migration bare values (e.g. `acme.com::dev`) pass
 * through unchanged. R2 install URNs round-trip without corruption — the
 * author-segment `:` is preserved inside the R2-embedded path-segment.
 *
 * Spec: 027-mcp-urn-canonical-form / contracts/canonical-urn-output.md §1.
 *
 * @throws UrnParseError with reason `empty-bare-value` if `bareValue` is
 *   empty or whitespace-only.
 * @throws UrnParseError with reason `already-prefixed-bare-value` if
 *   `bareValue` starts with `urn:` (the wrapper composes its own prefix).
 * @throws UrnParseError from `parseUrn(...)` for any acceptance violation
 *   per spec 021 (D1 registry, D2 grammar, D9 slug rules, D8 `loc:`
 *   deprecation).
 */
export function formatCanonicalUrn(
  type: CanonicalUrnType,
  bareValue: string,
): string {
  if (bareValue == null || bareValue.trim().length === 0) {
    throw new UrnParseError('', 'empty-bare-value');
  }
  if (hasSchemePrefix(bareValue)) {
    throw new UrnParseError(bareValue, 'already-prefixed-bare-value', bareValue);
  }
  // Promote legacy single-colon hierarchy to canonical `::` separators
  // (e.g. `acme.com:dev` → `acme.com::dev`) so the strict spec-021 parser
  // accepts pre-migration bare values. We only rewrite when the input
  // contains NO `::` at all — once any canonical separator is present,
  // the remaining single colons are intentional (e.g. R2 install URNs
  // carry an inner `:` inside the author segment:
  // `<install-org>::<app>::<author-org>:<agent-slug>`).
  const normalized = bareValue.includes('::')
    ? bareValue
    : bareValue.split(':').join('::');
  return toParserCanonical(`${CANONICAL_SCHEME}:${type}:${normalized}`);
}

/**
 * Build a canonical `hrn:node:<mem>::<loc>` URN from a memory URN + a node loc.
 *
 * Spec 027: produce a canonical-form node URN regardless of how `Memory.urn`
 * is stored (legacy `acme.com:dev` or canonical `acme.com::dev`). Canonicalize
 * the memory URN first to a known-shape bare form, then attach `loc` as the
 * node's single leaf path-segment with `::` — so `loc` (e.g. `review:sort`)
 * stays one multi-atom leaf rather than being re-split into hierarchy levels.
 *
 * Shared by the MCP `nodeUrn` helper and the global-search node adapter so the
 * two surfaces can't drift on node-URN shape.
 */
export function composeNodeUrn(memUrn: string, loc: string): string {
  return composeMemoryScopedUrn('node', memUrn, loc);
}

/**
 * Build a canonical `hrn:edge:<mem>::<loc>` URN from a memory URN + an edge
 * loc. Spec 037: edges are first-class, addressable peers of nodes — same
 * memory-scoped, loc-addressed shape, distinguished only by the `edge` type
 * word. The edge's memory is its SOURCE node's memory.
 */
export function composeEdgeUrn(memUrn: string, loc: string): string {
  return composeMemoryScopedUrn('edge', memUrn, loc);
}

/**
 * Shared core of {@link composeNodeUrn} / {@link composeEdgeUrn}: canonicalize
 * the memory URN to a known-shape bare form, then attach `loc` as a single
 * leaf path-segment with `::` so a multi-atom loc (e.g. `review:sort`) stays
 * one leaf rather than being re-split into hierarchy levels.
 */
function composeMemoryScopedUrn(type: 'node' | 'edge', memUrn: string, loc: string): string {
  const memCanonical = formatCanonicalUrn('memory', memUrn);
  const bareMemCanonical = memCanonical.substring(`${CANONICAL_SCHEME}:memory:`.length);
  return `${CANONICAL_SCHEME}:${type}:${bareMemCanonical}::${loc}`;
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
  return `Expected ${expected} URN (hrn:${expected}:...), got hrn:${parsed.type}:...`;
}
