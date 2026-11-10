/**
 * #437 — normalize the shared findNodes page BEFORE any retrieval path uses it.
 * Public GraphQL/MCP inputs are integers; the finite/truncation guards also
 * cover internal callers that bypass those schemas. Limit bounds hydration,
 * not graph expansion or the independent vector candidate window. Offset has
 * no ceiling: lowering a requested page would silently return an earlier one.
 */
export function normalizeFindNodesPaging(limit?: number | null, offset?: number | null) {
  return {
    limit: limit == null || !Number.isFinite(limit) ? 20 : Math.min(200, Math.max(1, Math.trunc(limit))),
    offset: offset == null || !Number.isFinite(offset) ? 0 : Math.max(0, Math.trunc(offset)),
  };
}
