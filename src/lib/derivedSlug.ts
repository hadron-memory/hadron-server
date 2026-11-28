// #5203 S3 — a slug DERIVED from a name never refuses the entity's creation; it iterates
// (hrn:node:hadronmemory.com:specs:cor:urn:010:01, Durable; the suffix spelling is Tunable).
//
// One rule for every creation door that derives a slug from a display name (memory, agent, clone, App):
//
// - the base is the slugified name, or a fallback base when nothing in the charset survives (`!!!`, `:`, `éé`);
// - a candidate that is a reserved word (matched case-insensitively, as `validateUserSlug` does) is skipped;
// - a candidate held by ANY row (live or soft-deleted) is skipped: a derived slug never reclaims a deleted holder,
//   which keeps that entity restorable (gate answers on #5203, section 3);
// - candidates are `base`, `base-2`, `base-3`, … (the worker and ticker spelling, {@link derivedSlugCandidate}).
//
// A slug the caller SUPPLIES is not derived and does not come through here: it is validated and refused when reserved
// or taken, with each door's own answer. The NAME is judged before deriving (empty, blank or unstorable is refused
// by the door, as an invalid name).

import { deriveSlugFromName, MAX_ATOM_LEN, RESERVED_SLUGS, UrnParseError } from './urn.js';

/** The base for a name that yields no slug. Not a reserved word, so it is kept when free. */
export const DERIVED_SLUG_FALLBACK = 'untitled';

/** True when `slug` is a reserved word (FR-019), matched case-insensitively as at every create boundary. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

/** The slugified name, or `fallback` when the name yields no slug. Pure; no reserved-word or uniqueness rule applied. */
export function derivedSlugBase(name: string, fallback: string = DERIVED_SLUG_FALLBACK): string {
  try {
    return deriveSlugFromName(name);
  } catch (err) {
    if (!(err instanceof UrnParseError)) throw err;
    return fallback; // `empty-derived-slug`: nothing in the charset survived.
  }
}

/**
 * The `n`th candidate for `base` (1-indexed: n=1 IS the bare base). The suffix is applied with room-trimming so the
 * result never exceeds the 64-char atom cap, and a separator the trim exposes is dropped so the atom still ends
 * alphanumeric. Moved here from `workerSlug.ts` (#991), which re-exports it as `workerSlugCandidate`.
 */
export function derivedSlugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  const room = MAX_ATOM_LEN - suffix.length;
  const trimmed = base.length > room ? base.slice(0, room).replace(/[._-]+$/g, '') : base;
  return `${trimmed}${suffix}`;
}

/** Upper bound on candidates probed one by one; reaching it means the probe is broken, not that the namespace is full. */
const MAX_CANDIDATES = 1000;

/**
 * The first candidate for `base` that is not a reserved word and that `isTaken` reports free. Advisory: the
 * caller's unique index is what arbitrates a concurrent create.
 */
export async function nextFreeDerivedSlug(base: string, isTaken: (slug: string) => Promise<boolean>): Promise<string> {
  for (let n = 1; n <= MAX_CANDIDATES; n++) {
    const candidate = derivedSlugCandidate(base, n);
    if (isReservedSlug(candidate)) continue;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`nextFreeDerivedSlug: no free slug for "${base}" within ${MAX_CANDIDATES} candidates`);
}
