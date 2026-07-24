/**
 * Global search — shared types for the cross-entity search engine that backs
 * both the GraphQL `globalSearch` query and the MCP `hadron_search` tool.
 *
 * Lives in `src/lib/` with NO MCP / GraphQL deps (mirrors `src/lib/search.ts`)
 * so both consumers import from a leaf module. Each surface builds a
 * `SearchPrincipal` with its own access gate, then hands it to `globalSearch`.
 */

/** Entity types v1 global search can return. */
export const ALL_ENTITY_TYPES = [
  'organization',
  'memory',
  'node',
  'agent',
  'app',
  'aiServiceConfig',
  'user',
] as const;
export type SearchEntityType = (typeof ALL_ENTITY_TYPES)[number];

/** Fields a query can be matched against. */
export const ALL_FIELDS = ['urn', 'name', 'description', 'pk', 'content'] as const;
export type SearchField = (typeof ALL_FIELDS)[number];

/**
 * One unified, flat result. Common fields across every entity type so all
 * three surfaces render a single ranked list. `urn` is null for entities with
 * no URN (AiServiceConfig, User); `memoryId`/`organizationId` are convenience
 * handles for building canonical navigation paths without a second round-trip.
 */
export interface GlobalSearchHit {
  entityType: SearchEntityType;
  id: string;
  urn: string | null;
  name: string | null;
  description: string | null;
  matchedField: SearchField;
  score: number;
  memoryId: string | null;
  organizationId: string | null;
}

export interface GlobalSearchParams {
  query: string;
  /** Restrict to these entity types; null/empty = all. */
  entityTypes?: SearchEntityType[] | null;
  /** Restrict to these fields; null/empty = smart-sniff the query shape. */
  fields?: SearchField[] | null;
  limit?: number | null;
  /** Page offset into the fully-ranked (bounded) hit list. Default 0. */
  offset?: number | null;
}

export interface GlobalSearchResult {
  hits: GlobalSearchHit[];
  /**
   * Total ranked matches for the pager. BOUNDED: the count within the
   * per-entity candidate cap, not an unbounded COUNT (see index.ts
   * PER_ENTITY_CAP). Page slicing operates over this bounded list.
   */
  total: number;
  /** Human-readable notes when the search ran at reduced fidelity. */
  degraded: string[];
}

/**
 * The access context the engine needs, pre-resolved by each surface using its
 * own gate so the engine stays surface-agnostic.
 *
 * - `accessibleMemoryIds`: memory-id allow-list for the Memory + Node slices.
 *   `null` means "admin / unrestricted" — the engine then applies the
 *   owner-only personal/private carve-out itself (the MCP gate returns null for
 *   admin; the GraphQL gate returns an explicit carved-out list — both correct).
 * - `orgIds`: org-id allow-list for the Organization / Agent / App /
 *   AiServiceConfig slices. `null` means "admin / unrestricted". `[]` means no
 *   org access (App-Key callers and unauthenticated users).
 * - `viewerUserId`: the User principal; gates the User slice (parity with
 *   `searchUsers`, which requires an authenticated user) and the personal/
 *   private carve-out.
 */
export interface SearchPrincipal {
  viewerUserId: string | null;
  isPlatformAdmin: boolean;
  accessibleMemoryIds: string[] | null;
  orgIds: string[] | null;
  /**
   * The caller's OWN member org ids (admin or not); [] for App-Key /
   * unauthenticated. Unlike `orgIds`, never the null "unrestricted" sentinel.
   * (Spec 048 dropped `isVisible`, so the Organization slice's former hidden-org
   * carve-out is gone — an admin now sees every org; retained for callers/tests.)
   */
  viewerOrgIds: string[];
  /**
   * When set, narrow the search to a single organization: the Memory + Node
   * slices are additionally constrained to `memory.organizationId === orgScopeId`
   * (AND-ed onto the access scope, so it never widens access), and the caller
   * sets `orgIds: [orgScopeId]` to confine the org-rooted slices. Null/undefined
   * ⇒ the default cross-org union. Set by the GraphQL `globalSearch(orgId:)`
   * arg; the MCP surface leaves it unset. Membership is verified by the caller
   * before this is set — the engine trusts it as an already-authorized scope.
   */
  orgScopeId?: string | null;
}

/** Keep only valid `SearchEntityType` values (defensive: MCP bypasses zod). */
export function normalizeEntityTypes(input: unknown): SearchEntityType[] | null {
  if (!Array.isArray(input)) return null;
  const set = new Set<string>(ALL_ENTITY_TYPES);
  const out = input.filter((v): v is SearchEntityType => typeof v === 'string' && set.has(v));
  return out.length > 0 ? out : null;
}

/** Keep only valid `SearchField` values (defensive: MCP bypasses zod). */
export function normalizeFields(input: unknown): SearchField[] | null {
  if (!Array.isArray(input)) return null;
  const set = new Set<string>(ALL_FIELDS);
  const out = input.filter((v): v is SearchField => typeof v === 'string' && set.has(v));
  return out.length > 0 ? out : null;
}
