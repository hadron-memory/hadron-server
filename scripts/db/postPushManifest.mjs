// Manifest loading + validation for prisma/post-push-manifest.json (#434 slice B).
//
// One module so the CI filter (migrateDiffFilter.mjs), the regenerator
// (gen-post-push-manifest.mjs) and the test (src/test/postPushManifest.test.ts)
// all enforce the same contract. Validation is deliberately unforgiving: an
// unknown key, an unknown kind, a missing `why`, or two rows claiming the same
// drift line is an error, not a warning — a whitelist that drifts silently is
// the failure mode this whole slice exists to remove.

import { readFileSync } from 'node:fs';

/** Kinds a diff-whitelist row may carry (the DRIFT REASON vocabulary). */
export const DIFF_WHITELIST_KINDS = [
  'partial-index',
  'hnsw-index',
  'gin-index',
  'generated-column',
  'not-null-invariant',
  'foreign-key-constraint',
  'unique-index',
];

/** Kinds a post-push-owned row may carry (must mirror OBJECT_KINDS in postPushInventory.mjs). */
export const POST_PUSH_OWNED_KINDS = [
  'extension',
  'index',
  'unique-index',
  'check-constraint',
  'foreign-key-constraint',
  'unique-constraint',
  'generated-column',
  'function',
  'trigger',
  'table',
  'sequence',
];

export class ManifestError extends Error {}

/**
 * Load and validate the manifest at `path`. Returns
 * { diffWhitelist, postPushOwned, raw } where each list element is the row as
 * written. Throws ManifestError with a precise message on any contract breach.
 */
export function loadManifest(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ManifestError(`manifest ${path} is not readable JSON: ${err.message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ManifestError(`manifest ${path} must be a JSON object`);
  }

  const knownKeys = new Set(['note', 'diff-whitelist', 'post-push-owned']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      throw new ManifestError(`manifest ${path}: unknown key "${key}" (known: ${[...knownKeys].join(', ')})`);
    }
  }
  if (!Array.isArray(raw['diff-whitelist'])) throw new ManifestError(`manifest ${path}: "diff-whitelist" must be a list`);
  if (!Array.isArray(raw['post-push-owned'])) throw new ManifestError(`manifest ${path}: "post-push-owned" must be a list`);

  const diffWhitelist = [];
  const seenLines = new Map(); // line -> row name (for duplicate detection)
  for (const [i, row] of raw['diff-whitelist'].entries()) {
    const at = `diff-whitelist[${i}]`;
    requireKeys(path, at, row, ['name', 'kind', 'why', 'line'], ['name', 'kind', 'why', 'line']);
    if (!DIFF_WHITELIST_KINDS.includes(row.kind)) {
      throw new ManifestError(`${path}: ${at} kind "${row.kind}" is not one of ${DIFF_WHITELIST_KINDS.join(', ')}`);
    }
    if (typeof row.line !== 'string' || !row.line.trim()) {
      throw new ManifestError(`${path}: ${at} "line" must be a non-empty string (the exact prisma migrate diff line to whitelist)`);
    }
    if (seenLines.has(row.line)) {
      throw new ManifestError(`${path}: ${at} duplicates the drift line already claimed by "${seenLines.get(row.line)}" — one row per line`);
    }
    seenLines.set(row.line, row.name);
    diffWhitelist.push(row);
  }

  const postPushOwned = [];
  const seenOwned = new Set();
  for (const [i, row] of raw['post-push-owned'].entries()) {
    const at = `post-push-owned[${i}]`;
    requireKeys(path, at, row, ['name', 'kind', 'why'], ['name', 'kind', 'why', 'file']);
    if (!POST_PUSH_OWNED_KINDS.includes(row.kind)) {
      throw new ManifestError(`${path}: ${at} kind "${row.kind}" is not one of ${POST_PUSH_OWNED_KINDS.join(', ')}`);
    }
    const identity = `${row.kind}:${row.name}`;
    if (seenOwned.has(identity)) {
      throw new ManifestError(`${path}: ${at} duplicates ${identity}`);
    }
    seenOwned.add(identity);
    postPushOwned.push(row);
  }

  return { diffWhitelist, postPushOwned, raw };
}

function requireKeys(path, at, row, keys, allowed) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new ManifestError(`${path}: ${at} must be an object`);
  }
  for (const key of keys) {
    if (typeof row[key] !== 'string' || !row[key].trim()) {
      throw new ManifestError(`${path}: ${at} needs a non-empty string "${key}"`);
    }
  }
  for (const key of Object.keys(row)) {
    if (!allowed.includes(key)) {
      throw new ManifestError(`${path}: ${at} unknown key "${key}" (allowed: ${allowed.join(', ')})`);
    }
  }
}

/**
 * The set of exact drift lines the filter may drop. Exposed for the test so
 * the fixture can prove the filter's matching is exact-string, not fuzzy.
 */
export function whitelistedLines(manifest) {
  return new Set(manifest.diffWhitelist.map((row) => row.line));
}
