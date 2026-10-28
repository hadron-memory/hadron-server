/** Test-only diagnostics for the fixed synthetic/provisional #2421 benchmark. */
export type SymptomResult = {
  symptom: string;
  expectedLoc: string;
  hits: readonly { node: { loc: string }; matchedBy: string }[];
};

export function reportSymptomRanking(results: readonly SymptomResult[]): number {
  return results.filter(row => row.hits.slice(0, 3).some(hit => hit.node.loc === row.expectedLoc)).length;
}
