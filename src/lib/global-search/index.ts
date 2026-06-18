/**
 * Global search engine — cross-entity search shared by the GraphQL
 * `globalSearch` query and the MCP `h-search` tool.
 *
 * Flow: classify the query (smart-sniff unless explicit `fields`) → run the
 * selected per-entity adapters concurrently (each applies its own access
 * scope) → merge into one ranked, flat list → cap at `limit`.
 *
 * Spec: cor:api:050 (feature) · cor:api:050:01 (field-sniff) · cor:api:050:02 (scope/access)
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Candidate rows fetched per entity before scoring (≥ limit so ranking is fair). */
const PER_ENTITY_CAP = 100;
/** Defensive cap on query length before it flows into substring filters. */
const MAX_QUERY_LEN = 512;

export async function globalSearch(
  db: PrismaClient,
  params: GlobalSearchParams,
  principal: SearchPrincipal,
): Promise<GlobalSearchResult> {
  const degraded: string[] = [];
  const q = (params.query ?? '').trim().slice(0, MAX_QUERY_LEN);
  if (q === '') return { hits: [], degraded };

  const { fields } = classifyQuery(q, params.fields);
  const fieldSet = new Set(fields);
  const urnTerm = urnSearchTerm(q);

  const types =
    params.entityTypes && params.entityTypes.length > 0
      ? // dedupe so a repeated type can't run its adapter twice (→ duplicate hits)
        [...new Set(params.entityTypes)].filter((t) => ALL_ENTITY_TYPES.includes(t))
      : [...ALL_ENTITY_TYPES];

  const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));

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
      a.entityType.localeCompare(b.entityType),
  );

  return { hits: hits.slice(0, limit), degraded };
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
