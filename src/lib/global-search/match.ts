/**
 * Matching + scoring helpers shared by the per-entity adapters.
 *
 * Tiered relevance: exact (3) > prefix (2) > substring (1), weighted per field
 * so a URN/name/PK hit outranks a description/content hit of the same tier.
 * Ranking is intentionally simple — cross-entity semantic ranking is out of
 * scope (that's `nodeSearch`/`hadron_find_nodes`' job).
 */

import { formatCanonicalUrn } from '../urn.js';
import type { SearchField } from './types.js';

// Node-URN composition is shared with mcp/server.ts via src/lib/urn.ts so the
// two surfaces can't drift on node-URN shape.
export { composeNodeUrn } from '../urn.js';

export const FIELD_WEIGHT: Record<SearchField, number> = {
  pk: 1.0,
  urn: 1.0,
  name: 0.9,
  description: 0.5,
  content: 0.4,
};

/**
 * 0 = no match, 1 = substring, 2 = prefix, 3 = exact (case-insensitive).
 * `needle` MUST already be trimmed + lowercased — `matchTier` runs per
 * candidate per row, so callers normalize the query once outside the loop.
 */
export function matchTier(value: string | null | undefined, needle: string): 0 | 1 | 2 | 3 {
  if (!value) return 0;
  if (needle.length === 0) return 0;
  const v = value.toLowerCase();
  if (v === needle) return 3;
  if (v.startsWith(needle)) return 2;
  if (v.includes(needle)) return 1;
  return 0;
}

/** Collapse runs of `:` to a single `:` for separator-agnostic URN compare. */
function singleColon(s: string): string {
  return s.replace(/:+/g, ':');
}

/**
 * URN match tier that ignores `::` vs `:` separator style, so a canonical
 * query matches a legacy single-colon stored URN and vice-versa.
 */
export function urnMatchTier(storedUrn: string | null | undefined, urnTerm: string): 0 | 1 | 2 | 3 {
  if (!storedUrn) return 0;
  return matchTier(singleColon(storedUrn), singleColon(urnTerm).toLowerCase());
}

/**
 * Separator variants of a URN term for the SQL pre-filter (broad), refined by
 * `urnMatchTier` in JS. Covers raw, single-colon, and double-colon stored forms.
 */
export function urnSearchVariants(urnTerm: string): string[] {
  const single = singleColon(urnTerm);
  const double = single.split(':').join('::');
  return [...new Set([urnTerm, single, double])];
}

/** Canonical prefixed URN for a stored bare URN (org/memory/agent/app). */
export function canonicalUrn(
  type: 'org' | 'memory' | 'agent' | 'app',
  bareUrn: string,
): string {
  try {
    return formatCanonicalUrn(type, bareUrn);
  } catch {
    return bareUrn;
  }
}

export interface FieldCandidate {
  field: SearchField;
  /** The raw stored value (null skips the field). */
  value: string | null | undefined;
  /** Override the tier computation (used by `pk` exact + `urn` separator-agnostic). */
  tier?: 0 | 1 | 2 | 3;
}

/**
 * Pick the best-scoring field among the candidates that the caller actually
 * searched. Returns null when nothing matched.
 */
export function bestMatch(
  candidates: FieldCandidate[],
  query: string,
  searched: Set<SearchField>,
): { field: SearchField; score: number } | null {
  let best: { field: SearchField; score: number } | null = null;
  // Normalize the query once — matchTier expects a pre-lowercased needle.
  const needle = query.trim().toLowerCase();
  for (const c of candidates) {
    if (!searched.has(c.field)) continue;
    const tier = c.tier !== undefined ? c.tier : matchTier(c.value, needle);
    if (tier === 0) continue;
    const score = tier * FIELD_WEIGHT[c.field];
    if (!best || score > best.score) best = { field: c.field, score };
  }
  return best;
}
