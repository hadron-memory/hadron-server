/**
 * Types for the post-push manifest loader (#434 slice B).
 *
 * A `.mjs` module so the CI filter, the regenerator and the test all load the
 * same code with plain `node` (see postPushInventory.d.mts for why the
 * declarations live beside it instead of `// @ts-expect-error` at the import).
 */

/** Drift-reason vocabulary a `diff-whitelist` row may carry. */
export type DiffWhitelistKind =
  | 'partial-index'
  | 'hnsw-index'
  | 'gin-index'
  | 'generated-column'
  | 'not-null-invariant'
  | 'foreign-key-constraint'
  | 'unique-index';

/** The `diff-whitelist` kind vocabulary, in order. */
export const DIFF_WHITELIST_KINDS: readonly DiffWhitelistKind[];

/** Object kinds a `post-push-owned` row may carry (mirrors the parser's kinds). */
export type PostPushOwnedKind =
  | 'extension'
  | 'index'
  | 'unique-index'
  | 'check-constraint'
  | 'foreign-key-constraint'
  | 'unique-constraint'
  | 'generated-column'
  | 'function'
  | 'trigger'
  | 'table'
  | 'sequence';

/** The `post-push-owned` kind vocabulary, in order. */
export const POST_PUSH_OWNED_KINDS: readonly PostPushOwnedKind[];

/** One whitelisted drift line: the exact `prisma migrate diff` line, and why it is acceptable. */
export interface DiffWhitelistRow {
  name: string;
  kind: DiffWhitelistKind;
  why: string;
  line: string;
}

/** One durable object the post-push closure owns (so `migrate diff` drift on it is expected). */
export interface PostPushOwnedRow {
  name: string;
  kind: PostPushOwnedKind;
  why: string;
  /** Where the object is created, when a single file names it. */
  file?: string;
}

/** A validated manifest. `raw` is the parsed JSON, shape only lightly checked. */
export interface Manifest {
  diffWhitelist: DiffWhitelistRow[];
  postPushOwned: PostPushOwnedRow[];
  raw: unknown;
}

/** Any manifest contract breach: unknown key/kind, missing `why`, duplicate line or identity. */
export class ManifestError extends Error {}

/**
 * Load and validate the manifest at `path`. Throws `ManifestError` with a
 * precise message on any contract breach — a whitelist that drifts silently
 * is the failure mode this slice exists to remove.
 */
export function loadManifest(path: string): Manifest;

/** The exact drift lines the filter may drop (identity is the full string). */
export function whitelistedLines(manifest: Manifest): Set<string>;
