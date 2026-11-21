import { z } from 'zod';
import { tagsInputSchema } from './tagsInput.js';

/**
 * #236 — the MCP tool input shapes (`SHAPE_HADRON_*`) and the shared constants they carry, moved out of server.ts.
 * Pure move: the registered tool surface is byte-identical (golden `__golden__/toolSurface2260.json`).
 */

/**
 * #1057 — the ONE statement of what an edge's `description` is for. `name` is
 * the label every agent read renders ("Related:" / "Referenced by:" on node
 * reads, per #721); `description` is carried for API consumers and is NOT
 * shown there. Undocumented, the field that is called "description" is where
 * an agent puts the text it wants seen, and it vanishes.
 */
export const EDGE_DESCRIPTION_DOC =
  'Longer gloss carried for API consumers (GraphQL, `hadron edge list --json`). NOT rendered on node reads: '
  + 'Related:/Referenced by: show the edge `name`, so put the label you want seen in `name`.';

/** #1328 — the claim, as every MCP node writer takes it. */
export const AUTHORED_WITH_ARG = z.object({
  task: z.string().describe('The author task: its node id or canonical URN.'),
  revision: z.number().int().positive().describe('The current revision of that task.'),
}).optional().describe('The author task this write worked from, required when the node\'s role rule names one. The server compares it and records it; it does not prove the task was followed.');

/** One operator can monitor this many live Workers in one poll. */
export const TEAM_CHAT_MONITOR_MAX_TARGETS = 20;

export const SHAPE_HADRON_SEARCH = {
  query: z
    .string()
    .describe('Search text: a PK/id, a URN (hrn:/urn: or bare root:slug), or free-text name.'),
  entityTypes: z
    .array(
      z.enum(['organization', 'memory', 'node', 'agent', 'app', 'aiServiceConfig', 'user']),
    )
    .optional()
    .describe('Restrict to these entity types. Omit to search all.'),
  fields: z
    .array(z.enum(['urn', 'name', 'description', 'pk', 'content']))
    .optional()
    .describe('Force these fields (overrides the smart-sniff). Omit to auto-detect.'),
  limit: z.number().optional().describe('Max results (default 20, max 200).'),
  scope: z.string().optional().describe('Spec 049: run the memory + node slices under a named scope (a scope id / name, "app", or "global"). Omitted: the ladder applies (active scope › active App › active organization) and the result says which.'),
};

export const SHAPE_HADRON_SET_ACTIVE_MEMORY = {
  memoryUrn: z.string().describe('Memory URN, e.g. hrn:mem:hadronmemory.com:dev (bare hadronmemory.com:dev also accepted). Legacy hrn:memory: and :: forms still resolve.'),
};

// #2661 / #2260: immutable, principal-independent parameter schemas are shared.
export const SHAPE_HADRON_RECORD_CONTENT_VALIDATION = {
  nodeRef: z.string().min(1).describe('The node reported on: its id or fully-qualified node URN.'),
  nodeRevision: z.number().int().min(1).describe('The node revision the validation task ran on.'),
  validationTaskRef: z.string().min(1).describe("The validation task the node's role rule names now: its id or node URN."),
  validationTaskRevision: z.number().int().min(1).describe('The task revision that ran.'),
  outcome: z.enum(['PASS', 'FAIL', 'ERROR']).describe('PASS, FAIL, or ERROR when the task could not be run to a verdict.'),
  runId: z.string().min(1).max(200).optional().describe('Your own label for this run (1-200 characters); makes a retry idempotent. Never an identity.'),
  // #1332 (Xanthos FIT 6670593797, Xavier #81384): the recorder owns its session argument, so a
  // refused session is judged after the not-found and writer refusals (cor:dmo:160:01), not by
  // the #1701 gate before them.
  session: z.string().optional().describe('Your worker session id, to record the report as that worker. A session that is not one of your open sessions is refused [session_not_bound] after the read and write checks; nothing is written.'),
};

export const SHAPE_HADRON_CREATE_APP_MEMORY = {
  app: z.string().describe('App ID or URN.'),
  name: z.string().min(1).describe('Memory name; determines its slug.'),
  shortDescription: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
};

export const SHAPE_HADRON_CREATE_MEMORY = {
  name: z.string().min(1).describe('Memory name; its slug becomes the URN tail (e.g. "My Notes" -> my-notes).'),
  memoryClass: z
    .enum(['knowledge', 'group', 'personal', 'private'])
    .optional()
    .describe("Memory class (default 'knowledge'). personal/private are owner-only; knowledge/group are organization-shared and need `org`."),
  org: z
    .string()
    .optional()
    .describe('Organization URN or id to create it in. Omit for a user-owned personal/private memory in your own namespace.'),
  shortDescription: z.string().optional().describe('One-line description.'),
  description: z.string().optional().describe('Longer description.'),
  tags: z.array(z.string()).optional().describe('Tags.'),
  visibility: z
    .enum(['PUBLIC', 'ORGANIZATION', 'GROUP'])
    .optional()
    .describe("Knowledge memories: PUBLIC or ORGANIZATION (default). A group memory is always GROUP. personal/private take none."),
};

export const SHAPE_HADRON_SET_ACTIVE_APP = {
  app: z
    .string()
    .describe(
      "App URN or unambiguous App name. Pass the URN form for guaranteed match; pass the display name when it is unique across your Apps.",
    ),
};

export const SHAPE_HADRON_SET_ACTIVE_ORG = {
  org: z
    .string()
    .optional()
    .describe('Organization URN (hrn:org:<root>) or id. Must be one you are a member of; a foreign or nonexistent org reads the same (org_not_found), with your memberships listed.'),
  clear: z
    .boolean()
    .optional()
    .describe('true = drop the explicit selection (the ladder then falls through to your active App / single membership). Ignored when org is passed.'),
};

export const SHAPE_HADRON_GET_RECOVERY_NODE = { nodeRef: z.string().describe('Stable node ID or qualified node URN.') };

export const SHAPE_HADRON_RESTORE_NODE = { nodeRef: z.string().describe('Stable node ID or qualified node URN.') };

export const SHAPE_HADRON_LIST_SCOPES = {
  app: z.string().optional().describe('App URN or id whose context to list. Defaults to the active App.'),
  ownerType: z.enum(['ORGANIZATION', 'AGENT', 'APP']).optional().describe('With ownerRef: list one owner\'s scopes instead of an App context.'),
  ownerRef: z.string().optional().describe('URN or id of the owner (with ownerType).'),
  name: z.string().optional().describe('Only scopes with exactly this name.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
};

export const SHAPE_HADRON_CREATE_SCOPE = {
  name: z.string().describe('The scope name.'),
  memoryUrns: z.array(z.string()).min(1).describe('The ORDERED memory list — fully-qualified memory URNs (hrn:mem:<root>:<slug>) or ids.'),
  description: z.string().optional().describe('What this lens is for — shown wherever the scope is shown.'),
  organizationRef: z.string().optional().describe('Own it by this organization (URN or id).'),
  agentRef: z.string().optional().describe('Own it by this Agent (URN or id) — travels with the Agent\'s installs.'),
  appRef: z.string().optional().describe('Own it by this App (URN or id). Default when no owner is passed: the active App.'),
};

export const SHAPE_HADRON_UPDATE_SCOPE = {
  scope: z.string().describe('The scope id (from hadron_list_scopes).'),
  name: z.string().optional(),
  description: z.string().optional(),
  memoryUrns: z.array(z.string()).min(1).optional().describe('The NEW ordered list — replaces, never merges.'),
};

export const SHAPE_HADRON_DELETE_SCOPE = { scope: z.string().describe('The scope id.') };

export const SHAPE_HADRON_SCOPE_EXPLAIN = {
  scope: z.string().optional().describe('The scope id. Or pass name.'),
  name: z.string().optional().describe('A scope NAME, resolved in the App\'s context.'),
  app: z.string().optional().describe('The App context for a name (URN or id). Defaults to the active App.'),
  loc: z.string().optional().describe('An address: report which memory in the scope would win for it.'),
};

export const SHAPE_HADRON_LIST_CHANNELS = {
  app: z.string().optional().describe('App URN or id. Defaults to the active App.'),
  memory: z.string().optional().describe('Or: one host memory (URN or id).'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
};

export const SHAPE_HADRON_CREATE_CHANNEL = {
  memory: z.string().describe('Host memory (URN or id) — any class you may write.'),
  loc: z.string().describe('The reserved address, e.g. chats:release.'),
  name: z.string().describe('The Channel name.'),
  description: z.string().optional().describe('What the Channel is for.'),
};

export const SHAPE_HADRON_REGISTER_LIST = {
  owner: z.string().optional().describe('An App or organization (URN or id). Defaults to the active App.'),
  channel: z.string().optional().describe('Only rows for this Channel (its id or address).'),
  attendee: z.string().optional().describe('Only rows naming this Worker or Agent (URN or id).'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
};

export const SHAPE_HADRON_REGISTER_ADD = {
  channel: z.string().describe('The Channel — its id, or its address (the chat root node URN hadron_list_channels prints). Copy one of those; a ref naming nothing reads as a Channel you may not see.'),
  attendee: z.string().optional().describe('A Worker or Agent (URN or id). Omit = every attendee in the owner\'s context.'),
  owner: z.string().optional().describe('An App or organization (URN or id). Defaults to the active App.'),
  role: z.enum(['WATCH', 'POST', 'BOTH']).optional().describe('Default BOTH.'),
  mentionOnly: z.boolean().optional().describe('Only messages mentioning the attendee count as new for it.'),
  description: z.string().optional().describe('Why — the human\'s intent.'),
};

export const SHAPE_HADRON_REGISTER_REMOVE = { entry: z.string().describe('The register entry id (from hadron_register_list).') };

export const SHAPE_HADRON_SET_ACTIVE_SCOPE = {
  scope: z.string().optional().describe('A scope id, or a scope NAME resolved in the active App\'s context (App › Agent › organization). See hadron_list_scopes.'),
  clear: z.boolean().optional().describe('true = drop the selection; the ladder falls through to the active App / organization.'),
};

export const SHAPE_HADRON_CREATE_PARENT_NODE = {
  authoredWith: AUTHORED_WITH_ARG,
  urn: z.string().describe('Fully-qualified node URN for the new section, e.g. "hrn:node:acme.com:mmdata:services" or "hrn:node:acme.com:mmdata:services:db-helpers"'),
  name: z.string().optional().describe('Display name (defaults to the last loc atom)'),
  description: z.string().optional().describe('What this section contains'),
  tags: tagsInputSchema.optional(),
};

export const SHAPE_HADRON_FIND_NODES = {
  query: z.string().describe('For mode:keyword (default) / mode:hybrid — a full-text query: stemmed terms ranked by relevance, with boolean operators `(a OR b) AND c`, quoted phrases, and `-term` / `NOT`. For mode:vector / mode:hybrid — also embedded and matched semantically against the memory\'s vector index. For mode:regex — a POSIX regular expression. Use "*" or "" to list all nodes (survey mode; rejected for mode:vector / mode:hybrid).'),
  mode: z.enum(['keyword', 'vector', 'hybrid', 'regex']).optional().describe('keyword (default): full-text search — stemmed, relevance-ranked, boolean operators, body + abstract indexed. vector: semantic search over the memory\'s vector index (requires vectorIndexEnabled). hybrid: keyword + vector fused by reciprocal-rank fusion (RRF, k=60). regex: POSIX regular-expression match over node text. On a non-indexed memory, mode:hybrid degrades to keyword-only and emits a [degraded:no_vector_index] note. Spec 033 + cor:api:090.'),
  parentRel: z.string().optional().describe('Scope search to this subtree'),
  memoryUrn: z.string().optional().describe('Scope search to a single memory (fully-qualified URN). Omit to search all memories you can read — see allMemories.'),
  memoryUrns: z.array(z.string()).min(1).optional().describe('Scope search to this SET of memories (each a fully-qualified memory URN, hrn:mem:<root>:<slug>) — a targeted multi-memory search. Must be non-empty (for "everything", use allMemories). Mutually exclusive with memoryUrn and allMemories.'),
  allMemories: z.boolean().optional().describe('Search across ALL memories you can read — the org-wide "does anyone know about X?" probe (stemmed + relevance-ranked in keyword mode). The explicit, self-documenting form of omitting a memory scope. Mutually exclusive with memoryUrn / memoryUrns.'),
  hasOpenThreads: z.boolean().optional().describe('#3494 — NodeFilter.hasOpenThreads: true selects nodes with live open root comments, false selects nodes with none, omitted leaves the filter off. Applies before ranking/paging in every mode, with existing access and content scope. Deleted stubs do not count. Inherited projections have zero summary. Timestamp is GraphQL-only; hit output is unchanged.'),
  isRunnable: z.boolean().optional().describe('Filter by runnable status (applies in every mode). true = only task nodes (Node.isRunnable=true) — the canonical "tasks I can run" predicate hadron_run_task gates on. false = only nodes explicitly marked non-runnable (most nodes leave it NULL, so false does NOT include them). Omit to ignore runnable status. Spec cor:api:060.'),
  role: z.string().optional().describe('Filter by Node.role family in every mode. Segment-boundary prefix semantics: "spec" matches "spec" and dotted descendants such as "spec.rule", but never "special" or "specification" (#1322). Node.role remains an open string; this is a query filter, not role validation.'),
  nodeType: z.string().optional().describe('#331 — exact-match node-type facet (free-form, e.g. "task" / "parent" / "info"): only nodes whose nodeType equals this. Applies in every mode; with query "*" it lists all nodes of one type. Orthogonal to objectType. Without it, system and chat-message nodes stay excluded (name "chat-message" to search chat messages; record nodes are never excluded); "comment" searches comments as the engine documents. Negation and multi-value are not supported here; use nodeTypes for a list of types.'),
  objectType: z.string().optional().describe('#725 — collection facet: only nodes whose objectType equals this (the domain-object discriminator, e.g. "competitor" / "insight"). Orthogonal to nodeType. Composes with query/mode + where.'),
  nodeTypes: z.array(z.string()).nullish().describe('#3113 — an explicit LIST of node types (GraphQL: NodeFilter.nodeTypes; null is the same as omitted), a union: only nodes whose nodeType is one of them. Applies in every mode. It narrows, ANDs the other filters and, being explicit, replaces the default that leaves out system and chat-message nodes; it never lifts the memory-class default, access, deleted rows or inheritance. Values are exact and case-sensitive; an unknown value matches nothing. Refused: an empty list, nodeType together with nodeTypes, more than 20 entries (counted before duplicates are dropped), and a list containing "comment" (search comments with nodeType or nodeKind). Vector and hybrid keep their bounded, widening candidate window.'),
  nodeKind: z.enum(['CONTENT', 'COMMENTS', 'ALL']).optional().describe('#1608/#1678 — which KIND of node to search (GraphQL: NodeFilter.contentScope). CONTENT (default): content nodes only. COMMENTS: comment nodes only (feedback about other nodes), found exhaustively in every mode before ranking and limits. ALL: both. A comment hit is labelled COMMENT and is never content of, or verified fact about, its target. Not hadron_get_node\'s contentScope, which picks the parts of one node to return.'),
  childrenOf: z.string().optional().describe('#2832 — list only the DIRECT children of this loc (GraphQL: NodeFilter.childrenOf). A direct child is a node whose loc is exactly this loc plus one more segment (no further colon); "" means the top-level nodes. It reads loc strings only (not edges, not parentRel), so a loc whose parent has no node of its own is still listed. Applies in every mode, with the same access and default exclusions as the rest of the search, and pairs with memoryUrn (loc is per memory). With no query and no sort the order is the sibling order (positioned nodes first, then by loc). Unlike parentRel, which scopes the WHOLE subtree.'),
  scope: z.string().optional().describe('Spec 049: search under a named scope — a scope id, a scope NAME (resolved in the active App\'s context), "app" (the active App\'s attached memories), or "global" (your active organization\'s view). Omitted with no memory selector: the ladder applies (active scope › active App › active organization), and the result says which. An explicit memoryUrn / memoryUrns / allMemories outranks the ambient scope but still intersects with one named here.'),
  brief: z.boolean().optional().describe('Return index info only: name, description, edges'),
  limit: z.number().int().optional().describe('Max primary results: integer clamped to 1–200 (default 10 for a query; 20 for survey mode "*"/""). Expansion neighbors are additional.'),
  minScore: z.number().optional().describe('Absolute relevance floor: drop hits scoring below this. Scores are NOT comparable across modes — keyword ranks run roughly 0..a-few, vector cosine similarity is 0..1, hybrid is a small RRF fraction — so read the (score …) values in a first unfiltered call, then set a floor for the mode in use. Prefer this (or a narrower query) over reading a long tail of weak hits. Returns fewer hits, never weaker ones; does not apply to survey mode.'),
  expand: z.number().int().min(0).max(3).optional().describe('Append undirected graph neighbors (all edge types) within depth N AFTER the ranked hits, unscored. Default 0 (no expansion). Max 3. Useful for context-stuffing — the ranked nodes plus their immediate graph context in one tool call. Spec 033 FR-020.'),
  granularity: z.enum(['node', 'chunk']).optional().describe('node (default): one entry per matching node, ranked by best-chunk similarity for content-chunk indexes. chunk: return matching passages (span text + character offsets + chunk index + parent node URN), useful for RAG context-stuffing. **chunk requires mode:vector** — hybrid + chunk is out of v1 (the design call for how RRF fuses with passage-level results was deferred). Spec 033 US2 FR-022.'),
  where: z.record(z.string(), z.unknown()).optional().describe('Structured predicate over a node\'s `properties`/`data` JSONB (#719) — filters, then the chosen mode ranks the survivors (composes with keyword/vector/hybrid/regex and survey/browse). A node is EITHER a branch (exactly one of `and`/`or`/`not`) OR a leaf: a `path` (array of JSON keys, e.g. ["sourceKind"]) plus exactly ONE operator — eq | ne | in | lt | lte | gt | gte | between | exists | contains. `field`: "properties" (default) | "data". `as`: "text" (default) | "number" | "datetime" | "boolean" — number/datetime route through DB guards so unparseable values drop the row (never an error); `contains` is jsonb @> containment. Bounded: depth ≤ 4, ≤ 32 leaves, path ≤ 8. Example: {"and":[{"path":["sourceKind"],"eq":"substack"},{"path":["extractedAt"],"as":"datetime","gte":"2026-07-04T00:00:00Z"}]}'),
};

export const SHAPE_HADRON_GET_NODE = {
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:architecture" (legacy :: forms still accepted), or an action URN "hrn:action:<root>:<agent-slug>:<code>" — the register entry\'s second address'),
  contentScope: z
    .enum(['content', 'abstract', 'all'])
    .optional()
    .describe("Selects what the response includes. 'content' (default): meta block + body, with abstract substituted into the body slot when content is null/empty (Source: abstract-fallback line appears). 'abstract': meta block + abstract, no body. 'all': meta block + abstract + body."),
  raw: z
    .boolean()
    .optional()
    .describe('Return the stored text with include tags ({{> loc}}) as written instead of resolving them (cor:dmo:150:03). Default false: includes resolve with your own read access.'),
};

export const SHAPE_HADRON_GET_NODES = {
  refs: z
    .array(z.string())
    .optional()
    .describe('Explicit-set form: node references, each a primary key OR a fully-qualified node URN (hrn:node:<root>:<memory>:<loc>). Returned in input order. Mutually exclusive with memoryUrn/locPrefix.'),
  memoryUrn: z
    .string()
    .optional()
    .describe('Prefix form: fully-qualified memory URN to read from. Use together with locPrefix.'),
  locPrefix: z
    .string()
    .optional()
    .describe('Prefix form: return every readable node whose loc starts with this prefix (loc order). Use together with memoryUrn.'),
  contentScope: z
    .enum(['content', 'abstract', 'all'])
    .optional()
    .describe("Per-node projection scope, as on hadron_get_node. Default 'content'."),
  raw: z
    .boolean()
    .optional()
    .describe('Return the stored text with include tags ({{> loc}}) as written instead of resolving them (cor:dmo:150:03). Default false: includes resolve with your own read access.'),
};

export const SHAPE_HADRON_GET_NEXT_NODE = {
  parent: z.string().describe('Fully-qualified parent node URN, e.g. "hrn:node:acme.com:mmdata:sections"'),
  current: z.string().optional().describe('Fully-qualified current child node URN (must be in the same memory as `parent`)'),
  raw: z
    .boolean()
    .optional()
    .describe('Return the stored text with include tags ({{> loc}}) as written instead of resolving them (cor:dmo:150:03). Default false: includes resolve with your own read access.'),
};

export const SHAPE_HADRON_LIST_NODES = {
  parentRel: z.string().optional().describe('Parent loc (for example notes:ideas) with memoryUrn, or a fully qualified hrn:node: parent URN. If both references are provided, they must name the same memory. A bare loc without memoryUrn searches discovery scope only; use an explicit reference for your personal/private memories. Omit to list from memory root.'),
  memoryUrn: z.string().optional().describe('Fully qualified Memory URN. Scopes a bare parentRel; required when parentRel is omitted. No active-memory fallback.'),
  depth: z.number().optional().describe('Max depth to traverse (default: 1)'),
  isRunnable: z.boolean().optional().describe('Filter the tree to runnable status. true = only task nodes (Node.isRunnable=true) — the canonical "tasks I can run" predicate hadron_run_task gates on. false = only nodes explicitly marked non-runnable (most nodes leave it NULL, so false does NOT include them). Omit to list every node. Spec cor:api:060.'),
};

export const SHAPE_HADRON_UNLOCK_MEMORY = {
  memoryUrn: z.string().describe('Memory URN or id'),
  passphrase: z.string().optional().describe('The passphrase the memory was encrypted with'),
  dataKey: z.string().optional().describe('Raw base64 32-byte data key (alternative to passphrase)'),
};

export const SHAPE_HADRON_LOCK_MEMORY = { memoryUrn: z.string().describe('Memory URN or id') };

export const SHAPE_HADRON_CREATE_NODE = {
  authoredWith: AUTHORED_WITH_ARG,
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:review:sort-imports". Both bare and prefixed forms accepted, in either URN grammar. Relative-form URNs (no memory) are rejected.'),
  name: z.string().describe('Node name'),
  nodeType: z.string().optional().describe('Node classification (free-form; canonical values: abstract, chat, data, info (default), prompt, record, reference, system). Running is gated by isRunnable, independent of nodeType.'),
  objectType: z.string().optional().describe('#725 — collection this node belongs to (the domain-object discriminator, e.g. "competitor" / "insight"), orthogonal to nodeType. On a memory with a property schema, it MUST name a declared collection and the node\'s properties are validated against it; free-form on an unschema\'d memory. Omit for an ordinary node.'),
  isRunnable: z.boolean().optional().describe('#1201 — REFUSED on this tool if true: a write producing a runnable node must go through hadron_create_task, because authoring something the platform will EXECUTE is not the same act as writing prose. Accepted only as false/omitted (the default). Independent of nodeType — a runnable node may carry any nodeType.'),
  role: z.string().optional().describe('#1201/#1322 — what this node is FOR (open string). NOT nodeType (the platform-kind axis) and NOT objectType (the collection discriminator); role does not affect default ranking, though hadron_find_nodes can filter by its dotted family. Most values are inert, but the GOVERNED families — "review" / "review.*", "spec" / "spec.*" and "question" / "question.*" — are refused on this tool. Use hadron_create_review for a review; a spec is authored with the `hadron spec` CLI, its only authoring surface; a question is asked with the GraphQL askQuestion operation (#1641). The same applies to isRunnable — this tool cannot create a runnable node; use hadron_create_task.'),
  description: z.string().optional().describe('Short description'),
  abstract: z.string().optional().describe('Paragraph-length summary (max 2000 chars). Opt-in on hadron_get_node via the contentScope parameter. (hadron_find_nodes preview surfacing of abstract ships in spec 031 US2 — not yet live.) Empty + whitespace-only values normalize to null. Spec 031.'),
  content: z.string().optional().describe('Markdown content'),
  seq: z.number().optional().describe('Sort order among siblings (lower values first)'),
  tags: tagsInputSchema.optional().describe('Tags'),
  properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
  data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config)'),
  llmModel: z.string().optional().describe('LLM model used (e.g. claude-opus-4-6)'),
  aiAgent: z.string().optional().describe('AI agent tool used (e.g. claude-code, cursor)'),
  edges: z.array(z.object({
    targetUrn: z.string().describe('Target node fully-qualified URN'),
    name: z.string().optional().describe('Relationship name (was "label"), e.g. depends-on, documents'),
    loc: z.string().optional().describe('Explicit edge loc. Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
    description: z.string().optional().describe(EDGE_DESCRIPTION_DOC),
    isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task/conversation flows)'),
  })).optional().describe('Outgoing edges (replaces the full set on the source node)'),
  install: z.object({
    app: z.string().describe('The App: its ID or fully-qualified URN.'),
    agent: z.string().describe('The Agent the App customises: its ID or fully-qualified URN.'),
  }).optional().describe('#2044 — write into an App\'s INSTALL MEMORY (where it keeps its customisation of an installed Agent, cor:agt:040:06) instead of a memory named by `urn`. When set, `urn` is just the node\'s LOC (e.g. "prompts:lane"), not a URN. The first create finds-or-creates the install memory in the same step as the write; later calls reuse it. Only whoever manages the App may write, while the App is live and the Agent installed. Not supported with `edges`, `isRunnable` or `abstractStillAccurate`.'),
};

export const SHAPE_HADRON_UPDATE_NODE = {
  authoredWith: AUTHORED_WITH_ARG,
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:review:sort-imports"'),
  expectedRevision: z.number().int().positive().max(2_147_483_647).optional().describe('Optional positive Revision value from hadron_get_node. A mismatch refuses with [node_write_conflict]; omit for backward-compatible last-write-wins behavior.'),
  name: z.string().optional().describe('New node name'),
  nodeType: z.string().optional().describe('Node classification (free-form; canonical values: abstract, chat, data, info (default), prompt, record, reference, system). Changing nodeType does NOT change isRunnable or properties (e.g. claudeSkill) — a retyped runnable node stays runnable until you clear isRunnable yourself. Running is gated by isRunnable, not nodeType.'),
  objectType: z.string().optional().describe('#725 — collection this node belongs to (e.g. "competitor" / "insight"), orthogonal to nodeType. On a schema-governed memory it must name a declared collection and the resulting properties are validated against it. Omit to preserve.'),
  isRunnable: z.boolean().optional().describe('#1201 — REFUSED on this tool: making a node runnable, and RETIRING a runnable one, both go through hadron_update_task. Editing a node that is already runnable is refused here too, whatever this field says, because the result is still a runnable node. Omit to preserve. Independent of nodeType — retyping the node never changes this flag.'),
  role: z.string().nullable().optional().describe('#1201/#1322 — what this node is FOR (open string). NOT nodeType and NOT objectType. Omit to preserve; null to clear. GOVERNED families ("review" / "review.*", "spec" / "spec.*", "question" / "question.*") are refused here — use hadron_update_review, the `hadron spec` CLI for a spec, or the question operations (amendQuestion, …) for a question — and so is EDITING a node that already carries one — the gate reads the resulting state, not the change — because a governed node must not be rewritable through the generic surface.'),
  description: z.string().optional().describe('New short description'),
  abstract: z.string().nullable().optional().describe('New paragraph-length summary (max 2000 chars). Pass `null` to clear; omit to preserve. Empty + whitespace-only normalize to null. Surfaced on hadron_get_node via contentScope; hadron_find_nodes preview surfacing ships in spec 031 US2. STALENESS: the abstract is fingerprinted against the content AS OF THIS CALL, so passing `abstract` and `content` TOGETHER keeps them in sync and needs no ordering. If you instead change `content` in a LATER call, this abstract is marked `abstract-stale` on read until you re-save it (re-sending the identical text is enough) or assert `abstractStillAccurate`. It also arms for an abstract that was NEVER fingerprinted — one saved against an empty node, where a body arrived later (#1128). Read the ABSENCE of the marker narrowly: it means "checked against this exact content" ONLY on a read that could have shown it — `contentScope` of `abstract` or `all`, on a memory that is unencrypted or unlocked. Under the default `content` scope, or on a locked memory, no marker is emitted either way and its absence says nothing at all. Spec 031/032.'),
  content: z.string().nullable().optional().describe('New markdown content. Pass `null` to clear; omit to preserve. Spec 032 widened the schema from string-only to allow null per the consistent partial-update convention; clearing content interacts with abstractOriginHash maintenance (FR-006/FR-007). Changing content WITHOUT also passing `abstract` arms the `abstract-stale` marker on this node — that is intended (the abstract was written against the old content and may no longer describe it). Pass both together, or assert `abstractStillAccurate` if you have re-read the abstract and it survives the edit.'),
  abstractStillAccurate: z.boolean().optional().describe('ASSERTION, NOT A SETTING — and it SUPPRESSES A CORRECTNESS CHECK. Setting this true tells the server you have RE-READ the existing abstract against the content this call is writing and it still describes it, so the `abstract-stale` marker is cleared instead of armed. It changes no text: it only re-fingerprints the abstract you already have. Do NOT set it to make a marker go away, to save a call, or by default — the marker exists to catch an abstract that quietly stopped matching its node, and this is the one flag that can hide exactly that. If you have not actually compared the two, OMIT IT: a stale marker on an accurate abstract is cheap and self-correcting, a suppressed marker on an inaccurate one is neither, and it misleads every later reader and every RAG hit. Ignored when `abstract` is also supplied (that path already re-fingerprints) or when the node has no abstract. CONCURRENCY — it binds to NEITHER half: it re-fingerprints whatever abstract is STORED when this write lands, against the `content` you pass here — or, if you omit it, the body as this call read it before the write. The two halves fail in OPPOSITE directions: a concurrent ABSTRACT swap is certified unseen and the marker is suppressed on text you never read, whereas a concurrent CONTENT change leaves the stored hash disagreeing with the row, so the marker stays armed: the hash IS written, it just lands on the wrong body, and the one thing you wanted — clearing the marker — does not happen. Neither side is checked against what you read. The fully-bound form needs no flag at all — pass `abstract` AND `content` together and you are writing exactly the two things you compared. Prefer that whenever the node might have another writer; use this flag when re-sending the abstract is not worth it and you accept that trade.'),
  seq: z.number().optional().describe('New sort order among siblings'),
  tags: tagsInputSchema.optional().describe('Replace tags'),
  properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
  data: z.record(z.string(), z.unknown()).nullable().optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config). REPLACES the whole data bag; null clears it and omission preserves it. To merge in a few keys while preserving the rest, use hadron_update_node_data instead.'),
  llmModel: z.string().optional().describe('LLM model used'),
  aiAgent: z.string().optional().describe('AI agent tool used'),
  edges: z.array(z.object({
    targetUrn: z.string().describe('Target node fully-qualified URN'),
    name: z.string().optional().describe('Relationship name (was "label"), e.g. depends-on, documents'),
    loc: z.string().optional().describe('Explicit edge loc. Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
    description: z.string().optional().describe(EDGE_DESCRIPTION_DOC),
    isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task/conversation flows)'),
  })).optional().describe('REPLACES the node\'s ENTIRE outgoing edge set — it does NOT merge. Any existing edge you do not re-supply here is DELETED, silently and without a diff. Unlike every other argument on this tool (omit `content` and content is preserved, omit `tags` and tags are preserved), omitting an edge does not preserve it. To change ONE edge, use hadron_update_edge instead; to add one without touching the others, use hadron_create_edge. If you must use this argument, read the node first and re-supply every edge you want to keep.'),
  reason: z.string().optional().describe('Why this change was made (stored in revision history)'),
  install: z.object({
    app: z.string().describe('The App: its ID or fully-qualified URN.'),
    agent: z.string().describe('The Agent the App customises: its ID or fully-qualified URN.'),
  }).optional().describe('#2044 — write into an App\'s INSTALL MEMORY (where it keeps its customisation of an installed Agent, cor:agt:040:06) instead of a memory named by `urn`. When set, `urn` is just the node\'s LOC (e.g. "prompts:lane"), not a URN. The first create finds-or-creates the install memory in the same step as the write; later calls reuse it. Only whoever manages the App may write, while the App is live and the Agent installed. Creates nothing: the memory exists once the first hadron_create_node with `install` has run. Not supported with `edges`, `isRunnable` or `abstractStillAccurate`.'),
};

export const SHAPE_HADRON_UPDATE_NODE_DATA = {
  authoredWith: AUTHORED_WITH_ARG,
  nodeUrn: z.string().describe('Node to update — a fully-qualified node URN (hrn:node:<root>:<memory>:<loc>) or an ID-shape PK.'),
  data: z.record(z.string(), z.unknown()).describe('JSON object to merge into the node\'s `data`. Must be an object (not an array or scalar). Its top-level keys overwrite existing ones; unmentioned keys are preserved.'),
};

export const SHAPE_HADRON_CREATE_OBJECT = {
  memoryUrn: z.string().describe('Memory to create the object in — a fully-qualified URN (hrn:mem:<root>:<slug>) or an ID.'),
  type: z.string().describe('The collection this object belongs to (e.g. "competitor"). A single segment (no ":").'),
  fields: z.record(z.string(), z.unknown()).describe('The object\'s flat fields (typed properties). "id"/"type" are reserved.'),
  key: z.string().optional().describe('Optional natural id → a human-meaningful loc (<type>:<key>); a single segment (no ":"). Omit for an auto-generated id.'),
  name: z.string().optional().describe('Optional display name for the underlying node (defaults to a name/title field, else the type).'),
};

export const SHAPE_HADRON_GET_OBJECT = {
  ref: z.string().describe('Object id (or a fully-qualified node URN).'),
};

export const SHAPE_HADRON_UPDATE_OBJECT = {
  ref: z.string().describe('Object id (or a fully-qualified node URN).'),
  fields: z.record(z.string(), z.unknown()).describe('Fields to merge in. "id"/"type" are reserved.'),
  reason: z.string().optional().describe('Optional rationale, recorded in revision history.'),
};

export const SHAPE_HADRON_DELETE_OBJECT = {
  ref: z.string().describe('Object id (or a fully-qualified node URN).'),
  hard: z.boolean().optional().describe('Permanently remove the row (default false = soft delete).'),
};

export const SHAPE_HADRON_FIND_OBJECTS = {
  memoryUrn: z.string().describe('Memory to query — a fully-qualified URN (hrn:mem:<root>:<slug>) or an ID.'),
  type: z.string().describe('The collection to query (e.g. "competitor").'),
  match: z.record(z.string(), z.unknown()).optional().describe('Equality shorthand: { field: value, ... } → an AND of eq predicates (cast inferred from the schema).'),
  where: z.record(z.string(), z.unknown()).optional().describe('Full #719 structured predicate over the object\'s fields (ANDed with match).'),
  sort: z.record(z.string(), z.unknown()).optional().describe('Single-field sort: { field: "asc" | "desc" }, e.g. { "fundingUsd": "desc" }.'),
  limit: z.number().optional(),
  offset: z.number().optional(),
};

export const SHAPE_HADRON_REPLACE_TEXT = {
  authoredWith: AUTHORED_WITH_ARG,
  oldText: z.string().describe('Text to find (literal substring), or a regular-expression source when regex:true. Must be non-empty.'),
  newText: z.string().describe('Replacement text. May be empty to delete the matched text. In regex mode, $1/$<name>/$& are honored.'),
  nodeUrns: z.array(z.string()).optional().describe('Explicit nodes to edit — fully-qualified node URNs (hrn:node:<root>:<memory>:<loc>) or ID-shape values.'),
  memoryUrns: z.array(z.string()).optional().describe('Edit every live node in these memories — fully-qualified memory URNs (hrn:mem:<root>:<slug>) or ID-shape values. At least one of nodeUrns / memoryUrns is required.'),
  prefix: z.string().optional().describe("Restrict the memoryUrns selection to a subtree: the node at this loc plus its descendants. Requires memoryUrns (loc is only unique within a memory)."),
  fields: z.array(z.enum(['content', 'name', 'alias', 'description', 'abstract', 'tags']))
    .describe('Which text fields to search. At least one required.'),
  caseInsensitive: z.boolean().optional().describe('Match case-insensitively (default false).'),
  regex: z.boolean().optional().describe('Treat oldText as a regular-expression source and newText as a replacement pattern (default false).'),
  dryRun: z.boolean().optional().describe('Preview only: report per-node match counts WITHOUT writing anything. Strongly recommended before a real run.'),
};

export const SHAPE_HADRON_CREATE_EDGE = {
  sourceUrn: z.string().describe('Source node, as an ID-shape PK (preferred — immutable across move/rename) OR a fully-qualified URN, e.g. "hrn:node:acme.com:mmdata:services:db-helper". The source node must already exist; this tool will not create it.'),
  targetUrn: z.string().describe('Target node, as an ID-shape PK (preferred) OR a fully-qualified URN. The target must already exist; use hadron_create_node first if it does not.'),
  name: z.string().optional().describe('Relationship name (was "label"), e.g. "depends-on", "documents", "supersedes". Optional — loc is the identity.'),
  loc: z.string().optional().describe('Explicit edge loc (its identity + URN suffix hrn:edge:<root>:<memory>:<loc>). Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
  description: z.string().optional().describe(EDGE_DESCRIPTION_DOC),
  isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task automation, conversation transitions).'),
};

export const SHAPE_HADRON_UPDATE_EDGE = {
  edgeRef: z.string().describe('Edge to update, as an ID-shape PK (preferred — immutable) OR a fully-qualified edge URN.'),
  name: z.string().nullable().optional().describe('New relationship name, e.g. "depends-on". Pass null to clear it.'),
  loc: z.string().optional().describe('New edge loc (its identity + URN suffix). Changing this changes the edge URN.'),
  description: z.string().nullable().optional().describe(`${EDGE_DESCRIPTION_DOC} Pass null to clear it.`),
  isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed.'),
  priority: z.number().int().optional().describe('Routing priority among sibling edges. Must be an integer.'),
  condition: z.record(z.string(), z.unknown()).nullable().optional().describe('JSONLogic routing condition evaluated when the walker picks an outgoing edge. Pass null to clear it (an unconditional edge).'),
  data: z.record(z.string(), z.unknown()).nullable().optional().describe('Structured data carried on the edge. REPLACES the stored object; pass null to clear it.'),
};

export const SHAPE_HADRON_DELETE_EDGE = {
  edgeRef: z.string().describe('Edge to delete, as an ID-shape PK OR a fully-qualified edge URN.'),
};

export const SHAPE_HADRON_DELETE_NODE = {
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:review:sort-imports".'),
  hard: z.boolean().optional().describe('Default false (soft-delete). Pass true to delete the row entirely; cascades to Edge and NodeRevision via FK and explicitly cleans up PendingEdge target-side rows. Irreversible.'),
  recursive: z.boolean().optional().describe('Default false (refuses with descendants). Pass true to apply the same soft/hard mode to every descendant under the node\'s URN prefix.'),
  cascadeCrossMemoryEdges: z.boolean().optional().describe('Hard-delete only; default false. Pass true to acknowledge that hard-deleting will remove edges whose other endpoint lives in a different memory (the other memory\'s view loses them silently).'),
};

export const SHAPE_HADRON_MOVE_NODE = {
  authoredWith: AUTHORED_WITH_ARG,
  urn: z.string().describe('Current node fully-qualified URN, e.g. "hrn:node:acme.com:mmdata:services:db-helper"'),
  targetUrn: z.string().describe('Destination node fully-qualified URN. Different memory in the target URN performs a cross-memory move.'),
  overwrite: z.boolean().optional().describe('Default false (refuses on collision). Pass true to soft-delete an existing live target node before moving; the move then proceeds into the freed URN slot.'),
  renameToLeaf: z.boolean().optional().describe("Default false — the node keeps its name. Pass true to also overwrite the moved node's name with the target loc's terminal atom (\"services:db-helper\" → \"db-helper\"). Destroys the existing display title, so only pass it when the name is meant to track the loc."),
};

export const SHAPE_HADRON_RUN_ACTION = {
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:actions:review"'),
  args: z.record(z.string(), z.string()).optional().describe('Action arguments as key-value pairs'),
};

export const SHAPE_HADRON_GET_RUN = {
  ref: z.string().describe('The run: its id, or its hrn:apprun:<root>:<app>:<run-id> URN (hadron_run_task prints the id).'),
};

export const SHAPE_HADRON_RUN_TASK = {
  task: z
    .string()
    .optional()
    .describe(
      'Loose name of the task to run (matched against runnable nodes by name/alias/loc/description).',
    ),
  memory: z
    .string()
    .optional()
    .describe('Loose memory name or URN to scope the search. Omit to use the active memory.'),
  urn: z
    .string()
    .optional()
    .describe('Fully-qualified node URN to run directly, skipping name resolution.'),
  args: z
    .record(z.string(), z.string())
    .optional()
    .describe('Task arguments as key-value pairs ({{key}} substitution).'),
  appRef: z
    .string()
    .optional()
    .describe(
      'App (PK or URN) to EXECUTE the task under (#529). When set, the server mints a MANUAL app run for the resolved task and returns the run id (poll the app-run status surface) instead of the rendered prompt. Omit to get the rendered instructions for you to run yourself.',
    ),
  runAsSelf: z
    .boolean()
    .optional()
    .describe('Attribute the executed run to the calling user (only with appRef).'),
  agentRef: z
    .string()
    .optional()
    .describe(
      "Agent (PK or URN) the executed run is served as (#2735). Only with appRef. Omit to use the App's single installed Agent; an App with several installed Agents refuses with RUN_AGENT_REQUIRED.",
    ),
};

export const SHAPE_HADRON_START_SESSION = {
  description: z.string().describe("What this session is about"),
  type: z.string().optional().describe('Session type: DEVELOPER, CHATBOT, AUTOMATION, EDGE'),
  repo: z.string().optional().describe('Repository being worked on (e.g. org/repo)'),
  branch: z.string().optional().describe('Git branch'),
  prNumber: z.number().optional().describe('Pull request number'),
  customerId: z.string().optional().describe('Customer ID for chatbot sessions'),
  language: z.string().optional().describe('Programming language'),
  llmModel: z.string().optional().describe('LLM model being used'),
  family: z.string().optional().describe('The model family this session runs as (cor:agt:060:04), e.g. claude, codex or glm. Omit to derive it from llmModel; a session nothing classifies gets no family, and its worker is not matched to queued tasks until one is given. A matching input only, never authorization.'),
  parentSessionId: z.string().optional().describe('Parent session ID'),
  prevSessionId: z.string().optional().describe('Previous session ID'),
  workerRef: z.string().optional().describe('The Worker (named casting) this session works as. Three forms resolve: the worker\'s NAME ("Iris" — unique within the App, case-insensitive, and what a human will say), its URN (hrn:worker:<root>:<app-slug>:<slug>), or its bare id. Prefer the name for a human-driven pickup; the URN when addressing a worker across App context. Must belong to this App; stamps the session\'s agentId from the casting and returns the worker\'s boot briefing.'),
  reportsTo: z.string().optional().describe('#1726 — the worker this worker reports to (its name in this App, URN or id), set in the same step as the bind, as a spawn brief would. Sets it only when the worker reports to nobody, or already to that worker; naming a different one refuses the bind (WORKER_REPORTS_TO_HELD) unless you manage the App. Omit to leave it unchanged.'),
  force: z.boolean().optional().describe('Take over a WORKER_TAKEN worker — one someone drove RECENTLY (#1114: a merely-open session no longer refuses, so if you are seeing this refusal the session is live rather than just unclosed). That open session may be someone else\'s live work, or your own left behind by a chat session that ended without ending it (ending a chat session never ends a worker session); the server cannot tell which, so neither should you assume. Use only on the user\'s explicit override, after showing who last drove it.'),
  launchGrant: z.string().optional().describe('#1709: the single-use launch grant your host gave you when it started you (cor:agt:070:08). Pass it with your holder\'s own credential; it binds the worker it names, so workerRef may be omitted. It cannot be combined with force.'),
};

export const SHAPE_HADRON_CREATE_RESUME_CLAIM = {
  session: z.string().describe('Your open worker session id (hadron_whoami lists it).'),
};

export const SHAPE_HADRON_RESUME_SESSION = {
  session: z.string().optional().describe('Pick one of a listed answer\'s sessions by its id. Omit on the first call.'),
  description: z.string().optional().describe('What the next session is about, used only when the redemption starts a new one (after a rotation).'),
  llmModel: z.string().optional().describe('LLM model: recorded on a session the redemption starts, and refreshed on an open session it resumes (never cleared when omitted).'),
  family: z.string().optional().describe('Model family (claude, codex, glm…): recorded on a session the redemption starts, and refreshed on an open session it resumes. Wins over the family the model implies; an invalid token is refused before a claim is spent.'),
};

export const SHAPE_HADRON_END_SESSION = {
  id: z.string().describe('Id of the session to end — a Hadron session id (the worker session id, when one is bound), never anything about your chat session'),
  summary: z
    .string()
    .optional()
    .describe(
      'A label on the session ROW, readable via the `session` / `sessions` GraphQL queries. It is NOT the continuity record: no worker-handoff path reads it, so the next driver of this worker never sees it (#1100). ' +
        'If you are writing something for whoever comes next, that is `handoff`. ' +
        'This used to be described as "Summary of what was accomplished", which is exactly what a departing worker thinks it is writing: choosing it succeeds, returns a normal receipt, and delivers nothing to anyone. ' +
        'The two mistakes are not symmetric. Putting continuity prose here produces NO handoff, and cannot be corrected afterwards — the sequence is append-only and the stint has ended, so the remedy is to bind again and end that session with the prose. Putting a label in `handoff` is merely untidy: the label is missing from the row and the prose reaches the next driver anyway.',
    ),
  handoff: z
    .string()
    .optional()
    .describe(
      'The closing handoff for this worker: prose the NEXT worker session bound to this worker receives at bind. Worker-bound sessions only.',
    ),
  resumeClaim: z
    .boolean()
    .optional()
    .describe(
      '#1956: also write a RESUME CLAIM, with the handoff and before the end, so the fresh context after this rotation recovers the worker with the CLI (`hadron team session start`, no --as). Single use, 60 seconds, redeemable only by you. Your own worker session only.',
    ),
  inputTokens: z.number().optional().describe('Total input tokens used'),
  outputTokens: z.number().optional().describe('Total output tokens used'),
  turnCount: z.number().optional().describe('Number of conversation turns'),
  errorCount: z.number().optional().describe('Number of errors encountered'),
};

export const SHAPE_HADRON_WHOAMI = {
  app: z.string().optional().describe('Narrow your sessions to this App ID or qualified App URN. Missing and unavailable references return no matching session.'),
  workerRef: z.string().optional().describe('Narrow your sessions to this Worker ID, qualified Worker URN, name or slug. Ambiguous names/slugs require app or an exact ID/URN.'),
  limit: z.number().int().optional().describe('Max sessions to return (default 10, cap 50). Newest first.'),
  includeEnded: z.boolean().optional().describe('Also list recently ENDED sessions — useful to confirm you did end one, or to find the session a work record should have been attributed to.'),
};

export const SHAPE_HADRON_CAST_WORKER = {
  reportsTo: z.string().nullable().optional().describe('Same-App reporting head reference; supply this or noTeam:true, never both. Only omission is compatible while choice enforcement is OFF.'),
  noTeam: z.boolean().nullable().optional().describe('true explicitly records No team; false and null are invalid. Omit reportsTo entirely when choosing this arm.'),
  role: z.string().optional().describe('The role ("backend-engineer") — picks the installed agent by its personaRole when agent is omitted, and becomes the casting\'s role label. Not validated against defined roles: cast lists are ergonomics, never a gate (cor:agt:020:00).'),
  name: z.string().optional().describe('The worker\'s name — REQUIRED in effect (#1050): omitting it refuses WORKER_NAME_REQUIRED rather than deriving one, because a name is permanent within the App. Optional in the schema only so that refusal carries its reason instead of arriving as a bare validation error.'),
  agent: z.string().optional().describe('The agent to cast (Agent URN or ID) — must be installed in the App. Omit to resolve it from role.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
  session: z.string().optional().describe('Your session id — used to resolve which App to cast in when app is omitted. Passing it also keeps that session alive — driving a session through any team tool counts as activity (#1081).'),
};

export const SHAPE_HADRON_CHANNEL_POST = {
  channel: z.string().describe('The Channel — its id, or its address (the chat root node URN hadron_list_channels prints). Copy one of those; a ref naming nothing reads as a Channel you may not see.'),
  body: z.string().describe('The message text (max 65536 characters). Mention teammates as @worker-name or @handle.'),
  replyToSeq: z.number().int().optional().describe('seq of the message this replies to.'),
  session: z.string().optional().describe('A session id — the message is authored by that session\'s bound Worker. Omit it on a connection bound to ONE worker session to post as that Worker; on a SHARED connection (several of your sessions bound on it, e.g. several chat sessions on one host) an omitted session is refused SESSION_AMBIGUOUS (#1701). Not combinable with asMe.'),
  asMe: z.boolean().optional().describe('true posts as YOU, the human, even on a connection bound to a worker (#1697). Required to post as yourself when no worker session is bound or named; without it such a post is refused [authorship_required]. Not combinable with session.'),
};

export const SHAPE_HADRON_CHANNEL_READ = {
  replyToSeq: z.number().int().optional().describe('Only direct replies to this seq, excluding the target. Missing or deleted target refuses TEAM_CHAT_REPLY_NOT_FOUND. AND-composes with other filters; not combinable with monitor:true.'),
  channel: z.string().describe('The Channel — its id, or its address (the chat root node URN hadron_list_channels prints). Copy one of those; a ref naming nothing reads as a Channel you may not see.'),
  sinceSeq: z.number().int().optional().describe('Only messages with seq strictly greater than this watermark.'),
  beforeSeq: z.number().int().optional().describe('Page BACKWARD: only messages with seq strictly less than this, newest page of those. Ignores offset.'),
  teamHeadRef: z.string().optional().describe('Filter by an authorized stable team-head ID; mutually exclusive with untagged.'),
  untagged: z.boolean().optional().describe('Filter for no stored head identity, including historical absent snapshots. Requires team metadata access.'),
  mentions: z.string().optional().describe('Filter to messages mentioning this worker (name or id) or user (handle/id) of the host App. For a worker this includes its stored team-broadcast recipients and qualifying global broadcasts (including legacy @team), decided at post time; never its own posts.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Legacy oldest-first page offset. Prefer sinceSeq or beforeSeq for stable paging.'),
  session: z.string().optional().describe('Your session id — passing it keeps that session alive (#1081).'),
  expectedIncarnation: z.number().int().optional().describe('#2181: pin the read to the Channel incarnation you read (the "incarnation" on the final line of a read). A different one is [channel_incarnation_changed] with no page and no cursor, check or resume applied; omitted, the read is unfenced.'),
};

export const SHAPE_HADRON_TEAM_CHAT_POST = {
  body: z.string().describe('The message text (max 65536 characters). Mention teammates as @worker-name or @handle.'),
  replyToSeq: z.number().int().optional().describe('seq of the message this replies to (a replies-to edge is wired).'),
  session: z.string().optional().describe('A session id — the message is authored by that session\'s bound Worker. Omit it on a connection bound to ONE worker session to post as that Worker; on a SHARED connection (several of your sessions bound on it, e.g. several chat sessions on one host) an omitted session is refused SESSION_AMBIGUOUS (#1701). Not combinable with asMe.'),
  asMe: z.boolean().optional().describe('true posts as YOU, the human, even on a connection bound to a worker (#1967, as hadron_channel_post). Required to post as yourself when no worker session is bound or named; without it such a post is refused [authorship_required]. Not combinable with session.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
  channel: z.string().optional().describe('Spec 049: post into THIS Channel (its id or address, from hadron_list_channels) instead of the App\'s default team chat. Item J: your worker authors there when its App is the Channel\'s, or when you may write the Channel\'s host memory.'),
};

export const SHAPE_HADRON_TEAM_CHAT_READ = {
  replyToSeq: z.number().int().optional().describe('Only direct replies to this seq, excluding the target. Missing or deleted target refuses TEAM_CHAT_REPLY_NOT_FOUND. AND-composes with other filters; not combinable with monitor:true.'),
  sinceSeq: z.number().int().optional().describe('Only messages with seq strictly greater than this watermark.'),
  beforeSeq: z.number().int().optional().describe('Page BACKWARD (#1116): only messages with seq strictly LESS than this, returning the NEWEST such page — pass the oldest seq you have seen. Stable under concurrent posting where offset is not. Ignores offset.'),
  teamHeadRef: z.string().optional().describe('Filter by an authorized stable team-head ID; mutually exclusive with untagged.'),
  untagged: z.boolean().optional().describe('Filter for no stored head identity, including historical absent snapshots. Requires team metadata access.'),
  mentions: z.string().optional().describe('Filter to messages mentioning this worker (name or id) or user (handle/id). For a worker this includes its stored team-broadcast recipients and qualifying global broadcasts (including legacy @team), decided at post time; never its own posts.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Legacy oldest-first page offset. Prefer sinceSeq or beforeSeq for stable paging.'),
  session: z.string().optional().describe('Your session id — used to resolve which team App to read when app is omitted. On an ordinary read, passing it keeps that session alive (#1081). Monitor mode uses it only as an App hint and does not heartbeat or wake the session.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
  channel: z.string().optional().describe('Spec 049: read THIS Channel (its id or address, from hadron_list_channels) instead of the App\'s default team chat.'),
  expectedIncarnation: z.number().int().optional().describe('#2181: with channel, pin the read to the Channel incarnation you read; see hadron_channel_read.'),
  monitor: z.boolean().optional().describe('Use the register + stored ChannelReadState for your live Worker sessions. Incompatible with sinceSeq, beforeSeq, mentions and offset.'),
  monitorFor: z.string().optional().describe('With monitor:true, narrow to one Worker by name, id or URN. It must be bound to one of your live sessions in this App.'),
  acknowledge: z.array(z.object({
    worker: z.string().describe('Exact Worker id from the returned checkpoint.'),
    channel: z.string().describe('Exact Channel id from the returned checkpoint.'),
    seq: z.number().int().min(0).describe('Exact sequence from the returned checkpoint.'),
    proof: z.string().describe('Opaque server proof from the returned checkpoint; binds Worker + Channel + sequence.'),
  })).max(TEAM_CHAT_MONITOR_MAX_TARGETS).optional().describe('With monitor:true, deliberately advance these server-issued checkpoints after routing/action succeeded.'),
};

export const SHAPE_HADRON_TEAM_CHAT_SEARCH = {
  query: z.string().describe('The text to find: a literal, case-insensitive substring, 2 to 200 characters counted as typed (no trimming). % _ and the backslash have no special meaning.'),
  limit: z.number().int().optional().describe('Matches per page (default 20; a larger value is clamped to 50; below 1 is refused).'),
  cursor: z.string().optional().describe('The continuation from the previous page of THIS search (same query, chat and caller); any other use is [team_chat_search_cursor_invalid].'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the active App. Ignored when channel is given.'),
  channel: z.string().optional().describe('Search THIS Channel (its id or address, from hadron_list_channels) instead of the App\'s default team chat.'),
};

export const SHAPE_HADRON_TEAM_CHAT_MARK_READ = {
  session: z.string().describe('Your live Worker session; selects the Worker whose own cursor advances.'),
  app: z.string().optional().describe('The App. Omit to recover it from session or the active selection.'),
  channel: z.string().optional().describe('Channel id or address. Omit for the team Channel hadron_team_chat_read serves for the App.'),
  seq: z.number().int().min(0).describe('Read through this exact sequence.'),
  expectedIncarnation: z.number().int().optional().describe('#2181: fence the mark to the Channel incarnation you read (the "incarnation" on the final line of a read). A different one is [channel_incarnation_changed] — never repeat it; read again and pin the new incarnation. The result names channelIncarnation and cursorIncarnation (null = legacy cursor, never relabelled). Omitted, the mark is unfenced.'),
};

export const SHAPE_HADRON_LIST_WORKERS = {
  includeRetired: z.boolean().optional().describe('Include retired castings — historical staff whose names stay reserved.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
  session: z.string().optional().describe('Your session id — used to resolve which team App to list when app is omitted. Passing it also keeps that session alive — driving a session through any team tool counts as activity (#1081).'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
};

export const SHAPE_HADRON_GET_WORKER = {
  workerRef: z.string().describe('The worker: its NAME ("Iris", within the App), its URN (hrn:worker:<root>:<app-slug>:<slug>), or its id.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Only needed for the NAME form; omit to use the session\'s active App.'),
  session: z.string().optional().describe('Your session id. Used to resolve which App a bare NAME belongs to when app is omitted, and — whenever you pass it — to keep that session alive: driving a session through any team tool counts as activity, so its DERIVED liveness stays current while you are working (#1081; #1114 — inactivity no longer reaps anything, it only decides whether a session reads as live).'),
};

export const SHAPE_HADRON_DELETE_WORKER = {
  workerRef: z.string().describe('The worker id or URN.'),
  confirmNoExternalAttribution: z.boolean().optional().describe('Explicit requester verification of no external attribution. Omitted or false refuses; ordinary yes/confirmation is insufficient.'),
};

export const SHAPE_HADRON_UPDATE_WORKER = {
  workerRef: z.string().describe('The worker: its NAME ("Iris", within the App), its URN, or its id.'),
  signature: z.string().nullable().optional().describe('Per-worker signature template. Omit preserves; null refuses; blank delivers nothing. App managers only.'),
  trailer: z.string().nullable().optional().describe('Per-worker trailer template, same manager and omission rules as signature.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Only needed for the NAME form; omit to use the session\'s active App.'),
  session: z.string().optional().describe('Your session id. Used to resolve which App a bare NAME belongs to when app is omitted, and — whenever you pass it — to keep that session alive: driving a session through any team tool counts as activity, so its DERIVED liveness stays current while you are working (#1081; #1114 — inactivity no longer reaps anything, it only decides whether a session reads as live).'),
};

export const SHAPE_HADRON_CHANGE_WORKER_AGENT = {
  workerRef: z.string().describe('The worker: its NAME ("Iris", within the App), its URN, or its id.'),
  agent: z.string().describe('The agent the worker will cast: an Agent URN or id, installed in the App. The role is that agent\'s own.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Only needed for the NAME form; omit to use the session\'s active App.'),
  session: z.string().optional().describe('Your session id: resolves which App a bare NAME belongs to, and keeps that session alive (#1081). Passing a WORKER session does not authorize the change: a worker session is refused.'),
};

export const SHAPE_HADRON_SET_WORKER_REPORTS_TO = {
  workerRef: z.string().describe('The worker whose value changes: its NAME (within the App), URN or id.'),
  reportsTo: z.string().nullable().describe('The worker it reports to (name, URN or id), or null to clear.'),
  app: z.string().optional().describe('The team App (URN or id). Only needed for the NAME forms; omit to use the session\'s App.'),
};

export const SHAPE_HADRON_RECORD_WORK = {
  session: z.string().describe('The session id the work is attributed to (must be a session of the team App).'),
  tool: z.string().describe('The external tool the artifact lives in, e.g. "github".'),
  kind: z.string().describe('Artifact kind: pr | issue | commit | branch | repo.'),
  ref: z.string().describe('The artifact ref — a github URL or short form; stored canonically (e.g. owner/repo#371).'),
  action: z.string().describe('What happened: opened | merged | claimed | reviewed | closed | pushed | ... (free verb).'),
  detail: z.record(z.string(), z.unknown()).optional().describe('Optional display extras (title, URL) — stored, never filtered on.'),
  model: z.string().optional().describe('Optional explicit report of the LLM model that produced the work (#1398) — use it for a model switch or a late record. Takes precedence over the session\'s model; omit to use the session\'s model. Not verified telemetry.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
};

export const SHAPE_HADRON_TEAM_WORK_ITEMS = {
  ref: z.string().optional().describe('Artifact filter: a PR URL or owner/repo#371 matches canonically; an ownerless repo suffix such as cli#793 finds all matching GitHub repositories in this App.'),
  session: z.string().optional().describe('Filter to records of this session id.'),
  worker: z.string().optional().describe('Filter to ONE worker\'s records — its name ("Iris"), id, or URN. Everything that worker has done, across all of their sessions. A retired worker still resolves.'),
  tool: z.string().optional().describe('Filter by tool (e.g. "github").'),
  kind: z.string().optional().describe('Filter by kind: pr | issue | commit | branch | repo.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
};

export const SHAPE_HADRON_VALIDATE = {
  memoryUrn: z.string().describe('Fully-qualified memory URN, e.g. "acme.com:mmdata"'),
};

export const SHAPE_HADRON_SYNC_GRAPH = {
  memoryUrn: z.string().describe('Fully-qualified memory URN, e.g. "acme.com:mmdata"'),
};
