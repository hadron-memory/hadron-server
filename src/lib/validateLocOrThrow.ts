import { GraphQLError } from 'graphql';
import { InvalidLocError, validateLoc } from './validateLoc.js';

/**
 * #4461 — the cap on a loc's TOTAL length, in characters, on a write.
 * `validateLoc` caps each atom at 64 but not the whole, so a loc of many valid
 * atoms was accepted at any size. PROVISIONAL value: the cor:api Rule that
 * fixes it (precondition 1 of the #4461 gate) names the number; change it here.
 */
export const LOC_MAX_TOTAL_LENGTH = 512;

/**
 * #4461 — validate a loc at a GraphQL write boundary and refuse it ONE way at
 * every site: `BAD_USER_INPUT`, with `extensions.field` (the argument the
 * caller sent) and `extensions.reason` (`empty` | `invalid-charset` |
 * `too-long`), and NEVER the offending value: not in the message, not in
 * `extensions`. The caller's own input is not a leak, but echoing it returns an
 * unbounded string twice into responses and logs (cor:api:090:05's Proposed
 * direction; #4106).
 *
 * Replaces ten hand-written try/catch wraps that answered two shapes
 * (`InvalidLocError` with `loc`/`segment` extensions, and `BAD_USER_INPUT` with
 * the echo in the text). A new GraphQL site calls this; it does not wrap
 * `validateLoc` itself.
 *
 * Throws only what it maps; anything else `validateLoc` throws propagates.
 *
 * Error-shape change (the CHECKED arm (b) of the #4461 gate, already gated, not reopened): a bad loc used to surface
 * as `InvalidLocError` with `loc`/`segment` extensions at some sites; it is now `BAD_USER_INPUT` with `field` and
 * `reason` at all of them. Portal follow-up hadron-portal#2323 reads both shapes.
 *
 * Reason typing: `InvalidLocError.reason` is the closed union `'empty' | 'invalid-charset' | 'too-long'`
 * (validateLoc.ts), and `REASON_TEXT` below is a `Record` over exactly that union, so a new reason fails to compile
 * here until it has text.
 *
 * `uncapped` skips ONLY the total-length cap, for an argument that names an EXISTING node (renumberSpec's `fromLoc`):
 * an over-cap node stays addressable, while the charset and atom rules still refuse a malformed value the same way at
 * any length, so a refusal never echoes one.
 */
export function validateLocOrThrow(loc: string, field: string, opts?: { uncapped?: boolean }): void {
  if (!opts?.uncapped && loc.length > LOC_MAX_TOTAL_LENGTH) throw badLoc(field, 'too-long');
  try {
    validateLoc(loc);
  } catch (e) {
    if (e instanceof InvalidLocError) throw badLoc(field, e.reason);
    throw e;
  }
}

const REASON_TEXT: Record<InvalidLocError['reason'], string> = {
  'empty': 'it cannot be empty',
  'invalid-charset': 'each ":"-separated segment must use letters, digits, dots, underscores or hyphens, and start and end with a letter or digit',
  'too-long': `each ":"-separated segment must be at most 64 characters and the whole loc at most ${LOC_MAX_TOTAL_LENGTH}`,
};

function badLoc(field: string, reason: InvalidLocError['reason']): GraphQLError {
  return new GraphQLError(`${field} is not a valid loc: ${REASON_TEXT[reason]}.`, {
    extensions: { code: 'BAD_USER_INPUT', field, reason },
  });
}
