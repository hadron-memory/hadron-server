/**
 * #697 stored-alias-map resolution fallback.
 *
 * The URN grammar v2 online migration flips `urn` from its v1 form to the flat
 * v2 form and records the pre-migration URN in `legacyUrn` (see the schema).
 * Because migration *assigns* the new slug (auto-suffixing an author-derived
 * alias on collision, #695), an old URN cannot be string-rewritten to the new
 * one — so a legacy reference (a wikilink, an exported repo, a chat log, an
 * external link; the #239 accept-forever promise) is resolved by MATCHING the
 * `legacyUrn` column, not by transforming the string.
 *
 * Each `resolve<Entity>Ref` calls this after its primary `urn` lookup misses:
 * it queries the entity's live rows whose `legacyUrn` equals the same
 * normalized lookup form and hands the result here.
 *
 * INERT until the migration runs — pre-migration every `legacyUrn` is null, so
 * `matches` is always empty and this returns null (the caller throws its
 * NotFound exactly as before). Post-migration it turns a legacy input into the
 * migrated row, or fails LOUDLY on ambiguity.
 */

import { AmbiguousLegacyUrnError } from './errors.js';

/**
 * Resolve the stored-alias-map candidates for a legacy URN input. Returns the
 * single live match, throws {@link AmbiguousLegacyUrnError} on more than one
 * (never a silent wrong resolve — #697), or null on none (the caller throws its
 * own typed NotFound). Pass at most 2 rows (`take: 2`) — the count past 1 is all
 * this needs.
 */
export function resolveLegacyAlias(
  ref: string,
  matches: ReadonlyArray<{ id: string }>,
): { id: string } | null {
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new AmbiguousLegacyUrnError(ref);
  return { id: matches[0]!.id };
}
