/**
 * cor:acl:080:02/04 — row → sanitized `PublicResourceRef` mappers, shared by the
 * `PublicOrganization` field resolvers and the marketplace catalogue queries.
 * A ref carries only safe display identity ({id, name, urn, description}); it
 * never traverses to members / private data / credentials.
 */
import { safeCanonicalUrn } from './resolvers.helpers.js';
import { legacyMemoryUrnToCanonical } from '../../../lib/urn.js';

export interface PublicRef {
  id: string;
  name: string;
  urn: string;
  description: string | null;
}

/** Organization → ref (no description column; null). */
export function orgRowToRef(o: { id: string; name: string; urn: string }): PublicRef {
  return { id: o.id, name: o.name, urn: safeCanonicalUrn('org', o.urn), description: null };
}

/** Memory → ref (shortDescription → description; canonicalize the memory URN). */
export function memoryRowToRef(m: {
  id: string;
  name: string;
  urn: string;
  shortDescription: string | null;
}): PublicRef {
  return {
    id: m.id,
    name: m.name,
    urn: m.urn.includes('::')
      ? safeCanonicalUrn('memory', m.urn)
      : safeCanonicalUrn('memory', legacyMemoryUrnToCanonical(m.urn)),
    description: m.shortDescription ?? null,
  };
}

/** Agent → ref. */
export function agentRowToRef(a: {
  id: string;
  name: string;
  urn: string;
  description: string | null;
}): PublicRef {
  return { id: a.id, name: a.name, urn: safeCanonicalUrn('agent', a.urn), description: a.description ?? null };
}
