import type { Prisma } from '../generated/prisma/index.js';

/**
 * #2967 — the product order of a node's edges. An edge include with no `orderBy` follows
 * Postgres physical or plan order, so two reads of one node could differ byte for byte.
 *
 * - `EDGE_DISPLAY_ORDER`: every projection that lists edges (MCP node reads, GraphQL
 *   `Node.outgoingEdges` / `incomingEdges`), loc then id. Matches the edge-list order of
 *   cor:api:120:02; `id` makes it total. Used for incoming edges everywhere, since a priority
 *   compares edges of different sources.
 * - `EDGE_RUN_ORDER`: a source node resolving its OUTGOING edges for a run. cor:dmo:060:03 makes
 *   `Edge.priority` (lower first) the durable within-source resolution order, so run output
 *   resolves priority, then loc, then id.
 *
 * Both are functions returning fresh arrays because Prisma's `orderBy` type is mutable.
 */
export const edgeDisplayOrder = (): Prisma.EdgeOrderByWithRelationInput[] => [{ loc: 'asc' }, { id: 'asc' }];
export const edgeRunOrder = (): Prisma.EdgeOrderByWithRelationInput[] => [{ priority: 'asc' }, { loc: 'asc' }, { id: 'asc' }];
