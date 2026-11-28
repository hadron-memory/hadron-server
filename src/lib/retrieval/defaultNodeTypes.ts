import { asksForInstructions } from '../instructionRoles.js';

/**
 * The node types an UNQUALIFIED search leaves out (cor:api:090:02).
 *
 * - `system`: the original default, orthogonal to the SYSTEM memory-class one.
 * - `chat-message` (#2836): a team chat root holds tens of thousands of these,
 *   and a search that did not ask for them should not have to page past them.
 *
 * Explicit wins: a filter naming a `nodeType` gets exactly that type, these
 * included. `record` is deliberately NOT here: run outputs are stored as
 * `record`, and hiding them would fail silently (so a chatbot chat root's
 * `record` messages stay searchable).
 *
 * The ONE list behind every default site. Production code does not read it
 * directly (pinned, #5452): it asks `defaultExcludedNodeTypes`, below.
 */
export const UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES: readonly string[] = Object.freeze(['system', 'chat-message']);

/** #5452 — the same list with `system` lifted, for a filter that asked for system nodes. */
const EXCLUDED_WITH_SYSTEM_NODES: readonly string[] = Object.freeze(
  UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES.filter((t) => t !== 'system'),
);

/**
 * #5452 (cor:api:090:02) — the node types a filter with NO explicit `nodeType` / `nodeTypes` leaves out.
 *
 * `includeSystemNodes: true` lifts `system` and nothing else: `chat-message` stays out on every answer.
 * #5485: so does a filter that asks for instructions (`asksForInstructions`).
 * Only the boolean `true` lifts; `false`, `null`, omitted and any other value keep the default, so a loosely
 * typed caller cannot widen a read by accident. It decides the node-type default ONLY: the memory-class
 * SYSTEM default, access, soft-deleted rows, comments and inheritance are other clauses and never read this.
 *
 * The one function every default site calls: the SQL filter clause (`retrieval/postgres.ts`: the lexical,
 * regex, browse and vector statements), the Prisma `structuredWhere` (the hydration and list paths) and the
 * loc-segments read (`memoryLocSegments.ts`), so none of them can disagree on what an unqualified read returns.
 */
export function defaultExcludedNodeTypes(
  filter?: { includeSystemNodes?: unknown; isRunnable?: unknown; role?: unknown } | null,
): readonly string[] {
  // #5485 — naming `isRunnable: true` or a role in an instruction family is an explicit ask for instructions,
  // exactly as naming a nodeType is: it lifts `system` here, and only `system`. Decided HERE so the SQL clause and
  // the Prisma filter cannot disagree; `chat-message` and the memory-class default never read it.
  return filter?.includeSystemNodes === true || asksForInstructions(filter)
    ? EXCLUDED_WITH_SYSTEM_NODES
    : UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES;
}
