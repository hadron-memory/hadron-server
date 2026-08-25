/**
 * `splitNodeUrn`, but able to decompose a URN whose LOC IS ALREADY CORRUPT.
 *
 * urn-lib-js 0.0.14 taught the decomposers about fragments: `#<word>` is
 * stripped before the positional split and reported separately, and an
 * UNREGISTERED fragment word is refused outright (`UrnNotQualifiedError`).
 * Both are right for a URN a caller composed. Neither is right for a URN this
 * server composed FROM A ROW, because `Node.loc` can already contain a `#`:
 * rows predate the loc charset validation, and reads are how anyone discovers
 * them.
 *
 * Straight through the library, `hadron_get_node("org::mem::evil#@example.com")`
 * stopped decomposing and threw out of the tool — so the one row you most need
 * to look at became the one row you cannot read, and therefore cannot fix. That
 * is a read surface losing a capability to a dependency bump
 * (`src/lib/urn.test.ts` and `src/mcp/server.portalUrl.test.ts` both caught it).
 *
 * So: try the library first, always. Only when it refuses a fragment do we
 * retry on the text before the `#` and put the remainder back on the loc,
 * recovering exactly the pre-0.0.14 decomposition for that one input class. The
 * split itself still comes from the library — nothing here re-implements the
 * grammar, which is the drift the package exists to end (#693, #239).
 *
 * A REGISTERED fragment (`#data`) is not this function's business: the library
 * decomposes it cleanly and reports `fragment`, and callers must decide what
 * that means rather than having it silently folded away.
 */
import { splitNodeUrn, UrnNotQualifiedError, type NodeLikeUrnParts } from './urn.js';

/**
 * Decompose a node URN, tolerating a corrupt stored loc that contains `#`.
 *
 * `corruptFragment` is set only on the recovery path — it tells a caller the
 * loc it received is not URN-legal, which is why (for instance) no portal link
 * may be built from it.
 */
export function splitNodeUrnTolerant(
  input: string,
): NodeLikeUrnParts & { corruptFragment?: boolean } {
  try {
    return splitNodeUrn(input);
  } catch (err) {
    const hashIdx = input.indexOf('#');
    // Only the fragment refusal is recoverable, and only when there IS a
    // fragment to blame. Anything else — a genuinely unqualified URN, an
    // ambiguous legacy alias — must escape: answering it with a best-effort
    // split would turn a loud, correct refusal into a wrong lookup.
    //
    // NO INPUT REACHES THE `instanceof` HALF TODAY, and the test suite does not
    // pretend otherwise: every failure the library raises for a `#`-carrying
    // input is UrnNotQualifiedError, so deleting that clause leaves the suite
    // green (review:a-green-mutation-indicts-the-test). It stays because the
    // clause states this function's contract rather than inheriting it, and
    // because a future error class here would otherwise route silently into
    // recovery. What actually keeps recovery safe is BELOW: the retry goes back
    // through the library, so it can only succeed where the text before the `#`
    // is a valid node URN — which is the corrupt-loc case and nothing else.
    // That property IS reachable, and is tested.
    if (!(err instanceof UrnNotQualifiedError) || hashIdx === -1) throw err;
    const parts = splitNodeUrn(input.slice(0, hashIdx));
    return { ...parts, loc: parts.loc + input.slice(hashIdx), corruptFragment: true };
  }
}
