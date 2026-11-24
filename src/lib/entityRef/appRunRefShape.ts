/**
 * assertAppRunRefShape — a pure SHAPE check for an AppRun reference (#4141, S5 of #775).
 *
 * `resolveAppRunRef` deliberately answers a malformed URN exactly like an absent run (no existence oracle for the
 * read surfaces, #1577). The write door `cancelAppRun(ref:)` separates the two: a ref that cannot name a run at all is
 * a caller bug (cor:api:140:01, "a malformed relative URN propagates as a typed error"), while a well-shaped ref that
 * names nothing is a miss. A shape check says nothing about whether any run exists, so it opens no oracle.
 *
 * Call-site only. `resolveAppRunRef`, `appRun(ref:)` and `resolveUrn`'s apprun case keep their answers.
 * Accepts what the resolver accepts: a bare id, or `hrn:apprun:<root>:<app>:<run-id>`.
 * A parser failure throws `UrnParseError` (formatter code BAD_USER_INPUT); a well-formed URN of another type throws
 * a BAD_USER_INPUT `GraphQLError` that does not echo the ref.
 */
import { GraphQLError } from 'graphql';
import { isId } from './shape.js';
import { parseUrnV2 } from '../urn.js';

export function assertAppRunRefShape(ref: string): void {
  if (isId(ref)) return;
  const parsed = parseUrnV2(ref); // throws UrnParseError on an unparseable ref
  if (parsed.type !== 'apprun') {
    throw new GraphQLError('Expected an AppRun reference (an id or an hrn:apprun URN).', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}
