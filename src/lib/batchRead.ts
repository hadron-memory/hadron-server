/**
 * Hard caps for the batch node read (spec cor:api:040:02).
 *
 * BOTH a node-count cap and a response-size cap bound every batch read, on both
 * transports (MCP hadron_get_nodes + the GraphQL batch query). Exceeding either is
 * LOUD — a typed error (count) or an explicit `truncated` flag (size) — never a
 * silent short read. That loud-never-silent contract is the durable rule and
 * the direct lesson of hadron-cli#23 (a bulk read that silently truncated at
 * ~100 rows, so a corpus-wide command reported "all clear" having seen a
 * fraction of the corpus).
 *
 * The VALUES below are tunable operational dials — raising or lowering them does
 * not invalidate the spec. They are sized to comfortably hold a full module or
 * the whole platform-specs corpus (~112 nodes) in one call while still bounding
 * a runaway prefix.
 */
export const BATCH_READ_MAX_NODES = 200;
export const BATCH_READ_MAX_BYTES = 1_000_000;
/** Requested edge rows share this budget; endpoints remain gated, lazy Node reads. */
export const BATCH_READ_MAX_EDGES = 2_000;
