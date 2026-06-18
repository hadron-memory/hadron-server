/**
 * Smart-sniff: classify a raw query into the field(s) to search when the caller
 * gives no explicit `fields`. Explicit fields always override the sniff.
 *
 * Precedence (most specific first):
 *   1. PK-shaped (`isId`: cuid `c…` 25-char or 32-hex UUIDv7) → exact id match.
 *   2. URN-shaped (`hrn:`/`urn:` prefix, or `::`, or a colon with no whitespace
 *      — i.e. a bare `<org>:<slug>` URN) → urn substring.
 *   3. Otherwise (free text) → name + urn substring. (PK can't match free text
 *      via exact lookup, so this realises the stated "URN, PK, name" default.)
 *
 * Spec: cor:api:050:01
 */

import { isId } from '../entityRef/shape.js';
import { hasSchemePrefix, parseUrnInput } from '../urn.js';
import type { SearchField } from './types.js';

export type SniffMode = 'explicit' | 'pk' | 'urn' | 'text';

export interface QueryClassification {
  fields: SearchField[];
  sniff: SniffMode;
}

/** Heuristic: does this look like a URN (vs a free-text name) for SEARCH? */
export function looksLikeUrn(query: string): boolean {
  const q = query.trim();
  if (q.length === 0) return false;
  if (hasSchemePrefix(q)) return true; // hrn:/urn: prefix
  if (q.includes('::')) return true; // canonical separator
  // Bare URN like "micromentor.org:juno" — a colon with no whitespace. Free
  // text with a colon (e.g. "note: follow up") contains whitespace and is
  // treated as a name search.
  if (q.includes(':') && !/\s/.test(q)) return true;
  return false;
}

/**
 * The bare URN term to substring-match against stored `urn` columns: strips a
 * known `hrn:<type>:` / `urn:<type>:` scheme prefix so "hrn:agent:acme.com:x"
 * matches the stored "acme.com:x".
 */
export function urnSearchTerm(query: string): string {
  return parseUrnInput(query.trim()).value;
}

export function classifyQuery(
  query: string,
  explicitFields?: SearchField[] | null,
): QueryClassification {
  if (explicitFields && explicitFields.length > 0) {
    return { fields: [...new Set(explicitFields)], sniff: 'explicit' };
  }
  const q = query.trim();
  if (isId(q)) return { fields: ['pk'], sniff: 'pk' };
  if (looksLikeUrn(q)) return { fields: ['urn'], sniff: 'urn' };
  return { fields: ['name', 'urn'], sniff: 'text' };
}
