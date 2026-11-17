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
 * The ONE list both findNodes default sites read: the SQL filter clause
 * (`retrieval/postgres.ts`, the lexical, regex and browse paths) and the
 * Prisma `structuredWhere` (the vector hydration and list paths), so the two
 * can never disagree on what an unqualified search returns.
 */
export const UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES: readonly string[] = Object.freeze(['system', 'chat-message']);
