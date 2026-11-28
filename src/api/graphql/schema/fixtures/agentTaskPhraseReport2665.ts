/** Test-only diagnostics for the fixed synthetic/provisional #2421 benchmark. */
export type PhraseResult = {
  phrase: string;
  expectedLoc: string;
  hits: readonly { node: { loc: string }; matchedBy: string }[];
};

export function reportPhraseRanking(results: readonly PhraseResult[]): number {
  const ranked = results.map(row => {
    const top = row.hits.slice(0, 3);
    const index = top.findIndex(hit => hit.node.loc === row.expectedLoc);
    return { ...row, top, rank: index < 0 ? 'miss' as const : index + 1 };
  });
  const correct = ranked.filter(row => row.rank !== 'miss').length;
  console.log('Fixed synthetic/provisional phrase benchmark (hermetic keyword/fallback; not live-vector or real-world recall)');
  console.log('Phrase | Expected loc | Top 3 (ranked loc [matchedBy]) | Expected rank');
  for (const row of ranked) {
    const candidates = row.top.map(hit => `${hit.node.loc} [${hit.matchedBy}]`).join('; ') || '—';
    console.log(`${row.phrase} | ${row.expectedLoc} | ${candidates} | ${row.rank}`);
  }
  console.log(`Total hits: ${correct}/${results.length}`);
  return correct;
}
