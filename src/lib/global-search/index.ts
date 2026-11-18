/**
 * Global search engine — cross-entity search shared by the GraphQL
 * `globalSearch` query and the MCP `hadron_search` tool.
 *
 * Flow: classify the query (smart-sniff unless explicit `fields`) → run the
 * selected per-entity adapters concurrently (each applies its own access
 * scope) → merge into one ranked, flat list → slice to the requested page.
 *
 * Pagination (issue #465) is a BOUNDED contract: each adapter fetches at most
 * `PER_ENTITY_CAP` candidates before JS scoring, so `total` is the ranked-match
 * count within that bound, not an unbounded COUNT. Scoring happens in JS after
 * the capped SQL fetch, so a SQL COUNT could not reproduce the post-scoring hit
 * count — an accurate deep-paging `total` would require pushing scoring into
 * SQL across every adapter. The cap is sized so the common case (an extension
 * Find tab) pages truthfully; extreme result sets under-count, by design.
 *
 * Spec: cor:api:050 (feature) · cor:api:050:01 (field-sniff) · cor:api:050:02 (scope/access) · cor:api:050:03 (bounded pagination)
 */

import { classifyQuery, urnSearchTerm } from './classify.js';
import { ADAPTERS, type AdapterCtx } from './entities.js';
import {
  ALL_ENTITY_TYPES,
  type GlobalSearchHit,
  type GlobalSearchParams,
  type GlobalSearchResult,
  type SearchPrincipal,
} from './types.js';
import type { PrismaClient } from '../../generated/prisma/index.js';

export const GLOBAL_SEARCH_DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
/**
 * Candidate rows fetched per entity before JS scoring. Also the ceiling on the
 * per-entity contribution to `total` (issue #465 bounded contract): the merged
 * `total` can be at most `PER_ENTITY_CAP × entityTypes`. Raised from 100 to 200
 * so a paged Find surface (limit ≤ MAX_LIMIT = 200) can walk a full page of a
 * single dominant entity type without the bound truncating mid-page.
 */
const PER_ENTITY_CAP = 200;
/** Defensive cap on query length before it flows into substring filters. */
const MAX_QUERY_LEN = 512;

export async function globalSearch(
  db: PrismaClient,
  params: GlobalSearchParams,
  principal: SearchPrincipal,
): Promise<GlobalSearchResult> {
  const degraded: string[] = [];
  const q = (params.query ?? '').trim().slice(0, MAX_QUERY_LEN);
  if (q === '') return { hits: [], total: 0, degraded };

  const { fields } = classifyQuery(q, params.fields);
  const fieldSet = new Set(fields);
  const urnTerm = urnSearchTerm(q);

  const types =
    params.entityTypes && params.entityTypes.length > 0
      ? // dedupe so a repeated type can't run its adapter twice (→ duplicate hits)
        [...new Set(params.entityTypes)].filter((t) => ALL_ENTITY_TYPES.includes(t))
      : [...ALL_ENTITY_TYPES];

  const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? GLOBAL_SEARCH_DEFAULT_LIMIT));
  const offset = Math.max(0, params.offset ?? 0);

  const ctx: AdapterCtx = {
    db,
    principal,
    q,
    urnTerm,
    fields: fieldSet,
    cap: PER_ENTITY_CAP,
    degraded,
  };

  const perType = await Promise.all(types.map((t) => ADAPTERS[t](ctx)));
  const hits: GlobalSearchHit[] = perType.flat();

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.name ?? a.urn ?? a.id).localeCompare(b.name ?? b.urn ?? b.id) ||
      a.entityType.localeCompare(b.entityType) ||
      // Final tiebreak on the unique id → a TOTAL order. Without it, two hits
      // with equal score+name+entityType keep their input order, which is the
      // DB's (unordered) candidate-fetch order and can differ between the page-1
      // and page-2 requests — a row could appear on both pages or be skipped.
      a.id.localeCompare(b.id),
  );

  // `total` is the full ranked list length. Page = a slice of this fully-ordered
  // list; the id tiebreak above makes paging stable WITHIN the per-entity
  // candidate bound. NOTE (issue #465): when a type has more than PER_ENTITY_CAP
  // matches, WHICH candidates are fetched is itself bounded/approximate (they're
  // capped before scoring), so `total` and deep pages past the bound are not
  // exact — the documented bounded-search contract.
  return { hits: hits.slice(offset, offset + limit), total: hits.length, degraded };
}

export type {
  GlobalSearchHit,
  GlobalSearchParams,
  GlobalSearchResult,
  SearchEntityType,
  SearchField,
  SearchPrincipal,
} from './types.js';
export { ALL_ENTITY_TYPES, ALL_FIELDS, normalizeEntityTypes, normalizeFields } from './types.js';
export { classifyQuery, looksLikeUrn, urnSearchTerm } from './classify.js';
