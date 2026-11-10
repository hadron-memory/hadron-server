/** Test-only diagnostics for the fixed synthetic/provisional #2421 benchmark. */
export type SymptomResult = {
  symptom: string;
  expectedLoc: string;
  hits: readonly { node: { loc: string }; matchedBy: string }[];
};

export function reportSymptomRanking(results: readonly SymptomResult[]): number {
  const ranked = results.map(row => {
    const top = row.hits.slice(0, 3);
    const index = top.findIndex(hit => hit.node.loc === row.expectedLoc);
    return { ...row, top, rank: index < 0 ? 'miss' as const : index + 1 };
  });
  const correct = ranked.filter(row => row.rank !== 'miss').length;
  console.log('Fixed synthetic/provisional symptom benchmark (hermetic keyword/fallback; not live-vector or real-world recall)');
  console.log('Symptom | Expected loc | Top 3 (ranked loc [matchedBy]) | Expected rank');
  for (const row of ranked) {
    const candidates = row.top.map(hit => `${hit.node.loc} [${hit.matchedBy}]`).join('; ') || '—';
    console.log(`${row.symptom} | ${row.expectedLoc} | ${candidates} | ${row.rank}`);
  }
  console.log(`Total hits: ${correct}/${results.length}`);
  return correct;
}
