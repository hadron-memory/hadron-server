/**
 * Spec 033 US3 — reciprocal-rank fusion (RRF).
 *
 * Hybrid search combines a keyword-ranked list and a vector-ranked list into
 * a single ranking by summing 1/(k + rank) across the per-list ranks of each
 * document. RRF is rank-only (no absolute-score calibration needed across the
 * two retrievers — keyword tf-idf scores and cosine distances are not
 * commensurable), which is why it's a strong default for first-cut hybrid.
 *
 * `k = 60` is the platform-wide constant per FR-019, matching the Cormack /
 * Microsoft baseline. Spec calls this out so it isn't accidentally tuned
 * away later — bumping k has subtle effects on rank-1 dominance.
 *
 * **Important — keyword rank must already be a relevance ranking, not the
 * default alphabetical-by-loc list.** Today's `h-find-nodes` keyword path
 * returns hits sorted by `loc` for stability; feeding that raw into RRF as
 * the "rank" lets alphabetical order drive the fused ordering. The caller
 * is responsible for re-ranking the keyword list (distinct-query-terms-matched
 * desc, then total-term-frequency desc, ties broken by loc) BEFORE handing
 * it to RRF. See `keywordRelevanceRank` in `src/mcp/server.ts`.
 */

export const RRF_K = 60;

/**
 * Fuse N pre-ranked lists into a single ranking by reciprocal-rank fusion.
 *
 * Documents present in only one list still receive a score (their RRF
 * contribution from that one list) — the formula naturally handles partial
 * overlap. Items absent from a list contribute zero from that list.
 *
 * Stable: when two items end up with the same fused score, the one that
 * appeared first in any input list wins (insertion-order tiebreak via the
 * Map). Without a stable tiebreak the result would drift across runs and
 * break snapshot tests.
 *
 * @param lists  pre-ranked input lists; index 0 is rank 1 within each list
 * @param keyFn  deterministic key extractor used to identify "the same item"
 *               across lists (URN, node id, etc.)
 * @param k      RRF constant; defaults to platform-wide `RRF_K = 60`
 * @returns      fused list of unique items, highest fused score first
 */
export function reciprocalRankFusion<T>(
  lists: ReadonlyArray<ReadonlyArray<T>>,
  keyFn: (item: T) => string,
  k: number = RRF_K,
): T[] {
  // Map preserves insertion order; first-seen wins ties.
  const acc = new Map<string, { score: number; item: T; firstSeen: number }>();
  let seq = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const rank = i + 1; // RRF is 1-indexed
      const key = keyFn(item);
      const inc = 1 / (k + rank);
      const cur = acc.get(key);
      if (cur) {
        cur.score += inc;
      } else {
        acc.set(key, { score: inc, item, firstSeen: seq++ });
      }
    }
  }
  return Array.from(acc.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable tiebreak — preserves first-seen across runs.
      return a.firstSeen - b.firstSeen;
    })
    .map((entry) => entry.item);
}
