/** Shared hybrid composition (#2421, cor:api:240:01), extracted from findNodes.
 * Inputs are already scoped, relevance-ranked retriever results. Preserve RRF's
 * keyword-first stable ties and the caller's candidate-window size; source is
 * derived from membership in those exact input lists, never guessed from score.
 */
import { reciprocalRankFusionScored } from '../rrf.js';
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
