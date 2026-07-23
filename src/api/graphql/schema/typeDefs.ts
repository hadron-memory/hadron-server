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
  only ever narrow the caller's accessible scope — with one documented scope
  SELECTION: visibility: PUBLIC switches from the caller's own union
  (org-owned + org-subscribed + own personal/private) to the public
  marketplace slice (every PUBLIC memory — the old publicMemories query).
  Both slices are readable by the caller, so this never widens access.
  """
  input MemoryFilter {
    "Restrict to exactly these classes. Omitted, the noisy agent system class is hidden by default; pass it explicitly to surface system memories."
    memoryClasses: [MemoryClass!]
    "Restrict by visibility. PUBLIC selects the marketplace slice (see above)."
    visibility: MemoryVisibility
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
  'nodes' is the authorized, existing subset (input order for an id set, loc
  order for a prefix). 'unavailable' lists the requested refs that were denied
  OR not found — indistinguishable, so the result never discloses whether an
  unreadable node exists. 'truncated' is true when the response-size cap was
  reached, and 'omitted' then carries the dropped node ids. (Over the
  node-count cap the query errors instead — never a silent short read.)
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
    "Fully-qualified node URN (hrn:node:<org>::<memory>::<loc>), composed server-side from the node's memory URN + loc (#481). Carried by every Node-returning surface (findNodes, node, appNodes, nodeBatch, mutation returns)."
    urn: String!
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
    drains. Operational state (never versioned on NodeRevision). The
    portal renders this as a subtle "embedding…" badge so a user who
    just edited isn't confused that their change "didn't take" in
    search yet. System-managed.
    """
    embeddingPendingAt: String
    """
    Spec 033 FR-009 — set when an embed attempt failed (record, not a
    work signal). Transient failures keep embeddingPendingAt set for
    retry; permanent failures clear it. The portal renders this as a
    red badge with the embeddingError message inline so users with an
    empty index can distinguish "nothing matched" from "every embed
    failed". System-managed.
    """
    embeddingFailedAt: String
    """
    Spec 033 — last embed error message (diagnosability; also surfaced
    by hadron_validate). Common values: encrypted-no-plaintext (#206),
    embedding-endpoint-unreachable, dimension-mismatch. Null when no
    failure has been recorded since the most recent success or revoke.
    System-managed.
    """
    embeddingError: String
    """
    Spec 033 — attempt counter for backoff / give-up. Resets to 0 on
    success or revoke. Surfaced for ops diagnostics (a node stuck at a
    high attempt count likely needs operator attention). System-managed.
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
    createdAt: String!
    updatedAt: String!
    memory: Memory
    outgoingEdges: [Edge!]!
    incomingEdges: [Edge!]!
  }

  type Edge {
    id: ID!
    source: Node!
    target: Node!
    "Fully-qualified edge URN (hrn:edge:<org>::<memory>::<loc>), composed server-side from the edge's (source-side) memory URN + loc (#481 parity — edges are loc-addressed peers of nodes, spec 037)."
    urn: String!
    # Colon-delimited path within the (source node's) memory — the edge's
    # identity and the suffix of its URN hrn:edge:<org>::<memory>::<loc>.
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
    agentId: String
    memoryId: String
    expiresAt: String
    repo: String
    branch: String
    prNumber: Int
    customerId: String
    language: String
    plan: String
    llmModel: String
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
    startedAt: String!
    endedAt: String
    autoExpiredAt: String
    events: [UsageEvent!]!
  }

  type UsageEvent {
    id: ID!
    type: String!
    nodeLoc: String
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
    createdAt: String!
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
    effectiveAt: String!
    createdAt: String!
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
    expiresAt: String
    sourceType: String
    sourceId: String
    note: String
    createdAt: String!
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
    createdAt: String!
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
    identityProvider: String
    externalId: String
    externalAppId: String
    linkedAt: String
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
    Spec 021 US1: the R2 canonical install URN combining the App's
    identity with its installed Agent's author-org and slug. Format is
    hrn:agent:<installing-org>::<app-slug>::<author-org>:<agent-slug>.
    Two orgs installing same-slug agents from different authors produce
    distinct URNs that differ at the author-org segment, enabling
    audit-log entries to identify each install unambiguously without a
    PK disambiguator. Returns null when the App has no agent attached
    (orphan apps from the 008 cutover; new apps require an agentId per
    009).
    """
    installedAgentUrn: String
    trainingMode: Boolean!
    surfaces: [String!]!
    members: [AppMember!]!
    memberCount: Int!
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
    expiresAt: String
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
    createdAt: String!
    updatedAt: String
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
    createdAt: String!
    createdBy: String
    updatedAt: String
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
    createdAt: String!
    """
    The API actor who created the row. Distinct from grantor when an
    App backend creates the share on the principal's behalf.
    """
    createdBy: String
    updatedAt: String
    updatedBy: String
  }

  type CreateMemorySharePayload {
    memoryShare: MemoryShare!
  }

  type UpdateMemoryShareRolePayload {
    memoryShare: MemoryShare!
  }

  type RevokeMemorySharePayload {
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
    createdAt: String!
    createdBy: String
    updatedAt: String
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
    createdAt: String!
    updatedAt: String
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
    createdAt: String!
  }

  # 008-agent-installation: Org↔Agent license. Authorizes (a) creating an App
  # in this Org that uses this Agent, and (b) bundling this Agent in an
  # AgentImport edge of an Agent the Org owns. Sibling to AgentSubscription.
  type AgentOrgGrant {
    orgId: ID!
    agentId: ID!
    organization: Organization!
    agent: Agent!
    activatedAt: String
    expiresAt: String
    revokedAt: String
    revokedBy: ID
    isActive: Boolean!
    createdAt: String!
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
    activatedAt: String
    expiresAt: String
    revokedAt: String
    revokedBy: ID
    isActive: Boolean!
    createdAt: String!
  }

  type AppKey {
    id: ID!
    appId: String!
    keyPreview: String!
    label: String
    createdAt: String!
    lastUsedAt: String
    revokedAt: String
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
    createdAt: String!
    lastUsedAt: String
    revokedAt: String
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
    isVisible: Boolean
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
    createdAt: String!
    updatedAt: String!
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
    createdAt: String!
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
    vectorIndexEncryptedAckAt: String
    userMemoryOfAgentId: String
    anonymousExpiresAt: String
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
    lastSyncedAt: String
    createdAt: String!
    updatedAt: String!
    subscriptions: [MemorySubscription!]!
    """
    023-app-shape US3: cross-user grants on this memory. Non-empty
    only when class = personal (FR-018). Includes grantee + role for
    each row. Visible only to the principal (memory.userId) and to
    ADMIN/OWNER of the memory's owning org.
    """
    shares: [MemoryShare!]!
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
    createdAt: String!
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
    createdAt: String!
    updatedAt: String
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
    createdAt: String!
    lastMessageAt: String
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
    createdAt: String!
  }

  type AgentMemoryItem {
    id: ID!
    memory: Memory!
    role: String!
    createdAt: String!
  }

  # An organization's subscription to a memory it does not own.
  type MemorySubscription {
    id: ID!
    memory: Memory!
    organization: Organization!
    role: Role!
    activated: Boolean!
    createdAt: String!
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
    lastSyncAt: String
    lastError: String
    createdAt: String!
    updatedAt: String!
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
    createdAt: String!
    updatedAt: String!
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
    createdAt: String!
    createdBy: String
    updatedAt: String!
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
    createdAt: String!
    createdBy: String
    updatedAt: String!
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
    createdAt: String!
    createdBy: String
    updatedAt: String!
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
    createdAt: String!
    createdBy: String
    updatedAt: String!
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
    receivedDateTime: String
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
    dateTime: String
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
    createdAt: String
    updatedAt: String
  }

  type ScheduleBusyInterval {
    start: String!
    end: String!
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
    createdAt: String
    modifiedAt: String
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
    expiresAt: String
    acceptedAt: String
    createdAt: String!
    activationCount: Int!
  }

  # Outgoing edge on a node, used in NodeInput.edges
  input NodeEdgeInput {
    """
    Reference to the target node. Accepts a node ID, a full URN
    (hrn:node:<memory-urn>::<loc>), a memory-prefixed loc
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
    "The node to change: PK (CUID / 32-char hex) or fully-qualified node URN (org::memory::loc). XOR with memoryId+loc."
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
    status: AppRunStatus!
    curNodeUrn: String
    parentRunId: ID
    failure: JSON
    timeoutMs: Int
    attempts: Int!
    startedAt: String
    finishedAt: String
    createdAt: String!
    createdBy: String
  }

  type AppRunsPage {
    items: [AppRun!]!
    total: Int!
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
    runAt: String
    timezone: String!
    entryNodeUrn: String!
    eventData: JSON
    policy: JSON
    aiConfigName: String
    enabled: Boolean!
    lastRunAt: String
    nextRunAt: String
    createdAt: String!
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
    "Canonical URN of the grantee App (hrn:app:<org>::<slug>), or null if unresolvable."
    granteeAppUrn: String
    granteeAppName: String
    "Covered scopes: mail.read, mail.send, calendar.freebusy, calendar.read."
    scopes: [String!]!
    "ISO-8601 expiry, or null for perpetual (until revoked)."
    expiresAt: String
    createdAt: String!
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
    expiresAt: String
    createdAt: String!
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
    lastCalledAt: String
    createdAt: String!
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
    consumedAt: String
    expiresAt: String
    createdAt: String!
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
    resetAt: String!
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

  scalar JSON

  # ─── Assets ──────────────────────────────────────────────────────
  # Per spec 004-asset-upload. Assets live in a dedicated Asset
  # entity (NOT a nodeType) FK-related to Memory. URN form:
  #   <memory.urn>:assets:<asset.id>

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
    description: String
    uploadedAt:  String!
    """Uploader (User id). Null when the asset was created server-side by an app run (hadron_store_file)."""
    uploadedBy:  ID
    deletedAt:   String
    """The asset's URN: <memory.urn>:assets:<asset.id>."""
    urn:         String!
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
    expiresAt:       String!
    storageKey:      String!
    maxSizeBytes:    Int!
    allowedMimeType: String!
  }

  input CompleteAssetUploadInput {
    uploadId: ID!
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

  type AssetDownloadUrl {
    url:       String!
    expiresAt: String!
    filename:  String!
    mimeType:  String!
    sizeBytes: Int!
  }

  """
  Result of resolving a Hadron URN to the ids a client needs to navigate to
  the resource's canonical page. Powers the portal's /app/u/<urn> redirect
  route (hadron-portal#262).

  \`kind\` is the URN's type segment: memory | node | agent | org | app | user.
  \`id\` is the resolved entity's primary id. \`memoryId\` is set only for
  nodes (their owning memory), \`organizationId\` only for apps (their owning
  org) — both are the extra ids those resources' canonical routes require.
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
    "Canonical URN of the resolved resource (the AiServiceConfig id when the resource is a config, which has no URN)."
    resourceUrn: String!
    "memory | node | app | agent | aiServiceConfig."
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
    (\`org::slug\` could be a memory or an agent) and resolve to null.
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
      2. a fully-qualified node URN (\`hrn:node:<org>::<memory>::<loc>\`,
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
    fully-qualified edge URN (\`hrn:edge:<org>::<memory>::<loc>\`; the edge's
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
    'ids' (explicit set, returned in input order) OR 'memory' + 'locPrefix'
    (subtree, loc order) — not both. Per-node access is applied independently:
    denied or missing ids come back in 'unavailable' and never fail the call.
    Bounded by hard caps — over the node-count cap throws BAD_USER_INPUT; over
    the response-size cap returns a partial result with 'truncated: true' and
    the dropped ids in 'omitted' (never a silent short read). Node content is
    returned raw — Mustache templates are NOT compiled (unlike the single-node
    'node' read), since this is a bulk source read for lint / audit /
    migration and compiling per node would re-introduce the N+1 it eliminates.
    """
    nodeBatch(ids: [ID!], memory: ID, locPrefix: String): NodeBatchResult!

    # Usage stats for a node (most recent events first)
    nodeUsage(loc: String!, limit: Int): [UsageEvent!]!

    # Usage events (most recent first), optionally filtered by type, memoryId,
    # or nodeId.
    #
    # Access control (#250): results are always scoped to memories the caller
    # may read (org membership / subscriptions / public / owned personal+private
    # per spec 034; ADMIN/OWNER see all but other users' personal+private). A
    # memoryId the caller can't read returns [] (no existence leak); the global
    # form (no memoryId) is bounded to the readable set, never cross-tenant.
    #
    # memoryId is a memory identifier — accepts the memory's ID or URN. Results
    # are scoped to events whose node belongs to that memory (FK-precise).
    #
    # nodeId is a node token accepting a PK, a fully-qualified URN, or a bare
    # loc (no memoryId needed):
    #   - PK / URN  → resolved to a single node; scoped via its exact nodeId FK
    #                 (memory-precise).
    #   - bare loc  → exact nodeLoc match, bounded to readable memories (like
    #                 nodeUsage but access-scoped); not existence-checked.
    usageEvents(type: String, memoryId: ID, nodeId: ID, limit: Int, offset: Int): [UsageEvent!]!

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

    # Sessions, most recent first
    sessions(type: String, repo: String, customerId: String, limit: Int, offset: Int): [Session!]!
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
    safe for a non-member. Returns non-null only when the org is activated
    (isVisible=true) AND exposes a public footprint (a PUBLIC memory/agent, or
    listedOnMarketplace); otherwise null (denied is indistinguishable from
    not-found — anti-enumeration). Never exposes members, private memories,
    apps, or credentials. 'ref' accepts the org ID or URN.
    """
    publicOrganization(ref: ID!): PublicOrganization

    """
    cor:acl:080:04 — browse the marketplace catalogue: resources opted-in via
    listedOnMarketplace AND publicly accessible. Public (no membership required);
    sanitized flat refs only (never members / private data / credentials). One
    paginated query per resource type; ordered by (name, id) for stable paging.
    - marketplaceOrganizations: activated (isVisible=true) + listed orgs.
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
    limit: 0 -> count only.
    """
    apps(orgId: ID, limit: Int, offset: Int): AppsPage!

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
    Name-ascending order (id tiebreak); limit default 50 / cap 200;
    limit: 0 -> count only.
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
    is PUBLIC by definition). Field-level exposure is slim for non-members:
    systemPrompt / systemMemoryId / memoryItems / imports / importedBy are
    member/admin-gated (null / [] for outsiders). Name-ascending order
    (id tiebreak); limit default 50 / cap 200; limit: 0 -> count only.
    """
    publicAgents(filter: AgentFilter, limit: Int, offset: Int): AgentsPage!
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
    v2 (spec 006) — memory-addressed listing. Returns assets for a
    specific memory; caller must have read access. The replacement
    for agentAssets in the v2 surface.

    Accepts the entity's ID or URN.
    """
    memoryAssets(
      memoryId:       ID!
      mimeType:       String
      skip:           Int = 0
      count:          Int = 20
      includeDeleted: Boolean = false
    ): AssetListResult!

    # Mint a short-TTL presigned GET URL for an asset. Default TTL
    # 5 minutes; ceiling 1 hour. Gated on scan_status = CLEAN.
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
    "One run (cor:agt:010:02). ref is an AppRun ID or an hrn:apprun:<root>:<app>:<run-id> URN (#696)."
    appRun(ref: ID!): AppRun
    "The latest run of an App resolved to a concrete run (#696) — 'current/latest/previous' are queries, never magic run-ids in URN space (cor:urn:010:02). previous: true returns the run before the latest."
    latestAppRun(appRef: String!, previous: Boolean): AppRun
    appRuns(appRef: String, orgRef: String, status: AppRunStatus, parentRunId: ID, limit: Int, offset: Int): AppRunsPage!
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
    # nodeRef (a node PK or a fully-qualified node URN, org::memory::loc),
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

    # Session lifecycle
    startSession(input: SessionInput!): Session!
    endSession(id: ID!, summary: String, inputTokens: Int, outputTokens: Int, turnCount: Int, errorCount: Int): Session!

    # Record a usage event
    recordUsage(event: UsageEventInput!): Boolean!

    """
    App key management — revoke all active keys for an App and mint a
    fresh one. (See createAppKey / revokeAppKey / deleteApp below.)

    Accepts the entity's ID or URN.
    """
    regenerateAppKey(id: ID!): AppCreated!

    # User management
    updateMyProfile(name: String, handle: String, email: String): User!
    updateUserRoles(userId: ID!, roles: [Role!]!): User!
    # Consolidate a duplicate account into a surviving user. Source-only
    # identities and relationships move; duplicate role-bearing relationships
    # preserve the strongest live entitlement. The source is soft-deleted.
    # Platform admin, or an org admin/owner when both users are live members
    # of an organization they administer. The resulting merge is global.
    mergeUsers(input: MergeUsersInput!): User!

    # Organization management
    createOrganization(name: String!, urn: String!): Organization!

    """
    Update an Organization.

    Accepts the entity's ID or URN.
    """
    updateOrganization(id: ID!, name: String, urn: String, isVisible: Boolean, listedOnMarketplace: Boolean, policy: JSON): Organization!

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
    addOrgMember(orgId: ID!, userId: ID!, role: Role!): OrgMember!
    """Accepts the entity's ID or URN (orgId)."""
    updateOrgMember(orgId: ID!, userId: ID!, role: Role!): OrgMember!
    """Accepts the entity's ID or URN (orgId)."""
    removeOrgMember(orgId: ID!, userId: ID!): Boolean!

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
    Soft-delete a Memory.

    Accepts the entity's ID or URN.
    """
    deleteMemory(id: ID!): Boolean!

    """
    Clone a Memory into a new Memory at \`targetUrn\`.

    \`ref\` accepts the source's ID or URN. \`targetUrn\` is a fully-qualified
    "org::slug" memory URN naming the clone; its org segment MAY differ from
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
    a fully-qualified '<org>::<slug>' URN naming the new memory (it may land in
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
    ADMIN); OMIT orgId to create a USER-OWNED agent owned by the caller (spec
    047) — its URN is namespaced under the caller's @handle and its system
    memory is user-owned too. Exactly one owner (org XOR user).

    orgId accepts the org's ID or URN.
    """
    createAgent(orgId: ID, name: String!, description: String, systemPrompt: String, systemMemoryId: String, visibility: AgentVisibility, type: AgentType, surfaces: [String!]): Agent!

    """
    Update an Agent.

    Accepts the entity's ID or URN.
    """
    updateAgent(id: ID!, name: String, urn: String, description: String, systemPrompt: String, systemMemoryId: String, visibility: AgentVisibility, listedOnMarketplace: Boolean, type: AgentType, surfaces: [String!]): Agent!

    """
    Soft-delete an Agent.

    Accepts the entity's ID or URN.
    """
    deleteAgent(id: ID!): Boolean!

    """
    Attach a Memory to an Agent.

    Accepts the entity's ID or URN.
    """
    addMemoryToAgent(agentId: ID!, memoryId: ID!, role: String): Agent!

    """
    Update an Agent's role on an attached Memory.

    Accepts the entity's ID or URN.
    """
    updateAgentMemoryRole(agentId: ID!, memoryId: ID!, role: String!): Agent!

    """
    Detach a Memory from an Agent.

    Accepts the entity's ID or URN.
    """
    removeMemoryFromAgent(agentId: ID!, memoryId: ID!): Agent!

    # Memory subscriptions (cross-org)
    """
    Create a cross-org Memory subscription.

    Accepts the entity's ID or URN.
    """
    createMemorySubscription(memoryId: ID!, orgId: ID!, role: Role!): MemorySubscription!

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
    updateMemorySubscription(memoryId: ID!, orgId: ID!, role: Role!): MemorySubscription!

    """
    Delete a cross-org Memory subscription.

    Accepts the entity's ID or URN.
    """
    deleteMemorySubscription(memoryId: ID!, orgId: ID!): Boolean!

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

    """
    Add a public memory to the current user's personal workspace.

    Accepts the entity's ID or URN.
    """
    addToMyMemories(memoryId: ID!): Boolean!

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
      USER-OWNED App owned by the caller (spec 047) — namespaced under the
      caller's @handle, owner-only in v1. Accepts the org's ID or URN.
      """
      orgId: ID
      """
      The Agent this App deploys. Required as of 009-install-agent-flow:
      every App must reference an Agent. The server itself accepts any
      Agent the caller can resolve and auto-provisions an AgentOrgGrant
      (008 behavior preserved); the portal's install flow restricts the
      affordance to Agents owned by the caller org. A hard server-side
      cross-org gate is reserved for the marketplace spec.
      """
      agentId: ID!
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
      id: ID!
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
    deleteApp(id: ID!): Boolean!

    """
    Install an Agent into an App (023-app-shape US1). Creates an AppAgent
    row joining the two. An App can have multiple Agents installed; one
    credential addresses all of them.

    Rejects with code DUPLICATE_APP_AGENT when the Agent is already
    installed in the App.

    Accepts the entity's ID or URN for both appId and agentId. Optional
    trainingMode flag updates the per-App training flag (applies to
    every installed Agent — training mode is per-App, not per-Agent,
    per spec 023 FR-001).
    """
    installAgentIntoApp(
      appId: ID!
      agentId: ID!
      trainingMode: Boolean
    ): InstallAgentIntoAppPayload!

    """
    Uninstall an Agent from an App. Deletes the AppAgent row. The Agent's
    per-(App, Agent, *) memories are NOT cascade-deleted (spec 023 FR-005);
    they persist as orphans and become reachable again if the same Agent
    is later reinstalled.

    Idempotent — succeeds whether or not the AppAgent row exists.

    Accepts the entity's ID or URN.
    """
    uninstallAgentFromApp(
      appId: ID!
      agentId: ID!
    ): UninstallAgentFromAppPayload!

    """
    DEPRECATED: use installAgentIntoApp. Carried for source-compat with
    pre-023 portal callers.

    Accepts the entity's ID or URN.
    """
    addAgentToApp(
      appId: ID!
      agentId: ID!
      trainingMode: Boolean
    ): App! @deprecated(reason: "Use installAgentIntoApp (spec 023-app-shape US1). Returns Payload type with the AppAgent row.")

    """
    DEPRECATED: use uninstallAgentFromApp. Carried for source-compat
    with pre-023 portal callers.

    Accepts the entity's ID or URN.
    """
    removeAgentFromApp(appId: ID!, agentId: ID!): App! @deprecated(reason: "Use uninstallAgentFromApp (spec 023-app-shape US1).")

    """
    Idempotent UPSERT of an AppMember row. Per spec 008-agent-installation
    FR-004 / FR-016. The role MUST be a value present in the parent
    Agent's installationPolicy.memberRoles. Creating a new member is
    rejected if the App's current member count meets or exceeds the
    Agent's installationPolicy.maxMembers. Updating an existing member's
    role does NOT trigger the maxMembers check.

    Accepts the entity's ID or URN.
    """
    ensureAppMember(appId: ID!, userId: ID!, role: String!): AppMember!

    """
    Delete an AppMember row. Idempotent (no-op when the row doesn't exist).
    Personal-class memory at (appId, userId) is retained as an orphan per
    FR-015 — re-attaches automatically if the user later rejoins the same
    App.

    Accepts the entity's ID or URN.
    """
    removeAppMember(appId: ID!, userId: ID!): Boolean!

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
      - InvalidMemoryClassForShareError / MemoryNotFoundForShareError —
        defined on the controller for completeness; functionally
        unreachable via this GraphQL mutation in v1 because the
        caller-authority guard short-circuits to FORBIDDEN first.
    """
    createMemoryShare(
      memoryId: ID!
      granteeId: ID!
      role: MemoryShareRole!
    ): CreateMemorySharePayload!

    """
    023-app-shape US3 — revoke a MemoryShare. Per FR-022, revocation
    takes effect on the next read (there's no "deactivated" state;
    just a row delete). Idempotent.

    Caller-authority rule matches createMemoryShare.
    """
    revokeMemoryShare(
      memoryId: ID!
      granteeId: ID!
    ): RevokeMemorySharePayload!

    """
    023-app-shape US3 — change the role on an existing MemoryShare.
    Throws MemoryShareNotFoundError if the (memoryId, granteeId) row
    doesn't exist — use createMemoryShare to upsert.

    Caller-authority rule matches createMemoryShare.
    """
    updateMemoryShareRole(
      memoryId: ID!
      granteeId: ID!
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
      memoryId: ID!
      userId: ID!
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
      memoryId: ID!
      userId: ID!
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
      memoryId: ID!
      userId: ID!
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
      parentAgentId: ID!
      importedAgentId: ID!
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
    removeAgentImport(parentAgentId: ID!, importedAgentId: ID!): Boolean!

    """
    Mint a new AppKey for an App.

    Accepts the entity's ID or URN.
    """
    createAppKey(appId: ID!, label: String): AppKeyCreated!
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
    revokeAgentSubscription(userId: ID!, agentId: ID!): AgentSubscription!

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
    createdAt: String!
  }

  type EditorLockResult {
    locked: Boolean!
    lockedBy: String
    expiresAt: String
  }
`;
