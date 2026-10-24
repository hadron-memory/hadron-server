/**
 * Types for the SDL-enumeration gate (#1103).
 *
 * The gate is a `.mjs` script to match its siblings in this directory and to
 * stay runnable by CI without a build step. Its predicate is unit-tested from
 * TypeScript, though, so the one exported function needs a declaration —
 * `// @ts-expect-error` at the import would have silenced any FUTURE type
 * error in that test too, which is the cheaper fix and the wrong one.
 */

/** One description that spells out part of a watched set. */
export interface PartialEnumeration {
  /** Where a human should look, e.g. `Mutation.createConnectionGrant`. */
  coord: string;
  /** The watched set's exported name, e.g. `CONNECTION_GRANT_SCOPES`. */
  set: string;
  /** Members the description does spell out. */
  present: string[];
  /** Members it omits — what the author has to add, or stop enumerating. */
  missing: string[];
  /** The offending description, verbatim. */
  text: string;
}

/** A set this gate watches. `members` is imported from its source, never copied. */
export interface WatchedSet {
  name: string;
  source: string;
  members: readonly string[];
  /** Optional exact SDL coordinates; required for ordinary-word sets. */
  coordinates?: readonly string[];
  /** Optional first capture isolates a promised list from incidental examples. */
  enumerationPattern?: RegExp;
}

/**
 * Descriptions in `sdl` that spell out two or more members of a watched set
 * without spelling out all of them. Empty when the SDL is clean.
 */
export function findPartialEnumerations(
  sdl: string,
  sets?: readonly WatchedSet[],
): PartialEnumeration[];
