/**
 * Shape detector for the entity-reference convention (spec 007).
 *
 * URNs always contain at least one `:` by construction (e.g.
 * "org-foo:family-mealplan"). UUIDv7 IDs are 32 hex chars and
 * never contain `:`. The shapes are disjoint.
 *
 * After upstream prefix-normalization (see `parseUrnInput` in
 * `src/lib/urn.ts`), the colon-presence check unambiguously
 * dispatches between URN and ID lookup.
 */

export function isUrn(ref: string): boolean {
  return ref.includes(':');
}
