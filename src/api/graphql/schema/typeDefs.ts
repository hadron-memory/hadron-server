export const typeDefs = `#graphql
  enum Role {
    OWNER
    ADMIN
    CONTRIBUTOR
    READER
  }

  enum SubscriptionType {
    READ_ONLY
    READ_WRITE
  }

  enum SyncStatus {
    PENDING
    SYNCING
    OK
    ERROR
  }

  """
  035-visibility-enum-cleanup: meaningful only for knowledge
  (PUBLIC/ORGANIZATION) and group (GROUP); null otherwise. PERSONAL/PRIVATE
  were dropped — privacy is the personal/private memory CLASS now.
  """
  enum MemoryVisibility {
    PUBLIC
    ORGANIZATION
    """
    023-app-shape US4: team-shared visibility. Bound bidirectionally
    to MemoryClass.group by the chk_memory_group_visibility CHECK
    constraint — a memory has class=group iff visibility=GROUP.
    """
    GROUP
  }

  """
  035-visibility-enum-cleanup: agents have their own visibility enum,
  decoupled from MemoryVisibility. PERSONAL is the creator-only draft state.
  """
  enum AgentVisibility {
    PUBLIC
    ORGANIZATION
    PERSONAL
  }

  enum CreateUserPermission {
    DENY
    EXPLICIT
    IMPLICIT
  }

  enum IdentifyUserMethod {
    USER_ID
    SECRET
  }

  enum AgentType {
    ASSISTANT
    CHATBOT
  }

  "Retrieval modes for findNodes (cor:api:090:01). keyword is stemmed FTS; vector/hybrid need the memory's vector index; regex is a POSIX pattern match."
  enum FindNodesMode {
    keyword
    vector
    hybrid
    regex
  }

  """
  Result granularity for findNodes (cor:api:090). Spec 033.

  - node: one entry per matching node (default).
  - chunk: passage-level entries with offsets into the parent node's
    content (vector mode only; chunk hits collapse to node-level when
    granularity is node).
  """
  enum SearchGranularity {
    node
    chunk
  }

  """
  Node fields a lexical (keyword/regex) query matches and weights. Weight-mask,
  NOT a hard filter: naming a subset zeroes the excluded fields in scoring but
  does not strictly exclude them from matching (cor:api:090:03). Ignored by
  mode:vector (the index source is a per-memory config, not a query param).
  """
  enum NodeField {
    name
    alias
    loc
    tags
    description
    abstract
    content
    properties
    data
  }

  "Result ordering for findNodes. Default relevance; the rest suppress scoring (browse order)."
  enum NodeSort {
    relevance
    loc
    seq
    updatedAt
  }

  "Sort direction for a findNodes property-path sort (#719). Default asc."
  enum SortDirection {
    asc
    desc
  }

  """
  Order findNodes by the value at a properties/data JSON path (#719).

  Reuses the NodeWhere leaf addressing: path into field (properties|data), typed
  by as (text|number|datetime|boolean). number/datetime route through the same DB
  guards, so a missing or unparseable value sorts LAST regardless of direction;
  loc ascending breaks ties for stable pagination. Overrides the sort enum when
  present. On vector/hybrid modes it re-orders the retrieved candidate window (the
  ranking runs against the vector index, not the JSONB), like the sort enum does.
  """
  input NodePropertySort {
    "Path of object keys into the column, e.g. ['stage']."
    path: [String!]!
    "JSONB column (default properties)."
    field: NodeWhereColumn
    "Value typing before comparison (default text)."
    as: NodeWhereCast
    "Direction (default asc)."
    direction: SortDirection
  }

  "JSONB column a NodeWhere leaf reads (#719). Defaults to properties."
  enum NodeWhereColumn {
    properties
    data
  }

  "How a NodeWhere leaf's extracted value is typed before comparison (#719). Default text."
  enum NodeWhereCast {
    text
    number
    datetime
    boolean
  }

  """
  A recursive structured predicate over a node's properties/data JSONB (#719).

  A node is EITHER a branch (exactly one of and/or/not) OR a leaf (a path plus
  exactly one operator). Leaf values are JSON scalars, bound as parameters; path
  segments are identifier-validated. datetime/number comparisons route through
  DB guard functions so unparseable data drops the row (never a 500). Bounded:
  depth ≤ 4, ≤ 32 leaves, path ≤ 8 segments — a malformed/oversized tree is
  BAD_USER_INPUT. Composes with every mode (keyword/regex/vector/hybrid) and the
  no-query browse: for lexical modes + browse the predicate is applied in-query;
  for vector/hybrid it post-filters the ranked candidate set (rank order preserved).
  """
  input NodeWhereInput {
    and: [NodeWhereInput!]
    or: [NodeWhereInput!]
    not: NodeWhereInput
    "JSONB column (default properties)."
    field: NodeWhereColumn
    "Path of object keys into the column, e.g. ['capturedAt']."
    path: [String!]
    "Value typing for the comparison (default text)."
    as: NodeWhereCast
    eq: JSON
    ne: JSON
    in: [JSON!]
    lt: JSON
    lte: JSON
    gt: JSON
    gte: JSON
    between: [JSON!]
    exists: Boolean
    "jsonb containment (@>) of the JSON value at the path."
    contains: JSON
  }

  """
  Structured, unscored, AND-combined filter context for findNodes (cor:api:090:02).
  """
  input NodeFilter {
    "Memory scope — a mix of memory IDs and fully-qualified URNs; intersected with the caller's access."
    memoryIds: [ID!]
    "Restrict by memory class. SYSTEM is excluded by default; passing this (or naming a system memory in memoryIds) overrides that."
    memoryClasses: [MemoryClass!]
    nodeType: String
    "#725 — collection facet: only nodes whose objectType equals this (e.g. \\"competitor\\")."
    objectType: String
    tags: [String!]
    isRunnable: Boolean
    locPrefix: String
    createdBy: String
    updatedAfter: String
    updatedBefore: String
    "Include soft-deleted nodes (default false)."
    includeDeleted: Boolean
    "Structured predicate over the node's properties/data JSONB (#719)."
    where: NodeWhereInput
  }

  "Per-hit vector-retrieval lineage (cor:api:090:04), present when a hit came from the vector index."
  type NodeVectorMeta {
    similarity: Float
    model: String
    chunkIndex: Int
    offsets: [Int!]
    abstractStale: Boolean
    source: String
  }

  "A scored node hit (cor:api:090:04). score is null for an unscored filtered list (no query)."
  type NodeHit {
    node: Node!
    score: Float
    vector: NodeVectorMeta
  }

  """
  Envelope for findNodes (cor:api:090) — the unified node list + search field
  (it replaced the removed nodes + nodeSearch queries). hits carry per-hit score + vector metadata;
  passages carry chunk-granularity results; reason/degraded surface no-index /
  reduced-fidelity outcomes.
  """
  type FindNodesResult {
    hits: [NodeHit!]!
    passages: [Passage!]!
    total: Int
    reason: String
    """
    Reduced-fidelity flag(s); hits are usable. May carry MULTIPLE
    comma-separated codes (e.g. 'no_vector_index,literal_fallback') —
    parse the set, never compare the whole string. Codes: no_vector_index,
    embedding_unavailable, literal_fallback, and_relaxed_to_or (a bare
    multi-term keyword query matched nothing under AND, so it was retried as
    OR and these hits match ANY term).
    """
    degraded: String
  }

  "Slim node projection for the graph view (issue #466) — only what a node-link graph draws."
  type GraphNode {
    id: ID!
    loc: String!
    "Non-null — mirrors Node.name (the DB column is NOT NULL)."
    name: String!
    "Non-null — mirrors Node.nodeType (NOT NULL, defaults to 'info')."
    nodeType: String!
    tags: [String!]!
    "Sibling sort order in the tree view (nullable; #513). Small scalar — kept in the slim projection."
    seq: Int
    "Whether the node can be run as a task — drives the tree action indicator (nullable; #513)."
    isRunnable: Boolean
    "Short one-line description for graph tooltips / detail (nullable; #513). NOT the heavy body — content/abstract/data stay out of the slim projection."
    description: String
  }

  "Slim edge projection for the graph view (issue #466) — endpoint IDs only."
  type GraphEdge {
    id: ID!
    loc: String!
    name: String
    sourceId: ID!
    targetId: ID!
  }

  "Paged envelope for memoryNodes — the standard limit/offset/total idiom; total is the memory's full node count."
  type GraphNodesPage {
    nodes: [GraphNode!]!
    total: Int!
  }

  "Paged envelope for memoryEdges — total is the memory's full edge count."
  type GraphEdgesPage {
    edges: [GraphEdge!]!
    total: Int!
  }

  # ── Uniform find-many envelopes (#473) ────────────────────────────────
  #
  # Every entity's paginated list query returns the same { items, total }
  # shape so a client can drive one generic pager for all of them. total is
  # the exact full count for the query's scope+filter; limit defaults to 50
  # (capped 200) and limit: 0 returns just the total (the cheap count).

  type MemoriesPage {
    items: [Memory!]!
    total: Int!
  }

  type OrganizationsPage {
    items: [Organization!]!
    total: Int!
  }

  type AppsPage {
    items: [App!]!
    total: Int!
  }

  type AgentsPage {
    items: [Agent!]!
    total: Int!
  }

  type EdgesPage {
    items: [Edge!]!
    total: Int!
  }

  type UsersPage {
    items: [User!]!
    total: Int!
  }

  type AiServiceConfigsPage {
    items: [AiServiceConfig!]!
    total: Int!
  }

  """
  Filter for the uniform memories() list (#473). All clauses AND-combine and
  only ever narrow the caller's accessible scope — with two documented slice
  SELECTIONS, each switching which readable set the list draws from (never
  widening access beyond what the caller may already read):
    - visibility: PUBLIC switches from the caller's own union (org-owned +
      org-subscribed + own personal/private) to the public marketplace slice
      (every PUBLIC memory — the old publicMemories query).
    - sharedWithMe: true switches to the memories shared WITH the caller via
      MemoryShare (the caller is a grantee) — the portal's
      Memories-shared-with-me tab.
  """
  input MemoryFilter {
    "Restrict to exactly these classes. Omitted, the noisy agent system class is hidden by default; pass it explicitly to surface system memories."
    memoryClasses: [MemoryClass!]
    "Restrict by visibility. PUBLIC selects the marketplace slice (see above)."
    visibility: MemoryVisibility
    """
    true selects the distinct set of memories shared WITH the caller
    via MemoryShare (the caller is a grantee) — the portal's
    Memories-shared-with-me tab. This is its own slice, NOT part of the
    caller's owned/org union: a grantee is never their own grantor, so
    it excludes owned memories. App-key callers get an empty page
    (sharing is a user-to-user concept). See Memory.myShare for the
    per-row grantor + role.
    """
    sharedWithMe: Boolean
  }

  "Filter for the uniform organizations() list (#473)."
  input OrganizationFilter {
    """
    true restricts the list to the caller's own memberships — even for
    platform ADMIN/OWNER, whose unscoped reach otherwise spans every live
    org; the old myOrganizations semantics.
    """
    memberOnly: Boolean
  }

  "Filter for the uniform agents() list (#473). Clauses AND-combine."
  input AgentFilter {
    type: AgentType
    visibility: AgentVisibility
    """
    #782 — true restricts the list to the caller's OWN user-owned (org-less)
    agents: organizationId IS NULL AND ownerUserId = the caller. For ALL
    callers INCLUDING platform ADMIN/OWNER (owner scope is never an
    admin-bypass surface), mirroring the owner-only personal/private memories
    slice. Org-less by definition, so orgId is not consulted. App-key callers
    (no user context) get an empty page. Powers the portal's "My agents".
    """
    ownedByMe: Boolean
  }

  """
  Filter for the publicAgents() marketplace slice (#551). ONLY 'type' narrows.
  Deliberately a SEPARATE, narrower input from AgentFilter: the slice is PUBLIC
  by definition (so 'visibility' is meaningless) and a PUBLIC agent is never
  user-owned (user-owned agents are strictly PERSONAL, spec 047), so an
  'ownedByMe' here would always be empty — rejecting it at the schema keeps a
  client from applying the filter uniformly and silently getting cross-org
  marketplace agents (#782 Codex review).
  """
  input PublicAgentFilter {
    type: AgentType
  }

  "Filter for the uniform apps() list (#473). Clauses AND-combine."
  input AppFilter {
    """
    #782 — true restricts the list to the caller's OWN user-owned (org-less)
    apps: organizationId IS NULL AND ownerUserId = the caller. For ALL callers
    INCLUDING platform ADMIN/OWNER (owner scope is never an admin-bypass
    surface), mirroring the owner-only personal/private memories slice.
    Org-less by definition, so orgId is not consulted. App-key callers (no
    user context) get an empty page. Powers the portal's "My apps".
    """
    ownedByMe: Boolean
  }

  """
  Filter for the uniform edges() list (#473). Clauses AND-combine and are
  intersected with the caller's readable memories. memoryId / sourceNodeId /
  targetNodeId each accept an ID or a fully-qualified URN; an unresolvable
  ref yields an empty page (consistent with the no-disclosure posture).
  """
  input EdgeFilter {
    "Confine to edges whose (denormalized, source-side) memory is this one."
    memoryId: ID
    "Edges leaving this node."
    sourceNodeId: ID
    "Edges arriving at this node."
    targetNodeId: ID
    isRunnable: Boolean
    "Include soft-deleted edges (default false)."
    includeDeleted: Boolean
  }

  """
  Filter for the uniform users() list (#473). For a non-platform-admin caller
  'query' is REQUIRED (a blank/omitted query returns an empty page) and
  matching is enumeration-safe per cor:acl:070:02: public identifiers
  (handle, githubUsername) match by substring, email by exact equality, and
  name only where the viewer may see it (self/admin/co-member). Platform
  ADMIN/OWNER may omit 'query' for the full user list.
  """
  input UserFilter {
    query: String
  }

  """
  Filter for the uniform aiServiceConfigs() list (#473) — the owning entity.
  Omitted entirely, the list is the platform ADMIN/OWNER's cross-owner view
  of every config; non-admin callers MUST filter by owner (org ADMIN of the
  owning org, mirroring the management-surface gate).
  """
  input AiServiceConfigFilter {
    ownerType: AiConfigOwnerType!
    "The owning entity — accepts ID or URN (HADRON_SERVER: ID only)."
    ownerId: ID!
  }

  """
  Entity types the cross-entity global search (globalSearch) can return.
  Mirrors the SearchEntityType union in src/lib/global-search.
  """
  enum SearchEntityType {
    organization
    memory
    node
    agent
    app
    aiServiceConfig
    user
  }

  """
  Fields globalSearch can match against. Omit \`fields\` to let the server
  smart-sniff the query shape (PK → URN → name); explicit fields override the
  sniff. \`pk\` is exact-match; the rest are case-insensitive substring.
  \`content\` (node bodies) is opt-in and skips encrypted memories.
  """
  enum SearchField {
    urn
    name
    description
    pk
    content
  }

  """
  One unified, flat globalSearch result — common fields across every entity
  type so a single ranked list renders uniformly. \`urn\` is null for an
  aiServiceConfig (no URN) and for a user with no handle or a not-URN-legal
  handle (a user's URN is hrn:user:<handle>); \`memoryId\` / \`organizationId\`
  are convenience handles for building canonical navigation paths.
  """
  type GlobalSearchHit {
    entityType: SearchEntityType!
    id: ID!
    urn: String
    name: String
    description: String
    matchedField: SearchField!
    score: Float!
    memoryId: ID
    organizationId: ID
  }

  type GlobalSearchResult {
    hits: [GlobalSearchHit!]!
    """
    Total ranked matches for building a pager. BOUNDED CONTRACT: this is the
    count within the per-entity candidate cap (each entity type contributes at
    most a fixed number of candidates before scoring), not an unbounded COUNT.
    On very large result sets it under-counts; page slicing (offset/limit)
    operates over this bounded, fully-ranked list.
    """
    total: Int!
    """
    Notes when the search ran at reduced fidelity (e.g. content search skipped
    on encrypted memories).
    """
    degraded: [String!]!
  }

  """
  Spec cor:api:040 — result envelope for the batch node read (nodeBatch).
  'nodes' is the authorized, existing subset (input order for a ref set, loc
  order for a prefix). 'unavailable' and 'omitted' are both lists of REFS, not
  node objects. 'unavailable' lists the requested refs that were denied OR not
  found — indistinguishable, so the result never discloses whether an
  unreadable node exists. 'truncated' is true when the response-size cap was
  reached, and 'omitted' then carries the refs of the nodes dropped to stay
  under it. (Over the node-count cap the query errors instead — never a silent
  short read.) Both lists echo the caller's OWN ref strings for the 'refs'
  form — pass a URN, get that URN back, not a primary key you never sent — and
  node ids for the prefix form, which has no caller refs.
  """
  type NodeBatchResult {
    nodes: [Node!]!
    unavailable: [ID!]!
    truncated: Boolean!
    omitted: [ID!]!
  }

  """
  Spec 033 US2 — one matching chunk from a content-chunk vector index.
  Carries the locator metadata a RAG consumer needs for context-stuffing:
  span text, character offset within the parent node, chunk index, and
  the parent node's URN.
  """
  type Passage {
    parentNodeId: ID!
    parentNodeUrn: String!
    chunkIndex: Int!
    charStart: Int!
    charEnd: Int!
    text: String!
    score: Float!
  }

  type Node {
    id: ID!
    memoryId: String!
    nodeType: String!
    "#725 — collection discriminator (which domain object this node is, e.g. \\"competitor\\"). NULL for an ordinary node."
    objectType: String
    loc: String!
    "Fully-qualified node URN (hrn:node:<root>:<memory>:<loc>), composed server-side from the node's memory URN + loc (#481). Carried by every Node-returning surface (findNodes, node, appNodes, nodeBatch, mutation returns)."
    urn: String!
    """
    #881 — the portal URL that opens this node, built server-side so no client
    ever has to construct one (constructing means guessing which URN spelling
    the /app/u/<urn> route resolves, and the legacy '::' forms in circulation
    make that guess wrong). Form: <portal-origin>/app/u/<urn>, the portal's
    stable URN-alias route. NULL when the deployment has no portal origin
    configured (FRONTEND_URL) — a link to the wrong host is worse than none, so
    clients render the field only when present.
    """
    portalUrl: String
    isLink: Boolean!
    name: String!
    alias: String
    description: String
    "Paragraph-length summary of this node. Opt-in on hadron_get_node via the contentScope parameter. hadron_find_nodes preview surfacing ships in spec 031 US2 — not yet live. Never surfaced in hadron_list_nodes. Cap is 2000 characters; longer values are rejected with NodeAbstractTooLongError. Empty + whitespace-only values normalize to null. Spec 031."
    abstract: String
    "Spec 032 — fingerprint of the content value at the time abstract was authored. SHA-256 of plaintext content, truncated to 8 hex chars. Compared at read time against computeContentHash(node.content) to detect staleness; when the two values differ AND abstractOriginHash is non-null, the abstract may not reflect current content. System-managed; never settable via NodeInput."
    abstractOriginHash: String
    """
    Spec 033 FR-006/FR-007 — set when this node needs (re-)embedding;
    cleared on success. The single work signal the embedding worker
    drains. A FUTURE-dated value is a backed-off retry not yet due
    (#882) — the worker only selects stamps at or before now.
    Operational state (never versioned on NodeRevision). The portal
    renders this as a subtle "embedding…" badge so a user who just
    edited isn't confused that their change "didn't take" in search
    yet. System-managed.
    """
    embeddingPendingAt: DateTime
    """
    Spec 033 FR-009 — set when an embed attempt failed (record, not a
    work signal). Retryable failures (timeouts, 5xx) reschedule with
    exponential backoff and never give up (#882); permanent failures
    (deterministic 4xx, dimension mismatch, encrypted-no-plaintext)
    clear embeddingPendingAt — recovery is the retryFailedEmbeddings
    mutation. The portal renders this as a red badge with the
    embeddingError message inline so users with an empty index can
    distinguish "nothing matched" from "every embed failed".
    System-managed.
    """
    embeddingFailedAt: DateTime
    """
    Spec 033 — last embed error message (diagnosability; also surfaced
    by hadron_validate). Common values: encrypted-no-plaintext (#206),
    embedding-endpoint-unreachable, dimension-mismatch. Null when no
    failure has been recorded since the most recent success or revoke.
    System-managed.
    """
    embeddingError: String
    """
    Spec 033 — attempt counter feeding the exponential-backoff schedule
    (#882 — no terminal give-up; a retryable failure never removes the
    node from the queue). Resets to 0 on success or revoke. Surfaced for
    ops diagnostics (a node at a high attempt count is retrying at the
    backoff ceiling and likely needs operator attention). System-managed.
    """
    embeddingAttempts: Int!
    content: String
    tokens: Int
    tags: [String!]!
    properties: JSON
    data: JSON
    seq: Int
    ownerRepo: String
    isRunnable: Boolean
    llmModel: String
    aiAgent: String
    createdAt: DateTime!
    updatedAt: DateTime!
    memory: Memory
    outgoingEdges: [Edge!]!
    incomingEdges: [Edge!]!
    """
    The asset this node references, for a reference node created by
    createAssetReferenceNode or hadron_store_file (its data.asset
    points at one). Null for every ordinary node.

    Also null when the pointer is DANGLING — the asset was deleted, or
    is soft-deleted. There is no schema-level Asset-to-Node foreign key
    (cor:dmo:060:10 reserves it), so data.asset.id is a soft reference
    and this resolver is what keeps it honest: never assume a node
    carrying data.asset still has a live asset behind it.
    """
    asset: Asset
  }

  type Edge {
    id: ID!
    "The source node. NULLABLE (#781): null when the caller cannot read the source node's memory — a cross-memory edge (e.g. reached via incomingEdges) must not expose an endpoint in a memory the caller can't read. For a same-memory edge the caller can already see, this is always present."
    source: Node
    "The target node. NULLABLE (#781): null when the caller cannot read the target node's memory (a cross-memory edge's far endpoint). For a same-memory edge, always present."
    target: Node
    "Fully-qualified edge URN (hrn:edge:<root>:<memory>:<loc>), composed server-side from the edge's (source-side) memory URN + loc (#481 parity — edges are loc-addressed peers of nodes, spec 037)."
    urn: String!
    # Colon-delimited path within the (source node's) memory — the edge's
    # identity and the suffix of its URN hrn:edge:<root>:<memory>:<loc>.
    loc: String!
    # Free-form relationship name (e.g. imports, depends_on). Optional since
    # spec 037 — loc is the identity. (Was the required 'label'.)
    name: String
    description: String
    # If true, this edge can be executed/run (task automation, conversation
    # transitions). Mirrors Node.isRunnable.
    isRunnable: Boolean
    # JSONLogic gating expression. Null = always fires. Validated against
    # the v1 operator subset and the five variable scopes (memory.*,
    # chat.*, agent.*, message.data.*, now()/today()).
    # See hadron-docs/docs/reference/edge-conditions.md.
    condition: JSON
    # Resolution-order hook (lower = earlier; default 0). When two edges
    # share a priority, fall back to insertion order.
    priority: Int!
    data: JSON
  }

  type Session {
    id: ID!
    type: String!
    appId: String
    userId: String
    "The role-agent driving the session (with workerId set, the agent behind the casting)."
    agentId: String
    "#974 / cor:agt:020:03: the Worker (named casting) this session works as."
    workerId: String
    """
    #980 / cor:agt:020:02: the Worker behind workerId, nested — so a session
    list can render the app-qualified compound ('eng-team/Iris') without a
    per-row worker(ref:) + app(ref:) round trip (Worker carries name and app).
    Resolves for RETIRED workers too: retirement ends the casting, not the
    history, so past sessions stay attributable. Worker.app and Worker.agent
    run their OWN read gates and mask to null on deny (#552), so this nesting
    never widens what the session read admits.
    """
    worker: Worker
    memoryId: String
    expiresAt: DateTime
    repo: String
    branch: String
    prNumber: Int
    customerId: String
    language: String
    plan: String
    llmModel: String
    "#928: where the driving tool's transcript lives on 'host'."
    transcriptPath: String
    "#928: machine identifier the session ran on."
    host: String
    "#928: the tool driving the session ('claude-code', 'codex', ...)."
    tool: String
    inputTokens: Int
    outputTokens: Int
    turnCount: Int
    errorCount: Int
    parentSessionId: String
    prevSessionId: String
    summary: String
    outcome: Float
    outcomeRef: String
    outcomeMeta: JSON
    startedAt: DateTime!
    endedAt: DateTime
    autoExpiredAt: DateTime
    events: [UsageEvent!]!
  }

  type UsageEvent {
    id: ID!
    type: String!
    nodeLoc: String
    """
    Memory the event is attributed to (#796). Stored at write time, so it
    outlives the node — null only for events written before the backfill
    whose node was already deleted, or paths with no memory in scope.
    """
    memoryId: String
    actionArgs: JSON
    # Caller identity — the App that authored this event.
    appId: String
    sessionId: String
    model: String
    tokensIn: Int
    tokensOut: Int
    # 046-usage-metering: billing attribution + cost snapshot.
    userId: String
    organizationId: String
    provider: String
    # Owner level of the API key that served the call
    # (HADRON_SERVER means platform-paid; anything else is BYOK).
    keyOwnerType: String
    # Provider cost snapshot in micro-cents (1e-8 USD), as a base-10
    # integer string. Null when the (provider, model) pair is unpriced.
    costMicroCents: String
    createdAt: DateTime!
  }

  """
  A revision's editor resolved to PUBLIC IDENTIFIERS ONLY (#617). Deliberately
  excludes name / email / any PII — resolving editedBy must never widen the
  disclosure surface. handle + urn are the same public identifiers the users
  search already exposes, so no per-caller visibility gate applies.
  """
  type NodeRevisionEditor {
    handle: String
    urn: String
  }

  # 046-usage-metering: effective-dated provider rate row. Prices are
  # micro-cents (1e-8 USD) per MILLION tokens, as base-10 integer strings.
  type AiModelPrice {
    id: ID!
    provider: String!
    model: String!
    # Pricing tier 1-3; tier 1 is the default everything resolves today.
    tier: Int!
    inputMicroCentsPerMTok: String!
    outputMicroCentsPerMTok: String!
    # Per-tier debit markup in basis points (2500 = 25%). Null falls back
    # to the CREDIT_MARKUP_PERCENT env default.
    markupBasisPoints: Int
    effectiveAt: DateTime!
    createdAt: DateTime!
    createdBy: String
  }

  type AiModelPriceList {
    items: [AiModelPrice!]!
    total: Int!
  }

  # 046-usage-metering: append-only org credit ledger row. Signed
  # micro-cents as a base-10 integer string (grants +, debits -).
  type CreditLedgerEntry {
    id: ID!
    organizationId: ID!
    kind: String!
    amountMicroCents: String!
    expiresAt: DateTime
    sourceType: String
    sourceId: String
    note: String
    createdAt: DateTime!
    createdBy: String
  }

  type CreditLedgerEntryList {
    items: [CreditLedgerEntry!]!
    total: Int!
  }

  type CreditBalance {
    organizationId: ID!
    balanceMicroCents: String!
  }

  input SetAiModelPriceInput {
    provider: String!
    model: String!
    # Pricing tier 1-3; defaults to 1.
    tier: Int
    inputMicroCentsPerMTok: String!
    outputMicroCentsPerMTok: String!
    # Per-tier debit markup in basis points (2500 = 25%); omit to fall
    # back to the CREDIT_MARKUP_PERCENT env default.
    markupBasisPoints: Int
    # Defaults to now. Appends a new effective-dated row - never mutates.
    effectiveAt: String
  }

  input GrantCreditsInput {
    orgRef: String!
    # Positive micro-cents, base-10 integer string.
    amountMicroCents: String!
    # Grant expiry policy field (no enforcement in Phase 0).
    expiresAt: String
    # Idempotency + provenance pair (both or neither), e.g.
    # ('stripe-checkout', <session id>). (sourceType, sourceId) is unique
    # across the ledger - re-granting the same pair returns the EXISTING
    # entry instead of double-crediting (at-least-once webhook safety).
    sourceType: String
    sourceId: String
    note: String
  }

  type NodeRevision {
    id: ID!
    "Computed end-anchored URN hrn:noderev:<root>:<mem>:<loc...>:<rev> (#696). Null for legacy rows without a revNo, and for multi-segment per-user memories the flat shape cannot express."
    urn: String
    "Per-node monotonic revision number (#696). Null on legacy rows predating the counter (backfilled by the migration)."
    revNo: Int
    nodeId: String!
    loc: String!
    name: String!
    alias: String
    description: String
    "Paragraph summary at capture (spec 031)."
    abstract: String
    content: String
    tags: [String!]!
    # ── #620: full curated-subset snapshot fields. Null on LEGACY rows
    # captured before the columns existed (nodeType doubles as the legacy
    # sentinel — it is non-null on every post-#620 snapshot).
    nodeType: String
    isLink: Boolean
    properties: JSON
    data: JSON
    seq: Int
    isRunnable: Boolean
    llmModel: String
    aiAgent: String
    "The editing User id, when a user is known (#620). Use editedByUser for resolution."
    editedBy: String
    """
    What is known about the editor when no User id is available (#620):
    'github:<login>' / 'email:<addr>' / 'user:<id>' identity strings, or
    'app:<App.id>' for App-key principals. (Legacy free-form #88 reasons /
    commit messages that squatted in editedBy were migrated to revLabel.)
    """
    editedByInfo: String
    """
    The editor resolved to a user (handle + URN) — from editedBy as a User id,
    the createdBy fallback (#619), or an identity-string form of editedByInfo
    ('github:<login>' resolves via the user's linked GitHub username). Null when
    nothing resolves — the portal falls back to the raw strings. Public
    identifiers only (#617).
    """
    editedByUser: NodeRevisionEditor
    "User-settable label for this revision (#620, 500-char cap) — set via updateNodeRevision; also captures the 'reason' supplied with the edit that took this snapshot (legacy reasons were migrated here)."
    revLabel: String
    """
    Which node fields the edit that took this snapshot changed, e.g.
    ["abstract","tags"] (#620). The snapshot is the PRE-edit state, so this
    describes the delta between this snapshot and the state that replaced it.
    Empty for legacy rows.
    """
    changes: [String!]!
    "Reserved (#620): User id that approved this revision. No write surface yet."
    approvedBy: String
    "approvedBy resolved to public identifiers (handle + URN), like editedByUser."
    approvedByUser: NodeRevisionEditor
    createdAt: DateTime!
  }

  type User {
    id: ID!
    handle: String
    "User-layer action-policy link (cor:acl:040:02, #510) — constrains runs made on the user's behalf. Null = no restriction. Self-authored via updateMyPolicy."
    policy: JSON
    # Canonical \`hrn:user:<handle>\` URN (spec cor:urn:010:01). Computed from the
    # handle; null for a handle-less user (who has no URN).
    urn: String
    githubId: Int
    githubUsername: String
    """
    Google account subject id (#837). Opaque provider identifier, never an
    address. Withheld (null) from a viewer who is not the user themselves, a
    platform admin, or a co-member of one of their orgs — the same #384 gate that
    name/email use.

    Load-bearing for duplicate-account triage: mergeUsers adopts a source
    provider id only where the target column is null, and identityProvider
    records only which provider CREATED the row, so it cannot be used to infer
    this (a GITHUB row may carry a linked googleId).
    """
    googleId: String
    "Apple account subject id (#837). Same gate and rationale as googleId."
    appleId: String
    identityProvider: String
    externalId: String
    externalAppId: String
    linkedAt: DateTime
    name: String
    email: String
    avatarUrl: String
    roles: [Role!]!
    maxReferrals: Int
    # 008-agent-installation: User-App memberships. Resolves to a non-empty
    # list only when the queried User is the authenticated user (mirrors
    # the User.agentSubscriptions resolver-side gate from 005).
    appMemberships: [AppMember!]!
  }

  # The runtime deployment of an Agent in an Organization. Owns long-lived
  # App Keys and references its Agent via App.agent_id (a direct FK; the
  # legacy AppAgent join was dropped in 008-agent-installation).
  type App {
    id: ID!
    name: String!
    urn: String!
    "App-layer action-policy link (cor:acl:040:02, #510). Null = no restriction. Org-admin-authored via updateApp."
    policy: JSON
    organizationId: String
    organization: Organization
    # 008-agent-installation: direct FK replaces the AppAgent join.
    agentId: ID
    agent: Agent
    """
    The installed Agent's canonical URN. An installed agent stays
    AUTHOR-ROOTED forever, so this is simply the Agent's own URN:
    hrn:agent:<author-org>:<agent-slug>. Two orgs installing same-slug
    agents from different authors therefore still produce distinct URNs
    (they differ at the author root), enabling audit-log entries to
    identify each install unambiguously without a PK disambiguator.
    The v1 spec-021 R2 install chain
    (hrn:agent:<installing-org>::<app-slug>::<author-org>:<agent-slug>)
    is RETIRED — see #697 Stage 2 / D10 and emitInstalledAgentUrnV2. Returns null when the App has no agent attached
    (orphan apps from the 008 cutover; new apps require an agentId per
    009).
    """
    installedAgentUrn: String
    trainingMode: Boolean!
    surfaces: [String!]!
    members: [AppMember!]!
    memberCount: Int!
    """
    The App's SHARED app-class memory (#965) — the team space the shared/team
    chat and the worklog live in, provisioned at install since #951. This is
    the App → memory hop clients need to default a team-memory argument
    (hadron-cli#399) instead of scanning every readable memory for
    Memory.appId. Read-only resolution, never provisions: the memory holding
    the App's 'worklog' root wins (the ledger home — oldest, mirroring the
    worklog locator), else the oldest agent-keyed shared row
    (sharedMemoryOfAgentId set; Worker working memories are also app-class
    rows under this App and are never this answer). Null when nothing has
    provisioned a shared memory yet (an App predating #951 with no team
    activity), or when the caller cannot read the memory record (the ordinary
    record read gate — denied and missing are indistinguishable).
    """
    sharedMemory: Memory
    appType: AppType!
    role: AppMembershipRole!
    description: String
    systemPrompt: String
    agentTools: [String!]!
    # 036-ai-service-config: the three AI fields below are registry-backed
    # reads of the App's config named 'default' (legacy columns dropped).
    aiProvider: String
    aiModel: String
    hasAiApiKey: Boolean!
    expiresAt: DateTime
    # App-original fields
    createUserPermission: CreateUserPermission!
    identifyUserMethod: IdentifyUserMethod!
    sessionTimeoutSeconds: Int!
    anonymousTtlDays: Int!
    """
    023-app-shape US1: Agents installed in this App, via the AppAgent
    N:M join. Multiple Agents can be installed; one App credential
    routes to all of them via the URN supplied in the request.
    """
    appAgents: [AppAgent!]!
    """
    023-app-shape: convenience that returns every installed Agent
    (equivalent to App.appAgents.map(aa => aa.agent)). Previously was
    a soft-deprecated single-element synthesis; now returns the FULL
    multi-Agent set per spec 023 US1.
    """
    agents: [Agent!]!
    keys: [AppKey!]!
    createdAt: DateTime!
    updatedAt: DateTime
  }

  """
  023-app-shape US1: the App↔Agent N:M join. Reintroduced after spec 008
  collapsed it; per FR-003 it carries NO role column (system memory is
  read-only to every App) and per FR-001 it carries NO trainingMode
  column (training mode is per-App, on App.trainingMode).
  """
  type AppAgent {
    app: App!
    agent: Agent!
    createdAt: DateTime!
    createdBy: String
    updatedAt: DateTime
    updatedBy: String
  }

  """
  Return shape for the installAgentIntoApp mutation. Wraps the new
  AppAgent row so callers can read its audit fields without re-querying.
  """
  type InstallAgentIntoAppPayload {
    appAgent: AppAgent!
  }

  """
  Return shape for the uninstallAgentFromApp mutation. The Agent's
  per-(App, Agent, *) memories are NOT cascade-deleted (spec 023 FR-005);
  they persist as orphans on the now-removed AppAgent edge.
  """
  type UninstallAgentFromAppPayload {
    appId: ID!
    agentId: ID!
  }

  """
  Return shape for the joinApp mutation (023-app-shape US2). The
  AppMember row is included so callers can read its derived
  isOrgExternal flag without a re-query.
  """
  type JoinAppPayload {
    appMember: AppMember!
  }

  """
  023-app-shape US3: role on a MemoryShare row. Asymmetric grant
  for personal-class memory.
  - reader: read access only.
  - writer: read + write (the grantee can add/edit/delete nodes
    within the memory).
  """
  enum MemoryShareRole {
    reader
    writer
  }

  """
  023-app-shape US3: asymmetric cross-user grant on a personal-class
  Memory. The principal (memory.userId) grants a grantee read/write
  access. Used for per-pairing isolation patterns (e.g., Alice's
  personal Memory paired-with-Mentor-A is distinct from her
  paired-with-Mentor-B Memory, each with its own MemoryShare).
  """
  type MemoryShare {
    memory: Memory!
    """
    The User who was granted access.
    """
    grantee: User!
    """
    The principal of the Memory (Memory.userId). Per spec 023 FR-019
    this is always the principal, even when an App backend made the
    API call on the principal's behalf — that actor is recorded in
    createdBy instead.
    """
    grantor: User!
    role: MemoryShareRole!
    createdAt: DateTime!
    """
    The API actor who created the row. Distinct from grantor when an
    App backend creates the share on the principal's behalf.
    """
    createdBy: String
    updatedAt: DateTime
    updatedBy: String
  }

  type CreateMemorySharePayload {
    memoryShare: MemoryShare!
  }

  type UpdateMemoryShareRolePayload {
    memoryShare: MemoryShare!
  }

  """
  Return shape for deleteMemoryShare. Both fields are RESOLVED primary
  keys, so a caller who passed a URN / email / handle can correlate the
  deletion. granteeId is the caller themselves on the self-removal path.
  """
  type DeleteMemorySharePayload {
    memoryId: ID!
    granteeId: ID!
  }

  """
  023-app-shape US4: role on a MemoryMember row. Symmetric team
  membership for group-class memory.
  - reader: read access.
  - writer: read + write (the member can add/edit/delete nodes
    within the memory).
  - owner: read + write + management — add/remove other members,
    change roles, delete the Memory itself. Subject to the
    last-owner protection rule (FR-038): the platform refuses
    to remove or demote the sole remaining owner; the path to
    fully empty a group memory is to delete it.
  """
  enum MemoryMemberRole {
    reader
    writer
    owner
  }

  """
  023-app-shape US4: symmetric team-membership row for group-class
  memory. The "Company Brain" model — multiple users collaboratively
  read/write a shared memory, governance by role, no single owner
  on the Memory itself.
  """
  type MemoryMember {
    memory: Memory!
    user: User!
    role: MemoryMemberRole!
    createdAt: DateTime!
    createdBy: String
    updatedAt: DateTime
    updatedBy: String
  }

  type AddMemoryMemberPayload {
    memoryMember: MemoryMember!
  }

  type UpdateMemoryMemberRolePayload {
    memoryMember: MemoryMember!
  }

  type RemoveMemoryMemberPayload {
    memoryId: ID!
    userId: ID!
  }

  """
  Return shape for the leaveApp mutation (023-app-shape US2). The
  user's personal-class Memory at (appId, userId) is NOT
  cascade-deleted (spec 008 FR-015 orphan retention); it re-attaches
  if the user later re-joins the same App.
  """
  type LeaveAppPayload {
    appId: ID!
    userId: ID!
  }

  enum AppType {
    WORKSTATION
    CHATBOT
    AGENT
    AUTOMATION
    CLOUD
    IOT
  }

  enum AppMembershipRole {
    OWNER
    ADMIN
    CONTRIBUTOR
    READER
  }

  # 008-agent-installation: User↔App membership join carrying a per-App role
  # validated against the parent Agent's installation_policy.memberRoles.
  type AppMember {
    appId: ID!
    userId: ID!
    app: App!
    user: User!
    role: String!
    """
    023-app-shape US2: true when this User is an AppMember of the App
    but NOT an OrgMember of the App's owning Organization. Derived at
    query time from the absence of an OrgMember row (per spec 023
    FR-011 — no appOnly column is added to the AppMember table).
    Unlocks the B2C / therapy / consumer use cases where end-users
    use an App without joining the operator's org.
    """
    isOrgExternal: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime
  }

  # 008-agent-installation: the Agent declarative knobs.
  enum AppMemoryKind {
    shared
    user
    none
  }

  type MemoryProvisioning {
    appMemory: AppMemoryKind!
  }

  type InstallationPolicy {
    """
    Integer-as-string OR the sentinel 'unlimited'. GraphQL does not have an
    Int|String union; clients parse: parseInt(maxMembers) succeeds for
    integer values; 'unlimited' is the sentinel.
    """
    maxMembers: String!
    memberRoles: [String!]!
  }

  # 008-agent-installation: Agent dependency edge ("Suite imports Calendar").
  # v1 enforces 1-level imports only.
  type AgentImport {
    parentAgentId: ID!
    importedAgentId: ID!
    parentAgent: Agent!
    importedAgent: Agent!
    position: Int!
    required: Boolean!
    createdAt: DateTime!
  }

  # 008-agent-installation: Org↔Agent license. Authorizes (a) creating an App
  # in this Org that uses this Agent, and (b) bundling this Agent in an
  # AgentImport edge of an Agent the Org owns. Sibling to AgentSubscription.
  type AgentOrgGrant {
    orgId: ID!
    agentId: ID!
    organization: Organization!
    agent: Agent!
    activatedAt: DateTime
    expiresAt: DateTime
    revokedAt: DateTime
    revokedBy: ID
    isActive: Boolean!
    createdAt: DateTime!
  }

  # 005-agent-subscription: User-side license expressing "this user is
  # authorized to use this agent." Auto-provisioned on first user-attributed
  # contact (server-side, not via a public mutation in v1); revocable by an
  # ADMIN/OWNER of the Agent's owning org.
  enum MemoryClass {
    system
    app
    knowledge
    personal
    """
    023-app-shape US4: team-shared memory with symmetric membership.
    Governed by a list of MemoryMember rows (each with reader/writer/
    owner role) — no single owner field on Memory. Closes the
    Company Brain gap that wasn't covered by the four legacy classes.
    """
    group
    """
    Single-owner, owner-only memory — no MemoryShare path (not
    shareable), no ADMIN/OWNER bypass. Spec 034 (hadron-server #242)
    made it user-creatable via createMemory: free-standing (no
    app/agent) or app-scoped. May opt into encrypt-at-rest
    (the private CLASS marks it; visibility is NULL), but the encryption
    implementation itself is a deferred follow-up — do NOT rely on
    at-rest encryption for secret material yet.
    """
    private
  }

  # 017-chat-visibility-and-personal-memory: a chat is created in one
  # of two tiers, chosen by the user at chat creation and immutable
  # thereafter. private chats live in the user's personal-class
  # memory; shared chats live in the App's app-class memory.
  enum ChatScope {
    private
    shared
  }

  type AgentSubscription {
    userId: ID!
    agentId: ID!
    user: User
    agent: Agent
    activatedAt: DateTime
    expiresAt: DateTime
    revokedAt: DateTime
    revokedBy: ID
    isActive: Boolean!
    createdAt: DateTime!
  }

  type AppKey {
    id: ID!
    appId: String!
    keyPreview: String!
    label: String
    createdAt: DateTime!
    lastUsedAt: DateTime
    revokedAt: DateTime
  }

  # Returned once at creation — the raw key is never stored
  type AppKeyCreated {
    key: AppKey!
    rawKey: String!
  }

  # 025-oauth-for-mcp: user-scoped bearer-token credential. Mirrors the
  # AppKey shape but resolves to a User instead of an App. Surfaced to
  # the portal revocation UI (Phase 3) so users can audit + revoke
  # their own keys. userId is intentionally absent — for self-service
  # v1 the caller is always the owner; admin-tooling auditability is
  # out of scope (see contracts/graphql-mutations.md, PR-137 delta D1).
  type UserApiKey {
    id: ID!
    keyPreview: String!
    label: String
    createdAt: DateTime!
    lastUsedAt: DateTime
    revokedAt: DateTime
    # Issuance path: portal (createUserApiKey) or oauth:<client_id>
    # (POST /oauth/token). Powers source labels in the revocation UI.
    issuedVia: String
  }

  # Returned once at creation — the raw key is never stored.
  # Renamed from PR 137's UserApiKeyCreated for Result-suffix
  # consistency; nested field is userApiKey, not key (PR-137 delta D2).
  type UserApiKeyCreateResult {
    userApiKey: UserApiKey!
    rawKey: String!
  }

  # The kind of principal a credential resolved to (issue #562). USER covers
  # both JWT sessions and hdr_user_ personal API keys; APP is an hdr_app_ key.
  # AGENT is reserved for a future agent-credential principal — no auth path
  # produces it today.
  enum PrincipalType {
    USER
    APP
    AGENT
  }

  # The resolved principal for the credential presented on THIS request
  # (issue #562). Exposes the AuthContext the server already resolves per
  # request (cor:aut:020:02) read-only, so any surface (CLI, portal) can
  # validate a token and name the exact credential without per-client hacks.
  #
  # Security posture (held deliberately):
  #   - Current-request only. There is intentionally no query that takes an
  #     arbitrary token as an argument — that would be a token oracle. The
  #     caller must possess the credential, exactly as today.
  #   - No reason-leak. A credential that does not resolve yields a null
  #     authContext (Query field), identically for revoked / never-existed /
  #     malformed. Once a credential HAS resolved (you authenticated as it),
  #     surfacing active-vs-revoked via apiKey.revokedAt is fine.
  type AuthContext {
    # Which kind of credential authenticated this request.
    principalType: PrincipalType!
    # The authenticated User — populated for USER principals (JWT or
    # hdr_user_ key), null for App keys.
    user: User
    # App.id — populated for APP principals (hdr_app_ key).
    appId: ID
    # Reserved for a future agent-credential principal; always null today.
    agentId: ID
    # The specific UserApiKey presented — populated only when the request
    # authenticated via an hdr_user_ key (its id, label, keyPreview,
    # createdAt, lastUsedAt, revokedAt). Null for JWT sessions and App keys.
    apiKey: UserApiKey
    # Set when the credential is an impersonation token: this request runs
    # READ-ONLY as the target user, scoped to one org. Null for every other
    # credential. Portal and CLI read this to render the acting-as state.
    impersonation: ImpersonationInfo
  }

  # Admin impersonation (read-only support sessions): the acting-as facts of
  # THIS request's credential, surfaced on AuthContext so whoami-style
  # consumers can name the real actor, the scope org, and the expiry.
  type ImpersonationInfo {
    sessionId: ID!
    # The admin behind the curtain (visibility per the normal User field
    # rules — the actor is a co-member of the scope org).
    actorUser: User
    organizationId: ID!
    expiresAt: DateTime!
    # Always true in v1 — impersonated sessions cannot mutate.
    readOnly: Boolean!
  }

  # One admin-impersonation session: the durable audit record (who
  # impersonated whom, in which org, when) AND the revocation source of
  # truth (stopImpersonation writes endedAt; rows are never deleted).
  type ImpersonationSession {
    id: ID!
    adminUser: User!
    targetUser: User!
    organization: Organization!
    reason: String
    createdAt: DateTime!
    expiresAt: DateTime!
    # Explicit-stop timestamp; null while live or when the session merely
    # lapsed by TTL.
    endedAt: DateTime
    # User.id of whoever stopped it early (the admin actor for a self-stop
    # from the impersonated context). Null while live / TTL-lapse.
    endedBy: ID
    # Derived: endedAt is null AND expiresAt is in the future.
    isActive: Boolean!
  }

  type ImpersonationSessionList {
    items: [ImpersonationSession!]!
    total: Int!
  }

  # Returned exactly once by startImpersonation — the token is never stored
  # or shown again (UserApiKey rawKey precedent).
  type StartImpersonationResult {
    session: ImpersonationSession!
    token: String!
  }

  input ImpersonationSessionFilter {
    # Only sessions that are live right now (endedAt null, unexpired).
    activeOnly: Boolean
  }

  # Returned once at App creation / regenerateAppKey — the raw key is never stored
  type AppCreated {
    app: App!
    rawKey: String!
  }

  # Decrypted AI config for an App (owner / org admin only).
  type AppAIConfig {
    provider: String!
    apiKey: String!
    model: String!
  }

  # A company or team that owns one or more Hadron memories.
  type Organization {
    id: ID!
    name: String!
    urn: String!
    "Org-layer action-policy link (cor:acl:040:02, #510). Null = no restriction. Org-admin-authored via updateOrganization."
    policy: JSON
    "cor:acl:080:04 — opt-in marketplace catalogue flag (advertisement, not access)."
    listedOnMarketplace: Boolean!
    githubInstallationId: Int
    githubAppId: String
    hasGithubAppPrivateKey: Boolean!
    members: [OrgMember!]!
    memories: [Memory!]!
    agents: [Agent!]!
    apps: [App!]!
    subscriptions: [MemorySubscription!]!
    exchangeConnections: [ExchangeConnection!]!
    # 008-agent-installation: this org's grants for using/bundling Agents.
    # Resolvable to ADMIN/OWNER of the org only.
    agentOrgGrants: [AgentOrgGrant!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  cor:acl:080:02 — a sanitized, non-member-safe view of a DISCOVERABLE org.
  Deliberately a SEPARATE type from Organization: it exposes only public
  identity + the org's public footprint, never members / private memories /
  apps / credentials (which the full Organization's nested resolvers would leak).
  """
  type PublicOrganization {
    id: ID!
    name: String!
    urn: String!
    listedOnMarketplace: Boolean!
    "The org's PUBLIC, non-app-scoped memories (sanitized refs)."
    publicMemories: [PublicResourceRef!]!
    "The org's PUBLIC agents (sanitized refs)."
    publicAgents: [PublicResourceRef!]!
  }

  "A minimal, safe reference to a public resource (marketplace / discovery)."
  type PublicResourceRef {
    id: ID!
    name: String!
    urn: String!
    description: String
  }

  "A paginated page of sanitized public resource refs (marketplace catalogue)."
  type PublicResourceRefPage {
    items: [PublicResourceRef!]!
    total: Int!
  }

  # Per-organization membership record for a user.
  type OrgMember {
    id: ID!
    user: User!
    "Target member's role in this org. Null when the viewer isn't an ADMIN/OWNER of the org (#384 field-level visibility); always visible for one's own membership."
    role: Role
    canInvite: Boolean!
    createdAt: DateTime!
  }

  # A Hadron memory (git repo + branch settings).
  # 033-rag-vector-retrieval: what a memory's vector index is built from.
  enum EmbeddingSource {
    abstract
    contentChunks
    both
  }

  type Memory {
    id: ID!
    organizationId: String
    organization: Organization
    """
    The memory's URN, grammar v2 (cor:urn:010:01): hrn:mem:<root>:<slug...>,
    emitted by safeCanonicalUrn/emitEntityUrnV2 from the stored urn — so a v1
    double-colon chain, a legacy single-colon row and an already-v2 row all read
    back identically here. <slug...> is one atom for a migrated memory but still
    several for a compound pre-Stage-3 per-user one (<root>:<agent>:app-user:<id>).

    The STORED column is the bare form (<root>:<slug>, no scheme prefix — the
    chk_memory_urn_not_prefixed guardrail rejects writing a rendered one); this
    field is the rendered view of it. When emission throws, the stored value is
    served raw and logged, so a bare, unprefixed value is a possible read.
    """
    urn: String!
    name: String!
    shortDescription: String
    description: String
    """
    Free-form structured metadata bag (client-defined JSON, no server-side
    semantics). Null when unset. Settable via createMemory / updateMemory.
    """
    data: JSON
    "#725 — opt-in per-memory property schema (declared collections + typed fields). NULL = unstructured. Authored via updateMemory; well-formedness validated server-side."
    schema: JSON
    tags: [String!]!
    license: String
    category0: String
    category1: String
    category2: String
    iconUrl: String
    heroUrl: String
    homeUrl: String
    source: String
    readBranch: String
    writeBranch: String
    # 035-visibility-enum-cleanup: nullable — set only for knowledge/group.
    visibility: MemoryVisibility
    "cor:acl:080:04 — opt-in marketplace catalogue flag (advertisement, not access)."
    listedOnMarketplace: Boolean!
    # 005-agent-subscription: four-way memory typology
    class: MemoryClass!
    """
    #766 — derived shareability signal: true iff this memory can be shared
    with an individual user via MemoryShare, i.e. class = 'personal'
    (spec 023 FR-018). Lets the CLI and portal surface or gate the share
    action before a createMemoryShare attempt rather than discovering
    InvalidMemoryClassForShareError at execution time.
    """
    shareable: Boolean!
    # 006-asset-upload-redesign: per-memory upload-acceptance gate.
    # Default true for app/knowledge/personal-class memories; false for
    # system-class. Org admins or memory owners can flip via the
    # setMemoryAcceptsUploads mutation (added in v2 story phases).
    acceptsUploads: Boolean!
    # 005-agent-subscription: User owner for personal-class memories.
    # Resolves to null for non-personal memories or when the caller is
    # not the memory owner / not ADMIN/OWNER of the memory's org.
    userId: ID
    isEncrypted: Boolean!
    # 033-rag-vector-retrieval: per-memory vector-index config.
    vectorIndexEnabled: Boolean!
    embeddingSource: EmbeddingSource!
    """
    Spec 033 US2 — chunk-window size in tokens (~4 chars/token). Null = platform default (512).
    Applies when embeddingSource includes content chunks.
    """
    chunkTokens: Int
    """
    Spec 033 US2 — overlap between consecutive chunks in tokens. Null = platform default (64).
    Must be < chunkTokens.
    """
    chunkOverlap: Int
    """
    Spec 033 US2 — force the fixed-size chunking strategy, bypassing the
    structure-aware default. Useful when the content's heading structure
    is unreliable (e.g. transcripts, machine-generated reports).
    """
    forceFixedSize: Boolean!
    """
    #621 — cap on how many NodeRevision rows are kept per node in this memory.
    On each new revision the oldest overflow is pruned. Default 10; minimum 1.
    """
    maxRevCount: Int!
    """
    Spec 033 FR-026 — timestamp at which the memory owner accepted the
    encrypted-memory vector-inversion disclosure. Set when the caller
    passes acknowledgeVectorInversionRisk: true on updateMemory for an
    isEncrypted: true memory enabling vectorIndexEnabled for the first
    time. The portal surfaces this readback so the user can confirm
    when they accepted the tradeoff (the disclosure text is the
    FR_026_DISCLOSURE constant in src/lib/entityRef/errors.ts).
    Survives a revoke + re-enable cycle (never cleared). Null for
    unencrypted memories and for encrypted memories where the index
    was never enabled.
    """
    vectorIndexEncryptedAckAt: DateTime
    userMemoryOfAgentId: String
    anonymousExpiresAt: DateTime
    # 008-agent-installation: app pivot for app/personal-class memories.
    # Required when class IN ('app', 'personal'); NULL otherwise.
    appId: ID
    app: App
    # Populated only for class = system — the agent this memory is
    # the system memory of. Null for regular knowledge memories.
    agent: Agent
    syncStatus: SyncStatus!
    syncError: String
    pendingEdgeCount: Int!
    lastSyncedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
    subscriptions: [MemorySubscription!]!
    """
    023-app-shape US3: cross-user grants on this memory. Non-empty
    only when class = personal (FR-018). Includes grantee + role for
    each row. Visible only to the principal (memory.userId) and to
    ADMIN/OWNER of the memory's owning org.
    """
    shares: [MemoryShare!]!
    """
    The caller's OWN share of this memory (they are the grantee), or
    null. Grantee-readable — unlike shares (principal / org-admin only),
    this returns at most the single MemoryShare row keyed
    (memoryId, callerId), so it never leaks co-grantees. null for a
    non-grantee or an App-key caller. Lets the portal render
    Shared-by-@grantor + the role on each shared-with-me row.
    """
    myShare: MemoryShare
    """
    023-app-shape US4: team membership rows on this memory. Non-empty
    only when class = group (FR-027). Visible to any current member
    (any role) and to ADMIN/OWNER of the memory's owning org.
    """
    members: [MemoryMember!]!
  }

  # The definition (one per Agent) — what a Builder creates and what the
  # marketplace sells. Per 008-agent-installation. An App is the deployment
  # of an Agent in some org.
  type Agent {
    id: ID!
    organizationId: String
    urn: String!
    name: String!
    description: String
    systemPrompt: String
    systemMemoryId: String
    visibility: AgentVisibility!
    "cor:acl:080:04 — opt-in marketplace catalogue flag (advertisement, not access)."
    listedOnMarketplace: Boolean!
    type: AgentType!
    surfaces: [String!]!
    # #928/#974 persona dressing (cor:agt:020:01): universal metadata that
    # lets any agent present as a colleague. The NAMED identity ('Iris') is
    # the Worker - the casting of an installed agent into an App - never a
    # field here. Pure metadata: no server behavior forks on these fields.
    "Persona role - free string with conventions ('backend-engineer')."
    personaRole: String
    "Persona identity TEMPLATE ('You are {{name}}, ...'); {{name}}/{{role}} are bound at casting time (Worker.prompt returns the bound result)."
    personaPrompt: String
    # 036-ai-service-config: the four AI fields below are registry-backed
    # reads of the Agent's config named 'default' (legacy columns dropped).
    aiProvider: String
    aiModel: String
    hasAiApiKey: Boolean!
    aiApiKeyPreview: String
    properties: JSON
    memoryItems: [AgentMemoryItem!]!
    # 008-agent-installation: declarative knobs.
    memoryProvisioning: MemoryProvisioning!
    installationPolicy: InstallationPolicy!
    # 008-agent-installation: dependency edges and installations.
    imports: [AgentImport!]!
    importedBy: [AgentImport!]!
    """
    Apps that have this Agent installed (via the AppAgent join). After
    spec 023-app-shape, an App can install multiple Agents; this list
    contains every App where THIS Agent is one of the installed ones.
    #551: these are OTHER tenants' App objects (whose keys/members are not
    re-gated at the field level), so — unlike the Agent's own fields — this is
    NOT public on a PUBLIC agent. Scoped to Apps in orgs the CALLER belongs to
    (platform ADMIN/OWNER: all); a non-member gets an empty list.
    """
    apps: [App!]!
    """
    023-app-shape: the AppAgent join rows where this Agent is installed.
    Use App.appAgents to get the join rows from the App side. #551: same
    caller-org scope as apps — never exposes a foreign org's App.
    """
    appAgents: [AppAgent!]!
    "Adoption count. #551: the agent owning-org members' view (0 otherwise)."
    appCount: Int!
    """
    Org grants for this Agent (which orgs were granted it). #551: the agent's
    customer list — visible to members of the Agent's owning org only (empty
    otherwise), regardless of the agent's PUBLIC visibility.
    """
    orgGrants: [AgentOrgGrant!]!
    createdAt: DateTime!
  }

  # Decrypted AI config for an agent. Only returned to org admins — the
  # portal backend uses it to make LLM calls on behalf of the logged-in user.
  # 036-ai-service-config: registry-backed (the Agent's config named
  # 'default'); prefer resolveAIConfig for new callers.
  type AgentAIConfig {
    provider: String!
    apiKey: String!
    model: String!
  }

  """
  036-ai-service-config: which entity owns an AiServiceConfig. Exactly one
  owner per config (DB-enforced).
  """
  enum AiConfigOwnerType {
    HADRON_SERVER
    ORGANIZATION
    APP
    AGENT
  }

  """
  036-ai-service-config: a named AI service configuration (masked
  management view — never carries key material beyond the preview).
  Owned by exactly one of HadronServer / Organization / App / Agent.
  Resolution walks App -> Agent -> Org (of the App) -> HadronServer and
  returns the first ENABLED config with the requested name. Well-known
  fallback name: 'default' (conventional extras: 'fast', 'frontier').
  Name is unique per owner.
  """
  type AiServiceConfig {
    id: ID!
    name: String!
    ownerType: AiConfigOwnerType!
    "ID of the owning HadronServer / Organization / App / Agent."
    ownerId: ID!
    "Provider identifier; v1 known: 'anthropic' | 'openai' | 'glm' | 'bedrock'."
    provider: String!
    "Model identifier, passed verbatim to the provider."
    model: String!
    hasApiKey: Boolean!
    "Ellipsis + last 4 characters of the stored key; null when no key."
    apiKeyPreview: String
    "Provider-specific knobs (maxTokens, thinking, effort, baseUrl, ...)."
    params: JSON
    "Disabled configs are skipped by resolution (the walk continues outward)."
    enabled: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime
  }

  """
  036-ai-service-config: privileged resolution result. Carries the
  DECRYPTED key — only returned by resolveAIConfig (org ADMIN of the
  effective context org, or platform ADMIN/OWNER); successor to
  agentAIConfig / appAIConfig.
  """
  type ResolvedAiConfig {
    configId: ID!
    name: String!
    "Which level matched: APP | AGENT | ORGANIZATION | HADRON_SERVER."
    ownerType: AiConfigOwnerType!
    provider: String!
    model: String!
    """
    Decrypted key. For provider 'bedrock' this is the JSON-encoded
    accessKeyId/secretAccessKey/region triple the portal stores.
    """
    apiKey: String!
    params: JSON
  }

  # A saved chat in one of the chat-scope tiers.
  #
  # Per spec 017, scope is set at chat creation and immutable
  # thereafter. private chats live in the author's personal-class
  # memory; shared chats live in the App's app-class memory and are
  # readable by every AppMember of that App.
  type Chat {
    id: ID!
    loc: String!
    title: String!
    conversationName: String
    stageName: String
    messageCount: Int!
    createdAt: DateTime!
    lastMessageAt: DateTime
    # 017-chat-visibility-and-personal-memory.
    scope: ChatScope!
    # The chat's author (chat-root node's createdBy). Null for legacy
    # chats predating createdBy persistence. Surfaces who started a
    # shared chat so the portal can distinguish own vs other-member
    # shared chats in the list.
    createdBy: ID
  }

  # One chat message in history, as returned by chatHistory.
  type ChatMessage {
    role: String!
    content: String!
    seq: Int
    createdAt: DateTime!
  }

  """
  One message in a team App's chat (#939, Worker envelope since #974). Exactly
  one of authorUserId / authorWorkerId is set: a human post carries the user, a
  worker post carries the Worker (the named casting, cor:dmo:050:11) plus the
  driving sessionId. mentions holds the lowercased tokens extracted
  server-side at write time (the '@worker-name / @handle' format, stored
  without the '@').
  """
  type TeamChatMessage {
    "The message node's id."
    nodeId: ID!
    "Ordering key, unique per chat, allocated atomically (ascending from 1)."
    seq: Int!
    body: String!
    at: DateTime!
    authorUserId: ID
    authorWorkerId: ID
    "Display convenience: the worker name or the user handle."
    authorName: String
    "The session driving the worker author, when posted via sessionRef."
    sessionId: ID
    "The seq this message replies to, when it is a reply."
    replyToSeq: Int
    mentions: [String!]!
  }

  type TeamChatMessagesPage {
    items: [TeamChatMessage!]!
    total: Int!
  }

  """
  One team-worklog record (#947) — an externally visible work milestone (a PR
  opened, a branch pushed, an issue closed), append-only. The worklog is the
  AUTHORITATIVE PR-session join (spec cor:agt:020:03); Session.prNumber is a
  latest-wins display convenience. ref carries the ONE canonical spelling per
  artifact (github: owner/repo#N, owner/repo@sha, owner/repo:branch,
  owner/repo; owner/repo lowercased).
  """
  type TeamWorkItem {
    "The record node's id."
    nodeId: ID!
    "The session the work is attributed to."
    sessionId: ID!
    "Display convenience, denormalized at write: the session's bound worker name, else the attributed user's handle (pre-#974 records surface their stored personaName here)."
    workerName: String!
    "The Worker (named casting) behind the record, when the session was worker-bound."
    workerId: ID
    "The external tool the artifact lives in ('github', ...). Lowercased."
    tool: String!
    "Artifact kind: pr, issue, commit, branch, or repo."
    kind: String!
    "The canonical artifact ref — the equality-lookup key."
    ref: String!
    "What happened: opened, merged, claimed, reviewed, closed, pushed, ... (free string, lowercased)."
    action: String!
    "When the record was made (server-stamped)."
    at: DateTime!
    "Optional display extras (title, URL) — never filtered on."
    detail: JSON
  }

  type TeamWorkItemsPage {
    items: [TeamWorkItem!]!
    total: Int!
  }

  """
  A Worker (#974, cor:dmo:050:11) — the named casting of an installed Agent
  into an App: 'Iris', the backend-engineer agent cast into the eng-team App.
  The Agent carries the reusable persona dressing; the Worker is the local
  named identity that does attributable work. Names are unique per App,
  case-insensitively, forever (retirement and uninstall never free them —
  cor:agt:020:02); rows survive the agent's uninstall. A Worker is addressable
  by its id or by the computed \`urn\` below (#991).
  """
  type Worker {
    id: ID!
    appId: ID!
    agentId: ID!
    "The worker's name ('Iris') — the identity every surface renders."
    name: String!
    """
    The URN atom, derived from the name at cast time and permanent thereafter
    (#991). Lowercased, sanitized to the URN slug charset, and iterated
    ('iris', 'iris-2', …) until free within the App — so deriving it NEVER
    refuses a cast, and the name collision stays the only allocation failure a
    caller sees (cor:agt:020:02).
    """
    slug: String!
    """
    hrn:worker:<root>:<app-slug>:<slug> (#991) — computed from the App's URN
    plus \`slug\`, not stored. Accepted anywhere a workerRef is taken, and
    resolvable via Query.resolveUrn, so a client can address a worker without
    holding its id. Null only when the App's URN predates the flat grammar-v2
    shape this arity requires.
    """
    urn: String
    "The cast-list role this filling answers ('backend-engineer')."
    role: String
    "Per-worker individuality layered over the agent's template prompt."
    promptOverride: String
    "The worker-scoped working memory in the App's container (null until provisioned)."
    memoryId: ID
    "The role-agent behind the casting."
    agent: Agent
    "The App whose staff this casting fills."
    app: App
    """
    The worker's boot prompt, resolved: the agent's personaPrompt template
    with {{name}}/{{role}} bound, then promptOverride appended as its own
    paragraph. Null when the agent carries no template and the worker no
    override.
    """
    prompt: String
    """
    #1029 — what a fresh binding of this worker inherits from the last one.

    Returned by startSession alongside the boot briefing (binding is briefing,
    so binding is handoff) and by the worker read, which is the recovery path
    after a context compaction — the reader who has most lost the handoff and
    least knows one exists. Working-state field: behind the worker read gate,
    masked to null on deny, like prompt/promptOverride/memoryId.
    """
    continuity: WorkerContinuity
    createdAt: DateTime!
    createdBy: String
    "Retirement instant — a retired worker stops authoring and takes no new sessions; the name stays reserved."
    retiredAt: DateTime
    retiredBy: String
  }

  """
  #1029 — the continuity a worker carries between stints.

  Handoffs are ordinary nodes in the worker's working memory, so a client walks
  the whole sequence through the node surface. This type exists for the ONE
  handoff that cannot be discovered: the newest, which a fresh session does not
  know to look for.
  """
  type WorkerContinuity {
    status: WorkerContinuityStatus!
    """
    The newest handoff node, or null when the worker has none. Present even
    when status is MISSING — a stale handoff is still the best available
    account of where this worker got to, and withholding it helps nobody.
    """
    handoff: Node
    """
    The worker's most recent ENDED session, as a SANITIZED projection — the
    three facts continuity needs, and deliberately not the Session object.

    The worker read gate that admits this field is WIDER than the session read
    gate: an AppMember who is not an org member passes the first and fails the
    second. Returning a Session here would hand them another driver's
    transcriptPath, host, repo and summary through its field resolvers, which
    assume the outer query authorized them (#552 / #983).
    """
    previousSession: WorkerContinuitySession
  }

  """
  #1029 — the previous stint, reduced to what a successor needs to know: which
  session it was, when it ended, and whether the server reaped it. Not a
  Session, on purpose (see WorkerContinuity.previousSession).
  """
  type WorkerContinuitySession {
    id: ID!
    endedAt: DateTime
    "Set when the #930 reaper ended it — nobody closed this stint deliberately."
    autoExpiredAt: DateTime
  }

  """
  #1029. MISSING is deliberately not "no handoff": it means the PREVIOUS stint
  did not write one, while \`handoff\` may still carry an older record. Silently
  presenting a stale handoff as current is the failure this distinction exists
  to prevent.
  """
  enum WorkerContinuityStatus {
    "No previous ended session — nothing to inherit, and that is not a gap."
    FIRST_STINT
    "The previous session wrote the handoff returned here."
    CURRENT
    "The previous session ended, or was auto-expired, without writing one."
    MISSING
  }

  type WorkersPage {
    items: [Worker!]!
    total: Int!
  }

  """
  What castWorker WOULD do (#964) — an unsaved projection, deliberately not a
  Worker (no fake id to mistake for a real row). Scalars only: the ids/names
  here are attribution-level facts the mint-gate audience already sees, so no
  nested entity hands out its field resolvers.
  """
  type CastWorkerPreview {
    "The name the cast would allocate: the explicit name, or the first register entry free against the App's FULL roster (retired names stay taken)."
    name: String!
    "The casting's role: explicit, else the agent's personaRole dressing."
    role: String
    "The role-agent the casting would bind."
    agentId: ID!
    agentName: String!
    "The Team Agent whose register resolved the name (register mode only; null with an explicit name)."
    teamAgentId: ID
    teamAgentName: String
    """
    The composed boot prompt, post {{name}}/{{role}} substitution with
    promptOverride appended — the same composition Worker.prompt performs,
    reviewable BEFORE the name is permanent. Null when the agent carries no
    template and no override was given.
    """
    prompt: String
    "Whether the agent's personaPrompt binds {{name}} — a nameless template silently produces workers whose prompt never names them. Null when the agent has no template."
    hasNamePlaceholder: Boolean
  }

  """
  One entry of a role's name register (#960, cor:agt:020:02). Order is
  allocation order — castWorker walks the register first-to-last.
  """
  type TeamRoleName {
    name: String!
    """
    True when a Worker holds this name in the App (case-insensitive, retired
    included — retirement never frees a name). Judged against the App's FULL
    roster server-side, which is why a client cannot compute this column.
    """
    taken: Boolean!
    "The Worker holding the name, when taken."
    heldBy: Worker
  }

  """
  A role definition (#960): the roles:<role> node in the Team Agent's system
  memory, carrying the name register (data.names) and register conventions.
  The persona prompt template is NOT here — with the Worker model (#974) it
  lives on the role-agent as dressing (personaRole + personaPrompt); roleAgent
  points at it.
  """
  type TeamRole {
    "The role slug, e.g. backend-engineer."
    role: String!
    "The node loc: roles:<role>."
    loc: String!
    nodeId: ID!
    description: String
    "Ordered register = allocation order (trimmed, case-insensitive dedup, first spelling wins)."
    register: [TeamRoleName!]!
    freeCount: Int!
    "True when no register name is free (empty registers included) — the next register-mode cast refuses WORKER_REGISTER_EXHAUSTED."
    exhausted: Boolean!
    "Register convention: initial-letter range like 'F-J' (data.nameRange). Writes validate added names against it."
    nameRange: String
    "Register convention prose (data.nameConvention)."
    nameConvention: String
    """
    The single installed agent whose personaRole matches this role — exactly
    the agent a role-mode castWorker would use (null when zero or ambiguous).
    Runs Query.agent's own read gate and masks to null on deny (the #552
    posture), like Worker.agent.
    """
    roleAgent: Agent
    """
    Whether the role-agent's personaPrompt binds {{name}} — the check that
    finds templates which silently produce nameless workers (role-agents
    authored before any guard existed). Null when no single role-agent
    resolves. Computed even when roleAgent itself is masked: it discloses one
    boolean about the caller's own App's casting default.
    """
    hasNamePlaceholder: Boolean
  }

  type TeamRolesPage {
    items: [TeamRole!]!
    total: Int!
  }

  "Result of deleteTeamRole (#1002)."
  type DeleteTeamRolePayload {
    "The role slug that was retired."
    role: String!
    """
    Nodes tombstoned — the roles:<role> definition plus any sub-nodes under it
    (a roles:<role>:notes is content OF the role and retires with it). Soft,
    so the subtree is recoverable.
    """
    nodesDeleted: Int!
    """
    Register spellings handed to the successor, in the order they were added to
    it. Empty when no transferTo was given.
    """
    transferredNames: [String!]!
    """
    The successor role AFTER the transfer, so a client can render the new
    register without a second read. Null when no transferTo was given.
    """
    transferredTo: TeamRole
  }

  "Result of updateTeamCollections (hadron-cli#401)."
  type TeamCollectionsPayload {
    "The team App's shared memory the declaration was written to."
    memoryId: ID!
    "The server-owned collections declared on it."
    collections: [String!]!
    "False when the declaration already matched the canonical definition (idempotent no-op)."
    changed: Boolean!
  }

  type AgentMemoryItem {
    id: ID!
    memory: Memory!
    role: String!
    createdAt: DateTime!
  }

  # An organization's subscription to a memory it does not own.
  type MemorySubscription {
    id: ID!
    memory: Memory!
    organization: Organization!
    role: Role!
    activated: Boolean!
    createdAt: DateTime!
  }

  # A connected email mailbox (identity record). Provider state lives in the
  # provider capability tool (hadrontool-ms-exchange, #396); mail operations
  # route through the tool. Mail ops are OWNER-ONLY (only userId may operate
  # the mailbox); list/delete stay org-ADMIN management operations.
  type ExchangeConnection {
    id: ID!
    organizationId: String!
    userId: String!
    mailboxEmail: String!
    displayName: String
    # Email provider backing this connection ('ms-exchange' today).
    provider: String!
    syncEnabled: Boolean!
    syncStatus: SyncStatus!
    lastSyncAt: DateTime
    lastError: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  # One Slack workspace install of the Hadron Slack app (spec 043).
  # Org-owned, workspace granularity: defaultAppId names the Hadron App that
  # serves /hadron commands from this workspace. The bot + app tokens live
  # ENCRYPTED IN THE TOOL (hadrontool-slack) — they are write-only inputs on
  # createSlackConnection and no field here ever returns them.
  type SlackConnection {
    id: ID!
    organizationId: String!
    defaultAppId: String!
    "Slack provider backing this connection ('slack' today)."
    provider: String!
    "Slack workspace (team) id, e.g. T0123456789."
    teamId: String!
    teamName: String!
    "The bot's Slack USER id (U…) — the sender on messages it posts."
    botUserId: String!
    "The bot's BOT id (B…) — what bot message events carry. Distinct from botUserId; the bridge loop filter needs both."
    botId: String!
    "'ACTIVE' or 'ERROR' (the tool's connection-status vocabulary)."
    status: String!
    lastError: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  # Uniform paginated list shape (cor:api:120).
  type SlackConnectionsPage {
    items: [SlackConnection!]!
    total: Int!
  }

  # One registered EXTERNAL MCP server (hadrontool-mcp conduit registry).
  # Org-owned. Static auth headers are encrypted at rest and WRITE-ONLY:
  # no field here ever returns them — hasHeaders is all a reader gets.
  # The row grants nothing by itself; every run-time call walks the policy
  # chain as 'tool.mcp__<slug>__<tool>' plus the run's action budget.
  type McpServer {
    id: ID!
    organizationId: String!
    "Run-tool name segment (mcp__<slug>__<tool>); lowercase [a-z0-9-], unique per org, immutable."
    slug: String!
    name: String!
    "Streamable-HTTP MCP endpoint URL."
    url: String!
    "Exposed-tool allowlist; empty = every tool the server advertises."
    toolAllowlist: [String!]!
    "Whether encrypted static headers are stored (the values are never returned)."
    hasHeaders: Boolean!
    "Disabled servers fail run-tool resolution loud, same as an unregistered slug."
    enabled: Boolean!
    createdAt: DateTime!
    createdBy: String
    updatedAt: DateTime!
    updatedBy: String
  }

  # Uniform paginated list shape (cor:api:120).
  type McpServersPage {
    items: [McpServer!]!
    total: Int!
  }

  # One tool an external MCP server advertises, as admitted by the
  # registry row (allowlist + name grammar + length cap applied) — what
  # this query returns IS what a run can declare in data.tools.
  type McpServerTool {
    "The tool's name on the external server."
    name: String!
    description: String
    "The run-tool / policy name: mcp__<slug>__<name>."
    runToolName: String!
    "The tool's argument JSON Schema, passed through verbatim."
    inputSchema: JSON
  }

  # One named, owner-scoped secret — the general secret store (#677).
  # Polymorphic owner (user | org | app | memory). The value is encrypted
  # at rest and WRITE-ONLY: no field here ever returns it — kind + metadata
  # are the inspectable half (you can see THAT a secret exists and, for
  # webfetch-auth, WHERE it applies, without decrypting). A bare name
  # resolves at run time via the CSS cascade, most-specific-first:
  # memory -> app -> user -> org.
  type Secret {
    id: ID!
    "Owner scope: user | org | app | memory."
    ownerType: String!
    ownerId: ID!
    "Cascade-resolution key; unique per owner; lowercase [a-z0-9-], max 64."
    name: String!
    "Extensible kind; v1: generic | webfetch-auth."
    kind: String!
    "The NON-secret, inspectable half (webfetch-auth: { type, urlPrefix })."
    metadata: JSON
    createdAt: DateTime!
    createdBy: String
    updatedAt: DateTime!
    updatedBy: String
  }

  # Uniform paginated list shape (cor:api:120).
  type SecretsPage {
    items: [Secret!]!
    total: Int!
  }

  # One registered Home Assistant instance (hadrontool-home-assistant
  # registry, hadron-server#640). Org-owned. The long-lived access token
  # is encrypted at rest and WRITE-ONLY: no field here ever returns it.
  # The row grants nothing by itself; every run-time call walks the policy
  # chain as 'tool.ha__<slug>__<op>' plus the run's action budget.
  type HomeAssistantInstance {
    id: ID!
    organizationId: String!
    "Run-tool name segment (ha__<slug>__<op>); lowercase [a-z0-9-], unique per org, immutable."
    slug: String!
    name: String!
    "Home Assistant base URL (e.g. https://ha.example.com or a Nabu Casa remote URL)."
    url: String!
    "Exposed-op allowlist over the closed op catalog; empty = every op. Lets an admin register a read-only instance."
    opAllowlist: [String!]!
    "Disabled instances fail run-tool resolution loud, same as an unregistered slug."
    enabled: Boolean!
    createdAt: DateTime!
    createdBy: String
    updatedAt: DateTime!
    updatedBy: String
  }

  # Uniform paginated list shape (cor:api:120).
  type HomeAssistantInstancesPage {
    items: [HomeAssistantInstance!]!
    total: Int!
  }

  "One org-owned BYO Resend sender. The API key is encrypted and write-only."
  type ResendSender {
    id: ID!
    organizationId: String!
    "Fixed sender identity, e.g. Hadron Agent <agent@example.com>; Resend enforces verification."
    from: String!
    "Whether an encrypted API key is stored; the key is never returned."
    hasApiKey: Boolean!
    enabled: Boolean!
    createdAt: DateTime!
    createdBy: String
    updatedAt: DateTime!
    updatedBy: String
  }

  type ResendSendersPage {
    items: [ResendSender!]!
    total: Int!
  }

  # One op of the CLOSED Home Assistant op catalog, as admitted by a
  # registry row's allowlist — what this query returns IS what a run can
  # declare in data.tools. The catalog is static (no upstream round-trip).
  type HomeAssistantOp {
    "The op segment, e.g. call_service."
    op: String!
    description: String!
    "The run-tool / policy name: ha__<slug>__<op>."
    runToolName: String!
    "The op's argument JSON Schema."
    inputSchema: JSON
  }

  # Provider-neutral flag state (spec 002) — Graph's tri-state mapped to a
  # neutral vocabulary so a future Gmail tool can map its own subset.
  enum EmailFlag {
    FLAGGED
    NONE
    COMPLETE
  }

  # Result of emailSaveDraft: the provider-side draft (it lives in the
  # mailbox's Drafts folder, not in any platform table — spec 002 US5).
  type EmailDraftInfo {
    draftId: ID!
    conversationId: ID
  }

  type ExchangeMessage {
    id: ID!
    subject: String
    from: String
    receivedDateTime: DateTime
    isRead: Boolean
    bodyPreview: String
    body: String
    hasAttachments: Boolean
  }

  type ExchangeFolder {
    id: ID!
    displayName: String!
    totalItemCount: Int
    unreadItemCount: Int
  }

  # ── Calendar surface (hadrontool-google-cal; provider-neutral) ────────
  # Calendar connections are ExchangeConnection rows (provider 'google-cal')
  # on the same owner-only + ConnectionGrant gate as mail; only the
  # operations differ. Shapes mirror the tool's neutral contract so an
  # ms-exchange calendar sibling needs zero schema changes.

  "Provider-neutral attendee response. NONE = invited, not yet answered."
  enum CalendarEventResponse {
    ACCEPTED
    DECLINED
    TENTATIVE
    NONE
  }

  "One calendar the connected account can see."
  type CalendarInfo {
    id: ID!
    name: String!
    description: String
    timeZone: String
    "True for the account's primary calendar (the default calendarId)."
    isPrimary: Boolean!
    "True when the connected account may create/modify events here."
    canEdit: Boolean!
  }

  """
  An event boundary: exactly one of dateTime (timed, with timeZone) or
  date (YYYY-MM-DD, all-day) is set.
  """
  type CalendarEventTime {
    "Instant for a timed event. Exactly one of dateTime / date is set."
    dateTime: DateTime
    """
    Calendar date for an all-day event, as YYYY-MM-DD. Deliberately String
    and NOT DateTime (#205): an all-day event has no instant, and widening it
    to a timestamp would force a timezone the provider never supplied.
    """
    date: String
    timeZone: String
  }

  type CalendarAttendee {
    name: String
    address: String!
    optional: Boolean!
    response: CalendarEventResponse!
  }

  type CalendarPerson {
    name: String
    address: String
  }

  type CalendarEvent {
    id: ID!
    calendarId: String!
    title: String
    description: String
    location: String
    start: CalendarEventTime!
    end: CalendarEventTime!
    isAllDay: Boolean!
    "confirmed, tentative, or cancelled (provider-neutral vocabulary)."
    status: String!
    organizer: CalendarPerson
    "True when the connected account organized the event."
    isOrganizer: Boolean!
    attendees: [CalendarAttendee!]!
    "The connected account's own response; null when it is not an attendee."
    myResponse: CalendarEventResponse
    webLink: String
    "Series id when this is an instance of a recurring event."
    seriesId: ID
    createdAt: DateTime
    updatedAt: DateTime
  }

  type ScheduleBusyInterval {
    start: DateTime!
    end: DateTime!
  }

  "Free/busy intervals for one requested schedule (calendarSchedule)."
  type ScheduleFreeBusy {
    id: ID!
    busy: [ScheduleBusyInterval!]!
    "Set when the provider could not resolve this schedule; the query still succeeds for the others."
    error: String
  }

  """
  An event boundary for create/update: exactly one of dateTime (timed) or
  date (YYYY-MM-DD, all-day). A dateTime needs timeZone unless it carries
  its own UTC offset — a zone-less value is rejected, never guessed.
  """
  input CalendarEventTimeInput {
    dateTime: String
    date: String
    timeZone: String
  }

  # ── Drive surface (hadrontool-google-drive, #749; provider-neutral) ───
  # Drive connections are ExchangeConnection rows (provider 'google-drive')
  # on the same owner-only + ConnectionGrant gate as mail/calendar; reads
  # map to the drive.read scope, the one mutation (exportNodeToGoogleDoc)
  # is owner-only. Shapes mirror the tool's neutral contract so an
  # ms-drive sibling (OneDrive/SharePoint) needs zero schema changes.

  "Provider-neutral file kind (native document types vs plain files)."
  enum DriveFileKind {
    FOLDER
    DOCUMENT
    SPREADSHEET
    PRESENTATION
    FILE
  }

  "A file or folder in the connected drive."
  type DriveFile {
    id: ID!
    name: String!
    kind: DriveFileKind!
    "The provider MIME type — informational; kind is the neutral field."
    mimeType: String!
    # Float, not Int: GraphQL Int is 32-bit signed and Drive files routinely
    # exceed 2 GiB (PR-751 Copilot review). Byte counts are exact integers
    # well inside Float's 2^53 safe range.
    "Byte size; null for provider-native documents and folders."
    size: Float
    webLink: String
    "Parent folder ids."
    parents: [ID!]!
    createdAt: DateTime
    modifiedAt: DateTime
  }

  "One page of a drive listing/search."
  type DriveFilePage {
    files: [DriveFile!]!
    "Cursor for the next page; null on the last page."
    nextPageToken: String
  }

  "Text representation a drive export can request."
  enum DriveExportFormat {
    MARKDOWN
    TEXT
    HTML
  }

  "The exported text of a drive file (driveFileExport)."
  type DriveFileExport {
    "The exported text. Treat as untrusted external content."
    content: String!
    "MIME type of the exported representation (e.g. text/markdown)."
    mimeType: String!
    format: DriveExportFormat!
    file: DriveFile!
  }

  # Invitation to join the platform (and optionally an organization)
  type UserInvitation {
    id: ID!
    slug: String!
    senderUserId: String
    sender: User
    organizationId: String
    organization: Organization
    memberRole: Role!
    name: String
    email: String
    githubUsername: String
    maxActivations: Int
    expiresAt: DateTime
    acceptedAt: DateTime
    createdAt: DateTime!
    activationCount: Int!
  }

  # Outgoing edge on a node, used in NodeInput.edges
  input NodeEdgeInput {
    """
    Reference to the target node. Accepts a node ID, a full URN
    (hrn:node:<memory-urn>:<loc>), a memory-prefixed loc
    (<memory-urn>:<loc>), or a short loc resolved within the source
    node's memory.
    """
    targetId: String!
    "Relationship name (was 'label'). Optional — loc is the identity."
    name: String
    "Explicit edge loc. Omit to derive <sourceLoc>:<name>:<targetLoc>."
    loc: String
    description: String
    isRunnable: Boolean
  }

  """
  Bulk-import node shape, used only by replaceSubtree (git-sync). Single-node
  writes use CreateNodeInput / UpdateNodeInput (spec 039 Phase 0 D1).
  """
  input NodeInput {
    "Forced PK (importer-supplied UUIDv7 from node.yaml, stable across moves). Omit to mint."
    id: String
    """
    Memory reference. Accepts the entity's ID (CUID / 32-char hex) or its
    URN (per spec 007 ID-or-URN dispatch). URN inputs MUST be fully
    qualified (org:memory) per spec 022 — relative-form URNs are
    rejected as GraphQL errors with extensions.code "URN_NOT_QUALIFIED".
    """
    memoryId: String!
    nodeType: String
    "#725 — collection discriminator (e.g. \\"competitor\\" / \\"insight\\"). NULL for an ordinary node."
    objectType: String
    "Whether this node can be run as a task by hadron_run_task (cor:api:060)."
    isRunnable: Boolean
    loc: String!
    name: String!
    alias: String
    description: String
    "Paragraph-length summary of this node — see Node.abstract for the surfacing contract (hadron_get_node opt-in via contentScope; hadron_find_nodes preview ships in US2). Optional. Omit to preserve; null to clear; string to replace. Empty + whitespace-only normalize to null. Cap is 2000 characters."
    abstract: String
    content: String
    seq: Int
    tags: [String!]
    properties: JSON
    data: JSON
    ownerRepo: String
    llmModel: String
    aiAgent: String
    # Replace all outgoing edges when provided (omit to leave edges unchanged)
    edges: [NodeEdgeInput!]
    """
    Why this change was made — recorded on the revision-history snapshot
    (NodeRevision.revLabel, #620; historically it squatted in editedBy),
    mirroring hadron_update_node's reason arg so CLI and MCP edits leave
    equally-traceable history. Only an update snapshots a prior revision, so
    reason has no effect on a pure create.
    """
    reason: String
  }

  """
  Input for createNode. 'memoryId', 'loc', and 'name' are required; creating
  is create-only — a live node at (memoryId, loc) rejects with
  NodeLocConflictError (spec 039 Phase 0 D1/D4).
  """
  input CreateNodeInput {
    "Forced PK (importer/sync use case, e.g. a stable UUIDv7). Only ever a create-id here — never a selector (D2). Omit to mint."
    id: String
    """
    Memory reference. Accepts the entity's ID (CUID / 32-char hex) or its
    URN (per spec 007 ID-or-URN dispatch). URN inputs MUST be fully
    qualified (org:memory) per spec 022 — relative-form URNs are
    rejected as GraphQL errors with extensions.code "URN_NOT_QUALIFIED".
    """
    memoryId: String!
    loc: String!
    name: String!
    nodeType: String
    "#725 — collection discriminator (e.g. \\"competitor\\" / \\"insight\\"). NULL for an ordinary node."
    objectType: String
    "Whether this node can be run as a task by hadron_run_task (cor:api:060)."
    isRunnable: Boolean
    alias: String
    description: String
    "Paragraph-length summary of this node — see Node.abstract for the surfacing contract. Optional. Empty + whitespace-only normalize to null. Cap is 2000 characters."
    abstract: String
    content: String
    "MIME type of content (#476/#488, spec cor:cnv:010:01): 'text/markdown' (default) stores as-is; 'text/html' converts captured DOM to Markdown; 'application/pdf' extracts a PDF's text layer to Markdown (send 'content' as raw base64 — a PDF is binary; scanned/image-only PDFs error). The conversion runs before storage and fills properties.title from the extracted title when not supplied. Consumed at write time — never persisted. Any other value is rejected."
    contentType: String
    seq: Int
    tags: [String!]
    properties: JSON
    data: JSON
    ownerRepo: String
    llmModel: String
    aiAgent: String
    "Outgoing edges to create with the node."
    edges: [NodeEdgeInput!]
    "Recorded on revision history only when a soft-deleted node is resurrected (a pure create snapshots nothing)."
    reason: String
  }

  """
  Input for updateNode. Identify the target by 'id' (PK or fully-qualified
  node URN) XOR ('memoryId' + 'loc') — both selectors, or neither, is an
  error (spec 039 Phase 0 D2). updateNode never creates and never moves (D3).
  Every content field is optional: omitted = preserved (D4).
  """
  input UpdateNodeInput {
    "The node to change: PK (CUID / 32-char hex) or fully-qualified node URN (hrn:node:<root>:<memory>:<loc>). XOR with memoryId+loc."
    id: String
    "Selector, with 'loc': the target's memory (ID or fully-qualified URN). XOR with 'id'."
    memoryId: String
    "Selector, with 'memoryId': the target's current loc. Not writable here — moveNode relocates."
    loc: String
    "Omit to preserve (D4)."
    name: String
    nodeType: String
    "#725 — collection discriminator (e.g. \\"competitor\\"). Omit to preserve; null to clear."
    objectType: String
    "Whether this node can be run as a task by hadron_run_task (cor:api:060). Omit to preserve."
    isRunnable: Boolean
    alias: String
    description: String
    "Paragraph-length summary of this node — see Node.abstract for the surfacing contract. Omit to preserve; null to clear; string to replace. Empty + whitespace-only normalize to null. Cap is 2000 characters."
    abstract: String
    content: String
    "MIME type of content (#476/#488, spec cor:cnv:010:01): 'text/markdown' (default) stores as-is; 'text/html' converts captured DOM to Markdown; 'application/pdf' extracts a PDF's text layer to Markdown (send 'content' as raw base64 — a PDF is binary; scanned/image-only PDFs error). The conversion runs before storage and fills properties.title from the extracted title when not supplied. Consumed at write time — never persisted. Any other value is rejected."
    contentType: String
    seq: Int
    "Omit to preserve existing tags (issue #235); supply to replace the set."
    tags: [String!]
    properties: JSON
    data: JSON
    ownerRepo: String
    llmModel: String
    aiAgent: String
    # Replace all outgoing edges when provided (omit to leave edges unchanged)
    edges: [NodeEdgeInput!]
    """
    Why this change was made — recorded on the revision-history snapshot
    (NodeRevision.revLabel, #620; historically it squatted in editedBy),
    mirroring hadron_update_node's reason arg so CLI and MCP edits leave
    equally-traceable history.
    """
    reason: String
  }

  """
  Input for importNode (#457). Target: 'nodeUrn' XOR ('memoryId' + 'loc') —
  the URN may name a not-yet-existing node (import creates it). Source:
  exactly one of 'url' | 'content'.
  """
  input ImportNodeInput {
    "Target memory (ID or fully-qualified URN), with 'loc'. XOR with 'nodeUrn'."
    memoryId: String
    "Target loc within 'memoryId'. XOR with 'nodeUrn'."
    loc: String
    "Fully-qualified node URN naming the target (existing or new). XOR with memoryId+loc."
    nodeUrn: String
    "Source URL (http/https) — fetched server-side, SSRF-guarded, WITHOUT user credentials."
    url: String
    "Inline source content (e.g. the Web Clipper's authenticated-DOM capture). XOR with 'url'."
    content: String
    "MIME type of 'content': text/html (DEFAULT here — unlike createNode) converts to Markdown at the write seam; text/markdown stores as-is; application/pdf extracts a PDF's text layer to Markdown ('content' must be raw base64 — a PDF is binary; scanned/image-only PDFs error). Ignored on the url path (always HTML)."
    contentType: String
    "Display name. Default: the extracted page/article/document title; on a re-import of an existing node the current name is preserved; a fresh create without either falls back to the loc leaf."
    name: String
    "Default 'webpage' (or 'info' when contentType is application/pdf)."
    nodeType: String
    "Merged provenance metadata; the server sets properties.url on the url path when absent (properties.title is filled from the extracted title by the write seam)."
    properties: JSON
    "Task node to run against the imported node once stored (#528) — PK or fully-qualified URN. Presence triggers a MANUAL app run; the result envelope is FETCH_PENDING + jobId (poll appRun(ref:)). The imported node's URN is passed to the task as eventData.importedNodeUrn."
    taskRef: ID
    "Extra template args merged into the task run's eventData (only meaningful with taskRef)."
    taskArgs: JSON
    "App to run the task under — PK or URN. Falls back to the caller's active App. Only meaningful with taskRef."
    appRef: ID
  }

  """
  importNode outcome. Sync v1 always returns STORED with the stored node;
  FETCH_PENDING + jobId are RESERVED for the future async url path (same API
  shape, no breaking change when it lands).
  """
  enum ImportNodeStatus {
    STORED
    FETCH_PENDING
  }

  type ImportNodeResult {
    status: ImportNodeStatus!
    node: Node
    "Reserved for the async path — always null in sync v1."
    jobId: ID
  }

  # ── Spec 040 — headless agent runs (cor:agt:010) ──────────────────────────

  enum AppRunStatus { PENDING RUNNING COMPLETED FAILED TIMED_OUT CANCELLED }
  enum AppRunTriggerKind { SCHEDULE WEBHOOK MANUAL INTEGRATION SPAWN }

  # One headless run — the audit record AND (v1) the activation: policy
  # snapshot, live budgets (zeroing halts the run), lifecycle, trigger
  # provenance. Spec cor:agt:010:02.
  type AppRun {
    id: ID!
    "Computed grammar-v2 URN hrn:apprun:<root>:<app>:<run-id> (#696). Null for the rare multi-segment App URN the flat shape cannot express."
    urn: String
    organizationId: ID!
    appId: ID!
    agentId: ID
    "On-behalf-of user (cor:agt:010:01). Null = pure App service identity."
    userId: ID
    triggerKind: AppRunTriggerKind!
    triggerId: ID
    entryNodeUrn: String!
    eventData: JSON
    "The run envelope (plan-multi-node D-MN-1): fields extracted by flow nodes as the walker advances. eventData stays the immutable trigger payload; on key collision the envelope wins."
    data: JSON
    "Per-hop trail (#538): one element per completed hop — [{node, edgeOut, startedAt, finishedAt, tokensSpent}]. edgeOut is the routing edge taken FROM the hop (null on the last). A hop that failed mid-execution has no element; curNodeUrn + failure identify it."
    hops: JSON
    "Fan-out state (plan-spawn, #548): set on runs that called hadron_spawn — {processItem, itemKey, callback?, itemCallback?, total, callbackFiredAt?, callbackError?}. callbackError records a callback mint that was denied (quota/policy) — the digest that never came."
    spawn: JSON
    policy: JSON
    "Remaining LLM-token budget — live-decremented; zero halts the run."
    budgetTokens: Int
    "Remaining action budget — live-decremented per write/tool action."
    budgetActions: Int
    """
    Total LLM tokens consumed by this run (#832). Unclamped, so it stays
    truthful when a hop overshoots the remaining budget — unlike
    budgetTokensInitial minus budgetTokens, whose decrement is clamped.

    Counts every hop whose LLM call COMPLETED, including hops whose run later
    failed — strictly more than a sum over the hops trail, which has no element
    for a hop that did not complete.

    KNOWN GAP: a hop aborted by the TOOL LOOP (a tool denied by policy, or a
    tool handler that threw) is NOT counted. The provider has already billed
    that call, but the tool-loop helper discards the accumulated usage when a
    tool throws, so the number is not available at the failure site. Such a run
    under-reports. Do not treat this as a billing figure.

    NULL means UNKNOWN: a run minted before the counter existed, with no hop
    trail to back-fill from. 0 means it genuinely spent nothing.
    """
    tokensSpent: Int
    """
    Total budgeted actions consumed (#832) — only actions actually admitted by
    the budget guard; a denied action counts nothing.

    NULL means UNKNOWN, not zero: runs minted before the counter existed have
    no recorded action spend and, unlike tokens, no hop-trail signal to
    reconstruct one from. Reporting 0 would contradict their already-decremented
    budgetActions.
    """
    actionsSpent: Int
    """
    The token budget this run was MINTED with — budgetTokens is what REMAINS.
    NULL for runs minted before this was recorded, which is deliberate: 0 would
    render as 'no budget' rather than 'unknown'.
    """
    budgetTokensInitial: Int
    "The action budget this run was minted with (#832). NULL for pre-existing runs."
    budgetActionsInitial: Int
    status: AppRunStatus!
    curNodeUrn: String
    parentRunId: ID
    failure: JSON
    timeoutMs: Int
    attempts: Int!
    startedAt: DateTime
    finishedAt: DateTime
    createdAt: DateTime!
    createdBy: String

    # --- Relations (#831). All NULLABLE and independently gated: the appRuns
    # org-READER gate authorizes the RUN, not everything hanging off it, and a
    # nested object inherits its own type's field resolvers (App.keys /
    # App.members do not re-check — the #552 class). Denied and deleted both
    # read as null; the FK scalars above stay the durable audit record.
    """
    The App this run activated. Null when the caller may not read that App, or
    when the App row was hard-deleted. appId remains the audit record.
    """
    app: App
    "The agent that ran, when the run resolved one and the caller may read it."
    agent: Agent
    "On-behalf-of user (cor:agt:010:01). Null = pure App service identity. Personal fields on the returned User carry their own #384 gate."
    user: User
    """
    The resolved entry node. NULLABLE by design — entryNodeUrn is the immutable
    audit record and the node may have been deleted, moved, or be unreadable to
    this caller since the run. A null here is a normal, expected state.
    """
    entryNode: Node
  }

  "One health check the validator runs (#819)."
  enum MemoryValidationCheck {
    "An edge whose target node is missing OR soft-deleted. A hard-deleted target cannot occur - Edge.target is FK-enforced with onDelete: Cascade - so in practice this means a dangling edge to a tombstone."
    BROKEN_REF
    "A node with no description, content, or abstract."
    SPARSE
    "The abstract no longer reflects current content (spec 032 FR-011)."
    STALE_ABSTRACT
    "embedding_failed_at is set - a retryable failure awaiting its backoff, or the permanent class (deterministic 4xx, dimension mismatch, #206 encrypted-no-plaintext) recoverable via retryFailedEmbeddings (spec 033 / #882). Such a node is absent from vector search, which from outside looks identical to no hits matching."
    EMBED_FAILED
    "objectType/properties violate the memory declared schema (#725)."
    SCHEMA
  }

  "One finding (#819). nodeUrn is null when the URN could not be composed - a memory URN the flat v2 shape cannot express, or an unexpected/legacy loc - in which case nodeId and nodeLoc still identify the node."
  type MemoryValidationFinding {
    kind: MemoryValidationCheck!
    nodeId: ID!
    nodeLoc: String!
    nodeUrn: String
    detail: String!
  }

  """
  A check that could NOT run (#819). Reported explicitly rather than silently
  omitted: a clean bill of health that quietly skipped a check is worse than no
  report at all.
  """
  type MemoryValidationSkippedCheck {
    check: MemoryValidationCheck!
    reason: String!
  }

  type MemoryValidationResult {
    memoryId: ID!
    "Live (non-deleted) nodes scanned - soft-deleted tombstones are excluded, since their findings would be unactionable (#884). The whole memory in one pass - the checks are cross-referential, so a partial scan would produce false positives rather than fewer findings."
    nodesChecked: Int!
    "Findings, capped by the limit argument."
    findings: [MemoryValidationFinding!]!
    "The TRUE finding count, before any truncation - gate CI on this, not on findings.length."
    totalFindings: Int!
    "True when findings was capped and totalFindings is larger."
    truncated: Boolean!
    skippedChecks: [MemoryValidationSkippedCheck!]!
    """
    True only when EVERY check ran and none found anything. A skipped check
    makes this false even with zero findings - you cannot claim health for a
    check you did not run.
    """
    ok: Boolean!
  }

  type AppRunsPage {
    items: [AppRun!]!
    total: Int!
  }

  """
  Orderable columns on the appRuns list (#833). Reuses the shared
  SortDirection enum. Default createdAt desc — existing callers depend on
  newest-first.

  startedAt / finishedAt are NULLABLE (a PENDING run has neither); nulls sort
  LAST in both directions, so unstarted runs never crowd out the rows an
  operator asked to see. Every sort carries an id tiebreak so offset paging is
  deterministic.

  Duration (finishedAt - startedAt) is deliberately absent: it has no stored
  column and Prisma cannot order by a computed expression, so it needs a
  generated column of its own - tracked separately rather than half-shipped.
  """
  enum AppRunSortField {
    createdAt
    startedAt
    finishedAt
    status
  }

  "Recurring trigger (cor:agt:010, D-2026-07-04-E)."
  type AgentSchedule {
    id: ID!
    organizationId: ID!
    appId: ID!
    agentId: ID
    "On-behalf-of user captured at creation; v1 only the creator themself."
    userId: ID
    name: String!
    "5-field cron for recurring schedules; null for one-shots (#510)."
    cron: String
    "One-shot instant (#510); null for recurring schedules. XOR with cron."
    runAt: DateTime
    timezone: String!
    entryNodeUrn: String!
    eventData: JSON
    policy: JSON
    aiConfigName: String
    enabled: Boolean!
    lastRunAt: DateTime
    nextRunAt: DateTime
    createdAt: DateTime!
    createdBy: String
  }

  type AgentSchedulesPage {
    items: [AgentSchedule!]!
    total: Int!
  }

  input CreateAgentScheduleInput {
    "App the run executes as — ref: PK or fully-qualified URN."
    appRef: String!
    name: String!
    "Recurring: 5-field cron expression, evaluated in timezone (default UTC). Provide exactly one of cron / runAt."
    cron: String
    "One-shot: run once at this ISO-8601 instant (#510). Provide exactly one of cron / runAt."
    runAt: String
    timezone: String
    "Fully-qualified URN of the prompt node to run (D-2026-05-09-012/017)."
    entryNodeUrn: String!
    "Agent — ref: PK or URN; must be installed in the App."
    agentRef: String
    "true: the run acts on behalf of YOU (required to reach your personal memories). v1 never delegates a third party (cor:agt:010:01)."
    runAsSelf: Boolean
    "Static payload merged into each run's template args."
    eventData: JSON
    "Trigger-layer allow-list { allow: [...] } — one link of the conjunctive chain (cor:acl:040)."
    policy: JSON
    "Named AI config for this trigger (spec-036 walk override)."
    aiConfigName: String
    enabled: Boolean
  }

  input UpdateAgentScheduleInput {
    name: String
    "Providing cron switches the schedule to recurring (clears runAt)."
    cron: String
    "Providing runAt switches the schedule to one-shot (clears cron). At most one of cron / runAt per call."
    runAt: String
    timezone: String
    entryNodeUrn: String
    "Agent — ref: PK or URN; must be installed in the App."
    agentRef: String
    runAsSelf: Boolean
    eventData: JSON
    policy: JSON
    aiConfigName: String
    enabled: Boolean
  }

  input TriggerAppRunInput {
    "App — ref: PK or fully-qualified URN."
    appRef: String!
    entryNodeUrn: String!
    eventData: JSON
    runAsSelf: Boolean
    aiConfigName: String
  }

  """
  A user-owned connection's scoped delegation to an App install (spec-042 Track
  B, #593). The connection OWNER grants a specific App scoped access to their
  mailbox/calendar; the enforcement gate is requireEmailConnection. The grantee
  App is exposed as SCALARS only (never a nested App object), so a cross-org
  grant can't reach the App keys/members. Token material is never exposed.
  """
  type ConnectionGrant {
    id: ID!
    connectionId: ID!
    "The App install this grant delegates to."
    granteeAppId: ID!
    "Canonical URN of the grantee App (hrn:app:<root>:<slug>), or null if unresolvable."
    granteeAppUrn: String
    granteeAppName: String
    "Covered scopes: mail.read, mail.send, calendar.freebusy, calendar.read."
    scopes: [String!]!
    "ISO-8601 expiry, or null for perpetual (until revoked)."
    expiresAt: DateTime
    createdAt: DateTime!
  }

  type ConnectionGrantsPage {
    items: [ConnectionGrant!]!
    total: Int!
  }

  "An individual action grant (design:grant-model): extra management actions for one member of one org, on top of their role bundle. Grantee and org are projected as scalars, never nested objects."
  type PrincipalGrant {
    id: ID!
    "Grantee kind - 'USER' in v1."
    principalType: String!
    principalId: ID!
    principalHandle: String
    organizationId: ID!
    organizationUrn: String
    "Allowed actions - exact ('memory.clone'), prefix ('memory.*'), or '*'."
    actions: [String!]!
    "ISO-8601 expiry, or null for perpetual (until revoked)."
    expiresAt: DateTime
    createdAt: DateTime!
  }

  type PrincipalGrantsPage {
    items: [PrincipalGrant!]!
    total: Int!
  }

  "Webhook trigger (D-2026-05-02). The secret is NEVER exposed here — the URL is returned once at create/rotate."
  type AgentWebhook {
    id: ID!
    organizationId: ID!
    appId: ID!
    agentId: ID
    userId: ID
    name: String!
    argsSchema: JSON
    entryNodeUrn: String!
    eventData: JSON
    policy: JSON
    aiConfigName: String
    enabled: Boolean!
    lastCalledAt: DateTime
    createdAt: DateTime!
    createdBy: String
  }

  type AgentWebhooksPage {
    items: [AgentWebhook!]!
    total: Int!
  }

  "Create/rotate result — path + platform token are shown ONCE."
  type AgentWebhookCredentials {
    webhook: AgentWebhook!
    "Server-relative URL path: /hooks/<secret>/<name>. Append ?hpt=<token>."
    path: String!
    "The time-limited platform JWT (hpt) — the second factor. Store it now."
    token: String!
  }

  input CreateAgentWebhookInput {
    "App — ref: PK or fully-qualified URN."
    appRef: String!
    "Lowercase alphanumeric/dash, 1-64 chars — part of the URL."
    name: String!
    entryNodeUrn: String!
    "Agent — ref: PK or URN; must be installed in the App."
    agentRef: String
    runAsSelf: Boolean
    "JSON Schema for POST args (stored in v1; enforcement is follow-on)."
    argsSchema: JSON
    eventData: JSON
    policy: JSON
    aiConfigName: String
    enabled: Boolean
  }

  "One consumable ticket in the org ledger (cor:acl:050:04 tier 2)."
  type ActionTicket {
    id: ID!
    organizationId: ID!
    appId: ID
    action: String!
    mintedBy: String!
    note: String
    consumedByRunId: ID
    consumedAt: DateTime
    expiresAt: DateTime
    createdAt: DateTime!
  }

  "Usage-vs-limit for one scope x action window (#510). The stored limit is the enforced value; env defaults only seed first touch."
  type QuotaCounter {
    id: ID!
    "app or org."
    scopeKind: String!
    scopeId: String!
    "run.execute, llm.tokens, sms.send, or email.send."
    action: String!
    "Window kind (day). The row rolls in place at UTC midnight - used resets, limit persists."
    window: String!
    used: Int!
    limit: Int!
    resetAt: DateTime!
  }

  input SetQuotaLimitInput {
    "Org - ref: PK or URN."
    orgRef: String!
    "Optional app scope - ref: PK or URN; must belong to the org. Omit to set the org-level limit."
    appRef: String
    "run.execute, llm.tokens, sms.send, or email.send."
    action: String!
    "Non-negative integer; 0 pauses the scope (every launch denies QUOTA_EXCEEDED)."
    limit: Int!
  }

  "One layer's verdict in an explained policy evaluation (#510)."
  type PolicyLayerVerdict {
    "org, user, or app."
    layer: String!
    "Whether this layer has a link at all (absent = no restriction)."
    present: Boolean!
    allowed: Boolean!
    "The layer's allow-list, for display; null when absent."
    allow: [String!]
  }

  "The standing-chain policy debug surface (#510): per-layer verdicts for one action (cor:acl:040:02). Trigger/run links are per-trigger and not part of the standing chain."
  type EffectiveActionPolicy {
    allowed: Boolean!
    layers: [PolicyLayerVerdict!]!
  }

  type ActionTicketsPage {
    items: [ActionTicket!]!
    total: Int!
  }

  input MintActionTicketsInput {
    "Organization — ref: PK or URN."
    orgRef: String!
    "Scope tickets to one App (ref: PK or URN); omit for org-wide."
    appRef: String
    "v1: comm.outbound only."
    action: String!
    count: Int!
    "Ledger legibility — why these tickets exist."
    note: String
    expiresAt: String
  }

  """
  Text-bearing Node fields that searchReplaceInNodes may rewrite. JSON fields
  (data, properties) and the structural 'loc' are intentionally excluded in v1.
  """
  enum NodeTextField {
    content
    name
    alias
    description
    abstract
    tags
  }

  """
  Bulk literal/regex search-and-replace across selected nodes.

  Selection is a union — at least one of 'nodeIds' or 'memoryIds' is required:
    - nodeIds:   explicit nodes (IDs or fully-qualified URNs).
    - memoryIds: every live node in those memories (IDs or URNs).
    - prefix:    further restrict the memoryIds set to the node at 'prefix'
                 plus its descendants, matched on colon loc-path boundaries
                 (so 'auth' matches 'auth' and 'auth:tokens' but not
                 'authoring'). Requires 'memoryIds' — loc is only unique
                 within a memory.

  Matching is literal substring by default; set 'regex: true' to treat
  'oldText' as a RegExp source (and 'newText' as a replacement pattern with
  dollar-sign backrefs). 'caseInsensitive' toggles case folding. Matching is
  always global.

  Set 'dryRun: true' to get per-node/per-field match counts WITHOUT writing.
  """
  input SearchReplaceInNodesInput {
    "Text (literal) or RegExp source (regex mode) to find. Must be non-empty."
    oldText: String!
    "Replacement. May be empty (deletes the matched text). Regex mode honors dollar-sign backrefs."
    newText: String!
    "Explicit node IDs or fully-qualified URNs."
    nodeIds: [ID!]
    "Memory IDs or URNs — selects every live node in each."
    memoryIds: [ID!]
    "Loc-prefix filter applied within 'memoryIds' (parent loc + descendants)."
    prefix: String
    "Which text fields to search. At least one required."
    fields: [NodeTextField!]!
    caseInsensitive: Boolean = false
    "Treat oldText as a RegExp source and newText as a replacement pattern."
    regex: Boolean = false
    "When true, report matches without writing anything."
    dryRun: Boolean = false
    """
    Why this change was made — recorded on each changed node's revision-history
    snapshot (NodeRevision.revLabel, #620; historically it squatted in
    editedBy), mirroring hadron_update_node's reason arg.
    """
    reason: String
  }

  type SearchReplaceFieldResult {
    field: NodeTextField!
    matches: Int!
  }

  type SearchReplaceNodeResult {
    nodeId: ID!
    loc: String!
    memoryId: ID!
    "Total replacements across all searched fields on this node."
    replacements: Int!
    fields: [SearchReplaceFieldResult!]!
  }

  type SearchReplaceResult {
    "Nodes the selection resolved to (after auth + prefix filtering)."
    nodesScanned: Int!
    "Nodes with at least one replacement."
    nodesChanged: Int!
    totalReplacements: Int!
    "Echoes the request — true means nothing was written."
    dryRun: Boolean!
    "Per-node breakdown; only nodes with at least one match are listed."
    results: [SearchReplaceNodeResult!]!
  }

  input EdgeInput {
    sourceLoc: String!
    targetLoc: String!
    "Relationship name (was 'label'). Optional — loc is the identity."
    name: String
    "Explicit edge loc. Omit to derive <sourceLoc>:<name>:<targetLoc>."
    loc: String
    description: String
    isRunnable: Boolean
  }

  "A node field that mergeNodes can fold from the source into the target."
  enum NodeMergeField {
    "Concatenate source content after target content (blank-line separated)."
    CONTENT
    "Concatenate source abstract after target abstract (2000-char cap enforced)."
    ABSTRACT
    "Concatenate source description after target description."
    DESCRIPTION
    "Union the tag sets (target order first, then new source tags)."
    TAGS
    "Shallow-merge the encrypted 'data' JSON; target wins on key collisions."
    DATA
    "Shallow-merge the 'properties' JSON; target wins on key collisions."
    PROPERTIES
    "Re-point the source's incoming and outgoing edges onto the target. Each re-homed edge's loc is recomputed from its new endpoints (deriveEdgeLoc); a re-homed edge whose recomputed (loc, memoryId) collides with one the target already holds is dropped rather than duplicated — so an equivalent edge with an endpoint-derived loc is de-duplicated — as are self-loops."
    EDGES
  }

  input MergeNodesInput {
    "Source node — ID or fully-qualified URN. Folded into 'target'."
    source: String!
    "Target node — ID or fully-qualified URN. The surviving node."
    target: String!
    "Fields to merge. Omit (or null) to merge every mergeable field."
    include: [NodeMergeField!]
    "Hard-delete the source node after a successful merge."
    deleteSource: Boolean = false
  }

  input MergeMemoriesInput {
    "Source memory — ID or fully-qualified URN. Emptied into 'target'."
    source: String!
    "Target memory — ID or fully-qualified URN. The surviving memory."
    target: String!
    "Field strategy for source nodes whose loc collides with an existing target node (folded via the mergeNodes rules). Omit (or null) = every mergeable field. Nodes with no target counterpart move over unchanged (loc preserved)."
    include: [NodeMergeField!]
    "Delete the (now-empty) source memory after a successful merge."
    deleteSourceMem: Boolean = false
  }

  input MergeUsersInput {
    "Source user — ID, bare handle, or fully-qualified user URN. Folded into 'target' and soft-deleted."
    source: String!
    "Target user — ID, bare handle, or fully-qualified user URN. The surviving user; target wins non-combinable conflicts while roles preserve the strongest live entitlement."
    target: String!
  }

  input SessionInput {
    id: String!
    type: String
    repo: String
    branch: String
    prNumber: Int
    customerId: String
    language: String
    llmModel: String
    parentSessionId: String
    prevSessionId: String
    # #928 coding-session provenance.
    transcriptPath: String
    host: String
    tool: String
    """
    #928 / cor:api:140: the role-Agent driving this session, as a PK or URN.
    Resolves to Session.agentId. The caller must be able to READ the agent
    (PUBLIC, or owner / org member) - a session is never attributed to an
    agent the caller cannot see. Usually omitted with workerRef, which derives
    it from the casting.
    """
    agentRef: String
    """
    #974 / cor:agt:020:03: the Worker (named casting) this session works as.
    Three forms resolve, told apart by SHAPE (never by trying each in turn, so
    a typo'd URN can't silently fall through to a roster search):

    - the worker's NAME ("Iris") — #990. Unique per App, case-insensitively,
      matched with the DATABASE's lower(), the expression
      workers_app_name_uniq indexes. Requires App context (appRef, an App-key
      credential, or an MCP active-App selection): a name means nothing without
      one, so a nameless-App call refuses SESSION_WORKER_NAME_NEEDS_APP rather
      than guessing across the caller's Apps. Gated on the STAFF READ GATE
      before the lookup runs — resolving a name discloses roster membership,
      which the id/URN forms never do.

      Which refusal you get depends on WHERE the denial happens, and clients
      should not assume one code covers both: a caller who supplied appRef has
      already been checked against the same participant predicate, so an
      outsider is refused FORBIDDEN there, before any name is read. Only a
      denial at the in-branch staff gate — reachable when the App came from an
      App-key credential rather than appRef — is masked as WORKER_NOT_FOUND,
      indistinguishable from an App with no such worker.
    - the worker's URN (hrn:worker:<root>:<app-slug>:<slug>, #991); the URN's
      leaf is the derived slug, never the display name (cor:agt:020:02).
    - the worker's id.

    Resolves to Session.workerId, and stamps Session.agentId with the worker's
    role-agent. The worker must belong to the session's App: with appRef (or an
    App-key credential) it must match the worker's App; without one, the
    worker's App becomes the session's, behind the same membership gate as
    appRef. A retired worker refuses (WORKER_RETIRED). #940: a worker with an
    ACTIVE session refuses WORKER_TAKEN — extensions carry workerId, sessionId,
    lastDriver, lastSeenAt, everything the takeover prompt needs — unless
    force is true (informed takeover, cor:agt:020:03: show who last drove it,
    proceed only on explicit override, never silently).
    """
    workerRef: String
    """
    #940: take over a worker whose binding would otherwise refuse WORKER_TAKEN.
    Only meaningful with workerRef. Clients must surface the WORKER_TAKEN
    payload (who last drove it, when) before retrying with force - that IS the
    informed-takeover contract; force exists so the override is explicit,
    never the default.
    """
    force: Boolean
    "The session's stated intent (Session.plan) - what this session is about. MCP's hadron_start_session description lands here."
    plan: String
    """
    #943 / cor:api:140: the App this session is a unit of work for, as a PK or
    URN. Resolves to Session.appId - the pivot that was previously stamped ONLY
    from an App-key credential, which made a user-started session structurally
    unable to satisfy the team-chat authorship gate (cor:agt:020:04 condition b,
    SESSION_NOT_IN_APP). The caller must be a member of that App: an AppMember
    at any role, an org member with CONTRIBUTOR+ on its owning org, or the
    owner of a user-owned App. Unknown or deleted App: BAD_USER_INPUT;
    non-member: FORBIDDEN. An App-key credential wins - if the caller
    authenticated as an App and appRef names a DIFFERENT App, the call is
    refused (SESSION_APP_MISMATCH).

    Uninstalled Apps differ by ref form, because App URNs are only unique
    among ACTIVE rows (spec 021 FR-027: one live App plus N uninstalled
    history rows may share a URN). By URN an uninstalled App is simply not
    found - BAD_USER_INPUT - since there is no single row the URN names; by
    PK it is found and refused APP_UNINSTALLED.
    """
    appRef: String
  }

  input UsageEventInput {
    type: String!
    nodeLoc: String
    actionArgs: JSON
    sessionId: String
    model: String
    tokensIn: Int
    tokensOut: Int
  }

  type UsageSummaryEntry {
    nodeLoc: String!
    type: String!
    count: Int!
  }

  "One time bucket of read+write activity (#796)."
  type UsageActivityBucket {
    """
    Bucket start as YYYY-MM-DD, in the requested timeZone. Deliberately
    String and NOT DateTime (#205): it is a calendar-day label in the
    caller's zone, not an instant — rendering it as a UTC timestamp would
    shift buckets across the date line.
    """
    date: String!
    reads: Int!
    writes: Int!
  }

  "Bucket width for usageActivity (#796)."
  enum UsageActivityBucketSize {
    DAY
    WEEK
    MONTH
  }

  scalar JSON

  """
  A timestamp string, e.g. '2026-07-30T12:34:56.789Z'.

  Guaranteed parseable by Date.parse / new Date(). Values Hadron mints are
  ISO 8601 UTC; a value passed through from an external provider (calendar,
  mail, drive) keeps that provider's representation, which may carry a
  non-UTC offset — so compare instants, don't compare these as strings.

  Issue #205: date fields used to be declared String and fed a Prisma Date,
  which graphql-js coerced through Date.valueOf() into epoch milliseconds
  ('1716943200000') — a value new Date() parses as Invalid Date. This scalar
  makes that shape unrepresentable, so no client needs to sniff the format.

  Output-only today: date-valued arguments remain String.
  """
  scalar DateTime

  # ─── Assets ──────────────────────────────────────────────────────
  # Per spec 004-asset-upload. Assets live in a dedicated Asset
  # entity (NOT a nodeType) FK-related to Memory. URN form (grammar
  # v2, #697 Stage 2):
  #   hrn:asset:<root>:<mem...>:assets:<asset.id>
  # See Asset.urn below for the two degraded shapes a parser must
  # tolerate, and for why <mem...> is not always a single atom.

  enum AssetScanStatus {
    PENDING
    CLEAN
    BLOCKED
  }

  type Asset {
    id:          ID!
    memoryId:    ID!
    filename:    String!
    mimeType:    String!
    sizeBytes:   Int!
    scanStatus:  AssetScanStatus!
    """Engine signature name recorded when the scan verdict was BLOCKED (the row is kept as an audit tombstone; its bytes are deleted). Null otherwise."""
    scanSignature: String
    description: String
    uploadedAt:  DateTime!
    """Uploader (User id). Null when the asset was created server-side by an app run (hadron_store_file)."""
    uploadedBy:  ID
    deletedAt:   DateTime
    """
    The asset's URN, grammar v2 (cor:urn:010:01): hrn:asset:<root>:<mem...>:assets:<asset.id>,
    emitted by emitAssetUrnV2 from the holding memory's STORED urn.

    <mem...> is one or more atoms, not always one. A per-user memory urn minted
    before the #697 Stage-3 flip is still compound (<root>:<agent>:app-user:<id>
    and friends), and each extra memory atom lengthens the asset URN with it —
    so the 'assets' marker is not at a fixed offset. A parser recovering the
    holding memory must take everything between the type word and that marker,
    never a fixed two-atom prefix. Prefer locating the LAST 'assets' atom and
    reading the id after it (assetIdFromRef does exactly this).

    Two degraded shapes a parser must tolerate, both of which really occur:
      * hrn:asset:unknown:assets:<asset.id> — the holding memory row could not
        be loaded. Carries no memory identity at all.
      * <memory.urn>:assets:<asset.id> — the pre-#697 shape, with NO hrn:asset:
        prefix, served when v2 emission throws (empty, over-length or
        charset-invalid atom in the stored memory urn). It interpolates the
        stored memory urn verbatim, which is normally bare (<root>:<slug>), so
        this shape usually looks like acme.com:docs:assets:<id>.

    A third oddity is reachable through the NORMAL branch, not a fallback: a
    legacy memories.urn row that predates the chk_memory_urn_not_prefixed
    guardrail can still hold a rendered hrn:mem:-prefixed value, and that
    composes into hrn:asset:hrn:mem:<root>:<slug>:assets:<id>. A prefix strip
    that assumes one leading type word will mis-read it.
    """
    urn:         String!
    """
    Stable, UNAUTHENTICATED hotlink to the bytes (GET /assets/<id>).

    Anyone with this URL can fetch the file — there is no read gate on
    it. A deliberate, temporary posture; see src/api/assetPublic.ts. Do
    not present it in a UI as though it were access-controlled.

    Null when the server has no BASE_URL configured (no canonical
    origin to build an absolute URL from), when the asset is not
    CLEAN, or when its memory is encrypted — encrypted memories are
    never hotlinkable, since an anonymous request holds no session key.
    """
    publicUrl:   String
  }

  enum UploadIntent {
    USER
    AGENT_REQUEST
  }

  input BeginAssetUploadInput {
    """Accepts the entity's ID or URN."""
    agentUrn:        String!
    filename:        String!
    mimeType:        String!
    sizeBytes:       Int!
    description:     String
    uploadIntent:    UploadIntent!
    uploadRequestId: String
  }

  # v2 (spec 006-asset-upload-redesign): memory-addressed input.
  # memoryId is required for the attached upload path. The staging
  # path (memoryId omitted) is added in US4.
  input BeginAssetUploadV2Input {
    """
    Memory reference. Accepts the entity's ID (CUID / 32-char hex) or its
    URN (per spec 007 ID-or-URN dispatch). URN inputs MUST be fully
    qualified (org:memory) per spec 022 — relative-form URNs are
    rejected as GraphQL errors with extensions.code "URN_NOT_QUALIFIED".
    """
    memoryId:        ID!
    filename:        String!
    mimeType:        String!
    sizeBytes:       Int!
    description:     String
    uploadIntent:    UploadIntent!
    uploadRequestId: String
  }

  type AssetPutHeader {
    name:  String!
    value: String!
  }

  type BeginAssetUploadResult {
    uploadId:        ID!
    putUrl:          String!
    putHeaders:      [AssetPutHeader!]!
    expiresAt:       DateTime!
    storageKey:      String!
    maxSizeBytes:    Int!
    allowedMimeType: String!
  }

  input CompleteAssetUploadInput {
    uploadId: ID!
  }

  """
  Attach an existing asset to the graph by creating a reference node
  that points at it.

  The node is a nodeType: reference node whose data.asset carries the
  asset's id, urn, filename, mimeType and sizeBytes — the same shape
  hadron_store_file writes for run-created files, so a reader handles
  both origins identically. There is no schema-level Asset-to-Node
  link (cor:dmo:060:10 reserves it); the pointer is a soft reference,
  and Node.asset resolves to null once the asset is gone.

  Requires READ access to the asset's holding memory and WRITE access
  to the memory the reference node lands in — which need not be the
  same memory.
  """
  input CreateAssetReferenceNodeInput {
    """
    Asset id, or its URN — canonically hrn:asset:<root>:<mem...>:assets:<asset.id>.
    Parsing is Postel-liberal (assetIdFromRef): the id is whatever follows the
    LAST 'assets' atom, so every shape Asset.urn can emit is accepted, including
    the pre-#697 memory-prefixed <memory.urn>:assets:<asset.id> spelling and the
    other degraded fallback. A ref with no 'assets' atom is taken as a bare id.
    """
    assetRef:    String!
    """Fully-qualified node URN for the reference node."""
    nodeUrn:     String!
    """Node name. Defaults to the asset's filename."""
    name:        String
    """Node description. Defaults to the asset's own description."""
    description: String
  }

  input SetAgentAssetUploadEnabledInput {
    """
    Agent reference. Accepts the entity's ID (CUID / 32-char hex) or its
    URN (per spec 007 ID-or-URN dispatch). URN inputs MUST be fully
    qualified (org:agent) per spec 022 — relative-form URNs are rejected
    as GraphQL errors with extensions.code "URN_NOT_QUALIFIED".
    """
    agentUrn: String!
    enabled:  Boolean!
  }

  type AssetListResult {
    assets:  [Asset!]!
    total:   Int!
    hasMore: Boolean!
  }

  """
  Filter for the cross-memory assets() list. Every field narrows the
  caller's accessible set; none of them widens it.
  """
  input AssetFilter {
    """
    Narrow to these memories (id or fully-qualified URN). Unreadable and
    unknown refs are silently dropped; a malformed URN is an error. An
    explicitly EMPTY list is the empty scope, never a fallback to the
    default scope.
    """
    memoryRefs:     [ID!]
    """Only the caller's own uploads. Never widens the gate."""
    mine:           Boolean
    mimeType:       String
    scanStatus:     AssetScanStatus
    includeDeleted: Boolean
  }

  """Uniform find-many envelope for assets (spec cor:api:120)."""
  type AssetsPage {
    items: [Asset!]!
    total: Int!
  }

  type AssetDownloadUrl {
    url:       String!
    expiresAt: DateTime!
    filename:  String!
    mimeType:  String!
    sizeBytes: Int!
  }

  """
  Result of resolving a Hadron URN to the ids a client needs to navigate to
  the resource's canonical page. Powers the portal's /app/u/<urn> redirect
  route (hadron-portal#262).

  \`kind\` is the URN's type segment: memory | node | agent | org | app | user |
  apprun | worker | noderev.
  \`id\` is the resolved entity's primary id. \`memoryId\` is set only for
  nodes (their owning memory), \`organizationId\` for apps, app runs, and
  workers (their owning org) — both are the extra ids those resources'
  canonical routes require.
  """
  type UrnResolution {
    kind:           String!
    id:             ID!
    memoryId:       ID
    organizationId: ID
    "Set to 'data' when the resolved URN named a #data fragment of its parent node/apprun (#696); null otherwise."
    fragment:       String
  }

  """
  issue #323: where a single grant in an EffectiveAccess result comes from.
  """
  enum AccessSource {
    "Platform ADMIN/OWNER."
    PLATFORM_ROLE
    "ADMIN/OWNER (or, for org-readable knowledge, any Role) of the owning org."
    ORG_ROLE
    "personal/private memory owner (Memory.userId)."
    MEMORY_PRINCIPAL
    "group-class team membership row (MemoryMember)."
    MEMORY_MEMBER
    "personal-class cross-user grant (MemoryShare)."
    MEMORY_SHARE
    "individual action grant (PrincipalGrant, cor:acl:040:06) - clone/delete capabilities on top of the role bundle."
    PRINCIPAL_GRANT
    "node inherits its memory's access."
    NODE_INHERITED
    "AppMember row."
    APP_MEMBER
    "active AgentSubscription, or an org-level AgentOrgGrant the user inherits."
    AGENT_SUBSCRIPTION
    "admin of the AI config's owning entity."
    AICONFIG_OWNER
    "resource is publicly / universally visible."
    PUBLIC_VISIBILITY
  }

  """
  issue #323: one reason a subject has (or would have) access to a resource.
  """
  type AccessGrant {
    source: AccessSource!
    "The role/level this particular grant confers."
    role: String!
    "Human label for the grant's origin (owning org URN, the inherited memory URN, the app URN, etc.); null when the grant has no distinct origin."
    via: String
  }

  """
  issue #323: the effective access a single user has to a single resource,
  with the grants that confer it. An empty grants list (with all capabilities
  false and role null) is a first-class 'no access' answer, NOT an error.
  """
  type EffectiveAccess {
    user: User!
    "Canonical (grammar-v2, hrn:-prefixed) URN of the resolved resource, emitted the same way the entity's own urn field emits it — so it can be fed straight back into another query or command. Two exceptions have no URN by nature: an AiServiceConfig yields its id, and a user yields hrn:user:<handle>."
    resourceUrn: String!
    "memory | node | app | agent | aiServiceConfig | organization | user."
    resourceKind: String!

    canRead: Boolean!
    canWrite: Boolean!
    "Manage grants / settings (admin/owner-equivalent)."
    canManage: Boolean!
    canDelete: Boolean!

    "Highest single clean role label (e.g. owner, writer, ADMIN); null when access is purely capability-based or absent."
    role: String

    "The reasons access is granted. Empty means no access. Ordered strongest-first."
    grants: [AccessGrant!]!
  }

  # Single-node export (#386). MD/JSON are the canonical, round-trippable files;
  # PDF is a presentation render (content only) produced by the internal
  # hadrontool-pdf service and delivered BASE64. HTML remains reserved.
  enum NodeExportFormat {
    MD
    JSON
    PDF
  }

  "Selectable sections for a presentation (full: false) export."
  enum NodeExportSection {
    METADATA
    CONTENT
    ABSTRACT
    DATA
    PROPERTIES
    EDGES
  }

  "How the rendered payload is encoded. TEXT for MD/JSON; BASE64 for PDF."
  enum NodeExportEncoding {
    TEXT
    BASE64
  }

  type NodeExportResult {
    format: NodeExportFormat!
    "MIME type, e.g. text/markdown or application/json."
    mimeType: String!
    "Suggested download filename, e.g. <loc-leaf>.md."
    filename: String!
    encoding: NodeExportEncoding!
    "The rendered file contents (TEXT)."
    data: String!
    "Byte length of the rendered payload (UTF-8)."
    bytes: Int!
  }

  """
  #745 — a page of objects from the object store. Each object is a flat JSON
  record { id, type, ...fields } (the projection of a node). 'total' is the full
  match count (null when unbounded).
  """
  type ObjectList {
    objects: [JSON!]!
    total: Int
  }

  "#772 — the kinds of widget placeable on a user's /app/dashboard grid."
  enum DashboardWidgetType {
    MEMORY_STATS
    AGENT_STATS
    USAGE_ACTIVITY
  }

  "One widget the caller has placed on their /app/dashboard grid (#772)."
  type DashboardWidget {
    id: ID!
    type: DashboardWidgetType!
    "Columns spanned on the 12-col desktop grid."
    span: Int!
    "Rows spanned on the fixed-height row grid (#788)."
    rowSpan: Int!
    "0-based sort order among the caller's widgets."
    position: Int!
    "Widget-instance settings; shape is widget-defined (#788)."
    config: JSON
  }

  "Data for ONE placed widget — the portal fans this out by widgetId (#797)."
  type DashboardWidgetData {
    "The placement this payload belongs to — fan out by this, not by type (#797)."
    widgetId: ID!
    type: DashboardWidgetType!
    "The widget-specific payload (e.g. memory-stats => { memoryCount })."
    data: JSON!
  }

  """
  #806 — a named, saved widget configuration. A palette entry: applying one
  COPIES its config into a placement, so later edits to the preset do not reach
  placements already seeded from it, and deleting it never orphans a placement.
  Owner-only — no org, no sharing.
  """
  type DashboardWidgetPreset {
    id: ID!
    "The widget type this configuration belongs to. Immutable after creation."
    type: DashboardWidgetType!
    "Display name, unique among the caller's presets for this type."
    name: String!
    "The saved settings, shape widget-defined — becomes a placement's config verbatim."
    config: JSON!
  }

  "One widget in a setDashboardWidgets selection; grid position is the array order."
  input DashboardWidgetInput {
    "When set and owned by the caller, update that placement in place (id survives the save); otherwise create a new one (#788)."
    id: ID
    type: DashboardWidgetType!
    "Columns to span (1-12) on the 12-col grid; clamped server-side."
    span: Int!
    "Rows to span (1-4); clamped server-side (#788)."
    rowSpan: Int!
    "Widget-instance settings; shape is widget-defined (#788)."
    config: JSON
  }

  type Query {
    """
    Resolve a fully-qualified, \`hrn:<type>:\`-prefixed Hadron URN (legacy \`urn:\` scheme also accepted) to the ids
    needed to reach its canonical page. Returns null when the URN is
    unresolvable (not found) OR the caller lacks access. Unlike the dedicated
    per-kind queries — which throw \`Forbidden\` on no-access — this query
    deliberately collapses both not-found and no-access to null, so a
    redirect resolver can 404 uniformly without disclosing which case it was.

    Per-kind access uses the SAME authorization rules as the dedicated
    queries (memory/org/agent: org membership; app: org ADMIN; node:
    memoryAccessFilter), only with the throw replaced by a null return.

    The \`hrn:<type>:\` prefix (legacy \`urn:<type>:\` also accepted) is the
    dispatch key — bare URNs without a type prefix are ambiguous across kinds
    (\`root:slug\` could be a memory or an agent) and resolve to null.
    """
    resolveUrn(urn: String!): UrnResolution

    """
    issue #323: resolve the effective access a single user has to a single
    resource, with the grants that confer it. The authoritative backing for
    the 'hadron access check <user> <resource>' audit command — one resolver
    that reuses the server's authorization rules instead of re-deriving them
    client-side.

    'user' (the subject) accepts a User ID or a hrn:user:<handle> URN (spec
    cor:urn:010:01). 'resource' is dispatched on URN type the same way
    resolveUrn dispatches: a memory, node, app, agent, org, or user MUST be a
    fully-qualified hrn:<type>: URN (a bare id is ambiguous across those kinds).
    A bare id with no scheme prefix is treated as an AiServiceConfig id — the
    only URN-less resource kind.

    Authorization (who may CALL this): the same visibility bar already
    enforced on the underlying grant tables — a platform ADMIN/OWNER, an
    ADMIN/OWNER of the resource's owning org, or (for a strict-owner memory)
    the memory's principal. Everyone else gets FORBIDDEN, NOT a silent empty
    result, so the command can't probe access it isn't allowed to audit.

    A subject with no access is a SUCCESS with an empty grants list (all
    capabilities false, role null) — not NOT_FOUND. An unresolvable or
    unknown resource ref is NOT_FOUND.
    """
    effectiveAccess(user: ID!, resource: ID!): EffectiveAccess!

    """
    The uniform single-node read (#473) — subsumes the former nodeById(id:)
    and node(loc:, memory:) split. 'ref' accepts, in dispatch order:

      1. a primary key (the unambiguous read — the old nodeById),
      2. a fully-qualified node URN (\`hrn:node:<root>:<memory>:<loc>\`,
         legacy \`urn:\` scheme accepted),
      3. a bare loc — scoped by 'memoryRef' (an ID or URN) when given; unscoped,
         it resolves across every readable memory and a cross-memory loc
         collision is REJECTED with extensions.code AMBIGUOUS_NODE_LOC
         (listing the candidate memoryIds) rather than silently returning
         one (#335). An unprefixed 3+-segment ref whose first two segments
         name a readable memory is treated as form 2 (a full URN); pass
         'memoryRef' to force loc interpretation.

    raw: true skips Mustache template compilation. Soft-deleted nodes do not
    resolve. Access: the caller's readable-memory set (same gate the old
    queries used); denied and missing are both null.
    """
    node(ref: ID!, memoryRef: ID, raw: Boolean): Node

    # Render one node to a portable, self-contained file (spec cor:api).
    # full: true (default) returns the CANONICAL form — byte-identical to
    #   "hadron node export <urn>", all sections, round-trippable via
    #   "hadron node import". Requires MD or JSON; sections is ignored.
    # full: false returns a PRESENTATION render of the selected sections
    #   (default: all); not guaranteed round-trippable.
    # Auth: same node-read gate as node(ref:). (HTML/PDF + asUrl delivery land
    # later; the result shape is forward-compatible.)
    nodeExport(
      id: ID!
      format: NodeExportFormat = MD
      full: Boolean = true
      sections: [NodeExportSection!]
    ): NodeExportResult!

    """
    Unified node search (cor:api:090) — the single node list + retrieval
    surface (it replaced the removed \`nodes\` filter/list and \`nodeSearch\`
    rank queries in PR3). Omit \`query\` for a filtered list in deterministic
    order (subsumes \`nodes\`); pass \`query\` to rank by \`mode\`
    (keyword | vector | hybrid | regex). Lexical modes honor boolean operators
    (\`(a OR b) AND c\`, quoted phrases, NOT/-) — operator words are
    UPPERCASE-ONLY, so natural phrases like 'not sure' search literally —
    and \`fields\` as a ranking weight-mask. Malformed boolean syntax
    (unmatched parenthesis, unterminated quote) DEGRADES to a literal phrase
    search flagged \`degraded: 'literal_fallback'\` instead of erroring; only
    mode: regex fails loudly on bad syntax. \`filter\` is the structured, AND-combined filter context
    (SYSTEM memory class excluded by default; explicit wins). Returns a
    scored-hit envelope. Access-scoped identically to the per-kind node queries.

    orgId (optional) narrows the accessible scope to a single organization the
    caller is a member of; a non-member orgId returns an empty envelope
    (total 0, no existence disclosure). Combined with filter.isRunnable: true
    this is the canonical "the caller's runnable task nodes in one org" query
    (there is no separate myTasks surface — a task is simply an isRunnable node).
    """
    findNodes(
      query: String
      mode: FindNodesMode
      filter: NodeFilter
      fields: [NodeField!]
      sort: NodeSort
      "#719 — order by a properties/data JSON path; overrides sort when present."
      sortProperty: NodePropertySort
      expand: Int
      granularity: SearchGranularity
      orgId: ID
      limit: Int
      offset: Int
      "Optional absolute relevance floor (cor:api:090 / #497): drop ranked hits whose score is below this value. Scores are NOT comparable across modes, so the meaningful scale differs per mode (keyword ts_rank is roughly 0..a-few; vector cosine similarity is 0..1; hybrid is a small RRF fraction) — pick a floor for the mode in use. Ignored on the no-query browse list (unscored) and never trims expand-neighbours. A floor returns fewer hits, never weaker ones."
      minScore: Float
    ): FindNodesResult!

    """
    #745 — read one object by its id (the object store's flat projection of a
    node). Returns a JSON object { id, type, ...fields } or null if not
    found/inaccessible. The object store is the legible sugar surface over
    structured storage (an object IS a node); see createObject / findObjects.
    """
    object(ref: ID!): JSON

    """
    #745 — query a collection. Returns objects of the given type (the collection
    / node objectType) in the memory, projected flat. 'match' is an equality
    shorthand ({ field: value }) desugared to a where predicate with each field's
    cast inferred from the memory schema; 'where' is the full #719 predicate
    (ANDed with match); 'sort' is a single-field shorthand desugared to a
    property-path sort.
    """
    findObjects(
      "Memory ID or fully-qualified URN (hrn:memory:...) — relative refs are rejected (spec 022)."
      memoryRef: String!
      type: String!
      "Equality shorthand: { field: value, ... } becomes an AND of eq predicates (cast inferred from the schema)."
      match: JSON
      "Full #719 structured predicate over the object's fields (ANDed with match)."
      where: JSON
      "Single-field sort: a map of one field to the direction string 'asc' or 'desc', e.g. { fundingUsd: 'desc' }."
      sort: JSON
      limit: Int
      offset: Int
    ): ObjectList!

    """
    Cross-entity global search across organizations, memories, nodes, agents,
    apps, AiServiceConfigs, and users — one ranked, flat list of hits.

    By default the query shape is smart-sniffed: a PK-shaped input does an exact
    id lookup, a URN-shaped input matches URNs, anything else matches name + URN.
    Pass \`fields\` to force specific fields (overrides the sniff) and
    \`entityTypes\` to restrict the kinds searched. Every hit is access-scoped to
    the caller exactly as the per-kind queries are. Distinct from \`findNodes\`,
    which is the node-only, vector-aware retrieval surface.

    orgId (optional) narrows the org-anchored slices to a single organization:
    node/memory hits are confined to that org's memories and organization /
    agent / app / aiServiceConfig hits to that org. (The user slice is NOT
    org-scoped — users aren't org-owned; they stay gated by the caller's
    user-visibility as usual.) Omit for the cross-org union (default). A caller
    who is not a member of orgId gets an empty page (total: 0) — no
    org-existence disclosure; membership-gated for everyone, no admin bypass.

    Paged in the repo standard idiom: limit (default 50, capped 200) + offset
    (default 0), with total in the envelope. NOTE: total is the ranked-match
    count WITHIN the per-entity candidate bound (a fixed cap per entity type),
    not an unbounded COUNT — deep paging past that bound is not surfaced. See
    GlobalSearchResult.total.
    """
    globalSearch(
      query: String!
      entityTypes: [SearchEntityType!]
      fields: [SearchField!]
      orgId: ID
      limit: Int
      offset: Int
    ): GlobalSearchResult!

    """
    The uniform single-edge read (#473) — edges are first-class, loc-addressed
    peers of nodes (spec 037). 'ref' accepts a primary key or a
    fully-qualified edge URN (\`hrn:edge:<root>:<memory>:<loc>\`; the edge's
    memory is its SOURCE node's memory). Access: the edge's memory must be in
    the caller's readable set; denied and missing are both null.
    """
    edge(ref: ID!): Edge

    """
    Uniform paginated edge list (#473). Scope: edges whose (denormalized,
    source-side) memory the caller can read, AND-narrowed by the filter.
    orgId follows cor:api:100:01 (member -> scope, non-member -> empty page,
    no disclosure, no admin bypass). Deterministic loc-ascending order
    (id tiebreak); limit default 50 / cap 200; limit: 0 -> count only.
    """
    edges(filter: EdgeFilter, orgId: ID, limit: Int, offset: Int): EdgesPage!

    """
    Batch read (spec cor:api:040) — the full node projection (select any Node
    fields, including content + edges) for MANY nodes in one call, eliminating
    the N+1 of one node(ref:) per node (e.g. 'spec lint --all'). Provide EITHER
    'refs' (explicit set, returned in input order) OR 'memory' + 'locPrefix'
    (subtree, loc order) — not both. Each entry of 'refs' is a primary key OR a
    fully-qualified node URN (cor:api:140), so a URN-holding caller batches in
    ONE call instead of resolving each ref first. The split on a bad ref is by
    KIND, not by luck: a ref whose SHAPE is wrong errors the call — unqualified
    / relative (UrnNotQualifiedError) or a URN of the wrong entity type, e.g.
    'hrn:mem:...' (BAD_USER_INPUT) — while a well-formed ref that names nothing
    the caller may read comes back in 'unavailable'. A caller mistake stays
    loud instead of hiding among denials. Per-node access is applied
    independently AFTER resolution: denied or missing refs come back in
    'unavailable' and never fail the call. Bounded by hard caps — over the
    node-count cap throws BAD_USER_INPUT; over the response-size cap returns a
    partial result with 'truncated: true' and the dropped refs in 'omitted'
    (never a silent short read). Node content is returned raw — Mustache
    templates are NOT compiled (unlike the single-node 'node' read), since this
    is a bulk source read for lint / audit / migration and compiling per node
    would re-introduce the N+1 it eliminates.
    """
    nodeBatch(refs: [ID!], memory: ID, locPrefix: String): NodeBatchResult!

    """
    DEPRECATED: use usageEvents(loc: <loc>). Carried for source-compat;
    there are no known callers (checked across portal / CLI / docs at #802).

    Usage events for a node loc, most recent first.

    The migration is a rename, not a rewrite — usageEvents' loc argument is
    the SAME verbatim exact nodeLoc match under the same gate, so
    nodeUsage(loc: "x", limit: n) becomes usageEvents(loc: "x", limit: n)
    with identical results and identical access scoping:

      nodeUsage(loc: 'cor:acl:010:01', limit: 20)
      usageEvents(loc: 'cor:acl:010:01', limit: 20)

    Do NOT migrate to usageEvents(nodeId: <loc>): nodeId is shape-classified,
    and a hierarchical loc with 3+ colon-separated segments (like the spec
    citation above) qualifies as node-URN shape and routes to ref resolution
    instead — NODE_NOT_FOUND, or another node's events (PR-986 review). The
    loc argument exists precisely so the migration needs no shape caveats.

    usageEvents is a strict superset: nodeId accepts a PK or a fully-qualified
    node URN (memory-precise — a bare loc cannot disambiguate the same loc in
    two memories), plus type filtering, memoryId scoping and offset paging. It
    is also the surface that gets extended; nodeUsage will not grow arguments.

    Access control is identical and unchanged (#802) — see usageEvents below.
    Deprecated for redundancy, NOT because this field is unsafe.
    """
    nodeUsage(loc: String!, limit: Int): [UsageEvent!]!
      @deprecated(reason: "Use usageEvents(loc: <loc>) — identical exact-match loc semantics and access scoping, plus PK/URN refs via nodeId, type filtering, memoryId scoping and paging (#802).")

    # Usage events (most recent first), optionally filtered by type, memoryId,
    # or nodeId.
    #
    # Access control (#250): results are always scoped to memories the caller
    # may read (org membership / subscriptions / public / owned personal+private
    # per spec 034; ADMIN/OWNER see all EXCEPT another user's personal/private
    # memories and, per spec 047, another user's user-owned memories). A
    # memoryId the caller can't read returns [] (no existence leak); the global
    # form (no memoryId) is bounded to the readable set, never cross-tenant.
    #
    # memoryId is a memory identifier — accepts the memory's ID or URN. Results
    # are scoped on the denormalized UsageEvent.memoryId column (#796), so an
    # event stays attributed to its memory after its node is deleted.
    #
    # nodeId is a node token accepting a PK, a fully-qualified URN, or a bare
    # loc (no memoryId needed):
    #   - PK / URN  → resolved to a single node; scoped via its exact nodeId FK
    #                 (memory-precise).
    #   - bare loc  → exact nodeLoc match, bounded to readable memories; not
    #                 existence-checked. Shape-classified: a loc with 3+
    #                 colon-separated segments qualifies as node-URN shape and
    #                 takes the PK/URN branch instead — use loc for those.
    #                 (This used to read "like nodeUsage but access-scoped" —
    #                 a comment that named an ungated sibling without anyone
    #                 following the pointer back. nodeUsage was gated in #802
    #                 and deprecated as redundant in the same issue.)
    #
    # loc — the VERBATIM exact nodeLoc filter (never shape-sniffed, so every
    # loc works, hierarchical spec citations included), bounded to readable
    # memories; not existence-checked. The migration target for the deprecated
    # nodeUsage(loc:) above — same match, same gate (PR-986 review, Codex P2).
    # Mutually exclusive with nodeId (BAD_USER_INPUT when both are passed).
    usageEvents(type: String, memoryId: ID, nodeId: ID, loc: String, limit: Int, offset: Int): [UsageEvent!]!

    """
    Revision history for a node, most recent first.

    Accepts the node's ID or URN. Access-gated on the node's memory: a node
    whose memory the caller can't read returns an empty list (no existence
    disclosure).
    """
    nodeRevisions(nodeRef: ID!, limit: Int): [NodeRevision!]!

    """
    A single node-revision snapshot by its id (#617 Display).

    Access-gated on the snapshot's node memory (read): null when the revision
    does not exist OR the caller cannot read the node's current memory OR the
    memory the snapshot was captured in (per-snapshot gating mirrors
    nodeRevisions — a moved node keeps its id, so a snapshot may belong to a
    memory the caller cannot read). A soft-deleted node is also null (its
    history drops out of every read surface). Null, never an error, so there
    is no existence disclosure.
    """
    nodeRevision(revisionId: ID!): NodeRevision

    """
    Aggregated usage counts per node and type for a memory.

    Accepts the entity's ID or URN.
    """
    memoryUsageSummary(memoryRef: ID!): [UsageSummaryEntry!]!

    """
    #796 — read/write activity counts, bucketed by time.

    Default scope is the caller's OWN events across everything they touched;
    pass memoryRefs to switch to all users' events attributed to ANY of those
    memories (#805), each of which requires read access. The result is the
    UNION as a single read/write series, not a per-memory breakdown; since every
    event carries exactly one memory, the union equals the sum of the separate
    scopes with no double-counting.

    A ref the caller cannot read — or that does not exist — is silently dropped
    from the union rather than failing the query, so the result never reveals
    which of the named memories exist. Passing an empty list therefore yields
    an empty result, NOT the caller's own activity. A malformed ref is still an
    error. At most 20 refs.

    Only non-empty buckets are returned — zero-fill the window client-side.
    Counts only events of type read and write. Window bounds are ISO-8601
    strings: from is INCLUSIVE, to is EXCLUSIVE, so adjacent windows tile
    without double-counting. Defaults to the 7 days ending now; a span longer
    than 366 days is clamped by moving from forward.
    """
    usageActivity(
      "Window start, inclusive. Default: to minus 7 days."
      from: String
      "Window end, exclusive. Default: now."
      to: String
      bucket: UsageActivityBucketSize = DAY
      "Switch scope to all users of these memories, unioned (each ID or URN; max 20)."
      memoryRefs: [ID!]
      "IANA zone deciding where bucket boundaries fall. Default UTC."
      timeZone: String
    ): [UsageActivityBucket!]!

    # Sessions, most recent first
    "workerRef (#974): only sessions bound to that Worker (by id), newest first - the 'taken right now' / 'last driven by' read (cor:agt:020:03)."
    sessions(type: String, repo: String, customerId: String, workerRef: String, limit: Int, offset: Int): [Session!]!
    session(id: ID!): Session

    """
    The uniform single-user read (#473). 'ref' accepts a primary key or a
    \`hrn:user:<handle>\` URN. Resolves for the user themselves, a platform
    ADMIN/OWNER, or a caller sharing at least one organization with the
    target (the resolveUrn user gate); anyone else gets null — denied and
    missing are indistinguishable, preserving #384's anti-enumeration
    posture. PII fields (name/email) stay gated by the User field resolvers.
    """
    user(ref: ID!): User

    """
    Uniform paginated user list (#473) — replaces the admin-only users list
    and searchUsers. Platform ADMIN/OWNER: every live user, filter.query
    optional. Everyone else: filter.query is REQUIRED (blank/omitted -> empty
    page) and matching is enumeration-safe per cor:acl:070:02 — handle /
    githubUsername by substring, email by exact match, name only where the
    viewer may see it (self/admin/co-member). Name-ascending order (id
    tiebreak); limit default 50 / cap 200; limit: 0 -> count only.
    """
    users(filter: UserFilter, limit: Int, offset: Int): UsersPage!

    # Current authenticated user
    me: User

    """
    The resolved principal for the credential on THIS request (issue #562).
    Credential-type-agnostic: works for personal API keys, JWT sessions, and
    App keys alike — unlike me, which is null for a valid App credential.
    Returns null when the presented credential does not resolve (identically
    for revoked / never-existed / malformed — never a token oracle). See the
    AuthContext type for the full security posture.
    """
    authContext: AuthContext

    """
    One admin-impersonation audit record by id. Resolvable to the session's
    admin, an org ADMIN/OWNER of its org, or a platform admin; anyone else
    gets null (denied and missing are indistinguishable).
    """
    impersonationSession(ref: ID!): ImpersonationSession

    """
    Uniform paginated admin-impersonation audit list (createdAt-desc).
    Platform admins may omit orgId (unscoped); everyone else must name an
    org they are a live ADMIN/OWNER of. filter.activeOnly keeps only
    currently-live sessions. limit default 50 / cap 200.
    """
    impersonationSessions(orgId: String, filter: ImpersonationSessionFilter, limit: Int, offset: Int): ImpersonationSessionList!

    """
    Uniform paginated organization list (#473) — replaces organizations +
    myOrganizations. Scope: the caller's memberships; platform ADMIN/OWNER
    get every live org (the established admin unscoped reach) unless
    filter.memberOnly restricts the list to their own memberships (the old
    myOrganizations view, as a slice-as-filter). Name-ascending order (id
    tiebreak); limit default 50 / cap 200; limit: 0 -> count only.
    """
    organizations(filter: OrganizationFilter, limit: Int, offset: Int): OrganizationsPage!

    """
    Fetch an Organization (org member or platform ADMIN).

    'ref' accepts the entity's ID or URN.
    """
    organization(ref: ID!): Organization

    """
    cor:acl:080:02 — the sanitized PUBLIC view of a DISCOVERABLE organization,
    safe for a non-member. Returns non-null only when the org exposes a public
    footprint (a PUBLIC memory/agent, or listedOnMarketplace); otherwise null
    (denied is indistinguishable from not-found — anti-enumeration). Never
    exposes members, private memories, apps, or credentials. 'ref' accepts the
    org ID or URN.
    """
    publicOrganization(ref: ID!): PublicOrganization

    """
    cor:acl:080:04 — browse the marketplace catalogue: resources opted-in via
    listedOnMarketplace AND publicly accessible. Public (no membership required);
    sanitized flat refs only (never members / private data / credentials). One
    paginated query per resource type; ordered by (name, id) for stable paging.
    - marketplaceOrganizations: listedOnMarketplace orgs.
    - marketplaceAgents: listed + visibility=PUBLIC agents.
    - marketplaceMemories: listed + public-readable memories.
    Drill into an org's public footprint via publicOrganization(ref:).
    """
    marketplaceOrganizations(limit: Int, offset: Int): PublicResourceRefPage!
    marketplaceAgents(limit: Int, offset: Int): PublicResourceRefPage!
    marketplaceMemories(limit: Int, offset: Int): PublicResourceRefPage!

    # Invitation lookup (public — no auth required, used by invite acceptance page)
    invitation(slug: String!): UserInvitation

    """
    Fetch a single Memory (org member, shared-read gate, or platform ADMIN).

    'ref' accepts the entity's ID or URN.
    """
    memory(ref: ID!): Memory

    """
    Uniform paginated memory list (#473) — replaces myMemories,
    publicMemories, and orgSystemMemories.

    Default scope: the caller's union — (1) their OWN personal/private
    memories (always; they are user-owned and show in every org context),
    (2) memories their member orgs own, (3) memories their member orgs
    subscribe to. Per-user agent memories (userMemoryOfAgentId) are excluded.
    App-key callers get the union of their installed Agents' memory items.

    filter.visibility: PUBLIC selects the public marketplace slice instead
    (every PUBLIC memory — the old publicMemories). filter.memoryClasses
    restricts to exactly the listed classes; omitted, the noisy agent system
    class is hidden by default (pass it explicitly to surface system
    memories, e.g. the old orgSystemMemories = orgId + memoryClasses:
    [system]).

    orgId follows cor:api:100:01: member -> the "active organization" view
    (own personal/private + that org's owned + subscribed memories);
    non-member -> empty page, no existence disclosure, no admin bypass.

    Name-ascending order (id tiebreak); limit default 50 / cap 200;
    limit: 0 -> count only.
    """
    memories(filter: MemoryFilter, orgId: ID, limit: Int, offset: Int): MemoriesPage!

    "#772 — the caller's placed dashboard widgets, ordered by position. Empty for a non-user (App-key) caller."
    dashboardWidgets: [DashboardWidget!]!
    "#797 — data for each of the caller's PLACED widgets, in position order, one entry per placement built from its own config. Empty for a non-user caller."
    dashboardWidgetData: [DashboardWidgetData!]!

    """
    #806 — the caller's saved widget configurations, name-ordered (id tiebreak),
    optionally narrowed to one widget type. Empty for a non-user caller; never
    another user's presets.
    """
    dashboardWidgetPresets(
      "Return only presets for this widget type. Omit for all of them."
      type: DashboardWidgetType
    ): [DashboardWidgetPreset!]!

    """
    Exchange connections for an org.

    Accepts the entity's ID or URN.
    """
    exchangeConnections(orgId: ID!): [ExchangeConnection!]!

    """
    Fetch one Slack connection by id (spec 043). Returns null when the row
    does not exist OR the caller is not a member of its org — no existence
    disclosure.
    """
    slackConnection(ref: ID!): SlackConnection

    """
    Uniform paginated Slack-connection list (cor:api:120). Default scope:
    the caller's member orgs. orgId follows cor:api:100:01 (member -> that
    org, non-member -> empty page, no disclosure, no admin bypass).
    Team-name-ascending order (id tiebreak); limit default 50 / cap 200;
    limit: 0 -> count only.
    """
    slackConnections(orgId: ID, limit: Int, offset: Int): SlackConnectionsPage!

    """
    Fetch one registered external MCP server by id. Returns null when the
    row does not exist OR the caller is not a member of its org — no
    existence disclosure.
    """
    mcpServer(ref: ID!): McpServer

    """
    Uniform paginated MCP-server list (cor:api:120). Default scope: the
    caller's member orgs. orgId follows cor:api:100:01 (member -> that
    org, non-member -> empty page, no disclosure, no admin bypass).
    Slug-ascending order (id tiebreak); limit default 50 / cap 200;
    limit: 0 -> count only.
    """
    mcpServers(orgId: ID, limit: Int, offset: Int): McpServersPage!

    """
    Live tools/list passthrough for one registered server (org member) —
    what authors browse to pick data.tools entries. Applies the same
    admissibility filter as run-tool materialization, so what it returns
    IS what a run can call: a disabled server errors with
    MCP_SERVER_DISABLED rather than listing uncallable tools. Null when
    the row does not exist or the caller is not a member of its org;
    errors with MCP_TOOL_* codes when the conduit or the external server
    fails.
    """
    mcpServerTools(ref: ID!): [McpServerTool!]

    """
    Fetch one secret's inspectable half (never the value). Null when the
    row does not exist OR the caller is not entitled to its owner scope —
    no existence disclosure. Entitlement: user -> that user; org -> org
    member; app -> app owner or org member; memory -> memory READ.
    """
    secret(ref: ID!): Secret

    """
    Paginated secret list for ONE owner scope (the hadron secret ls
    surface). ownerRef accepts ID or URN (cor:api:140) and defaults to the
    caller for ownerType user. An unresolvable ref or a non-entitled owner
    yields an empty page — no disclosure. Name-ascending order (id
    tiebreak); limit default 50 / cap 200; limit: 0 -> count only.
    """
    secrets(ownerType: String!, ownerRef: ID, limit: Int, offset: Int): SecretsPage!

    """
    Fetch one registered Home Assistant instance (org member). Null when
    the row does not exist OR the caller is not a member of its org — no
    existence disclosure.
    """
    homeAssistantInstance(ref: ID!): HomeAssistantInstance

    """
    Uniform paginated Home Assistant instance list (cor:api:120). Default
    scope: the caller's member orgs. orgId follows cor:api:100:01 (member
    -> that org, non-member -> empty page, no disclosure, no admin
    bypass). Slug-ascending order (id tiebreak); limit default 50 / cap
    200; limit: 0 -> count only.
    """
    homeAssistantInstances(orgId: ID, limit: Int, offset: Int): HomeAssistantInstancesPage!

    "Fetch one sanitized BYO Resend sender config; null for missing or inaccessible."
    resendSender(ref: ID!): ResendSender

    "Uniform paginated BYO Resend sender list scoped to the caller's member orgs."
    resendSenders(orgId: ID, limit: Int, offset: Int): ResendSendersPage!

    """
    The ops one registered instance exposes (the closed catalog filtered
    by the row's allowlist) — what authors browse to pick data.tools
    entries; what this returns IS what a run can call. Null when the row
    does not exist or the caller is not a member of its org; a disabled
    instance errors with HA_INSTANCE_DISABLED.
    """
    homeAssistantInstanceOps(ref: ID!): [HomeAssistantOp!]
    exchangeMessages(
      connectionId: ID!
      top: Int
      "Deprecated: raw provider filters are gone; only 'isRead eq false' still translates. Use unreadOnly."
      filter: String
      unreadOnly: Boolean
    ): [ExchangeMessage!]!
    exchangeFolders(connectionId: ID!): [ExchangeFolder!]!

    # ── Calendar reads (hadrontool-google-cal) ─────────────────────────
    # Owner-only for interactive users; App/headless callers need a
    # ConnectionGrant covering calendar.read (calendar.freebusy for
    # calendarSchedule) — the same gate as the mail surface.

    "Calendars the connected account can see. Grant scope: calendar.read."
    calendars(connectionRef: ID!): [CalendarInfo!]!

    """
    Events in a time window (recurring events expand to instances, ordered
    chronologically). start/end are RFC 3339; calendarId defaults to the
    account's primary calendar. Grant scope: calendar.read.
    """
    calendarEvents(
      connectionRef: ID!
      calendarId: String
      start: String
      end: String
      "Free-text search over event fields."
      query: String
      top: Int
    ): [CalendarEvent!]!

    "One event by id. Grant scope: calendar.read."
    calendarEvent(connectionRef: ID!, eventId: ID!, calendarId: String): CalendarEvent!

    """
    Free/busy intervals for one or more schedules (calendar ids or addresses
    the account can read; defaults to the account's primary calendar).
    Structurally capped at yes/no busy windows — never event contents.
    Grant scope: calendar.freebusy.
    """
    calendarSchedule(
      connectionRef: ID!
      start: String!
      end: String!
      schedules: [String!]
    ): [ScheduleFreeBusy!]!

    # ── Drive reads (hadrontool-google-drive, #749) ────────────────────
    # Owner-only for interactive users; App/headless callers need a
    # ConnectionGrant covering drive.read — the same gate as the mail and
    # calendar surfaces.

    """
    Browse or search the connected drive. With no search criteria, lists
    the children of folderId (default: the drive root), folders first.
    Any of query/nameContains/mimeType/modifiedAfter switches to a search,
    most recently modified first. Grant scope: drive.read.
    """
    driveFiles(
      connectionRef: ID!
      folderId: ID
      "Full-text search over file content."
      query: String
      nameContains: String
      "Exact MIME type filter."
      mimeType: String
      "RFC 3339 lower bound on last modification."
      modifiedAfter: String
      top: Int
      pageToken: String
    ): DriveFilePage!

    "File metadata by id. Grant scope: drive.read."
    driveFile(connectionRef: ID!, fileId: ID!): DriveFile!

    """
    Export a drive file as text: native documents convert (Docs export
    natively to MARKDOWN; spreadsheets to TEXT as CSV; presentations to
    TEXT), text files return verbatim. Binary files are refused (typed
    validation error). Size-capped with a typed file_too_large — never
    truncated. Grant scope: drive.read.
    """
    driveFileExport(connectionRef: ID!, fileId: ID!, format: DriveExportFormat): DriveFileExport!

    """
    Uniform paginated app list (#473) — replaces the org-ADMIN apps(orgId!)
    and the member myApps. Scope: Apps in the caller's member orgs (App
    doesn't carry a userId, so org membership is the routing); platform
    ADMIN/OWNER unscoped get every live App. orgId follows cor:api:100:01
    (member -> scope, non-member -> empty page, no disclosure, no admin
    bypass). Name-ascending order (id tiebreak); limit default 50 / cap 200;
    limit: 0 -> count only. filter.ownedByMe (#782) narrows to the caller's own
    user-owned (org-less) Apps for every caller including platform admins.
    """
    apps(filter: AppFilter, orgId: ID, limit: Int, offset: Int): AppsPage!

    """
    Fetch an App (member of the App's org, or platform ADMIN — the myApps
    exposure bar; #473 relaxed this from org ADMIN for read parity with the
    list).

    'ref' accepts the entity's ID or URN.
    """
    app(ref: ID!): App
    # The App authenticated by the current AppKey (null for JWT users without an App)
    myApp: App

    """
    The uniform single-agent read (#473) — the first top-level Agent query;
    previously Agents were reachable only via Organization.agents /
    App.agents nesting. Gate mirrors resolveUrn's agent branch: member of
    the Agent's org or platform ADMIN/OWNER; denied throws Forbidden,
    missing is null.

    'ref' accepts the entity's ID or URN.
    """
    agent(ref: ID!): Agent

    """
    Uniform paginated agent list (#473). Scope: Agents owned by the caller's
    member orgs; platform ADMIN/OWNER unscoped get every live Agent. orgId
    follows cor:api:100:01 (member -> scope, non-member -> empty page, no
    disclosure, no admin bypass). filter narrows by type / visibility.
    filter.ownedByMe (#782) narrows to the caller's own user-owned (org-less)
    agents for every caller including platform admins. Name-ascending order
    (id tiebreak); limit default 50 / cap 200; limit: 0 -> count only.
    """
    agents(filter: AgentFilter, orgId: ID, limit: Int, offset: Int): AgentsPage!

    """
    #551 — the public-agent marketplace slice: every live PUBLIC agent,
    readable by ANY caller (no membership required), so an org can discover
    foreign public agents to subscribe to (008/009 AgentOrgGrant;
    hadron-portal#486). Kept SEPARATE from agents() on purpose: agents() stays
    bounded to the caller's own orgs, and the cross-org widening is this
    explicit, paginated surface rather than a value in a filter.

    filter.type narrows by AgentType; filter.visibility is IGNORED (the slice
    is PUBLIC by definition).

    Field-level exposure: a PUBLIC agent publishes its OWN definition
    (systemPrompt / systemMemoryId / memoryItems / imports) to every caller —
    that is what a marketplace listing is (#551). The fields that surface OTHER
    tenants (apps / appAgents / appCount / orgGrants / importedBy) are scoped to
    the caller's own access and come back empty for an outsider (#552, #757).

    Name-ascending order (id tiebreak); limit default 50 / cap 200;
    limit: 0 -> count only.
    """
    publicAgents(filter: PublicAgentFilter, limit: Int, offset: Int): AgentsPage!
    # 005-agent-subscription FR-005: AgentSubscriptions held by the
    # authenticated user. Read-only in v1.
    myAgentSubscriptions: [AgentSubscription!]!

    """
    005-agent-subscription FR-022: list all AgentSubscriptions for an
    Agent. Authorized for ADMIN/OWNER of the Agent's owning org.

    Accepts the entity's ID or URN.
    """
    agentSubscriptions(agentRef: ID!): [AgentSubscription!]!

    """
    All nodes accessible by an App: the union of every installed agent's
    system memory (read-only) and its knowledge memoryItems (#524).

    Accepts the entity's ID or URN.

    An optional NodeFilter pushes node-level predicates server-side — e.g.
    filter: { isRunnable: true } to list the App's runnable task nodes (#525).
    The App's memory scope is authoritative, so the filter's memory-scope
    fields (memoryIds / memoryClasses) are rejected with BAD_USER_INPUT rather
    than silently ignored — use findNodes for cross-memory scoping. Only
    node-level predicates (nodeType, tags, isRunnable, locPrefix, createdBy,
    updatedAfter/Before, includeDeleted) apply. Unlike findNodes, system-memory
    nodes are NOT excluded by default.
    """
    appNodes(appRef: ID!, filter: NodeFilter, limit: Int): [Node!]!

    """
    Slim, paginated node list for rendering a memory's graph view (issue #466).
    Returns ONLY the fields a node-link graph draws (id, loc, name, nodeType,
    tags) — no content / abstract / data / tokens / edges — so the payload is a
    fraction of the full node fragment. The graph view loads this to completion
    (page by page) and renders nodes, THEN loads memoryEdges to draw the links.

    memoryRef accepts the memory's ID or URN; a memory the caller can't read
    returns an empty page (total 0, no existence disclosure). Paged via limit
    (default 1000, hard-capped 2000) + offset; total is the memory's full node
    count so the client can show "N of M" and know when it has paged them all.
    limit: 0 returns an empty page with just the total — the cheap "how big is
    this memory" node count. Deterministic loc-ascending order so offset paging
    never drops/duplicates.
    """
    memoryNodes(memoryRef: ID!, limit: Int, offset: Int): GraphNodesPage!

    """
    Slim, paginated edge list for a memory's graph view (issue #466) — phase two
    after memoryNodes. Returns endpoint IDs only (sourceId/targetId); the client
    already holds the nodes by the time it draws edges, so it maps id -> node
    itself. Scoped by the edge's denormalized memoryId (edges whose SOURCE is in
    the memory); a cross-memory edge may reference a target outside this memory,
    which the client drops as a dangling endpoint. Same access gate, paging, and
    deterministic loc-ascending order as memoryNodes.
    """
    memoryEdges(memoryRef: ID!, limit: Int, offset: Int): GraphEdgesPage!

    """
    Decrypted AI config for an App (org ADMIN of the App's org).

    Accepts the entity's ID or URN.
    """
    appAIConfig(appRef: ID!): AppAIConfig

    """
    List keys for an App (org ADMIN of the App's org).

    Accepts the entity's ID or URN.
    """
    appKeys(appRef: ID!): [AppKey!]!

    """
    025-oauth-for-mcp FR-004: list the calling User's API keys (active
    + revoked, createdAt DESC). Powers Phase 3's portal revocation UI
    (SC-006). Rejected with UNAUTHENTICATED for AppKey-resolved
    callers (no user in context). PR-137 review delta D5 — Query
    not present in PR 137.
    """
    myUserApiKeys: [UserApiKey!]!

    """
    Agent AI config (org ADMIN) — returns the decrypted API key so the
    portal backend can make LLM calls on behalf of the user.

    036-ai-service-config: registry-backed (the Agent's config named
    'default'). Prefer resolveAIConfig for new callers.

    Accepts the entity's ID or URN.
    """
    agentAIConfig(agentRef: ID!): AgentAIConfig

    """
    The uniform single-config read (#473). 'ref' is the config's ID —
    AiServiceConfig is the one URN-less entity (matching resolveUrn /
    effectiveAccess dispatch). Masked: never returns key material, only
    hasApiKey + apiKeyPreview (resolveAIConfig is the privileged decrypted
    read). Auth mirrors the list: platform ADMIN/OWNER for
    HADRON_SERVER-owned configs, org ADMIN of the owning org otherwise;
    denied throws Forbidden, missing is null.
    """
    aiServiceConfig(ref: ID!): AiServiceConfig

    """
    036-ai-service-config: masked, paginated list of AI configs (#473).
    Never returns key material — only hasApiKey + apiKeyPreview.

    filter names the owning entity. Auth: platform ADMIN/OWNER for
    HADRON_SERVER owners; org ADMIN of the owning org for ORGANIZATION /
    APP / AGENT owners. filter omitted entirely = the platform ADMIN/OWNER
    cross-owner view of every config (non-admin callers must filter).

    Name-ascending order (id tiebreak); limit default 50 / cap 200;
    limit: 0 -> count only.
    """
    aiServiceConfigs(filter: AiServiceConfigFilter, limit: Int, offset: Int): AiServiceConfigsPage!

    """
    036-ai-service-config: resolve a config name for an execution context
    and return the DECRYPTED credentials (privileged; successor to
    agentAIConfig/appAIConfig).

    Walk: App -> Agent -> Org (of the App, else of the Agent) ->
    HadronServer; disabled configs are skipped. When name is omitted,
    'default' is resolved. When an explicit name misses, resolution falls
    back to 'default'; if that also misses, errors with
    NoAiConfigAvailableError. Consumers (webhooks, scheduled tasks, the
    portal chatbot) reference configs by name only — pass the name plus
    the execution context, never credentials.

    Auth: org ADMIN of the effective context org, or platform
    ADMIN/OWNER (required when no app/agent context is given).

    appRef/agentRef accept the entity's ID or URN.
    """
    resolveAIConfig(name: String, appRef: ID, agentRef: ID): ResolvedAiConfig!

    """
    036-ai-service-config: the MASKED set of configs RESOLVABLE in an
    execution context — every distinct config name a chat in this context
    could select. Populates a config picker in the chatbot UI.

    Same walk as resolveAIConfig (App -> Agent -> Org (of the App, else of
    the Agent) -> HadronServer), but returns ALL names instead of resolving
    one: configs are deduped by name with the innermost owner winning, so
    each entry is the row resolveAIConfig would return for that name. Only
    the Agent named here contributes — sibling Agents installed in the same
    App are not consulted. Disabled configs are skipped. Never returns key
    material (hasApiKey + apiKeyPreview only).

    Auth: scoped to one App's chat context. A non-admin caller MUST pass an
    appRef, be a member of that App, and (when an agentRef is given) the Agent
    must be installed in that App. Because the result is masked (no key
    material), App membership — not org admin — is the bar, unlike
    resolveAIConfig and the aiServiceConfigs management list. Platform
    ADMIN/OWNER are always allowed and may omit appRef.

    appRef/agentRef accept the entity's ID or URN.
    """
    resolveAiServiceConfigs(appRef: ID, agentRef: ID): [AiServiceConfig!]!

    """
    Saved chats for the current user in their personal memory for an
    agent. Newest first.

    Accepts the entity's ID or URN.
    """
    myChats(agentRef: ID!, limit: Int, offset: Int): [Chat!]!

    # Message history for a saved chat. Returns plain role/content pairs
    # suitable for feeding back into an LLM.
    chatHistory(chatId: String!, limit: Int): [ChatMessage!]!

    """
    Read a team App's chat (#939), seq-ordered ascending, as a uniform
    { items, total } page. sinceSeq is a watermark cursor: only messages with
    seq STRICTLY GREATER than it are returned (pass the last seq you have
    seen). mentionsRef filters to messages whose stored envelope mentions the
    referenced worker (a Worker id or name of THIS App, retired included) or
    user (handle/id) — matching runs against the mention tokens extracted at
    write time, never by re-parsing bodies. The ref must name this App's own
    staff or members (a Worker of the App, an AppMember, or the caller); an
    unresolvable or foreign mentionsRef yields the empty page identically (no
    existence oracle). limit defaults to 50 (cap 200); limit: 0 returns only
    total.

    Authorization: an AppMember of the App (any role), an org member with
    CONTRIBUTOR+ on the App's org, the owner of a user-owned App, or the
    App's own key (a pure App-key principal may READ its team chat).

    appRef and mentionsRef accept the entity's ID or URN.
    """
    teamChatMessages(
      appRef: ID!
      sinceSeq: Int
      mentionsRef: ID
      limit: Int
      offset: Int
    ): TeamChatMessagesPage!

    """
    Read a team App's worklog (#947) — the provenance query: which sessions
    (and transcripts) produced this PR? Newest first, as a uniform
    { items, total } page. ref accepts ANY accepted spelling (URL, short form,
    canonical) and is matched tool-awarely: with tool 'github' (or none) it is
    normalized, so 'https://github.com/o/r/pull/371' and 'o/r#371' return the
    same records; with another tool it matches the stored verbatim ref; with
    no tool it matches either spelling. sessionRef / tool / kind are equality
    filters; kind must be one of pr, issue, commit, branch, repo when given.
    limit defaults to 50 (cap 200); limit: 0 returns only total.

    Authorization: an AppMember of the App (any role), an org member with
    CONTRIBUTOR+ on the App's org, the owner of a user-owned App, or the
    App's own key (a pure App-key principal may READ its own App's worklog).

    appRef accepts the entity's ID or URN; sessionRef is the session id.
    """
    teamWorkItems(
      appRef: ID!
      ref: String
      sessionRef: ID
      """
      #1035 — everything ONE worker has done, filtered server-side so the page
      envelope stays correct. Without it a client must fan out over
      sessions(workerRef:) and merge, which cannot reproduce \`total\` or a
      stable offset on the one surface whose whole point is completeness.

      Accepts a worker id, its URN, or its NAME within this App. A RETIRED
      worker still resolves — retirement ends the casting, not the history.
      Records from a session that was never worker-bound carry no worker and
      do not match. A ref that names nothing readable in this App yields an
      EMPTY page rather than an error, so this is never an existence oracle
      for another App's roster.
      """
      workerRef: ID
      tool: String
      kind: String
      limit: Int
      offset: Int
    ): TeamWorkItemsPage!

    """
    One Worker by ref (#974) — its id, its URN (#991), or (with appRef) its
    NAME (#1015), the ergonomic handle a human already knows. The name form is
    ADDITIVE: it is activated by appRef, since a name is unique only within an
    App. Without appRef the ref must be an id or URN, and anything else refuses
    WORKER_NOT_FOUND as before. An id or URN wins over appRef rather than being
    checked against it, so a typo'd URN never degrades into a roster search.

    Selecting \`prompt\` re-renders the worker's boot briefing live from the
    role agent's template — the read that lets an agent recover a briefing it
    lost to a context compaction, instead of opening a second session or
    forcing a takeover of itself.

    Authorization: an AppMember of the worker's App (any role), an org member
    with CONTRIBUTOR+ on its org, the owner of a user-owned App, or the App's
    own key. For the NAME form the gate runs BEFORE the lookup and a denial is
    reported as WORKER_NOT_FOUND, so the roster is not an existence oracle.
    """
    worker(ref: ID!, appRef: ID): Worker

    """
    A team App's STAFF (#974, cor:agt:020:01 — Workers are the staff; the
    AppAgent join is the install roster): the App's castings, oldest first,
    as a uniform { items, total } page. Retired castings are hidden unless
    includeRetired. Same authorization as worker. appRef accepts the App's
    ID or URN.
    """
    workers(appRef: ID!, includeRetired: Boolean, limit: Int, offset: Int): WorkersPage!

    """
    An App's role definitions (#960): every roles:<role> node in the Team
    Agent's system memory, projected with the one answer a client cannot
    compute — which register names are still FREE, judged against the App's
    full worker roster (names are unique per App, case-insensitively, forever
    — cor:agt:020:02). Ordered by role slug. Same read authorization as
    workers. teamAgentRef disambiguates when more than one installed agent
    carries a roles: branch (TEAM_AGENT_AMBIGUOUS otherwise); an encrypted
    system memory without an active session key refuses SESSION_EXPIRED.
    """
    teamRoles(appRef: ID!, teamAgentRef: ID, limit: Int, offset: Int): TeamRolesPage!

    """
    Dry-run castWorker (#964): run the cast's exact resolution — same
    arguments, same typed refusals (WORKER_AGENT_NOT_FOUND / _AMBIGUOUS /
    _NOT_INSTALLED, WORKER_ROLE_NOT_FOUND, WORKER_REGISTER_EXHAUSTED,
    WORKER_NAME_TAKEN, APP_UNINSTALLED, TEAM_AGENT_NOT_FOUND /
    _NOT_INSTALLED / _AMBIGUOUS, and SESSION_EXPIRED for an encrypted
    register without an active session key), same MINT gate — up to but not
    including the writes, and return what would be created. A Query, not a
    dryRun flag: casting a name is the one irreversible act in the team
    feature (cor:agt:020:02 — permanence), and previewing it must not need a
    mutation permission model or a fake Worker row. THE PREVIEW RESERVES
    NOTHING: no lease exists by law (cor:agt:020:03), so a previewed name may
    be gone at cast time — by design; the cast's uniqueness constraint
    remains the only allocation primitive.
    """
    castWorkerPreview(
      appRef: ID!
      agentRef: ID
      role: String
      name: String
      teamAgentRef: ID
      promptOverride: String
    ): CastWorkerPreview!

    # ── Assets (spec 004-asset-upload + 006-asset-upload-redesign) ────
    # v1 — agent-addressed listing. Deprecated; use memoryAssets.
    agentAssets(
      agentUrn:       String!
      mimeType:       String
      skip:           Int = 0
      count:          Int = 20
      includeDeleted: Boolean = false
    ): AssetListResult!

    """
    v2 (spec 006) — memory-addressed listing. Returns every asset
    attached to the memory; the gate is the memory's read access. The
    replacement for agentAssets in the v2 surface.

    Set mine: true to narrow to the caller's own uploads — a filter on
    top of the read gate, not a substitute for it.

    Accepts the entity's ID or URN.
    """
    memoryAssets(
      memoryId:       ID!
      mimeType:       String
      skip:           Int = 0
      count:          Int = 20
      includeDeleted: Boolean = false
      mine:           Boolean = false
    ): AssetListResult!

    """
    Cross-memory asset list (#891) — every file the caller can reach,
    which is every asset held by a memory they can read. The uniform
    find-many surface for assets (spec cor:api:120); memoryAssets stays
    as the per-memory one.

    The three tabs of a top-level Assets section are filters over this,
    not separate queries: mine: true, no filter, and orgId respectively.
    """
    assets(
      filter: AssetFilter
      orgId:  ID
      limit:  Int = 50
      offset: Int = 0
    ): AssetsPage!

    # Mint a short-TTL presigned GET URL for an asset. Default TTL
    # 5 minutes; ceiling 1 hour. Gated on the holding memory's read
    # access and on scan_status = CLEAN.
    assetDownloadUrl(assetId: ID!, ttlSeconds: Int = 300): AssetDownloadUrl!

    """
    Identity of the hadron-server this GraphQL endpoint is bound to: the
    server-identity version and the deployment's canonical base URL. The
    GraphQL counterpart to the hadron_server_info MCP tool — both read the
    same getDeploymentInfo() helper, so MCP and GraphQL callers get one
    consistent answer to "which server/API am I talking to?".

    'version' is HADRON_SERVER_VERSION — the MCP/API-surface contract
    version, bumped when the tool/query surface changes in a caller-visible
    way. It is intentionally NOT the repo's package.json release version.

    Public — no authentication required. Does NOT expose the DATABASE_URL
    (it may carry credentials).
    """
    serverInfo: ServerInfo!

    # Spec 040 — the run audit surface (what ran, why, what it cost).
    """
    The next sibling node under a parent, ordered by seq (#817) — the GraphQL
    twin of hadron_get_next_node, so guided reading order is no longer MCP-only.

    parentRef / currentRef take a node PK or a fully-qualified URN
    (cor:api:140). Omit currentRef to get the FIRST child.

    Order: seq ascending; a NULL seq sorts LAST, after every explicitly ordered
    sibling; ties break on loc ascending. Identical to the MCP tool, so the two
    surfaces cannot present different reading orders.

    Returns null at the end of the sibling chain, and for a parent that does
    not exist or the caller cannot read — denied and missing are indistinguishable. A
    currentRef that is not among the parent's direct children is likewise null
    rather than an error, so it cannot probe a node's parentage. A MALFORMED
    ref still throws: a shape error discloses nothing about what exists.

    Stateless — this is a next-sibling read, not a session-backed cursor.
    """
    nextNode(parentRef: ID!, currentRef: ID, raw: Boolean): Node

    """
    Render a run/action node WITHOUT executing it (#818) — the GraphQL twin of
    hadron_run_action, which despite its name executes nothing: it loads the
    node, resolves its dependency edges, and renders with args.

    runTask covers the EXECUTE half. This is the render half, for previewing a
    task before running it (a task run --dry-run), for reading an action's
    assembled instructions when the CALLER is the executor, and for debugging
    template/dependency resolution without side effects.

    A Query because it is side-effect-free, and unlike the MCP tool it records
    NO action-run UsageEvent — metering a preview would inflate the ledger with
    actions nobody took.

    Uses the SAME assembler runTask executes (Mustache compilation via
    compileTemplate; flow-ROUTING edges skipped, since they are the walker's
    rails rather than references), so a dry run predicts the real prompt.

    Two deliberate narrowings relative to execution, both fail-safe: a
    referenced node the caller cannot READ is omitted rather than inlined
    (an edge may cross memories), and an edge whose target was soft-deleted is
    skipped so a preview cannot resurrect removed instructions.

    NOTE this is NOT the legacy MCP hadron_run_action bundle, which does a
    literal placeholder replace and inlines every outgoing edge. Where the two
    differ, this one matches execution.

    nodeRef is a node PK or a fully-qualified URN (cor:api:140). Denied and
    missing both raise NODE_NOT_FOUND - no existence oracle.
    """
    renderRunNode(nodeRef: String!, args: JSON): String!

    """
    Memory health audit (#819) — the GraphQL twin of hadron_validate, which was
    MCP-only, so the CLI, the portal and CI had no way to answer "is this
    memory healthy?".

    Every check is over server-owned state a client cannot compute:
    abstractOriginHash vs current content, embedding_failed_at (not projected
    on Node at all), and property-schema conformance. So unlike other gaps
    there is no slow client-side fallback.

    Returns TYPED findings so a caller can branch and CI can gate on
    totalFindings. findings is capped by limit (default 200, max 1000) while
    totalFindings reports the true count - so a gate is never fooled by
    truncation. Read gate as the rest of the memory reads.
    """
    validateMemory(memoryRef: ID!, limit: Int): MemoryValidationResult!

    "One run (cor:agt:010:02). ref is an AppRun ID or an hrn:apprun:<root>:<app>:<run-id> URN (#696)."
    appRun(ref: ID!): AppRun
    "The latest run of an App resolved to a concrete run (#696) — 'current/latest/previous' are queries, never magic run-ids in URN space (cor:urn:010:02). previous: true returns the run before the latest."
    latestAppRun(appRef: String!, previous: Boolean): AppRun
    """
    The run audit list.

    statuses (#836) is a disjunction — 'everything still in flight' is
    [PENDING, RUNNING] and 'what went wrong' is [FAILED, TIMED_OUT], neither of
    which the single-valued status arg could express. Per
    conventions:multi-ref-scope-args: OMITTING it means no status filter, while
    an explicitly EMPTY list is the EMPTY scope and returns nothing - it never
    silently falls back to 'all'. Values are deduped; an unknown member is
    rejected by enum validation rather than dropped.

    status is DEPRECATED in favour of statuses. Both are accepted for one
    release; when both are given, statuses wins.

    sortBy / sortDir (#833) order the whole result set server-side, so a client
    table is no longer limited to sorting the page it happens to hold.
    """
    appRuns(
      appRef: String
      orgRef: String
      status: AppRunStatus @deprecated(reason: "Use statuses (#836) - a single value cannot express PENDING-or-RUNNING.")
      statuses: [AppRunStatus!]
      parentRunId: ID
      sortBy: AppRunSortField
      sortDir: SortDirection
      limit: Int
      offset: Int
    ): AppRunsPage!
    agentSchedules(appRef: String!, limit: Int, offset: Int): AgentSchedulesPage!
    agentWebhooks(appRef: String!, limit: Int, offset: Int): AgentWebhooksPage!
    "The ticket ledger: minted, consumed-by-which-run, expired (org-ADMIN)."
    actionTickets(orgRef: String!, limit: Int, offset: Int): ActionTicketsPage!
    # Spec 042 Track B (#593) — connection delegation grants, owner-scoped.
    "One connection grant the caller created, by ID; null if not theirs (no existence oracle)."
    connectionGrant(ref: ID!): ConnectionGrant
    "The caller's own connection grants; connectionRef narrows to one connection."
    connectionGrants(connectionRef: String, limit: Int, offset: Int): ConnectionGrantsPage!
    "One action grant by ID - visible to the grantee or an admin of its org; null otherwise (no existence oracle)."
    principalGrant(ref: ID!): PrincipalGrant
    "Action grants. Default: the caller's own (self-audit is never gated). An org admin passing orgRef sees that org's grants, optionally narrowed by userRef."
    principalGrants(orgRef: String, userRef: String, limit: Int, offset: Int): PrincipalGrantsPage!
    "Usage-vs-limit counters for an org (+ one app when appRef given). Org-ADMIN. Rows materialize on first view, seeded with platform defaults (#510)."
    quotaCounters(orgRef: String!, appRef: String): [QuotaCounter!]!
    "Explain the standing policy chain (org / user / app) for one action - which layer denies it (#510, cor:acl:040:02). Org-ADMIN on the app's org."
    effectiveActionPolicy(appRef: String!, action: String!, userRef: String): EffectiveActionPolicy!
    "One provider rate row by id (spec 046). Authenticated read - rates are not a secret."
    aiModelPrice(ref: ID!): AiModelPrice
    "Provider rate rows, newest effective first, optional provider/model filter (spec 046). Authenticated read."
    aiModelPrices(provider: String, model: String, tier: Int, limit: Int, offset: Int): AiModelPriceList!
    "One org's append-only credit-ledger page, newest first (spec 046). Org-ADMIN."
    creditLedgerEntries(orgRef: String!, limit: Int, offset: Int): CreditLedgerEntryList!
    "One org's credit balance - SUM over the append-only ledger (spec 046). Org-ADMIN."
    creditBalance(orgRef: String!): CreditBalance!
  }

  """
  Identity of the running hadron-server (see Query.serverInfo).
  """
  type ServerInfo {
    # HADRON_SERVER_VERSION — the MCP/API-surface contract version.
    version: String!
    # The deployment's canonical base URL (BASE_URL, else the local default).
    baseUrl: String!
  }

  type Mutation {
    """
    Start impersonating another member of orgRef (admin support/diagnostics).
    Caller must be a live ADMIN/OWNER of the org (platform ADMIN/OWNER is
    OWNER-equivalent), the target a live member, PEER-OR-BELOW (an org ADMIN
    may not impersonate an org OWNER), never self. Returns the audit session
    and a short-TTL token (returned exactly once) whose requests run
    READ-ONLY as the target, scoped to this one org: other orgs and all
    personal-class resources stay invisible, and every mutation except
    stopImpersonation is rejected. Every request re-validates the session
    row, so stopping it (or demoting the admin) kills the token immediately.
    """
    startImpersonation(orgRef: String!, userRef: String!, reason: String): StartImpersonationResult!

    """
    Stop an impersonation session (writes endedAt; the audit row is never
    deleted). With an impersonation token, id may be omitted (ends the
    token's own session — the one mutation an impersonated context may
    call). With a normal token, id is required and the caller must be the
    session's admin, an org ADMIN/OWNER of its org, or a platform admin.
    Idempotent on an already-ended session.
    """
    stopImpersonation(id: ID): ImpersonationSession!

    """
    #772 — replace the caller's entire dashboard widget selection. Grid position
    is the array order; each widget's span (1-12) and rowSpan (1-4) are required
    and clamped server-side. Covers both create and update (the layout is always
    saved as a whole). Returns the new selection. Requires an authenticated user.
    """
    setDashboardWidgets(widgets: [DashboardWidgetInput!]!): [DashboardWidget!]!

    """
    #806 — save a named widget configuration for the caller. 'name' is trimmed
    and must be 1-60 characters, unique among the caller's presets for that
    widget type; a duplicate is BAD_USER_INPUT. 'config' must be a JSON object
    within the same 4KB budget as a placement's config. Requires an
    authenticated user.
    """
    createDashboardWidgetPreset(
      type: DashboardWidgetType!
      name: String!
      config: JSON!
    ): DashboardWidgetPreset!

    """
    #806 — rename a preset and/or replace its settings. Partial: an omitted (or
    null) argument leaves that field alone; there is no way to clear 'config',
    since a preset with no settings has nothing to apply. 'type' is immutable —
    delete and re-create to move settings to another widget. A preset the caller
    does not own is indistinguishable from one that does not exist (NOT_FOUND).
    """
    updateDashboardWidgetPreset(
      presetRef: ID!
      name: String
      config: JSON
    ): DashboardWidgetPreset!

    """
    #806 — delete one of the caller's presets. Placements already seeded from it
    keep their config (apply copies; there is no live link). A preset the caller
    does not own is indistinguishable from one that does not exist (NOT_FOUND).
    """
    deleteDashboardWidgetPreset(presetRef: ID!): Boolean!

    """
    Create a single node. Rejects with NodeLocConflictError when a live node
    already exists at (memoryId, loc) — creating is create-only (spec 039
    Phase 0 D1); a soft-deleted node at the target loc is resurrected.
    'name' is required here and only here (D4).
    """
    createNode(input: CreateNodeInput!): Node!

    """
    Update an existing node. Identify it by 'id' (PK or fully-qualified node
    URN) XOR the ('memoryId', 'loc') combo — supplying both selectors, or
    neither, is an error (D2). Rejects with NODE_NOT_FOUND when the target
    does not exist; updateNode never creates and never moves (relocation is
    moveNode's job, D3). Every content field is optional — omitted fields are
    preserved ('name' included, D4; 'abstract' keeps its omit/null/string
    contract; omitted 'tags' are preserved, issue #235).
    """
    updateNode(input: UpdateNodeInput!): Node!

    # Shallow-merge a JSON patch into a node's 'data' bag. The supplied JSON's
    # top-level keys are written over the node's existing 'data' (the patch
    # wins on key collision); keys the patch doesn't mention are preserved.
    # If the node has no 'data' yet, the supplied JSON becomes its 'data'
    # verbatim. 'data' must be a JSON object (not an array or scalar). 'nodeRef'
    # is a node ID or fully-qualified URN. Honors the same single-write
    # invariants as updateNode (per-memory write auth, encryption, revision
    # history, git mirror). Returns the updated node.
    updateNodeData(nodeRef: ID!, data: JSON!, reason: String): Node!

    # #742 - Shallow-merge a JSON patch into a node's structured 'properties'
    # (the schema-governed JSONB column, DISTINCT from 'data'). The patch's
    # top-level keys are written over the node's existing 'properties' (patch
    # wins on collision); unmentioned keys are preserved; a node with no
    # 'properties' takes the patch verbatim. 'properties' must be a JSON object
    # (not an array or scalar). 'nodeRef' is a node ID or fully-qualified URN.
    # On a schema-governed memory the MERGED result is validated against the
    # memory's schema (BAD_USER_INPUT on a violation). 'properties' is plaintext
    # at rest (never encrypted), so the merge + conformance check need no key —
    # but the write still honors the same single-write invariants as updateNode
    # (per-memory write auth, an active session on an encrypted memory, revision
    # history, git mirror). Returns the updated node.
    updateNodeProperties(nodeRef: ID!, properties: JSON!, reason: String): Node!

    # #745 — Object store: the legible sugar surface over structured storage.
    # An object IS a node; these ops are thin projections onto createNode /
    # updateNodeProperties / deleteNode, inheriting all their invariants
    # (auth, encryption, schema conformance, revisions, atomic merge).

    # Create an object in a collection. 'memoryRef' is a memory ID or
    # fully-qualified URN (relative refs are rejected, spec 022). 'type' is the
    # collection (node objectType); 'fields' are the flat, typed properties
    # (validated against the memory schema when the collection is declared). The
    # node's loc is auto-derived (<type>:<key ?? generated-id>) and hidden; pass
    # 'key' for a human-meaningful id (a single segment, no ':'), 'name' to
    # override the derived node name. 'id' and 'type' are reserved and cannot be
    # field names. Returns the flat object.
    createObject(memoryRef: String!, type: String!, fields: JSON!, key: String, name: String): JSON!

    # Merge fields into an existing object (server-side atomic shallow merge +
    # schema conformance on the result). 'ref' is the object id (or node URN);
    # 'fields' wins on key collision, unmentioned keys preserved. Returns the
    # updated flat object.
    updateObject(ref: ID!, fields: JSON!, reason: String): JSON!

    # Delete an object (soft by default; 'hard: true' removes the row). 'ref' is
    # the object id (or node URN). Returns true on success.
    deleteObject(ref: ID!, hard: Boolean): Boolean!

    # Bulk search-and-replace text across selected nodes (literal or regex).
    # Honors per-memory write auth, encryption, revision history, abstract
    # staleness, and re-embedding. Supports dryRun preview.
    searchReplaceInNodes(input: SearchReplaceInNodesInput!): SearchReplaceResult!

    # Delete a node identified by 'nodeRef' (a node ID or fully-qualified URN;
    # #542). Soft-delete by default (sets deletedAt; the node disappears from
    # reads, matching the hadron_delete_node MCP tool). Pass hard: true to
    # remove the row entirely (cascades edges + NodeRevision via FK) —
    # irreversible. #391. A re-delete of an already soft-deleted node is
    # idempotent (the ref resolves through the tombstone).
    #
    # If the node has descendants (nodes under its loc prefix), a plain delete
    # REFUSES with NODE_HAS_DESCENDANTS (carrying the count) rather than silently
    # orphaning the subtree — parity with the hadron_delete_node MCP tool. Pass
    # recursive: true to delete the node's whole loc-subtree — the node at its loc
    # PLUS every descendant, matched on ':' path boundaries (so deleting 'auth'
    # does not touch 'authoring'). The subtree lives in one memory, so the single
    # write-access check covers it; 'hard' applies to the whole subtree.
    #
    # A hard delete cascades edges on both endpoints via FK. If any affected node
    # is on an edge that bridges this memory to another, the hard delete REFUSES
    # with CROSS_MEMORY_EDGES (the caller may not own the other memory) unless
    # cascadeCrossMemoryEdges: true. A non-recursive soft re-delete of an already
    # soft-deleted node is an idempotent no-op that preserves its audit stamp.
    deleteNode(nodeRef: ID!, hard: Boolean, recursive: Boolean, cascadeCrossMemoryEdges: Boolean): Boolean!

    # Restore a node to a previous revision (#617).
    #
    # Default (truncate: false): snapshots the CURRENT node state into history
    # first, then restores the node's fields to the revision — non-destructive,
    # the restore itself becomes undoable.
    #
    # truncate: true: restores the node's fields to the revision AND deletes
    # every NodeRevision NEWER than the selected one (createdAt strictly greater),
    # WITHOUT creating a pre-restore snapshot. Boundary is EXCLUSIVE of the
    # selected row: the selected revision is KEPT and becomes the new baseline
    # (the most-recent snapshot afterward); its era and older survive. Restore +
    # truncate run in one transaction (atomic).
    restoreNodeRevision(revisionId: ID!, truncate: Boolean = false): Node!

    # Delete a single node-revision snapshot by id (#617). Auth: the node's memory
    # write access (as restoreNodeRevision). Throws NOT_FOUND for an unknown id.
    deleteNodeRevision(revisionId: ID!): Boolean!

    # Set or clear the user-facing label on a revision snapshot (#620,
    # NodeRevision.revLabel, 500-char cap). Omit revLabel to preserve; pass
    # null to clear. Auth: the node's memory write access (as
    # deleteNodeRevision) PLUS the nodeRevision query's read gates — it returns
    # the full snapshot, so a soft-deleted node or a snapshot captured in an
    # unreadable memory answers the same NOT_FOUND as an unknown id.
    updateNodeRevision(revisionId: ID!, revLabel: String): NodeRevision!

    # Delete ALL NodeRevision rows for a node, returning the count deleted (#617).
    # 'nodeRef' is the node's PK or fully-qualified URN. Auth: the node's memory
    # write access. An unknown ref throws NODE_NOT_FOUND. Reachable on a
    # soft-deleted node (purging residual history is a cleanup op).
    clearNodeHistory(nodeRef: ID!): Int!

    # Relocate a node (#564). 'sourceRef' is the node's PK or fully-qualified
    # URN. The destination is EITHER 'targetUrn' (the node's new full URN — new
    # memory and/or loc) OR 'targetMemoryRef' (a memory ID/URN; the node keeps
    # its current loc, only its memory changes) — supply exactly one. The node
    # keeps its id, so all incoming/outgoing edge references stay valid. Fails
    # loudly with NODE_ALREADY_EXISTS if a live node already occupies the
    # destination. Requires write access to both the source and destination
    # memories.
    moveNode(sourceRef: ID!, targetUrn: String, targetMemoryRef: ID): Node!

    # Clone a node to a new location, returning the NEW node with a fresh id
    # (#564). Same selector shape as moveNode ('sourceRef' + exactly one of
    # 'targetUrn' / 'targetMemoryRef'). Copies the source's own fields; outgoing
    # edges are copied only where they naturally resolve — a live node exists at
    # the target's loc in the destination memory. Incoming edges are not copied.
    # Fails loudly if the destination loc is already occupied. Requires read
    # access to the source memory and write access to the destination.
    cloneNode(sourceRef: ID!, targetUrn: String, targetMemoryRef: ID): Node!

    # Fold one node (source) into another (target), returning the updated
    # target. Per-field strategy: text fields (CONTENT/ABSTRACT/DESCRIPTION)
    # concatenate target-first; TAGS unions; DATA/PROPERTIES shallow-merge
    # with the target winning on key collisions; EDGES re-points the source's
    # relationships onto the target. 'include' selects which fields fold in
    # (omitted = all). 'deleteSource: true' hard-deletes the source afterward.
    # Honors per-memory write auth, encryption, revision history, abstract
    # staleness, and re-embedding (same invariants as createNode/updateNode).
    mergeNodes(input: MergeNodesInput!): Node!

    # Merge one memory (source) into another (target), returning the updated
    # target. Source nodes whose loc already exists in the target are folded
    # into their counterpart via the mergeNodes field strategy ('include'
    # selects which fields); source nodes with no counterpart move over with
    # their loc unchanged. Edges follow. The source memory ends up empty;
    # 'deleteSourceMem: true' then deletes it. v1 rejects encrypted source or
    # target memories and system/app classes.
    mergeMemories(input: MergeMemoriesInput!): Memory!

    # Replace all nodes owned by a repo within a memory (collection tool)
    replaceSubtree(ownerRepo: String!, memoryId: String!, nodes: [NodeInput!]!, edges: [EdgeInput!]!): Int!

    # Edge CRUD. Null-arg semantics (#263):
    # - condition/data: null on updateEdge CLEARS the stored value (the
    #   edge-conditions contract — a null condition means 'always fires').
    # - priority: null is treated as UNSET (createEdge falls back to the
    #   default 0; updateEdge keeps the stored value) — the column is a
    #   non-nullable Int, so null is never a meaningful value for it.
    # Clients that serialize unset args as explicit nulls must omit them
    # instead, or they will clear stored conditions/data on update.
    # #322/#542: sourceRef/targetRef each accept an ID-shape PK (preferred —
    # immutable, so the edge survives a later move/rename) OR a fully-qualified
    # node URN. Resolved via resolveNodeRef. edgeRef (update/delete) likewise
    # accepts an edge PK or a fully-qualified edge URN, resolved via
    # resolveEdgeRef (#542 Tier 2).
    createEdge(sourceRef: ID!, targetRef: ID!, name: String, loc: String, description: String, isRunnable: Boolean, condition: JSON, priority: Int, data: JSON): Edge!
    updateEdge(edgeRef: ID!, name: String, loc: String, description: String, isRunnable: Boolean, condition: JSON, priority: Int, data: JSON): Edge!
    deleteEdge(edgeRef: ID!): Boolean!

    # Run a task — a runnable node (isRunnable=true) — identified by a single
    # nodeRef (a node PK or a fully-qualified node URN, hrn:node:<root>:<memory>:<loc>),
    # resolved by the shared resolveNodeRef (#542). A bare loc without a memory
    # is rejected — pass a full URN or an ID. For loose-name matching and
    # interactive task selection use the MCP hadron_run_task tool, which
    # resolves to a concrete nodeRef before calling this.
    # By default RENDERS the task: returns the assembled instructions (node content
    # with {{arg}} substitution and referenced nodes) for an LLM agent to execute.
    # Pass appRef (App PK or URN) to EXECUTE instead (#529): the server mints a
    # MANUAL app run for the resolved task under that App and returns the run id
    # (poll appRun(ref:) for status + output). runAsSelf attributes the run to
    # the caller. Without appRef, behavior is unchanged.
    # Spec cor:api:060.
    runTask(nodeRef: String!, args: JSON, appRef: ID, runAsSelf: Boolean): String!

    """
    Import external content into a node (#457, sync v1). Source: exactly one
    of 'url' (server-fetched inline, SSRF-guarded, Readability-extracted,
    ~30s budget — the fetch carries NO user credentials, so authenticated
    pages must come as 'content') or 'content' (client-captured, e.g. the
    Web Clipper's authenticated DOM). Target: 'nodeUrn' XOR ('memoryId' +
    'loc'); an existing node is updated IN PLACE (NodeRevision snapshot is
    the undo), a missing one is created. HTML converts to Markdown at the
    write seam (contentType defaults to text/html here, unlike createNode).
    """
    importNode(input: ImportNodeInput!): ImportNodeResult!

    # Spec 040 — headless runs. Schedule CRUD is org-ADMIN-gated; a schedule
    # fires the launch gate (cor:acl:050) per due tick and mints an AppRun.
    createAgentSchedule(input: CreateAgentScheduleInput!): AgentSchedule!
    updateAgentSchedule(id: ID!, input: UpdateAgentScheduleInput!): AgentSchedule!
    deleteAgentSchedule(id: ID!): Boolean!
    "Run an entry node now (MANUAL trigger) — same launch gate + kernel as a schedule."
    triggerAppRun(input: TriggerAppRunInput!): AppRun!
    "The kill switch manual handle: PENDING/RUNNING to CANCELLED (cor:agt:010:02)."
    cancelAppRun(id: ID!): AppRun!

    "Create a webhook trigger — returns the URL path + platform token ONCE (D-2026-05-02)."
    createAgentWebhook(input: CreateAgentWebhookInput!): AgentWebhookCredentials!
    "New secret + token; the old URL dies immediately."
    rotateAgentWebhook(id: ID!): AgentWebhookCredentials!
    deleteAgentWebhook(id: ID!): Boolean!

    # Spec 042 Track B (#593) — user->App connection delegation. Owner-only.
    """
    Grant an App install scoped access to a connection you OWN. scopes must be a
    subset of {mail.read, mail.send, calendar.freebusy, calendar.read}; expiresAt
    (ISO-8601) is optional and must be in the future. appRef is a PK or App URN.
    """
    createConnectionGrant(connectionRef: String!, appRef: String!, scopes: [String!]!, expiresAt: String): ConnectionGrant!
    "Revoke a connection grant you created (soft delete). Owner-only."
    revokeConnectionGrant(ref: ID!): Boolean!
    "Grant a member extra management actions (org-ADMIN, interactive-only; design:grant-model). The grantee must be a live member of the org."
    createPrincipalGrant(orgRef: String!, userRef: String!, actions: [String!]!, expiresAt: String): PrincipalGrant!
    "Revoke an action grant (org-ADMIN, interactive-only; soft delete)."
    revokePrincipalGrant(ref: ID!): Boolean!
    "Mint comm.outbound tickets into the org ledger (org-ADMIN; cor:acl:050:04)."
    mintActionTickets(input: MintActionTicketsInput!): Int!
    "Set the stored (enforced) quota limit for a scope x action (#510) - the operator dial that previously required psql. Org-ADMIN."
    setQuotaLimit(input: SetQuotaLimitInput!): QuotaCounter!
    "Append an effective-dated provider rate row (spec 046). PLATFORM ADMIN - org admins must never set the prices they are billed at."
    setAiModelPrice(input: SetAiModelPriceInput!): AiModelPrice!
    "Mint credits for an org - a positive grant ledger row (spec 046). PLATFORM ADMIN ONLY (self-grant risk); processor top-ups land here later."
    grantCredits(input: GrantCreditsInput!): CreditLedgerEntry!
    "Author YOUR user-layer action-policy link (cor:acl:040:02, #510). Null clears (= no restriction)."
    updateMyPolicy(policy: JSON): User!

    # Asset upload — v1 (spec 004)
    beginAssetUpload(input: BeginAssetUploadInput!): BeginAssetUploadResult!
    completeAssetUpload(input: CompleteAssetUploadInput!): Asset!
    setAgentAssetUploadEnabled(input: SetAgentAssetUploadEnabledInput!): App!
    softDeleteAsset(assetId: ID!): Asset!
    restoreAsset(assetId: ID!): Asset!

    # Asset upload — v2 (spec 006-asset-upload-redesign)
    # Memory-addressed begin: the caller specifies the destination
    # memory directly, no agent traversal. Replaces agent-addressed
    # beginAssetUpload during the deprecation window.
    beginAssetUploadV2(input: BeginAssetUploadV2Input!): BeginAssetUploadResult!
    createAssetReferenceNode(input: CreateAssetReferenceNodeInput!): Node!

    # Session lifecycle
    startSession(input: SessionInput!): Session!
    """
    #931: update a live session's mutable provenance fields (a PR is usually
    opened after startSession already ran). Explicit null clears; omitted
    preserves; an empty update is a valid liveness touch (bumps updatedAt,
    which the #930 inactivity reaper counts). id-only - sessions have no URN.
    Gate: platform admin, the session's App, or the attributed user (not via
    impersonation). Updates on an ended session stay allowed (late PR-merge
    attribution).
    """
    updateSession(id: ID!, prNumber: Int, branch: String): Session!

    """
    End a session, and — for a worker-bound one — write its closing handoff
    (#1029).

    Gate (#931): platform admin, the session's App, or the attributed user
    (not via impersonation).

    \`handoff\` is agent-composed prose: what landed, what is open, what is
    blocked, what the next driver should not repeat. The server owns where it
    goes (the worker's working memory, under the \`handoffs\` parent, at a
    lexically-ordered loc), so no client re-derives the convention.

    Written BEFORE the session ends, and a failed write REFUSES the end
    (HANDOFF_WRITE_FAILED) rather than ending anyway: a still-bound worker is
    recoverable — retry, or end without a handoff deliberately — while an ended
    session whose handoff evaporated is not, because the context that composed
    it is gone. Passing \`handoff\` on a session with no worker is refused rather
    than dropped; there is no sequence to write it to.
    """
    endSession(id: ID!, summary: String, handoff: String, inputTokens: Int, outputTokens: Int, turnCount: Int, errorCount: Int): Session!

    # Record a usage event
    recordUsage(event: UsageEventInput!): Boolean!

    """
    App key management — revoke all active keys for an App and mint a
    fresh one. (See createAppKey / revokeAppKey / deleteApp below.)

    Accepts the entity's ID or URN.
    """
    regenerateAppKey(appRef: ID!): AppCreated!

    # User management
    updateMyProfile(name: String, handle: String, email: String): User!
    updateUserRoles(userId: ID!, roles: [Role!]!): User!
    # Consolidate a duplicate account into a surviving user. Source-only
    # identities and relationships move; duplicate role-bearing relationships
    # preserve the strongest live entitlement. The source is soft-deleted.
    # Platform admin, or an org admin/owner when both users are live members
    # of an organization they administer. The resulting merge is global.
    mergeUsers(input: MergeUsersInput!): User!

    """
    Delete a user account (self-serve account deletion, Apple 5.1.1(v) /
    GDPR erasure posture). Requires a user credential (JWT or hdr_user key);
    App-key callers are rejected.

    Omitting userRef deletes the CALLER's own account (no role needed).
    A platform ADMIN/OWNER may name another user; userRef accepts the
    user's ID, handle, or hrn:user:<handle> URN. Any other caller naming a
    target receives the same FORBIDDEN error whether or not that user
    exists (no user-enumeration oracle).

    Org memberships auto-resolve: an org where the target is the only
    active OWNER but which still has OTHER active members BLOCKS deletion
    (error code SOLE_ORG_OWNER, extensions.organizations lists the
    blockers - transfer ownership first, nothing is deleted); an org where
    the target is the ONLY active member is soft-deleted with the account;
    plain memberships are revoked.

    Owned data is hard-erased: personal/private and user-owned memories,
    user-owned Apps and Agents (with their standard delete cascades),
    sessions, OAuth/handoff codes, provider connections, grants, shares,
    subscriptions, widgets and user secrets; API keys are revoked. The
    User row itself is kept for audit/billing FK integrity but scrubbed
    (identity fields nulled, handle replaced with a random deleted-...
    value) and soft-deleted; a deleted account can no longer authenticate.
    """
    deleteUser(userRef: ID): Boolean!

    # Organization management
    createOrganization(name: String!, urn: String!): Organization!

    """
    Update an Organization.

    Accepts the entity's ID or URN.
    """
    updateOrganization(id: ID!, name: String, urn: String, listedOnMarketplace: Boolean, policy: JSON): Organization!

    """
    Soft-delete an Organization.

    Accepts the entity's ID or URN.
    """
    deleteOrganization(id: ID!): Boolean!

    """
    Link a GitHub App installation to an organization (org ADMIN or platform ADMIN).

    Accepts the entity's ID or URN.
    """
    linkGithubApp(orgId: ID!, installationId: Int!): Organization!

    """
    Set GitHub App credentials for an organization (encrypted at rest).

    Accepts the entity's ID or URN.
    """
    updateOrgGithubApp(orgId: ID!, appId: String!, privateKey: String!): Organization!

    """
    Remove all GitHub App config from an organization.

    Accepts the entity's ID or URN.
    """
    unlinkGithubApp(orgId: ID!): Organization!

    """
    User invitations (org ADMIN or platform ADMIN).

    Accepts the entity's ID or URN.
    """
    createUserInvitation(orgId: ID!, memberRole: Role!, name: String, email: String, githubUsername: String, maxActivations: Int, expiresInDays: Int): UserInvitation!
    # Platform invite — no org association, just onboards a new user
    inviteUser(name: String, email: String, githubUsername: String, maxActivations: Int, expiresInDays: Int): UserInvitation!
    acceptInvitation(slug: String!): Boolean!

    # Organization membership (platform ADMIN or org OWNER/ADMIN).
    # orgId accepts the entity's ID or URN. userId is keyed by raw ID only —
    # User has no urn column.
    """Accepts the entity's ID or URN (orgId)."""
    addOrgMember(
      "#764 — the organization as an id / slug / hrn:org:<slug> URN. Supply this OR orgId."
      orgRef: String
      orgId: ID @deprecated(reason: "Use orgRef (accepts id / slug / URN).")
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
      role: Role!
    ): OrgMember!
    """Accepts the entity's ID or URN (orgId)."""
    updateOrgMember(
      "#764 — the organization as an id / slug / hrn:org:<slug> URN. Supply this OR orgId."
      orgRef: String
      orgId: ID @deprecated(reason: "Use orgRef (accepts id / slug / URN).")
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
      role: Role!
    ): OrgMember!
    """Accepts the entity's ID or URN (orgId)."""
    removeOrgMember(
      "#764 — the organization as an id / slug / hrn:org:<slug> URN. Supply this OR orgId."
      orgRef: String
      orgId: ID @deprecated(reason: "Use orgRef (accepts id / slug / URN).")
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
    ): Boolean!

    # Memory management (org ADMIN)
    """
    Create a memory in an organization. Accepts the entity's ID or URN
    for orgId.

    Defaults to knowledge-class with ORGANIZATION visibility. Pass
    memoryClass: group + visibility: GROUP for a group-class memory
    (023-app-shape US4; the caller is auto-added as the first owner),
    or memoryClass: personal | private for an owner-only memory the
    caller owns (spec 034 — free-standing, no app/agent; the caller
    must be a member of the org container). system- and app-class
    memories are NOT created here — they auto-provision via
    Agent.systemMemoryId / the App install path.
    """
    createMemory(
      """
      Owning organization. OPTIONAL (spec 047 — user-owned tenancy): when
      OMITTED, the memory is owned by the authenticated caller in their own
      handle namespace (organizationId NULL, ownerUserId = caller), and its URN
      roots on the caller's handle (hrn:mem:<handle>:<slug>) rather than an org
      domain. The org-less path supports only the owner-only classes 'personal'
      and 'private'; pass orgId for 'knowledge' / 'group'.
      """
      orgId: ID
      name: String!
      shortDescription: String
      description: String
      """Free-form structured metadata bag (client-defined JSON). Null = unset."""
      data: JSON
      tags: [String!]
      license: String
      category0: String
      category1: String
      category2: String
      iconUrl: String
      heroUrl: String
      homeUrl: String
      source: String
      readBranch: String
      writeBranch: String
      visibility: MemoryVisibility
      """
      'knowledge' (default), 'group', or the owner-only 'personal' /
      'private' (spec 034). 'system' and 'app' are rejected — they
      auto-provision via different code paths.
      """
      memoryClass: MemoryClass
      """
      Override the vector-index defaults. A 'knowledge'-class memory defaults
      to vectorIndexEnabled=true with embeddingSource=contentChunks (so any
      node with content is retrievable immediately, no abstract authoring
      needed — #281); every other class keeps the column defaults
      (false / abstract). An explicit value here wins for any class.
      """
      vectorIndexEnabled: Boolean
      embeddingSource: EmbeddingSource
      """#621 — per-node revision-history cap (default 10, minimum 1)."""
      maxRevCount: Int
    ): Memory!

    """
    Add a NEW memory to an App, born App-scoped.

    Unlike createMemory (which only makes free-standing memories), this scopes
    the new memory to an App. memoryClass accepts only the App-associable
    classes: 'app', 'personal', or 'private' ('system'/'knowledge'/'group'
    forbid an app_id). appRef/agentRef accept an ID, bare URN, or prefixed URN;
    the Agent must be installed in the App.

    Authorization is split by class: 'app' is shared deployment data and
    requires org OWNER/ADMIN; 'personal'/'private' are the caller's OWN memory
    and require only App membership (the caller becomes the owner).

    Typed errors: UNSUPPORTED_MEMORY_CLASS, BAD_USER_INPUT (maxRevCount < 1),
    APP_UNINSTALLED, AGENT_NOT_INSTALLED, MEMORY_URN_CONFLICT, FORBIDDEN,
    UNAUTHENTICATED.
    """
    createMemoryInApp(
      appRef: ID!
      agentRef: ID!
      memoryClass: MemoryClass!
      name: String!
      shortDescription: String
      description: String
      data: JSON
      tags: [String!]
      vectorIndexEnabled: Boolean
      embeddingSource: EmbeddingSource
      maxRevCount: Int
    ): Memory!

    """
    Attach an EXISTING free-standing memory to an App.

    Applies only to 'personal'/'private' memories owned by the caller (an
    'app'-class memory can't be free-standing, so there is nothing to attach).
    Sets the App and Agent scope; the memory's URN, class, and owner are
    unchanged. memoryRef/appRef/agentRef accept an ID, bare URN, or prefixed
    URN; the Agent must be installed in the App. Requires App membership.

    Typed errors: UNSUPPORTED_MEMORY_CLASS, MEMORY_ALREADY_APP_SCOPED,
    APP_UNINSTALLED, AGENT_NOT_INSTALLED, FORBIDDEN, ORGANIZATION_MISMATCH.
    """
    attachMemoryToApp(memoryRef: ID!, appRef: ID!, agentRef: ID!): Memory!

    """
    Update a Memory.

    Accepts the entity's ID or URN.

    Spec 033 FR-026: enabling \`vectorIndexEnabled\` on an \`isEncrypted\` memory
    requires \`acknowledgeVectorInversionRisk: true\` in the same call. Without
    the flag, an \`EncryptedVectorIndexNotAcknowledgedError\` is thrown carrying
    the full four-point disclosure on \`error.disclosure\` (single source of
    truth in \`FR_026_DISCLOSURE\` — see \`src/lib/entityRef/errors.ts\`). On a
    non-encrypted memory the flag is a no-op.
    """
    updateMemory(id: ID!, name: String, urn: String, organizationId: ID, shortDescription: String, description: String, data: JSON, tags: [String!], license: String, category0: String, category1: String, category2: String, iconUrl: String, heroUrl: String, homeUrl: String, source: String, readBranch: String, writeBranch: String, visibility: MemoryVisibility, listedOnMarketplace: Boolean, vectorIndexEnabled: Boolean, embeddingSource: EmbeddingSource, acknowledgeVectorInversionRisk: Boolean, chunkTokens: Int, chunkOverlap: Int, forceFixedSize: Boolean, maxRevCount: Int, schema: JSON): Memory!

    """
    #882 — re-drive every FAILED embed in a memory (the operator recovery
    surface; previously hand-written SQL). Re-stamps each live node whose
    \`embeddingFailedAt\` is set — permanent-class failures whose pending
    marker was cleared, and backed-off retryable failures (made immediately
    eligible) — resetting the failure state exactly like a fresh write, then
    wakes the embedding worker. Returns the count re-stamped; 0 when the
    memory is not vector-indexed. \`memoryRef\` accepts the memory's ID or
    URN. Requires memory-owner or org-ADMIN (same gate as updateMemory).
    """
    retryFailedEmbeddings(memoryRef: ID!): Int!

    """
    Soft-delete a Memory.

    Accepts the entity's ID or URN.
    """
    deleteMemory(id: ID!): Boolean!

    """
    Clone a Memory into a new Memory at \`targetUrn\`.

    \`ref\` accepts the source's ID or URN. \`targetUrn\` is a fully-qualified
    "root:slug" memory URN naming the clone; its org segment MAY differ from
    the source's, cloning the memory into another organization. The clone's
    display name is derived from the target slug.

    Copies the Memory row plus all live Nodes, Edges, and PendingEdges;
    references to the source memory's URN inside node content/abstract
    (canonical and legacy spellings) are rewritten to the clone's URN.
    Vector-index config carries over and the clone's nodes are stamped for
    re-embedding.

    NOT copied: revision history, subscriptions, shares, group members
    (the caller is bootstrapped as a group clone's first owner), sessions,
    licenses, log entries, assets, and git-sync config (the clone starts
    DB-only).

    Authorization: the SOURCE side mirrors deleteMemory (personal/private →
    owner only; knowledge/group → source-org ADMIN). When \`targetUrn\` names a
    DIFFERENT org, the caller must additionally be a non-reader member of that
    target org. system/app-class sources and encrypted memories are rejected.
    """
    cloneMemory(ref: ID!, targetUrn: String!): Memory!

    """
    Extract a parent node and its whole loc-subtree into a BRAND-NEW memory,
    making the parent the new memory's root.

    The subtree is loc-prefix defined: the node at the parent's loc plus every
    live descendant (loc starting with 'parentLoc:'). Locs are REBASED so the
    parent becomes the root — 'findings:auth' becomes the memory slug and
    'findings:auth:oauth' becomes '<slug>:oauth'. Edges wholly inside the
    subtree carry over (their loc re-derived from the rebased endpoints);
    boundary-crossing edges and PendingEdges are dropped.

    'parentRef' is the parent node's ID or fully-qualified URN. 'targetUrn' is
    a fully-qualified '<root>:<slug>' URN naming the new memory (it may land in
    a DIFFERENT org). 'move' = false (default) COPIES the subtree, leaving the
    source intact; 'move' = true relocates it, soft-deleting the source subtree
    (its nodes, the source memory's touching edges, and its pending edges).

    The new memory PRESERVES the source's class so an extract never widens who
    can read the content: a member-restricted 'group' stays group, a
    personal/private source stays owner-owned, knowledge stays knowledge.
    Governance/config (requiresLicense, chunk dials, revision cap, acceptsUploads)
    carries over from the source.

    Authorization: read access to the source memory (denial reads as
    NODE_NOT_FOUND). For knowledge/group sources the caller needs the SOURCE
    org's memory.clone grant (an export) AND the destination org's memory.create
    (plus a non-reader membership for a cross-org drop); a personal/private
    extract instead requires the owner to be a member of the destination org.
    'move' additionally requires source write access, and cannot target the
    source root (that would empty the source — clone + deleteMemory instead).
    Encrypted and system/app-class sources are rejected.

    v1 limitation: node content is copied verbatim — because both the slug and
    node locs change, URN references among the moved nodes WILL break; and
    unresolved PendingEdges within the subtree are dropped.
    """
    extractParentNodeToMemory(parentRef: ID!, targetUrn: String!, move: Boolean = false): Memory!

    """
    Set encrypted source token for non-GitHub-App repos.

    Accepts the entity's ID or URN.
    """
    setMemorySourceToken(id: ID!, token: String!, expiresAt: String): Memory!

    # Agent management
    """
    Create an agent. Provide orgId to create an ORG-owned agent (requires org
    ADMIN); OMIT orgId to create a USER-OWNED agent owned by the caller — its
    URN is rooted on the caller's bare handle (hrn:agent:<handle>:<slug>, grammar
    v2 — no @ sigil) and its system memory is user-owned too. Exactly one owner
    (org XOR user).

    personaRole / personaPrompt are the persona dressing (cor:agt:020:01) —
    the reusable role plus the '{{name}}'-templated identity prompt. The NAMED
    identity is a Worker, cast with castWorker; names never live on agents.

    orgId accepts the org's ID or URN.
    """
    createAgent(orgId: ID, name: String!, description: String, systemPrompt: String, systemMemoryId: String, visibility: AgentVisibility, type: AgentType, surfaces: [String!], personaRole: String, personaPrompt: String): Agent!

    """
    Update an Agent.

    urn renames the slug (org-owned agents only). personaRole / personaPrompt
    are the persona dressing (cor:agt:020:01); explicit null or blank clears,
    omitted preserves. Worker castings referencing this agent are unaffected —
    the named identity lives on the Worker.

    Accepts the entity's ID or URN.
    """
    updateAgent(ref: ID!, name: String, urn: String, description: String, systemPrompt: String, systemMemoryId: String, visibility: AgentVisibility, listedOnMarketplace: Boolean, type: AgentType, surfaces: [String!], personaRole: String, personaPrompt: String): Agent!

    """
    Soft-delete an Agent.

    Accepts the entity's ID or URN.
    """
    deleteAgent(ref: ID!): Boolean!

    """
    #949 — re-own an Agent's class=system memory to the Agent's own owner
    (org XOR user) and re-derive its URN as '<agent-urn>-system'.

    The recovery path for a system memory that ended up owned by a different
    tenant. Access to a memory follows the MEMORY's owner, so such a row puts
    one tenant's Agent design (for a Team Agent: its 'roles:<role>'
    definitions and name registers) inside another tenant's audience. System
    memories are only ever created by Agent provisioning, so before this the
    only fix was to recreate the Agent.

    Authorization: PLATFORM ADMIN only — the row being moved belongs to a
    different tenant than the Agent, so neither side's org admin is the right
    authority. Idempotent: an already-consistent pair is a no-op.

    Error codes (extensions.code): FORBIDDEN, AGENT_HAS_NO_SYSTEM_MEMORY,
    SYSTEM_MEMORY_NOT_FOUND.

    Accepts the entity's ID or URN.
    """
    repairAgentSystemMemory(agentRef: ID!): Agent!

    """
    Attach a Memory to an Agent.

    Accepts the entity's ID or URN.
    """
    addMemoryToAgent(agentRef: ID!, memoryRef: ID!, role: String): Agent!

    """
    Update an Agent's role on an attached Memory.

    Accepts the entity's ID or URN.
    """
    updateAgentMemoryRole(agentRef: ID!, memoryRef: ID!, role: String!): Agent!

    """
    Detach a Memory from an Agent.

    Accepts the entity's ID or URN.
    """
    removeMemoryFromAgent(agentRef: ID!, memoryRef: ID!): Agent!

    # Memory subscriptions (cross-org)
    """
    Create a cross-org Memory subscription.

    Accepts the entity's ID or URN.
    """
    createMemorySubscription(
      "#764 — the memory as an id or URN. Supply this OR memoryId."
      memoryRef: String
      memoryId: ID @deprecated(reason: "Use memoryRef (accepts id / URN).")
      "#764 — the organization as an id / slug / hrn:org:<slug> URN. Supply this OR orgId."
      orgRef: String
      orgId: ID @deprecated(reason: "Use orgRef (accepts id / slug / URN).")
      role: Role!
    ): MemorySubscription!

    """
    Subscribe an organization to a PUBLIC Agent without creating an App.

    Accepts the entity's ID or URN.
    """
    createAgentOrgGrant(agentRef: ID!, orgRef: ID!): AgentOrgGrant!

    """
    Revoke an organization's Agent subscription without deleting install state.

    Accepts the entity's ID or URN.
    """
    revokeAgentOrgGrant(agentRef: ID!, orgRef: ID!): AgentOrgGrant!

    """
    Update a cross-org Memory subscription.

    Accepts the entity's ID or URN.
    """
    updateMemorySubscription(
      "#764 — the memory as an id or URN. Supply this OR memoryId."
      memoryRef: String
      memoryId: ID @deprecated(reason: "Use memoryRef (accepts id / URN).")
      "#764 — the organization as an id / slug / hrn:org:<slug> URN. Supply this OR orgId."
      orgRef: String
      orgId: ID @deprecated(reason: "Use orgRef (accepts id / slug / URN).")
      role: Role!
    ): MemorySubscription!

    """
    Delete a cross-org Memory subscription.

    Accepts the entity's ID or URN.
    """
    deleteMemorySubscription(
      "#764 — the memory as an id or URN. Supply this OR memoryId."
      memoryRef: String
      memoryId: ID @deprecated(reason: "Use memoryRef (accepts id / URN).")
      "#764 — the organization as an id / slug / hrn:org:<slug> URN. Supply this OR orgId."
      orgRef: String
      orgId: ID @deprecated(reason: "Use orgRef (accepts id / slug / URN).")
    ): Boolean!

    """
    Trigger an on-demand sync for one memory (org ADMIN or CONTRIBUTOR).

    Accepts the entity's ID or URN.
    """
    syncMemory(id: ID!): Memory!

    """
    Push all nodes in a memory to its configured git repo.

    Accepts the entity's ID or URN.
    """
    pushMemoryToGit(id: ID!): Boolean!

    # Exchange integration (connection created via OAuth at /auth/microsoft)
    deleteExchangeConnection(id: ID!): Boolean!
    testExchangeConnection(id: ID!): Boolean!

    """
    Register a Slack workspace install (spec 043). orgRef/appRef accept ID
    or URN (cor:api:140); the App must belong to the org. Both tokens are
    validated live by the tool and stored encrypted THERE — core keeps
    identity only, and no field ever returns a token. Requires org
    ADMIN/OWNER.
    """
    createSlackConnection(orgRef: ID!, appRef: ID!, botToken: String!, appToken: String!): SlackConnection!
    "Soft-delete a Slack connection (org ADMIN/OWNER); tears down the tool side best-effort."
    deleteSlackConnection(ref: ID!): Boolean!

    """
    Register an external MCP server (org ADMIN/OWNER). orgRef accepts ID
    or URN (cor:api:140). headers is a JSON object of static request
    headers (e.g. Authorization) — encrypted at rest, write-only, never
    returned. Registration grants nothing by itself: runs still need the
    policy chain to allow tool.mcp__<slug>__<tool>.
    """
    createMcpServer(
      orgRef: ID!
      slug: String!
      name: String!
      url: String!
      headers: JSON
      toolAllowlist: [String!]
      enabled: Boolean
    ): McpServer!

    """
    Update a registered MCP server (org ADMIN/OWNER). The slug is
    immutable — flow nodes reference it in data.tools names. headers
    REPLACES the stored object; clearHeaders: true removes it (pass one
    or the other, not both).
    """
    updateMcpServer(
      ref: ID!
      name: String
      url: String
      headers: JSON
      clearHeaders: Boolean
      toolAllowlist: [String!]
      enabled: Boolean
    ): McpServer!

    "Hard-delete a registered MCP server (org ADMIN/OWNER); runs referencing its tools fail loud afterwards."
    deleteMcpServer(ref: ID!): Boolean!

    """
    Create a named, owner-scoped secret (#677). Gate per owner scope:
    user -> that user (ownerRef optional, defaults to the caller); org ->
    org ADMIN; app -> app owner / org ADMIN; memory -> memory WRITE.
    value is the secret payload — encrypted at rest, write-only, never
    returned. kind selects validation: generic (opaque JSON) or
    webfetch-auth ({type: bearer|basic|header, ...} + metadata.urlPrefix
    origin binding). A run resolves the name via the CSS cascade
    (memory -> app -> user -> org) at entitled scopes only.
    """
    createSecret(
      ownerType: String!
      ownerRef: ID
      name: String!
      kind: String!
      metadata: JSON
      value: JSON!
    ): Secret!

    """
    Overwrite a secret's value and/or metadata (v1 rotation — no
    versioning). Name, kind, and owner are immutable — the cascade and
    flow config reference the name; create a new name instead. The
    effective (metadata, value) pair is re-validated per kind.
    """
    updateSecret(ref: ID!, metadata: JSON, value: JSON): Secret!

    "Hard-delete a secret; referencing runs fail their resolution loud (or fall through the cascade) afterwards."
    deleteSecret(ref: ID!): Boolean!

    """
    Register a Home Assistant instance (org ADMIN/OWNER). orgRef accepts
    ID or URN (cor:api:140). accessToken is an HA long-lived access token
    — encrypted at rest, write-only, never returned. Registration grants
    nothing by itself: runs still need the policy chain to allow
    tool.ha__<slug>__<op>.
    """
    createHomeAssistantInstance(
      orgRef: ID!
      slug: String!
      name: String!
      url: String!
      accessToken: String!
      opAllowlist: [String!]
      enabled: Boolean
    ): HomeAssistantInstance!

    """
    Update a registered Home Assistant instance (org ADMIN/OWNER). The
    slug is immutable — flow nodes reference it in data.tools names.
    accessToken REPLACES the stored token (never cleared: an instance
    without a token is unusable).
    """
    updateHomeAssistantInstance(
      ref: ID!
      name: String
      url: String
      accessToken: String
      opAllowlist: [String!]
      enabled: Boolean
    ): HomeAssistantInstance!

    "Hard-delete a registered Home Assistant instance (org ADMIN/OWNER); runs referencing its ops fail loud afterwards."
    deleteHomeAssistantInstance(ref: ID!): Boolean!

    "Register one BYO Resend sender for an org. The API key is encrypted and never returned."
    createResendSender(orgRef: ID!, from: String!, apiKey: String!, enabled: Boolean): ResendSender!

    "Update the fixed sender, replace its write-only API key, or enable/disable it."
    updateResendSender(ref: ID!, from: String, apiKey: String, enabled: Boolean): ResendSender!

    "Hard-delete an org's BYO Resend sender."
    deleteResendSender(ref: ID!): Boolean!
    exchangeReply(connectionId: ID!, messageId: ID!, body: String!): Boolean!
    exchangeMoveMessage(connectionId: ID!, messageId: ID!, folderId: String!): Boolean!

    """
    Save a draft in the mailbox's own Drafts folder (spec 002 US5): either a
    reply-draft (replyToMessageId) or a fresh draft (to + subject). Owner-only.
    idempotencyKey makes retries safe (at-least-once callers).
    """
    emailSaveDraft(
      connectionRef: ID!
      replyToMessageId: ID
      to: [String!]
      subject: String
      bodyHtml: String!
      idempotencyKey: String
    ): EmailDraftInfo!

    "Update a provider-side draft's body. Owner-only."
    emailUpdateDraft(connectionRef: ID!, draftId: ID!, bodyHtml: String!): Boolean!

    "Send a provider-side draft. Owner-only; idempotencyKey makes retries safe."
    emailSendDraft(connectionRef: ID!, draftId: ID!, idempotencyKey: String): Boolean!

    "Delete a message (provider trash semantics). Owner-only."
    emailDeleteMessage(connectionRef: ID!, messageId: ID!): Boolean!

    "Mark a message read or unread (default read). Owner-only."
    emailMarkRead(connectionRef: ID!, messageId: ID!, isRead: Boolean): Boolean!

    "Flag, unflag, or complete a message (default FLAGGED). Owner-only."
    emailFlagMessage(connectionRef: ID!, messageId: ID!, flag: EmailFlag): Boolean!

    "Set the categories (color labels) on a message. Owner-only."
    emailCategorizeMessage(connectionRef: ID!, messageId: ID!, categories: [String!]!): Boolean!

    # ── Calendar mutations (hadrontool-google-cal) ─────────────────────
    # All owner-only in v1 (no grant scope maps to calendar mutations —
    # fail-closed for App/headless callers). idempotencyKey rides through
    # to the tool's reservation-based replay (at-least-once callers).
    # notifyAttendees (default true) controls invitation/update emails.

    "Create an event. calendarId defaults to the primary calendar. Owner-only."
    calendarCreateEvent(
      connectionRef: ID!
      calendarId: String
      title: String!
      description: String
      location: String
      start: CalendarEventTimeInput!
      end: CalendarEventTimeInput!
      "Attendee email addresses."
      attendees: [String!]
      notifyAttendees: Boolean
      idempotencyKey: String
    ): CalendarEvent!

    "Patch an event — absent fields stay unchanged; attendees replaces the set. Owner-only."
    calendarUpdateEvent(
      connectionRef: ID!
      eventId: ID!
      calendarId: String
      title: String
      description: String
      location: String
      start: CalendarEventTimeInput
      end: CalendarEventTimeInput
      attendees: [String!]
      notifyAttendees: Boolean
      idempotencyKey: String
    ): CalendarEvent!

    "Delete (cancel) an event. Owner-only."
    calendarDeleteEvent(
      connectionRef: ID!
      eventId: ID!
      calendarId: String
      notifyAttendees: Boolean
      idempotencyKey: String
    ): Boolean!

    """
    Set the connected account's own RSVP on an event it was invited to
    (ACCEPTED / DECLINED / TENTATIVE — NONE is not a settable response).
    Owner-only.
    """
    calendarRespondToEvent(
      connectionRef: ID!
      eventId: ID!
      response: CalendarEventResponse!
      calendarId: String
    ): CalendarEvent!

    # ── Drive mutations (hadrontool-google-drive, #749) ────────────────

    """
    Export a node's markdown as a NEW Google Doc in the connected drive
    (nodeRef is a PK or fully-qualified URN; title defaults to the node
    name; folderId defaults to the drive root). Always creates — the drive
    tool's scope cannot edit existing files, and no update surface exists.
    Owner-only: no grant scope maps to doc creation (fail-closed for
    App/headless callers).
    """
    exportNodeToGoogleDoc(
      nodeRef: ID!
      connectionRef: ID!
      folderId: ID
      title: String
    ): DriveFile!

    # ── Chat API ──────────────────────────────────────────────────────
    """
    Start a chat session (creates chat nodes, loads conversation, returns
    compiled prompt). When called by a JWT user, the chat is created in
    that user's personal memory for the agent (provisioned lazily if
    needed).

    Accepts the entity's ID or URN.
    """
    # 017: scope defaults to private (FR-003). A shared request
    # requires a JWT user with an AppMember row in some App that
    # installs this Agent (FR-006 + research.md Q-R2). Otherwise:
    #   - MCP App-key session → SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS
    #   - JWT user without a qualifying AppMember row, or no auth →
    #     SHARED_CHAT_REQUIRES_APP_CONTEXT
    #
    # 019: isTestRun suppresses the AgentSubscription auto-provision
    # side-effect for chats started by the spec-019 Tester. Default
    # false; the tester portal endpoint passes true. The chat still
    # creates real chat-root / message rows in memory — full
    # production-state isolation is deferred to a separate spec
    # (see STUBBED-tester-vs-production-memory-boundary). This single
    # gate prevents the cross-cutting AgentSubscription side-effect
    # from leaking from a chatbot-feature concern into the platform's
    # license-grant model (narrowed in 2026-05-12-user-installing-app).
    startChat(agentId: ID!, userId: String, conversationName: String, scope: ChatScope = private, isTestRun: Boolean = false): ChatStartResult!
    # Process a user message (saves message, builds context, returns next prompt)
    sendChatMessage(chatId: String!, userMessage: String!): ChatPromptResult!
    # Process the LLM's tool response (extract data, transition stage, save assistant message)
    processChatResponse(chatId: String!, toolResponse: JSON!): ChatResponseResult!
    # Save a chat summary
    saveChatSummary(chatId: String!, summary: String!): Boolean!
    # Rename a saved chat (user must own it)
    updateChatTitle(chatId: String!, title: String!): Boolean!
    # Soft-delete a saved chat and all its messages
    deleteChat(chatId: String!): Boolean!

    # Agent AI config (org ADMIN). Key is encrypted at rest.
    """
    Update an Agent's AI provider config. Key is encrypted at rest.

    036-ai-service-config: upserts the Agent's registry config named
    'default'. Prefer createAiServiceConfig/updateAiServiceConfig for
    new callers.

    Accepts the entity's ID or URN.
    """
    updateAgentAIConfig(agentId: ID!, provider: String!, model: String!, apiKey: String): Agent!

    """
    Clear an Agent's AI provider config.

    036-ai-service-config: deletes the Agent's registry config named
    'default'.

    Accepts the entity's ID or URN.
    """
    clearAgentAIConfig(agentId: ID!): Agent!

    """
    036-ai-service-config: create a named AI config on an owner entity.

    apiKey semantics: omitted = stored without a key (unusable for
    execution until one is set); non-empty = encrypted at rest with a
    masked preview. Name must be 1-64 lower-case [a-z0-9_-], unique per
    owner. provider must be a known provider; params are validated per
    provider.

    Auth: as aiServiceConfigs. ownerId accepts ID or URN
    (HADRON_SERVER: ID only).
    """
    createAiServiceConfig(
      ownerType: AiConfigOwnerType!
      ownerId: ID!
      name: String!
      provider: String!
      model: String!
      apiKey: String
      params: JSON
      enabled: Boolean
    ): AiServiceConfig!

    """
    036-ai-service-config: update a named AI config. All fields optional.

    apiKey semantics: omitted = keep the stored key; empty string =
    clear it; non-empty = replace (encrypted, preview recomputed).

    Auth: admin rights on the owning entity (as aiServiceConfigs).
    """
    updateAiServiceConfig(
      id: ID!
      name: String
      provider: String
      model: String
      apiKey: String
      params: JSON
      enabled: Boolean
    ): AiServiceConfig!

    """
    036-ai-service-config: delete a named AI config (hard delete; the
    resolution walk simply no longer finds it).

    Auth: admin rights on the owning entity (as aiServiceConfigs).
    """
    deleteAiServiceConfig(id: ID!): Boolean!

    # Chatbot revisions (org ADMIN)
    """
    Snapshot an Agent's system memory as a new revision.

    Accepts the entity's ID or URN.
    """
    createRevision(agentId: ID!, description: String): RevisionResult!

    """
    Publish a revision and pin the Agent to it.

    Accepts the entity's ID or URN.
    """
    publishRevision(agentId: ID!, revisionLoc: String!, versionLabel: String): RevisionResult!

    """
    Restore an Agent's system memory from a revision (auto-saves first).

    Accepts the entity's ID or URN.
    """
    restoreRevision(agentId: ID!, revisionLoc: String!): RevisionResult!

    # Editor lock (org ADMIN)
    """
    Acquire (or renew) the editor lock for an Agent's system memory.

    Accepts the entity's ID or URN.
    """
    acquireEditorLock(agentId: ID!): EditorLockResult!

    """
    Release the editor lock for an Agent's system memory.

    Accepts the entity's ID or URN.
    """
    releaseEditorLock(agentId: ID!): Boolean!

    # Public mutations (no auth required)
    joinWaitingList(email: String!, requestedFeatures: String): Boolean!
    sendContactMessage(name: String!, email: String!, message: String!): Boolean!

    # ── Apps and multi-user-agent sessions ────────────────────────────

    # App management (org ADMIN) — the unified caller-identity entity per
    # Constitution Invariant #6.
    """
    Install an Agent into an organization, creating an App that deploys it.

    Auto-provisions an AgentOrgGrant for (orgId, agentId) on first install,
    and adds the caller as an AppMember with role 'owner'. Required
    AgentImports cascade automatically; optional imports cascade only when
    their id appears in installOptional.

    009-install-agent-flow: the cross-org install restriction (FR-009) is
    enforced at the portal — the Install affordance is hidden for Agents
    not owned by the calling org. The server still auto-provisions grants
    on first install (preserved from 008); a hard server-side cross-org
    gate is reserved for the marketplace spec.

    Accepts the entity's ID or URN.
    """
    createApp(
      """
      Provide to create an ORG-owned App (requires org ADMIN). OMIT to create a
      USER-OWNED App owned by the caller — rooted on the caller's bare handle
      (hrn:app:<handle>:<slug>, grammar v2 — no @ sigil), owner-only. Accepts the
      org's ID or URN.
      """
      orgRef: ID
      """
      The Agent this App deploys. Required as of 009-install-agent-flow:
      every App must reference an Agent. The server itself accepts any
      Agent the caller can resolve and auto-provisions an AgentOrgGrant
      (008 behavior preserved); the portal's install flow restricts the
      affordance to Agents owned by the caller org. A hard server-side
      cross-org gate is reserved for the marketplace spec.
      """
      agentRef: ID!
      name: String!
      urn: String
      appType: AppType
      role: AppMembershipRole
      description: String
      systemPrompt: String
      agentTools: [String!]
      aiProvider: String
      aiModel: String
      aiApiKey: String
      expiresAt: String
      surfaces: [String!]
      trainingMode: Boolean
      """
      008-agent-installation: optional dep Agent ids to cascade-install.
      Required imports of the parent Agent always cascade; optional imports
      install only when their id appears here. Pass [] (or omit) to skip
      all optional deps. v1 accepts ID or URN.
      """
      installOptional: [ID!]
      createUserPermission: CreateUserPermission
      identifyUserMethod: IdentifyUserMethod
      sessionTimeoutSeconds: Int
      anonymousTtlDays: Int
      "App-layer action-policy link (cor:acl:040:02, #510). Explicit null clears; omitted preserves."
      policy: JSON
    ): App!

    """
    Update an App.

    Accepts the entity's ID or URN.
    """
    updateApp(
      ref: ID!
      name: String
      urn: String
      appType: AppType
      role: AppMembershipRole
      description: String
      systemPrompt: String
      agentTools: [String!]
      aiProvider: String
      aiModel: String
      aiApiKey: String
      expiresAt: String
      surfaces: [String!]
      trainingMode: Boolean
      createUserPermission: CreateUserPermission
      identifyUserMethod: IdentifyUserMethod
      sessionTimeoutSeconds: Int
      anonymousTtlDays: Int
    ): App!

    """
    Soft-delete an App.

    Accepts the entity's ID or URN.
    """
    deleteApp(ref: ID!): Boolean!

    """
    Install an Agent into an App (023-app-shape US1). Creates an AppAgent
    row joining the two. An App can have multiple Agents installed; one
    credential addresses all of them.

    This is the ONE operation that attaches an EXISTING Agent to an EXISTING
    App — distinct from createApp (which makes a NEW App from an Agent). It
    is therefore also the re-attach that cor:dmo:050:03 promises: detaching an
    Agent retains the memories accumulated under that App-and-Agent pairing as
    orphans, and installing the Agent again is what makes them reachable.
    Under cor:agt:020:01 the AppAgent join is a team's install ROSTER (which
    agents are available); the App's STAFF are its Workers, cast from
    installed agents with castWorker. Worker rows survive uninstall
    (cor:dmo:050:11) — uninstalling severs future casting, not history.

    Rejects with code DUPLICATE_APP_AGENT when the Agent is already
    installed in the App.

    Authorization: the owner of a user-owned App, or an org member with
    CONTRIBUTOR+ on an org-owned App's org (platform admins included). NOT
    plain AppMembers: installing an existing Agent is itself a read grant on
    that Agent's design — its system memory becomes readable from every App
    context, and the returned Agent carries its systemPrompt — so this gate
    stays at the level that can already read the org's Agents.

    Accepts the entity's ID or URN for both appId and agentId. Optional
    trainingMode flag updates the per-App training flag (applies to
    every installed Agent — training mode is per-App, not per-Agent,
    per spec 023 FR-001).
    """
    installAgentIntoApp(
      appRef: ID!
      agentRef: ID!
      trainingMode: Boolean
    ): InstallAgentIntoAppPayload!

    """
    #974 — cast a Worker (cor:dmo:050:11, cor:agt:020:01/:02): the named
    casting of an agent ALREADY INSTALLED in the App, superseding
    createTeamPersona's minting semantics (nothing is minted — the agent
    carries the persona dressing; the Worker is the local named identity).
    Casting is opt-in, never requires a Team Agent (an explicit name skips the
    register entirely), and multiple castings of one agent per App are legal
    (Iris and Henry, both backend-engineer).

    Agent resolution: agentRef when given (must be installed here —
    WORKER_AGENT_NOT_INSTALLED); otherwise role picks the single installed
    agent whose personaRole matches (zero / several candidates:
    WORKER_AGENT_NOT_FOUND / WORKER_AGENT_AMBIGUOUS, never a guess). The
    casting's role defaults to the agent's personaRole when role is omitted.

    Name allocation (cor:agt:020:02): a caller-supplied name wins (one
    attempt — WORKER_NAME_TAKEN is the answer); otherwise the Team Agent's
    cast-list register for the role (the roles:<role> node's data.names,
    located as before: teamAgentRef, or the single installed agent with a
    roles: branch) is walked first-to-last, advancing past WORKER_NAME_TAKEN —
    the workers_app_name_uniq constraint IS the allocation primitive. Names
    are unique per App, case-insensitively, FOREVER (two Apps may each have an
    Iris; retirement and uninstall never free a name).

    A worker-scoped working memory is provisioned in the App's container
    (Worker.memoryId; best-effort — a failed provision leaves it null for
    lazy provisioning).

    Authorization: an org member with CONTRIBUTOR+ on the App's org, an
    AppMember of the App whose role is not 'reader', or the owner of a
    user-owned App. Pure App-key principals are denied.

    Error codes (extensions.code): WORKER_NAME_TAKEN,
    WORKER_REGISTER_EXHAUSTED, WORKER_AGENT_NOT_INSTALLED,
    WORKER_AGENT_NOT_FOUND, WORKER_AGENT_AMBIGUOUS, WORKER_ROLE_NOT_FOUND,
    TEAM_AGENT_NOT_FOUND, TEAM_AGENT_AMBIGUOUS, TEAM_AGENT_NOT_INSTALLED,
    SESSION_EXPIRED (encrypted system memory without an active session key),
    APP_UNINSTALLED.

    Accepts the entity's ID or URN for appRef, agentRef, and teamAgentRef.
    """
    castWorker(
      appRef: ID!
      agentRef: ID
      role: String
      name: String
      teamAgentRef: ID
      promptOverride: String
    ): Worker!

    """
    #974 — retire a Worker (cor:agt:020:02): end the casting while reserving
    its name FOREVER. A retired worker stops authoring team chat at once (the
    worker-App pin checks retirement at post time), takes no new work records,
    and refuses new session bindings; the row and its name reservation
    survive. Idempotent — retiring an already-retired worker returns it
    unchanged. Same authorization as castWorker. workerRef is the worker's id
    or its URN (#991).
    """
    retireWorker(workerRef: ID!): Worker!

    """
    #1010 — amend a casting's individuality after the fact.

    \`promptOverride\` is the per-worker escape hatch (cor:agt:020:01), but it
    could only be set at CASTING time — fixing a casting's individuality at the
    one moment nobody yet knows what makes it individual. The role agent's
    \`personaPrompt\` cannot stand in (it is SHARED by every casting of that
    role), and re-casting is barred by \`WORKER_IN_USE\` for any worker that has
    done work — precisely the ones with an identity to record.

    Scope is one field on purpose: \`name\` is permanent by law (cor:agt:020:02)
    and \`role\`/\`agent\` define the casting itself. OMITTING promptOverride
    preserves it; explicit \`null\` or a blank string CLEARS it, matching the
    nullable column and castWorker's blank-is-absent normalization.

    Refuses WORKER_RETIRED for a retired worker: an override is briefing text
    delivered at bind time, and a retired worker takes no new bindings, so the
    edit could never reach anyone.

    Same authorization as castWorker. workerRef is the worker's id or URN (#991).
    """
    updateWorker(workerRef: ID!, promptOverride: String): Worker!

    """
    #974 — hard-delete a NEVER-USED miscast (cor:dmo:050:11's only removal
    escape): refused with WORKER_IN_USE unless no session was ever bound and
    the worker's working memory holds no content. Anything with history
    retires instead — its name is bound to that history forever. Also removes
    the empty working memory. Same authorization as castWorker.
    """
    deleteWorker(workerRef: ID!): Boolean!

    """
    #960 — mint a roles:<role> definition in the Team Agent's system memory.
    Owns the spec knowledge a hand-authoring caller had to carry: the loc is
    roles:<role> (single atom), the register goes in data.names (ordered),
    and the write runs the register invariants — an added name may not appear
    in another of this App's registers (TEAM_ROLE_NAME_DUPLICATE) and must
    fall inside nameRange when one is set (TEAM_ROLE_NAME_OUT_OF_RANGE,
    override with allowOutOfRange; a supplied nameRange must parse as an
    initial-letter range like 'F-J'). Register checks and the write run in
    one App-scoped critical section, serialized with register-mode casting.
    Refuses an existing role
    (TEAM_ROLE_EXISTS — updateTeamRole is the edit path). Authorization is
    the Team Agent's definition-edit gate: whoever may write the agent's
    system memory through the generic node surface may write roles — the
    write delegates to that same seam (encryption, revision snapshot, git
    mirror included).
    """
    createTeamRole(
      appRef: ID!
      teamAgentRef: ID
      role: String!
      names: [String!]!
      nameRange: String
      nameConvention: String
      description: String
      allowOutOfRange: Boolean
    ): TeamRole!

    """
    #960 — edit a roles:<role> definition. names is WHOLESALE (the natural
    fit for 'team role names set') but the invariants run against the DIFF
    between stored and submitted, so add/rm/mv sugar can never smuggle a
    violation: a name MINTED in this App may never be removed
    (TEAM_ROLE_NAME_MINTED — the register entry records the allocation), an
    added name may not appear in another register (TEAM_ROLE_NAME_DUPLICATE),
    and added names validate against nameRange (allowOutOfRange overrides).
    Omitted fields preserve; explicit null clears a convention key. Sibling
    data keys always survive (the single --data clobber hazard is unreachable
    through this surface). Unknown role: WORKER_ROLE_NOT_FOUND. Same
    authorization as createTeamRole.

    #987 — expectedNames turns the wholesale write into COMPARE-AND-SWAP:
    when supplied, the write refuses TEAM_ROLE_STALE unless the STORED
    register still equals it (ordered, exact spellings, after the same
    trim/dedup canonicalization the register itself gets — pass back the
    register exactly as teamRoles returned it). The refusal's extensions
    carry the current storedNames, so a client rebases its edit without a
    second read. This is what makes read-modify-write sugar (names
    add/rm/mv) safe: the diff invariants deliberately protect only MINTED
    names, so without the precondition two concurrent composed writes
    silently drop each other's newly added FREE names — no refusal fires,
    because removing an unminted name is legal by design.
    """
    updateTeamRole(
      appRef: ID!
      teamAgentRef: ID
      role: String!
      names: [String!]
      nameRange: String
      nameConvention: String
      description: String
      allowOutOfRange: Boolean
      expectedNames: [String!]
    ): TeamRole!

    """
    #1002 — retire a roles:<role> definition. Soft-deletes the role node and
    any sub-nodes under it (roles:<role>:notes is content OF the role), so the
    subtree is recoverable. Unknown role: WORKER_ROLE_NOT_FOUND. Same
    authorization and same App-scoped critical section as createTeamRole, so a
    retirement serializes with register-mode casting.

    MINTED names decide whether a bare delete is allowed. A minted register
    entry is what records that a name was allocated to this role; dropping the
    register without rehoming it would erase that ledger, so a role holding
    minted names refuses TEAM_ROLE_IN_USE unless transferTo names a successor.
    A role whose register is entirely free deletes with no ceremony.

    Note this does NOT free the names themselves: a Worker's name is permanent
    per App (cor:agt:020:02, enforced by workers_app_name_uniq irrespective of
    any register), so retiring a role can never make a taken name castable
    again. The register is bookkeeping about ALLOCATION, not identity — which
    is exactly why moving it between roles is safe.

    transferTo performs the supersede as ONE step: the old definition is
    retired and its whole register is appended to the successor's, preserving
    order and skipping spellings the successor already lists. This removes the
    ordering trap a hand-run sequence has to rediscover (a name may not sit in
    two of an App's registers, so the old role must be gone BEFORE the
    successor can claim its names — TEAM_ROLE_NAME_DUPLICATE otherwise).
    Transferred names are EXEMPT from the successor's nameRange: they are
    re-homed allocations, not new ones, and the range governs what may be
    allocated next. The successor's own conventions are left untouched —
    changing them is updateTeamRole's job, not a side effect of a delete.

    The delete and the transfer are two operations that cannot share one
    transaction, so the source role is RESTORED if the transfer fails — the
    delete is soft, and the tombstone still holds the register verbatim. The
    minted check is also re-run AFTER the delete, because an explicit-name
    castWorker mints without taking the register lock and could otherwise slip
    a freshly minted name past the pre-check. Should the restore itself fail,
    TEAM_ROLE_DELETE_NOT_COMPENSATED reports the loc to recover by hand rather
    than leaving the caller to retry against a role that is silently gone.
    """
    deleteTeamRole(
      appRef: ID!
      teamAgentRef: ID
      role: String!
      transferTo: String
    ): DeleteTeamRolePayload!

    """
    Post a message into a team App's chat (#939) as a platform operation.
    The team chat is ONE well-known chat per team App, at loc chats:team in
    the Team Agent's shared app-class memory, bootstrapped on first post.
    The message is written through the atomic chat-message allocator (#919),
    so racing posts get distinct consecutive seqs.

    Author derivation (#974): with sessionRef, the message is authored by
    that session's bound Worker (the session must be writable by the caller, a
    session OF this App, active, and bound to a non-retired Worker OF this
    App — the worker-App pin, checked at post time so retirement revokes) and
    the envelope records the driving sessionId; without it, by the calling
    human. Mentions ('@worker-name' / '@handle'; a multi-word name is
    mentioned by its slug, e.g. '@mary-jane') are extracted server-side at
    write time into the envelope. replyToSeq wires a replies-to edge to the
    cited message. body is capped at 65536 characters.

    Authorization: an AppMember of the App (any role — every member of the
    host is a participant per cor:acl:030:01), an org member with
    CONTRIBUTOR+ on the App's org, or the owner of a user-owned App. Pure
    App-key principals cannot post.

    Error codes (extensions.code): TEAM_CHAT_BODY_TOO_LARGE,
    TEAM_CHAT_REPLY_NOT_FOUND, SESSION_NOT_FOUND, SESSION_NOT_IN_APP (the
    session belongs to a different App — a worker never authors across
    Apps), SESSION_ENDED, SESSION_NOT_WORKER_BOUND,
    SESSION_WORKER_NOT_IN_APP (the worker-App pin), WORKER_RETIRED,
    SESSION_EXPIRED (encrypted team memory without an active session key),
    TEAM_AGENT_NOT_FOUND / TEAM_AGENT_AMBIGUOUS (first-post bootstrap could
    not locate the Team Agent), APP_UNINSTALLED, FORBIDDEN.

    appRef accepts the entity's ID or URN; sessionRef is the session id.
    """
    createTeamChatMessage(
      appRef: ID!
      body: String!
      replyToSeq: Int
      sessionRef: ID
    ): TeamChatMessage!

    """
    Record an externally visible work milestone into the team App's worklog
    (#947) — the append-only, authoritative PR-session join (spec
    cor:agt:020:03). The session must be writable by the caller and a session
    OF this App (SessionInput.appRef, #944); an ENDED session is accepted —
    late attribution (a merge lands after the session ends) is the point.
    ref accepts URL and short spellings and is stored in ONE canonical form
    (github: owner/repo#N, owner/repo@sha, owner/repo:branch, owner/repo);
    a bare number is refused — the server never infers a repo. kind must be
    one of pr, issue, commit, branch, repo; action is a free lowercased verb
    (opened, merged, claimed, reviewed, closed, pushed, ...). kind: pr also
    denormalizes the latest-wins Session.prNumber display convenience.
    detail is an optional JSON bag of display extras (title, URL) — stored,
    never filtered on. Records are append-only: correct a wrong record by
    recording a newer one.

    Authorization: an AppMember of the App (any role), an org member with
    CONTRIBUTOR+ on the App's org, or the owner of a user-owned App. A pure
    App-key principal may NOT record (read-only on the worklog).

    A worker-bound session records under its Worker's name (#974,
    cor:agt:020:05) — the worker must belong to THIS App and not be retired
    (SESSION_WORKER_NOT_IN_APP / WORKER_RETIRED — a retired or foreign
    worker refuses rather than reshaping the attribution); an unbound
    session records under the attributed user's handle.

    Typed refusals: WORK_REF_INVALID, SESSION_NOT_FOUND, SESSION_NOT_IN_APP,
    SESSION_WORKER_NOT_IN_APP, WORKER_RETIRED, TEAM_AGENT_NOT_FOUND /
    TEAM_AGENT_AMBIGUOUS (first-write bootstrap could not locate the Team
    Agent), APP_UNINSTALLED, FORBIDDEN, BAD_USER_INPUT.

    appRef accepts the entity's ID or URN; sessionRef is the session id.
    """
    recordTeamWork(
      appRef: ID!
      sessionRef: ID!
      tool: String!
      kind: String!
      ref: String!
      action: String!
      detail: JSON
    ): TeamWorkItem!

    """
    (Re)declare the server-owned team collections on the team App's shared
    memory, converging a drifted declaration to the canonical definition
    (hadron-cli#401). Idempotent: 'changed' is false when the declaration
    already matched.

    Why this exists as its own operation. recordTeamWork declares the worklog
    collection on first write, but deliberately leaves an ALREADY-declared one
    untouched — a deployment that tightened it governs that surface too, which
    is the point of schema governance. A declaration is not always a
    deployment decision though: 'hadron team init' shipped a client-side copy
    of this schema that has since drifted from the server's (its kind enum
    predates the 'repo' kind), so on a CLI-bootstrapped memory a
    recordTeamWork(kind: 'repo') is refused by a rule nobody chose.
    Overriding silently would break real governance; this operation makes
    convergence an explicit act instead.

    Only the server-owned collections are rewritten — every other collection
    on the memory is preserved.

    Authorization: owner or org ADMIN on the memory, the same bar updateMemory
    applies to a schema edit. Team participation is deliberately NOT enough:
    it lets you record work, not redefine what a record is.

    Typed refusals: APP_UNINSTALLED, UNAUTHENTICATED, TEAM_AGENT_NOT_FOUND /
    TEAM_AGENT_AMBIGUOUS (when the App's shared memory must still be
    bootstrapped).

    Accepts the entity's ID or URN.
    """
    updateTeamCollections(appRef: ID!): TeamCollectionsPayload!

    """
    Uninstall an Agent from an App. Deletes the AppAgent row. The Agent's
    per-(App, Agent, *) memories are NOT cascade-deleted (spec 023 FR-005);
    they persist as orphans and become reachable again if the same Agent
    is later reinstalled.

    Idempotent — succeeds whether or not the AppAgent row exists.

    Accepts the entity's ID or URN.
    """
    uninstallAgentFromApp(
      appRef: ID!
      agentRef: ID!
    ): UninstallAgentFromAppPayload!

    """
    DEPRECATED: use installAgentIntoApp. Carried for source-compat with
    pre-023 portal callers.

    Accepts the entity's ID or URN.
    """
    addAgentToApp(
      appRef: ID!
      agentRef: ID!
      trainingMode: Boolean
    ): App! @deprecated(reason: "Use installAgentIntoApp (spec 023-app-shape US1). Returns Payload type with the AppAgent row.")

    """
    DEPRECATED: use uninstallAgentFromApp. Carried for source-compat
    with pre-023 portal callers.

    Accepts the entity's ID or URN.
    """
    removeAgentFromApp(appRef: ID!, agentRef: ID!): App! @deprecated(reason: "Use uninstallAgentFromApp (spec 023-app-shape US1).")

    """
    Idempotent UPSERT of an AppMember row. Per spec 008-agent-installation
    FR-004 / FR-016. The role MUST be a value present in the parent
    Agent's installationPolicy.memberRoles. Creating a new member is
    rejected if the App's current member count meets or exceeds the
    Agent's installationPolicy.maxMembers. Updating an existing member's
    role does NOT trigger the maxMembers check.

    Accepts the entity's ID or URN.
    """
    ensureAppMember(
      "#764 — the App as an id / URN. Supply this OR appId."
      appRef: String
      appId: ID @deprecated(reason: "Use appRef (accepts id / URN).")
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
      role: String!
    ): AppMember!

    """
    Delete an AppMember row. Idempotent (no-op when the row doesn't exist).
    Personal-class memory at (appId, userId) is retained as an orphan per
    FR-015 — re-attaches automatically if the user later rejoins the same
    App.

    Accepts the entity's ID or URN.
    """
    removeAppMember(
      "#764 — the App as an id / URN. Supply this OR appId."
      appRef: String
      appId: ID @deprecated(reason: "Use appRef (accepts id / URN).")
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
    ): Boolean!

    """
    023-app-shape US2 — user-level install. The currently-logged-in user
    joins the App as an AppMember. NO OrgMember check (spec 023 FR-009)
    so this works for B2C / consumer / therapy use cases where the
    end-user is not in the App's operator org.

    Role defaults to the first value in the Agent's
    installationPolicy.memberRoles (the conventional "guest" or "owner"
    slot). Idempotent — if the user is already an AppMember of the App,
    the existing row is returned.

    Error codes (GraphQLError extensions.code, Error.name style):
      - UNAUTHENTICATED — no logged-in user in context.
      - AppNotFoundError — the App does not exist or is soft-deleted.
      - AppUninstalledError — the App is in the spec-021 soft-uninstall
        lifecycle phase.
      - OrphanAppError — the App has no installed Agents (so there's
        no Agent.installationPolicy to consult).
      - NoMemberRolesError — the primary Agent's
        installation_policy.memberRoles is empty, so joinApp can't
        pick a default role.
      - MaxMembersExceededError — the Agent's maxMembers limit is hit.
      - InvalidRoleError — the picked default role isn't accepted by
        the Agent's policy (rare; would indicate a policy update
        race).

    Accepts the entity's ID or URN.
    """
    joinApp(appId: ID!): JoinAppPayload!

    """
    023-app-shape US2 — user-level uninstall. The currently-logged-in user
    leaves an App. Idempotent (no-op when not a member). The user's
    personal-class Memory at (appId, userId) is NOT cascade-deleted
    per spec 008 FR-015 — it re-attaches if the user later re-joins.

    Accepts the entity's ID or URN.
    """
    leaveApp(appId: ID!): LeaveAppPayload!

    """
    023-app-shape US3 — asymmetric cross-user grant on a personal-class
    Memory. The principal (memory.userId) grants a grantee read or
    write access. Used for the per-pairing pattern (Alice's
    paired-with-Mentor-A memory is distinct from her
    paired-with-Mentor-B memory; each gets its own MemoryShare).

    Upsert semantics: re-calling with a different role on an existing
    (memoryId, granteeId) pair updates the role rather than throwing.

    For v1 the caller MUST be the principal themselves (memory.userId
    === ctx.userId). The Agent-mediated path (App backend acting on
    the principal's behalf via MCP) is supported by the access-control
    predicate but not by this GraphQL surface — see the deferred
    policy discussion linked from joinApp.ts.

    Share-audience rule (#778): a plain ORG-OWNED personal memory
    (organizationId set, no agent scope) may be shared ONLY with a
    current member of that org; a FREE-STANDING (org-less) personal
    memory may be shared with any user. Agent-scoped personal memories
    (the spec-023 per-pairing App pattern) are exempt — their audience
    is governed by AppMember + AgentSubscription, not org membership.

    Error codes (extensions.code, Error.name style):
      - UNAUTHENTICATED — no logged-in user in context.
      - FORBIDDEN — caller is not the Memory's principal. The
        caller-authority guard runs first and deliberately does not
        differentiate between "memory doesn't exist", "memory is not
        personal-class", and "caller isn't the principal" — all three
        return FORBIDDEN so memory metadata isn't leaked to
        non-principals.
      - MemoryShareGranteeMissingError — granteeId doesn't resolve to
        an existing User. Only reachable when the caller passes the
        principal guard.
      - CrossOrgShareNotAllowedError — the grantee is not a member of an
        org-owned personal memory's org (the #778 audience rule above).
      - InvalidMemoryClassForShareError / MemoryNotFoundForShareError —
        defined on the controller for completeness; functionally
        unreachable via this GraphQL mutation in v1 because the
        caller-authority guard short-circuits to FORBIDDEN first.
    """
    createMemoryShare(
      memoryId: ID!
      "#769 — the grantee as a reference resolved server-side: a user id, email, handle, or hrn:user:<handle> URN. Resolution sees the full user table, so a cross-org personal-memory share works by email/handle. Supply this OR granteeId."
      granteeRef: String
      "Deprecated (#769): the grantee's user PK. Use granteeRef, which also accepts email / handle / URN."
      granteeId: ID @deprecated(reason: "Use granteeRef (accepts id / email / handle / hrn:user URN).")
      role: MemoryShareRole!
    ): CreateMemorySharePayload!

    """
    023-app-shape US3 — delete a MemoryShare. Per FR-022, revocation
    takes effect on the next read (there's no "deactivated" state;
    just a row delete). Renamed from revokeMemoryShare in #785.

    Caller-authority rule (#785) — principal OR self, the same shape
    removeMemoryMember uses:
      - The memory's principal (memory.userId) may delete ANY grantee
        row on their memory. Idempotent: deleting a share that is
        already gone succeeds.
      - A GRANTEE may delete THEIR OWN row — the
        stop-sharing-with-me / leave path. Omit granteeRef entirely and
        the mutation targets the caller's own share.
      - Everyone else gets FORBIDDEN.

    On the self path the SHARE ROW itself is the authorization, so that
    path is idempotent only up to the row's lifetime: repeating a
    successful leave answers FORBIDDEN (you already left). That is what
    keeps every unauthorized outcome identical — a caller who is
    neither principal nor grantee cannot tell "no such memory" from
    "not shared with me" from "not yours", by error code or by the
    difference between an error and a successful no-op. The same rule
    covers the grantee reference: a non-principal caller gets FORBIDDEN
    whether the named user exists or not, so neither memories nor
    users can be enumerated here. (A principal, who by definition
    already knows the memory exists, still gets NOT_FOUND for a
    granteeRef that resolves to nobody.)

    A grantee may leave a memory whose owner has soft-deleted it (the
    row would otherwise be stranded); the principal path still treats a
    soft-deleted memory as FORBIDDEN.
    """
    deleteMemoryShare(
      "The memory, by id or URN (#785)."
      memoryRef: ID!
      "#769 — the grantee as a server-resolved reference (id / email / handle / hrn:user URN). Supply this OR granteeId. Omit BOTH to target the caller's own share (self-removal)."
      granteeRef: String
      granteeId: ID @deprecated(reason: "Use granteeRef (accepts id / email / handle / hrn:user URN).")
    ): DeleteMemorySharePayload!

    """
    023-app-shape US3 — change the role on an existing MemoryShare.
    Throws MemoryShareNotFoundError if the (memoryId, granteeId) row
    doesn't exist — use createMemoryShare to upsert.

    Caller-authority rule matches createMemoryShare.
    """
    updateMemoryShareRole(
      memoryId: ID!
      "#769 — the grantee as a server-resolved reference (id / email / handle / hrn:user URN). Supply this OR granteeId."
      granteeRef: String
      granteeId: ID @deprecated(reason: "Use granteeRef (accepts id / email / handle / hrn:user URN).")
      role: MemoryShareRole!
    ): UpdateMemoryShareRolePayload!

    """
    023-app-shape US4 — add a team member to a group-class Memory.
    Idempotent on the (memoryId, userId) PK: re-calling with a
    different role upserts the role.

    The caller MUST be an owner of the Memory (role = owner). The
    bootstrap case is handled by createMemory itself, which adds the
    creator as the first owner of a newly-created group memory.

    Error codes (extensions.code, Error.name style):
      - UNAUTHENTICATED — no logged-in user in context.
      - FORBIDDEN — caller is not an owner of the memory. (Uniform
        for missing-memory / wrong-class / not-an-owner cases, by
        the same don't-leak-metadata rule as MemoryShare mutations.)
      - InvalidMemoryClassForMemberError — memory is not group-class
        (only reachable from non-GraphQL callers in v1 — the
        caller-authority guard short-circuits to FORBIDDEN first).
      - MemoryMemberUserMissingError — the userId doesn't resolve.
      - LastOwnerProtectedError (FR-038) — reachable via the
        idempotent upsert path when the call would demote an
        existing sole owner to reader/writer.
    """
    addMemoryMember(
      "#764 — the memory as an id or URN. Supply this OR memoryId."
      memoryRef: String
      memoryId: ID @deprecated(reason: "Use memoryRef (accepts id / URN).")
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
      role: MemoryMemberRole!
    ): AddMemoryMemberPayload!

    """
    023-app-shape US4 — change the role on an existing team member.
    Throws MemoryMemberNotFoundError when the row doesn't exist;
    use addMemoryMember to upsert. Throws LastOwnerProtectedError
    (FR-038) when demoting the sole remaining owner.

    Caller-authority rule matches addMemoryMember.

    Error codes (extensions.code, Error.name style):
      - UNAUTHENTICATED — no logged-in user in context.
      - FORBIDDEN — caller is not an owner of a live group memory.
      - MemoryNotFoundForMemberError — memory absent or soft-deleted
        (only reachable from non-GraphQL callers in v1 — the guard
        short-circuits to FORBIDDEN first).
      - InvalidMemoryClassForMemberError — memory is not group-class
        (same; guard short-circuits to FORBIDDEN first).
      - MemoryMemberNotFoundError — no row at (memoryId, userId).
      - LastOwnerProtectedError (FR-038) — would demote the sole owner.
    """
    updateMemoryMemberRole(
      "#764 — the memory as an id or URN. Supply this OR memoryId."
      memoryRef: String
      memoryId: ID @deprecated(reason: "Use memoryRef (accepts id / URN).")
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
      role: MemoryMemberRole!
    ): UpdateMemoryMemberRolePayload!

    """
    023-app-shape US4 — remove a team member. Idempotent. Removing
    the LAST owner is rejected with LastOwnerProtectedError (FR-038)
    — group memories must always have ≥1 owner; the path to fully
    empty one is to delete the Memory.

    Removing the last non-owner does NOT delete the Memory (FR-031);
    the row persists with its remaining owner(s).

    Caller-authority: either an owner of the Memory, or the member
    being removed (self-removal).
    """
    removeMemoryMember(
      "#764 — the memory as an id or URN. Supply this OR memoryId."
      memoryRef: String
      memoryId: ID @deprecated(reason: "Use memoryRef (accepts id / URN).")
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
    ): RemoveMemoryMemberPayload!

    """
    Publish a dependency edge from a parent Agent to an imported Agent
    (008-agent-installation FR-005). v1 supports 1-level imports only:
    the imported Agent must not itself be a parent of any other import.

    Authorization: ADMIN/OWNER of the parent Agent's owning org. The
    parent's owning org MUST hold an active AgentOrgGrant for the
    imported Agent — bundling requires the same kind of license that
    installation does.

    Accepts the entity's ID or URN for both Agent ids.
    """
    publishAgentImport(
      parentAgentRef: ID!
      importedAgentRef: ID!
      position: Int!
      required: Boolean = true
    ): AgentImport!

    """
    Delete a dependency edge between two Agents. Idempotent (no-op when
    the row doesn't exist). Apps that already installed the imported
    Agent are unaffected; removing the import only stops *future*
    parent installs from cascading the dep.

    Accepts the entity's ID or URN.
    """
    removeAgentImport(parentAgentRef: ID!, importedAgentRef: ID!): Boolean!

    """
    Mint a new AppKey for an App.

    Accepts the entity's ID or URN.
    """
    createAppKey(appRef: ID!, label: String): AppKeyCreated!
    # AppKey is keyed by raw ID — no urn column. Stays ID-only.
    revokeAppKey(id: ID!): Boolean!

    """
    025-oauth-for-mcp FR-004: mint a new user-scoped API key for the
    calling User. Returns the raw key exactly once (the server stores
    only the SHA-256 hash). Rejected with UNAUTHENTICATED for AppKey-
    resolved callers (no user in context). Per Clarifications, label
    is optional (portal defaults to a placeholder when omitted).
    """
    createUserApiKey(label: String): UserApiKeyCreateResult!

    """
    025-oauth-for-mcp FR-004: revoke a user-scoped API key owned by
    the calling User. Returns the updated UserApiKey so the portal
    can render the new revokedAt without a refetch (PR-137 review
    delta D3 — was Boolean). Idempotent for already-revoked keys;
    rejected with FORBIDDEN if the key belongs to another user;
    NOT_FOUND if id does not exist; UNAUTHENTICATED for AppKey-
    resolved callers.
    """
    revokeUserApiKey(id: ID!): UserApiKey!

    """
    005-agent-subscription FR-023 + FR-028 + FR-029: revoke a user's
    AgentSubscription. Authorized for ADMIN/OWNER of the Agent's owning
    org. Side effect: empty personal Memory of (user, agent) is hard-
    deleted; non-empty is retained with userMemoryOfAgentId preserved.

    Accepts the entity's ID or URN (agentId).
    """
    revokeAgentSubscription(
      "#764 — the user as an id / email / handle / hrn:user:<handle> URN. Supply this OR userId."
      userRef: String
      userId: ID @deprecated(reason: "Use userRef (accepts id / email / handle / URN).")
      "#764 — the Agent as an id / URN. Supply this OR agentId."
      agentRef: String
      agentId: ID @deprecated(reason: "Use agentRef (accepts id / URN).")
    ): AgentSubscription!

    # App Key callers only: vouch for a user and manage sessions.
    # Identity lifecycle
    createAppUser(externalId: String!, handle: String, name: String, email: String): User!

    # Multi-user-agent session lifecycle (renamed to avoid collision with
    # the developer/guided startSession and endSession mutations).
    # dataKey is base64-encoded, 32 bytes, required when the app is
    # configured with identifyUserMethod: SECRET and the target memory is
    # (or will become) encrypted.
    startAgentSession(
      agentId: ID!
      externalUserId: String
      sessionTimeoutSeconds: Int
      dataKey: String
    ): Session!
    endAgentSession(sessionId: ID!): Boolean!

    """
    Link an anonymous memory to a real user (converts session memory
    ownership). Providing dataKey encrypts the memory in place atomically
    with the link.

    Accepts the entity's ID or URN.
    """
    linkMemoryToUser(memoryId: ID!, externalUserId: String!, dataKey: String): Memory!

    """
    Convert a plaintext PRIVATE memory to encrypted (spec 041, caller-held
    keys). Exactly one of dataKey (base64, 32 bytes) / passphrase (scrypt-
    derived; salt + params stored on the memory, the key itself never).
    Owner or org-App-key. All node content/abstract/data is re-written as
    ciphertext in one transaction. One-way without the key: the server
    cannot recover the content.

    Accepts the entity's ID or URN.
    """
    encryptMemory(memoryId: ID!, dataKey: String, passphrase: String): Memory!
  }

  # ── Chat types ──────────────────────────────────────────────────────
  type ChatStartResult {
    chatId: String!
    systemMessage: String!
    tools: JSON
    conversationName: String
    stageName: String
  }

  type ChatPromptResult {
    systemMessage: String!
    tools: JSON
    messageHistory: JSON!
    summarizationNeeded: SummarizationRequest
  }

  type SummarizationRequest {
    messageCount: Int!
    prompt: String!
  }

  type ChatResponseResult {
    displayMessage: String!
    stageTransitioned: Boolean!
    newStageName: String
    conversationHandoff: String
    chatEnded: Boolean!
    onTrack: Boolean!
    offTrackReason: String
  }

  type RevisionResult {
    revisionLoc: String!
    label: String!
    published: Boolean!
    createdAt: DateTime!
  }

  type EditorLockResult {
    locked: Boolean!
    lockedBy: String
    expiresAt: DateTime
  }
`;
