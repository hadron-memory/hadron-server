/**
 * Local-alias slug minting at materialization sites (issue #695,
 * D-2026-07-15-004).
 *
 * When a foreign-rooted resource is **materialized under a local root** (a
 * clone, an install that actually copies, a runtime `(app,user)` provision, or
 * the `mergeUsers` bulk re-own), the local URN needs a slug that is unique
 * *within that root's `(root, type)` namespace* (v2 flat grammar: slugs are
 * unique per root+type, so `<root>:<slug>` must not already exist). This is the
 * one shared primitive for that: keep the desired slug when the composed URN is
 * free, and on collision fall back to a **deterministic, author-derived**
 * disambiguator — never a random token, and never the foreign slug adopted
 * verbatim.
 *
 * Why author-derived, not random (contrast {@link generateUniqueHandle}): a
 * handle's random suffix defends against an enumeration oracle (signup order /
 * user count). A resource slug leaks no such count, so determinism is preferred
 * — the same author materialized twice under the same root yields a stable,
 * predictable alias (`notes-acme.com`), and the numeric tail only advances on a
 * genuine repeat collision. The 64-char atom cap is honored by truncating the
 * **stem** (never the disambiguating suffix), mirroring the handle generator.
 *
 * Pure by design — the caller supplies an `isTaken(urn)` probe (the right table
 * + liveness predicate for the entity), so the helper is DB-agnostic and unit
 * testable, and every callsite runs it inside its own transaction.
 */

import { deriveSlugFromName } from './urn.js';

/** URN-atom cap (spec cor:urn:010:01). Shared with the handle generator. */
const MAX_SLUG_LEN = 64;

/**
 * Longest author-derived disambiguator we splice in, so the stem always keeps
 * some readable prefix even under the 64-char cap. A long author root
 * (`code-generator-system-baragaun.com`) is truncated to this before use.
 */
const MAX_AUTHOR_STEM_LEN = 24;

export interface MintLocalSlugArgs {
  /**
   * The local root the resource materializes under, WITHOUT the trailing colon
   * — e.g. `@holger` (a user handle) or `acme.com` (an org name). The composed
   * URN is `<root>:<slug>`.
   */
  root: string;
  /** The slug to keep when the composed URN is free (the source/foreign slug). */
  desiredSlug: string;
  /**
   * The foreign author's root (`@code-generator-system` / `acme.com`), used to
   * derive the deterministic disambiguator on collision. Its `@` prefix (if
   * any) and out-of-charset runs are sanitized away.
   */
  authorRoot: string;
  /**
   * True when `<root>:<slug>` is already claimed by a LIVE row of the target
   * entity (the caller picks the table + liveness predicate — `deletedAt IS
   * NULL`, or `uninstalled_at IS NULL` for App's partial-unique urn).
   */
  isTaken: (composedUrn: string) => Promise<boolean>;
}

export interface MintedSlug {
  /** The chosen slug — `desiredSlug` when free, else an author-derived alias. */
  slug: string;
  /** The composed `<root>:<slug>` URN, guaranteed free at mint time. */
  urn: string;
}

/**
 * Coerce an author root into a slug-atom-legal disambiguator fragment: strip a
 * leading `@`, slugify (lowercase, out-of-charset runs → `-`, trimmed to
 * start/end-alnum), and cap the stem so it can't consume the whole atom.
 */
function authorStem(authorRoot: string): string {
  const stripped = authorRoot.replace(/^@/, '');
  let stem: string;
  try {
    stem = deriveSlugFromName(stripped);
  } catch {
    // An author root with nothing slug-legal (all punctuation) — fall back to a
    // stable literal so the disambiguator is still deterministic and non-empty.
    stem = 'x';
  }
  return stem.slice(0, MAX_AUTHOR_STEM_LEN).replace(/[._-]+$/g, '') || 'x';
}

/**
 * Truncate a slug to the 64-char atom cap, trimming any separator the slice
 * exposes so the atom still ends alphanumeric. A no-op for the common ≤64 input
 * (a slug lifted from an existing URN); the guard is for the clone / provision
 * callers the module doc advertises, which may hand in a longer desired slug.
 */
function capAtom(slug: string): string {
  if (slug.length <= MAX_SLUG_LEN) return slug;
  return slug.slice(0, MAX_SLUG_LEN).replace(/[._-]+$/g, '') || slug.slice(0, 1);
}

/**
 * Join a stem and a disambiguating suffix under the 64-char atom cap by
 * truncating the STEM (keeping the suffix intact so the disambiguation
 * survives), and re-trim any separator the slice exposed so the atom still
 * ends alphanumeric.
 */
function capJoin(stem: string, suffix: string): string {
  const joined = `${stem}-${suffix}`;
  if (joined.length <= MAX_SLUG_LEN) return joined;
  const room = Math.max(1, MAX_SLUG_LEN - suffix.length - 1); // -1 for the '-'
  const truncatedStem = stem.slice(0, room).replace(/[._-]+$/g, '') || stem.slice(0, 1);
  return `${truncatedStem}-${suffix}`;
}

/**
 * Mint a collision-free slug under `root`. Returns the desired slug (and its
 * composed URN) when free; otherwise a deterministic, author-derived alias
 * (`<stem>-<author>`, then `<stem>-<author>-2`, `-3`, … on repeat collision).
 * Throws only if 100 author-derived candidates are all taken (effectively
 * impossible — the caller's DB unique remains the atomic backstop).
 */
export async function mintLocalSlug(args: MintLocalSlugArgs): Promise<MintedSlug> {
  const desiredSlug = capAtom(args.desiredSlug);
  const compose = (slug: string): string => `${args.root}:${slug}`;

  // 1. Keep the desired slug when the composed URN is free — stable URNs are
  //    the whole point; only a genuine clash triggers an alias.
  if (!(await args.isTaken(compose(desiredSlug)))) {
    return { slug: desiredSlug, urn: compose(desiredSlug) };
  }

  // 2. Collision → deterministic, author-derived alias (never random, never the
  //    foreign slug verbatim). The numeric tail advances only on repeat clashes.
  const stem = authorStem(args.authorRoot);
  for (let n = 0; n < 100; n++) {
    const suffix = n === 0 ? stem : `${stem}-${n + 1}`;
    const slug = capJoin(desiredSlug, suffix);
    if (!(await args.isTaken(compose(slug)))) {
      return { slug, urn: compose(slug) };
    }
  }
  throw new Error(
    `mintLocalSlug: could not find a free slug for "${args.desiredSlug}" under "${args.root}"`,
  );
}
