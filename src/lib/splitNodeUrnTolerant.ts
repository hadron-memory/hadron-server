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
 * A REGISTERED fragment (`#data`) decomposes cleanly, so it never reaches the
 * recovery path — but a stored loc can be `foo#data` LITERALLY, and then the
 * clean decomposition is the wrong answer: the read looks up `foo` and either
 * misses or, worse, returns a different node that happens to exist (PR #1088
 * review, Codex P2). A pure function cannot tell those apart — only the
 * database can — so `literalLoc` is always reported and the READ paths try it
 * first. Callers that act on the whole node want `splitWholeNodeUrn` instead.
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
): NodeLikeUrnParts & { corruptFragment?: boolean; literalLoc?: string } {
  try {
    const parts = splitNodeUrn(input);
    // The loc as STORED would look, if this row predates loc validation and
    // its loc really does contain the `#`. Only a lookup can decide; the
    // caller tries this first and falls back to the decomposed reading.
    return parts.fragment
      ? { ...parts, literalLoc: `${parts.loc}#${parts.fragment}` }
      : parts;
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

/**
 * The refusal a WHOLE-NODE operation owes a caller who addressed a fragment.
 *
 * Returns a message, or null when the URN names no fragment.
 *
 * urn-lib-js 0.0.15 made `splitNodeUrn` strip `#data` and report it separately.
 * Every caller that destructures only `{ memoryUrn, loc }` therefore stopped
 * missing and started resolving THE PARENT — and on `hadron_delete_node` that
 * turns a safe not-found into deleting the whole node, when the caller asked to
 * address only its data (PR #1088 review, Codex P1). Before the bump the same
 * input looked up a literal `…#data` loc and found nothing.
 *
 * A fragment names a resource OF the node. Until a surface can act on that
 * resource, the honest answer is to refuse and say which is which — never to
 * act on the parent because it is the nearest thing we can find
 * (hadron-server#994, whose whole subject is silently resolving to the parent).
 */
export function nodeFragmentRefusal(input: string, fragment?: string): string | null {
  if (!fragment) return null;
  return (
    `"${input}" addresses this node's ${fragment}, not the node. ` +
    `This operation acts on the whole node, so it will not act on a fragment reference — ` +
    `drop "#${fragment}" to name the node itself.`
  );
}

/**
 * `splitNodeUrn` for an operation that acts on the WHOLE node: identical, but
 * refuses a fragment instead of silently resolving to the parent.
 *
 * Throws `UrnNotQualifiedError`, which the GraphQL/controller call sites already
 * surface as a client error. MCP handlers return text rather than throwing, so
 * they use `nodeFragmentRefusal` and their own `textResult` instead.
 */
export function splitWholeNodeUrn(input: string): NodeLikeUrnParts {
  const parts = splitNodeUrn(input);
  const refusal = nodeFragmentRefusal(input, parts.fragment);
  if (refusal) throw new UrnNotQualifiedError(refusal);
  return parts;
}
