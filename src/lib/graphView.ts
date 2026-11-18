/**
 * #2990 — the graph view's data queries (`memoryNodes`, `memoryEdges`) are switched OFF by default: a temporary
 * degradation (Holger, 2026-10-31) so the remaining portal slowness can be found with that load gone. They answer
 * the empty page before any read, so lifting it is a config change, not a revert. Revisit per #2810, #2970 and
 * hadron-portal#1380.
 *
 * Read per call. ON unless the value is exactly `false`: an unset, empty or mistyped value keeps the degradation, so a
 * typo can never silently put the cost back.
 */
export function graphViewDisabled(): boolean {
  return process.env.GRAPH_VIEW_DISABLED !== 'false';
}
