/** Shared hybrid composition (#2421, cor:api:240:01), extracted from findNodes.
 * Inputs are already scoped, relevance-ranked retriever results. Preserve RRF's
 * keyword-first stable ties and the caller's candidate-window size; source is
 * derived from membership in those exact input lists, never guessed from score.
 */
import { RRF_K, reciprocalRankFusionScored } from '../rrf.js';
import { BooleanQueryError, literalQuery, relaxConjunctionToOr } from './tsquery.js';
export type MatchedBy = 'VECTOR' | 'KEYWORD' | 'BOTH';
export function composeHybridRanking(
  keyword: ReadonlyArray<{ nodeId: string; score: number }>,
  vector: ReadonlyArray<{ nodeId: string; score: number }>,
  limit: number,
): Array<{ nodeId: string; score: number; matchedBy: MatchedBy }> {
  const kw = new Set(keyword.map(h => h.nodeId));
  const vec = new Set(vector.map(h => h.nodeId));
  return reciprocalRankFusionScored([keyword.map(h => h.nodeId), vector.map(h => h.nodeId)], id => id)
    .slice(0, limit)
    .map(h => ({ nodeId: h.item, score: h.score, matchedBy: kw.has(h.item) ? (vec.has(h.item) ? 'BOTH' : 'KEYWORD') : 'VECTOR' }));
}

/** Keyword half of hybrid retrieval, including the existing fallback grammar.
 * Only a keyword-only fallback relaxes conjunctions; true hybrid keeps strict
 * keyword inputs because the vector half supplies recall (findNodes #496).
 */
export async function hybridKeywordCandidates(
  query: string,
  search: (query: string) => Promise<Array<{ nodeId: string; score: number }>>,
  relax = false,
): Promise<{ hits: Array<{ nodeId: string; score: number }>; degraded: string | null }> {
  try {
    const strict = await search(query);
    if (relax && strict.length === 0) {
      const relaxedQuery = relaxConjunctionToOr(query);
      if (relaxedQuery) {
        const relaxed = await search(relaxedQuery);
        if (relaxed.length) return { hits: relaxed, degraded: 'and_relaxed_to_or' };
      }
    }
    return { hits: strict, degraded: null };
  } catch (e) {
    if (!(e instanceof BooleanQueryError)) throw e;
    try { return { hits: await search(literalQuery(query)), degraded: 'literal_fallback' }; }
    catch (literalError) {
      if (!(literalError instanceof BooleanQueryError)) throw literalError;
      return { hits: [], degraded: 'literal_fallback' };
    }
  }
}

/** One leg of a hybrid fusion: its ranked node ids (rank = index + 1) and whether the leg has nothing deeper. */
export interface HybridLeg { ids: ReadonlyArray<string>; exhausted: boolean }

/**
 * #4779 (P3-4; Vera's FIT condition 4c on cor:api:090:04, certified fusion accepted in team chat #140476) — RRF over two legs
 * read to a finite depth, and whether its order up to `page` is CERTIFIED: no node, seen or unseen, could take a position in
 * `[0, page)` (or swap two of them) if the legs were read further. Without it, pages at different offsets (whose legs are
 * read to different depths) repeat or skip nodes, which is not "the true page" of the fused ranking.
 *
 * - Scores are RRF exactly as {@link composeHybridRanking} computes them (keyword term, then vector term), so a hit's score
 *   is the value it was ranked by. Ties keep RRF's keyword-first order: a keyword hit by keyword rank, then vector-only hits
 *   by vector rank. That key does not depend on how deep the legs were read.
 * - A node's term in a leg is KNOWN when it is in that leg, the leg is exhausted, or (vector only) its exact vector rank was
 *   looked up (`vecRanks`/`vecLooked`; looked up and absent means it has no eligible vector, a term of exactly 0). An
 *   unknown term is bounded above by `1/(k + depth + 1)`: the node is not in the leg's first `depth` ranks.
 * - Certified when each of the first `page` nodes scores above every later node's upper bound (an unseen node's included);
 *   an equal score is enough only against a later node whose score is exact, since that tie's order is the stable key.
 * - #5162 — never certified on a lookup that contradicts the vector leg (above the #4994 bound they are separate HNSW
 *   walks): every looked-up leg node must sit at its leg position, and every other looked-up rank must be deeper than the
 *   leg. The caller asks the lookup about the leg's nodes too, so agreement is shown, not assumed. A contradiction only
 *   withholds certification: the order is read and settled as before (the same rows), and the caller flags the page
 *   `stopped_early`. `exactLookup` (the lookup ranked a scope within the bound exactly, as the leg is there) skips the
 *   check: no second walk exists, and a difference could only be a write between the two statements.
 *
 * While the bounds still leave doubt about the order up to `page`, `vecLookup` lists the keyword hits whose vector term is
 * still unknown (look them up, then call again) and `kwUncertain` says the keyword leg could still change the order (widen
 * it). With no doubt left both are empty, even when a disagreement withholds `certified`: there is nothing more to read.
 *
 * Limits (BLIND P3-2, P3-5 on #4928):
 * - "Certified" is relative to the legs as given. A vector leg served by the approximate HNSW walk (rankUnderBudget) is the
 *   index's order, not the exact one; certification then holds for that order (built as, not ruled: #4928).
 * - A certified page's node can still carry an unknown term (it is ordered by bounds that leave no doubt): its `score` is
 *   then the known part, and its `matchedBy` names only the legs it was seen in.
 */
export function certifiedHybridRanking(
  kw: HybridLeg,
  vec: HybridLeg,
  page: number,
  vecRanks: ReadonlyMap<string, number> = new Map(),
  vecLooked: ReadonlySet<string> = new Set(),
  exactLookup = false,
  k: number = RRF_K,
): {
  ranked: Array<{ nodeId: string; score: number; matchedBy: MatchedBy }>;
  certified: boolean;
  vecLookup: string[];
  kwUncertain: boolean;
} {
  const kwRank = new Map(kw.ids.map((id, i) => [id, i + 1]));
  const vecRank = new Map(vec.ids.map((id, i) => [id, i + 1]));
  const missK = kw.exhausted ? 0 : 1 / (k + kw.ids.length + 1);
  const missV = vec.exhausted ? 0 : 1 / (k + vec.ids.length + 1);
  const ids = [...kw.ids, ...vec.ids.filter((id) => !kwRank.has(id))];
  const rows = ids.map((nodeId) => {
    const rk = kwRank.get(nodeId);
    const rv = vecRank.get(nodeId) ?? vecRanks.get(nodeId);
    const kwKnown = rk !== undefined || kw.exhausted;
    const vecKnown = vecRank.has(nodeId) || vecLooked.has(nodeId) || vec.exhausted;
    let score = 0;
    if (rk !== undefined) score += 1 / (k + rk);
    if (rv !== undefined) score += 1 / (k + rv);
    const exact = kwKnown && vecKnown;
    const ub = score + (kwKnown ? 0 : missK) + (vecKnown ? 0 : missV);
    const matchedBy: MatchedBy = rk !== undefined ? (rv !== undefined ? 'BOTH' : 'KEYWORD') : 'VECTOR';
    // Keyword-first stable tie key, independent of depth.
    const tie: [number, number] = rk !== undefined ? [0, rk] : [1, vecRank.get(nodeId) ?? Number.MAX_SAFE_INTEGER];
    return { nodeId, score, ub, exact, matchedBy, tie, vecKnown, inKw: rk !== undefined };
  });
  rows.sort((a, b) => b.score - a.score || a.tie[0] - b.tie[0] || a.tie[1] - b.tie[1]);
  const unseenUb = missK + missV;
  // Suffix maxima of the upper bounds of inexact rows (and unseen nodes) and of the scores of exact rows.
  const n = rows.length;
  const sufInexact = new Array<number>(n + 1);
  const sufExact = new Array<number>(n + 1);
  sufInexact[n] = unseenUb > 0 ? unseenUb : -Infinity;
  sufExact[n] = -Infinity;
  for (let i = n - 1; i >= 0; i--) {
    const r = rows[i]!;
    sufInexact[i] = Math.max(sufInexact[i + 1]!, r.exact ? -Infinity : r.ub);
    sufExact[i] = Math.max(sufExact[i + 1]!, r.exact ? r.score : -Infinity);
  }
  let settled = n >= page || unseenUb === 0;
  for (let i = 0; settled && i < Math.min(page, n); i++) {
    const s = rows[i]!.score;
    if (!(s > sufInexact[i + 1]! && s >= sufExact[i + 1]!)) settled = false;
  }
  const walksDisagree = !exactLookup && [...vecLooked].some((id) => {
    const inLeg = vecRank.get(id);
    const lookedUp = vecRanks.get(id);
    return inLeg !== undefined ? lookedUp !== inLeg : lookedUp !== undefined && lookedUp <= vec.ids.length;
  });
  return {
    ranked: rows.map((r) => ({ nodeId: r.nodeId, score: r.score, matchedBy: r.matchedBy })),
    certified: settled && !walksDisagree,
    vecLookup: settled ? [] : rows.filter((r) => r.inKw && !r.vecKnown).map((r) => r.nodeId),
    kwUncertain: !settled && !kw.exhausted,
  };
}
