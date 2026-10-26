export const typeDefs = `#graphql
  "#1156 — hrn:node:hadronmemory.com:specs:cor:dmo:070:05: closed end causes; unknown is reserved for legacy rows."
  enum SessionEndReason {
    ended
    superseded
    expired
    unknown
  }

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

  """#1447 — a spec corpus's state, derived from its nodes since #1591: DRAFT while no live node is minted, MINTED once any is."""
  enum CorpusState {
    DRAFT
    MINTED
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

  "#1608 — which kinds of node a search or list returns (hrn:node:hadronmemory.com:specs:cor:dmo:110:08)."
  enum NodeContentScope {
    "Content only, never comments. The default."
    CONTENT
    "Comments only, never content: feedback, not verified fact about its target."
    COMMENTS
    "Content and comments; every comment hit is still a comment (see Node.asComment)."
    ALL
  }

  """
  Structured, unscored, AND-combined filter context for findNodes (cor:api:090:02).
  """
  input NodeFilter {
    "Memory scope — a mix of memory IDs and fully-qualified URNs; intersected with the caller's access."
    memoryIds: [ID!]
    "Restrict by memory class. SYSTEM is excluded by default; passing this (or naming a system memory in memoryIds) overrides that."
    memoryClasses: [MemoryClass!]
    "An explicit 'comment' with no contentScope searches comments (as COMMENTS)."
    nodeType: String
    """
    #1608 — content, comments or both (hrn:node:hadronmemory.com:specs:cor:dmo:110:08).
    Default CONTENT. Applied by the server before ranking, pagination and
    limits in every mode (keyword, regex, vector, hybrid and filter-only), so a
    COMMENTS search finds every matching comment the caller may read.
    """
    contentScope: NodeContentScope
    "#725 — collection facet: only nodes whose objectType equals this (e.g. \\"competitor\\")."
    objectType: String
    tags: [String!]
    isRunnable: Boolean
    "#1322 — role-family filter. 'spec' matches 'spec' and 'spec.*' on a dot boundary, never 'special' / 'specification'."
    role: String
    locPrefix: String
    createdBy: String
    updatedAfter: String
    updatedBefore: String
    "Include soft-deleted nodes (default false)."
    includeDeleted: Boolean
    "Structured predicate over the node's properties/data JSONB (#719)."
    where: NodeWhereInput
    "#1591 — only nodes in this approval state (read from the stored revision; a node changed outside a revisioned writer is reconciled on its next read)."
    approvalState: NodeApprovalState
    "#1591 — only minted (true) or unminted (false) nodes."
    minted: Boolean
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
    OR and these hits match ANY term), scope_narrowed (spec 049: the scope
    this search ran under lists memories you cannot read; they were dropped
    and \`scope.droppedCount\` says how many).
    """
    degraded: String
    "Spec 049 (D-2026-09-13-002): what this search was produced under. Null when no scope applied (the pre-049 accessible set, optionally org-narrowed)."
    scope: SearchScopeInfo
  }

  """
  Spec 049 — the scope a search ran under (every result discloses it,
  D-2026-09-13-002). \`kind\`: scope | app | global | user-owned. \`source\`:
  call | session | active-app | active-org | trigger (a headless run snapshot). \`memoryUrns\` lists only the
  memories YOU may read; \`droppedCount\` is how many the scope lists that you
  may not — a count, never their names.
  """
  type SearchScopeInfo {
    kind: String!
    source: String!
    label: String!
    ownerUrn: String
    memoryUrns: [String!]!
    droppedCount: Int!
  }

  "Slim node projection for the graph view (issue #466) — only what a node-link graph draws."
  type GraphNode {
    id: ID!
    "#1606 — how many open discussion threads this node has: the node-list trust cue (hrn:node:hadronmemory.com:specs:cor:dmo:110:07). Batched per request."
    openThreads: Int!
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
    "The edge's governed kind (#2124); see Edge.governedKind."
    governedKind: EdgeGovernedKind
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
  # the exact full count for the query's scope+filter; limit defaults to 20
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

  # ── Spec 049 Phase 2 — named search scopes ("lenses"), D-2026-09-13-001 ──

  "Which entity owns a Scope. Exactly one per scope (DB-enforced, the AiServiceConfig pattern)."
  enum ScopeOwnerType {
    ORGANIZATION
    AGENT
    APP
  }

  """
  A named search SCOPE: an ORDERED list of memories with exactly one owner
  (organization | Agent | App). Selects memories only — no saved filter, no
  retrieval parameters — and NEVER grants: \`memories\` is the stored list ∩
  what YOU may read (D-2026-09-13-004), and \`hiddenMemoryCount\` says how many
  you cannot see, as a count only. Names are unique per owner; \`global\` and
  \`app\` are reserved (the ladder's own views). Collisions across owners in
  an App's context resolve App › Agent › organization, never unioned.
  """
  type Scope {
    id: ID!
    name: String!
    description: String
    ownerType: ScopeOwnerType!
    "ID of the owning organization / Agent / App."
    ownerId: ID!
    "Bare stored URN of the owner, when it has one."
    ownerUrn: String
    "The scope's memories YOU may read, in scope order."
    memories: [ScopeMemoryEntry!]!
    "How many memories the scope lists in total."
    memoryCount: Int!
    "How many of them you may NOT read (count only — never their names)."
    hiddenMemoryCount: Int!
    createdAt: DateTime!
    updatedAt: DateTime
  }

  type ScopeMemoryEntry {
    "0-based order within the scope."
    position: Int!
    memory: Memory!
  }

  type ScopesPage {
    items: [Scope!]!
    total: Int!
  }

  """
  Filter for the uniform scopes() list. Clauses AND-combine and only narrow the
  caller's readable set. \`ownerType\` + \`ownerRef\` name one owner; \`appRef\`
  selects the App's whole CONTEXT (its own scopes, its installed Agents', its
  organization's) — what a bare name would resolve against there.
  """
  input ScopeFilter {
    ownerType: ScopeOwnerType
    "ID or URN of the owner (with ownerType)."
    ownerRef: ID
    "ID or URN of an App — the resolution context."
    appRef: ID
    name: String
  }

  """
  Exactly one of organizationRef / agentRef / appRef. \`memoryRefs\` is the
  ORDERED list (IDs or URNs); each must be readable by you — an unreadable
  memory reads as "no match", the same as a nonexistent one.
  """
  input CreateScopeInput {
    name: String!
    description: String
    organizationRef: ID
    agentRef: ID
    appRef: ID
    memoryRefs: [ID!]!
  }

  "All optional. \`memoryRefs\`, when passed, REPLACES the list (it is the new order)."
  input UpdateScopeInput {
    name: String
    description: String
    memoryRefs: [ID!]
  }

  """
  What a scope resolves to FOR YOU: which owner tier won when resolved by
  name, the scopes it shadowed, the readable memories in order, how many were
  dropped for access, and — when \`loc\` was asked — which memory would win
  for that address (the input the task-customization operation consumes).
  """
  type ScopeExplanation {
    scope: Scope!
    resolvedVia: ScopeOwnerType!
    "Lower-precedence scopes of the same name in that App's context (that you may read)."
    shadowed: [Scope!]!
    memories: [Memory!]!
    droppedCount: Int!
    winner: Memory
  }

  # ── Spec 049 Phase 4 — Channels (D-2026-09-13-006) ──

  "What kind of feed a Channel is. CHAT today; BLOCKERS / TASKS when built."
  enum ChannelKind {
    CHAT
  }

  """
  A CHANNEL (spec 049, D-2026-09-13-006): a durable, ordered message stream
  hosted in ONE memory at ONE reserved address, server-ordered and
  server-attributed — a platform entity, created one-to-one with its chat root.
  Creating it RESERVES and PROTECTS the address: generic node writes under it
  are refused (LOC_PROTECTED); its own operations (createTeamChatMessage,
  hadron_team_chat_post) are the only writers. The audience is the host
  memory's (cor:acl:030:01) — a Channel has no access layer of its own.
  \`lastSeq\` / \`lastMessageAt\` are the platform-maintained watermark.
  """
  type Channel {
    id: ID!
    "Host memory."
    memoryId: ID!
    """
    #2509: this memory's record, exactly as Query.memory answers it to the
    caller, or null when the caller may not read that record (or it is
    deleted). Seeing this channel does not grant its memory's record, so use
    memoryId for the address.
    """
    memory: Memory
    "The reserved address of the chat root (e.g. chats:team)."
    loc: String!
    name: String!
    kind: ChannelKind!
    description: String
    "The chat root node this Channel IS the entity for (one-to-one)."
    chatRootNodeId: ID!
    """
    #1171 — the Channel's ADDRESS: its chat root's node URN
    (hrn:node:<org>:<memory>:<loc>). A channelRef takes TWO FORMS — an id, or a
    chat-root node ref — and the node ref is accepted in every spelling the
    node resolver takes (\`urn:node:\`, bare fully-qualified, canonical \`::\`);
    this field emits the one to copy. COPY it rather than composing one: a
    Channel a ref fails to name is indistinguishable from one you may not read.

    NULL when the server has no flat-v2 address it can safely advertise —
    commonly a pre-v2 compound host memory URN, which flattens into a node URN
    that cannot be split back. It does NOT mean the Channel is unaddressable in
    principle (a canonical \`::\` spelling can still resolve one); it means the
    server will not hand you a string it would itself reject. Use \`id\` there;
    it always works.
    """
    chatRootUrn: String
    "Highest seq the allocator has issued — a watermark, not a count."
    lastSeq: Int!
    """
    #2181 — which incarnation of the Channel this is. An opaque, stable integer that rises when a supported recreation
    reuses the Channel under the same id; seqs and read cursors can survive it, so a pinned read or mark names this
    value. Compare for equality only.
    """
    incarnation: Int!
    lastMessageAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime
  }

  type ChannelsPage {
    items: [Channel!]!
    total: Int!
  }

  "Filter for channels(): by App (its host memories' Channels) or by one host memory. Refs: ID or URN."
  input ChannelFilter {
    appRef: ID
    memoryRef: ID
  }

  """
  Create a named Channel WITH its chat root, in one transaction. The host may be
  a memory of ANY class that you may write — the host memory's own audience
  decides who reads and posts (cor:acl:030:01), so a Channel in a private memory
  is private and one in an app memory is the App's. \`loc\` is the reserved
  address (e.g. chats:release) and must not overlap an existing Channel's;
  \`chats:team\` is every App's default and is created with the App.

  There is no app-class precondition. This said there was until #1248 — the
  rule was retired by #1196 and the description outlived it, so every client
  mirroring this SDL published a refusal that cannot fire.

  **Creating at a DELETED Channel's address starts CLEAN** (#1226). The address
  stays reserved by the tombstone, so a create here adopts it rather than
  inserting beside it — and the previous Channel's messages are tombstoned so
  the new room is empty. The allocator history remains, while the empty
  Channel's last-sequence and last-message watermarks reset. Its first new
  message therefore resumes above the old maximum, so an old read cursor
  cannot hide it. Expect a gap in the numbering, never inherited transcript or
  phantom attention.
  """
  input CreateChannelInput {
    memoryRef: ID!
    loc: String!
    name: String!
    description: String
  }

  input UpdateChannelInput {
    name: String
    description: String
  }

  # ── Spec 049 Phase 5 — the chat register (D-2026-09-13-007) ──

  "What a register row declares: INTENT, never permission (D-2026-09-13-008)."
  enum RegisterRole {
    WATCH
    POST
    BOTH
  }

  "A register row is owned by exactly one of the two; Agent-owned rows do not exist (plan §14)."
  enum RegisterOwnerType {
    ORGANIZATION
    APP
  }

  """
  A REGISTER ENTRY (spec 049, D-2026-09-13-007): "this attendee takes part in
  this Channel". The attendee is a Worker when cast, otherwise an Agent in an
  App; both null = every attendee in the owner's context (org-wide for an
  organization row, App-wide for an App row). Not a trigger list — a row never
  starts a run. The register never grants: what the attendee may read or post
  is the Channel's host memory's decision. Not exportable.
  """
  type RegisterEntry {
    id: ID!
    ownerType: RegisterOwnerType!
    "ID of the owning organization / App."
    ownerId: ID!
    organizationId: ID
    appId: ID
    channelId: ID!
    "The Channel — null when you may not read its host memory (you stand on the owner side only)."
    channel: Channel
    attendeeWorkerId: ID
    attendeeAgentId: ID
    "The attendee's URN (hrn:worker:… or the Agent's); null for 'every attendee'."
    attendeeUrn: String
    role: RegisterRole!
    "Only messages mentioning the attendee count as new for it."
    mentionOnly: Boolean!
    "The row install materialised for the App's default Channel (D2)."
    installDefault: Boolean!
    "The human's intent, free text."
    description: String
    createdAt: DateTime!
    updatedAt: DateTime
  }

  type RegisterEntriesPage {
    items: [RegisterEntry!]!
    total: Int!
  }

  "Filter for registerEntries(). Refs: ID or URN."
  input RegisterEntryFilter {
    "An App or an organization."
    ownerRef: ID
    "A Channel: its id or its address (Channel.chatRootUrn). A ref naming nothing matches nothing."
    channelRef: ID
    "A Worker or an Agent."
    attendeeRef: ID
  }

  input CreateRegisterEntryInput {
    "An App or an organization (URN or id)."
    ownerRef: ID!
    "A Channel: its id or its address (Channel.chatRootUrn, #1171)."
    channelRef: ID!
    "A Worker or an Agent in the owner's context; omitted = every attendee there."
    attendeeRef: ID
    "Default BOTH."
    role: RegisterRole
    mentionOnly: Boolean
    description: String
  }

  input UpdateRegisterEntryInput {
    role: RegisterRole
    mentionOnly: Boolean
    description: String
  }

  # ── Spec 049 Phase 6 — resolveRegister (plan §4.3) ──

  "S5 — why an attendee cannot act on a register row. Rendered identically by every consumer."
  enum RegisterDisclosure {
    HOST_MEMORY_NOT_READABLE
    HOST_MEMORY_NOT_WRITABLE
    CHANNEL_DELETED
    DRIVER_NOT_PARTICIPANT
    UNKNOWN_ACTOR
    IMPERSONATION
  }

  "Which attendee column the winning register row named."
  enum RegisterNamedBy {
    WORKER
    AGENT
    EVERYONE
  }

  "The Channel half of a register view row; the host memory's URN only when the viewer may read it."
  type RegisterViewChannel {
    id: ID!
    name: String!
    kind: ChannelKind!
    loc: String!
    hostMemoryUrn: String
    "The host memory's id — like the URN, only when the viewer may read it."
    hostMemoryId: ID
    "The Channel's watermark — the highest seq issued, not a count."
    lastSeq: Int!
    lastMessageAt: DateTime
    deleted: Boolean!
  }

  """
  One row of an attendee's RESOLVED register (spec 049 §4.3): the winning
  register entry for a Channel (App › organization, Worker › Agent › everyone,
  never unioned), the Channel's watermark, and the ATTENDEE's real standing on
  the host memory — canRead / canPost are the existing gates, the register
  grants nothing. A row the attendee cannot act on is returned with its reason,
  never dropped. Host memory identifiers remain gated for the VIEWER.
  """
  type RegisterViewRow {
    entry: RegisterEntry!
    namedBy: RegisterNamedBy!
    channel: RegisterViewChannel!
    "Phase 7 — the attendee's cursor; null until read-state lands."
    lastSeenSeq: Int
    canRead: Boolean!
    "False for a Worker without an eligible driver (UNKNOWN_ACTOR); null only when no access subject was supplied."
    canPost: Boolean
    disclosure: RegisterDisclosure
    attendeeUrn: String
  }

  """
  Spec 049 Phase 7 — where an attendee is up to on a Channel (D-2026-09-13-009).
  Outside the register; keyed on the ATTENDEE (a Worker, or an Agent in an
  App); advances are monotonic. Mute is session state, never here.
  """
  type ChannelReadState {
    attendeeUrn: String
    channelId: ID!
    lastSeenSeq: Int!
    updatedAt: DateTime!
    "#2181 — the Channel's CURRENT incarnation (the same value as Channel.incarnation)."
    channelIncarnation: Int!
    """
    #2181 — the incarnation the stored cursor was last RAISED under. NULL is a legacy cursor: it is never backfilled and
    never relabelled. Treat your cursor as current only when this equals both channelIncarnation and the incarnation you
    read, and lastSeenSeq >= your seq.
    """
    cursorIncarnation: Int
  }

  "#1353 — compact unread metadata for one Worker/Channel pair. No message body is returned."
  type TeamAttentionChannel {
    channel: ID!
    name: String!
    unread: Int!
    unreadMentions: Int!
    firstUnreadSeq: Int
    lastSeq: Int!
  }

  "#1353 — one live Worker that has relevant unread attention after the supplied token."
  type TeamAttentionWorker {
    worker: ID!
    name: String!
    urn: String
    live: Boolean!
    channels: [TeamAttentionChannel!]!
  }

  type TeamAttentionResult {
    "Opaque signed snapshot. Adopt it only after every listed nudge is accepted."
    token: String!
    workers: [TeamAttentionWorker!]!
  }

  type TeamAttentionSwitchoverChannel {
    channel: ID!
    name: String!
    fromSeq: Int!
    throughSeq: Int!
    unread: Int!
    unreadMentions: Int!
  }

  type TeamAttentionSwitchoverWorker {
    worker: ID!
    name: String!
    urn: String
    channels: [TeamAttentionSwitchoverChannel!]!
  }

  type TeamAttentionSwitchoverPreview {
    "Short-lived proof binding the exact operator, App, Workers, registers, cursors and heads shown here."
    proof: String!
    expiresAt: DateTime!
    workers: [TeamAttentionSwitchoverWorker!]!
  }

  """
  #1384 paged (v2): one bounded slice of an attention scan. Counts are exact
  for the captured (seen, head] range of the issuing scan only, and items are
  emitted solely from Channels that scan has exhausted.
  """
  type TeamAttentionPageItem {
    worker: ID!
    workerName: String!
    workerUrn: String
    channel: ID!
    channelName: String!
    unread: Int!
    unreadMentions: Int!
    firstUnreadSeq: Int
    lastRelevantSeq: Int
    "The frozen Channel head this item's counts are exact for."
    lastSeq: Int!
  }

  type TeamAttentionPage {
    items: [TeamAttentionPageItem!]!
    "False while any Channel is unfinished or queued items remain undelivered."
    scanComplete: Boolean!
    "Continuation for the next pull; null on the final page."
    nextPage: String
    """
    FINAL PAGE ONLY: a since-watermark token (same shape v1 issued) to adopt
    after every listed nudge was accepted. Never present while scanComplete
    is false.
    """
    adoptableSince: String
  }

  type TeamAttentionPreviewPage {
    items: [TeamAttentionPageItem!]!
    scanComplete: Boolean!
    nextPage: String
    """
    FINAL PAGE ONLY: the short-lived switchover proof (frozen heads). An
    incomplete preview never carries one, so a partial preview can never
    silently discard an unscanned backlog.
    """
    proof: String
    expiresAt: DateTime
  }

  type TeamAttentionSwitchoverResult {
    applied: Boolean!
    workersAdvanced: Int!
    channelsAdvanced: Int!
  }

  "#1353 — the exact Worker/Channel cursor advanced by markOwnTeamChatRead."
  type OwnTeamChatReadState {
    workerId: ID!
    channelId: ID!
    lastSeenSeq: Int!
    "#2181 — the Channel's CURRENT incarnation (with expectedIncarnation, the value that was fenced)."
    channelIncarnation: Int!
    "#2181 — the incarnation the stored cursor was last raised under; NULL is a legacy cursor. See ChannelReadState.cursorIncarnation."
    cursorIncarnation: Int
  }

  "Spec 049 Phase 5 — what an Agent's install-created register row is made with (plan §3.5)."
  type RegisterDefaults {
    mentionOnly: Boolean!
  }

  input RegisterDefaultsInput {
    mentionOnly: Boolean
  }

  """
  Filter for the uniform memories() list (#473). All clauses AND-combine and
  only ever narrow the caller's accessible scope — with two documented slice
  SELECTIONS, each switching which readable set the list draws from (never
  widening access beyond what the caller may already read):
    - visibility: PUBLIC switches from the caller's own union (org-owned +
      org-subscribed + own user-owned) to the public marketplace slice
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
    """
    #1179 — true restricts the list to the caller's OWN ORG-LESS memories:
    organizationId IS NULL AND the caller owns it. For ALL callers INCLUDING
    platform ADMIN/OWNER (owner scope is never an admin-bypass surface), the
    same intent as AgentFilter.ownedByMe and AppFilter.ownedByMe. Org-less by
    definition, so orgId is not consulted. App-key callers (no user context)
    and impersonated sessions get an empty page. Powers the portal's
    "My memories".

    "Owns it" is PER CLASS, because Memory has two independent owner columns
    and the read gates already split on exactly this line (canReadMemoryRecord
    and the MCP canReadMemory both branch on personal/private FIRST and admit
    userId there, falling through to ownerUserId for every other class):

      - personal / private → userId, the STRICT owner;
      - every other class  → ownerUserId, the spec-047 user TENANT owner.

    This is where the memory filter is NECESSARILY wider than its Agent and
    App siblings, which have one owner column each and can say ownerUserId
    alone. Keying memories on ownerUserId alone would hand a personal memory
    to its tenant owner when the two columns differ — legal rows, since
    nothing constrains them to agree — while memory(ref:) refuses that same
    caller. Keying on the class pair alone was the ORIGINAL defect: it was
    only ever a proxy for ownership, correct while the two coincided (#1176).

    So a knowledge-class memory under a user root
    (hrn:mem:holger:holgers-gear) is in this slice, and an ORG-owned personal
    memory is not (it has an organizationId) — which matches what the
    portal's class-plus-client-side-repair query already returned.

    Composes by AND like every other clause, so it only ever narrows:
    combined with visibility PUBLIC it is empty by construction (#758
    excludes user-owned rows from the marketplace slice), and combined with
    sharedWithMe it narrows that slice rather than replacing it.
    """
    ownedByMe: Boolean
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
    """
    #2343 — restricts the list to Apps that install this Agent (the AppAgent
    join; an App has no separate primary-agent column to match). Accepts an ID
    or a fully-qualified URN. The Agent must be one the caller can read: an
    unreadable, deleted, unresolvable or nonexistent Agent yields an empty page,
    never a not-found or forbidden error. Combines with ownedByMe and orgId.
    """
    agentId: ID
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
  matching follows hrn:node:hadronmemory.com:specs:cor:acl:070:02: public identifiers
  (handle, githubUsername) match by substring, email by exact equality, and
  name only for platform admins or live co-members of an organization. Platform
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
    "Spec 049: the scope the Memory + Node slices ran under (see FindNodesResult.scope). Null when no scope applied."
    scope: SearchScopeInfo
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

  """What the caller intends to do with the plan. It decides the ACTION, never the class."""
  enum SkillPlanIntent {
    """Corpus judgment only: findings, no files consulted, no bodies returned."""
    LINT
    """Classes and findings for files the client found. Never returns a body."""
    STATUS
    """Classes, findings, and the rendered body for anything the client should write."""
    EXPORT
  }

  """What the client saw of ONE file on disk. The server never reads the caller's disk."""
  input SkillFileFactsInput {
    """The directory the skill occupies — compared against the node's stored name."""
    dirName: String!
    """The id value from the provenance header; omit on a header generation that predates it."""
    nodeId: String
    """The source URN from the provenance header."""
    sourceUrn: String
    """The hash value from the header; omit for a legacy header that carries none."""
    headerHash: String
    """The hash the client computed over the file itself."""
    fileHash: String
    "The positive rev=N value from provenance. Null means an older artifact omitted it."
    revision: Int
    """True when the file exists and could not be parsed."""
    parseFailed: Boolean
    """True when the file carries frontmatter keys the renderer never writes."""
    hasExtraFrontmatter: Boolean
  }

  input SkillPlanInput {
    intent: SkillPlanIntent!
    """Memory refs for LINT/STATUS only. EXPORT refuses this field, even an empty list."""
    memories: [String!]
    """Persisted Scope ID for a narrowed EXPORT. Omit for unscoped export; explicit null refuses. Membership is resolved afresh for each call."""
    scopeRef: ID
    """
    Target host, named by its D12 declaration key verbatim. Supported hosts: claudeSkill, codexSkill. Default: claudeSkill. One host per call; the plan reads that host's declaration and applies its limits, and the retired top-level skill/claudeSkill keys alias to claudeSkill only. An unknown host is refused with BAD_USER_INPUT naming the supported hosts, never judged as another host and never answered with an empty plan.
    """
    host: String
    """What the client found on disk. Empty for lint, which touches no disk."""
    files: [SkillFileFactsInput!]
    """With EXPORT only, explicitly override local-edit or missing-provenance-ID protection for this invocation."""
    force: Boolean
  }

  """Plan installed individual skill files for explicit task refs; plugin exports use skillPlan."""
  input SelectedSkillFilePlanInput {
    """Nonempty node IDs or fully qualified node URNs. Relative locs are refused."""
    nodes: [String!]!
    host: String
    files: [SkillFileFactsInput!]
    force: Boolean
  }

  """One lint result, carrying the node and memory so a renderer never looks them back up."""
  type SkillFinding {
    urn: String!
    memory: String!
    rule: String!
    """Either error or warning — the same vocabulary spec lint renders."""
    severity: String!
    message: String!
  }

  """A client-side filesystem action planned by the server. It does not claim that I/O occurred."""
  enum SkillExportAction {
    WRITE
    MOVE
    REMOVE
    SKIP
    REFUSE
    FAIL
  }

  """One server-owned reason for an export action."""
  type SkillExportReason {
    """Stable machine-readable reason, usually a drift class or lint rule."""
    code: String!
    """Actionable text clients can display without recreating server policy."""
    message: String!
  }

  """
  The server's filesystem plan for one skill. The client still performs and
  reports actual local I/O; this object records only what the server judged safe.
  """
  type SkillExportPlanEntry {
    action: SkillExportAction!
    """True when the client must leave any installed file unchanged."""
    preservesExistingFile: Boolean!
    reasons: [SkillExportReason!]!
  }

  type SkillPlanEntry {
    urn: String!
    nodeId: String!
    "Authoritative current node revision used in rendered provenance."
    revision: Int!
    """The stored skill name (D12 retired derivation)."""
    name: String!
    """
    One of: current, stale, locally-edited, renamed, never-exported, orphaned,
    unhashed, collision, unavailable, disabled. Null when the file could not be
    parsed — a parse failure is reported as a FAILURE, not as a class.
    """
    class: String
    """True when the file exists and does not parse. Reported identically by status and export."""
    parseFailure: Boolean!
    """Source directory selected for a MOVE or REMOVE action; also reported for the renamed class."""
    movedFrom: String
    findings: [SkillFinding!]!
    """
    Present only for EXPORT, only for a class whose action writes, and only
    when the node has no error findings — so a client cannot write a file the
    server already judged broken.
    """
    renderedBody: String
    """
    Present only for EXPORT. This is a planned action and its server-owned
    reasons, not evidence that the client completed a filesystem write.
    """
    exportPlan: SkillExportPlanEntry
    """Why an enabled source is out of export in STATUS or EXPORT, or null when this category does not apply. Separate from the planned filesystem action."""
    outOfExportReason: String
  }

  """A file that paired with no declared node. Never removed without an explicit prune."""
  type SkillOrphan {
    dirName: String!
    sourceUrn: String
    nodeId: String
  }

  """A named task that cannot produce a host entry. An unavailable ref reveals no node metadata."""
  type SkillSelectionResult {
    ref: String!
    nodeId: String
    action: SkillExportAction!
    reason: SkillExportReason!
  }

  """The live, access-intersected Scope selection used by this EXPORT plan."""
  type SkillPlanScopeSelection {
    id: ID!
    name: String!
    readableMemoryCount: Int!
    droppedCount: Int!
    """Stable digest for comparing separate host plans from one export."""
    fingerprint: String!
  }

  type SkillPlan {
    entries: [SkillPlanEntry!]!
    orphans: [SkillOrphan!]!
    """True for scoped or selected exports: out-of-selection files are not classified as orphans."""
    orphanAssessmentSkipped: Boolean!
    """Non-null only when EXPORT selected a persisted Scope."""
    scopeSelection: SkillPlanScopeSelection
    """Opaque unavailable refs and selected nodes with no declaration for this host."""
    selectionResults: [SkillSelectionResult!]!
    """
    How many nodes carrying ANY declaration key were in scope. A plan over an
    empty corpus and a plan the caller cannot see are otherwise the same empty
    list, and a client that cannot tell them apart reports nothing-to-do for a
    corpus it was denied.
    """
    scanned: Int!
    """
    How many of those were judged for THIS host — the number of entries. A node
    declaring only another host is scanned and not judged, so the two differ by
    design; the gap is a fact about the corpus, not a discrepancy.
    """
    judged: Int!
    """
    Nodes in scope carrying a key under properties.exports that names no host
    (#1292, cor:agt:030:06): an unrecognised key is reported, never read as an
    alias, and never blocks anything. HOST-INDEPENDENT: the list is identical
    in every host's plan, because the key belongs to none of them, so a client
    reports each node once rather than once per host. A node here may also
    have an entry, when it declares a known host too; one declaring only
    unknown keys has none, and is part of the scanned-minus-judged gap.
    """
    unrecognized: [SkillPlanUnrecognized!]!
  }

  """A node carrying one or more exports keys that name no host (#1292)."""
  type SkillPlanUnrecognized {
    urn: String!
    nodeId: String!
    """The node's display name, not a skill name: an unrecognised key has no host, so it declares no skill name anyone reads."""
    name: String!
    memory: String!
    """How many unrecognised keys the node carries — the true total, whether or not each is listed."""
    keyCount: Int!
    """
    The unrecognised keys LISTED, in UTF-8 byte order — e.g. codex for
    properties.exports.codex. At most 10, and none over 128 bytes: the report
    is bounded because properties is writer-controlled. keyCount is the total;
    anything not listed is counted in one extra warning, never dropped silently.
    """
    keys: [String!]!
    """One warning per listed key, plus one for any not listed. Attributed to no host; never blocks."""
    findings: [SkillFinding!]!
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

  enum NodeMoveLinkStatus { MISSING RETARGETED AMBIGUOUS }

  type NodeMoveLinkWarning {
    nodeId: ID!
    nodeLoc: String!
    raw: String!
    target: String!
    "RETARGETED names a different node; AMBIGUOUS has multiple live alias claimants."
    status: NodeMoveLinkStatus!
  }

  """
  #1885 (hrn:node:hadronmemory.com:specs:cor:dmo:050:14) - the base Agent an
  inherited node comes from.
  """
  type InheritedFrom {
    agentId: ID!
    "The base Agent's URN, fully qualified."
    agentUrn: String!
  }

  """
  #1892 (hrn:node:hadronmemory.com:specs:cor:dmo:050:15) - one task on an Agent's task list.
  """
  type AgentListedTask {
    "The task. A base's task, listed through the Agent, keeps its own URN and carries inheritedFrom."
    node: Node!
    "The name of the index edge that lists it; null for a task no index edge lists."
    trigger: String
    "#2421 experimental symptom search: which retriever ranked this task; null on the unfiltered list."
    matchedBy: AgentTaskMatchedBy
  }

  "#2421 experimental symptom search: membership in the hybrid ranking inputs."
  enum AgentTaskMatchedBy {
    "Ranked by the vector retriever."
    VECTOR
    "Ranked by the keyword retriever."
    KEYWORD
    "Ranked by both retrievers."
    BOTH
  }

  "#1892 (hrn:node:hadronmemory.com:specs:cor:dmo:050:16) - how an Agent takes part in a process."
  enum AgentProcessKind {
    "Listed in the Agent's processes index: a process it starts or owns."
    STARTS
    "Derived: the process has a stage edge to one of the Agent's tasks."
    INVOLVED
  }

  """
  #1892 (hrn:node:hadronmemory.com:specs:cor:dmo:050:16) - one process on an Agent's process list.
  """
  type AgentListedProcess {
    node: Node!
    kind: AgentProcessKind!
    "The name of the index edge that lists it, for STARTS; always null for INVOLVED."
    trigger: String
  }

  "Explicit writer-only tombstone content; no generic entity relations. hrn:node:hadronmemory.com:specs:cor:dmo:010:04"
  type RecoveryNode {
    id: ID!
    urn: String!
    memoryId: ID!
    loc: String!
    name: String!
    nodeType: String!
    description: String
    deletedAt: DateTime!
    content: String
  }
  type RecoveryNodeSummary {
    id: ID!
    urn: String!
    memoryId: ID!
    loc: String!
    name: String!
    nodeType: String!
    deletedAt: DateTime!
  }
  type RecoveryNodesPage { items: [RecoveryNodeSummary!]!, total: Int! }
  type RecoveryEndpoint { id: ID!, urn: String!, loc: String!, name: String!, deletedAt: DateTime }
  type RecoveryGraphEdge { id: ID!, name: String, source: RecoveryEndpoint!, target: RecoveryEndpoint! }
  type RecoveryEdgesPage { items: [RecoveryGraphEdge!]!, total: Int! }

  """#2046 — the result of a compile: the new unapproved revision of the compiled node."""
  type CompiledBootPrompt {
    node: Node!
    "The revision this compile wrote."
    revNo: Int!
    "SHA-256 hex of the compiled text."
    contentHash: String!
    "Whether this compile wrote the pointer."
    pointerSet: Boolean!
    "Always false: a compile never approves or signs."
    approvalIssued: Boolean!
  }

  type Node {
    "Deletion marker. Ordinary reads still omit tombstones; explicit recovery is writer-only."
    deletedAt: DateTime
    id: ID!
    "#1392 — warnings from a cross-memory move. Null on other Node reads; [] when a move changes no local content links. Raw content is preserved."
    moveLinkWarnings: [NodeMoveLinkWarning!]
    "#1323 — current live revision. Creation is revision 1; each committed authoring change advances it. NodeRevision.revNo N is the retained snapshot of this node when revision N was current, before the edit that advanced it."
    revision: Int!
    "#1326 — attribution of this content state. Null means legacy or unknown. Task identity is redacted unless its memory is independently readable."
    authorship: NodeAuthorship
    "#1326 — advisory validation for this exact revision. A report for an older revision is STALE."
    contentValidation: NodeContentValidationStatus!
    "#1591 — whether the current revision is approved, and the latest approval on record."
    approvalStatus: NodeApprovalStatus!
    "#1591 — whether this node is minted, and the record of it."
    mintStatus: NodeMintStatus!
    "#2048 (hrn:node:hadronmemory.com:specs:cor:agt:040:13) — link lint for a boot-prompt source: the warnings that hold for this node as it is now, read as the caller (a target the caller cannot read is a position-only BROKEN_INCLUDE). An empty page is a real answer; null means the warnings are unavailable (a fault, or a compiled boot prompt, whose warnings read its recorded provenance). Lint never blocks a write, and nothing is stored or pushed. Pages default to 50 and clamp at 100."
    lintWarnings(first: Int = 50, after: String): LintWarningPage
    "#1632 (hrn:node:hadronmemory.com:specs:cor:dmo:130:06) — the node's signatures and their derived states, current signers first. Batch-loaded on list and search reads. An encrypted node reads NOT_APPLICABLE and lists none."
    signatureStatus: NodeSignatureStatus!
    "#1632 (hrn:node:hadronmemory.com:specs:cor:dmo:130:03) — the node's signing requests, newest first, including ended ones (#10019). state filters on the effective state (an open request past its deadline is EXPIRED). first: 1–100, default 20."
    signingRequests(state: SigningRequestState, first: Int = 20): [SigningRequest!]!
    "#1610 — the Worker that created this node, when it was written in a worker session. The user is createdBy. Null for a write with no worker behind it, and for nodes written before #1610."
    createdByWorker: ActorRef
    "#1610 — the Agent behind this node's creation: a worker's role agent, an agent session, or a headless App run. Null when no agent was behind it."
    createdByAgent: ActorRef
    "#1610 — the Worker behind the last authored edit. A later authored edit with no worker behind it clears it, so it always describes the last authored edit (not the updatedAt clock, which operational writes also advance)."
    updatedByWorker: ActorRef
    "#1610 — the Agent behind the last authored edit; cleared like updatedByWorker."
    updatedByAgent: ActorRef
    "#2176 - the User behind the last authored edit, as handle and URN only (the same projection as a revision's editedByUser, and always the user that revision records). Cleared like updatedByWorker: an authored edit with no user behind it (a system job, a git sync, an API key with no account) clears it. Null also for a deleted user and for nodes last edited before #2176, which are not backfilled."
    updatedByUser: NodeRevisionEditor
    "#1606 — open and resolved discussion on this node (hrn:node:hadronmemory.com:specs:cor:dmo:110:07). Batched per request."
    commentSummary: CommentSummary!
    "#1608 — this node AS a comment (author, target, anchor revision, thread) when its nodeType is 'comment'; null for content. Lets a search hit render as feedback, never as content of its target (hrn:node:hadronmemory.com:specs:cor:dmo:110:08)."
    asComment: Comment
    memoryId: String!
    """
    The PLATFORM-kind axis (info / task / prompt / record / …). Load-bearing for
    retrieval and rendering.

    NOT 'objectType', which says which domain COLLECTION a node belongs to, and
    NOT 'role', which says what the node is FOR. Three kind-ish fields is the
    accepted price of keeping retrieval stable while roles stay open, so each
    one says what it is not — mixing them up is the predictable failure.
    """
    nodeType: String!
    """
    #725 — the COLLECTION discriminator: which domain object this node is an
    instance of, e.g. \"competitor\" / \"insight\". Validated against the memory's
    property schema when it has one. NULL for an ordinary node.

    NOT 'nodeType' (the platform-kind axis, which drives retrieval) and NOT
    'role' (what the node is for; role can be filtered explicitly but does not
    change default ranking or rendering).
    """
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
    """
    #1885 (hrn:node:hadronmemory.com:specs:cor:dmo:050:14) - set when this node
    was read through an Agent that extends a base: the node belongs to that
    base's system memory and comes into the Agent's effective system memory by
    inheritance. The node keeps its own address (its urn is the base's); this
    names the base it comes from. Null for a node read in its own memory.
    """
    inheritedFrom: InheritedFrom
    """
    #1450 — a server-recorded placeholder awaiting authored content, such as a
    RESERVED spec citation created by reserveSpecCitation. A placeholder may
    exist in any memory; it is never inferred from an empty body. Writing real
    nonblank content through the spec door or shared mirror write path clears
    it. Placeholders block minting.
    """
    isPlaceholder: Boolean!
    isLink: Boolean!
    name: String!
    alias: String
    description: String
    "Paragraph-length summary of this node. Opt-in on hadron_get_node via the contentScope parameter. hadron_find_nodes preview surfacing ships in spec 031 US2 — not yet live. Never surfaced in hadron_list_nodes. Cap is 2000 characters; longer values are rejected with NodeAbstractTooLongError. Empty + whitespace-only values normalize to null. Spec 031."
    abstract: String
    "Spec 032 — fingerprint of the content value at the time abstract was authored. SHA-256 of plaintext content, truncated to 8 hex chars. Compared at read time against computeContentHash(node.content) to detect staleness: the abstract may not reflect current content when the two differ, OR when this is NULL on a node that has both an abstract and content (#1128 — an abstract written before the body existed was never fingerprinted, so it has never been checked against it; that reads as unverified, not as verified). NULL is only a clean state when the node has no abstract, or no content for the abstract to describe. Note restoreNodeRevision restores this field verbatim, so restoring a snapshot taken while it was NULL reinstates the unverified state — correctly, since that abstract has never been checked against the restored content. System-managed; never settable via NodeInput."
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
    """
    The node's text. Include tags and data variables resolve for the reader
    (hrn:node:hadronmemory.com:specs:cor:dmo:150:03); pass raw: true for the stored text with its tags as
    written. Through nodeBatch, an omitted raw returns the stored text
    permanently (R21 A) and raw: false resolves.
    """
    content(raw: Boolean): String
    tokens: Int
    tags: [String!]!
    properties: JSON
    data: JSON
    seq: Int
    ownerRepo: String
    """
    Whether this node can be run as a task (nullable; #513) — it drives the tree
    action indicator, and since #1201 it is also the CAPABILITY gate for the
    task kind: a write that would PRODUCE a runnable node must come through
    createTaskNode / updateTaskNode. Gated here rather than on a label because
    omitting a label is free, while omitting this means the node does not run.
    """
    isRunnable: Boolean
    """
    #1201 — what this node is FOR, as an OPEN string. A closed governed
    subset has dedicated authoring doors; memory role rules can additionally
    constrain arbitrary roles.

    NOT 'nodeType' (the platform-kind axis, load-bearing for retrieval) and NOT
    'objectType' (the collection discriminator, schema-validated). This field
    does not change default retrieval or ranking; NodeFilter.role explicitly
    selects its exact dotted family (#1322).

    A GOVERNED family routes the write to that kind's own authoring door, and
    the generic node surface is refused: 'review' / 'review.*' and 'spec' /
    'spec.*' and 'decision' / 'decision.*', alongside the task kind, which is
    gated on 'isRunnable'
    rather than on any label because a label can be omitted and a capability
    cannot. Other roles do not invoke a governed door, but can still be
    constrained by memory role rules and selected by explicit role filters.
    """
    role: String
    llmModel: String
    aiAgent: String
    createdAt: DateTime!
    updatedAt: DateTime!
    """
    #2193: this node's memory record, exactly as Query.memory answers it to the
    caller, or null when the caller may not read that record (or it is
    deleted). Seeing a node does not grant its memory's record, so use urn or
    memoryId for the address. Always null on an inherited node.
    """
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

  """
  Which server-owned mechanism governs an edge (#2124). A governed edge is
  written by its own path and refused by every ordinary edge write. A client
  must tolerate a value it does not know as read-only/unsupported, never as an
  ordinary edge: this list grows when the server adds a governed kind.
  """
  enum EdgeGovernedKind {
    "Derived from an include tag in the source node's content (#2040)."
    INCLUDE
    "A comment's anchor edge to the node it comments on."
    COMMENT_ANCHOR
    "A reply comment's edge to its thread root."
    COMMENT_REPLY
  }

  type Edge {
    id: ID!
    "The live source node, or null when deleted or when its memory is unreadable. Cross-memory edges never grant access to an otherwise unreadable endpoint. Deleted-node inspection uses the explicit recovery graph."
    source: Node
    "The live target node, or null when deleted or when its memory is unreadable. Deleted-node inspection uses the explicit recovery graph."
    target: Node
    "Fully-qualified edge URN (hrn:edge:<root>:<memory>:<loc>), composed server-side from the edge's (source-side) memory URN + loc (#481 parity — edges are loc-addressed peers of nodes, spec 037)."
    urn: String!
    """
    Colon-delimited path within the (source node's) memory — the edge's
    identity and the suffix of its URN hrn:edge:<root>:<memory>:<loc>.
    """
    loc: String!
    """
    Free-form relationship name (e.g. imports, depends_on). Optional since
    spec 037 — loc is the identity. (Was the required 'label'.)
    """
    name: String
    """
    Longer gloss carried for API consumers. NOT rendered on agent node reads,
    whose Related:/Referenced by: lines show the edge name (#721: name is the
    display label). Put the label you want seen in name (#1057).
    """
    description: String
    """
    If true, this edge can be executed/run (task automation, conversation
    transitions). Mirrors Node.isRunnable.
    """
    isRunnable: Boolean
    """
    JSONLogic gating expression. Null = always fires. Validated against
    the v1 operator subset and the FOUR variable scopes — memory.*, chat.*,
    agent.*, message.data.* (VALID_SCOPE_PREFIXES; anything else is
    UNKNOWN_SCOPE). The time builtins now() and today() are a SEPARATE
    constant, not a fifth scope: they are whole references rather than
    prefixes, and the evaluator pre-resolves them from the request clock.
    Until #1246 this said "five variable scopes" and listed the builtins as
    one of them — a count and a category error in one sentence.
    See hadron-docs/docs/reference/edge-conditions.md.
    """
    condition: JSON
    """
    Resolution-order hook (lower = earlier; default 0). When two edges
    share a priority, fall back to insertion order.
    """
    priority: Int!
    data: JSON
    """
    The edge's OWN stored governed kind (#2124): null for an ordinary edge,
    otherwise INCLUDE, COMMENT_ANCHOR or COMMENT_REPLY. Read-only; it rides
    the same gate as the edge, is never inferred from name or loc, and no
    edge write accepts it. A stored value this server does not support is an
    UNSUPPORTED_EDGE_GOVERNED_KIND error, never null.
    """
    governedKind: EdgeGovernedKind
  }

  "#2288: derived per-session state; ENDED means terminal, not necessarily an explicit end."
  enum SessionState {
    LIVE
    LAPSED
    DORMANT
    ENDED
  }

  """
  A unit of work recorded against a user or App: the general row, and what the
  bare word "session" means throughout this schema (#1034). \`type\` says which
  kind — DEVELOPER, CHATBOT, AUTOMATION, EDGE — and \`workerId\` is optional.

  A **worker session** is the subtype with \`workerId\` set: a Worker (named
  casting) bound to a driver, which is what makes work attributable to a
  teammate and what a merged PR traces back through. Binding is optional, so a
  list of these is not a staff view and may hold no worker sessions at all —
  read \`workerId\` per row rather than assuming either way.

  A **chat session** is NOT one of these and has no row here: it is the
  conversation a human is in — the Claude Desktop window, the Claude Code
  session, the IDE chat. The two are independent and **ending one does not end
  the other**: a chat session that closes leaves its worker session open
  until endSession. Since #1114 nothing ends it for inactivity — silence is not
  evidence of abandonment — but it stops reading as LIVE once nobody has driven
  it inside its idle window, so the stale session stops blocking another bind
  without being ended or losing its unwritten handoff. That changes no HOLD: a
  human-held name stays held until explicit release, so only its holder can bind
  it again. Do not use "chat session" for a Chat (the agent conversation entity)
  — that is an **agent chat**, a third concept.
  """
  type Session {
    id: ID!
    "Which kind of session this is: DEVELOPER, CHATBOT, AUTOMATION or EDGE."
    type: String!
    appId: String
    userId: String
    "The role-agent driving the session (with workerId set, the agent behind the casting)."
    agentId: String
    "#2458 (hrn:node:hadronmemory.com:specs:cor:dmo:050:11): the worker's role when this session was bound; it does not follow a later change of the worker's agent. Null without a worker."
    role: String
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
    """
    #1707 — the model family this session runs as (hrn:node:hadronmemory.com:specs:cor:agt:060:04): given at
    start, or derived from llmModel then tool; null when it could not be
    classified. A bound worker's family is its newest open session's. A matching
    input only, never an authorization input: it is self-declared.
    """
    family: String
    "#1709 — a host-launched session (hrn:node:hadronmemory.com:specs:cor:agt:070:08): the host that started it. Null for a session started by hand."
    launchHostId: String
    "#1709 — the worker.start operation that launched it."
    launchOperationId: ID
    "#1709 — the task it was launched for; null for a manager's start without one."
    launchTaskId: ID
    "#1709 — who issued the start: platform (an assignment) or manager."
    launchIssuedBy: String
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
    "#1156 — hrn:node:hadronmemory.com:specs:cor:dmo:070:05: null while open; stamped cause after end, unknown for legacy ends. Readable wherever this Session is; no ending actor."
    endReason: SessionEndReason
    autoExpiredAt: DateTime
    """
    hadron-cli#791 / hrn:node:hadronmemory.com:specs:cor:agt:020:11:
    whether THIS session is live: not ended
    or hard-expired (hrn:node:hadronmemory.com:specs:cor:agt:020:03),
    AND driven inside its type's idle window (activity is the latest of
    startedAt, the heartbeat updatedAt, and the latest attributed usage
    event, capped at endedAt). The same derived predicate as startSession's
    WORKER_TAKEN gate and Worker.hasLiveSession, so the three always agree.
    An unexpired open session that is not live has LAPSED: nobody drove it inside the
    window, so another driver may bind its worker; it is not ended, and can
    still be ended with a handoff. False for an ended or deleted session.
    """
    isLive: Boolean!
    """
    #2288 / hrn:node:hadronmemory.com:specs:cor:agt:020:13:
    this session's derived state, using its own App's dormancy period (platform
    default when App-less), never the viewer's App. ENDED means terminal: an
    explicit/reaped end, deletion, or now >= promised expiresAt before reap.
    It does not assert an explicit ending act. Otherwise DORMANT uses the same
    activity and strict older-than threshold as the resume refusal. At exact
    dormancy equality it is not dormant. LIVE includes idle deadline equality;
    hard expiry is exclusive even when the deadlines coincide. The remaining
    open sessions are LAPSED. Reading state never drives or resumes a session.
    """
    state: SessionState!
    """
    #1617 / #1036: the earlier of last activity plus the type's idle window
    and a promised expiresAt (hrn:node:hadronmemory.com:specs:cor:agt:020:03).
    The idle deadline is inclusive; a hard expiry is exclusive: the session
    is expired at now >= expiresAt, even before the reaper runs. Driving it
    can renew its idle deadline, never its promised expiry. Null for an
    ended or deleted session.
    """
    lapsesAt: DateTime
    events: [UsageEvent!]!
  }

  """
  #1956 (hrn:node:hadronmemory.com:specs:cor:agt:020:03) — what resumeSession did. RESUMED: bound to an open
  session (a shed's claim, or the one live session of the fast path). STARTED:
  the claimed session had ended (a rotation), so the worker's next session was
  started. CHOOSE: several candidates, nothing bound or consumed; call again with
  \`session\` set to the one the human picks.
  """
  enum ResumeOutcome { RESUMED STARTED CHOOSE }

  "#1956 — where a resume candidate came from: an unused resume claim, or (with no claim) a live bound session."
  enum ResumeSource { CLAIM LIVE_SESSION }

  "#1956 — one of the caller's own sessions offered by a CHOOSE answer. Never carries a claim id."
  type ResumeCandidate {
    "The session to pass back as resumeSession(input: { session }) to pick this one."
    sessionId: ID!
    workerId: ID!
    workerName: String!
    "The session's description (its plan), when it has one."
    description: String
    source: ResumeSource!
    "When the claim lapses; null for a live session."
    expiresAt: DateTime
  }

  "#1956 — the answer to resumeSession: the bound session, or the candidates to choose from."
  type ResumeSessionResult {
    outcome: ResumeOutcome!
    "The bound session for RESUMED and STARTED; null for CHOOSE."
    session: Session
    "Empty unless outcome is CHOOSE."
    candidates: [ResumeCandidate!]!
  }

  "#1956 — the receipt of a written resume claim. It names no claim id: redemption is judged by the caller's token."
  type ResumeClaimReceipt {
    sessionId: ID!
    workerId: ID!
    expiresAt: DateTime!
  }

  "#1956 — resumeSession's optional input. Provenance for a session the redemption starts; on an open session it resumes, only \`llmModel\` and \`family\` are refreshed (#2086)."
  input ResumeSessionInput {
    "Pick one of a CHOOSE answer's candidates by its sessionId."
    session: ID
    "What the next session is about, when the redemption starts one (its plan)."
    description: String
    "Recorded on a session the redemption starts. Never replaces the tool of a session it resumes."
    tool: String
    "Recorded on a session the redemption starts only."
    host: String
    "Recorded on a session the redemption starts, and refreshed on an open session it resumes (#2086). Omitted or null never clears."
    llmModel: String
    "Recorded on a session the redemption starts, and refreshed on an open session it resumes (#2086). Wins over the family a model implies; an invalid token is refused before any claim is spent."
    family: String
    "Recorded on a session the redemption starts only."
    transcriptPath: String
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
    """
    Caller identity — the App that authored this event.
    """
    appId: String
    sessionId: String
    model: String
    tokensIn: Int
    tokensOut: Int
    # 046-usage-metering: billing attribution + cost snapshot.
    userId: String
    organizationId: String
    provider: String
    """
    Owner level of the API key that served the call
    (HADRON_SERVER means platform-paid; anything else is BYOK).
    """
    keyOwnerType: String
    """
    Provider cost snapshot in micro-cents (1e-8 USD), as a base-10
    integer string. Null when the (provider, model) pair is unpriced.
    """
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

  enum NodeAuthorshipKind { TASK HUMAN }
  type NodeAuthorship {
    kind: NodeAuthorshipKind!
    taskRef: String
    taskRevision: Int
    human: NodeRevisionEditor
    authoredAt: DateTime!
  }

  enum NodeContentValidationOutcome { PASS FAIL ERROR }
  enum NodeContentValidationState { UNVALIDATED STALE PASS FAIL ERROR }
  type NodeContentValidationReport {
    nodeRevision: Int!
    validationTaskRef: String
    validationTaskRevision: Int
    outcome: NodeContentValidationOutcome!
    reportedAt: DateTime!
  }
  type NodeContentValidationStatus {
    state: NodeContentValidationState!
    latestReport: NodeContentValidationReport
  }

  """
  046-usage-metering: effective-dated provider rate row. Prices are
  micro-cents (1e-8 USD) per MILLION tokens, as base-10 integer strings.
  """
  type AiModelPrice {
    id: ID!
    provider: String!
    model: String!
    """
    Pricing tier 1-3; tier 1 is the default everything resolves today.
    """
    tier: Int!
    inputMicroCentsPerMTok: String!
    outputMicroCentsPerMTok: String!
    """
    Per-tier debit markup in basis points (2500 = 25%). Null falls back
    to the CREDIT_MARKUP_PERCENT env default.
    """
    markupBasisPoints: Int
    effectiveAt: DateTime!
    createdAt: DateTime!
    createdBy: String
  }

  type AiModelPriceList {
    items: [AiModelPrice!]!
    total: Int!
  }

  """
  046-usage-metering: append-only org credit ledger row. Signed
  micro-cents as a base-10 integer string (grants +, debits -).
  """
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
    """
    Pricing tier 1-3; defaults to 1.
    """
    tier: Int
    inputMicroCentsPerMTok: String!
    outputMicroCentsPerMTok: String!
    """
    Per-tier debit markup in basis points (2500 = 25%); omit to fall
    back to the CREDIT_MARKUP_PERCENT env default.
    """
    markupBasisPoints: Int
    """
    Defaults to now. Appends a new effective-dated row - never mutates.
    """
    effectiveAt: String
  }

  input GrantCreditsInput {
    orgRef: String!
    """
    Positive micro-cents, base-10 integer string.
    """
    amountMicroCents: String!
    """
    Grant expiry policy field (no enforcement in Phase 0).
    """
    expiresAt: String
    """
    Idempotency + provenance pair (both or neither), e.g.
    ('stripe-checkout', <session id>). (sourceType, sourceId) is unique
    across the ledger - re-granting the same pair returns the EXISTING
    entry instead of double-crediting (at-least-once webhook safety).
    """
    sourceType: String
    sourceId: String
    note: String
  }

  "#1591 — whether a node's approval still covers its current text (#1611: title, abstract and content under approval-hash v1; a metadata-only revision keeps it)."
  enum NodeApprovalState {
    "Approval is not applicable in an encrypted memory."
    NOT_APPLICABLE
    "Never approved."
    NOT_APPROVED
    "The approval covers the current text: it was recorded at the revision in NodeApproval.revision, which can be older than Node.revision when only metadata (tags, properties, role, description, alias, loc, edges) changed since."
    APPROVED
    "Approved once, then the title, abstract or content changed (or the text no longer hashes to the approval, see verifyNode's TAMPERED)."
    SUPERSEDED
  }

  "#1591 — one recorded approval of a node revision."
  type NodeApproval {
    "The approved revision number (Node.revision at approval time)."
    revision: Int!
    "The approving user's public identifiers; null when the approver was not a user (see approvedByInfo)."
    approvedBy: NodeRevisionEditor
    "The approving principal when no user is known, e.g. app:<id>."
    approvedByInfo: String
    approvedAt: DateTime!
    "Approval hash v1 at approval time: 64 lowercase hex of SHA-256 over the canonical title/abstract/content serialization (src/lib/approvalHash.ts)."
    hash: String!
  }

  "#1591 — whether a node is minted, and the record of it. Encrypted memories read not-minted with all record fields null; not-applicable is distinguished by approvalStatus. Minting protects nothing by itself (permanence is off for now)."
  type NodeMintStatus {
    minted: Boolean!
    mintedAt: DateTime
    "The minting user's public identifiers; null when not a user (see mintedByInfo)."
    mintedBy: NodeRevisionEditor
    "The minting principal when no user is known, e.g. app:<id>, or backfill for nodes minted by the #1591 migration."
    mintedByInfo: String
    "The revision that was minted. Null for nodes backfilled as minted, whose minted revision is unknown."
    revision: Int
    "The approval hash of the minted revision. Null for backfilled nodes, which were never approved."
    hash: String
  }

  "#1632 (hrn:node:hadronmemory.com:specs:cor:dmo:130:03) — a signing request: open, then ends exactly once."
  enum SigningRequestState {
    OPEN
    "A signature was verified and recorded."
    COMPLETED
    "The eligible signer turned it down."
    DECLINED
    "Its lifetime passed (SIGNING_REQUEST_TTL_SECONDS, default 24h); endedAt is the deadline."
    EXPIRED
    "The node's title, abstract or content changed, or it entered an encrypted memory."
    STALE
    "The requester account withdrew it."
    WITHDRAWN
  }

  "#1632 (hrn:node:hadronmemory.com:specs:cor:dmo:130:04) — a signature's state, derived on every read. An invalid record is never a signature: it is counted in NodeSignatureStatus.integrityProblems instead."
  enum SignatureState {
    "Verifies, and the title/abstract/content has not changed since it was made."
    CURRENT
    "Verifies, but the content changed since; restoring the old text never makes it current again."
    EARLIER
    "Made by a first passkey still in its cooling-off window; never counts until the window ends normally."
    PENDING
    "Made by a first passkey revoked inside its window; never counts."
    CANCELLED
    "The node is in an encrypted memory, where signing does not apply."
    NOT_APPLICABLE
    "The node left an encrypted memory it carried this signature into; never counts again. (Derivation lands with E2.)"
    ENDED_ENCRYPTED_MEMORY
  }

  "#1632 — who asked for a signature. The requester account is userId, else appId (#10397)."
  type SigningRequester {
    userId: ID
    "Set only when an App key itself asked."
    appId: ID
    "The Worker whose session made the request, when one did."
    workerId: ID
    sessionId: ID
  }

  "#1632 (hrn:node:hadronmemory.com:specs:cor:dmo:130:03) — a request for a person to sign one node's content, pinned at creation."
  type SigningRequest {
    "128 bits of randomness."
    id: ID!
    nodeId: ID!
    nodeUrn: String
    "The revision pinned at creation."
    revision: Int!
    "The approval hash v1 of the pinned content (64 lowercase hex)."
    approvalHash: String!
    "The signature payload version the signer signs: hadron-signature-v1 until S2b-2's v3."
    payloadVersion: String!
    "The effective state."
    state: SigningRequestState!
    "Null: any writer of the node's memory may sign."
    namedSigner: NodeRevisionEditor
    requestedBy: SigningRequester!
    createdAt: DateTime!
    expiresAt: DateTime!
    "Null while OPEN. EXPIRED ends at expiresAt; every other end at the moment it happened (DB clock)."
    endedAt: DateTime
    "The signature that completed it; null unless COMPLETED (and when the record does not verify)."
    signature: NodeSignature
  }

  "#1632 (hrn:node:hadronmemory.com:specs:cor:dmo:130:06, hrn:node:hadronmemory.com:specs:cor:dmo:130:07) — one signature on a node. Only the passkey's label is ever shown."
  type NodeSignature {
    id: ID!
    signer: NodeRevisionEditor
    passkeyLabel: String!
    "When the signer's passkey was revoked, if it was; the signature keeps its state."
    passkeyRevokedAt: DateTime
    "The revision it was made on."
    revision: Int!
    verifiedAt: DateTime!
    signingRequestId: ID!
    payloadVersion: String!
    state: SignatureState!
  }

  "#1632 — a node's signatures."
  type NodeSignatureStatus {
    "CURRENT if any signature is current, else the best of PENDING, EARLIER, CANCELLED; NOT_APPLICABLE on an encrypted node; null with no signatures."
    state: SignatureState
    "Current signers first, then newest first."
    signatures: [NodeSignature!]!
    "Records that fail re-verification: reported, never listed as signatures."
    integrityProblems: Int!
  }

  "#1591 — a node's approval state plus its latest approval."
  type NodeApprovalStatus {
    state: NodeApprovalState!
    "The latest approval on record; null when NOT_APPROVED or NOT_APPLICABLE."
    approval: NodeApproval
  }

  "#1591 — the tamper check's verdict."
  enum NodeIntegrityState {
    "The current revision is approved and its text still hashes to the approval."
    INTACT
    "Approved text no longer hashes to its approval: it changed outside the revision system."
    TAMPERED
    "Edited (a new revision) since the last approval. Not a tamper finding."
    SUPERSEDED
    "Never approved: nothing to verify against."
    NOT_APPROVED
  }

  "#1591 — one node's tamper check."
  type NodeIntegrityCheck {
    nodeId: ID!
    urn: String!
    loc: String!
    state: NodeIntegrityState!
    "The current revision."
    revision: Int!
    approvedRevision: Int
    "The approval hash on record."
    expectedHash: String
    "The approval hash recomputed from the current title/abstract/content."
    actualHash: String!
  }

  "#1591 — the tamper check over every live node of a memory."
  type MemoryIntegrityReport {
    checked: Int!
    intact: Int!
    tampered: Int!
    superseded: Int!
    notApproved: Int!
    "Every node that is not INTACT, ordered by loc."
    problems: [NodeIntegrityCheck!]!
  }

  "#1591 — a node and its approval, returned by the approve mutations."
  type NodeApprovalReceipt {
    nodeId: ID!
    urn: String!
    loc: String!
    approval: NodeApproval!
    "#2048 — the link-lint warnings for this node as they hold now; the same data as Node.lintWarnings. Approving never blocks on a warning."
    lintWarnings(first: Int = 50, after: String): LintWarningPage
  }

  "#2048 (hrn:node:hadronmemory.com:specs:cor:agt:040:13) — what link lint warns about."
  enum LintKind {
    "The include's target is soft-deleted (hrn:node:hadronmemory.com:specs:cor:agt:040:13, R20 A)."
    RETIRED_TARGET
    "The target is readable but has no revision that meets the include's settings (approved and/or rev=N)."
    NO_QUALIFYING_REVISION
    "The include pins a revision and a newer revision is approved."
    PINNED_NEWER_APPROVED
    "The include says signed; signing is not checked yet."
    SIGNING_NOT_CHECKED
    "The target is missing or the caller cannot read it. Position only: it never says which, or anything about the target."
    BROKEN_INCLUDE
  }

  "#2048 — one link-lint warning. A fixed set of fields: there is no free-form detail."
  type LintWarning {
    kind: LintKind!
    "0-based offset of the include tag in the node's source text."
    position: Int!
    text: String!
    "The target's URN, only for a target the caller can read; null for BROKEN_INCLUDE."
    targetUrn: String
    "The revision the include pins, when it pins one."
    pinnedRevision: Int
    "The newest approved revision, for PINNED_NEWER_APPROVED."
    newerRevision: Int
    "Reserved for the policy-agent override notice; null for source lint."
    overriddenNodeLoc: String
    "Reserved for the worker signature/trailer lint; null for source lint."
    workerField: String
  }

  "#2048 — one page of warnings, ordered by position."
  type LintWarningPage {
    items: [LintWarning!]!
    "All warnings that hold, not just this page."
    total: Int!
    "Pass as after for the next page; null on the last."
    nextCursor: String
  }

  "#1591 — the outcome of approving every node of a memory."
  type ApproveMemoryNodesResult {
    approvedCount: Int!
    "Nodes newly approved by this call, ordered by loc."
    approved: [NodeApprovalReceipt!]!
    "Nodes whose current revision was already approved (left unchanged)."
    alreadyApprovedCount: Int!
    "Locs of reserved placeholders, which have no spec to approve yet."
    skippedPlaceholders: [String!]!
    "#1641 — decisions and decision logs in this memory, which bulk approval never approves: a decision is approved individually by one of its deciders."
    skippedDecisionCount: Int!
    "#1641 — the first 50 of those, by loc."
    skippedDecisions: [String!]!
    "#2043 — boot prompts in this Agent system or App install memory that this caller may not approve: only the Agent's or App's manager approves them, as themselves, never through a worker session."
    skippedBootPromptCount: Int!
    "#2043 — the first 50 of those, by loc."
    skippedBootPrompts: [String!]!
    "#1607 — unminted nodes of this memory with open discussion: a warning, never a blocker (hrn:node:hadronmemory.com:specs:cor:dmo:110:07). Ordered by loc."
    unresolvedFeedback: [UnresolvedFeedback!]!
  }

  "#1610 — public identity of a Worker or Agent that wrote a node: never the full object, whose own read gate this does not pass."
  type ActorRef {
    id: ID!
    name: String!
    "The canonical hrn:worker:/hrn:agent: URN. Null when it cannot be composed."
    urn: String
  }

  "#1641 — a decision's derived state (hrn:node:hadronmemory.com:hadron-server:design:decision-nodes §6.3). Computed by the one evaluation on every read, never stored. Precedence: TAMPERED, UNVERIFIABLE, WITHDRAWN, SUPERSEDED, STALE, DECIDED, ANSWERED_UNCONFIRMED, OPEN."
  enum DecisionState {
    "Not every part is answered."
    OPEN
    "Every part is answered; the tier's evidence (a decider's approval, or later a signature) is missing at the current revision."
    ANSWERED_UNCONFIRMED
    "Answered, and the tier's evidence by a decider is intact at the current revision. The only state a ruling may be relied on in."
    DECIDED
    "Evidence exists, but for an earlier revision: the decision changed after it was approved."
    STALE
    "The rendered content, the structured payload and the approval hash disagree: changed outside the decision operations."
    TAMPERED
    "Written by a codec or renderer this server does not know, so it cannot be verified (fail closed)."
    UNVERIFIABLE
    WITHDRAWN
    SUPERSEDED
  }

  "#1641 — the assurance a decision's answer needs. APPROVED: a decider's approval. SIGNED: a decider's passkey signature (#1614; not available yet, so a SIGNED decision stays ANSWERED_UNCONFIRMED)."
  enum DecisionTier {
    APPROVED
    SIGNED
  }

  enum DecisionUrgency {
    NORMAL
    URGENT
  }

  "#1641 — list order. PORTAL_DEFAULT: urgent first, then open before answered, then newest ask. CODE: code order."
  enum DecisionSort {
    PORTAL_DEFAULT
    CODE
  }

  "#1641 — where an answer was given, as the answering caller states it (a claim)."
  enum DecisionAnswerVia {
    PORTAL
    CLI
    MCP
    CHAT_RECORDED
    IMPORT
  }

  "#1641 — a reference: exactly one of an external ref (hadron-server#1640, team:6783), a node id or URN, or a spec citation."
  type DecisionRef {
    ref: String
    node: String
    spec: String
  }

  input DecisionRefInput {
    ref: String
    node: String
    spec: String
  }

  "#1641 — an authenticated actor: taken from the principal, never supplied by a client. Public projections only (#552)."
  type DecisionActor {
    userId: ID
    workerId: ID
    appId: ID
    user: CommentActorRef
    worker: CommentActorRef
    app: CommentActorRef
  }

  type DecisionOption {
    "The option id an answer names."
    key: String!
    label: String!
    meaning: String
    cost: String
  }

  type DecisionRecommendation {
    key: String!
    "Who recorded the recommendation (authenticated)."
    by: DecisionActor!
    reason: String
    "A relayed recommendation's original author, as a claim."
    attributedTo: String
  }

  type DecisionAnswer {
    "The chosen option; null for a free-text answer."
    key: String
    text: String
    freeform: Boolean!
    "The decider whose credential recorded it."
    byUserId: ID!
    at: DateTime!
    via: DecisionAnswerVia!
    "Where the answer was given (a claim)."
    source: DecisionRef
    reason: String
    "An imported answer's recorded speaker (a claim, never rendered as the authenticated answerer)."
    claimedBy: String
    recordedByUserId: ID
  }

  type DecisionPart {
    "Permanent within the decision; amendments add parts, never renumber."
    n: Int!
    "The citation of this part, e.g. DU-1."
    citation: String!
    question: String!
    options: [DecisionOption!]!
    "Null when the asker deliberately gave none (see noRecommendationReason). Never pre-selected."
    recommendation: DecisionRecommendation
    noRecommendationReason: String
    answer: DecisionAnswer
    "Earlier answers to this part, oldest first: a re-answer appends, never replaces quietly."
    answerHistory: [DecisionAnswer!]!
  }

  type DecisionApprovalEvidence {
    byUserId: ID
    by: CommentActorRef
    "The revision approved."
    revision: Int!
    approvedAt: DateTime!
    "INTACT, TAMPERED, SUPERSEDED or NOT_APPROVED: the approval hash checked against the live text."
    integrity: String!
    "Whether the approver is one of the decision's deciders (only then does it count)."
    byDecider: Boolean!
  }

  type DecisionEvidence {
    "The latest approval on record, whoever gave it."
    approval: DecisionApprovalEvidence
  }

  type DecisionWithdrawal {
    by: DecisionActor!
    at: DateTime!
    reason: String!
  }

  """
  #1641 — a human decision: a governed node (role decision) under a decision log, written only by the
  decision operations. Its content is rendered from this structured payload, so an approval covers
  exactly what was asked and answered. Plan: hrn:node:hadronmemory.com:hadron-server:design:decision-nodes.
  """
  type Decision {
    id: ID!
    urn: String!
    "The decision's own page, where its card renders. Copy it; never build it."
    portalUrl: String
    "Permanent: DA, DB, … issued in sequence by its log, never reused."
    code: String!
    n: Int!
    logId: ID
    title: String!
    urgency: DecisionUrgency!
    tier: DecisionTier!
    authorizes: Boolean!
    "Migrated history that is never usable as an authorization."
    archival: Boolean!
    "DERIVED on every read. Rely on a ruling only while it is DECIDED."
    state: DecisionState!
    context: String
    parts: [DecisionPart!]!
    "What is waiting on this decision."
    blocks: [DecisionRef!]!
    sources: [DecisionRef!]!
    "Spec citations the ruling must reach."
    followUps: [DecisionRef!]!
    deciderIds: [ID!]!
    deciders: [CommentActorRef!]!
    "True when the caller is a decider, including through an account merged into theirs (#1715)."
    viewerIsDecider: Boolean!
    "Account merges the stored user ids follow: the record keeps the merged-away id (#1715)."
    identityMerges: [DecisionIdentityMerge!]!
    askedBy: DecisionActor!
    askedAt: DateTime
    "When the last part was answered; null while any part is open."
    answeredAt: DateTime
    withdrawn: DecisionWithdrawal
    evidence: DecisionEvidence!
    "The node's current revision: the expectedRevision of the next change."
    revSeq: Int!
    node: Node
  }

  type DecisionPage {
    items: [Decision!]!
    "Matching decisions before paging."
    total: Int!
  }

  type DecisionPurge {
    code: String!
    byUserId: ID!
    by: CommentActorRef
    at: DateTime!
    reason: String!
    "sha256 of the purged decision's rendered content."
    contentHash: String!
  }

  "#1641 — a decision log's settings (never a decision, never approved)."
  type DecisionLog {
    id: ID!
    urn: String!
    portalUrl: String
    loc: String!
    name: String!
    "Codes are this prefix plus letters: D → DA, DB, …"
    prefix: String!
    "How many codes have been issued (withdrawn and purged ones included)."
    lastCode: Int!
    defaultDeciderIds: [ID!]!
    eligibleDeciderIds: [ID!]!
    "Who decides a decision asked without naming deciders."
    defaultDeciders: [CommentActorRef!]!
    "Who else a decision may name as a decider. A decision's deciders are narrowed from these, never widened."
    eligibleDeciders: [CommentActorRef!]!
    purges: [DecisionPurge!]!
    "Account merges the stored user ids follow: the record keeps the merged-away id (#1715)."
    identityMerges: [DecisionIdentityMerge!]!
    revSeq: Int!
  }

  """
  #1715 — an account merge that a user id stored in a decision or a log follows.
  Stored ids are never rewritten by mergeUsers, because they are part of the
  authenticated record: the record still names fromUserId, and that account now
  acts as toUserId. A chain of merges is listed link by link, oldest first.
  """
  type DecisionIdentityMerge {
    fromUserId: ID!
    from: CommentActorRef
    toUserId: ID!
    to: CommentActorRef
    mergedAt: DateTime!
  }

  "#1641 — verifyDecision: the one evaluation's findings."
  type DecisionVerification {
    state: DecisionState!
    "NO_BLOCK, BLOCK_INVALID, UNKNOWN_CODEC, UNKNOWN_RENDERER, RENDER_MISMATCH, DATA_MISMATCH, APPROVAL_HASH_MISMATCH."
    findings: [String!]!
    codec: String
    renderer: String
    revision: Int!
    approvedRevision: Int
    approvalIntegrity: String!
    approvalByDecider: Boolean!
  }

  input DecisionOptionInput {
    key: String!
    label: String!
    meaning: String
    cost: String
  }

  input DecisionRecommendationInput {
    key: String!
    reason: String
    "Relaying someone else's recommendation: who (recorded as a claim)."
    attributedTo: String
  }

  input DecisionNoRecommendationInput {
    reason: String!
  }

  "#1641 — one part of a decision. Give options or yesno, and a recommendation or noRecommendation."
  input DecisionPartInput {
    question: String!
    options: [DecisionOptionInput!]
    yesno: Boolean
    recommendation: DecisionRecommendationInput
    noRecommendation: DecisionNoRecommendationInput
  }

  input AskDecisionInput {
    title: String!
    urgency: DecisionUrgency
    "Default APPROVED; SIGNED when authorizes is true (APPROVED is then refused: DECISION_TIER_TOO_LOW)."
    tier: DecisionTier
    authorizes: Boolean
    "The authorization a grant decision carries (authorizes: true only)."
    grant: JSON
    "Narrows the log's default deciders; never widens past its eligible set."
    deciders: [ID!]
    context: String
    blocks: [DecisionRefInput!]
    sources: [DecisionRefInput!]
    followUps: [DecisionRefInput!]
    parts: [DecisionPartInput!]!
  }

  "#1641 — a change to an existing part (by its permanent number). Omitted fields are unchanged; answers never change here."
  input DecisionPartPatchInput {
    n: Int!
    question: String
    options: [DecisionOptionInput!]
    yesno: Boolean
    recommendation: DecisionRecommendationInput
    noRecommendation: DecisionNoRecommendationInput
  }

  input AmendDecisionInput {
    title: String
    urgency: DecisionUrgency
    tier: DecisionTier
    context: String
    blocks: [DecisionRefInput!]
    sources: [DecisionRefInput!]
    followUps: [DecisionRefInput!]
    parts: [DecisionPartPatchInput!]
    addParts: [DecisionPartInput!]
  }

  "#1606 — a comment thread's state (hrn:node:hadronmemory.com:specs:cor:dmo:110:05). Top-level comments only."
  enum CommentThreadState {
    OPEN
    RESOLVED
  }

  "#1606 — who a comment is from (hrn:node:hadronmemory.com:specs:cor:dmo:110:03)."
  enum CommentAuthorKind {
    "A named worker wrote it; the user who bound the session is provenance only."
    WORKER
    "A user wrote it directly."
    USER
    "An unnamed agent wrote it on a user's behalf (a token or a run)."
    USER_AGENT
    "An App key with no user."
    APP
  }

  "#1606 — a public projection of a comment's author, resolver or provenance user. Never the full User/Worker/Agent/App object (#552)."
  type CommentActorRef {
    id: ID!
    name: String
    "Users only."
    handle: String
    "Workers, agents and Apps: the canonical URN, when it can be composed."
    urn: String
  }

  "#1606 — a comment's author. Exactly the refs its kind names are set."
  type CommentAuthor {
    kind: CommentAuthorKind!
    "WORKER."
    worker: CommentActorRef
    "USER and USER_AGENT."
    user: CommentActorRef
    "USER_AGENT only."
    agent: CommentActorRef
    "APP."
    app: CommentActorRef
  }

  "#1606 — the node a comment concerns. Same memory as the comment, so the same read gate."
  type CommentTargetRef {
    id: ID!
    urn: String!
    name: String!
    nodeType: String!
    "The target's current revision (Node.revision)."
    revSeq: Int!
  }

  """
  #1606 — feedback about a node (hrn:node:hadronmemory.com:specs:cor:dmo:110). A comment is a node of type
  \`comment\` in its target's memory, readable by exactly who can read that
  memory. It is never part of its target's content, never approved or minted,
  and never authoritative.
  """
  type Comment {
    id: ID!
    urn: String!
    "The portal page of the comment node; null when FRONTEND_URL is unset."
    portalUrl: String
    target: CommentTargetRef!
    "Null for a top-level comment; else the thread's top-level comment."
    threadRootId: ID
    isTopLevel: Boolean!
    "The target revision the thread was written against (replies inherit their thread's)."
    anchorRevision: Int!
    "The target fingerprint at anchorRevision: 64 lowercase hex, or null for encrypted targets (hrn:node:hadronmemory.com:specs:cor:dmo:110:01)."
    anchorApprovalHash: String
    "anchorRevision equals the target's current revision. When false, show the comment as about an older revision (hrn:node:hadronmemory.com:specs:cor:dmo:110:01)."
    anchorIsCurrent: Boolean!
    "Null when deleted."
    quote: String
    "Null when deleted: the stub shows the state, not the text."
    body: String
    "Top-level only; null for a reply."
    state: CommentThreadState
    "#1721 — deleted with deleteComment. A deleted comment is shown only as a stub with no text, kept while it has live replies (hrn:node:hadronmemory.com:specs:cor:dmo:110:05)."
    deleted: Boolean!
    deletedAt: DateTime
    "Who deleted it: its author, or a memory manager."
    deletedBy: CommentActorRef
    resolvedAt: DateTime
    resolvedBy: CommentActorRef
    author: CommentAuthor!
    "Whether the caller is this comment's author (the edit and delete right). Computed with the same author key the server enforces."
    viewerIsAuthor: Boolean!
    "Worker comments only: the user who bound the worker session, shown as provenance, never as author. Null for other comments, and for callers who cannot write the memory."
    provenanceUser: CommentActorRef
    createdAt: DateTime!
    "When the comment row last changed: an edit, or a delete that leaves a stub. Resolve and reopen never change it. To show a comment as edited, use editedAt."
    updatedAt: DateTime
    "When the body or quote was last edited; null when it never was. Only an edit sets it (hrn:node:hadronmemory.com:specs:cor:dmo:110:12)."
    editedAt: DateTime
    "Who last edited the body or quote; null when it never was."
    editedBy: CommentActorRef
    "The comment's write counter. Pass it as expectedRevision to edit, delete, resolve or reopen. A comment keeps no revision history, so there are no earlier revisions to read."
    revSeq: Int!
  }

  type CommentThread {
    root: Comment!
    "Oldest first; at most the first 200."
    replies: [Comment!]!
    "Every live reply, including any beyond the returned 200."
    replyCount: Int!
  }

  type CommentThreadPage {
    "Newest thread first."
    items: [CommentThread!]!
    total: Int!
  }

  "#1606 — the trust cue (hrn:node:hadronmemory.com:specs:cor:dmo:110:07). Counts live threads; zeros on a memory that cannot hold comments."
  type CommentSummary {
    openThreads: Int!
    resolvedThreads: Int!
    "Every live comment, top-level and replies, deleted stubs included."
    comments: Int!
    "The caller's own open, live top-level thread on this node, if any: one per author (hrn:node:hadronmemory.com:specs:cor:dmo:110:05)."
    viewerOpenThreadId: ID
  }

  "#1607 — a node with open feedback, reported as a WARNING by mint and approval reports, never a blocker (hrn:node:hadronmemory.com:specs:cor:dmo:110:07)."
  type UnresolvedFeedback {
    nodeId: ID!
    urn: String!
    loc: String!
    openThreads: Int!
  }

  type NodeRevision {
    id: ID!
    "#1610 — the Worker behind the edit this snapshot records, beside editedBy (the user)."
    editedByWorker: ActorRef
    "#1610 — the Agent behind the edit this snapshot records."
    editedByAgent: ActorRef
    "#1326 — attribution of the content captured before the next edit."
    authorship: NodeAuthorship
    "#1326 — advisory validation at this historical revision."
    contentValidation: NodeContentValidationStatus!
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
    """
    #620: full curated-subset snapshot fields. Null on LEGACY rows
    captured before the columns existed (nodeType doubles as the legacy
    sentinel — it is non-null on every post-#620 snapshot).
    """
    nodeType: String
    isLink: Boolean
    properties: JSON
    data: JSON
    seq: Int
    isRunnable: Boolean
    "#1201 — Node.role at capture time. In the curated subset because CLEARING a governed role is the escalation #1202 exists for: a history that cannot show the role cannot show the un-governing."
    role: String
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
    "User id recorded by per-node approval for this revision; null when no user approval was recorded."
    approvedBy: String
    "approvedBy resolved to public identifiers (handle + URN), like editedByUser."
    approvedByUser: NodeRevisionEditor
    "#1591 — the approving principal when no user is known, e.g. app:<id>."
    approvedByInfo: String
    "#1591 — when this revision was approved; null unless it was approved before it was edited away."
    approvedAt: DateTime
    "#1591 — approval hash v1 recorded when this revision was approved."
    approvalHash: String
    "#1838 — was THIS revision approved (for pinning)? Not whether the node is approved now (that is Node.approvalStatus). A revision counts as approved when some recorded approval covers exactly its hashed content, whichever revision the approval was recorded on (Holger's R7, hrn:node:hadronmemory.com:specs:cor:dmo:060:04)."
    revisionApproval: RevisionApproval!
    createdAt: DateTime!
  }

  "#1838 — whether one revision was approved, and by which recorded approval."
  type RevisionApproval {
    "NOT_APPLICABLE inside an encrypted memory; APPROVED or NOT_APPROVED otherwise (never SUPERSEDED: that is about the live text)."
    state: NodeApprovalState!
    approved: Boolean!
    "The revision the covering approval was recorded at; it can differ from this revision when only metadata changed, or the text recurs."
    recordedAtRevision: Int
    approvedBy: String
    approvedByInfo: String
    approvedAt: DateTime
  }

  "Only safe identity scalars for a live organization shared with the effective human viewer."
  type SharedOrganization {
    id: ID!
    name: String!
    urn: String!
  }

  type SharedOrganizationsPage {
    items: [SharedOrganization!]!
    total: Int!
  }

  type User {
    "Live shared memberships only; null for unsupported viewers or deleted users, empty for no intersection. Default 20, cap 200, nonnegative offset, organization id order. Impersonation stays in its one organization. Pages are live across requests."
    sharedOrganizations(limit: Int, offset: Int): SharedOrganizationsPage
    id: ID!
    handle: String
    "User-layer action-policy link (cor:acl:040:02, #510) — constrains runs made on the user's behalf. Null = no restriction, or hidden from viewers without personal-field access. Self-authored via updateMyPolicy."
    policy: JSON
    """
    Canonical \`hrn:user:<handle>\` URN (spec cor:urn:010:01). Computed from the
    handle; null for a handle-less user and for a user whose handle is
    not-URN-legal (neither has a URN).
    """
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
    "Account metadata, visible to self, platform admins, and co-members."
    identityProvider: String
    externalId: String
    externalAppId: String
    linkedAt: DateTime
    name: String
    email: String
    avatarUrl: String
    "Platform roles; an empty list is returned to viewers without personal-field access."
    roles: [Role!]!
    maxReferrals: Int
    """
    008-agent-installation: User-App memberships. Resolves to a non-empty
    list only when the queried User is the authenticated user (mirrors
    the User.agentSubscriptions resolver-side gate from 005).
    """
    appMemberships: [AppMember!]!
  }

  """
  A runtime caller identity owned by exactly one Organization or User. It owns
  long-lived App Keys and installs Agents through the AppAgent N:M join: one
  App may install many Agents, and one Agent may be installed in many Apps.
  The singular agentId / agent fields below are soft-deprecated convenience
  reads of the first install, not a direct foreign key.
  """
  type App {
    id: ID!
    name: String!
    urn: String!
    "#2171 (R211): the member roles this App offers: the union over its installed Agents, primary first."
    availableMemberRoles: [String!]!
    "#2138: when the whole team was paused (setTeamPause), or null. Separate from every worker's own pause."
    teamPausedAt: DateTime
    """
    #2109 — whether the current caller manages this App: its owner, an owner-role
    member, a live ADMIN or OWNER of its organization, or a platform admin for an
    organization-owned App. A known fact for an App the caller can read, so false
    is an answer and not a refusal. False for an App key, an impersonated
    session, a headless run and a request bound to a worker session. This is not
    permission to perform every task or worker operation: each operation checks
    its own authority.
    """
    viewerManages: Boolean!
    "Spec 049 Phase 4: the App's default Channel — the row its team chat became (null until provisioned)."
    defaultChannel: Channel
    "App-layer action-policy link (cor:acl:040:02, #510). Null = no restriction. Org-admin-authored via updateApp."
    policy: JSON
    organizationId: String
    organization: Organization
    """
    SOFT-DEPRECATED convenience read: the FIRST installed Agent. An App
    installs MANY Agents through the \`AppAgent\` join (023-app-shape Phase 2b,
    which DROPPED the direct FK that 008-agent-installation had introduced) —
    see \`appAgents\` below for the real cardinality. Kept so single-Agent
    clients keep working; do not build new multi-Agent logic on it.
    """
    agentId: ID
    agent: Agent
    """
    SOFT-DEPRECATED convenience read: the FIRST installed Agent's canonical
    URN, matching agentId / agent. Use appAgents for the full install roster.
    An installed agent stays AUTHOR-ROOTED forever, so this is simply that
    Agent's own URN:
    hrn:agent:<author-org>:<agent-slug>. Two orgs installing same-slug
    agents from different authors therefore still produce distinct URNs
    (they differ at the author root), enabling audit-log entries to
    identify the selected Agent unambiguously without a PK disambiguator.
    The v1 spec-021 R2 install chain
    (hrn:agent:<installing-org>::<app-slug>::<author-org>:<agent-slug>)
    is RETIRED — see #697 Stage 2 / D10 and emitInstalledAgentUrnV2. Returns
    null when the App has no installed Agent or the selected Agent's stored URN
    cannot be emitted in grammar v2.
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
    """
    Ruling DY-5: days without activity after which a lapsed worker session of
    this App is DORMANT. No agent act (post, read, mark-read) resumes a dormant
    session; only an explicit rebind by its human holder brings the worker
    back, and the router stops routing it. Default 90.
    """
    sessionDormancyDays: Int!
    """
    Ruling DY-3: whether startAgentSession stamps a hard expiry by default.
    False means this App's agent sessions have no hard expiry unless the call
    passes sessionTimeoutSeconds (still capped by the App's ceiling).
    """
    agentSessionsExpire: Boolean!
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
    "Key inventory, only for whoever manages the App as themselves, never through a bound worker session (hrn:node:hadronmemory.com:specs:cor:dmo:050:05)."
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
    "The App when this caller may read it; strict user ownership still applies."
    app: App
    "The installed Agent when this caller may read its definition; an installation license alone does not grant that read."
    agent: Agent
    """
    #2045 — the canonical URN of the compiled boot prompt the install's pointer names now
    (a moved node shows its new URN; a hard-deleted one its URN at write time). Null when no pointer is set
    OR when the caller may not see it (the App's participants only): null is not proof that no pointer exists.
    """
    bootPromptRef: String
    """
    #2045 — whether the pointer's target is deleted (soft or hard): true / false, and null when no pointer is set
    or the caller may not see it. Same gate as bootPromptRef. Nothing is served from a deleted target (R27).
    """
    bootPromptTargetDeleted: Boolean
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
    """
    #2509: this memory's record, exactly as Query.memory answers it to the
    caller, or null when the caller may not read that record (or it is
    deleted). Seeing this share does not grant its memory's record, so use
    memoryId for the address.
    """
    memory: Memory
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
    """
    #2509: this memory's record, exactly as Query.memory answers it to the
    caller, or null when the caller may not read that record (or it is
    deleted). Seeing this membership does not grant its memory's record, so use
    memoryId for the address.
    """
    memory: Memory
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
  """
  #1073 — what a releaseWorker call actually DID, rather than what the caller
  predicted it would do.

  releaseWorker used to return the post-release Worker, whose
  heldByUserId is null by construction — so a client could report only who
  held the name when it last looked. Per cor:agt:020:09 the two release
  paths are different ACTS: the holder's own release notifies nobody, an admin
  force-release must announce itself in the team chat. A receipt that cannot
  tell them apart describes an act that may not have happened.
  """
  type ReleaseWorkerPayload {
    """
    The worker, re-read immediately after the guarded release and BEFORE the
    team-chat notice — so the interval in which another caller could bind is as
    narrow as it can be made. It is NOT zero, and this is a re-read rather than
    a snapshot of the write.

    So a non-null heldByUserId here is a LATER hold somebody else took, never a
    failed release. releasedFrom is what says the release happened; this field
    is current state, and the two answer different questions.
    """
    worker: Worker!
    """
    The holder the WRITE ended — not the one a pre-read saw. Null when nothing
    was released, i.e. the name was already unheld (the idempotent path).

    This is the value the authorization decision was made against AND the value
    the guarded write matched on; #1084 made those the same user by
    construction, so this cannot name somebody other than whoever actually
    lost the name.
    """
    releasedFrom: ReleasedFromUser
    """
    True when the caller released SOMEBODY ELSE'S hold — the admin
    force-release path, the one act that takes a name without its holder
    acting, and the one that posts to the team chat.

    Computed server-side, from the authenticated principal and the hold the
    write ended in the same transaction. A client computing it would have to
    compare a value it was given against one it had to fetch, and that fetch
    fails on exactly the path where the answer matters.

    false always means the holder was YOU, or that nothing was released
    (releasedFrom null) — never "the server could not tell".
    """
    forced: Boolean!
    """
    Whether the team-chat notice was posted. THREE states, deliberately:

    - null — no notice was owed. A self-release, or nothing released.
    - true — a notice was owed and posted.
    - false — a notice was OWED AND FAILED. The release still happened; an
      unreachable chat must not stop an admin recovering a departed
      colleague's names.

    A plain boolean would collapse the first and last, and a client cannot
    render "we may have silently failed to announce this" honestly — so the
    only truthful UI would be to say nothing, throwing the field away.
    """
    notified: Boolean
  }

  """
  #1073 — a sanitized identity for the person a release took a name FROM.

  Deliberately a SEPARATE type from User, on the cor:acl:080:02 /
  PublicOrganization precedent: a field returning another entity's object hands
  the caller that entity's field resolvers, and User's default-resolved tail
  (policy, identityProvider, externalId, githubId, roles, maxReferrals) carries
  no gate of its own — it relies on the surface that returned it.

  releaseWorker cannot lean on that. Its admin path exists for the departed
  colleague, and leaveApp DELETES the AppMember row while the hold survives —
  so the very case this path serves is the one where the caller has no other
  route to that User. Worker itself only ever exposed heldByUserId, a bare id,
  so a full User here would be a NEW disclosure rather than an inherited one.

  Exposes what answers "who did I release", and nothing that grows back toward
  User. name keeps the same #384 gate it has on User rather than a second copy
  of the rule; the rest is public identity a URN already discloses.
  """
  type ReleasedFromUser {
    id: ID!
    handle: String
    "Canonical hrn:user:<handle> URN (cor:urn:010:01). Null for a handle-less user."
    urn: String
    """
    Withheld (null) from a viewer who is not the user themselves, a platform
    admin, or a co-member of one of their orgs — the SAME #384 gate as
    User.name, reused rather than restated. An admin releasing a colleague who
    has left the org sees null here, and still gets id/handle/urn.
    """
    name: String
  }

  type AppMember {
    appId: ID!
    userId: ID!
    "The App when the caller may read it; an external App member can still see their membership row."
    app: App
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

  """
  008-agent-installation: Agent dependency edge ("Suite imports Calendar").
  v1 enforces 1-level imports only.
  """
  type AgentImport {
    parentAgentId: ID!
    importedAgentId: ID!
    "The parent Agent when this caller may read its definition."
    parentAgent: Agent
    "The dependency Agent when this caller may read its definition; a builder grant alone does not grant that read."
    importedAgent: Agent
    position: Int!
    required: Boolean!
    createdAt: DateTime!
  }

  """
  008-agent-installation: Org↔Agent license. Authorizes (a) creating an App
  in this Org that uses this Agent, and (b) bundling this Agent in an
  AgentImport edge of an Agent the Org owns. Sibling to AgentSubscription.
  """
  type AgentOrgGrant {
    orgId: ID!
    agentId: ID!
    "The customer Organization when the caller may read it; a vendor grant alone does not authorize it."
    organization: Organization
    "The licensed Agent when this caller may read its definition."
    agent: Agent
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

  """
  017-chat-visibility-and-personal-memory: a chat is created in one
  of two tiers, chosen by the user at chat creation and immutable
  thereafter. shared chats live in the App's app-class memory.
  private chats live in the user's personal-class memory, OR in a
  knowledge-class one when the caller's org has no matching App
  install — validateChatScopeInvariants accepts both, so a client
  must not assume the memory class from the scope.
  """
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
    "#1749 — the scopes this key holds now (hrn:node:hadronmemory.com:specs:cor:aut:010:03). Whoever manages the App only."
    scopes: [AppKeyScope!]!
    "#1709 — what this key did as a host, newest first (hrn:node:hadronmemory.com:specs:cor:agt:070:07: every use is recorded). Whoever manages the App only."
    hostUses(first: Int): [HostKeyUse!]!
  }

  "#1749 — a scope an App key holds. A closed list: attention:deliver, and (#1709) host:operate."
  type AppKeyScope {
    scope: String!
    grantedAt: DateTime!
    grantedBy: ID!
    "#1709 — the one host a host:operate scope is bound to (hrn:node:hadronmemory.com:specs:cor:agt:070:04); null for every other scope."
    hostId: String
  }

  "#1709 — one use of a host key (hrn:node:hadronmemory.com:specs:cor:agt:070:07)."
  type HostKeyUse {
    id: ID!
    hostId: String!
    "register, collect, report, availability, read, (#1969) session: a refused session write (updateSession, endSession), or (#1981) issue: a refused issueHostOperation."
    action: String!
    "The operation a report was about."
    operationId: ID
    "How many operations a collection returned, or workers a registration listed."
    count: Int
    "#1881 — the refusal code when the server refused this use (e.g. APP_KEY_SCOPE_REQUIRED); null for a use that succeeded. A refused use is recorded too (hrn:node:hadronmemory.com:specs:cor:agt:070:07: every use)."
    refusedCode: String
    usedAt: DateTime!
  }

  """
  Returned once at creation — the raw key is never stored
  """
  type AppKeyCreated {
    key: AppKey!
    rawKey: String!
  }

  """#1631: a passkey record, as its owner sees it. Never a private key."""
  type PasskeyCredential {
    id: ID!
    """The owner's name for it; the fixed text "Erased passkey" once the owner's account is deleted."""
    label: String!
    transports: [String!]!
    backupEligible: Boolean!
    backedUp: Boolean!
    registeredAt: DateTime!
    lastUsedAt: DateTime
    revokedAt: DateTime
    """A first passkey's cooling-off window; null for a later passkey."""
    window: PasskeyWindow
    """
    When its cancel link was used; null if never cancelled. The cancel IP address and user agent,
    and the credential id, are shown only on the interactive revocation page after the owner proves who they are,
    never over a bearer credential (#1631 PR3 §10).
    """
    cancel: PasskeyCancelRecord
  }

  type PasskeyWindow {
    endsAt: DateTime!
    endedAt: DateTime
    """ran-out | ended-early | cancelled, or null while open (a window that ran out reads by its end time)."""
    outcome: String
    """The fresh sign-in method it was registered with."""
    registrationMethod: String
  }

  type PasskeyCancelRecord {
    at: DateTime!
  }

  """
  025-oauth-for-mcp: user-scoped bearer-token credential. Mirrors the
  AppKey shape but resolves to a User instead of an App. Surfaced to
  the portal revocation UI (Phase 3) so users can audit + revoke
  their own keys. userId is intentionally absent — for self-service
  v1 the caller is always the owner; admin-tooling auditability is
  out of scope (see contracts/graphql-mutations.md, PR-137 delta D1).
  """
  type UserApiKey {
    id: ID!
    keyPreview: String!
    label: String
    createdAt: DateTime!
    lastUsedAt: DateTime
    revokedAt: DateTime
    """
    #2298: when the owner hid this revoked key from their default list; null when
    visible. Display state only: it never affects validity, revocation or lineage.
    """
    hiddenAt: DateTime
    """
    Issuance identity: portal for direct sign-in issuance, or oauth:<client_id>
    for OAuth issuance. A key minted by a key inherits that credential's
    issuance identity. Powers source labels in the revocation UI.
    """
    issuedVia: String
    """
    Authenticated key that minted this key. Null for direct issuance or
    unknown legacy ancestry; historical parents are never inferred.
    """
    mintedByKeyId: ID
    """
    Immutable OAuth scopes bound to this credential. Empty means an
    unrestricted portal/legacy key rather than an OAuth-scoped key.
    """
    oauthScopes: [String!]!
  }

  """
  Returned once at creation — the raw key is never stored.
  Renamed from PR 137's UserApiKeyCreated for Result-suffix
  consistency; nested field is userApiKey, not key (PR-137 delta D2).
  """
  type UserApiKeyCreateResult {
    userApiKey: UserApiKey!
    rawKey: String!
  }

  """
  The kind of principal a credential resolved to (issue #562). USER covers
  both JWT sessions and hdr_user_ personal API keys; APP is an hdr_app_ key.
  AGENT is reserved for a future agent-credential principal — no auth path
  produces it today.
  """
  enum PrincipalType {
    USER
    APP
    AGENT
  }

  """
  The resolved principal for the credential presented on THIS request
  (issue #562). Exposes the AuthContext the server already resolves per
  request (cor:aut:020:02) read-only, so any surface (CLI, portal) can
  validate a token and name the exact credential without per-client hacks.

  Security posture (held deliberately):
    - Current-request only. There is intentionally no query that takes an
      arbitrary token as an argument — that would be a token oracle. The
      caller must possess the credential, exactly as today.
    - No reason-leak. A credential that does not resolve yields a null
      authContext (Query field), identically for revoked / never-existed /
      malformed. Once a credential HAS resolved (you authenticated as it),
      surfacing active-vs-revoked via apiKey.revokedAt is fine.
  """
  type AuthContext {
    """
    Which kind of credential authenticated this request.
    """
    principalType: PrincipalType!
    """
    The authenticated User — populated for USER principals (JWT or
    hdr_user_ key), null for App keys.
    """
    user: User
    """
    App.id — populated for APP principals (hdr_app_ key).
    """
    appId: ID
    """
    Reserved for a future agent-credential principal; always null today.
    """
    agentId: ID
    """
    The specific UserApiKey presented — populated only when the request
    authenticated via an hdr_user_ key (its id, label, keyPreview,
    createdAt, lastUsedAt, revokedAt). Null for JWT sessions and App keys.
    """
    apiKey: UserApiKey
    """
    Set when the credential is an impersonation token: this request runs
    READ-ONLY as the target user, scoped to one org. Null for every other
    credential. Portal and CLI read this to render the acting-as state.
    """
    impersonation: ImpersonationInfo
  }

  """
  Admin impersonation (read-only support sessions): the acting-as facts of
  THIS request's credential, surfaced on AuthContext so whoami-style
  consumers can name the real actor, the scope org, and the expiry.
  """
  type ImpersonationInfo {
    sessionId: ID!
    """
    The admin behind the curtain (visibility per the normal User field
    rules — the actor is a co-member of the scope org).
    """
    actorUser: User
    organizationId: ID!
    expiresAt: DateTime!
    """
    Always true in v1 — impersonated sessions cannot mutate.
    """
    readOnly: Boolean!
  }

  """
  One admin-impersonation session: the durable audit record (who
  impersonated whom, in which org, when) AND the revocation source of
  truth (stopImpersonation writes endedAt; rows are never deleted).
  """
  type ImpersonationSession {
    id: ID!
    adminUser: User!
    targetUser: User!
    organization: Organization!
    reason: String
    createdAt: DateTime!
    expiresAt: DateTime!
    """
    Explicit-stop timestamp; null while live or when the session merely
    lapsed by TTL.
    """
    endedAt: DateTime
    """
    User.id of whoever stopped it early (the admin actor for a self-stop
    from the impersonated context). Null while live / TTL-lapse.
    """
    endedBy: ID
    """
    Derived: endedAt is null AND expiresAt is in the future.
    """
    isActive: Boolean!
  }

  type ImpersonationSessionList {
    items: [ImpersonationSession!]!
    total: Int!
  }

  """
  Returned exactly once by startImpersonation — the token is never stored
  or shown again (UserApiKey rawKey precedent).
  """
  type StartImpersonationResult {
    session: ImpersonationSession!
    token: String!
  }

  input ImpersonationSessionFilter {
    """
    Only sessions that are live right now (endedAt null, unexpired).
    """
    activeOnly: Boolean
  }

  """
  Returned once at App creation / regenerateAppKey — the raw key is never stored
  """
  type AppCreated {
    app: App!
    rawKey: String!
  }

  """
  Decrypted AI config for an App (owner / org admin only).
  """
  type AppAIConfig {
    provider: String!
    apiKey: String!
    model: String!
  }

  """
  A company or team that owns one or more Hadron memories.
  """
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
    """
    008-agent-installation: this org's grants for using/bundling Agents.
    Resolvable to ADMIN/OWNER of the org only.
    """
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

  """
  Per-organization membership record for a user.
  """
  type OrgMember {
    id: ID!
    user: User!
    "Target member's role in this org. Null when the viewer isn't an ADMIN/OWNER of the org (#384 field-level visibility); always visible for one's own membership."
    role: Role
    canInvite: Boolean!
    createdAt: DateTime!
  }

  """
  033-rag-vector-retrieval: what a memory's vector index is built from.
  """
  enum EmbeddingSource {
    abstract
    contentChunks
    both
  }

  enum MemoryTransferHandling {
    CARRY
    REFUSE
    REMOVE
    CREATE
  }

  type MemoryTransferDependent {
    kind: String!
    count: Int!
    handling: MemoryTransferHandling!
  }

  type MemoryTransferBlocker {
    code: String!
    message: String!
  }

  type MemoryOwnerTransferPreview {
    memoryId: ID!
    oldUrn: String!
    newUrn: String!
    fromOwner: ID!
    toOwner: ID!
    currentClass: MemoryClass!
    targetClass: MemoryClass!
    dependents: [MemoryTransferDependent!]!
    blockers: [MemoryTransferBlocker!]!
    canApply: Boolean!
    applied: Boolean!
  }

  """
  A Hadron memory (git repo + branch settings).
  """
  type Memory {
    id: ID!
    organizationId: String
    "The owning Organization when the caller may read that Organization; a Memory read alone does not grant it."
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
    """
    035-visibility-enum-cleanup: nullable — set only for knowledge/group.
    """
    visibility: MemoryVisibility
    "cor:acl:080:04 — opt-in marketplace catalogue flag (advertisement, not access)."
    listedOnMarketplace: Boolean!
    """
    Which memory typology this row belongs to. See MemoryClass for the
    members — deliberately not restated here, because the count is what
    went stale: this said "four-way" from 005-agent-subscription until
    #1232, long after \`group\` (023) and \`private\` made it six.
    """
    class: MemoryClass!
    """
    #766 — derived shareability signal: true iff this memory can be shared
    with an individual user via MemoryShare, i.e. class = 'personal'
    (spec 023 FR-018). Lets the CLI and portal surface or gate the share
    action before a createMemoryShare attempt rather than discovering
    InvalidMemoryClassForShareError at execution time.
    """
    shareable: Boolean!
    """
    006-asset-upload-redesign: per-memory upload-acceptance gate.
    Default true for app/knowledge/personal-class memories; false for
    system-class. Org admins or memory owners can flip via the
    setMemoryAcceptsUploads mutation (added in v2 story phases).
    """
    acceptsUploads: Boolean!
    """
    The strict user owner, for BOTH \`personal\` and \`private\` classes —
    the DB invariant is \`class IN ('personal','private') ⇔ user_id IS NOT
    NULL\`, so a private memory has one too. Resolves to null for every
    other class, and also when the caller is not the memory owner / not
    ADMIN/OWNER of the memory's org.
    """
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
    #1447/#1448, derived per node since #1591 — DRAFT while none of this
    memory's live nodes is minted, MINTED once any is. Draft rights are per
    node: an unminted node can be renumbered, moved without a URN alias, and
    bulk-replaced, in any memory (see Node.mintStatus).
    """
    corpusState: CorpusState!
    "#1448/#1591 — the latest mint time among this memory's live nodes; null while none is minted."
    corpusMintedAt: DateTime
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
    """
    The App this memory is scoped to. Required for app-class memories.
    A system-class Agent definition has no App; a system-class INSTALL MEMORY
    has an App and isInstallMemory=true, including after its Agent link is
    detached. Other classes (knowledge, group, personal, private) may be
    App-scoped or free-standing. Enforced by chk_memory_class_app_id.
    """
    appId: ID
    "The linked App when the caller may read that App; a Memory read alone does not grant it."
    app: App
    """
    Populated only for class = system — the agent this memory is
    the system memory of. Null for regular knowledge memories.
    """
    agent: Agent
    syncStatus: SyncStatus!
    syncError: String
    "Version 1 JSON outcome of the last sync: partial, failed or unknown. Null after a completed clean sync; consult lastSyncedAt/syncStatus for a never-synced memory. Same Memory-record read gate applies. Git sync: hrn:node:hadronmemory.com:specs:cor:int:010:01."
    lastSyncReport: String
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
    """
    #1325 — this memory's config: its node-role rules. Null for anyone who does
    not MANAGE the memory (the strict owner of a personal/private memory; else
    its user owner or an org ADMIN/OWNER), however the Memory was reached. A
    memory with no rules yet reads as the empty config (id null, no rules).
    """
    config: MemoryConfig
  }

  """
  #1325 — a memory's config: exactly one per memory, holding its node-role
  rules (one per role or declared sub-role). Read and changed only by the
  memory's managers. Materialized by the first rule write; before that it reads
  as empty, with a null id.
  """
  type MemoryConfig {
    "Null until the first rule is written."
    id: ID
    memoryId: ID!
    "Role-ascending."
    rules: [NodeRoleRule!]!
    createdAt: DateTime
    createdBy: ID
    updatedAt: DateTime
    updatedBy: ID
  }

  """
  #1331 — who may write a node whose role this rule governs, ON TOP OF memory write access (never instead of it).
  A write is judged against the role the node has BEFORE it and the role it has AFTER, so creating, editing, changing or clearing a role all need the level.
  """
  enum NodeRoleWriters {
    "Anyone who may write the memory. Grants no new access."
    ALL
    "NOT BUILT yet (#1333): any write touching this role is refused (ROLE_WRITERS_UNSUPPORTED). Never read as ALL."
    OWNER
    "The owning organization's ADMINs and OWNERs, and the owning user (ROLE_WRITER_LEVEL_REQUIRED otherwise)."
    ADMIN
  }

  enum ContentValidator {
    AGENT
    PLATFORM
  }

  """
  #1325 — the state of one rule reference, next to its URN and id. NONE: not
  configured. OK: the node is live and you can read it; its id is given, and
  its URN too unless the node's memory has a legacy URN that cannot address it
  (#697), when the URN is null and the id is the ref to use. BROKEN: configured,
  but its node or memory is gone, so operations relying on a procedural rule
  are refused until a manager repoints it (fail-closed). Missing description
  documentation instead reports NONE through descriptionNodeState. UNREADABLE: the node exists but you may
  not read it, so its URN and id are withheld.
  """
  enum NodeRoleRuleRefState {
    NONE
    OK
    BROKEN
    UNREADABLE
  }

  """
  #1325 — one node-role rule. Task and description references are stored by
  node id (they survive moves) and returned as a URN and an id, each with its
  state. Both are given only when the state is OK; see NodeRoleRuleRefState.
  """
  type NodeRoleRule {
    "The rule's id — its ref for updateNodeRoleRule / deleteNodeRoleRule (a rule has no URN)."
    id: ID!
    "The dotted role or sub-role this rule governs, unique within the config."
    role: String!
    authorTask: String
    authorTaskId: ID
    authorTaskState: NodeRoleRuleRefState!
    validationTask: String
    validationTaskId: ID
    validationTaskState: NodeRoleRuleRefState!
    "Documentation, not procedure: a deleted description node reads as NONE, never BROKEN."
    descriptionNode: String
    descriptionNodeId: ID
    descriptionNodeState: NodeRoleRuleRefState!
    "On a parent role: refuse its undeclared sub-roles instead of falling back to it."
    strictSubRoles: Boolean!
    writers: NodeRoleWriters!
    validateBy: ContentValidator
    enabled: Boolean!
    "Set by applying a required template (#1334). A locked rule refuses every ordinary edit and delete (RULE_LOCKED); unlockNodeRoleRule is the deliberate step."
    locked: Boolean!
    "The template this rule was copied from, if any (provenance only; no live link)."
    sourceTemplateId: ID
    sourceTemplate: NodeRoleRuleSourceTemplate
    "Optimistic-concurrency token: pass it as expectedRevision to update or delete."
    revision: Int!
    createdAt: DateTime!
    createdBy: ID
    updatedAt: DateTime
    updatedBy: ID
  }

  type NodeRoleRuleSourceTemplate {
    id: ID!
    name: String!
    "The template has been deleted; the rule keeps its copy."
    deleted: Boolean!
  }

  "#1325 — a non-fatal finding about a saved rule. Never changes the mutation's success."
  type MemoryConfigWarning {
    code: String!
    role: String!
    field: String
    taskUrn: String
    taskState: NodeRoleRuleRefState
  }

  "#1325 part (c) — which entity owns a MemoryConfigTemplate. Exactly one per template."
  enum MemoryConfigTemplateOwnerType {
    HADRON_SERVER
    ORGANIZATION
    USER
    APP
  }

  """
  #1325 part (c) — a reusable rulebook with exactly one owner, COPIED into a
  memory's config when applied (never live-linked). Read and managed only by
  its owner's managers: a platform admin (server), an org ADMIN/OWNER
  (organization), the user themselves (user), the App's owner or org
  ADMIN/OWNER (App). For anyone else it does not exist.
  """
  type MemoryConfigTemplate {
    id: ID!
    "Unique per owner among live templates; 1-64 lower-case letters, digits, '-' or '_'."
    name: String!
    description: String
    "Applied as locked rules (#1334)."
    required: Boolean!
    ownerType: MemoryConfigTemplateOwnerType!
    "ID of the owning organization, user or App; null for the server."
    ownerId: ID
    "Role-ascending."
    rules: [MemoryConfigTemplateRule!]!
    "Optimistic-concurrency token for the template AND its rules."
    revision: Int!
    createdAt: DateTime!
    createdBy: ID
    updatedAt: DateTime
    updatedBy: ID
  }

  "#1325 part (c) — one rule of a template: a node-role rule without the config-only fields."
  type MemoryConfigTemplateRule {
    role: String!
    authorTask: String
    authorTaskId: ID
    authorTaskState: NodeRoleRuleRefState!
    validationTask: String
    validationTaskId: ID
    validationTaskState: NodeRoleRuleRefState!
    "Documentation, not procedure: a deleted description node reads as NONE, never BROKEN."
    descriptionNode: String
    descriptionNodeId: ID
    descriptionNodeState: NodeRoleRuleRefState!
    strictSubRoles: Boolean!
    writers: NodeRoleWriters!
    validateBy: ContentValidator
    enabled: Boolean!
  }

  type MemoryConfigTemplatesPage {
    items: [MemoryConfigTemplate!]!
    total: Int!
  }

  "Filter for memoryConfigTemplates(). Narrows the templates you manage; it never widens them."
  input MemoryConfigTemplateFilter {
    ownerType: MemoryConfigTemplateOwnerType
    "ID or URN of the owner (with ownerType). An owner you do not manage matches nothing."
    ownerRef: ID
  }

  "#1325 part (c) — a new template. \`rules\` are validated as a whole before anything is written."
  input CreateMemoryConfigTemplateInput {
    name: String!
    description: String
    required: Boolean
    "Each role at most once (NODE_ROLE_RULE_EXISTS)."
    rules: [CreateNodeRoleRuleInput!]
  }

  """
  #1325 part (c) — change a template. An omitted field is unchanged;
  description null clears it. \`rules\`, when given, REPLACES the template's
  rules in one transaction.
  """
  input UpdateMemoryConfigTemplateInput {
    name: String
    description: String
    required: Boolean
    rules: [CreateNodeRoleRuleInput!]
  }

  type MemoryConfigTemplatePayload {
    template: MemoryConfigTemplate!
    "Empty until #1327 adds its visibility warnings."
    warnings: [MemoryConfigWarning!]!
  }

  "#1334 — what applying a template did (or, on a dry run, would do) for one role."
  enum MemoryConfigApplyOutcome {
    "The memory had no rule for the role; the template's was copied in (locked if the template is required)."
    APPLIED
    "The memory already had a rule for the role, and a non-required template never overrides one."
    SKIPPED_CONFLICT
    "The memory's rule for the role was overwritten by a required template's, and is now locked."
    REPLACED
    "A required template met a LOCKED rule that you have no authority to move; the rule stands."
    SKIPPED_LOCKED
  }

  type MemoryConfigApplyEntry {
    role: String!
    outcome: MemoryConfigApplyOutcome!
    "The rule in force for this role afterwards. On a dry run, the existing rule, or null for a would-be APPLIED."
    rule: NodeRoleRule
  }

  type MemoryConfigApplyResult {
    memoryId: ID!
    template: NodeRoleRuleSourceTemplate!
    "The template revision that was applied; pass it back as expectedTemplateRevision to apply exactly what a dry run showed."
    templateRevision: Int!
    required: Boolean!
    dryRun: Boolean!
    "One per template rule, role-ascending."
    entries: [MemoryConfigApplyEntry!]!
    "Empty until #1327 adds its visibility warnings."
    warnings: [MemoryConfigWarning!]!
  }

  type NodeRoleRulePayload {
    rule: NodeRoleRule!
    "Empty until #1327 adds its visibility warnings."
    warnings: [MemoryConfigWarning!]!
  }

  """
  #1325 — a new rule, in a memory's config or in a template's rule list.
  Task and description references are node IDs or URNs you
  can read; a node you cannot read is refused exactly like a missing one
  (NODE_NOT_FOUND), and a task reference must be a runnable task (NOT_A_TASK).
  """
  input CreateNodeRoleRuleInput {
    "Lower-case letter/digit/dash segments joined by dots, 1-64 characters (INVALID_NODE_ROLE)."
    role: String!
    authorTaskRef: ID
    validationTaskRef: ID
    descriptionNodeRef: ID
    strictSubRoles: Boolean
    writers: NodeRoleWriters
    "Needs a validation task."
    validateBy: ContentValidator
    enabled: Boolean
  }

  """
  #1325 — change a rule. An omitted field is unchanged. A reference given as
  null or an empty string CLEARS it; validateBy null clears it. The role itself
  is the rule's identity and cannot be changed: delete and re-create instead.
  """
  input UpdateNodeRoleRuleInput {
    authorTaskRef: ID
    validationTaskRef: ID
    descriptionNodeRef: ID
    strictSubRoles: Boolean
    writers: NodeRoleWriters
    validateBy: ContentValidator
    enabled: Boolean
  }

  "#2177 - one page of Agent.extendedBy."
  type AgentExtensionPage {
    items: [Agent!]!
    "Opaque. Null when hasMore is false."
    endCursor: String
    hasMore: Boolean!
  }

  "#2246 - why an Agent is not ready to be offered; the values are the clone refusal's codes (hrn:node:hadronmemory.com:specs:cor:dmo:050:19)."
  enum AgentOfferReasonCode {
    AGENT_NOT_PUBLIC
    AGENT_RETIRED
    CLONE_LINKED_MEMORY_ENCRYPTED
    CLONE_LINKED_MEMORY_UNREADABLE
    CLONE_BASE_UNUSABLE
    CLONE_IMPORT_UNUSABLE
  }

  "#2246 - the name of one blocking subject, shown only because you may read it. Nothing else about it is reachable."
  type AgentOfferSubject {
    name: String!
  }

  """
  #2246 - one reason an Agent is not ready to be offered. count is every blocked subject; subjects are at
  most 20 of the ones you may read; omittedByCap are readable ones past the cap; hiddenByAccess are ones
  you may not read, never named. subjects + omittedByCap + hiddenByAccess = count.
  """
  type AgentOfferReason {
    code: AgentOfferReasonCode!
    count: Int!
    subjects: [AgentOfferSubject!]!
    omittedByCap: Int!
    hiddenByAccess: Int!
  }

  "#2246 - whether another organisation could subscribe to, install and clone the Agent as it stands."
  type AgentOfferReadiness {
    ready: Boolean!
    "Every reason that holds, in the clone refusal's order. Empty exactly when ready."
    reasons: [AgentOfferReason!]!
  }

  """
  The reusable definition a Builder creates and the marketplace can list.
  Agents are installed into runtime Apps through the AppAgent N:M join: an App
  may install many Agents, and an Agent may be installed in many Apps. The App,
  not the Agent, is the org- or user-owned caller identity and deployment.
  """
  type Agent {
    id: ID!
    organizationId: String
    urn: String!
    name: String!
    description: String
    "Templated Agent prompt. {{name}}/{{role}} bind to the Agent in chats or the named Worker in briefings."
    systemPrompt: String
    """
    #2045 — the canonical URN of the compiled boot prompt this Agent's pointer names now
    (a moved node shows its new URN; a hard-deleted one its URN at write time). Null when no pointer is set
    OR when the caller may not see it (only a caller who may read the Agent's system memory): null is not proof that no pointer exists.
    """
    bootPromptRef: String
    """
    #2045 — whether the pointer's target is deleted (soft or hard): true / false, and null when no pointer is set
    or the caller may not see it. Same gate as bootPromptRef. Nothing is served from a deleted target (R27).
    """
    bootPromptTargetDeleted: Boolean
    systemMemoryId: String
    visibility: AgentVisibility!
    "cor:acl:080:04 — opt-in marketplace catalogue flag (advertisement, not access)."
    listedOnMarketplace: Boolean!
    "#2138: false means every Worker cast from this Agent counts as having a task and is expected to check its team channel every period (coordinators, the lifecycle agent). Default true."
    usesTasks: Boolean!
    "#2162 (hrn:node:hadronmemory.com:specs:cor:agt:050:27): when a task one of this Agent's workers had started finishes or is cancelled, and it holds no other started task, its host resets the worker's context (a shed: the binding and session stay). Default false. Set by whoever manages the Agent."
    resetContextAfterTask: Boolean!
    type: AgentType!
    surfaces: [String!]!
    # #928/#974 persona dressing (cor:agt:020:01): universal metadata that
    # lets any agent present as a colleague. The NAMED identity ('Iris') is
    # the Worker - the casting of an installed agent into an App - never a
    # field here. Pure metadata: no server behavior forks on these fields.
    "Persona role - free string with conventions ('backend-engineer')."
    personaRole: String
    """
    #1885 (hrn:node:hadronmemory.com:specs:cor:dmo:050:14) - the id of the one base Agent this Agent extends,
    or null. Set, change or clear it with setAgentBase.
    """
    extendsAgentId: ID
    """
    #2177 - the Agents that DIRECTLY extend this one (not their extenders), in name order, that you may
    read exactly as you read agent(ref:). Visibility is applied before the page is cut. first: 1-50,
    default 20. "after" is an opaque token from a previous page's endCursor: it expires after 15 minutes,
    is bound to this Agent and to you, and a refused token is always the same "invalid cursor" error.
    An EMPTY page with hasMore true means the scan is incomplete, NOT that nothing readable remains:
    keep paging. There is deliberately no total.
    """
    extendedBy(first: Int = 20, after: String): AgentExtensionPage!
    """
    #2246 (hrn:node:hadronmemory.com:specs:cor:dmo:050:19) - is this Agent ready to be offered to other
    organisations: could an organisation with no relation to it subscribe to, install and clone it as it
    stands, and if not, why. Readable only by whoever manages the Agent (hrn:node:hadronmemory.com:specs:cor:dmo:050:13); null for everyone
    else, readers of a PUBLIC Agent included, and when the Agent is gone. A reason names a memory or Agent only
    if you may read it; otherwise only the count shows. Answers for an outsider, so a non-PUBLIC Agent is not
    ready even though its own manager can still clone it. Read-only; grants nothing.
    """
    offerReadiness: AgentOfferReadiness
    """
    #2281 - the URN of the Agent this one was cloned from (cloneAgent), as that Agent's current URN. Null when
    this is not a clone, when you cannot read the source, when the source was deleted, or when the clone's origin identity is not recorded: those cases are indistinguishable by design. Never an id or an object.
    """
    clonedFromAgentRef: String
    """
    #1892 (hrn:node:hadronmemory.com:specs:cor:dmo:050:15) - the id of the index node whose incoming,
    trigger-labelled edges list this Agent's own tasks, or null. Set or clear
    it with setAgentIndexRefs; read the Agent's whole task list with agentTaskList.
    """
    tasksIndexRef: ID
    """
    #1892 (hrn:node:hadronmemory.com:specs:cor:dmo:050:16) - the id of the index node whose incoming,
    trigger-labelled edges list the processes this Agent starts or owns, or
    null. Set or clear it with setAgentIndexRefs; read the Agent's processes
    with agentProcessList.
    """
    processesIndexRef: ID
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
    "Spec 049 Phase 5 — the defaults this Agent's install-created register row is made with."
    registerDefaults: RegisterDefaults!
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
    "Adoption count. #551: the owning tenant's view (0 otherwise): the owning org's members, or for a user-owned agent its owner (#1693)."
    appCount: Int!
    """
    Org grants for this Agent (which orgs were granted it). #551: the agent's
    customer list — visible to members of the Agent's owning org only (empty
    otherwise), regardless of the agent's PUBLIC visibility.
    """
    orgGrants: [AgentOrgGrant!]!
    createdAt: DateTime!

    "#2024 — the tickers this Agent declares. Casting a worker from it creates them for the worker (a snapshot: later edits reach only future casts). Readable by anyone who can read the Agent."
    tickerTemplates: [AgentTickerTemplate!]!
    "#2024 — whether the caller may create, change or delete this Agent's ticker templates (the Agent ADMIN door, the same as editing the Agent). Null when it cannot be decided."
    viewerMayEditTickerTemplates: Boolean
  }

  """
  Decrypted AI config for an agent — the portal backend uses it to make LLM
  calls on behalf of the logged-in user.

  Gated by requireOwnerOrOrgRole, which branches on the Agent's OWNERSHIP
  CLASS: an org-owned Agent admits an ADMIN of that org (and a platform
  admin), while a USER-owned one (ownerUserId set, organizationId null)
  admits only its owner — strictly, with no org path and no admin bypass.
  Published as "only returned to org admins" until #1232, which is the
  org-owned half of the rule.

  036-ai-service-config: registry-backed (the Agent's config named
  'default'); prefer resolveAIConfig for new callers.
  """
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
    "Provider identifier; known: 'anthropic' | 'openai' | 'glm' | 'bedrock' | 'openai-compatible' (any OpenAI-wire host; endpoint required)."
    provider: String!
    "Model identifier, passed verbatim to the provider."
    model: String!
    hasApiKey: Boolean!
    "Ellipsis + last 4 characters of the stored key; null when no key."
    apiKeyPreview: String
    "Provider-specific knobs (maxTokens, thinking, effort, baseUrl, ...)."
    params: JSON
    """
    #1373: the base URL this config's requests are sent to, as stored. Null =
    the provider's default (see effectiveEndpoint and aiProviderEndpoints).
    """
    endpoint: String
    """
    #1373: where a request for this config actually goes: endpoint, else the
    provider default. Null only for bedrock, whose endpoint is derived from
    its region.
    """
    effectiveEndpoint: String
    "#1373: the wire protocol as stored; null = the provider default. OpenAI-compatible providers only."
    apiStyle: AiApiStyle
    "#1373: the wire protocol a request actually uses (apiStyle, else the provider default); null for single-protocol providers."
    effectiveApiStyle: AiApiStyle
    "Disabled configs are skipped by resolution (the walk continues outward)."
    enabled: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime
  }

  "#1373: the wire protocol of an OpenAI-compatible provider."
  enum AiApiStyle {
    "POST {endpoint}/chat/completions — what most OpenAI-compatible hosts serve (the glm default)."
    CHAT_COMPLETIONS
    "POST {endpoint}/responses — OpenAI's Responses API (the openai default)."
    RESPONSES
  }

  "#1378: where a tested value came from."
  enum AiConfigTestValueSource {
    SAVED
    OVERRIDE
  }

  "#1378: which key a test used; NONE when there was none to use."
  enum AiConfigTestKeySource {
    SAVED
    OVERRIDE
    "A HADRON_SERVER config with no stored key: the server's own credential for that provider served the call, as it serves a run (#1385)."
    PLATFORM
    NONE
  }

  """
  #1378: values to test INSTEAD of the saved ones — e.g. an edited form before
  it is saved. Never stored. Each is validated exactly as a write would be.
  """
  input AiServiceConfigTestOverride {
    provider: String
    model: String
    "Omitted = the saved endpoint; null or empty = the provider default."
    endpoint: String
    "Omitted = the saved style; null = the provider default."
    apiStyle: AiApiStyle
    "A key to test with instead of the stored one. Never stored, never echoed."
    apiKey: String
    "Edited params to test instead of the saved ones (#1413): validated exactly as a save validates them, including the params.baseUrl refusal, against the effective provider — before anything outbound. Used for the call, never stored. Omitted = the saved params; null = the edit clears them (the provider defaults). On the wire the probe exercises the effective provider/model/endpoint/key and (hard-capped at 16, per #1378's original ceiling pending a cost ruling) maxTokens, like its one-word prompt; the other knobs go through the same mapping every run uses (#1417): temperature, OpenAI reasoningEffort, Anthropic effort and Anthropic thinking (sent as adaptive on Claude 4.6 and newer models; not sent to older ones, which reject adaptive) are sent, and maxTokens is an output ceiling (min of the config's and the probe's cap); unrecognised keys are accepted but not forwarded. A write, or an edit under test, is refused a value outside a provider's known range (Anthropic and Bedrock temperature at most 1); a saved row is not re-judged. knobs on the result reports what each one did."
    params: JSON
  }

  "#1378: per field, whether the test used the saved value or the override."
  type AiServiceConfigTestUsed {
    provider: AiConfigTestValueSource!
    model: AiConfigTestValueSource!
    endpoint: AiConfigTestValueSource!
    apiStyle: AiConfigTestValueSource!
    params: AiConfigTestValueSource!
    key: AiConfigTestKeySource!
  }

  type AiServiceConfigTestError {
    "NO_API_KEY | KEY_UNREADABLE (the stored key cannot be decrypted here; re-enter it) | CONFIG_INVALID (the config cannot be built at all, e.g. a malformed Bedrock key; no call made) | QUOTA_EXCEEDED (a platform-funded test with the org's daily token allowance used up; no call made) | LLM_CALL_FAILED (the provider call failed or timed out; see transient)"
    code: String!
    "Provider error text, scrubbed of the key and truncated."
    message: String!
    transient: Boolean!
  }

  "#1378: one test call, made through the same client and endpoint a run uses."
  type AiServiceConfigTestResult {
    ok: Boolean!
    provider: String!
    model: String!
    "The endpoint the request actually went to: the explicit endpoint, else the host the SDK chose (OPENAI_BASE_URL / ANTHROPIC_BASE_URL when the server sets one, Bedrock's regional host), else the catalog default. Null when it can't be known (Bedrock with no region)."
    endpoint: String
    "The wire protocol the request actually used."
    apiStyle: AiApiStyle
    used: AiServiceConfigTestUsed!
    latencyMs: Int!
    "The model's reply, truncated."
    reply: String
    error: AiServiceConfigTestError
    "#1417: what each provider knob in the effective params did on the call. Empty unless the call completed (a failed call's adapter warnings are unknown), or when the params carry none. maxTokens is listed as the ceiling it set (ADJUSTED when the probe's cap is lower); toolCalling (a gate) is not a provider knob and is not listed."
    knobs: [AiConfigTestKnob!]!
  }

  "#1417: what one provider knob in the effective params did on the call."
  type AiConfigTestKnob {
    "The params key, e.g. temperature."
    param: String!
    "SENT (carried to the provider, no adapter warning) | ADJUSTED (sent, but the adapter changed the value, e.g. clamped to its range) | DROPPED (the adapter removed it, e.g. temperature on a reasoning model) | NOT_SENT (the platform does not forward it; see detail)"
    state: String!
    "Why it was not sent, or the adapter's own warning text."
    detail: String
  }

  "#1373: one known endpoint for a provider, from the server's single suggestion list."
  type AiProviderEndpoint {
    url: String!
    label: String!
    "The endpoint a config with no endpoint uses."
    isDefault: Boolean!
    "What the URL does not say: billing, terms."
    note: String
  }

  """
  036-ai-service-config: privileged resolution result. Carries the
  DECRYPTED key — only returned by resolveAIConfig. A resolved platform
  credential is decrypted only for platform ADMIN/OWNER; org ADMIN may
  decrypt an authorized tenant-owned config. Successor to agentAIConfig /
  appAIConfig.
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
    "#1373: where requests for this config go (see AiServiceConfig.effectiveEndpoint)."
    effectiveEndpoint: String
    "#1373: the wire protocol requests use (see AiServiceConfig.effectiveApiStyle)."
    effectiveApiStyle: AiApiStyle
  }

  """
  A saved chat in one of the chat-scope tiers.

  Per spec 017, scope is set at chat creation and immutable
  thereafter. private chats live in the author's personal-class
  memory; shared chats live in the App's app-class memory and are
  readable by every AppMember of that App.
  """
  type Chat {
    id: ID!
    loc: String!
    title: String!
    conversationName: String
    stageName: String
    messageCount: Int!
    createdAt: DateTime!
    lastMessageAt: DateTime
    """
    017-chat-visibility-and-personal-memory.
    """
    scope: ChatScope!
    """
    The chat's author (chat-root node's createdBy). Null for legacy
    chats predating createdBy persistence. Surfaces who started a
    shared chat so the portal can distinguish own vs other-member
    shared chats in the list.
    """
    createdBy: ID
  }

  """
  One chat message in history, as returned by chatHistory.
  """
  type ChatMessage {
    role: String!
    content: String!
    seq: Int
    createdAt: DateTime!
  }

  type TeamTagSnapshot {
    headId: ID!
    label: String!
  }

  """
  One message in a team App's chat (#939, Worker envelope since #974). Exactly
  one of authorUserId / authorWorkerId is set, or authorSystem is true (#1791, the
  platform's own notice, which has neither): a human post carries the user, a
  worker post carries the Worker (the named casting, cor:dmo:050:11) plus the
  driving sessionId. mentions holds the lowercased tokens extracted
  server-side at write time (the '@worker-name / @handle' format, stored
  without the '@').
  """
  type TeamChatMessage {
    "The message node's id."
    nodeId: ID!
    """
    The message node's canonical URN, hrn:node:<memory>:<loc> (#1209), so a
    client can cite a message in a CLI call, an MCP tool or a reply. Composed
    server-side: a message loc carries a random component, so the chat root and
    the seq do not reconstruct it. Null when the address would not resolve back
    to this message: the host memory's stored URN or the loc cannot be emitted
    in the flat grammar-v2 shape, or the memory URN is a pre-v2 compound one
    (e.g. a legacy team space). A client shows nothing then, never a guessed
    address (the Worker.urn / Channel.urn contract).
    """
    urn: String
    "Ordering key, unique per chat, allocated atomically (ascending from 1)."
    seq: Int!
    body: String!
    at: DateTime!
    authorUserId: ID
    authorWorkerId: ID
    "#1791 — posted by the platform itself (a system author, neither a user nor a worker): the wake-budget notice. Carries no mentions."
    authorSystem: Boolean!
    "Display convenience: the worker name or the user handle."
    authorName: String
    "Spec 049 Phase 8 (item J): the Worker's App when the post crossed Apps — visible as one in the transcript."
    authorAppId: ID
    "The session driving the worker author, when posted via sessionRef."
    sessionId: ID
    "The seq this message replies to, when it is a reply."
    replyToSeq: Int
    mentions: [String!]!
    "Immutable head identity/display pairs. Null means absent or withheld; [] means known empty."
    teamTags: [TeamTagSnapshot!]
  }

  type TeamChatMessagesPage {
    items: [TeamChatMessage!]!
    """
    Number of canonical messages matching this read's sinceSeq/beforeSeq cursor
    range and mentionsRef filter, before limit/offset. It is not the total
    number of messages in the chat or Channel when a cursor/filter is present.
    """
    total: Int!
    "#2181 — the Channel this page was read from. NULL only when the App has no team channel yet."
    channelId: ID
    "#2181 — that Channel's incarnation at the read; pin the next read or mark with expectedIncarnation."
    channelIncarnation: Int
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
    "The LLM model that produced the work, snapshotted at record time (#1398): an explicit report wins over the recording session's model; null on records that predate the field or were made with none — never backfilled, so null always means unknown-at-record-time."
    model: String
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
    """
    The App's canonical URN (the same value App.urn returns, e.g.
    hrn:app:acme.com:team), as a scalar identity suitable for cross-App
    worker lists. Null when the caller cannot inspect this App's workers. This
    intentionally does not return the App object, whose nested keys and
    members have a narrower read audience.
    """
    appUrn: String
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
    """
    #1026 — the portal link that opens this worker, mirroring Node.portalUrl
    (#881), so a worker signing an artifact under #1008 hands over a URL
    instead of assembling one out of a URN spelling the /app/u route may not
    resolve.

    Built from the SAME URN the urn field returns, so the two cannot diverge.
    Null on both arms and neither is an error: no configured portal origin
    means no link (a link to the wrong host is worse than none), and an App URN
    the fixed arity cannot take means no URN to build one from.
    """
    portalUrl: String
    "The cast-list role this filling answers ('backend-engineer')."
    role: String
    """
    #1024 — the repo affinity of this worker's ROLE, resolved so a client that
    already holds the worker needs no second round-trip to teamRoles. Clients
    may use it to warn on a role/repo mismatch at session start; the server
    does not enforce a repo-affinity refusal.

    WORKING-STATE field: behind the worker read gate and masked to [] on deny,
    like promptOverride and the holder — Session.worker reaches a Worker
    through a wider gate that admits any org member and survives a user leaving
    the App, so an ungated field would publish a team's repo list through any
    historical session.

    Masking to [] costs nothing, because empty already means "no affinity,
    never warn": a denied caller simply gets no warning, which is the safe
    direction for a signal that must never become a refusal. Same reason a
    worker with no role, a role with no definition, or an unreadable system
    memory all answer [] rather than erroring.
    """
    repos: [String!]!
    "Per-worker signature template, masked for nonreaders (hrn:node:hadronmemory.com:specs:cor:agt:040:04)."
    signature: String
    "Per-worker commit trailer template, masked for nonreaders (hrn:node:hadronmemory.com:specs:cor:agt:040:04)."
    trailer: String
    "Per-worker individuality layered over the agent's template prompt."
    promptOverride: String
    """
    #2045 — the canonical URN of the compiled boot prompt this worker's pointer names now
    (set for customised workers only). Null when no pointer is set OR when the caller may not see it (WORKING-STATE
    field, behind the worker read gate): null is not proof that no pointer exists.
    """
    bootPromptRef: String
    """
    #2045 — whether the pointer's target is deleted (soft or hard): true / false, and null when no pointer is set
    or the caller may not see it. Same gate as bootPromptRef. Nothing is served from a deleted target (R27).
    """
    bootPromptTargetDeleted: Boolean
    "The worker-scoped working memory in the App's container (null until provisioned)."
    memoryId: ID
    """
    #1050 — the human HOLDING this name, or null when nobody does.

    A name is held by a person, not by a live session: expiry, a reap, or a
    closed chat session never free it, and only an explicit release does. This
    is what separates the two meanings of \"taken\" — HELD is whose name it is,
    while a live session is only ever a question about your own worker.

    WORKING-STATE field, behind the worker read gate and masked to null on
    deny — like promptOverride and memoryId, and NOT like name/role/urn.
    Session.worker reaches a Worker row through a wider gate that admits any
    org member and survives a user leaving the App, so an ungated holder would
    let a former member read current staffing off a historical session.
    """
    heldByUserId: ID
    """
    When the current hold was taken. Null exactly when heldByUserId is — and
    likewise masked on deny.

    #1034: "taken" here is the HOLD's timestamp, unrelated to \`WORKER_TAKEN\`
    (a live worker session) and to \`TeamRoleName.taken\` (a name allocated in
    the register). Three senses of one word across two types.
    """
    heldAt: DateTime
    "S12 placement; null is withheld, UNSET is no recorded choice (including OFF-era casts)."
    teamPlacement: WorkerTeamPlacement
    """
    #1726 — the one Worker this worker reports to: a non-retired Worker of the
    same App, never itself, never a cycle. Null reports to nobody. A property of
    the casting, not of a session, so binding or ending a session leaves it
    alone. Changed with setWorkerReportsTo (or reportsTo at startSession); every
    change is a \`worker.reports-to\` team event. Masked on deny, like heldByUserId.
    """
    reportsToWorkerId: ID
    "#1726 — the Worker named by reportsToWorkerId; masked likewise."
    reportsTo: Worker
    "#1726 — true when this worker reports to a worker that has since retired (a stale claim nothing clears automatically)."
    reportsToRetired: Boolean!
    """
    hadron-cli#487 — whether anyone is DRIVING this name right now.

    Not availability: availability is the HOLD above (\`cor:agt:020:09\`), and an
    ended or idle session never frees a name. This says only whether someone is
    mid-stint, which is the question a coordinator asks about a name already
    theirs. Conflating the two is the CLI bug this field exists for.

    #1114 — COMPUTED, never stored: an unended session driven inside its
    type's idle window, with no promised hard expiry at or before now.
    An open row alone is insufficient. Inactivity does not end the session
    or release a human-held name. An eligible act may resume a lapsed session;
    a dormant or terminal session cannot be revived by an agent act.

    Uses the SAME predicate startSession refuses WORKER_TAKEN on
    (\`cor:agt:020:11\`) — a reader must not be told a worker is busy that a
    binder can take, and since #1114 that is load-bearing rather than tidy:
    with nothing ending abandoned sessions, an \`endedAt IS NULL\` gate would
    refuse a bind forever and leave force as the only route.

    Nullable BECAUSE of the read gate, not because the answer is unknown: this
    is a working-state field like heldByUserId, masked to null on deny rather
    than answering false, which would state a fact the server never computed.
    """
    hasLiveSession: Boolean
    """
    #1707 — the model family of this worker's binding (hrn:node:hadronmemory.com:specs:cor:agt:060:04):
    its newest open session's family. It follows the binding, not activity: a
    quiet session keeps it, and it is cleared when the session ends or replaced
    by a newer bind. Null when unbound, when the binding reported none, or on
    the same read gate as hasLiveSession. A matching input, never an
    authorization input.
    """
    family: String
    """
    #2252 — the model this worker's binding last reported: its newest open session's, the same fold, gate and
    lifecycle as family. Null when unbound, when the binding reported none (an older session's is never
    inherited), or on the same read gate as hasLiveSession. Self-declared: advisory, never authorization.
    """
    model: String
    """
    #2252 — when model was self-reported (a bind, a resume or an updateSession carrying a model; a repeat of the
    same model counts). Null when the session never reported one. A report time, not verified detection.
    """
    modelReportedAt: DateTime
    """
    #2252 (R189) — the coarse tier of model from the platform's one model-to-tier mapping: high (opus-class),
    mid (sonnet-class), low (haiku-class); null when the model is unmapped (no guessed equivalence for another
    family). Advisory: a coordinator's reading aid, never an authorization or routing input in this slice.
    """
    tier: String
    """
    hadron-cli#487 — when this worker was last DRIVEN, over every session it has
    ever had. Null for a worker nobody has ever bound, and that null is the
    point: a casting nobody picked up renders identically to one worked
    yesterday on every surface today, so a coordinator can dispatch into a
    channel no one reads and get no signal at all.

    The instant is the platform's one derivation of session activity — the
    greatest of startedAt, updatedAt, and the newest attributed usage event — so
    it agrees with the takeover prompt and with the idle window hasLiveSession
    is derived from (#1114: that window DESCRIBES a session, it no longer ends
    one). Masked to null on deny, like heldByUserId.
    """
    lastActiveAt: DateTime
    """
    #2138 §3.4 (experimental) — whether this worker is checking its team
    channel as expected, derived at read time. Masked to null on the same read
    gate as hasLiveSession.
    """
    checkStatus: WorkerCheckStatus
    "The role-agent behind the casting."
    agent: Agent
    "The App whose staff this casting fills."
    app: App
    """
    The worker's boot prompt, resolved: the agent's systemPrompt template
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

  enum WorkerTeamPlacement {
    UNSET
    NO_TEAM
    REPORTS_TO
  }

  """
  What castWorker WOULD do (#964) — an unsaved projection, deliberately not a
  Worker (no fake id to mistake for a real row). Scalars only: the ids/names
  here are attribution-level facts the mint-gate audience already sees, so no
  nested entity hands out its field resolvers.
  """
  type CastWorkerPreview {
    teamPlacement: WorkerTeamPlacement!
    reportsToWorkerId: ID
    "The name the cast would take — the caller's, checked free against the App's FULL roster (retired names stay taken). Required since #1050; a nameless preview refuses exactly where the cast would."
    name: String!
    "The casting's role: the agent's personaRole (it cannot be overridden, R222)."
    role: String
    "The role-agent the casting would bind."
    agentId: ID!
    agentName: String!
    """
    The composed boot prompt, post {{name}}/{{role}} substitution with
    promptOverride appended — the same composition Worker.prompt performs,
    reviewable BEFORE the name is permanent. Null when the agent carries no
    template and no override was given.
    """
    prompt: String
    "Whether the agent's systemPrompt binds {{name}} — a nameless template silently produces workers whose prompt never names them. Null when the agent has no template."
    hasNamePlaceholder: Boolean
    "#2024 — the tickers this cast would create, each at its effective cadence (the larger of the template's and the App's floor). Non-reserving: nothing is written or held, so a later cast may differ if the App changes. Empty when the Agent declares none."
    tickers: [CastPreviewTicker!]!
  }

  "#2024 — one ticker a cast would create from an Agent ticker template."
  type CastPreviewTicker {
    "The generated name: the template name, a middle dot, then the worker name."
    name: String!
    templateId: ID!
    templateRevision: Int!
    "What the template asks for."
    requestedCadenceSeconds: Int!
    "What the ticker gets: the larger of the requested cadence and the App's floor."
    effectiveCadenceSeconds: Int!
    relevance: TickerRelevance!
    reasons: [TickerReason!]!
  }

  """
  A role definition (#960): the roles:<role> node in the Team Agent's system
  memory. #1050: it carries no name register — a role is a definition, not an
  allocation pool.
  The prompt template is NOT here — with the Worker model (#974) it
  lives on the role-agent (personaRole + systemPrompt); roleAgent
  points at it.
  """
  type TeamRole {
    "The role slug, e.g. backend-engineer."
    role: String!
    "The node loc: roles:<role>."
    loc: String!
    nodeId: ID!
    description: String
    """
    #1024 — the repos a worker in this role normally works in, from
    \`data.repos\`. A SOFT signal for clients to warn on a role/repo mismatch at
    session start (hadron-cli#456): a worker bound as a server-engineer with
    \`--repo …/hadron-cli\` is usually a mistake and is sometimes deliberate.

    NEVER a refusal, and never inferred. Cross-repo work is legitimate — a
    coordinator does it by definition, and sibling repos share code — so a hard
    gate would be wrong the first time someone makes a genuine cross-cutting
    change. Affinity is declared, not guessed from the role slug, which happens
    to work for \`cli-engineer\` → \`hadron-cli\` and breaks for any team whose repo
    names do not match their role names.

    EMPTY AND UNSET ARE THE SAME: no affinity, never warn. A client cannot
    usefully act differently on the two, since "spans everything" and "not
    configured yet" both mean do-not-warn, and distinguishing them would make an
    unconfigured team look misconfigured.
    """
    repos: [String!]!
    """
    The single installed agent whose personaRole matches this role — exactly
    the agent a role-mode castWorker would use (null when zero or ambiguous).
    Runs Query.agent's own read gate and masks to null on deny (the #552
    posture), like Worker.agent.
    """
    roleAgent: Agent
    """
    Whether the role-agent's systemPrompt binds {{name}} — the check that
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

  """
  An organization's subscription to a memory it does not own.
  """
  type MemorySubscription {
    id: ID!
    memory: Memory!
    "The subscriber Organization when the caller may read it; memory access alone does not authorize it."
    organization: Organization
    role: Role!
    activated: Boolean!
    createdAt: DateTime!
  }

  """
  A connected PROVIDER ACCOUNT (identity record) — despite the name, this
  one type carries mailboxes, calendars and Drive accounts alike; the
  provider field below says which, and each routes to its own capability
  tool. Provider state lives in that tool, never here.

  Operations are identity-scoped: the connection's OWNER may perform them,
  and an App/headless caller may perform those covered by a live
  ConnectionGrant whose scopes include the operation's (requireEmailConnection
  enforces both branches, fail-closed for an unmapped operation). list and
  delete stay org-ADMIN management operations.
  """
  type ExchangeConnection {
    id: ID!
    organizationId: String!
    userId: String!
    mailboxEmail: String!
    displayName: String
    """
    Provider backing this connection. Dispatched per-connection through
    the tool registry: \`ms-exchange\`, \`gmail\`, \`google-cal\`,
    \`google-drive\`. (This said "'ms-exchange' today" until #1232 — true
    when written, and three providers out of date by the time it was
    published.)
    """
    provider: String!
    syncEnabled: Boolean!
    syncStatus: SyncStatus!
    lastSyncAt: DateTime
    lastError: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  One Slack workspace install of the Hadron Slack app (spec 043).
  Org-owned, workspace granularity: defaultAppId names the Hadron App that
  serves /hadron commands from this workspace. The bot + app tokens live
  ENCRYPTED IN THE TOOL (hadrontool-slack) — they are write-only inputs on
  createSlackConnection and no field here ever returns them.
  """
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

  """
  Uniform paginated list shape (cor:api:120).
  """
  type SlackConnectionsPage {
    items: [SlackConnection!]!
    total: Int!
  }

  """
  One registered EXTERNAL MCP server (hadrontool-mcp conduit registry).
  Org-owned. Static auth headers are encrypted at rest and WRITE-ONLY:
  no field here ever returns them — hasHeaders is all a reader gets.
  The row grants nothing by itself; every run-time call walks the policy
  chain as 'tool.mcp__<slug>__<tool>' plus the run's action budget.
  """
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

  """
  Uniform paginated list shape (cor:api:120).
  """
  type McpServersPage {
    items: [McpServer!]!
    total: Int!
  }

  """
  One tool an external MCP server advertises, as admitted by the
  registry row (allowlist + name grammar + length cap applied) — what
  this query returns IS what a run can declare in data.tools.
  """
  type McpServerTool {
    "The tool's name on the external server."
    name: String!
    description: String
    "The run-tool / policy name: mcp__<slug>__<name>."
    runToolName: String!
    "The tool's argument JSON Schema, passed through verbatim."
    inputSchema: JSON
  }

  """
  One named, owner-scoped secret — the general secret store (#677).
  Polymorphic owner (user | org | app | memory). The value is encrypted
  at rest and WRITE-ONLY: no field here ever returns it — kind + metadata
  are the inspectable half (you can see THAT a secret exists and, for
  webfetch-auth, WHERE it applies, without decrypting). A bare name
  resolves at run time via the CSS cascade, most-specific-first:
  memory -> app -> user -> org.
  """
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

  """
  Uniform paginated list shape (cor:api:120).
  """
  type SecretsPage {
    items: [Secret!]!
    total: Int!
  }

  """
  One registered Home Assistant instance (hadrontool-home-assistant
  registry, hadron-server#640). Org-owned. The long-lived access token
  is encrypted at rest and WRITE-ONLY: no field here ever returns it.
  The row grants nothing by itself; every run-time call walks the policy
  chain as 'tool.ha__<slug>__<op>' plus the run's action budget.
  """
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

  """
  Uniform paginated list shape (cor:api:120).
  """
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

  """
  One op of the CLOSED Home Assistant op catalog, as admitted by a
  registry row's allowlist — what this query returns IS what a run can
  declare in data.tools. The catalog is static (no upstream round-trip).
  """
  type HomeAssistantOp {
    "The op segment, e.g. call_service."
    op: String!
    description: String!
    "The run-tool / policy name: ha__<slug>__<op>."
    runToolName: String!
    "The op's argument JSON Schema."
    inputSchema: JSON
  }

  """
  Provider-neutral flag state (spec 002) — Graph's tri-state mapped to a
  neutral vocabulary so a future Gmail tool can map its own subset.
  """
  enum EmailFlag {
    FLAGGED
    NONE
    COMPLETE
  }

  """
  Result of emailSaveDraft: the provider-side draft (it lives in the
  mailbox's Drafts folder, not in any platform table — spec 002 US5).
  """
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
  its own UTC offset — a zone-less value is rejected by the calendar tool
  (validation_error), never guessed.
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

  """
  Invitation to join the platform (and optionally an organization)
  """
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

  """The invite-page view available to anyone holding the invitation slug."""
  type PublicInvitation {
    memberRole: Role!
    maxActivations: Int
    activationCount: Int!
    expiresAt: DateTime
    sender: PublicInvitationSender
    organization: PublicInvitationOrganization
  }

  "Only the sender display fields needed on the invite page."
  type PublicInvitationSender {
    name: String
    githubUsername: String
  }

  "Only the organization display name needed on the invite page."
  type PublicInvitationOrganization {
    name: String!
  }

  """
  Outgoing edge on a node, used in NodeInput.edges
  """
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
  Legacy bulk-import node shape retained for replaceSubtree compatibility.
  replaceSubtree now refuses without writing; single-node writes use
  CreateNodeInput / UpdateNodeInput (spec 039 Phase 0 D1).
  """
  input NodeInput {
    "Forced PK (importer-supplied UUIDv7 from node.yaml, stable across moves). Omit to mint."
    id: String
    """
    Memory reference. Accepts the entity's ID (CUID / 32-char hex) or its
    URN (per spec 007 ID-or-URN dispatch). URN inputs MUST be fully
    qualified (hrn:mem:<root>:<memory>) per spec 022 — relative-form URNs are
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
    """
    Replace all outgoing edges when provided (omit to leave edges unchanged)
    """
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
  #2044 (hrn:node:hadronmemory.com:specs:cor:agt:040:06) — names an App's INSTALL MEMORY by the pair that
  identifies it: the App and the Agent it customises. Both are ID-or-URN refs
  like every other entity ref (relative URNs are refused, URN_NOT_QUALIFIED).
  Accepted by createNode / updateNode in place of 'memoryId'. The install memory
  is created by the App's first customisation: a createNode through this target
  finds-or-creates it in the same transaction as the write, so a refused write
  leaves nothing behind. Only whoever manages the App may write through it, and
  only while the App is live and the Agent installed.
  """
  input InstallTargetInput {
    appRef: String!
    agentRef: String!
  }

  """
  Input for createNode. 'loc' and 'name' are required, plus EITHER 'memoryId'
  or 'install' (an App's install memory, #2044) — both or neither is an
  error (BAD_USER_INPUT). Creating is create-only — a live node at (memoryId,
  loc) rejects with NodeLocConflictError (spec 039 Phase 0 D1/D4).
  """
  input CreateNodeInput {
    "Forced PK (importer/sync use case, e.g. a stable UUIDv7). Only ever a create-id here — never a selector (D2). Omit to mint."
    id: String
    """
    Memory reference. Accepts the entity's ID (CUID / 32-char hex) or its
    URN (per spec 007 ID-or-URN dispatch). URN inputs MUST be fully
    qualified (hrn:mem:<root>:<memory>) per spec 022 — relative-form URNs are
    rejected as GraphQL errors with extensions.code "URN_NOT_QUALIFIED".
    """
    memoryId: String
    "#2044 — an App's install memory as the target, instead of 'memoryId'. See InstallTargetInput."
    install: InstallTargetInput
    loc: String!
    name: String!
    nodeType: String
    "#725 — collection discriminator (e.g. \\"competitor\\" / \\"insight\\"). NULL for an ordinary node."
    objectType: String
    "Whether this node can be run as a task by hadron_run_task (cor:api:060)."
    isRunnable: Boolean
    """
    #1201 — what this node is FOR (open string). NOT 'nodeType' (the
    platform-kind axis) and NOT 'objectType' (the collection discriminator).
    A GOVERNED family ('review', 'spec', 'decision', including dotted descendants)
    requires that kind's own door; generic createNode refuses it.
    """
    role: String
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
    "#2044 — selector, with 'loc', in place of 'memoryId': the App's install memory. Creates nothing (the first createNode does). XOR with 'id'."
    install: InstallTargetInput
    "Selector, with 'memoryId': the target's current loc. Not writable here — moveNode relocates."
    loc: String
    """
    Optional optimistic-concurrency precondition (#937). When supplied, the
    update is applied only while the node's current live revision still equals
    this positive 32-bit integer. A mismatch refuses atomically with
    NODE_WRITE_CONFLICT; omitting it or passing null preserves last-write-wins
    compatibility.
    Read the baseline from Node.revision.
    """
    expectedRevision: Int
    "Omit to preserve (D4)."
    name: String
    nodeType: String
    "#725 — collection discriminator (e.g. \\"competitor\\"). Omit to preserve; null to clear."
    objectType: String
    "Whether this node can be run as a task by hadron_run_task (cor:api:060). Omit to preserve."
    isRunnable: Boolean
    """
    #1201 — what this node is FOR (open string). NOT 'nodeType' and NOT
    'objectType' — see Node.role. Omit to preserve; null to clear. A GOVERNED
    value requires that kind's own door, and so does editing a node that
    ALREADY carries one: the gate reads the resulting state, not the change.
    """
    role: String
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
    """
    Replace all outgoing edges when provided (omit to leave edges unchanged)
    """
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

  type AppRunFailureReason {
    "Stable category: NOT_ADOPTED, MEMORY_UNREADABLE, CHANGED, OVER_BUDGET, NO_AI_CONFIG, TIMED_OUT, CANCELLED or OTHER."
    kind: String!
    "What happened, in plain words."
    summary: String!
    "Who can fix it."
    whoCanFix: String!
    "What to do, and where."
    nextStep: String!
  }

  """
  One headless run — the audit record AND (v1) the activation: policy
  snapshot, live budgets (zeroing halts the run), lifecycle, trigger
  provenance. Spec hrn:node:hadronmemory.com:specs:cor:agt:010:02.
  """
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

    A tool-loop call that is REJECTED (a provider or transport error, a tool
    denied by policy, a handler that threw, hadron_fail) counts the steps the
    SDK had already completed, once: the provider billed them. Usage the SDK
    did not report is not counted: the step that failed, and any completed step
    without token counts. Such a run can still under-report. A rejection before
    any step completed counts nothing, and unknown is never recorded as zero.
    Do not treat this as a billing figure.

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
    Priced LLM cost of this run in micro-cents (1e-8 USD), as a string (#2439):
    the sum of its usage events' cost. Events with no known price add nothing.
    NULL means UNKNOWN (a run minted before the counter existed), not zero.
    """
    costMicroCents: String
    """
    A failed run's cause in plain words (#2439): what happened, who can fix it
    and where. Null when the run has no failure. Static text derived from the
    failure and the run's budgets; it names no memory, id or tool, so it
    discloses nothing the caller does not already read. The raw failure stays
    available on the failure field.
    """
    failureReason: AppRunFailureReason
    """
    Spec 049 (D-2026-09-13-004): the scope this run carries, as YOU may read it —
    the snapshot taken at mint (the trigger's scope, or a spawned parent's)
    re-intersected with your access; memoryUrns lists what you may read of it
    and droppedCount the rest. Null ⇒ the run carries no named scope and its
    view is the App's attached memories ('app').
    """
    scope: SearchScopeInfo
    """
    Spec 049 Phase 6 (D-2026-09-13-007): the register this run's attendee
    (its Agent in its App) carried at mint, as YOU may act on it — rows from
    the snapshot, watermarks live, gates evaluated now. Empty when the run has
    no Agent (no attendee) or no rows.
    """
    register: [RegisterViewRow!]!
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
    # nested object inherits its own type's fields, including ungated App
    # scalars (the #552 class). Denied and deleted both
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
    "Spec 049: the scope this trigger's runs carry (null ⇒ 'app')."
    scopeId: ID
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
    "Spec 049 (D-2026-09-13-004): the scope this trigger's runs carry — a scope id, or a name resolved in the App's context (App › Agent › organization). Must be readable by you and resolvable in that App. Snapshotted onto each run at mint; omitted ⇒ the App's attached memories ('app')."
    scopeRef: ID
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
    "Spec 049: set the trigger's scope (id or name in the App's context); an empty string clears it back to 'app'."
    scopeRef: ID
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
    "Covered scopes: mail.read, mail.send, calendar.freebusy, calendar.read, drive.read."
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
    "Spec 049: the scope this trigger's runs carry (null ⇒ 'app')."
    scopeId: ID
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
    "Spec 049 (D-2026-09-13-004): the scope this webhook's runs carry — a scope id, or a name resolved in the App's context. Snapshotted onto each run at mint; omitted ⇒ 'app'."
    scopeRef: ID
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

  "Only text fields a spec bulk edit may change."
  enum SpecTextField { content abstract }

  """
  Replace text in explicit unminted nodes of one memory. A dry run returns
  a plan; apply must present that exact plan and refuses if any selected row,
  protection, match, or mint state changed. A minted target node is refused,
  even when other nodes in the memory are unminted. Other governed kinds and
  protected addresses are skipped; ordinary nodes need not carry the spec role.
  Generic replacement keeps its governed-node protections.
  """
  input SpecSearchReplaceInput {
    memoryRef: ID!
    nodeIds: [ID!]!
    oldText: String!
    newText: String!
    fields: [SpecTextField!]!
    caseInsensitive: Boolean = false
    regex: Boolean = false
    "Literal mode only; matches the CLI's default ASCII word-boundary behavior."
    wordBoundary: Boolean = true
    dryRun: Boolean = false
    "Required for apply; copied from the exact dry-run response."
    expectedPlan: String
    "Refuse the entire apply when more nodes would change."
    maxNodesChanged: Int
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

  "Mutually exclusive reasons selected nodes were protected from bulk replacement."
  type SearchReplaceSkipCounts {
    "Governed nodes of any kind. This is not a spec-only count."
    governed: Int!
    "Nodes at or below a Channel address."
    protectedAddress: Int!
  }

  enum SearchReplaceSkipReason { OTHER_GOVERNED_KIND PROTECTED_ADDRESS }

  type SearchReplaceSkip {
    nodeId: ID!
    loc: String!
    memoryId: ID!
    reason: SearchReplaceSkipReason!
    governedKinds: [String!]!
  }

  type SearchReplaceResult {
    "Unique authorized nodes selected before bulk-write protections are applied."
    nodesSelected: Int!
    "Selected nodes whose requested text fields were actually inspected."
    nodesScanned: Int!
    "Selected nodes protected from inspection and replacement."
    nodesSkipped: Int!
    """
    Mutually exclusive skip reasons. Governance takes precedence over Channel
    address protection, so a node carrying both signals counts once as governed.
    """
    skipCounts: SearchReplaceSkipCounts!
    "Nodes with at least one replacement."
    nodesChanged: Int!
    totalReplacements: Int!
    "Echoes the request — true means nothing was written."
    dryRun: Boolean!
    "Per-node breakdown; only nodes with at least one match are listed."
    results: [SearchReplaceNodeResult!]!
    "Opaque exact preview fingerprint on the spec door; null on the generic door."
    plan: String
    "Node-addressed protected selections on the spec door; null on the generic door."
    skips: [SearchReplaceSkip!]
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

  type UserMergeConsentRequest {
    proof: String!
    expiresAt: DateTime!
  }

  input MergeUsersInput {
    "Single-use dual-login proof from beginMergeUsersConsent, approved by both accounts. Required at execution; absent refuses MERGE_CONSENT_REQUIRED."
    consentProof: String
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
    """
    #928 coding-session provenance.
    """
    transcriptPath: String
    host: String
    tool: String
    """
    #1707 / hrn:node:hadronmemory.com:specs:cor:agt:060:04: the model family this session runs as, e.g.
    claude, codex or glm (a lowercase token). Omitted: derived from llmModel
    first, then tool — tool alone never classifies claude-code, since GLM runs
    inside it too — and a session nothing classifies gets no family, so its
    worker is not matched to queued tasks until one is given. A matching input,
    never an authorization input.
    """
    family: String
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
      workers_app_name_uniq indexes. With appRef, an App-key credential or an
      MCP active-App selection, lookup stays within that App. With no App,
      #1597 searches only live Apps the caller may bind into: exactly one
      non-retired match binds; none refuses WORKER_NOT_FOUND; several refuse
      SESSION_WORKER_NAME_AMBIGUOUS with candidates (worker id/URN, name, App,
      role and holder). Nothing is bound on ambiguity: choose an id or URN.
      Candidate discovery reuses App participation and user-owned-App holding
      rules; it grants no new bind authority. The staff read gate precedes
      name lookup (hrn:node:hadronmemory.com:specs:cor:agt:020:00).

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
    appRef. A retired worker refuses (WORKER_RETIRED). #1937: an id or URN
    naming a worker in an App the caller cannot read refuses exactly like an
    absent ref (WORKER_NOT_FOUND, same message and extensions), so no other
    refusal here tells an outsider the worker exists. The one exception is the
    worker the caller's own launchGrant names (see launchGrant). #940: a worker
    with a LIVE session (the shared derived liveness predicate) refuses
    WORKER_TAKEN — extensions carry workerId, sessionId,
    lastDriver, lastSeenAt, everything the takeover prompt needs — unless
    force is true (informed takeover, cor:agt:020:03: show who last drove it,
    proceed only on explicit override, never silently).
    """
    workerRef: String
    """
    #1726 — the worker this bind's worker reports to: an id, URN or name of a
    worker in the session's App. Sets it in the same step as the bind (a spawn
    brief), only when the worker reports to nobody or already to this one;
    naming a different worker is refused (WORKER_REPORTS_TO_HELD) unless the
    caller manages the App, and refuses the bind with it. Omitted leaves the
    value unchanged. Needs workerRef and a person behind the request.
    """
    reportsTo: String
    """
    #940: take over a worker whose binding would otherwise refuse WORKER_TAKEN.
    Only meaningful with workerRef. Clients must surface the WORKER_TAKEN
    payload (who last drove it, when) before retrying with force - that IS the
    informed-takeover contract; force exists so the override is explicit,
    never the default.
    """
    force: Boolean
    """
    #1709 — the single-use launch grant a host passed to the agent it started (hrn:node:hadronmemory.com:specs:cor:agt:070:08).
    Redeemed with the HOLDER's own token: it binds that worker on the holder's behalf and records the launching host,
    operation and task; the hold is unchanged. workerRef may be omitted (the grant names the worker). Refused
    LAUNCH_GRANT_INVALID when unknown, expired, used or not minted for the caller (an App key never redeems one);
    LAUNCH_REFUSED, failing the start with the reason, when the hold changed, the holder may no longer hold the
    worker, or it already has a live session. Never forced: with force it is BAD_USER_INPUT.
    The grant's own worker skips the #1937 worker read gate, because the grant already told its holder that worker
    exists: a holder who has lost the App gets LAUNCH_REFUSED with its reason rather than WORKER_NOT_FOUND, and so
    may learn that this one worker was retired (#1945). Any other workerRef sent with a grant is gated first.
    """
    launchGrant: String
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

    Null unless the asset would be served right now: its per-asset
    switch (publicLinkEnabled) is on, the deployment switch is on, and it is
    CLEAN in a live unencrypted memory. Also null when the server has no
    BASE_URL configured (no canonical origin to build an absolute URL from)
    even though it would be served, so null is NEVER proof the switch is off.
    """
    publicUrl:   String
    """
    #1667 — the per-asset public-link opt-in. STORED POLICY, not
    proof of publication: the anonymous link also needs the deployment switch
    (publicLinkAvailable) and a live, CLEAN asset in an unencrypted memory.
    Every asset starts false. Reading it grants no Asset read right.
    """
    publicLinkEnabled: Boolean!
    """
    Whether THE CALLER may switch this asset's public link right now: the
    memory's manager under the shared class-manager predicate, never a mere
    writer, and strictly the owner in a personal or private memory. False in a
    session's memory and in an encrypted memory. Not a download capability.
    """
    canManagePublicLink: Boolean!
    """
    Whether this deployment serves public links at all
    (ASSET_PUBLIC_HOTLINK_ENABLED). Independent of the stored opt-in, of who is
    asking, of the scan state and of whether a canonical origin is configured.
    Hide the switch when false; never infer this from publicUrl.
    """
    publicLinkAvailable: Boolean!
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

  """
  v2 (spec 006-asset-upload-redesign): memory-addressed input.
  memoryId is required for the attached upload path. The staging
  path (memoryId omitted) is added in US4.
  """
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

  """
  Single-node export (#386). MD/JSON are the canonical, round-trippable files;
  PDF is a presentation render (content only) produced by the internal
  hadrontool-pdf service and delivered BASE64. HTML remains reserved.
  """
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
    """
    { memoryCount } — how many memories the caller OWNS: the
    memories(filter: { ownedByMe: true }) slice, not everything they can read
    (#1231). Stated here because the population is the contract: a client that
    has to guess it writes its own count, and then the two disagree.
    """
    MEMORY_STATS
    """
    { agentCount } — how many agents the caller OWNS: the
    agents(filter: { ownedByMe: true }) slice (#1231). Owner-scoped for every
    caller, platform admins included.
    """
    AGENT_STATS
    "{ windowDays, buckets } — the caller's usage activity over a rolling window."
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

  """#1449 — how a spec corpus reference was found."""
  enum SpecReferenceKind {
    "A node URN in the corpus text (name, description, abstract or content), including inside a URL."
    URN
    "A real edge from a corpus node."
    EDGE
  }

  """#1449 — why a reference does not reach a written spec."""
  enum SpecReferenceProblem {
    "No live node at the cited loc."
    MISSING
    "The cited node is a placeholder: a reserved citation with no spec written yet."
    PLACEHOLDER
  }

  """
  #1449 — one reference to a spec in a draft corpus. For kind URN, field is
  the text field it was found in and text the URN as written; for kind EDGE,
  field is 'edge' and text the edge's relationship name.
  """
  type SpecReference {
    kind: SpecReferenceKind!
    sourceNodeId: ID!
    sourceLoc: String!
    "The scanned field; edge for a real edge; pendingEdge for an edge whose target is not a node yet."
    field: String!
    "The cited loc; for an edge into another memory, the target's node URN; for a pendingEdge not yet resolved to a node, its target as recorded (a loc, file id or URN)."
    targetLoc: String!
    text: String
    "Set only by specUnresolvedReferences."
    reason: SpecReferenceProblem
  }

  """#1449 — one spec a renumber moves (the spec or a descendant)."""
  type SpecRenumberMove {
    fromLoc: String!
    toLoc: String!
  }

  """#1449 — state of one node's reference rewrite in a renumber."""
  enum SpecRewriteStatus {
    "Dry run: this rewrite would be made."
    PLANNED
    REWRITTEN
    "A concurrent edit removed the references (or the node) before the rewrite, so nothing was written."
    UNCHANGED
    "The rewrite was refused or kept conflicting; error says why. The move itself stands."
    FAILED
  }

  """#1449 — one node whose URN references a renumber rewrites."""
  type SpecRenumberRewrite {
    nodeId: ID!
    loc: String!
    "The text fields rewritten."
    fields: [String!]!
    "How many URN references were rewritten."
    count: Int!
    status: SpecRewriteStatus!
    error: String
  }

  """
  #1449 — a moved citation that appears as bare TEXT (a link label, a node
  name, prose). Reported, never rewritten: it cannot be told apart from other
  characters in prose.
  """
  type SpecTextCitation {
    sourceNodeId: ID!
    sourceLoc: String!
    field: String!
    citation: String!
    "A short window of text around the citation."
    excerpt: String!
  }

  """#1449 — the result (or, with dryRun, the plan) of renumberSpec."""
  type SpecRenumberResult {
    dryRun: Boolean!
    moved: [SpecRenumberMove!]!
    rewrites: [SpecRenumberRewrite!]!
    textCitations: [SpecTextCitation!]!
  }

  """#1448 — why the mint report lists an item."""
  enum SpecMintFindingKind {
    "A reserved citation with no spec written yet."
    PLACEHOLDER
    "A reference to a spec that does not exist, or to a placeholder (rule: MISSING | PLACEHOLDER)."
    UNRESOLVED_REFERENCE
    "A structural lint error (rule: nodetype-info | tag-spec | serialization-leak | duplicate-loc)."
    LINT
    "An abstract written for an earlier body."
    STALE_ABSTRACT
    "#1591 — the node's current revision is not approved."
    NOT_APPROVED
    "#1591 — the approved revision's text changed outside the revision system, so it no longer matches its approval hash. Re-approve it."
    TAMPERED
    "#1591 — an edge, live pending edge or text citation (a prefixed node URN) into another memory's node that is not minted yet (targetLoc is its URN)."
    CITES_UNMINTED
  }

  """#1448 — one item in a mint report. loc is where it was found; targetLoc the cited spec, for a reference."""
  type SpecMintFinding {
    kind: SpecMintFindingKind!
    loc: String!
    rule: String
    message: String!
    targetLoc: String
  }

  """#1448 — one open question in the corpus (report-only, never blocks minting)."""
  type SpecOpenQuestion {
    loc: String!
    question: String!
  }

  """#1448 — open questions grouped by who decides; decider null means unassigned."""
  type SpecOpenQuestionGroup {
    decider: String
    questions: [SpecOpenQuestion!]!
  }

  """
  #1448 — the mint report. blockers must all be gone for a mint to succeed.
  staleAbstracts are listed separately; they block only when
  staleAbstractsBlock is true (once abstract re-affirmation is saved and
  deployed, server#1408). openQuestions never block.
  """
  type SpecCorpusMintReport {
    memoryId: ID!
    dryRun: Boolean!
    "True when this call stamped nodes in its mint scope; false for a dry run or an empty scope."
    minted: Boolean!
    blockers: [SpecMintFinding!]!
    staleAbstracts: [SpecMintFinding!]!
    staleAbstractsBlock: Boolean!
    openQuestions: [SpecOpenQuestionGroup!]!
    "#1591 — how many nodes this call minted (0 on a dry run or refusal)."
    mintedCount: Int!
    "#1591 — the locs of NEW nodes this call minted, or would mint on a dry run, ordered by loc."
    mintLocs: [String!]!
    "#1612 — the locs of already-minted nodes this call re-minted (edited since, or minted with no recorded revision), or would on a dry run, ordered by loc. A re-mint keeps the first mint's time and minter."
    remintLocs: [String!]!
    "#1612 — how many of mintedCount were re-mints."
    remintedCount: Int!
    "#1607 — nodes in mintLocs with open discussion: a WARNING, never a blocker (hrn:node:hadronmemory.com:specs:cor:dmo:110:07). Ordered by loc."
    unresolvedFeedback: [UnresolvedFeedback!]!
  }

  enum TeamSpecForm { SERVER CLIENT_INPUT }

  enum AutomationTriggerKind { SCHEDULE WEBHOOK MANUAL }

  "#2441: UNADOPTED = no valid adoption; ADOPTED = a valid adoption; CHANGED = the automation differs from what was adopted (computed on open only), so the next run fails AUTOMATION_CHANGED."
  enum AutomationAdoptionState { UNADOPTED ADOPTED CHANGED }

  "#2441: one flow of an automation (the entry flow or a flow it routes to)."
  type AutomationFlowSummary {
    urn: String!
    name: String!
    tools: [String!]!
    writes: [String!]!
  }

  "#2441: plain-language facts derived from the previewed automation. A fact the pin cannot show says not stated; nothing here is a maximum the approval enforces."
  type AutomationSummary {
    name: String!
    flows: [AutomationFlowSummary!]!
    reads: [String!]!
    writes: [String!]!
    tools: [String!]!
    schedule: String
    limits: [String!]!
    cannotDo: [String!]!
  }

  "#2441: what an adopter reviews before approving. depth carries only what previewAutomation returns to the same caller, plus the registered resources with URL userinfo and query removed."
  type AutomationApproval {
    state: AutomationAdoptionState!
    hash: String!
    summary: AutomationSummary!
    depth: JSON!
  }

  type AutomationApprovalRow {
    triggerKind: AutomationTriggerKind!
    triggerRef: String!
    name: String!
    state: AutomationAdoptionState!
    headline: String!
  }

  type AutomationApprovalOmission {
    triggerKind: AutomationTriggerKind!
    reason: String!
  }

  type AutomationApprovalPage {
    rows: [AutomationApprovalRow!]!
    nextCursor: String
    omitted: [AutomationApprovalOmission!]!
  }

  type Query {
    "Read a retained deleted node in a live memory that you can read and write. Returns the stored body without expanding templates or includes. hrn:node:hadronmemory.com:specs:cor:dmo:010:04"
    recoveryNode(nodeRef: ID!): RecoveryNode
    "Page through retained deleted nodes you can recover. Default 20, maximum 200; total counts all accessible results. No timed purge. hrn:node:hadronmemory.com:specs:cor:api:120:04"
    recoveryNodes(memoryRef: ID!, limit: Int = 20, offset: Int = 0): RecoveryNodesPage!
    "Inspect live edges and accessible deleted endpoints in one memory you can read and write. Default 20, maximum 200. hrn:node:hadronmemory.com:specs:cor:api:110:02"
    recoveryEdges(memoryRef: ID!, limit: Int = 20, offset: Int = 0): RecoveryEdgesPage!
    "#1719: review exact automation graph bytes and digest. triggerRef is the trigger row ID; MANUAL uses the origin AppRun ID. Only its run-as user or the manager of an App-only trigger may preview."
    previewAutomation(triggerKind: AutomationTriggerKind!, triggerRef: String!): JSON!
    "#2441: the schedules and webhooks of an App that the caller may adopt, with their adoption state. Authorization first, then ordered by (name, kind, id) and paged: limit defaults to 20, maximum 50; after is the previous page's nextCursor. MANUAL triggers are never listed (consent is per run); omitted says so. Only an adopter sees any row."
    automationApprovals(appRef: String!, limit: Int = 20, after: String): AutomationApprovalPage!
    "#2441: state, hash, plain summary and graph depth for one trigger. MANUAL takes the origin run id. Same gate as approveAutomation."
    automationApproval(triggerKind: AutomationTriggerKind!, triggerRef: String!): AutomationApproval!

    """
    #1705 — one agent task, or null when it does not exist or the caller may
    not read it (no existence oracle). Readers: the App's participants, workers
    acting through their sessions included (hrn:node:hadronmemory.com:specs:cor:agt:050:21).
    """
    agentTask(id: ID!): AgentTask

    "#1747 — the live tickers of an App the caller participates in. An App the caller cannot reach reads as APP_NOT_FOUND (hrn:node:hadronmemory.com:specs:cor:agt:080:18)."
    tickers(appRef: String!): [Ticker!]!

    """
    #2213 — \`tickers\` as a page: the same App gate, rows and order, with the real total.
    \`limit\` defaults to 20, 0 returns the count only, a negative limit is 0 and a limit
    over 200 is served as 200 (never refused). \`offset\` below 0 is 0.
    """
    tickersPage(appRef: String!, limit: Int, offset: Int): TickerPage!

    "#1747 — one ticker by id or hrn:ticker: URN; null when it does not exist or the caller may not reach it."
    ticker(ref: String!): Ticker

    "#1747 — an App's ticker settings: the cadence floor, the default self-subscription cadence, the live-ticker cap and the daily wake budget (hrn:node:hadronmemory.com:specs:cor:agt:080:05)."
    appTickerSettings(appRef: String!): AppTickerSettings!
    "App delivery settings for participants; cadence/window is the ticker floor (hrn:node:hadronmemory.com:specs:cor:agt:080:05)."
    appDeliverySettings(appRef: String!): AppDeliverySettings!

    "#1747 — one worker's wake settings (defaults when it has none), readable by the App's participants (hrn:node:hadronmemory.com:specs:cor:agt:080:03)."
    workerWakeSettings(workerRef: String!): WorkerWakeSettings!
    """
    #1748 — the wakes due now (hrn:node:hadronmemory.com:specs:cor:agt:080:08). Counts and seq ranges only; reads nothing it does not return.
    accepts (#2169, hrn:node:hadronmemory.com:specs:cor:agt:090:04): the reason kinds this caller can deliver. Omit it and no STOP notice is
    ever returned (the shipped ticker-wake). A call that lists STOP is offered the worker's newest undelivered stop notice, and
    declares the lane it serves (a host key: its own registration; a person who manages the App, or a key without a host:
    the unhosted lane) for STOP_CONSUMER_FRESH_SECONDS (default 600), but only when it read the lane from its start to its end in one call:
    no workerRefs, no after, and no next page (ask for first: 200; a lane larger than a page cannot declare). A worker whose host is lost has no serving lane until the host returns. Setting a stop signal is refused (STOP_SIGNAL_UNAVAILABLE)
    while any worker it would cover is on a lane with no fresh declaration.
    """
    dueWakes(appRef: String!, workerRefs: [String!], first: Int, after: String, accepts: [WakeKind!]): DueWakePage!
    """
    #2022 (hrn:node:hadronmemory.com:specs:cor:agt:090:07) — an App's stop signals, oldest set first. A person in the App sees
    every signal (worker narrows to those covering that worker now); a worker's session sees the live ones covering it; a
    host key sees its own host's. includeEnded adds ended ones (not for a worker's session). first: default 20, max 200.
    """
    teamStopSignals(appRef: String!, worker: String, includeEnded: Boolean, first: Int, after: String): StopSignalPage!
    """
    #2017 (S1) — the ready-to-deliver batches of the workers registered on the calling host (hrn:node:hadronmemory.com:specs:cor:agt:080:22, :26).
    An own live session reads only its bound worker. A host App key needs attention:deliver AND host:operate;
    the host is the key's, the request names none, and a worker not on that host is absent. The text is written by the server and typed unchanged. Reading moves nothing; acknowledge the batch ids.
    """
    deliveryBatches(appRef: String!, workerRefs: [String!], first: Int, after: String): DeliveryBatchPage!

    "#1709 — the App's host registrations, liveness derived now (hrn:node:hadronmemory.com:specs:cor:agt:070:01). Whoever reads the App's tasks and events, the App's own key included."
    hostRegistrations(appRef: String!): [HostRegistration!]!
    "#1709 — the App's host operations, newest first (hrn:node:hadronmemory.com:specs:cor:agt:070:02). Whoever reads the App's tasks and events. A host key (one ever granted host:operate, revoked or not) is refused with FORBIDDEN, whatever it passes: it sees its own host's operations only by collecting them (hrn:node:hadronmemory.com:specs:cor:agt:070:04 S5, Holger's ruling 0). after: the endCursor of the previous page."
    hostOperations(appRef: String!, hostId: String, status: HostOperationStatus, worker: String, first: Int, after: String): HostOperationPage!

    """
    #1705 — a team App's agent tasks, newest first. Party filters combine with the other selectors;
    owner / assignee / creator name a party of the App (a ref naming nobody matches
    nothing; a retired worker is no party to name, so it matches nothing). creator is
    the task's creator as createdBy projects it: a worker, or a person for a task they created
    themselves (not one their worker created, #2370). queued selects pending tasks with no assignee; rootsOnly selects roots. These
    take precedence over status and parentTaskId respectively. limit defaults to 20 (cap 200).
    Readers: the App's participants (hrn:node:hadronmemory.com:specs:cor:agt:050:21), or the App's own live key
    without a session binding (#1755).
    An App you do not participate in answers APP_NOT_FOUND, exactly like an
    absent one.
    """
    agentTasks(
      appRef: ID!
      status: [AgentTaskStatus!]
      owner: AgentTaskPartyInput
      assignee: AgentTaskPartyInput
      creator: AgentTaskPartyInput
      tag: String
      parentTaskId: ID
      rootsOnly: Boolean
      queued: Boolean
      limit: Int
      offset: Int
    ): [AgentTask!]!

    """
    #1705 — a task and every task below it, the root first, then by depth and
    creation. Null when the root is missing or unreadable. Bounded at 1000 rows.
    """
    agentTaskTree(root: ID!): [AgentTask!]

    """
    #1705 — a team App's event stream (hrn:node:hadronmemory.com:specs:cor:agt:050:11), in (createdAt, id)
    order. To read the next page pass after: the id of the last event you
    read; the cursor is the (createdAt, id) pair, so events sharing a
    timestamp are never skipped. since is a coarse time filter (strictly
    after), not a continuation. limit defaults to 20 (cap 200).
    """
    agentTeamEvents(
      appRef: ID!
      since: DateTime
      "The id of the last event read: the page continues strictly after it. An id that is not an event of this App is refused BAD_USER_INPUT."
      after: ID
      types: [String!]
      alarmsOnly: Boolean
      taskId: ID
      limit: Int
    ): [AgentTeamEvent!]!

    """
    #1706 — an App's effective stall windows (hrn:node:hadronmemory.com:specs:cor:agt:050:14–:17), and (#1763) its
    host-registration lapse (hrn:node:hadronmemory.com:specs:cor:agt:070:01). Readers:
    the App's task audience (hrn:node:hadronmemory.com:specs:cor:agt:050:21).
    """
    agentTaskStallSchedule(appRef: ID!): AgentTaskStallSchedule!

    """
    #1706 — every worker and model-family availability record in an App
    (hrn:node:hadronmemory.com:specs:cor:agt:060:02 / :03), each with whether it is in effect now. Readers: the
    App's task audience (interim until hrn:node:hadronmemory.com:specs:cor:agt:060:02's read question is ruled).
    """
    teamAvailability(appRef: ID!): TeamAvailability!

    """
    #1707 — every worker's derived state in an App (plan design:agent-tasks
    §7.4), computed server-side so the CLI and portal render one answer. Plan-
    derived, not a spec (hrn:node:hadronmemory.com:specs:cor:agt:050 leaves the roster out of scope). Readers:
    the App's task audience (hrn:node:hadronmemory.com:specs:cor:agt:050:21). Retired workers are left out.
    """
    teamRoster(appRef: ID!): TeamRoster!
    """
    #2061 — direct-report lanes from the same roster projection and read gate as teamRoster.
    One bounded RepeatableRead snapshot per call; no hierarchy rollups or role exclusions.
    """
    teamComposition(appRef: ID!): TeamComposition!
    "Declarative team JSON Schema (2020-12). apiVersion is the full identifier hadron.dev/team/v1alpha1; HTTP discovery uses /schemas/team/v1alpha1.json. CLIENT_INPUT additionally permits file parts for clients to inline; the server accepts SERVER only."
    teamSpecSchema(apiVersion: String!, form: TeamSpecForm = SERVER): String!
    """
    Resolve a fully-qualified, \`hrn:<type>:\`-prefixed Hadron URN (legacy \`urn:\` scheme also accepted) to the ids
    needed to reach its canonical page. Missing or inaccessible targets normally return null.
    Ambiguous legacy node references can instead refuse with extensions.code AmbiguousLegacyUrnError.

    Access is checked by kind: memory records use the memory-record read gate; nodes use the
    readable-memory set; organizations require membership (or platform administration);
    agents admit public visibility or owner/org access; Apps admit owner/org access;
    workers use the shared worker-read gate. Users resolve for themselves, a platform
    administrator, or a caller who shares an organization with them. App runs require org
    access, and node revisions use their captured memory (falling back to the current
    node's memory); a retracted comment's revision history resolves only for memory
    managers. Under impersonation only the support session's shared organization admits
    organizations, Apps, non-public Agents, workers and App runs, and a user-owned App or
    non-public Agent is not visible; a PUBLIC Agent still resolves. A retired worker still resolves. The kinds above are checked by kind,
    not an exhaustive promise. Dedicated queries can have different refusal shapes.

    The type prefix is the dispatch key; an untyped root:slug is ambiguous across kinds
    and returns null. The optional #data fragment is supported only for nodes and App runs.
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

    Self-audits are allowed subject to resource visibility. Cross-subject audits require
    platform administration, resource-org ADMIN/OWNER authority, or the applicable user-owner
    authority (including a strict-owner memory's principal). A forbidden audit is FORBIDDEN.
    Before that caller gate, unreadable memory/node/Agent resources are concealed as NOT_FOUND;
    self-audits conceal any unreadable resource the same way. Impersonation is restricted to
    the shared org and refuses identity-scoped or other-org resources with FORBIDDEN.

    Once admitted, a subject with no access is a SUCCESS with an empty grants list
    (all capabilities false, role null). Unknown subjects and unresolvable resource refs
    are NOT_FOUND. This query's supported resource kinds are not every resolveUrn kind.
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
         name a live memory is treated as form 2 (a full URN); pass
         'memoryRef' to force loc interpretation.

    raw: true selects stored content without include or variable resolution.
    Soft-deleted nodes do not resolve. Access uses the caller's readable-memory
    set. A denied or missing node returns null; an explicit memoryRef that is
    missing or unreadable raises MEMORY_NOT_FOUND. When addressed in a system
    memory by memoryRef or a full node URN, a loc with no local node may read
    through to an eligible inherited node under its own address; overrides and
    boot prompts are excluded. An unscoped bare loc does not search inheritance.
    """
    node(ref: ID!, memoryRef: ID, raw: Boolean): Node

    """
    Render one node to a portable, self-contained file (spec cor:api).
    full: true (default) returns the CANONICAL form — byte-identical to
      "hadron node export <urn>", all sections, round-trippable via
      "hadron node import". Requires MD or JSON; sections is ignored.
    full: false returns a PRESENTATION render of the selected sections
      (default: all); not guaranteed round-trippable.
    Auth: same node-read gate as node(ref:). (HTML/PDF + asUrl delivery land
    later; the result shape is forward-compatible.)
    """
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
      "Spec 049 (D-2026-09-13-002): search under a named scope — a scope id, a bare scope name (needs appRef), 'app' (the App's attached memories; needs appRef), or 'global' (the active organization's view — orgId, or your single membership). The scope's memories are intersected with your access (a lens never grants; the rest is disclosed as scope.droppedCount) and filter.memoryIds narrows WITHIN it. Omitted: the pre-049 behaviour — your accessible set, optionally narrowed by orgId."
      scope: String
      "Spec 049: the App context for a bare scope name or for scope: 'app' (ID or URN)."
      appRef: ID
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

    Paged in the repo standard idiom: limit (default 20, capped 200) + offset
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
      "Spec 049 (D-2026-09-13-002): run the memory + node slices under a named scope — a scope id, a bare name (needs appRef), 'app' (needs appRef), or 'global' (orgId, or your single membership). See findNodes.scope; the result's scope field discloses what applied."
      scope: String
      "Spec 049: the App context for a bare scope name or scope: 'app' (ID or URN)."
      appRef: ID
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
    (id tiebreak); limit default 20 / cap 200; limit: 0 -> count only.
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
    #1177 section 3 — the SKILL SEAM: the server judges, the client does I/O.

    One surface serving skill lint, skill status and skill export. The client
    sends what it can see of each file on disk; the server returns a drift
    CLASS and the lint findings per declared node, plus the rendered body for
    anything the client is to write.

    A QUERY, not a mutation, and that is the contract. Nothing here writes to a
    node — publishing is one-way, and the only writer in the feature is the
    client's own filesystem. So status and lint cannot write by construction
    rather than by promise.

    The client cannot name a drift class: the vocabulary is the server's, so it
    cannot drift between clients. A node failing lint is never given a rendered
    body, so a client cannot write a file the server judged broken.
    """
    skillPlan(input: SkillPlanInput!): SkillPlan!
    """Selected individual skill files only. Plugin bundles cannot use node selectors."""
    selectedSkillFilePlan(input: SelectedSkillFilePlanInput!): SkillPlan!

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

    """
    Usage events (most recent first), optionally filtered by type, memoryId,
    or nodeId.

    Access control (#250): results are always scoped to memories the caller
    may read (org membership / subscriptions / public / owned personal+private
    per spec 034; ADMIN/OWNER see all EXCEPT another user's personal/private
    memories and, per spec 047, another user's user-owned memories). A
    memoryId the caller can't read returns [] (no existence leak); the global
    form (no memoryId) is bounded to the readable set, never cross-tenant.

    memoryId is a memory identifier — accepts the memory's ID or URN. Results
    are scoped on the denormalized UsageEvent.memoryId column (#796), so an
    event stays attributed to its memory after its node is deleted.

    nodeId is a node token accepting a PK, a fully-qualified URN, or a bare
    loc (no memoryId needed):
      - PK / URN  → resolved to a single node; scoped via its exact nodeId FK
                    (memory-precise).
      - bare loc  → exact nodeLoc match, bounded to readable memories; not
                    existence-checked. Shape-classified: a loc with 3+
                    colon-separated segments qualifies as node-URN shape and
                    takes the PK/URN branch instead — use loc for those.
                    (This used to read "like nodeUsage but access-scoped" —
                    a comment that named an ungated sibling without anyone
                    following the pointer back. nodeUsage was gated in #802
                    and deprecated as redundant in the same issue.)

    loc — the VERBATIM exact nodeLoc filter (never shape-sniffed, so every
    loc works, hierarchical spec citations included), bounded to readable
    memories; not existence-checked. The migration target for the deprecated
    nodeUsage(loc:) above — same match, same gate (PR-986 review, Codex P2).
    Mutually exclusive with nodeId (BAD_USER_INPUT when both are passed).
    """
    usageEvents(type: String, memoryId: ID, nodeId: ID, loc: String, limit: Int, offset: Int): [UsageEvent!]!
    """
    #2212 - \`usageEvents\` as a page: the same READER gate, the same loc/nodeId rules and the same readable-memory
    scope, ordered newest first with an id tiebreak, with the real total. Sizes as \`tickersPage\`.
    """
    usageEventsPage(type: String, memoryId: ID, nodeId: ID, loc: String, limit: Int, offset: Int): UsageEventPage!

    """
    Revision history for a node, most recent first.

    Accepts the node's ID or URN. Access-gated on the node's memory: a node
    whose memory the caller can't read returns an empty list (no existence
    disclosure).
    """
    nodeRevisions(nodeRef: ID!, limit: Int): [NodeRevision!]!
    """
    #2212 - \`nodeRevisions\` as a page: the same access gate (a miss or an unreadable node is an empty page),
    with the snapshot-memory gate applied before counting, so \`total\` and the pages hold only snapshots you
    may read and never fall short near the limit. Newest first with an id tiebreak. Sizes as \`tickersPage\`.
    """
    nodeRevisionsPage(nodeRef: ID!, limit: Int, offset: Int): NodeRevisionPage!
    "#1591 — the tamper check: recompute the node's approval hash from its current title/abstract/content and compare it with the approval on record. A pure read; an encrypted memory needs its session key (SESSION_EXPIRED otherwise)."
    verifyNode(nodeRef: ID!): NodeIntegrityCheck!
    "#1632 — one signing request; null when unknown or when its node is not readable to the caller."
    signingRequest(id: ID!): SigningRequest
    "#1591 — the tamper check over every live node of a memory (ID or fully-qualified URN)."
    verifyMemoryNodes(memoryRef: String!): MemoryIntegrityReport!

    "#1606 — the discussion on a node (ID or URN), newest thread first. Read-gated on the node's memory; an unreadable or missing node is COMMENT_TARGET_NOT_FOUND."
    commentThreads(targetRef: ID!, state: [CommentThreadState!], limit: Int = 20, offset: Int = 0): CommentThreadPage!
    "#1606 — one comment by ID or URN; null when missing or unreadable."
    comment(ref: ID!): Comment

    "#1641 — a decision log's settings by ID or URN; null when missing or unreadable."
    decisionLog(ref: ID!): DecisionLog
    "#1641 — one decision by ref (ID or URN), or by code (DU, or a citation DU-1) within logRef. Null when missing or unreadable."
    decision(ref: ID, code: String, logRef: ID): Decision
    """
    #1641 — the decisions of one log (logRef), or with awaitingMe the OPEN decisions the caller
    decides across every memory they can read. State is derived for every candidate BEFORE the
    filters, sort and paging; a list above 5000 candidates refuses (DECISION_LOG_TOO_LARGE_FOR_FILTER).
    """
    decisions(
      logRef: ID
      awaitingMe: Boolean
      state: [DecisionState!]
      tier: DecisionTier
      urgency: [DecisionUrgency!]
      authorizes: Boolean
      sort: DecisionSort = PORTAL_DEFAULT
      limit: Int = 20
      offset: Int = 0
    ): DecisionPage!
    "#1641 — re-render a decision from its payload and check it against its content, data and approval: the findings behind its state."
    verifyDecision(ref: ID!): DecisionVerification!

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
    """
    Sessions VISIBLE to the caller, newest first — not only the caller's own.
    The scope is authorization-derived (\`sessionScopeFilter\`): a platform
    ADMIN/OWNER sees sessions in its audience, an App key sees its own App's, and an
    ordinary user sees those of Apps in any org they belong to **plus** every
    session of their user-owned Apps and every session attributed to them
    (these identity-scoped branches do
    not apply through impersonation). So a client must not present these as "my
    activity" — many rows may be attributed to other users or Apps.
    Sessions bound to personal/private memories additionally require that
    memory's strict owner, with no admin or impersonation override. A pure App
    key may also read only the session it is itself bound to.

    Unfiltered, this is also the GENERAL row of every \`type\`, worker-bound or
    not (#1034), so it is equally not a list of worker sessions.

    workerRef (#974): only sessions bound to that Worker (by id), newest first
    - the 'taken right now' / 'last driven by' read (cor:agt:020:03). That
    filter is what narrows this to worker sessions.
    """
    sessions(type: String, repo: String, customerId: String, workerRef: String, limit: Int, offset: Int): [Session!]!
    """
    #2212 - \`sessions\` as a page: the same session scope and filters (a blank or unresolvable workerRef is
    an empty page), newest first with an id tiebreak, with the real total. Sizes as \`tickersPage\`.
    """
    sessionsPage(type: String, repo: String, customerId: String, workerRef: String, limit: Int, offset: Int): SessionPage!
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
    githubUsername by substring, email by exact match, and name for platform
    admins or users sharing one of the viewer's active org memberships.
    Name-ascending order (id
    tiebreak); limit default 20 / cap 200; limit: 0 -> count only.
    """
    users(filter: UserFilter, limit: Int, offset: Int): UsersPage!

    """
    Current authenticated user
    """
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
    currently-live sessions. limit default 20 / cap 200.
    """
    impersonationSessions(orgId: String, filter: ImpersonationSessionFilter, limit: Int, offset: Int): ImpersonationSessionList!

    """
    Uniform paginated organization list (#473) — replaces organizations +
    myOrganizations. Scope: the caller's memberships; platform ADMIN/OWNER
    get every live org (the established admin unscoped reach) unless
    filter.memberOnly restricts the list to their own memberships (the old
    myOrganizations view, as a slice-as-filter). Name-ascending order (id
    tiebreak); limit default 20 / cap 200; limit: 0 -> count only.
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

    """
    Invitation lookup (public to the slug holder). Returns only invite-page
    display fields; accepting the slug still performs its own authorization.
    """
    invitation(slug: String!): PublicInvitation

    """
    Fetch a single Memory (org member, shared-read gate, or platform ADMIN).
    Missing and unreadable refs both return null without an error, so a caller
    cannot use this field to test whether a private memory exists. Malformed
    refs still fail as caller errors, and operational faults still propagate.

    'ref' accepts the entity's ID or URN.
    """
    memory(ref: ID!): Memory

    """
    #2044 (hrn:node:hadronmemory.com:specs:cor:agt:040:06) — the App's install memory for an Agent: where the App
    keeps its customisation of that Agent. Null when the App has not customised it
    yet (this read creates nothing), and null for anyone the memory's record is not
    open to: the App's participants, and whoever manages the App.
    """
    installMemory(appRef: String!, agentRef: String!): Memory

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

    Name-ascending order (id tiebreak); limit default 20 / cap 200;
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
    #2213 — \`dashboardWidgetPresets\` as a page: the same owner scope and order, with the
    real total. Empty for a non-user or impersonated caller. Sizes as \`tickersPage\`.
    """
    dashboardWidgetPresetsPage(
      "Return only presets for this widget type. Omit for all of them."
      type: DashboardWidgetType
      limit: Int
      offset: Int
    ): DashboardWidgetPresetPage!

    """
    Exchange connections for an org.

    Accepts the entity's ID or URN.
    """
    exchangeConnections(orgId: ID!): [ExchangeConnection!]!

    """
    #2213 — \`exchangeConnections\` as a page: the same admission (org ADMIN/OWNER,
    platform admin) and FORBIDDEN refusal, the same rows and order, with the real
    total. Sizes as \`tickersPage\`.
    """
    exchangeConnectionsPage(orgId: ID!, limit: Int, offset: Int): ExchangeConnectionPage!

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
    Team-name-ascending order (id tiebreak); limit default 20 / cap 200;
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
    Slug-ascending order (id tiebreak); limit default 20 / cap 200;
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
    tiebreak); limit default 20 / cap 200; limit: 0 -> count only.
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
    bypass). Slug-ascending order (id tiebreak); limit default 20 / cap
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
    Export a drive file through the connection's provider tool. Grant scope:
    drive.read is required for an App context's covering connection grant.
    Without an App context, the caller must own the connection; org
    administration alone does not grant access. The server delegates format conversion, binary-file refusal
    and size validation to that tool; it does not independently enforce those
    provider guarantees here. Returns the tool's content, MIME type and format.
    """
    driveFileExport(connectionRef: ID!, fileId: ID!, format: DriveExportFormat): DriveFileExport!

    """
    Uniform paginated app list (#473) — replaces the org-ADMIN apps(orgId!)
    and the member myApps. Scope: Apps in the caller's member orgs (App
    doesn't carry a userId, so org membership is the routing); platform
    ADMIN/OWNER unscoped get every live App. orgId follows cor:api:100:01
    (member -> scope, non-member -> empty page, no disclosure, no admin
    bypass). Name-ascending order (id tiebreak); limit default 20 / cap 200;
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
    """
    The App authenticated by the current AppKey (null for JWT users without an App)
    """
    myApp: App

    """
    The uniform single-agent read. Uses the shared Agent read gate, including
    PUBLIC visibility and owner-aware access to user-owned Agents. An absent
    or unreadable Agent returns null; malformed or under-qualified refs remain
    input errors. Nested fields keep their own exposure gates.

    'ref' accepts the entity's ID or URN.
    """
    agent(ref: ID!): Agent
    """
    #1892 (hrn:node:hadronmemory.com:specs:cor:dmo:050:15) - an Agent's tasks, across its base chain:
    every runnable node in its effective system memory, and every task the
    tasks index of an Agent in the chain lists, each once. A task an index
    lists carries that edge's name as its trigger, the nearest index's where
    two list it. Readable by whoever may read the Agent's system memory; a
    listed task outside the chain's memories is returned only when its own
    memory is readable too. Refused as AGENT_NOT_FOUND otherwise. The MCP tool
    hadron_agent_tasks returns the same list. Accepts the Agent's ID or URN.
    #2421 experiment: optional symptom ranks only runnable effective-chain tasks
    with non-empty abstracts; summary vectors and abstract-only lexical matches
    share hybrid ranking. At most 3 candidates (limit defaults to 3, larger
    values clamp); empty symptom or non-positive limit is BAD_USER_INPUT.
    Without symptom the list is unchanged. matchedBy identifies ranking inputs.
    """
    agentTaskList(ref: ID!, symptom: String, limit: Int): [AgentListedTask!]!
    """
    #1892 (hrn:node:hadronmemory.com:specs:cor:dmo:050:16) - an Agent's processes: the ones its own
    processes index lists (STARTS, with the edge's trigger), then the ones with
    a stage edge (named 'stage ...') to one of its agentTaskList tasks (INVOLVED, no
    trigger), each once. Same gate as agentTaskList; the MCP tool
    hadron_agent_processes returns the same list. Accepts the Agent's ID or URN.
    """
    agentProcessList(ref: ID!): [AgentListedProcess!]!

    """
    Uniform paginated agent list (#473). Scope: Agents owned by the caller's
    member orgs; platform ADMIN/OWNER unscoped get every live Agent. orgId
    follows cor:api:100:01 (member -> scope, non-member -> empty page, no
    disclosure, no admin bypass). filter narrows by type / visibility.
    filter.ownedByMe (#782) narrows to the caller's own user-owned (org-less)
    agents for every caller including platform admins. Name-ascending order
    (id tiebreak); limit default 20 / cap 200; limit: 0 -> count only.
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

    Name-ascending order (id tiebreak); limit default 20 / cap 200;
    limit: 0 -> count only.
    """
    publicAgents(filter: PublicAgentFilter, limit: Int, offset: Int): AgentsPage!
    """
    005-agent-subscription FR-005: AgentSubscriptions held by the
    authenticated user. Read-only in v1.
    """
    myAgentSubscriptions: [AgentSubscription!]!

    """
    005-agent-subscription FR-022: list all AgentSubscriptions for an
    Agent. Authorized for ADMIN/OWNER of the Agent's owning org.

    Accepts the entity's ID or URN.
    """
    agentSubscriptions(agentRef: ID!): [AgentSubscription!]!

    """
    Nodes in the App's current readable installed-Agent memory scope, with
    eligible inherited system-memory nodes. Participants additionally receive
    the App's team space; org-authorized readers do not gain that space merely
    from org membership. Live access, link roles and App scoping constrain the
    result; this is not every memory linked to any installed Agent.

    Accepts the App's ID or fully qualified URN. NodeFilter narrows node fields,
    including objectType, approvalState and minted. Nonempty memoryIds or
    memoryClasses are rejected with BAD_USER_INPUT: the App scope is authoritative.
    Unlike findNodes, system-node types are not excluded by default. Deleted
    content remains subject to recovery authority. NodeFilter.contentScope
    COMMENTS or ALL can select comments. When contentScope is omitted,
    nodeType=comment selects COMMENTS; otherwise the default CONTENT excludes
    comments. Filters on approvalState or minted always exclude comments.
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
    (default 20, hard-capped 2000) + offset; total is the memory's full node
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
    List keys for an App, only for whoever manages the App
    (hrn:node:hadronmemory.com:specs:cor:dmo:050:12; hrn:node:hadronmemory.com:specs:cor:acl:010:01).
    Never an App key, a bound worker session or an impersonated request.

    Accepts the entity's ID or URN.
    """
    appKeys(appRef: ID!): [AppKey!]!

    """
    025-oauth-for-mcp FR-004: list the calling User's API keys (active
    + revoked, createdAt DESC). Powers Phase 3's portal revocation UI
    (SC-006). Rejected with UNAUTHENTICATED for AppKey-resolved
    callers (no user in context). Impersonation is refused with Forbidden.
    """
    myUserApiKeys(
      "#2298: include keys the owner hid with setUserApiKeyHidden. Default false."
      includeHidden: Boolean = false
    ): [UserApiKey!]!

    """
    #1631 PR3: the caller's own passkey records, revoked ones included, newest first. Only the
    owner sees them: an App key or an impersonation session is refused. Registering and revoking are interactive
    ceremonies on the server-hosted pages, never GraphQL. Present only while passkey registration is enabled.
    """
    myPasskeys: [PasskeyCredential!]!

    """
    Agent AI config (org ADMIN) — returns the decrypted API key so the
    portal backend can make LLM calls on behalf of the user.

    036-ai-service-config: registry-backed (the Agent's config named
    'default'). Prefer resolveAIConfig for new callers.

    Accepts the entity's ID or URN.
    """
    agentAIConfig(agentRef: ID!): AgentAIConfig

    """
    The uniform single-config read. 'ref' is the config's ID (not a URN).
    Masked: never returns key material, only hasApiKey + apiKeyPreview
    (resolveAIConfig is the privileged decrypted read). Auth mirrors the list:
    platform ADMIN/OWNER for HADRON_SERVER; org ADMIN for ORGANIZATION;
    the App/Agent's owner or owning-org ADMIN for APP/AGENT. User-owned
    Apps and Agents use their strict owner-only credential gate, even for
    platform admins. Denied throws Forbidden, except an unreadable owning
    Agent answers AGENT_NOT_FOUND. A missing config returns null.
    """
    aiServiceConfig(ref: ID!): AiServiceConfig

    """
    036-ai-service-config: masked, paginated list of AI configs (#473).
    Never returns key material — only hasApiKey + apiKeyPreview.

    filter names the owning entity. Auth: platform ADMIN/OWNER for
    HADRON_SERVER owners; org ADMIN of the owning org for ORGANIZATION /
    APP / AGENT owners. filter omitted entirely = the platform ADMIN/OWNER
    cross-owner view of every config (non-admin callers must filter).

    Name-ascending order (id tiebreak); limit default 20 / cap 200;
    limit: 0 -> count only.
    """
    aiServiceConfigs(filter: AiServiceConfigFilter, limit: Int, offset: Int): AiServiceConfigsPage!

    """
    Spec 049 Phase 2 — the uniform single-scope read (cor:api:120). 'ref' is
    the scope's ID (a Scope has no URN yet). Null when missing OR when you may
    not read it — no existence disclosure. Read gate: an org scope to that
    org's members, an App scope to the App's participants, an Agent scope to
    whoever may read the Agent.
    """
    scope(ref: ID!): Scope

    """
    #1325 — a memory's config, for the memory's managers only. For anyone else,
    and for a missing memory, the same MEMORY_NOT_FOUND.
    """
    memoryConfig(memoryRef: ID!): MemoryConfig!

    "#1325 part (c) — one template you manage, by id; null for anything else, including a missing or deleted one."
    memoryConfigTemplate(ref: ID!): MemoryConfigTemplate

    """
    #1325 part (c) — the templates you manage, name-ascending. Default page 20,
    at most 200; limit 0 returns the count only.
    """
    memoryConfigTemplates(filter: MemoryConfigTemplateFilter, limit: Int, offset: Int): MemoryConfigTemplatesPage!

    """
    Spec 049 Phase 2 — paginated list of the scopes you may read, optionally
    narrowed by owner, by an App's resolution context, by name, and by the
    cor:api:100:01 orgId (member-gated, no admin bypass; non-member ⇒ empty
    page). Name-ascending (id tiebreak); limit default 20 / cap 200; limit: 0
    ⇒ count only.
    """
    scopes(filter: ScopeFilter, orgId: ID, limit: Int, offset: Int): ScopesPage!

    """
    Spec 049 Phase 2 — explain a scope for YOU. Pass scopeRef, or a bare name
    plus appRef (a name is unique only per owner, so it resolves in an App's
    context: App › Agent › organization, never unioned — two installed Agents
    each owning the name is SCOPE_NAME_AMBIGUOUS and you choose by scopeRef).
    Returns the readable memories in order, the dropped COUNT, the shadowed
    scopes, and with \`loc\` which memory would win for that address.
    """
    scopeExplain(scopeRef: ID, name: String, appRef: ID, loc: String): ScopeExplanation

    """
    Spec 049 Phase 4 — the uniform single-Channel read. 'ref' is the Channel's
    id or its ADDRESS — the chat root's node URN, which is \`Channel.chatRootUrn\`
    and what \`createChannel(memoryRef, loc)\` composes to (#1171). Null when
    missing, when the ref names nothing, OR when you may not read its host
    memory — identically, so this is never an existence oracle.
    """
    channel(ref: ID!): Channel

    """
    Spec 049 Phase 4 — Channels whose host memory you may read, narrowed by an
    App (its host memories' Channels) or by one memory, and by the cor:api:100:01
    orgId. Loc-ascending (id tiebreak); limit default 20 / cap 200.
    """
    channels(filter: ChannelFilter, orgId: ID, limit: Int, offset: Int): ChannelsPage!

    """
    Spec 049 Phase 5 — one register entry. Null when missing OR when you may
    neither read its Channel's host memory nor stand on the row's owner side.
    """
    registerEntry(ref: ID!): RegisterEntry

    """
    Spec 049 Phase 5 — register entries you may read (§8.6), narrowed by owner
    (an App or an organization), Channel, or attendee (a Worker or an Agent),
    and by the cor:api:100:01 orgId. A filter naming something foreign returns
    the same empty page as one naming nothing. Oldest first; limit default 20 / cap 200.
    """
    registerEntries(filter: RegisterEntryFilter, orgId: ID, limit: Int, offset: Int): RegisterEntriesPage!

    """
    Spec 049 Phase 6 — an attendee's RESOLVED register: the rows that apply to
    a Worker (workerRef) or to an Agent in an App (agentRef + appRef), one per
    Channel, with YOUR standing on each host memory. The relay reads this
    instead of a configured appRef. Gated on App participation (the same gate
    as the Worker's briefing); a foreign or nonexistent attendee is an empty list.
    """
    attendeeRegister(workerRef: ID, agentRef: ID, appRef: ID): [RegisterViewRow!]!

    """
    Spec 049 Phase 7 — an attendee's cursor on a Channel (attendeeRef: a Worker,
    or an Agent with appRef). Same gate as attendeeRegister; lastSeenSeq 0 when
    the attendee has never checkpointed there; null when unreadable or unknown.
    channelRef: the Channel's id or its address (\`Channel.chatRootUrn\`, #1171).
    """
    channelReadState(attendeeRef: ID!, appRef: ID, channelRef: ID!): ChannelReadState

    """
    #1353 v1 attention query, retired by #1384. This field always returns
    UPGRADE_REQUIRED; use teamAttentionPage for bounded polling. Pass an
    existing v1 since token to teamAttentionPage to carry its watermark
    forward. Neither operation changes read state.
    """
    teamAttention(appRef: ID!, since: String): TeamAttentionResult!

    """
    #1384 paged (v2) attention poll — the bounded successor to teamAttention
    (v1 answers UPGRADE_REQUIRED). Each call decrypts at most scanLimit rows
    (encrypted Channels), counts plaintext Channels with bounded SQL
    aggregates (#1779: a window of 200 seqs per scanLimit unit per Channel
    visit, 400 per call), and emits at most limit Worker/Channel pairs; continue with page while
    nextPage is present. The final page alone carries adoptableSince — adopt
    it only after EVERY listed nudge was accepted; on any partial failure
    retain the prior watermark and restart the scan (duplicates, never loss).
    An existing v1 since token starts a scan, carrying the watermark forward.
    Never changes read state.
    """
    teamAttentionPage(
      appRef: ID!
      since: String
      page: String
      limit: Int
      scanLimit: Int
    ): TeamAttentionPage!

    """
    #1384 paged switchover preview — same bounded scan as teamAttentionPage,
    full-backlog accounting. The apply proof exists ONLY on the final page of
    a completed preview; confirmTeamAttentionSwitchover (apply) is unchanged.
    """
    teamAttentionPreviewPage(
      appRef: ID!
      page: String
      limit: Int
      scanLimit: Int
    ): TeamAttentionPreviewPage!

    """
    Preview the explicit baseline switchover for the operator's current live
    Workers. Read-only: inspect the exact cursors, heads and unread counts,
    then pass proof to confirmTeamAttentionSwitchover within ten minutes.
    """
    teamAttentionSwitchoverPreview(appRef: ID!): TeamAttentionSwitchoverPreview!

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

    Auth: a named App uses its own owner/org ADMIN gate, including strict
    owner-only access for a user-owned App. A named Agent must be installed
    in that App. Without an App, an org Agent requires org ADMIN; a host-only
    context requires platform ADMIN/OWNER. A user-owned Agent is strictly
    owner-only, including when an App is also named. With no effective org,
    its owner can decrypt that Agent's own config or a user-owned App's
    config; a host fallback is unavailable through this query. A user-owned
    App's owner needs the outer source's own authority to decrypt an installed
    Agent or org config; its App ownership alone grants only its App config.
    A HADRON_SERVER fallback can back a server-side call, but only a platform
    ADMIN/OWNER may receive its plaintext key. Other callers get a typed
    refusal naming the resolved config and HADRON_SERVER level.

    appRef/agentRef accept the entity's ID or URN.
    """
    resolveAIConfig(name: String, appRef: ID, agentRef: ID): ResolvedAiConfig!

    """
    #1373: the known endpoints for a provider — the server's single suggestion
    list, so the portal and the CLI render the same choices and neither
    hardcodes a URL. Empty for an unknown provider and for bedrock (its
    endpoint comes from the region). Public reference data (vendor URLs), so
    it needs no auth.
    """
    aiProviderEndpoints(provider: String!): [AiProviderEndpoint!]!

    """
    036-ai-service-config: the MASKED set of configs RESOLVABLE in an
    execution context — every distinct config name a chat in this context
    could select. Populates a config picker in the chatbot UI.

    Same walk as resolveAIConfig (App -> Agent -> Org (of the App, else of
    the Agent) -> HadronServer), but returns ALL names instead of resolving
    one: configs are deduped by name with the innermost owner winning, so
    each entry is the row the resolution walk selects for that name; this
    masked listing does not grant permission to decrypt it. Only
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

    """
    Message history for a saved chat. Returns plain role/content pairs
    suitable for feeding back into an LLM.

    limit bounds the transcript to its MOST RECENT messages (default 20),
    and they are returned oldest-first. Stated because it was not: the window
    used to be taken from the other end, so a chat longer than the limit
    returned its opening forever (#1111), and a client author had no written
    contract to check that against. Contract: cor:cht:050:01.

    beforeSeq (#1116) pages BACKWARD: only messages with seq strictly LESS
    than it are considered, and the window then returns the newest "limit"
    of those -- the page immediately preceding the cursor, still oldest-first.
    It is the mirror of teamChatMessages' sinceSeq: pass the OLDEST seq you
    hold, as you would pass the newest to page forward. Omit it for the tail.

    There is no total -- the field returns the page and nothing else. A
    page SHORTER than the limit is a truthful end-of-data under that cursor,
    and only here: this resolver applies every filter inside the query and
    never drops a row after the database take, so the take IS the page. Do
    not carry the same-looking inference to reads that overfetch and
    post-filter; there a short page can still mean rows were removed.
    Two boundaries worth knowing before you build on it:
      - A message with NO seq is older than every numbered one
        (cor:cht:050:02), so every cursor includes such messages. They are
        reachable, but they cannot themselves BE a cursor -- a legacy chat
        holding more counterless messages than one page cannot be paged
        through them. Only pre-#919 transcripts are affected.
      - seq is unique going forward but NOT on pre-#919 rows. Where two
        legacy messages share a seq, a cursor at that value excludes both,
        so paging can skip the sibling. See #992 for the underlying gap.
    """
    chatHistory(chatId: String!, limit: Int, beforeSeq: Int): [ChatMessage!]!

    """
    Read a team App's chat (#939), seq-ordered ascending, as a uniform
    { items, total } page. sinceSeq is a watermark cursor: only messages with
    seq STRICTLY GREATER than it are returned (pass the last seq you have
    seen). With neither cursor nor offset, the NEWEST page is returned, still
    ascending. Pass sinceSeq: 0 to start a forward walk at the oldest message.
    beforeSeq (#1116) is its BACKWARD mirror for scroll-up paging: only
    messages with seq STRICTLY LESS than it are considered, and the NEWEST
    limit of those come back -- the page immediately before the cursor, still
    ascending. The two compose, so passing both reads a bounded slice.
    TeamChatMessagesPage.total counts that cursor range and the mentionsRef
    filter before paging, not the whole team-chat history.
    An explicit offset retains oldest-first positional paging for existing
    clients; prefer cursors for new reads. offset is IGNORED when beforeSeq is
    given: a cursor exists precisely because a position is unstable while
    workers keep posting, and honouring both would put that race back.
    mentionsRef filters to messages whose stored envelope mentions the
    referenced worker (a Worker id or name of THIS App, retired included) or
    user (handle/id) — matching runs against the mention tokens extracted at
    write time, never by re-parsing bodies. For a worker it returns what
    reaches that worker (#2020): its name, replies to it, and an @all/@team
    broadcast the server stamped at post time because its author could wake
    everyone (hrn:node:hadronmemory.com:specs:cor:agt:080:14); never the
    worker's own posts. A user ref matches the handle alone. The ref must name this App's own
    staff or members (a Worker of the App, an AppMember, or the caller); an
    unresolvable or foreign mentionsRef yields the empty page identically (no
    existence oracle). limit defaults to 20 (cap 200); limit: 0 returns only
    total.

    Authorization: an AppMember of the App (any role), an org member with
    CONTRIBUTOR+ on the App's org, the owner of a user-owned App, or the
    App's own key (a pure App-key principal may READ its team chat).
    Error codes (extensions.code): FORBIDDEN (an authenticated caller who is
    not a participant), UNAUTHENTICATED (no principal at all; checked before
    the App is resolved, so it answers identically whether or not the App
    exists).

    appRef and mentionsRef accept the entity's ID or URN.
    """
    teamChatMessages(
      appRef: ID!
      """
      Only false suppresses automatic read-cursor advancement. Session
      attribution, read usage and the eligible owned-session heartbeat remain.
      Omitted, null and true preserve normal contiguous-page acknowledgement;
      callers opting out acknowledge explicitly after successful delivery.
      """
      advanceReadState: Boolean = true
      sinceSeq: Int
      beforeSeq: Int
      mentionsRef: ID
      "Stable authorized head ID; mutually exclusive with untagged."
      teamHeadRef: ID
      "Select no stored head identity (legacy absent or explicit empty). Requires metadata access."
      untagged: Boolean
      limit: Int
      offset: Int
    ): TeamChatMessagesPage!

    """
    Spec 049 Phase 8 — read ANY Channel by ref (its id, or its address —
    \`Channel.chatRootUrn\`, #1171), with teamChatMessages'
    cursors, mentions filter and paging; teamChatMessages is the
    appRef → App.defaultChannel convenience over this. Authorization is the
    host App's team-chat read gate; a Channel you may not read — or one that
    does not exist — is CHANNEL_NOT_FOUND, identically.
    TeamChatMessagesPage.total has the same cursor- and mention-filtered
    meaning as for teamChatMessages, before paging.
    """
    channelMessages(
      channelRef: ID!
      sinceSeq: Int
      beforeSeq: Int
      mentionsRef: ID
      "Stable authorized head ID; mutually exclusive with untagged."
      teamHeadRef: ID
      "Select no stored head identity (legacy absent or explicit empty). Requires metadata access."
      untagged: Boolean
      limit: Int
      offset: Int
      """
      #2181 — pin the read to the Channel incarnation you read. A different incarnation, before or after the page is
      read, is CHANNEL_INCARNATION_CHANGED with nothing returned and no cursor, check stamp or session resume applied;
      the server never retargets. Omitted: the read is UNFENCED, as before.
      """
      expectedIncarnation: Int
      """
      #2181 — as on teamChatMessages: only false suppresses automatic read-cursor advancement (session attribution, the
      check stamp and the heartbeat remain), so a pinned page can be acknowledged explicitly after it is delivered.
      """
      advanceReadState: Boolean = true
    ): TeamChatMessagesPage!

    """
    Read a team App's worklog (#947) — the provenance query: which sessions
    (and transcripts) produced this PR? Newest first, as a uniform
    { items, total } page. ref accepts ANY accepted spelling (URL, short form,
    canonical) and is matched tool-awarely: with tool 'github' (or none) it is
    normalized, so 'https://github.com/o/r/pull/371' and 'o/r#371' return the
    same records. An ownerless github ref such as cli#793 matches every
    readable canonical ref whose repository ends in cli and number is 793;
    it never selects one owner. With another tool ref matches the stored
    verbatim spelling; with no tool it matches either. sessionRef / tool / kind
    are equality filters; kind must be one of pr, issue, commit, branch, repo
    when given.
    limit defaults to 20 (cap 200); limit: 0 returns only total.

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
    Workers CURRENTLY held by userRef across Apps the caller may inspect
    (#1344), oldest casting first. userRef accepts a user id, handle, URN, or
    email. Missing users, no holds, and holds confined to unreadable Apps all
    return the same empty page; total and pagination are computed only after
    the App authorization filter.

    Retired castings are hidden unless includeRetired. hasLiveSession on each
    item uses the existing derived idle-window predicate — it means the worker
    is being driven now, not merely that an unended Session row exists.
    """
    heldWorkers(userRef: String!, includeRetired: Boolean, limit: Int, offset: Int): WorkersPage!

    """
    An App's role definitions (#960): every roles:<role> node in the Team
    Agent's system memory. Ordered by role slug. Same read authorization as
    workers.

    #1050: no register projection. This once existed chiefly to answer "which
    names are still free", which needed the App's FULL roster and so could not
    be computed client-side — with names no longer allocated from a pool there
    is no such question, and the read is a plain list of definitions. teamAgentRef disambiguates when more than one installed agent
    carries a roles: branch (TEAM_AGENT_AMBIGUOUS otherwise); an encrypted
    system memory without an active session key refuses SESSION_EXPIRED.
    """
    teamRoles(appRef: ID!, teamAgentRef: ID, limit: Int, offset: Int): TeamRolesPage!

    """
    #2024 — the live ticker templates of an Agent, by name. Anyone who can read the Agent. An Agent the caller cannot read answers
    as absent (AGENT_NOT_FOUND).
    """
    agentTickerTemplates(agentRef: String!): [AgentTickerTemplate!]!

    """
    Dry-run castWorker (#964): run the cast's exact resolution — same
    arguments, same typed refusals (WORKER_AGENT_NOT_FOUND / _AMBIGUOUS /
    _NOT_INSTALLED, WORKER_NAME_REQUIRED, WORKER_NAME_TAKEN,
    WORKER_NAME_CONFUSABLE, WORKER_NAME_RESERVED, WORKER_NAME_RESERVED_TEAM_PREFIX
    (only while TEAM_TAGS_ENABLED), APP_UNINSTALLED),
    same MINT gate — up to but not
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
      "S12 head choice: requires staffing and App management; refuses WORKER_REPORTING_CAST_UNAVAILABLE if standby becomes available without cast coverage integration."
      reportsTo: ID
      "S12 explicit no-team choice; omit reportsTo. Both keys conflict, single null/blank/false is invalid. Omission remains UNSET while enforcement is OFF."
      noTeam: Boolean
      promptOverride: String
    ): CastWorkerPreview!

    # ── Assets (spec 004-asset-upload + 006-asset-upload-redesign) ────
    """
    v1 — agent-addressed listing. Deprecated; use memoryAssets.
    """
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
      limit:  Int = 20
      offset: Int = 0
    ): AssetsPage!

    """
    Mint a short-TTL presigned GET URL for an asset. Default TTL
    5 minutes; ceiling 1 hour. Gated on the holding memory's read
    access and on scan_status = CLEAN.
    """
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

    """
    #1449 — what refers to the spec at loc in a spec corpus (any memory since
    #1591): node URNs in the corpus text (inside URLs too) plus real edges from
    corpus nodes. Exact citation, not descendants. memoryRef accepts the
    memory's ID or URN.
    """
    specBacklinks(memoryRef: ID!, loc: String!): [SpecReference!]!

    """
    #1449 — references in a spec corpus (any memory since #1591) that do not reach a written
    spec: URNs citing a missing loc or a placeholder, edges to a
    placeholder or to a deleted spec of the corpus, and pending edges (field pendingEdge) whose target is not
    a written node yet. Minting refuses while any remain.
    """
    specUnresolvedReferences(memoryRef: ID!): [SpecReference!]!

    """
    One run (cor:agt:010:02). ref is an AppRun ID or an
    hrn:apprun:<root>:<app>:<run-id> URN (#696). Readable by a platform admin,
    a READER of the run's organization, the run's own App key, or a user with a
    live App relationship for a run on their behalf or a MANUAL run they
    started. A run the caller may not read returns null, exactly like a
    missing one (#1577: no existence oracle).
    """
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

    status is DEPRECATED in favour of statuses but remains accepted.
    When statuses is non-null it wins, including an empty list; omitted or
    null statuses falls back to status. No removal date is promised here.

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
    "Present and true only when this deployment offers node signing. Discovery never grants access to sign."
    signing: Boolean!
    "Present and true only when passkey registration is enabled separately from node signing."
    passkeyRegistration: Boolean!
    """
    HADRON_SERVER_VERSION — the MCP/API-surface contract version.
    """
    version: String!
    """
    The deployment's canonical base URL (BASE_URL, else the local default).
    """
    baseUrl: String!
  }

  type Mutation {
    "Restore one retained deleted node in a live memory you can read and write. Restore deleted ancestors first; governed nodes, comments, compiled boot prompts and protected internal addresses refuse. Does not restore descendants or revisions. hrn:node:hadronmemory.com:specs:cor:acl:130:02"
    restoreNode(nodeRef: ID!): Node!
    "#1719: rebind a trigger to its reviewed graph. expectedHash must match previewAutomation; edits since preview refuse adoption."
    reAdoptAutomation(triggerKind: AutomationTriggerKind!, triggerRef: String!, expectedHash: String!): Boolean!
    "#2441: adopt the automation by the hash the adopter reviewed (automationApproval.hash). Same door as reAdoptAutomation: one APPROVE event per successful call, even when nothing changed. A changed automation answers AUTOMATION_CHANGED."
    approveAutomation(triggerKind: AutomationTriggerKind!, triggerRef: String!, expectedHash: String!): Boolean!
    "#2441: decline. An adopted trigger is revoked, so its next run fails AUTOMATION_UNADOPTED (REVOKE event); with nothing adopted it changes no state (DECLINE event). A MANUAL origin deletes its consent row. Runs already started keep their snapshot."
    declineAutomation(triggerKind: AutomationTriggerKind!, triggerRef: String!): Boolean!

    """
    #1705 — create an agent task (hrn:node:hadronmemory.com:specs:cor:agt:050:06 root, :07 child). Writes
    task.created, and task.assigned when an assignee is named. A worker acts
    through its session (X-Hadron-Session); a person acts as themselves.
    A root task's creator may name its owner at creation — any participating
    worker or person (#1757, hrn:node:hadronmemory.com:specs:cor:agt:050:01, ruled 2026-10-11).
    Typed refusals: TASK_NOT_FOUND (a parent the caller cannot read, or in
    another App), TASK_NOT_ASSIGNEE, TASK_ENDED, TASK_CHILD_OWNER_MISMATCH,
    TASK_OWNER_INVALID, TASK_ASSIGNEE_INVALID, SESSION_NOT_BOUND,
    APP_NOT_FOUND (an App that does not exist or that you do not participate
    in, alike), APP_UNINSTALLED, FORBIDDEN (impersonation), BAD_USER_INPUT.
    Every write re-checks the caller's participation and the App's state
    inside its transaction.
    #2198 (experiment): createAgentTask, assignAgentTask, reassignAgentTask and
    finishAgentTask may succeed WITH warnings, in the response's
    \`extensions.warnings\` (not in \`errors\`): a list of
    { path (the mutation's response key), code, text, register? }. Codes are a
    closed list per release (task.create.no-source, task.assign.assignee-unavailable,
    task.assign.assignee-busy, task.assign.assignee-paused,
    task.finish.open-children); a client must tolerate unknown codes. \`text\` is
    fixed per code. \`register\` appears only for a caller that has an Agent:
    { state: mapped (taskLoc, taskUrn) | unmapped | unresolved }. A warning never
    blocks and never reveals another worker's state to a caller who could not
    already see it on the roster.
    """
    createAgentTask(input: CreateAgentTaskInput!): AgentTask!

    """
    #1747 — create a ticker in an App (hrn:node:hadronmemory.com:specs:cor:agt:080:01, :18). Any App participant, or a
    session bound to a worker of the App, up to the App live-ticker cap. The owner is the
    caller, never an argument. Refusals: TICKER_NAME_TAKEN, TICKER_CADENCE_OUT_OF_RANGE,
    TICKER_LIMIT_REACHED, TICKER_QUIET_HOURS_INVALID, APP_NOT_FOUND, APP_UNINSTALLED.
    """
    createTicker(appRef: String!, input: TickerInput!): Ticker!

    """
    #2024 — declare a ticker on an Agent. Whoever may edit the Agent (ADMIN on it); an App manager is not thereby an Agent editor.
    Affects only FUTURE casts. Refusals: TICKER_TEMPLATE_NAME_TAKEN, TICKER_TEMPLATE_LIMIT_REACHED, TICKER_CADENCE_OUT_OF_RANGE,
    TICKER_QUIET_HOURS_INVALID, BAD_USER_INPUT (reasons), AGENT_NOT_FOUND, FORBIDDEN.
    """
    createAgentTickerTemplate(agentRef: String!, input: AgentTickerTemplateInput!): AgentTickerTemplate!

    """
    #2024 — change a template; absent fields are unchanged. expectedRevision must be the revision you read, else
    TICKER_TEMPLATE_REVISION_MISMATCH and nothing is written. Affects only future casts.
    """
    updateAgentTickerTemplate(id: ID!, expectedRevision: Int!, input: AgentTickerTemplatePatch!): AgentTickerTemplate!

    "#2024 — remove a template (it stays as history; its name may be reused). expectedRevision as for update. Tickers already generated from it are untouched."
    deleteAgentTickerTemplate(id: ID!, expectedRevision: Int!): Boolean!

    "#1747 — change a ticker. Its owner, the holder of its owning worker, or whoever manages the App. The slug never changes."
    updateTicker(ref: String!, input: TickerPatch!): Ticker!

    "#1747 — delete a ticker. Its live subscriptions end with reason TICKER_DELETED; its name may be reused, its slug never."
    deleteTicker(ref: String!): Boolean!

    """
    #1747 — change an App ticker settings (hrn:node:hadronmemory.com:specs:cor:agt:080:05, :19). Whoever manages the App only.
    Refusals: TICKER_SETTINGS_OUT_OF_RANGE, TICKER_SETTINGS_CONFLICT (a floor above a live ticker cadence),
    DELIVERY_SETTINGS_CONFLICT (the shared cadence floor must keep stuckWindowSeconds greater than busyDelaySeconds + minCadenceSeconds).
    """
    setAppTickerSettings(appRef: String!, input: AppTickerSettingsInput!): AppTickerSettings!
    "App managers only; omitted preserves, null refuses. Standby activation is unavailable until S7 (hrn:node:hadronmemory.com:specs:cor:agt:080:19)."
    setAppDeliverySettings(appRef: String!, input: AppDeliverySettingsInput!): AppDeliverySettings!
    "#2138: pause or resume the whole team, as whoever manages the App. Separate from each worker's own pause: a worker cannot lift it, and ending it clears no self-pause. While paused, no worker is nudged and every worker's check status is PENDING (TEAM_PAUSED)."
    setTeamPause(appRef: String!, paused: Boolean!): TeamPause!
    """
    #2022 (hrn:node:hadronmemory.com:specs:cor:agt:090:01, :06) — set a stop signal. Whoever manages the App: any level and
    scope. A host key: a HALT on its own host only. Never replaces another signal. Refusals: APP_MANAGER_REQUIRED,
    HOST_SCOPE_REQUIRED, STOP_SIGNAL_SCOPE_FORBIDDEN, STOP_SIGNAL_NOT_FOUND (the target), BAD_USER_INPUT, APP_NOT_FOUND.
    #2173/#2169 (R95): setting ANY signal is refused with STOP_SIGNAL_UNAVAILABLE while a worker it would cover is on a lane with
    no fresh stop-consumer declaration (a worker would be stopped without being told; the extensions name the worker count and the
    lanes). A consumer declares a lane by polling dueWakes with accepts: [STOP]. Lifting and listing are unaffected.
    """
    setTeamStopSignal(input: SetTeamStopSignalInput!): StopSignal!
    """
    #2022 (hrn:node:hadronmemory.com:specs:cor:agt:090:05, :06) — lift a stop signal. Whoever manages the App, any; a host key, a HALT on its own host.
    Lifting one never ends another. changed is false when it had already ended. Refusals as setTeamStopSignal.
    """
    liftTeamStopSignal(appRef: String!, id: ID!): LiftStopSignalResult!

    """
    #1747 — subscribe a worker to a ticker (hrn:node:hadronmemory.com:specs:cor:agt:080:20, :25). Its holder and whoever manages
    the App, to any ticker; the worker itself only at or slower than the App self-subscription cadence
    (SUBSCRIBE_CADENCE_NEEDS_HOLDER); a worker holding the may-subscribe-workers grant, with a person
    behind the call, for OTHER workers only. Idempotent for a live subscription. A grant use is announced
    to the team chat, best-effort: announcement says POSTED or FAILED, and the subscription stands either way.
    """
    subscribeWorker(tickerRef: String!, workerRef: String!): SubscribeResult!

    "#1747 — end a worker subscription. The same callers as subscribeWorker, and the worker itself, always."
    unsubscribeWorker(tickerRef: String!, workerRef: String!): SubscribeResult!

    """
    #1747 — change a worker wake settings (hrn:node:hadronmemory.com:specs:cor:agt:080:03, :21): the worker itself, its holder, or whoever manages
    the App, in either direction. Never the may-subscribe-workers grant.
    """
    setWorkerWakeSettings(workerRef: String!, input: WorkerWakeSettingsInput!): WorkerWakeSettings!
    """
    S7 (#2023, R85) — isolate a worker until a time (default 2 hours, at most 7 days; a later time extends, an earlier one shortens).
    Only a person managing the App or holding the worker, acting as themselves. Refusals, in the order they are checked:
    an unknown worker, or one the caller cannot read (a pure App key among them), is WORKER_NOT_FOUND; a worker session (even a
    manager's) is WORKER_ISOLATION_FORBIDDEN; while S7 activation is off, setting an isolation is WORKER_ISOLATION_UNAVAILABLE
    (clearing is unaffected), so an ordinary person gets this before the manager/holder check; an impersonation that reaches the
    write is refused FORBIDDEN (read-only); a participant who neither manages the App nor holds the worker is
    WORKER_ISOLATION_FORBIDDEN. Never touches the worker's own pause.
    """
    isolateWorker(workerRef: String!, until: DateTime): WorkerWakeSettings!
    "S7 — lift an isolation (same audience). Clearing when none is set changes nothing."
    clearWorkerIsolation(workerRef: String!): WorkerWakeSettings!
    "#1748 — record that wakes were delivered (hrn:node:hadronmemory.com:specs:cor:agt:080:16). Never moves a read position."
    acknowledgeWakes(proofs: [String!]!): AcknowledgeWakesResult!
    """
    #2017 (S1) — record that delivery batches were typed (hrn:node:hadronmemory.com:specs:cor:agt:080:16, :17). Only the receiving host key or the worker's own receiving live session, within 15 minutes.
    The delivered mark rises to the end of each rendered range; with through (one batch only), only the listed channels move, each to a
    rendered seq of its own. Writes no read position, tick or budget. A repeat changes nothing.
    """
    acknowledgeDeliveryBatches(batchIds: [String!]!, through: [BatchThrough!]): AcknowledgeWakesResult!

    """
    #1709 — a host registers, or refreshes, which of its App's workers it can launch, as which model family, and in
    which worktrees it declares (hrn:node:hadronmemory.com:specs:cor:agt:070:01). The server validates their tokens, not filesystem existence. A host key only: an App key holding
    host:operate, which names the host; the request names none (hrn:node:hadronmemory.com:specs:cor:agt:070:04). Refreshing within the App's lapse count
    of poll intervals keeps it live. Refused HOST_KEY_REQUIRED for anyone else, APP_KEY_SCOPE_REQUIRED without the
    scope, APP_KEY_SESSION_BOUND with a session, BAD_HOST_REGISTRATION for a bad shape or a worker not of the App.
    """
    registerHost(input: RegisterHostInput!): HostRegistration!
    """
    #1709 — a host collects its own operations, oldest first: those still ISSUED (now marked COLLECTED) and those it
    collected and has not reported, except a worker.start whose launch grant is still live (#1928: a re-collection never
    revokes a launch in flight). Only its own host's, in its own App (hrn:node:hadronmemory.com:specs:cor:agt:070:04).
    first: at most 200, default 20.
    """
    collectHostOperations(appRef: String!, first: Int): [HostOperation!]!
    """
    #1709 — a host reports an operation's final outcome: SUCCEEDED, or FAILED with a reason
    (hrn:node:hadronmemory.com:specs:cor:agt:070:03). Only after collecting it, and only its own host's (another's is
    HOST_OPERATION_NOT_FOUND). The same outcome again answers the operation as it is; a different one is
    HOST_OPERATION_ALREADY_REPORTED. Writes host.operation.succeeded or host.operation.failed.
    """
    reportHostOperation(input: ReportHostOperationInput!): HostOperation!
    """
    #1709 — a host marks a worker it registers UNAVAILABLE, only as OUT_OF_TOKENS or HOST_DOWN, or clears a mark it set
    itself (hrn:node:hadronmemory.com:specs:cor:agt:060:08). It never replaces or clears anyone else's mark, a stall
    among them: AVAILABILITY_NOT_PERMITTED.
    """
    setHostWorkerAvailability(input: SetHostWorkerAvailabilityInput!): WorkerAvailability!
    """
    #1709 — issue an operation to one of the App's registered hosts (hrn:node:hadronmemory.com:specs:cor:agt:070:05).
    A type outside the closed set is HOST_OPERATION_TYPE_UNKNOWN (hrn:node:hadronmemory.com:specs:cor:agt:070:03), a
    missing, extra or malformed argument BAD_HOST_OPERATION_ARGS. worktree.create and worktree.remove: the worker's
    holder, the worker it reports to directly (not further up the chain), or whoever manages the App (else HOST_OPERATION_NOT_PERMITTED). worker.start:
    whoever manages the App only, with an optional taskId, for a held worker with no live session and no start in
    flight, in a worktree and family the live host registers for it (WORKER_NOT_HELD, WORKER_LIVE,
    WORKER_START_PENDING). worker.end: whoever manages the App only (else HOST_OPERATION_NOT_PERMITTED), naming an open
    session of the worker on a host that registers it (else BAD_HOST_OPERATION_ARGS). worker.deliver is the one type
    not issued yet, HOST_OPERATION_NOT_ISSUABLE until a host has a delivery path for it (hadron-cli#829).
    worker.reset-context is HOST_OPERATION_NOT_ISSUABLE here: the platform issues it when a task ends (#2162). An App key
    issues nothing (FORBIDDEN). An unregistered host is HOST_NOT_FOUND.
    """
    issueHostOperation(input: IssueHostOperationInput!): HostOperation!

    """
    #2162 — a context reset's protocol (hrn:node:hadronmemory.com:specs:cor:agt:050:27), for the host its
    worker.reset-context operation was issued to, with that host's key only, after collecting the operation
    (HOST_OPERATION_NOT_COLLECTED otherwise). Each step names the reset and its epoch (STALE_EPOCH when it moved), is
    idempotent (a replay answers replayed: true), and is out of order CONTEXT_RESET_WRONG_PHASE. Another App's or host's
    reset is CONTEXT_RESET_NOT_FOUND. The final outcome is reported with reportHostOperation: SUCCEEDED once relaunched,
    or FAILED with a reason that starts with its code. claimContextReset takes the fence: the worker becomes unavailable
    RESETTING, or the reset is refused SESSION_CHANGED, OTHER_WORK, UNAVAILABLE, PAUSED, SETTING_OFF or WORKER_GONE.
    """
    claimContextReset(input: ClaimContextResetInput!): ContextResetStep!
    "#2162 — register the durable checkpoint before any process control. A wrong reference is RECOVERY_REF_INVALID and changes nothing."
    registerContextResetRecovery(input: RegisterContextResetRecoveryInput!): ContextResetStep!
    """
    #2162 — the single stop grant per claim; a replay returns the same grant. The host signals only within stopLeaseMs of
    the moment it SENT this request (CLOCK_BOOTTIME). Refused NO_RECOVERY_REF, CLAIM_LAPSED, PROCESS_CHANGED or NOT_IDLE.
    """
    authorizeContextResetStop(input: AuthorizeContextResetStopInput!): ContextResetStep!
    "#2162 — the old agent stopped; its resetting mark now lasts until the relaunched agent's first activity."
    reportContextResetAgentStopped(input: ContextResetStepInput!): ContextResetStep!
    "#2162 — the agent was relaunched under its wrapper."
    reportContextResetRelaunched(input: ReportContextResetRelaunchedInput!): ContextResetStep!
    "#2162 — a failure after the claim that the host saw; the reset ends and the mark is released."
    reportContextResetRelaunchFailed(input: ReportContextResetRelaunchFailedInput!): ContextResetStep!

    "#1747 — give a worker a named App grant (hrn:node:hadronmemory.com:specs:cor:agt:080:24). Whoever manages the App only. Idempotent."
    grantApp(appRef: String!, workerRef: String!, name: AppGrantName!): AppGrant!

    "#1747 — revoke a grant. Whoever manages the App only. Takes effect at the grantee next call."
    revokeAppGrant(appRef: String!, workerRef: String!, name: AppGrantName!): AppGrant!

    """
    #1705 — assign a task with no assignee — a queued task (pending) or a BACKLOG task: the
    task's owner, a worker the owner reports to, directly or up the reportsTo chain, or whoever manages the App
    (hrn:node:hadronmemory.com:specs:cor:agt:050:09). closeSessionWhenDone, when
    given, replaces the task's value; omitted, the stored value is kept. Assigning a BACKLOG task moves it to
    pending (hrn:node:hadronmemory.com:specs:cor:agt:050:02, #1754). Refusals: TASK_NOT_FOUND, TASK_NOT_OWNER,
    TASK_ENDED, TASK_INVALID_TRANSITION (already assigned: use
    reassignAgentTask), TASK_ASSIGNEE_INVALID, SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    assignAgentTask(taskId: ID!, assignee: AgentTaskPartyInput!, closeSessionWhenDone: Boolean): AgentTask!

    """
    #1705 — move a task to another assignee: the task's owner, a worker the owner reports to, directly or up the reportsTo chain, or whoever
    manages the App (hrn:node:hadronmemory.com:specs:cor:agt:050:09). A started task stays started; the former
    assignee can no longer move it. Refusals: TASK_NOT_FOUND, TASK_NOT_OWNER,
    TASK_ENDED, TASK_INVALID_TRANSITION (no assignee yet, or the same one),
    TASK_ASSIGNEE_INVALID, SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    reassignAgentTask(taskId: ID!, assignee: AgentTaskPartyInput!, closeSessionWhenDone: Boolean): AgentTask!

    """
    #1705 — start a pending task: its assignee only (hrn:node:hadronmemory.com:specs:cor:agt:050:08).
    Refusals: TASK_NOT_FOUND, TASK_NOT_ASSIGNEE, TASK_ENDED,
    TASK_INVALID_TRANSITION, SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    startAgentTask(taskId: ID!): AgentTask!

    """
    #1705 — record progress on a started task: its assignee only
    (hrn:node:hadronmemory.com:specs:cor:agt:050:08). Carries no text. Refusals as startAgentTask.
    """
    recordAgentTaskProgress(taskId: ID!): AgentTask!

    """
    #1705 — finish a started task with its result: its assignee only
    (hrn:node:hadronmemory.com:specs:cor:agt:050:08). A pending task is refused: start it first. Refusals as
    startAgentTask, plus BAD_USER_INPUT for an outcome that is not one word.
    """
    finishAgentTask(taskId: ID!, result: AgentTaskResultInput!): AgentTask!

    """
    #1705 — cancel a pending, started or backlog task: its owner, a worker the owner reports
    to, directly or up the reportsTo chain, or whoever manages the App (hrn:node:hadronmemory.com:specs:cor:agt:050:09; a backlog task directly,
    Holger team chat #8150). Refusals:
    TASK_NOT_FOUND, TASK_NOT_OWNER, TASK_ENDED, SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    cancelAgentTask(taskId: ID!): AgentTask!

    """
    #1754 — park a queued task in the backlog (hrn:node:hadronmemory.com:specs:cor:agt:050:02): pending
    with no assignee becomes BACKLOG — unassigned, never matched, never waited
    on, no alarms. Whoever may assign a task may park it: its owner, a worker
    the owner reports to, directly or up the reportsTo chain, or whoever manages the App
    (hrn:node:hadronmemory.com:specs:cor:agt:050:09). Refusals: TASK_NOT_FOUND, TASK_NOT_OWNER,
    TASK_ENDED, TASK_INVALID_TRANSITION (not pending, or an assignee),
    SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    parkAgentTask(taskId: ID!): AgentTask!

    """
    #1754 — make a backlog task ready to be worked
    (hrn:node:hadronmemory.com:specs:cor:agt:050:02): BACKLOG becomes PENDING and the task enters
    the queue. Whoever may assign a task may make it ready: its owner, a worker
    the owner reports to, directly or up the reportsTo chain, or whoever manages the App
    (hrn:node:hadronmemory.com:specs:cor:agt:050:09). Refusals: TASK_NOT_FOUND, TASK_NOT_OWNER,
    TASK_ENDED, TASK_INVALID_TRANSITION (not backlog), SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    makeAgentTaskReady(taskId: ID!): AgentTask!

    """
    #1706 — acknowledge an alarm (hrn:node:hadronmemory.com:specs:cor:agt:050:20): it stops waking higher
    owners; the stall episode goes on until the task moves. Any owner in the
    alarm's chain, or whoever manages the App (hrn:node:hadronmemory.com:specs:cor:agt:050:24), and nobody
    else; the time is the server's.
    Refusals: ALARM_NOT_FOUND (also for an App you cannot read),
    NOT_AN_ALARM, ALARM_NOT_IN_CHAIN, ALARM_ALREADY_ACKNOWLEDGED (the first
    stands), SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    acknowledgeAlarm(eventId: ID!): AgentTeamEvent!

    """
    #1706 — set a worker's availability for work (hrn:node:hadronmemory.com:specs:cor:agt:060:08): the worker
    itself, acting through its session, and only to UNAVAILABLE; the person
    holding its name; or whoever manages the App. A worker another reports to directly may also clear only a
    stall-rule unavailable mark (the stall rule must have set it), never set another worker unavailable. Writes availability.changed.
    Refusals: WORKER_NOT_FOUND, AVAILABILITY_NOT_PERMITTED, WORKER_RETIRED,
    BAD_USER_INPUT, SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    setWorkerAvailability(input: SetWorkerAvailabilityInput!): WorkerAvailability!

    """
    #1706 — set a model family's availability for work in an App
    (hrn:node:hadronmemory.com:specs:cor:agt:060:09): whoever manages the App only. Writes availability.changed.
    Refusals: APP_NOT_FOUND, AVAILABILITY_NOT_PERMITTED, BAD_USER_INPUT,
    SESSION_NOT_BOUND, APP_UNINSTALLED.
    """
    setModelFamilyAvailability(input: SetModelFamilyAvailabilityInput!): ModelFamilyAvailability!

    """
    #1706 — set an App's stall windows, and (#1763) its host-registration lapse: whoever manages the App. Refusals:
    APP_NOT_FOUND, APP_MANAGER_REQUIRED, BAD_USER_INPUT, SESSION_NOT_BOUND,
    APP_UNINSTALLED.
    """
    setAgentTaskStallSchedule(appRef: ID!, input: AgentTaskStallScheduleInput!): AgentTaskStallSchedule!
    """
    Start impersonating another member of orgRef (admin support/diagnostics).
    Caller must be a live ADMIN/OWNER of the org (platform ADMIN/OWNER is
    OWNER-equivalent), the target a live member, PEER-OR-BELOW (an org ADMIN
    may not impersonate an org OWNER), never self. Returns the audit session
    and a short-TTL token (returned exactly once) whose requests run
    READ-ONLY as the target. Org-scoped reads are restricted to this one org;
    personal/private memories and identity-based owner grants are excluded. Public-resource
    read gates remain applicable. Every mutation except
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
    within the same 4096 UTF-16 code-unit budget for serialized JSON as a placement's config. Requires an
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
    'name' is required on creation, unlike updateNode. Target an explicit
    memoryId, or use install to create in an App's Agent install memory;
    supplying both targets is BAD_USER_INPUT.
    Include tags (#2040): content may carry {{> target settings}} tags. Writes
    that make a tag malformed refuse INVALID_INCLUDE; a tag the write adds or
    changes whose target is missing, deleted or not readable by the writer
    refuses INCLUDE_TARGET_UNAVAILABLE (one error for all three; tags already
    stored are not re-checked, #2041); and one that would make the node include
    itself INCLUDE_CYCLE; nothing is written. A chain deeper than 10 is not
    refused: it saves, and reads show the broken-include notice past level 10
    (#2134). Each tag's target gets a derived edge
    (governed kind INCLUDE) that only the content owns: editing or deleting it
    directly refuses INCLUDE_EDGE_DERIVED.
    """
    createNode(input: CreateNodeInput!): Node!

    """
    #1201 — the CREATE door for the spec kind. A write that would produce a
    node with role: 'spec' or a dotted 'spec.*' sub-role must come through here; the generic createNode
    refuses it.

    PURE ROUTING: it validates nothing and knows nothing beyond which kind it is
    the door for. The authoring RULES stay in the tool that owns them ('hadron
    spec', 'hadron coding'), which is a closed-list exception on the audience
    ground.

    STRENGTH: DILIGENCE. This is the intended authoring door for spec tools (#1152); the server does not attest which client binary called it. A determined caller may omit the label, and a citation resolves without it. Specs are deliberately not treated as a security concern; the destructive half is closed by #1182/#1184, which made createNode mint-or-refuse and race-safe.

    Exempt from its OWN kind only — it is fully subject to every other kind and
    to Channel address protection, so it cannot forge a chat message.
    Deliberately NOT an MCP tool: an agent's node surface is hadron_create_node,
    which refuses, and that absence is the mechanism rather than an oversight.
    """
    createSpecNode(input: CreateNodeInput!): Node!
    """
    #1450 — reserve a citation as a placeholder, in any memory since #1591: an
    unminted spec node at loc (role spec, nodeType info) marked isPlaceholder,
    so links can point at it and the placeholders left are the corpus's to-do
    list. Writing real content through updateSpecNode turns it into a real spec
    at the same citation; minting refuses while a placeholder remains. Refuses
    NodeLocConflictError at a live loc. memoryRef accepts the memory's ID or URN.
    """
    reserveSpecCitation(memoryRef: ID!, loc: String!, name: String): Node!
    """
    #1178 — allocate the next citation under parentLoc and reserve it as a
    placeholder, in one transaction: mint-or-refuse, so a client never reads
    sibling numbers and writes the next. Numbers follow hadron spec new:
    features in tens (010..990), rules and flows by one (01..99), rule 00 never,
    after lands strictly above it. A number ever minted is never handed out
    again (R216) while a row or alias of it remains, and a loc held by a row of
    any state is skipped. Refuses SPEC_PARENT_NOT_FOUND, SPEC_PARENT_NOT_NUMBERED
    and SPEC_NUMBER_SPACE_EXHAUSTED; an unreadable memory is not found.
    """
    allocateSpecNode(memoryRef: ID!, parentLoc: String!, after: Int, name: String): Node!
    """
    #1449 — renumber an UNMINTED spec (#1591: draft rights are per node): move
    it and its subtree from fromLoc to toLoc with no URN alias, refusing
    NODE_MINTED { locs } if any moved node is minted, then rewrite every node
    URN in the corpus that cites the moved specs, each as a normal edit. Bare
    text citations (labels, names) are reported in textCitations, not
    rewritten. dryRun returns the plan and writes nothing. The move is atomic;
    each rewrite is a separate guarded edit, and one that fails is reported
    FAILED without undoing the move.
    """
    renumberSpec(memoryRef: ID!, fromLoc: String!, toLoc: String!, dryRun: Boolean): SpecRenumberResult!
    """
    #1591 — mint the live nodes of a memory in the mint scope, at once,
    excluding comment nodes and the decision role family. The scope is the
    unminted nodes plus (#1612) minted nodes whose content changed since their
    minted revision or that have no recorded minted revision; a re-mint keeps
    the first mint's time and minter. Each node is
    stamped with its current revision and that revision's approval hash
    (Node.mintStatus); a minted node's moves then record URN aliases. Refuses
    SPEC_CORPUS_MINT_BLOCKED while any blocker remains among the nodes in
    scope: a placeholder, an unresolved reference, a structural lint error over
    spec-marked or citation-shaped nodes (nodetype-info, tag-spec, serialization-leak,
    duplicate-loc), a stale abstract once staleAbstractsBlock is true,
    NOT_APPROVED (the current revision is not approved), TAMPERED (approved
    text changed outside the revision system), or CITES_UNMINTED (an
    edge into another memory's node that is not minted). Minted nodes outside
    the scope are not re-checked. dryRun returns the full report without minting. Any
    writer of the memory. memoryRef accepts the ID or URN. A real run holds
    every write to the memory off while it checks and stamps, and refuses
    SPEC_CORPUS_BUSY (retryable) if a write is already in flight. Encrypted
    memories are refused (SPEC_CORPUS_ENCRYPTED_UNSUPPORTED). Minting protects
    nothing by itself: minted-spec permanence (#1468) is switched off for now.
    """
    mintMemoryNodes(memoryRef: ID!, dryRun: Boolean): SpecCorpusMintReport!
    "#1448, generalized by #1591 — the same operation as mintMemoryNodes, kept under its original name."
    mintSpecCorpus(memoryRef: ID!, dryRun: Boolean): SpecCorpusMintReport!

    """
    #1201 — the UPDATE door for the spec kind, and the counterpart of
    createSpecNode. Same posture: pure routing, exempt from its own kind only,
    not an MCP tool.

    It is needed because the gate reads the RESULTING state: editing a node that
    already carries this kind still produces one, so the generic updateNode
    refuses it even when the edit touches neither signal. That is the point — a
    spec node must not be rewritable through the generic surface.

    Identical to updateNode otherwise, selectors included ('id' XOR 'memoryId' +
    'loc'); it never creates and never moves.
    """
    updateSpecNode(input: UpdateNodeInput!): Node!

    """
    #1201 — the CREATE door for the review kind. A write that would produce a
    node with role: 'review' or a dotted 'review.*' sub-role must come through here; the generic createNode
    refuses it.

    PURE ROUTING: it validates nothing and knows nothing beyond which kind it is
    the door for. The authoring RULES stay in the tool that owns them ('hadron
    spec', 'hadron coding'), which is a closed-list exception on the audience
    ground.

    STRENGTH: SECURITY. A review is not coding-specific — any work performed can be reviewed, and a review may be a SAFETY CHECK. So an attacker can modify a work assignment AND remove the reviews meant to catch that. Omitting the label is self-defeating in its own way: an unlabelled check is invisible to the review tooling, so it is not a check.

    Exempt from its OWN kind only — it is fully subject to every other kind and
    to Channel address protection, so it cannot forge a chat message.
    This mutation is not itself an MCP tool; its MCP counterpart is the
    deliberate hadron_create_review tool, separate from hadron_create_node,
    which refuses (#1301 names it in the refusal).
    """
    createReviewNode(input: CreateNodeInput!): Node!

    """
    #1201 — the UPDATE door for the review kind, and the counterpart of
    createReviewNode. Same posture: pure routing, exempt from its own kind only;
    its MCP counterpart is hadron_update_review.

    It is needed because the gate reads the RESULTING state: editing a node that
    already carries this kind still produces one, so the generic updateNode
    refuses it even when the edit touches neither signal. That is the point — a
    review node must not be rewritable through the generic surface.

    Identical to updateNode otherwise, selectors included ('id' XOR 'memoryId' +
    'loc'); it never creates and never moves.
    """
    updateReviewNode(input: UpdateNodeInput!): Node!

    """
    #1201 — the CREATE door for the task kind. A write that would produce a
    node with isRunnable: true must come through here; the generic createNode
    refuses it.

    PURE ROUTING: it validates nothing and knows nothing beyond which kind it is
    the door for. The authoring RULES stay in the tool that owns them ('hadron
    spec', 'hadron coding'), which is a closed-list exception on the audience
    ground.

    STRENGTH: CAPABILITY. The only one of the three whose gate cannot be evaded by omission, which is why it carries the security case. It keys on 'isRunnable' rather than on 'role': a label is caller-set and freely dropped, while omitting the capability means the node does not run. The threat is a memory shared with someone who authors a runnable node that reads the owner's data when the OWNER runs it (#1202).

    Exempt from its OWN kind only — it is fully subject to every other kind and
    to Channel address protection, so it cannot forge a chat message.
    This mutation is not itself an MCP tool; its MCP counterpart is the
    deliberate hadron_create_task tool, separate from hadron_create_node,
    which refuses (#1301 names it in the refusal).
    """
    createTaskNode(input: CreateNodeInput!): Node!

    """
    #1201 — the UPDATE door for the task kind, and the counterpart of
    createTaskNode. Same posture: pure routing, exempt from its own kind only;
    its MCP counterpart is hadron_update_task.

    It is needed because the gate reads the RESULTING state: editing a node that
    already carries this kind still produces one, so the generic updateNode
    refuses it even when the edit touches neither signal. That is the point — a
    task node must not be rewritable through the generic surface.

    Identical to updateNode otherwise, selectors included ('id' XOR 'memoryId' +
    'loc'); it never creates and never moves.
    """
    updateTaskNode(input: UpdateNodeInput!): Node!

    """
    Update an existing node. Identify it by 'id' (PK or fully-qualified node
    URN) XOR the ('memoryId', 'loc') combo, or by ('install', 'loc') for an
    App's Agent install memory. Supplying install together with id or
    memoryId is BAD_USER_INPUT; the ordinary selectors remain mutually
    exclusive and one selector is required. Rejects with NODE_NOT_FOUND when the target
    does not exist; updateNode never creates and never moves (relocation is
    moveNode's job, D3). Every content field is optional — omitted fields are
    preserved ('name' included, D4; 'abstract' keeps its omit/null/string
    contract; omitted 'tags' are preserved, issue #235).
    Include tags (#2040): content may carry {{> target settings}} tags. Writes
    that make a tag malformed refuse INVALID_INCLUDE; a tag the write adds or
    changes whose target is missing, deleted or not readable by the writer
    refuses INCLUDE_TARGET_UNAVAILABLE (one error for all three; tags already
    stored are not re-checked, #2041); and one that would make the node include
    itself INCLUDE_CYCLE; nothing is written. A chain deeper than 10 is not
    refused: it saves, and reads show the broken-include notice past level 10
    (#2134). Each tag's target gets a derived edge
    (governed kind INCLUDE) that only the content owns: editing or deleting it
    directly refuses INCLUDE_EDGE_DERIVED.
    """
    updateNode(input: UpdateNodeInput!): Node!

    """
    Shallow-merge a JSON patch into a node's 'data' bag. The supplied JSON's
    top-level keys are written over the node's existing 'data' (the patch
    wins on key collision); keys the patch doesn't mention are preserved.
    If the node has no 'data' yet, the supplied JSON becomes its 'data'
    verbatim. 'data' must be a JSON object (not an array or scalar). 'nodeRef'
    is a node ID or fully-qualified URN. Honors the same single-write
    invariants as updateNode (per-memory write auth, encryption, revision
    history, git mirror). Returns the updated node.
    """
    updateNodeData(nodeRef: ID!, data: JSON!, reason: String): Node!

    """
    #742 - Shallow-merge a JSON patch into a node's structured 'properties'
    (the schema-governed JSONB column, DISTINCT from 'data'). The patch's
    top-level keys are written over the node's existing 'properties' (patch
    wins on collision); unmentioned keys are preserved; a node with no
    'properties' takes the patch verbatim.

    ONE EXCEPTION (#1227): an OBJECT under 'exports' - the per-host skill
    export declarations, keyed by host (D12) - is applied as a JSON Merge
    Patch (RFC 7396), not replaced. Hosts and their fields merge recursively,
    a null member DELETES that host or field, and scalars/arrays replace. So
    '{exports: {codexSkill: {enable: false}}}' flips one flag and keeps the
    host's name, description and every other host, and
    '{exports: {codexSkill: null}}' removes that host. A non-object 'exports'
    in the patch (null, a scalar, an array) keeps the top-level rule and
    replaces the stored value. The merge runs under a per-node lock, so two
    callers writing different hosts at once both land - do NOT
    read-modify-write 'exports' client-side, which can lose a concurrent
    writer's host. 'properties' must be a JSON object
    (not an array or scalar). 'nodeRef' is a node ID or fully-qualified URN.
    On a schema-governed memory the MERGED result is validated against the
    memory's schema (BAD_USER_INPUT on a violation). 'properties' is plaintext
    at rest (never encrypted), so the merge + conformance check need no key —
    but the write still honors the same single-write invariants as updateNode
    (per-memory write auth, an active session on an encrypted memory, revision
    history, git mirror). Returns the updated node.
    """
    updateNodeProperties(nodeRef: ID!, properties: JSON!, reason: String): Node!

    """
    #745 — Object store: the legible sugar surface over structured storage.
    An object IS a node; these ops are thin projections onto createNode /
    updateNodeProperties / deleteNode, inheriting all their invariants
    (auth, encryption, schema conformance, revisions, atomic merge).

    Create an object in a collection. 'memoryRef' is a memory ID or
    fully-qualified URN (relative refs are rejected, spec 022). 'type' is the
    collection (node objectType); 'fields' are the flat, typed properties
    (validated against the memory schema when the collection is declared). The
    node's loc is auto-derived (<type>:<key ?? generated-id>) and hidden; pass
    'key' for a human-meaningful id (a single segment, no ':'), 'name' to
    override the derived node name. Reserved object field names: id, type;
    these cannot be supplied in fields. Returns the flat object.
    """
    createObject(memoryRef: String!, type: String!, fields: JSON!, key: String, name: String): JSON!

    """
    Merge fields into an existing object (server-side atomic shallow merge +
    schema conformance on the result). 'ref' is the object id (or node URN);
    'fields' wins on key collision, unmentioned keys preserved. Returns the
    updated flat object. The merge is shallow for EVERY field, including one
    named 'exports': the per-host merge-patch updateNodeProperties applies to
    'properties.exports' (#1227) is a node-level skill-declaration rule and
    does not apply to object fields.
    """
    updateObject(ref: ID!, fields: JSON!, reason: String): JSON!

    """
    Delete an object (soft by default; 'hard: true' removes the row). 'ref' is
    the object id (or node URN). Returns true on success.
    """
    deleteObject(ref: ID!, hard: Boolean): Boolean!

    """
    Bulk search-and-replace text across selected nodes (literal or regex).
    Honors per-memory write auth, encryption, revision history, abstract
    staleness, and re-embedding. Supports dryRun preview.
    """
    searchReplaceInNodes(input: SearchReplaceInNodesInput!): SearchReplaceResult!

    "Governed bulk replacement inside one spec corpus, with exact preview binding. Every target must be unminted (#1591); SEARCH_REPLACE_NOT_DRAFT names minted ones."
    searchReplaceInSpecNodes(input: SpecSearchReplaceInput!): SearchReplaceResult!

    """
    Delete a node identified by 'nodeRef' (a node ID or fully-qualified URN;
    #542). Soft-delete by default (sets deletedAt; the node disappears from
    reads, matching the hadron_delete_node MCP tool). Pass hard: true to
    remove the row entirely (cascades edges + NodeRevision via FK) —
    irreversible. #391. A re-delete of an already soft-deleted node is
    idempotent (the ref resolves through the tombstone).

    If the node has descendants (nodes under its loc prefix), a plain delete
    REFUSES with NODE_HAS_DESCENDANTS (carrying the count) rather than silently
    orphaning the subtree — parity with the hadron_delete_node MCP tool. Pass
    recursive: true to delete the node's whole loc-subtree — the node at its loc
    PLUS every descendant, matched on ':' path boundaries (so deleting 'auth'
    does not touch 'authoring'). The subtree lives in one memory, so the single
    write-access check covers it; 'hard' applies to the whole subtree.

    A hard delete cascades edges on both endpoints via FK. If any affected node
    is on an edge that bridges this memory to another, the hard delete REFUSES
    with CROSS_MEMORY_EDGES (the caller may not own the other memory) unless
    cascadeCrossMemoryEdges: true. A non-recursive soft re-delete of an already
    soft-deleted node is an idempotent no-op that preserves its audit stamp.
    """
    deleteNode(nodeRef: ID!, hard: Boolean, recursive: Boolean, cascadeCrossMemoryEdges: Boolean): Boolean!

    """
    Restore a node to a previous revision (#617).

    Default (truncate: false): snapshots the CURRENT node state into history
    first, then restores the node's fields to the revision — non-destructive,
    the restore itself becomes undoable.

    truncate: true: restores the node's fields to the revision AND deletes
    every NodeRevision NEWER than the selected one (createdAt strictly greater),
    WITHOUT creating a pre-restore snapshot. Boundary is EXCLUSIVE of the
    selected row: the selected revision is KEPT and becomes the new baseline
    (the most-recent snapshot afterward); its era and older survive. The live
    revision counter still advances monotonically for the restore itself.
    Restore + truncate run in one transaction (atomic).
    """
    restoreNodeRevision(revisionId: ID!, truncate: Boolean = false): Node!

    """
    Delete a single node-revision snapshot by id (#617). Auth: the node's memory
    write access (as restoreNodeRevision). Throws NOT_FOUND for an unknown id.
    """
    deleteNodeRevision(revisionId: ID!): Boolean!

    """
    Set or clear the user-facing label on a revision snapshot (#620,
    NodeRevision.revLabel, 500-char cap). Omit revLabel to preserve; pass
    null to clear. Auth: the node's memory write access (as
    deleteNodeRevision) PLUS the nodeRevision query's read gates — it returns
    the full snapshot, so a soft-deleted node or a snapshot captured in an
    unreadable memory answers the same NOT_FOUND as an unknown id.
    """
    updateNodeRevision(revisionId: ID!, revLabel: String): NodeRevision!
    """
    #1591 — approve the node's CURRENT revision: record who, when, and the
    approval hash of its title/abstract/content. Pass revision to approve only
    if it is still the one you read (REVISION_MISMATCH otherwise). A memory
    writer may approve ordinary nodes, the author included; placed boot prompts
    also require their dedicated manager-as-self gate. Comments and
    decision-family nodes are refused. Idempotent: an approved
    revision keeps its existing approval. Refuses NODE_IS_PLACEHOLDER, and
    ENCRYPTED_MEMORY_NOT_APPLICABLE on any encrypted memory, even with a
    cached session key.
    """
    approveNode(nodeRef: ID!, revision: Int): NodeApprovalReceipt!
    """
    #1632 (hrn:node:hadronmemory.com:specs:cor:dmo:130:03) — ask for a node's current content to be signed. Any reader of the node may ask, agents included; agents never sign. expectedRevision, when given, must still be current (REVISION_MISMATCH). signerRef names one signer (a user id); omitted, any writer of the memory may sign. Refusals: NODE_NOT_FOUND, ENCRYPTED_MEMORY_NOT_APPLICABLE, and (hrn:node:hadronmemory.com:specs:cor:dmo:130:02, Holger #10430) COMMENT_NOT_SIGNABLE, NODE_IS_PLACEHOLDER, REVISION_MISMATCH, SIGNER_NOT_FOUND, and (Holger #11094, #1904) SIGNER_NOT_A_WRITER when the named signer may not write the node's memory (checked again when they sign or decline). No call takes an assertion: the signer signs on the server-hosted ceremony page (S2b-2).
    """
    requestNodeSignature(nodeRef: ID!, expectedRevision: Int, signerRef: ID): SigningRequest!
    "#1632 — withdraw an open signing request. Only the requester account, from any of its sessions (#10397). Refusals (hrn:node:hadronmemory.com:specs:cor:dmo:130:03, Holger #10430): SIGNING_REQUEST_NOT_FOUND, SIGNING_REQUEST_NOT_REQUESTER, SIGNING_REQUEST_ENDED (extensions.state)."
    withdrawSigningRequest(id: ID!): SigningRequest!
    "#1591 — approve the current revision of every live node of a memory (ID or fully-qualified URN) in the mint scope (unminted, or minted and changed since or with no recorded minted revision, #1612) that isn't approved yet, in one transaction. Placeholders are skipped and reported."
    approveMemoryNodes(memoryRef: String!): ApproveMemoryNodesResult!

    """
    #1606 — start a thread on a node (hrn:node:hadronmemory.com:specs:cor:dmo:110). Needs write access to the
    target's memory. Commentable classes: app, knowledge, personal, group, system;
    private memories are not commentable. anchorRevision defaults to the target's current revision;
    an older one anchors there while its text is still retained. The anchor
    hash is computed by the server. Typed refusals: COMMENT_TARGET_NOT_FOUND,
    COMMENT_FORBIDDEN, COMMENT_TARGET_IS_COMMENT, COMMENT_MEMORY_NOT_COMMENTABLE,
    COMMENT_OPEN_THREAD_EXISTS, COMMENT_ANCHOR_REVISION_INVALID,
    COMMENT_ANCHOR_REVISION_UNAVAILABLE, COMMENT_BODY_INVALID,
    COMMENT_IMPERSONATION_REFUSED.
    """
    createComment(targetRef: ID!, body: String!, quote: String, anchorRevision: Int): Comment!
    "#1606 — reply in a thread; commentRef may be any comment of it. Allowed on a resolved thread, which stays resolved (Holger, DAB)."
    replyToComment(commentRef: ID!, body: String!): Comment!
    "#1606 — the author edits a comment's body and/or quote. COMMENT_NOT_AUTHOR otherwise."
    editComment(commentRef: ID!, body: String, quote: String, expectedRevision: Int!): Comment!
    """
    #1721 — delete one comment: its author (with write access), or anyone who may delete others' comments (the memory's manager, or a platform admin outside personal and private memories). A top-level comment with live replies stays as a deleted stub with no text; any other comment is soft-deleted and gone from every read, and a stub goes with its last live reply (hrn:node:hadronmemory.com:specs:cor:dmo:110:05). Returns the comment as deleted. COMMENT_NOT_AUTHOR for a writer who is not the author; COMMENT_DELETED for a stub.
    """
    deleteComment(commentRef: ID!, expectedRevision: Int!): Comment!
    "#1606 — resolve a thread: its author or any writer of the memory. commentRef is the top-level comment; returns it."
    resolveCommentThread(commentRef: ID!, expectedRevision: Int!): Comment!
    "#1606 — reopen a resolved thread: its author or any writer of the memory."
    reopenCommentThread(commentRef: ID!, expectedRevision: Int!): Comment!
    "#1606 — a memory admin deletes a whole thread (soft: gone from every read, limit and check; the rows stay for audit, with no revision history, #1721). commentRef may be any comment of it."
    deleteCommentThread(commentRef: ID!, reason: String!): Boolean!

    """
    #1641 — create a decision log at loc in a memory: needs management rights on the memory, or the
    owner role in its live, installed App for non-personal/non-private memories. Impersonation is refused. Refused
    in an encrypted memory (DECISION_LOG_ENCRYPTED), a git-mirrored one (DECISION_LOG_MIRRORED), a
    system memory (DECISION_LOG_SYSTEM_MEMORY), an anonymous one (DECISION_LOG_ANONYMOUS_MEMORY), at a loc occupied by a live or deleted node at or beneath it (DECISION_LOG_EXISTS), or inside a decision's subtree. Deciders are user ids, each able
    to read the memory (DECISION_DECIDER_NOT_ELIGIBLE).
    """
    createDecisionLog(memoryRef: ID!, loc: String!, name: String, prefix: String, defaultDeciders: [ID!]!, eligibleDeciders: [ID!]): DecisionLog!
    "#1641 — replace a log's default (and, when given, other eligible) deciders, as an audited revision of the log. Existing decisions keep theirs. Needs management rights on the memory, or the owner role in its App."
    setDecisionLogDeciders(logRef: ID!, defaultDeciders: [ID!]!, eligibleDeciders: [ID!], expectedRevision: Int!, reason: String!): DecisionLog!
    """
    #1641 — ask a decision in a log: the server issues the next code using the log prefix (DA, DB, … with default D) and renders the
    content. Any writer of the log's memory, agents included, outside impersonation. Refusals: DECISION_INVALID (with JSON
    pointers), DECISION_RECOMMENDATION_MISSING, DECISION_TIER_TOO_LOW, DECISION_DECIDER_NOT_ELIGIBLE.
    """
    askDecision(logRef: ID!, input: AskDecisionInput!): Decision!
    """
    #1641 — amend a writable decision. Memory write access is always required; before any answer, any writer; after one, a decider only. Urgency is a
    decider's to change; lowering the tier is a decider's, before an answer, never when it authorizes.
    Refusals: NODE_WRITE_CONFLICT, DECISION_PART_RENUMBER, DECISION_ANSWER_IMMUTABLE, DECISION_NOT_DECIDER.
    """
    amendDecision(ref: ID!, input: AmendDecisionInput!, expectedRevision: Int!, reason: String!): Decision!
    "#1641 — withdraw a decision (terminal; the code stays consumed): the asker or a decider, a decider once answered. DECIDED ones are superseded instead (DECISION_ANSWERED_DECIDED)."
    withdrawDecision(ref: ID!, reason: String!, expectedRevision: Int!): Decision!
    "#1641 — a platform admin hard-deletes a decision that was never answered, recorded on its log (DECISION_ANSWERED otherwise). The code stays consumed."
    purgeUnansweredDecision(ref: ID!, reason: String!): Boolean!

    """
    Delete ALL NodeRevision rows for a node, returning the count deleted (#617).
    'nodeRef' is the node's PK or fully-qualified URN. Auth: the node's memory
    write access. An unknown ref throws NODE_NOT_FOUND. Reachable on a
    soft-deleted node (purging residual history is a cleanup op).
    """
    clearNodeHistory(nodeRef: ID!): Int!

    """
    Relocate a node (#564). 'sourceRef' is the node's PK or fully-qualified
    URN. The destination is EITHER 'targetUrn' (the node's new full URN — new
    memory and/or loc) OR 'targetMemoryRef' (a memory ID/URN; the node keeps
    its current loc, only its memory changes) — supply exactly one. The node
    keeps its id, so all incoming/outgoing edge references stay valid. Fails
    loudly with NODE_ALREADY_EXISTS if a live node already occupies the
    destination. Requires write access to both the source and destination
    memories. On a cross-memory move, select Node.moveLinkWarnings to see
    raw relative content links that now miss or resolve to another node.
    """
    moveNode(sourceRef: ID!, targetUrn: String, targetMemoryRef: ID): Node!

    """
    Clone a node to a new location, returning the NEW node with a fresh id
    (#564). Same selector shape as moveNode ('sourceRef' + exactly one of
    'targetUrn' / 'targetMemoryRef'). Copies the source's own fields; outgoing
    edges are copied only where they naturally resolve — a live node exists at
    the target's loc in the destination memory. Incoming edges are not copied.
    Fails loudly if the destination loc is already occupied. Requires read
    access to the source memory and write access to the destination.
    """
    cloneNode(sourceRef: ID!, targetUrn: String, targetMemoryRef: ID): Node!

    """
    Fold one node (source) into another (target), returning the updated
    target. Per-field strategy: text fields (CONTENT/ABSTRACT/DESCRIPTION)
    concatenate target-first; TAGS unions; DATA/PROPERTIES shallow-merge
    with the target winning on key collisions; EDGES re-points the source's
    relationships onto the target. 'include' selects which fields fold in
    (omitted = all). 'deleteSource: true' hard-deletes the source afterward.
    Honors per-memory write auth, encryption, revision history, abstract
    staleness, and re-embedding (same invariants as createNode/updateNode).
    """
    mergeNodes(input: MergeNodesInput!): Node!

    """
    Merge one memory (source) into another (target), returning the updated
    target. Source nodes whose loc already exists in the target are folded
    into their counterpart via the mergeNodes field strategy ('include'
    selects which fields); source nodes with no counterpart move over with
    their loc unchanged. Edges follow. The source memory ends up empty;
    'deleteSourceMem: true' then deletes it. v1 rejects encrypted source or
    target memories and system/app classes. An address the merge would move
    a node or a carried comment into, but which the target holds with a
    SOFT-DELETED node, refuses MERGE_TARGET_LOC_TOMBSTONED (the tombstone
    still owns the address; up to 25 locs named, with the full count). A
    tombstone present when the merge starts refuses before any batch commits;
    one that appears mid-merge refuses the batch it hits, and batches already
    committed stay committed (re-running completes the merge). Hard-delete the
    tombstone, or recreate a node there so it folds, then re-run.

    The merge commits in batches, and is resumable. A refusal raised after
    some batches committed (#1686) says so: it carries
    extensions.partialMerge { applied, relocated, folded, edgesMoved,
    edgesDropped, remainingSourceNodes, sourceIntact, remedy } and keeps its
    own code, or is MERGE_PARTIALLY_APPLIED (with causeCode) when the cause
    was untyped. The source memory is never deleted by a refused merge;
    resolve the blocker and re-run the same merge to finish it. A failure
    after the merge completed (re-indexing or reading back the target)
    carries partialMerge too, with remainingSourceNodes 0 and sourceIntact
    false when deleteSourceMem had removed the source. A refusal with no
    partialMerge applied nothing.
    """
    mergeMemories(input: MergeMemoriesInput!): Memory!

    """
    Retired. After the ordinary concealed-memory and write-access checks,
    calls return REPLACE_SUBTREE_RETIRED without changing nodes or edges. The field remains temporarily so existing clients get a clear
    refusal rather than an unknown-field error.
    """
    replaceSubtree(ownerRepo: String!, memoryId: String!, nodes: [NodeInput!]!, edges: [EdgeInput!]!): Int!
      @deprecated(reason: "Retired (#454): every authorized call refuses with REPLACE_SUBTREE_RETIRED and writes nothing. Use the canonical node write mutations.")

    # Edge CRUD — a GROUP note covering create/update/delete, which is why it
    # is allow-listed rather than published on createEdge alone (#1232).
    #
    # Null-arg semantics (#263):
    # - condition/data: null on updateEdge CLEARS the stored value (the
    #   edge-conditions contract — a null condition means 'always fires').
    # - priority: null is treated as UNSET (createEdge falls back to the
    #   default 0; updateEdge keeps the stored value) — the column is a
    #   non-nullable Int, so null is never a meaningful value for it.
    # Clients that serialize unset args as explicit nulls must omit them
    # instead, or they will clear stored conditions/data on update.
    #
    # #322/#542: sourceRef/targetRef each accept an ID-shape PK (preferred —
    # immutable, so the edge survives a later move/rename) OR a fully-qualified
    # node URN. Resolved via resolveNodeRef. edgeRef (update/delete) likewise
    # accepts an edge PK or a fully-qualified edge URN, resolved via
    # resolveEdgeRef (#542 Tier 2).
    createEdge(sourceRef: ID!, targetRef: ID!, name: String, loc: String, description: String, isRunnable: Boolean, condition: JSON, priority: Int, data: JSON): Edge!
    updateEdge(edgeRef: ID!, name: String, loc: String, description: String, isRunnable: Boolean, condition: JSON, priority: Int, data: JSON): Edge!
    deleteEdge(edgeRef: ID!): Boolean!

    """
    Render or execute a node identified by a single nodeRef (a node PK or a
    fully-qualified node URN, hrn:node:<root>:<memory>:<loc>). This explicit-reference
    operation does not require isRunnable=true. The runnable flag governs by-name
    task discovery, resolution and listing (hrn:node:hadronmemory.com:specs:cor:api:060:01).
    The reference is
    resolved by the shared resolveNodeRef (#542). A bare loc without a memory
    is rejected — pass a full URN or an ID. For loose-name matching and
    interactive task selection use the MCP hadron_run_task tool, which
    resolves to a concrete nodeRef before calling this.
    By default RENDERS the task: returns the assembled instructions (node content
    with {{arg}} substitution and referenced nodes) for an LLM agent to execute.
    Pass appRef (App PK or URN) to EXECUTE instead (#529): the server mints a
    MANUAL app run for the resolved task under that App and returns the run id
    (poll appRun(ref:) for status + output). runAsSelf attributes the run to
    the caller. Without appRef, behavior is unchanged.
    Spec cor:api:060.
    """
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
    Grant an App install scoped access to a connection you OWN, using your own
    user credential with no App context (no App-key or on-behalf-of-run path). scopes must
    be a non-empty subset of {mail.read, mail.send, calendar.freebusy, calendar.read, drive.read};
    duplicates are collapsed. expiresAt is optional; when supplied it must be
    a future ISO-8601 timestamp with an explicit timezone. appRef is a PK or
    App URN. A missing or unreadable connection answers NOT_FOUND.
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
    """
    #1667 — switch an asset's anonymous public link on or off. Only whoever
    manages the asset's memory; a refused request changes
    nothing. Returns the asset.
    """
    setAssetPublicLink(assetRef: ID!, enabled: Boolean!): Asset!
    softDeleteAsset(assetId: ID!): Asset!
    restoreAsset(assetId: ID!): Asset!

    """
    Asset upload — v2 (spec 006-asset-upload-redesign)
    Memory-addressed begin: the caller specifies the destination
    memory directly, no agent traversal. Replaces agent-addressed
    beginAssetUpload during the deprecation window.
    """
    beginAssetUploadV2(input: BeginAssetUploadV2Input!): BeginAssetUploadResult!
    createAssetReferenceNode(input: CreateAssetReferenceNodeInput!): Node!

    # Session lifecycle
    """
    Open a session — and, when \`input.workerRef\` is given, a WORKER SESSION:
    the binding that makes the work attributable to that named teammate.

    The binding is held server-side and is independent of the caller's CHAT
    SESSION (the human's Desktop window, Claude Code session or IDE chat).
    **Ending your chat session does not end a worker session** (#1034): a chat
    session that closes leaves this session open until endSession — #1114
    removed inactivity as a reason to end one, so nothing else will. The worker
    stops reading as LIVE once its idle window passes without a drive, which
    lets another bind proceed without ending the stale session or losing its
    unwritten handoff. A human HOLD stays in force until explicit release, so
    only its holder can bind it again. A client that ties its lifetime to a
    conversation must call endSession itself; nothing
    about closing a window reaches this server.
    """
    startSession(input: SessionInput!): Session!
    """
    #931: update a live session's mutable provenance fields (a PR is usually
    opened after startSession already ran). Explicit null clears; omitted
    preserves; an empty update is a valid liveness touch (bumps updatedAt,
    which liveness counts — #1114). id-only - sessions have no URN.
    Gate: platform admin, the session's App, or the attributed user (not via
    impersonation). An App key updates only user-less sessions (never one a
    person is behind), never a host-launched one, and a key ever granted
    host:operate updates none (#1934, hrn:node:hadronmemory.com:specs:cor:agt:070:04).
    Updates on an ended session stay allowed (late PR-merge attribution).
    #1931 — llmModel refreshes the model-family derivation; an explicit family wins.
    Null or omitted family metadata preserves the existing family. Unclassified models do not clear it.
    """
    updateSession(id: ID!, prNumber: Int, branch: String, llmModel: String, family: String): Session!

    """
    End a session, and — for a worker-bound one — write its closing handoff
    (#1029). Ending a client's chat session does not end its worker session
    or call this operation. Inactivity alone never ends a session; the reaper
    enforces a hard expiresAt promised at session start. Other explicit
    platform lifecycle operations can also end sessions.

    It ends the SESSION, not any HOLD. Where a person bound the worker the name
    stays theirs until explicitly released (#1050,
    [\`cor:agt:020:09\`](hrn:node:hadronmemory.com:specs:cor:agt:020:09)), so
    only that holder can bind it again. A pure App-key **bind takes no hold** —
    which is a fact about the bind, not a promise about the worker's state when
    this returns: an eligible user may have forced a binding meanwhile and taken
    the name, and ending the App-key session leaves that hold and that session
    untouched.

    Gate (#931): platform admin, the session's App, or the attributed user
    (not via impersonation). An App key ends only user-less sessions (never one
    a person is behind), never a host-launched one, and a key ever granted
    host:operate ends none (#1934, hrn:node:hadronmemory.com:specs:cor:agt:070:04);
    a host ends a launched session only by reporting its worker.end.

    \`handoff\` is agent-composed prose: what landed, what is open, what is
    blocked, what the next driver should not repeat. The server owns where it
    goes (the worker's working memory, under the \`handoffs\` parent, at a
    lexically-ordered loc), so no client re-derives the convention.

    \`summary\` is NOT a smaller \`handoff\` (#1100). It sets \`Session.summary\`,
    a label on the session row — readable back through \`session\` / \`sessions\`,
    but read by no worker-continuity path, so the next driver never sees it. The
    two sit side by side and only one of them reaches that driver, so a caller
    writing a closing note picks by name: it is \`handoff\`.

    The two mistakes are not symmetric, and that is the whole hazard. Putting
    continuity prose in \`summary\` succeeds, returns a normal receipt, and
    produces NO handoff — discovered only once the context that could have
    written one is gone, and not correctable in place, since the sequence is
    append-only and adding a handoff to an ended session is refused. A repeat
    end without a new handoff preserves the first end. The remedy is to
    bind again and end THAT session with the prose. Putting a label in
    \`handoff\` is merely untidy: the row lacks its label and the text reaches
    the next driver anyway.

    Written BEFORE the session ends, and a failed write REFUSES the end
    (HANDOFF_WRITE_FAILED) rather than ending anyway: a still-bound worker is
    recoverable — retry, or end without a handoff deliberately — while an ended
    session whose handoff evaporated is not, because the context that composed
    it is gone. Passing \`handoff\` on a session with no worker is refused rather
    than dropped; there is no sequence to write it to.

    #1956: \`resumeClaim: true\` also writes a resume claim, after the handoff
    and before the end, so the fresh context of a rotation starts this worker's
    next session with resumeSession and no arguments (see createResumeClaim).
    Only on your own open worker session: otherwise it refuses and nothing ends.
    """
    endSession(id: ID!, summary: String, handoff: String, inputTokens: Int, outputTokens: Int, turnCount: Int, errorCount: Int, resumeClaim: Boolean): Session!
    """
    #1956 (hrn:node:hadronmemory.com:specs:cor:agt:020:03) — write a RESUME CLAIM for your own open worker
    session before a deliberate context reset that keeps the session (a shed).
    The fresh context recovers the worker with resumeSession and no arguments,
    so no binding file is needed. The claim is single use, lives 60 seconds from
    this write (Holger, #12291), is redeemable only by you (judged by your token,
    never by anything presented), and replaces any unused claim for the same
    session. For a rotation, pass endSession(resumeClaim: true) instead, which
    writes it with the handoff, before the end. Someone else's session answers
    as an absent one; an ended session refuses SESSION_ENDED; a session with no
    worker refuses SESSION_NOT_WORKER_BOUND. An App key without a user or an
    impersonation caller receives the same absent-session answer.
    """
    createResumeClaim(sessionId: ID!): ResumeClaimReceipt!
    """
    #1956 (hrn:node:hadronmemory.com:specs:cor:agt:020:03) — recover your worker binding after a context reset,
    with one call and no arguments. One unused resume claim of yours binds it
    (RESUMED to the open session, or STARTED: the worker's next session, when
    the claimed one had ended); several list as CHOOSE and consume nothing. With
    no claim, the fast path: exactly one of your worker sessions that reads LIVE
    is RESUMED, several list as CHOOSE, never a guess. Pass \`session\` to pick
    a listed candidate. Nothing at all refuses NOTHING_TO_RESUME, and nothing is
    posted or recorded on your behalf. Judged only on your own user: anyone
    else's claims and sessions are invisible, and an App key or an impersonation
    gets the same refusal as a caller with nothing. A claim is single use: of two
    racing redemptions one binds and the other refuses NOTHING_TO_RESUME, and a
    claim's 60 seconds are judged by the database clock when it is consumed.
    A claim is recovery intent, not a waiver: resuming an open session passes
    the same lifecycle gate as any resume (you still hold the name and may drive
    its App, it is not past its hard expiry or dormant, no other session of the
    worker is live), else RESUME_REFUSED; starting the next one passes
    startSession's. Either refusal spends the claim. More recently driven worker
    sessions than one scan holds refuses RESUME_AMBIGUOUS rather than guessing.
    """
    resumeSession(input: ResumeSessionInput): ResumeSessionResult!

    """
    Record a usage event. A supplied session is attributed only when owned
    by the caller (no admin or impersonation bypass). Missing, deleted or
    unowned session references are recorded without session attribution.
    Owned ended, expired or idle sessions accept late attribution without
    counting it as activity. The existing READER role gate still applies.
    """
    recordUsage(event: UsageEventInput!): Boolean!

    """
    App key management — revoke all active keys for an App and mint a
    fresh one. Only whoever manages the App, as themselves
    (hrn:node:hadronmemory.com:specs:cor:dmo:050:05; hrn:node:hadronmemory.com:specs:cor:acl:010:01).
    Never an App key, a bound worker session or an impersonated request. The replacement key holds no scopes.

    Accepts the entity's ID or URN.
    """
    regenerateAppKey(appRef: ID!): AppCreated!

    # User management
    """
    Update display name and handle. A supplied email must match the existing
    address (ignoring case and surrounding whitespace); it is not rewritten
    or cleared by this call.
    """
    updateMyProfile(name: String, handle: String, email: String): User!
    updateUserRoles(userId: ID!, roles: [Role!]!): User!
    """
    Consolidate a duplicate account into a surviving user. Source-only
    identities and relationships move; duplicate role-bearing relationships
    preserve the strongest live entitlement. The source is soft-deleted.
    Requires platform administration, both accounts' consent proof, and an
    unbound user JWT; API keys, Apps, impersonation and session-bound callers
    cannot authorize a merge. The platform-role and missing-proof checks run
    before the credential-shape check. The resulting merge is global;
    organization administration does not authorize account consolidation. Both accounts must
    approve the exact ordered pair after fresh login, within 15 minutes.
    The proof is single-use, consumed atomically before transfers, and recorded
    with the merge. Invalid or missing proof refuses MERGE_CONSENT_REQUIRED.
    There is no administrator substitute or recovery path.

    Records the merge (#1715). User ids stored inside decisions and decision
    logs are never rewritten, since they are authenticated; readers follow
    them to the surviving account, so it is the asker or decider they name.

    Refused with MERGE_USER_IN_OPEN_ALARMS (extension alarmCount; never the
    alarms, tasks or Apps, which the caller may not be able to read) while
    either account is named in the owner chain of an unacknowledged agent-task
    alarm, whose sealed chain cannot follow a merge yet. Acknowledge
    the alarms, then merge. A source account with an unrevoked passkey refuses
    MERGE_SOURCE_HAS_PASSKEYS; revoke those passkeys before merging.
    """
    mergeUsers(input: MergeUsersInput!): User!

    "A platform admin using an unbound user JWT begins an exact ordered-pair, full-consolidation consent, valid for 15 minutes; API keys, Apps, impersonation and session-bound callers refuse FORBIDDEN. Returns its opaque proof once."
    beginMergeUsersConsent(source: String!, target: String!): UserMergeConsentRequest!
    "Each account approves with its own JWT from a verified login at or after consent creation (millisecond resolution). API keys, Apps, impersonation and any session-bound caller cannot approve. Source and target name the exact ordered pair. No admin substitute."
    approveMergeUsersConsent(proof: String!, source: String!, target: String!): Boolean!

    """
    Delete a user account (self-serve account deletion, Apple 5.1.1(v) /
    GDPR erasure posture). Requires a user credential (JWT or hdr_user key);
    App-key callers are rejected.

    Omitting userRef deletes the CALLER's own account (no role needed).
    A platform ADMIN/OWNER may name another user; userRef accepts the
    user's ID, handle, or hrn:user:<handle> URN. Any other caller naming a
    target receives the same FORBIDDEN error whether or not that user
    exists (no user-enumeration oracle). Deleting another user also requires
    a reason of 1-500 Unicode code points after trimming (BAD_USER_INPUT
    otherwise); this check follows target authorization.

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
    deleteUser(userRef: ID, reason: String): Boolean!

    # Organization management
    createOrganization(name: String!, urn: String!): Organization!

    """
    Update an Organization.

    Accepts the entity's ID or URN.
    """
    updateOrganization(
      id: ID!
      name: String
      urn: String
      listedOnMarketplace: Boolean
      policy: JSON
    ): Organization!

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
    """
    Platform invite — no org association, just onboards a new user
    """
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
    Create a free-standing memory. orgId accepts an organization's ID or URN.
    With orgId, the default is knowledge-class with ORGANIZATION visibility;
    knowledge/group creation requires the org's memory.create grant. Omitting
    orgId (or passing null) creates a user-owned memory in the authenticated
    caller's namespace and requires an explicit personal/private memoryClass.
    The default knowledge class is refused without orgId. Pass
    memoryClass: group + visibility: GROUP for a group-class memory
    (023-app-shape US4; the caller is auto-added as the first owner),
    or memoryClass: personal | private for an owner-only memory the
    caller owns (free-standing, no app/agent). An org-anchored personal/private
    memory requires actual membership of that org container; the org-less
    owner-only path requires no org membership. system- and app-class
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
      'private'. Without orgId, only personal/private are accepted; the
      knowledge default is refused. 'system' and 'app' are rejected here and
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
      """
      #1447/#1448 — accepted for compatibility and ignored since #1591: minting
      is per node, and every new node starts unminted, with draft rights, in
      any memory.
      """
      draftCorpus: Boolean
    ): Memory!

    """
    Add a NEW memory to an App, born App-scoped.

    Unlike createMemory (which only makes free-standing memories), this scopes
    the new memory to an App. memoryClass accepts only the App-associable
    classes: 'app', 'knowledge', 'personal', or 'private'. This door rejects
    'system' and 'group'; this is its allowlist, not a claim that the database
    forbids app_id for every rejected class. appRef/agentRef accept an ID, bare URN, or prefixed URN;
    the Agent must be installed in the App.

    Authorization is split by class: 'app'/'knowledge' are shared data and
    require the App's user-owner or owning-org OWNER/ADMIN. Personal/private
    require the caller's actual App membership (the caller becomes the owner),
    with no platform-admin membership bypass; they are not yet supported for
    a user-owned App. The install is rechecked as live and licensed in the
    deciding transaction. Live name collisions are aliased to a free URN.

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
    Transfer a free-standing Memory to exactly one new owner. dryRun previews
    the new URN and dependent handling without writing; apply recomputes under
    lock and can pin the preview with expectedNewUrn. A class change across
    user/org ownership must be explicit. The caller needs authority on both
    sides; unreadable source memories are concealed as not found. Group members
    block transfer by default; resetGroupMembers explicitly revokes every old
    membership inside the transfer transaction. A group destination then adds
    the caller as its first owner-member.
    """
    transferMemoryOwnership(memoryRef: ID!, orgRef: ID, userRef: ID, targetClass: MemoryClass, expectedNewUrn: String, resetGroupMembers: Boolean = false, dryRun: Boolean = false): MemoryOwnerTransferPreview!

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

    Copies the Memory row and its eligible live graph. Comment nodes,
    compiled boot-prompt nodes and decision-family nodes are excluded;
    derived INCLUDE edges are re-derived rather than copied. References to
    the source memory's URN inside node content/abstract
    (canonical and legacy spellings) are rewritten to the clone's URN.
    Vector-index config carries over and the clone's nodes are stamped for
    re-embedding.

    NOT copied: revision history, subscriptions, shares, group members
    (the caller is bootstrapped as a group clone's first owner), sessions,
    licenses, log entries, assets, and git-sync config (the clone starts
    DB-only).

    Include tags (#2167; hrn:node:hadronmemory.com:specs:cor:dmo:150:04 and
    hrn:node:hadronmemory.com:specs:cor:dmo:150:06): every tag in every copied node
    counts as added, checked after the URN rewrite. A tag whose target is
    missing or that the caller can't read refuses with
    INCLUDE_TARGET_UNAVAILABLE. A tag that closes a cycle among the copied
    nodes refuses with INCLUDE_CYCLE, at any chain length. Either refusal names
    only the authored tag and nothing is created.

    Authorization: the SOURCE side requires (personal/private →
    owner only; knowledge/group → source-org memory.clone grant). When \`targetUrn\` names a
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

    The new memory PRESERVES the source's class: group stays group (the
    caller is bootstrapped as its first owner), personal/private stays
    owner-owned, and knowledge stays knowledge. Class preservation alone is
    not a claim that the new memory has an identical membership audience.
    Governance/config (requiresLicense, chunk dials, revision cap, acceptsUploads)
    carries over from the source.

    Authorization: read access to the source memory (denial reads as
    NODE_NOT_FOUND). For knowledge/group sources the caller needs the SOURCE
    org's memory.clone grant (an export) AND the destination org's memory.create
    (plus a non-reader membership for a cross-org drop); a personal/private
    extract instead requires the owner to be a member of the destination org.
    'move' additionally requires source write access and must leave a live
    node outside the extracted subtree; otherwise it would empty the source
    (clone + deleteMemory instead). The guard uses node membership, not the
    source memory's mutable name.
    Encrypted and system/app-class sources are rejected.

    Include tags (#2167; hrn:node:hadronmemory.com:specs:cor:dmo:150:04 and
    hrn:node:hadronmemory.com:specs:cor:dmo:150:06): every tag in every copied node
    counts as added and is resolved where it lands in the new memory. First, a
    tag naming a copied node is rewritten to that node's rebased loc (a URN tag
    to the source memory becomes the new memory's URN); only the target
    changes, and a rewritten node loses its contentHash and authorship. A tag
    naming anything else stays as written, so a relative tag naming a node
    left behind refuses with INCLUDE_TARGET_UNAVAILABLE (a URN tag to a memory
    the copier can read passes unchanged). A relative tag outside the subtree
    whose loc equals a rebased loc also refuses (R188), and is never rewritten. A tag that closes a cycle refuses
    with INCLUDE_CYCLE. Either refusal names the tag as it stands in the copy,
    and nothing is created or moved.

    v1 limitation: apart from include tags, node content is copied verbatim —
    because both the slug and node locs change, other URN references among the
    moved nodes WILL break; and
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

    personaRole and systemPrompt are the persona dressing (cor:agt:020:01) —
    the reusable role plus the '{{name}}'-templated prompt. The NAMED
    identity is a Worker, cast with castWorker; names never live on agents.

    orgId accepts the org's ID or URN.
    """
    createAgent(orgId: ID, name: String!, description: String, systemPrompt: String, systemMemoryId: String, visibility: AgentVisibility, type: AgentType, surfaces: [String!], personaRole: String, usesTasks: Boolean, resetContextAfterTask: Boolean, "#2171 (R211): the member roles the Agent offers. Omitted: owner and member. Empty or malformed: BAD_USER_INPUT." memberRoles: [String!]): Agent!
    """
    Clone an Agent into an organization you administer: a new PERSONAL-draft Agent
    with its own copy of the source's system memory, its links and imports, and a recorded origin. Needs a
    PUBLIC source, or one you manage in its own organization. Refusals are typed (AGENT_NOT_PUBLIC,
    CLONE_*); a source that keeps changing answers CONFLICT with reason AGENT_CLONE_SOURCE_CHANGED
    (retryable). target must be an organization.

    Copied: name, description, systemPrompt, type, surfaces, usesTasks, registerDefaults, installationPolicy,
    memoryProvisioning, personaRole; the system memory graph (nodes, edges, pending edges) with the tasks and
    processes index pointers remapped; memory links (kept as links, not copied); imports and the base, re-pointed.
    NOT copied: visibility (the clone is PERSONAL), AI service config, boot-prompt pointers, node comments,
    decisions and decision logs, compiled boot-prompt nodes, derived include edges (re-derived), node revision
    history, embeddings (re-stamped), assets (their bytes stay with the source), git-sync config, the editor lock
    and published-revision pointer, Worker castings, App installs, and the source organization's subscriptions
    and grants. A base or import is licensed for the TARGET organization at clone time, or the clone refuses
    (BASE_UNUSABLE, IMPORT_UNUSABLE). A refusal's blocker subjects carry a name only when you can read the
    subject; otherwise only a position. The clone's origin is Agent.clonedFromAgentRef.
    """
    cloneAgent(source: ID!, target: ID!, name: String, slug: String): Agent!

    """
    Update an Agent.

    urn renames the slug (org-owned agents only). personaRole is normalized
    (explicit null or blank clears, omitted preserves). Worker castings
    referencing this agent are unaffected —
    the named identity lives on the Worker.

    Accepts the entity's ID or URN.
    """
    updateAgent(ref: ID!, name: String, urn: String, description: String, systemPrompt: String, systemMemoryId: String, visibility: AgentVisibility, listedOnMarketplace: Boolean, type: AgentType, surfaces: [String!], personaRole: String, usesTasks: Boolean, resetContextAfterTask: Boolean, registerDefaults: RegisterDefaultsInput, "#2171 (R211): replaces the member roles the Agent offers (and nothing else in its installation policy). Omitted or null: unchanged. Empty or malformed: BAD_USER_INPUT. Existing members keep their role." memberRoles: [String!]): Agent!

    """
    Soft-delete an Agent and its owned system memory. Requires management
    access to the readable Agent. Refuses while a live
    App install or live parent Agent import references it, or a live Agent
    extends it as its base. AgentMemoryItem attachments do not block deletion.

    Also refused with DECISION_CONTAINED (#1641) while the Agent's system memory holds a decision or a
    decision log: removing the memory would remove them, so the Agent is kept. This guard is live
    whether or not minted-corpus permanence is enforced; the separate minted-corpus refusal applies only
    when that enforcement is on.

    See hrn:node:hadronmemory.com:specs:cor:dmo:050:14.

    Accepts the entity's ID or URN.
    """
    deleteAgent(ref: ID!): Boolean!

    """
    #1885 (hrn:node:hadronmemory.com:specs:cor:dmo:050:14) - set, change or clear the one base Agent this
    Agent extends. The Agent then inherits its base chain's system-memory
    nodes, except boot prompts. A null baseRef clears the base.

    Whoever manages this Agent may call it. Extending another organization's
    Agent needs the organization's active AgentOrgGrant for it (a same-org base
    provisions one, never reactivating a revoked grant); a user-owned Agent
    extending someone else's needs its owner's active AgentSubscription.
    Refused, changing nothing, with AGENT_BASE_CYCLE when the base is this
    Agent or extends it, and AGENT_BASE_CHAIN_TOO_LONG when a chain through
    this Agent, its own or any Agent's that extends it, would hold more than 4.

    Accepts each Agent's ID or URN.
    """
    setAgentBase(ref: ID!, baseRef: ID): Agent!

    """
    #1892 (hrn:node:hadronmemory.com:specs:cor:dmo:050:15, hrn:node:hadronmemory.com:specs:cor:dmo:050:16) - set or clear
    this Agent's tasks-index and processes-index pointers. An omitted argument
    leaves that pointer unchanged; null clears it. Each target is a node ID or
    fully-qualified URN, and must be a live node the caller may read (refused
    as NODE_NOT_FOUND otherwise). Whoever manages this Agent may call it.
    Accepts the Agent's ID or URN.
    """
    setAgentIndexRefs(ref: ID!, tasksIndexRef: ID, processesIndexRef: ID): Agent!

    """
    #949 — re-own an Agent's class=system memory to the Agent's own owner
    (org XOR user). On an ownership repair, attempt the derived
    '<agent-urn>-system' URN; if another live memory holds it, retain the
    current URN. A changed URN records an alias. An already-consistent owner
    pair returns without changing its URN.

    The recovery path for a system memory that ended up owned by a different
    tenant. Access to a memory follows the MEMORY's owner, so such a row puts
    one tenant's Agent design inside another tenant's audience. System
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
    Start an AGENT CHAT (creates chat nodes, loads conversation, returns
    compiled prompt). When called by a JWT user, the agent chat is created in
    that user's personal memory for the agent (provisioned lazily if
    needed).

    #1034: an **agent chat** — deliberately not "chat session", which is
    reserved for the human's own conversation and names no row in this schema,
    and not the **team chat**, which is the App's shared channel.

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
    #
    # #1581: the caller must reach the Agent (PUBLIC, own, an org READER, or
    # an AppMember of an App with a live licensed install; a pure App key: the
    # Agent installed and licensed in its App), or the call fails exactly like
    # an unknown Agent. userId (acting for another user) is accepted only
    # from a pure App key, and only for a live AppMember of that App or a user
    # that App minted (createAppUser); a subscription carries no App, so it
    # does not count. A session-bound key always acts as its session's user
    # (a supplied userId must match), never names anyone from an anonymous
    # session, and chats only with its session's Agent. Anything else reads as an unknown user
    # or Agent. A signed-in user acts as themselves. The
    # subscription is provisioned in the transaction that creates the chat.
    startChat(agentId: ID!, userId: String, conversationName: String, scope: ChatScope = private, isTestRun: Boolean = false): ChatStartResult!
    """
    Process a user message (saves message, builds context, returns next prompt)
    """
    sendChatMessage(chatId: String!, userMessage: String!): ChatPromptResult!
    """
    Process the LLM's tool response (extract data, transition stage, save assistant message)
    """
    processChatResponse(chatId: String!, toolResponse: JSON!): ChatResponseResult!
    """
    Persist a caller-produced chat summary.

    #1115 — READ THIS BEFORE CALLING. The summary is STORED and nothing reads
    it back as a summary: no query excludes the messages it covers, and the
    model-history builder has no summary branch, so the node is replayed as an
    ordinary user turn ALONGSIDE the messages it summarises. Calling this
    makes the transcript longer, never shorter.

    The compression this was built for does not exist yet, and the trigger
    that used to request it (ChatPromptResult.summarizationNeeded) now always
    returns null. Kept working so existing callers do not break; re-arming it
    needs the design in #1115, not a flag.
    """
    saveChatSummary(chatId: String!, summary: String!): Boolean!
    """
    Rename a saved chat with current write access to its host memory.
    """
    updateChatTitle(chatId: String!, title: String!): Boolean!
    """
    Soft-delete a saved chat and all its messages. Requires current write access
    to its host memory.
    """
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
    Clear an Agent's AI provider config without returning or decrypting keys.

    Clearing a user-owned Agent, by its owner or a platform ADMIN/OWNER,
    removes every named configuration, including disabled configurations.
    hrn:node:hadronmemory.com:specs:cor:dmo:050:13
    An org-owned Agent clear deletes only the configuration named 'default'.

    Accepts the entity's ID or URN.
    """
    clearAgentAIConfig(agentId: ID!): Agent!

    """
    036-ai-service-config: create a named AI config on an owner entity.

    apiKey semantics: non-empty = encrypted at rest with a masked preview.
    Omitted is accepted only where a run may use the server's own
    credential: a HADRON_SERVER config with no explicit endpoint.
    Eligible process-credential providers: openai, anthropic, bedrock;
    every other provider needs its own key. Every ORGANIZATION, APP and AGENT
    config needs its own key: the platform credential is platform spend
    (#1390). Any config with an endpoint needs one too, because the SDK would
    otherwise send the server's credential to a host that didn't issue it (#1389). All of
    these are refused with AiConfigValidationError. A host that checks no
    key takes any placeholder.
    Name is trimmed, must be 1-64 lower-case [a-z0-9_-] starting with a
    letter or digit, and is unique per owner. provider must be a known
    provider; params are validated per provider.

    Auth: platform ADMIN/OWNER for HADRON_SERVER; org ADMIN for ORGANIZATION;
    the App/Agent's strict owner or owning-org ADMIN for APP/AGENT. A platform
    role does not bypass a user-owned App/Agent's credential gate.
    ownerId accepts ID or URN (HADRON_SERVER: ID only).
    """
    createAiServiceConfig(
      ownerType: AiConfigOwnerType!
      ownerId: ID!
      name: String!
      provider: String!
      model: String!
      apiKey: String
      params: JSON
      "#1373: base URL; https only, no query/fragment/credentials. Omit for the provider default."
      endpoint: String
      "#1373: OpenAI-compatible providers only; omit for the provider default."
      apiStyle: AiApiStyle
      enabled: Boolean
    ): AiServiceConfig!

    """
    036-ai-service-config: update a named AI config. All fields optional.

    apiKey semantics: omitted = keep the stored key; empty string =
    clear it (explicit null also clears); non-empty = replace (encrypted,
    preview recomputed). The RESULTING config is held to createAiServiceConfig's key rule, so
    clearing the key of a config that needs one is refused.

    Auth: the same owner-aware credential gate as createAiServiceConfig;
    managing a user-owned Agent through a platform role alone does not grant
    access to its stored credential.
    """
    updateAiServiceConfig(
      id: ID!
      name: String
      provider: String
      model: String
      apiKey: String
      params: JSON
      "#1373: omitted = unchanged; null or empty string = clear (provider default)."
      endpoint: String
      "#1373: omitted = unchanged; null = clear (provider default)."
      apiStyle: AiApiStyle
      enabled: Boolean
    ): AiServiceConfig!

    """
    #1378: test a SAVED config by id with one small real call, through the same
    client, endpoint and egress guard a run uses; the stored key never leaves
    the server. The override argument tests edited values without saving them. Auth: as
    updateAiServiceConfig; refused under impersonation. Every test that
    reaches the provider is metered (usage type ai-config-test); NO_API_KEY
    and KEY_UNREADABLE make no call and record nothing. The call is bounded
    by a 20s timeout. Rate-limited per caller and config (RATE_LIMITED).
    """
    testAiServiceConfig(id: ID!, override: AiServiceConfigTestOverride): AiServiceConfigTestResult!

    """
    036-ai-service-config: delete a named AI config (hard delete; the
    resolution walk simply no longer finds it).

    Auth: admin rights on the owning entity (as aiServiceConfigs).
    """
    deleteAiServiceConfig(id: ID!): Boolean!

    """
    Spec 049 Phase 2 — create a named scope on exactly one owner. Auth by
    owner: organization CONTRIBUTOR+; App or Agent ADMIN of the owning org, or
    the owner of a user-owned one. Name 1–64 [a-z0-9_-], unique per owner
    among live scopes (SCOPE_NAME_TAKEN), never \`global\` / \`app\`.
    """
    createScope(input: CreateScopeInput!): Scope!

    """
    #1325 — add a rule to a memory's config (creating the config on first use).
    Managers only; anyone else gets MEMORY_NOT_FOUND. A role that already has a
    rule is refused NODE_ROLE_RULE_EXISTS.
    """
    createNodeRoleRule(memoryRef: ID!, input: CreateNodeRoleRuleInput!): NodeRoleRulePayload!

    """
    #1325 — change a rule by its id. With expectedRevision, a rule changed since
    you read it is refused CONFLICT (extensions.currentRevision) and nothing is
    written; omitted, the last writer wins. A rule you may not manage reads as
    NOT_FOUND. A LOCKED rule (#1334) is refused with RULE_LOCKED (extensions
    ruleId, role, sourceTemplateId) for EVERY caller: unlock it first
    (unlockNodeRoleRule) or re-apply its required template.
    """
    updateNodeRoleRule(ref: ID!, input: UpdateNodeRoleRuleInput!, expectedRevision: Int): NodeRoleRulePayload!

    "#1325 — delete a rule by its id; expectedRevision as for updateNodeRoleRule. A LOCKED rule (#1334) is refused with RULE_LOCKED for every caller: unlock it first (unlockNodeRoleRule)."
    deleteNodeRoleRule(ref: ID!, expectedRevision: Int): Boolean!

    """
    #1334 — the deliberate step before a rule a required template LOCKED can be
    edited or deleted (Holger, 2026-09-27: nobody changes a locked rule through
    an ordinary edit). Needs lock authority: an org ADMIN/OWNER of the memory's
    org; on a personal/private or org-less memory, its manager. Anyone else who
    manages the memory gets RULE_LOCKED. Visible: bumps revision and stamps
    updatedBy. Unlocking an unlocked rule changes nothing. expectedRevision as
    for updateNodeRoleRule.
    """
    unlockNodeRoleRule(ref: ID!, expectedRevision: Int): NodeRoleRulePayload!

    """
    #1334 — copy a template's rules into ONE memory's config. A one-off copy:
    later template edits never reach this memory, and re-applying is explicit.

    Needs MANAGE on the memory (else MemoryNotFound) and on the template,
    which exists for you only if you manage its owner (else
    MEMORY_CONFIG_TEMPLATE_NOT_FOUND). The rules are validated as a whole,
    under a share lock, as createNodeRoleRule validates a new rule's
    references (NODE_NOT_FOUND for one you cannot read, NOT_A_TASK), and a
    template rule whose required task was deleted refuses the whole apply
    (NODE_ROLE_RULE_REF_BROKEN). All-or-nothing per memory.

    When the memory already has a rule for a role, a non-required template
    skips it and a required template replaces it. A LOCKED rule is only
    replaced by a caller with lock authority (see unlockNodeRoleRule);
    otherwise SKIPPED_LOCKED. Rules written by a required template are locked.

    expectedTemplateRevision: CONFLICT (with currentRevision) if the template
    changed since you read it. dryRun: the same report with nothing written.
    """
    applyMemoryConfigTemplate(templateRef: ID!, memoryRef: ID!, expectedTemplateRevision: Int, dryRun: Boolean): MemoryConfigApplyResult!

    """
    #1325 part (c) — create a template. ownerRef names the organization, user
    or App; omit it for HADRON_SERVER (platform admins only; refused
    HADRON_SERVER_NOT_CONFIGURED when this server has no row) and for USER
    (yourself — you own templates for no one else). A second live template of
    the same name under the same owner is MEMORY_CONFIG_TEMPLATE_EXISTS.
    """
    createMemoryConfigTemplate(
      ownerType: MemoryConfigTemplateOwnerType!
      ownerRef: ID
      input: CreateMemoryConfigTemplateInput!
    ): MemoryConfigTemplatePayload!

    """
    #1325 part (c) — change a template by its id. With expectedRevision, a
    template changed since you read it is refused CONFLICT
    (extensions.currentRevision) and nothing is written. A template you may not
    manage reads as MEMORY_CONFIG_TEMPLATE_NOT_FOUND.
    """
    updateMemoryConfigTemplate(ref: ID!, input: UpdateMemoryConfigTemplateInput!, expectedRevision: Int): MemoryConfigTemplatePayload!

    "#1325 part (c) — soft-delete a template. Configs it was applied to keep their copies."
    deleteMemoryConfigTemplate(ref: ID!, expectedRevision: Int): Boolean!

    "Spec 049 Phase 2 — update a scope you may write (auth as createScope). memoryRefs replaces the ordered list."
    updateScope(ref: ID!, input: UpdateScopeInput!): Scope!

    "Spec 049 Phase 2 — soft-delete a scope you may write; its name is free again at once."
    deleteScope(ref: ID!): Boolean!

    """
    Spec 049 Phase 4 — create a named Channel with its chat root. The host is
    any memory class you may write; its audience decides the Channel's
    (cor:acl:030:01). LOC_OVERLAPS_CHANNEL when the address overlaps an
    existing Channel's.
    """
    createChannel(input: CreateChannelInput!): Channel!

    "Spec 049 Phase 4 — rename / re-describe a Channel whose host memory you may write. ref: its id or its address (Channel.chatRootUrn, #1171)."
    updateChannel(ref: ID!, input: UpdateChannelInput!): Channel!

    """
    Spec 049 Phase 4 — soft-delete a Channel AND its chat root together (the
    protection holds while either exists). There is no restore: creating a
    Channel at the same address adopts it and starts clean, so the old
    transcript does not come back (#1257, #1226). Host memory write access
    required. An App's
    default Channel is unlinked from the App. ref: its id or its address
    (\`Channel.chatRootUrn\`, #1171).
    """
    deleteChannel(ref: ID!): Boolean!

    """
    Spec 049 Phase 5 — declare that an attendee takes part in a Channel. Owner:
    an App (org ADMIN / owner of a user-owned App) or an organization
    (CONTRIBUTOR+). attendeeRef: a Worker or an Agent in the owner's context;
    omitted = every attendee there. REGISTER_ENTRY_EXISTS when a live row
    already holds that (owner, Channel, attendee). Intent, never permission.
    """
    createRegisterEntry(input: CreateRegisterEntryInput!): RegisterEntry!

    "Spec 049 Phase 5 — change a row's role / mentionOnly / description (the owner's gate)."
    updateRegisterEntry(ref: ID!, input: UpdateRegisterEntryInput!): RegisterEntry!

    "Spec 049 Phase 5 — soft-delete a row. Each owner removes its own rows; an App may remove its install-created default."
    deleteRegisterEntry(ref: ID!): Boolean!

    """
    Spec 049 Phase 7 — advance an attendee's cursor on a Channel (the relay's
    write; §8.7 gate: the caller must be the attendee's DRIVER — a user whose
    live session is bound to that Worker, or the App-key principal of the
    attendee's App). Monotonic: a lower seq is a no-op that returns the cursor.
    channelRef: the Channel's id or its address (\`Channel.chatRootUrn\`, #1171).
    """
    advanceChannelReadState(attendeeRef: ID!, appRef: ID, channelRef: ID!, seq: Int!): ChannelReadState!

    """
    #1353: explicitly advance the cursor owned by one exact,
    caller-owned live Worker session on one readable registered Channel.
    Shares the MCP mark-read helper; unlike advanceChannelReadState this door
    requires that session. Monotonic; a seq beyond the captured Channel
    watermark is refused.
    """
    markOwnTeamChatRead(
      appRef: ID!
      sessionRef: ID!
      channelRef: ID!
      seq: Int!
      """
      #2181 — fence the mark to the incarnation you read. It runs in one transaction behind the Channel row lock: a
      different incarnation is CHANNEL_INCARNATION_CHANGED (never repeat it; read again and pin the new incarnation)
      and no cursor, check stamp or session resume is applied. A successful fenced response confirms
      channelIncarnation = the incarnation you pinned and lastSeenSeq >= seq, even when an equal or lower mark left a legacy NULL
      cursorIncarnation in place. Omitted: the mark is UNFENCED, as before.
      """
      expectedIncarnation: Int
    ): OwnTeamChatReadState!

    """
    Explicitly confirm a previously previewed #1353 switchover. The proof is
    actor/App/scope-bound; any live-Worker, register or cursor drift rejects
    the whole transaction. It advances only through the heads captured by the
    preview, so messages arriving afterward remain unread.
    """
    confirmTeamAttentionSwitchover(appRef: ID!, proof: String!): TeamAttentionSwitchoverResult!

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
    Create an App and install its initial Agent. With orgRef, the App is owned
    by that Organization and requires org ADMIN; without orgRef, it is owned by
    the authenticated User and remains owner-only.

    An org-owned install auto-provisions an AgentOrgGrant only for its own
    Agent. A cross-org install requires an existing active grant; subscribe to
    a PUBLIC Agent through createAgentOrgGrant before creating the App.
    It adds the caller as an AppMember with role 'owner' only when that role is
    present in the Agent's installationPolicy and the caller is a User.
    Required AgentImports cascade automatically for org-owned Apps; optional
    imports cascade only when their id appears in installOptional. Personal
    Apps reject dependency cascades in v1.

    Selected dependencies must also be licensed before any App is created.
    The server enforces this even when a caller bypasses the portal.

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
      The initial Agent installed into this new App. Required as of
      009-install-agent-flow: every new App starts with an installed Agent.
      For an org-owned App, the server auto-provisions a grant only for an
      Agent owned by that org; any cross-org Agent needs an existing active
      AgentOrgGrant. A personal App accepts only
      a PUBLIC Agent or one owned by the caller, and licenses a foreign PUBLIC
      Agent through the owner's AgentSubscription.
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
      "036 legacy shim over the App's 'default' AI config; held to createAiServiceConfig's key rule (#1389)."
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
      "036 legacy shim over the App's 'default' AI config; held to createAiServiceConfig's key rule (#1389)."
      aiApiKey: String
      expiresAt: String
      surfaces: [String!]
      trainingMode: Boolean
      createUserPermission: CreateUserPermission
      identifyUserMethod: IdentifyUserMethod
      sessionTimeoutSeconds: Int
      "Ruling DY-5: the dormancy threshold in days (a positive integer). See App.sessionDormancyDays."
      sessionDormancyDays: Int
      "Ruling DY-3: see App.agentSessionsExpire."
      agentSessionsExpire: Boolean
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

    Accepts the entity's ID or URN for both appRef and agentRef. Optional
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
    casting's role is the agent's personaRole and cannot be overridden
    (hrn:node:hadronmemory.com:specs:cor:dmo:050:11, R222): beside an agentRef,
    a role that is not that agent's refuses WORKER_ROLE_OVERRIDE_REFUSED.

    The casting check (#2458) is shared with changeWorkerAgent: the App's
    holder must be licensed for the agent (AGENT_ORG_GRANT_INACTIVE /
    AGENT_ORG_GRANT_REQUIRED; a missing same-organization grant is no refusal
    and a revoked one is) and for every Agent its served boot prompt
    includes from (BOOT_PROMPT_GRANT_REQUIRED / BOOT_PROMPT_INCLUDE_UNAVAILABLE).

    The name (cor:agt:020:02) is REQUIRED since #1050 — one attempt, and
    WORKER_NAME_TAKEN is the answer. There is no register to fall back to: a
    name is permanent within the App, so it is chosen and never derived, and a
    nameless cast refuses WORKER_NAME_REQUIRED rather than minting a permanent
    identifier nobody picked. The workers_app_name_uniq constraint IS the
    arbiter. Names are unique per App, case-insensitively, FOREVER (two Apps
    may each have an Iris; retirement and uninstall never free a name).
    Names whose mention token is a broadcast word are refused
    WORKER_NAME_RESERVED; choose a name whose token does not broadcast.
    #1677: NFKC-normalized Unicode 16 UTS #39 skeletons (original-case and
    caseless) must also be distinct within the App, including retired workers. A collision refuses
    WORKER_NAME_CONFUSABLE and names the existing worker; the chosen display
    spelling is preserved. Existing workers are not renamed or invalidated.

    A worker-scoped working memory is provisioned in the App's container
    (Worker.memoryId; best-effort — a failed provision leaves it null for
    lazy provisioning).

    Authorization: an org member with CONTRIBUTOR+ on the App's org, an
    AppMember of the App whose role is not 'reader', or the owner of a
    user-owned App. Pure App-key principals are denied.

    Error codes (extensions.code): WORKER_NAME_TAKEN, WORKER_NAME_CONFUSABLE,
    WORKER_NAME_REQUIRED, WORKER_NAME_RESERVED, WORKER_NAME_RESERVED_TEAM_PREFIX
    (a mention token starting team., refused only while TEAM_TAGS_ENABLED),
    WORKER_AGENT_NOT_INSTALLED, WORKER_AGENT_NOT_FOUND, WORKER_AGENT_AMBIGUOUS,
    APP_UNINSTALLED.

    #1050 also removed WORKER_ROLE_NOT_FOUND from this mutation: it fired only
    because a nameless cast had to find a roles:<role> node to read a register.
    An unrecognized role now resolves no agent (WORKER_AGENT_NOT_FOUND) or, with
    an explicit agentRef, is simply the casting's label.

    #1050: the TEAM_AGENT_* and SESSION_EXPIRED refusals are gone from this
    mutation. They were reachable only because a nameless cast had to locate a
    Team Agent and read its (possibly encrypted) system memory to find a
    register. Casting now touches no system memory at all, so teamAgentRef is
    gone too rather than left accepted-and-ignored.

    Accepts the entity's ID or URN for appRef and agentRef.
    """
    castWorker(
      appRef: ID!
      agentRef: ID
      role: String
      """
      #1050: a name is now mandatory in EFFECT but stays nullable in the
      schema, refused at the resolver with the typed WORKER_NAME_REQUIRED.
      A non-null String would report the same mistake as a bare validation error,
      losing the reason a name cannot be derived — and it would split this
      surface from the MCP tool, which calls the resolver directly and would
      keep the typed refusal. One rule, one message, both paths.
      """
      name: String
      "S12 head choice: requires staffing and App management; refuses WORKER_REPORTING_CAST_UNAVAILABLE if standby becomes available without cast coverage integration."
      reportsTo: ID
      "S12 explicit no-team choice; omit reportsTo. Both keys conflict, single null/blank/false is invalid. Omission remains UNSET while enforcement is OFF."
      noTeam: Boolean
      promptOverride: String
    ): Worker!

    """
    #974 — retire a Worker (cor:agt:020:02): end the casting while reserving
    its name FOREVER. A retired worker stops authoring team chat at once (the
    worker-App pin checks retirement at post time), takes no new work records,
    and refuses new session bindings; the row and its name reservation
    survive. Idempotent — retiring an already-retired worker returns it
    unchanged. Same authorization as castWorker. workerRef is the worker's id
    or its URN (#991). Retiring clears the worker's own reportsTo (#1726);
    workers that report to it keep theirs and read reportsToRetired.
    """
    retireWorker(workerRef: ID!): Worker!

    """
    #1726 — set, hand over or clear (reportsTo: null) who a worker reports to:
    a non-retired worker of the same App, never itself, never a cycle
    (WORKER_REPORTS_TO_SELF / _OTHER_APP / _RETIRED / _CYCLE; WORKER_RETIRED
    for a retired worker). Allowed for whoever manages the App, and for the
    worker it reports to now (handing over or clearing is its agreement). A
    worker that reports to nobody may also be claimed by a worker for itself
    when one person holds both, or placed under any worker by its own holder
    (interim, pending a ruling). WORKER_REPORTS_TO_FORBIDDEN otherwise. A worker acts through its bound
    session, with a person behind the request. Each change is a
    \`worker.reports-to\` team event. An explicit clear records NO_TEAM, including a previously UNSET line; repeating the recorded choice changes nothing.
    """
    setWorkerReportsTo(workerRef: ID!, reportsTo: ID): Worker!
    """
    #1050 — release a HELD name, so somebody else can hold it.

    A name is held by a person until released; nothing else frees one, which
    is what makes availability a fact rather than a judgement about whether an
    idle driver is really gone. Two principals may call this, and they are
    different acts: the HOLDER, releasing their own name and owing nobody
    notice; or an App/org ADMIN, force-releasing somebody else's — the path
    that exists so a departed colleague's names are not held forever.

    An admin force-release POSTS TO THE TEAM CHAT, naming who released what
    and from whom, because the incident this model answers is exactly the one
    where notice was owed and there was no way to give it. Best-effort: an
    unreachable chat never blocks the release.

    Releasing does NOT retire the worker, free the name for a different
    casting, or touch its history — the name stays permanently allocated to
    this casting, and the handoff sequence and worklog travel with the worker
    to whoever holds it next. Idempotent: releasing an unheld worker returns
    it unchanged.

    #1073 — OPTIONAL PRECONDITION. The two release paths are different acts:
    the holder's own release notifies nobody, an admin force-release announces
    itself in the team chat. A client that wants to tell its user which one it
    is about to perform can only classify from a pre-read, and the hold can
    change in between — so the act performed differs from the act described,
    and a hold taken in that interval is force-released silently.

    State what you expect and the server refuses instead. Pass
    expectedHolderUserId to assert a specific holder, or expectUnheld: true to
    assert there is none; a mismatch refuses WORKER_HOLD_STALE carrying the
    holder actually found. Passing neither keeps the unconditional behaviour,
    so this is additive. Passing both is BAD_USER_INPUT.

    Two arguments rather than one nullable id on purpose: distinguishing
    "expect nobody" from "no expectation" through a nullable argument would
    rest on KEY PRESENCE, and any layer that forwards the argument
    unconditionally sends undefined — present, and read as an assertion nobody
    made. That is a live hazard in this codebase, so a safety precondition does
    not lean on it.
    """
    releaseWorker(
      workerRef: ID!
      "Assert the name is held by exactly this user. Mismatch refuses WORKER_HOLD_STALE."
      expectedHolderUserId: ID
      "Assert the name is held by nobody. Mismatch refuses WORKER_HOLD_STALE."
      expectUnheld: Boolean
    ): ReleaseWorkerPayload!

    """
    #1010 — amend a casting's individuality after the fact.

    \`promptOverride\` is the per-worker escape hatch (cor:agt:020:01), but it
    could only be set at CASTING time — fixing a casting's individuality at the
    one moment nobody yet knows what makes it individual. The role agent's
    \`systemPrompt\` cannot stand in (it is SHARED by every casting of that
    role), and re-casting is barred by \`WORKER_IN_USE\` for any worker that has
    done work — precisely the ones with an identity to record.

    Signature/trailer edits require an App manager; a bound worker is provisionally refused (H26).
    Omitted preserves, null refuses, whitespace-only becomes empty text; other text is raw, max 2000 characters, no NUL.
    A mixed update is atomic. These values reach the next compose/bind via S4.

    \`name\` is permanent by law (hrn:node:hadronmemory.com:specs:cor:agt:020:02). The agent
    (and with it the role) is changed by changeWorkerAgent, not here. OMITTING promptOverride
    preserves it; explicit \`null\` or a blank string CLEARS it, matching the
    nullable column and castWorker's blank-is-absent normalization.

    Refuses WORKER_RETIRED for a retired worker: an override is briefing text
    delivered at bind time, and a retired worker takes no new bindings, so the
    edit could never reach anyone.

    promptOverride alone keeps castWorker staffing authorization. workerRef is the worker's id or URN (#991).
    """
    updateWorker(workerRef: ID!, promptOverride: String, signature: String, trailer: String): Worker!

    """
    #2458 (hrn:node:hadronmemory.com:specs:cor:dmo:050:11, R222): change the
    agent a worker casts. The role follows the agent and is never typed in.
    Name, slug, URN, signature, trailer, reporting line and every past record
    stay; past sessions keep the agent and role they ran under
    (Session.agentId, Session.role).

    Who: whoever manages the App, as themselves. A worker session (even one
    its manager holds), an App key, an impersonation or a run is FORBIDDEN.

    To what: the same checks as castWorker (WORKER_AGENT_NOT_INSTALLED,
    AGENT_ORG_GRANT_INACTIVE / _REQUIRED, BOOT_PROMPT_GRANT_REQUIRED /
    BOOT_PROMPT_INCLUDE_UNAVAILABLE, APP_UNINSTALLED). Also WORKER_RETIRED,
    WORKER_AGENT_UNCHANGED (it already casts that agent),
    WORKER_AGENT_HAS_NO_ROLE (the agent has no personaRole to change to) and
    WORKER_CASTING_STALE (a concurrent change; read again). A refused change
    changes nothing.

    A complete change, in one transaction: the worker's own boot-prompt
    pointer is cleared (it named the old agent's compiled prompt), the old
    agent's generated tickers end and the new agent's are made, and one
    \`worker.casting\` team event records who and the old and new agent and
    role. It takes effect at the worker's next bind: an open session
    finishes under the agent and role it was bound with. workerRef and agentRef are ids or URNs.
    """
    changeWorkerAgent(workerRef: ID!, agentRef: ID!): Worker!

    """
    #2045 (S8) — set or clear an Agent's boot-prompt pointer. nodeRef (a node id or a
    fully-qualified node URN) must name a COMPILED boot prompt in this Agent's own system memory; approval is not
    required here (it is checked when the prompt is served). nodeRef is REQUIRED: an explicit null clears, and an
    omitted one is refused with BAD_USER_INPUT.

    Only the Agent's manager, acting as themselves (R23): a request bound to a worker session, the manager's own
    included, is refused BOOT_PROMPT_POINTER_SESSION_REFUSED; a non-manager, an App key, an impersonation or a
    run is FORBIDDEN. The gate runs before the target is looked at, so a refused caller learns nothing about it.
    Then: BOOT_PROMPT_POINTER_NOT_FOUND (missing, deleted or unreadable, alike), _NOT_COMPILED, _WRONG_ROLE,
    _WRONG_MEMORY. No MCP twin (R24).
    """
    setAgentBootPrompt(agentRef: String!, nodeRef: String): Agent!
    """
    #2045 — set or clear an installed Agent's boot-prompt pointer for one App (AppAgent.bootPromptRef). The node
    must be compiled and sit in that App's install memory for that Agent. Only the App's manager, as themselves;
    otherwise as setAgentBootPrompt.
    """
    setAppAgentBootPrompt(appRef: String!, agentRef: String!, nodeRef: String): AppAgent!
    """
    #2045 — set or clear a worker's boot-prompt pointer (for customised workers). The node must be compiled and
    sit in the worker's App's install memory for the worker's Agent. Only the App's manager, as themselves;
    otherwise as setAgentBootPrompt. workerRef is the worker's id or URN.
    """
    setWorkerBootPrompt(workerRef: ID!, nodeRef: String): Worker!

    """
    #2046 (S9-4, hrn:node:hadronmemory.com:specs:cor:agt:040:12) — compile an Agent's boot prompt from its source ('boot:source') in the Agent's
    system memory into the compiled node 'boot:compiled' there, as a NEW unapproved revision (every compile writes
    one, even when the text is unchanged), with its provenance and a derived 'compiled-from' edge to the source.
    Sets 'Agent.bootPromptRef' unless 'setPointer: false'. Never approves or signs ('approvalIssued' is always false).

    Whoever manages the Agent, as themselves: a request bound to a worker session, a non-manager, an App key, an
    impersonation, a run, and a target that does not exist are alike refused BOOT_PROMPT_COMPILE_NOT_PERMITTED. Only then: BOOT_PROMPT_TARGET_RETIRED, BOOT_PROMPT_NO_SOURCE, BOOT_PROMPT_SOURCE_INVALID, the
    include refusals (BOOT_PROMPT_INCLUDE_*, _GRANT_REQUIRED, _COMPILE_LIMIT_EXCEEDED, with the tag's 'position'),
    and CONFLICT when the compile could not settle inside its 30-second budget (retry).
    A refusal changes nothing. No MCP twin.
    """
    compileAgentBootPrompt(agentRef: String!, setPointer: Boolean = true): CompiledBootPrompt!
    """
    #2046 — compile an installed Agent's boot prompt for one App into 'boot:compiled' in the App's install memory
    (the App's own 'boot:source' if it has a live one, else the Agent's, with the App's replacing nodes). Always sets
    'AppAgent.bootPromptRef'. Whoever manages the App; otherwise as compileAgentBootPrompt.
    """
    compileAppAgentBootPrompt(appRef: String!, agentRef: String!): CompiledBootPrompt!
    """
    #2046 — compile a customised worker's boot prompt from 'boot:workers:<workerId>:source' into
    'boot:workers:<workerId>:compiled' in the App's install memory. Sets the worker's pointer unless 'setPointer: false'.
    Whoever manages the worker's App; otherwise as compileAgentBootPrompt. workerRef is the worker's id or URN.
    """
    compileWorkerBootPrompt(workerRef: ID!, setPointer: Boolean = true): CompiledBootPrompt!

    """
    #1162 — hard-delete a never-referenced miscast only.
    hrn:node:hadronmemory.com:specs:cor:dmo:050:11
    Empty normally ended and released stints are repairable; persisted
    attribution, including tombstones/history, refuses WORKER_IN_USE.
    The requester must explicitly verify no signed commit, trailer, PR,
    comment, review or published artifact attributes work to this Worker.
    Database counts cannot prove external absence: known or uncertain
    external history means retire instead. Omitted or false confirmation
    refuses WORKER_EXTERNAL_ATTRIBUTION_UNCONFIRMED. No external crawl.
    Also removes empty ended stints and the empty working memory.
    Same staffing authorization as castWorker.
    """
    deleteWorker(workerRef: ID!, confirmNoExternalAttribution: Boolean): Boolean!

    """
    #960 — mint a roles:<role> definition in the Team Agent's system memory.
    Owns the spec knowledge a hand-authoring caller had to carry: the loc is
    roles:<role> (single atom). Refuses an existing role (TEAM_ROLE_EXISTS —
    updateTeamRole is the edit path). Authorization is the Team Agent's
    definition-edit gate: whoever may write the agent's system memory through
    the generic node surface may write roles — the write delegates to that same
    seam (encryption, revision snapshot, git mirror included).

    #1024 deliberately does NOT take \`repos\` here — set it with
    updateTeamRole. A create that also wrote data could not be made atomic: the
    write resurrects a tombstone through an unguarded upsert branch, and
    splitting it into create-then-guarded-update introduced a partial failure
    between the halves (the role lands, the repo write refuses). Two explicit
    calls put that seam where the caller can see and retry it, instead of hiding
    a non-atomic pair inside one mutation.

    #1050: a role definition no longer carries a NAME REGISTER. There is no
    names / nameRange / nameConvention / allowOutOfRange, and no register
    invariants to run, because names are not allocated — a cast supplies its
    own and workers_app_name_uniq is the sole arbiter. Any data.names left on
    an existing node is historical and is neither read nor rewritten.
    """
    createTeamRole(
      appRef: ID!
      teamAgentRef: ID
      role: String!
      description: String
    ): TeamRole!

    """
    #960 — edit a roles:<role> definition. Omitted fields preserve. Unknown
    role: WORKER_ROLE_NOT_FOUND. Same authorization as createTeamRole.

    #1024: \`repos\` sets the role's repo affinity. Omitted PRESERVES; an empty
    array CLEARS; explicit \`null\` is treated as OMITTED, not as a clear — worth
    stating because a client whose variables default to null would otherwise
    have to guess, and the two readings differ (preserve vs wipe). Pass \`[]\`
    to clear deliberately. It is merged into the node's \`data\` rather than replacing it,
    and the write is guarded on the row's revision — a concurrent generic node
    write (updateNode, hadron_update_node_data) refuses TEAM_ROLE_DATA_CONFLICT
    rather than silently reverting, since those surfaces do not take this one's
    lock. Retry after re-reading. A description-only edit carries no data and
    takes no guard.

    #1050: with the register gone this otherwise edits the description alone,
    so the #987 expectedNames compare-and-swap is gone too — it existed solely
    to stop two concurrent wholesale register writes silently dropping each
    other's newly added FREE names, a hazard that cannot arise when the write
    owns no list. That closes #1028 (the client-side register CAS arithmetic)
    outright rather than by implementing it.
    """
    updateTeamRole(
      appRef: ID!
      teamAgentRef: ID
      role: String!
      description: String
      repos: [String!]
    ): TeamRole!

    """
    #1002 — retire a roles:<role> definition. Soft-deletes the role node and
    any sub-nodes under it (roles:<role>:notes is content OF the role), so the
    subtree is recoverable. Unknown role: WORKER_ROLE_NOT_FOUND. Same
    authorization as createTeamRole.

    #1050: unconditional. The minted-name check, TEAM_ROLE_IN_USE, transferTo's
    one-step supersede, the post-delete recheck and the restore compensation
    all existed to protect the REGISTER as a ledger of which names had been
    allocated to this role; with no register there is no ledger to protect and
    no second write to compensate for.

    What that machinery protected is unchanged, and was never the register's
    doing: a Worker's name is permanent per App (cor:agt:020:02, enforced by
    workers_app_name_uniq irrespective of any role), so deleting a role can no
    more free a taken name than it could before. Superseding a role is now
    create-the-successor then delete-the-old; the names were never the thing
    being moved.
    """
    deleteTeamRole(
      appRef: ID!
      teamAgentRef: ID
      role: String!
    ): DeleteTeamRolePayload!

    """
    Post a message into a team App's chat (#939) as a platform operation.
    The team chat is ONE well-known chat per team App, at loc chats:team in
    the Team Agent's shared app-class memory, bootstrapped on first post.
    The message is written through the atomic chat-message allocator (#919),
    so racing posts get distinct consecutive seqs.

    Author derivation (#974): with sessionRef, the message is authored by
    that session's bound non-retired Worker. The session must be writable by
    the caller and live (or eligible for the shared lapsed-session resume).
    Its Worker belongs to this App, or its on-behalf-of user may write the
    Channel's host memory (item J below). The envelope records the driving
    sessionId; without it, the author is the calling human. Mentions
    ('@worker-name' / '@handle'; a multi-word name is
    mentioned by its slug, e.g. '@mary-jane') are extracted server-side at
    write time into the envelope. replyToSeq wires a replies-to edge to the
    cited message. body is capped at 65536 characters.

    Authorization: an AppMember of the App (any role — every member of the
    host is a participant per cor:acl:030:01), an org member with
    CONTRIBUTOR+ on the App's org, or the owner of a user-owned App. Pure
    App-key principals cannot post.

    Spec 049 Phase 8 (item J): the worker-App pin became the host-memory
    write check. A session's Worker authors here when its App is this one,
    OR when the session's on-behalf-of user may write the Channel's host
    memory — a cross-App post records authorAppId. A pure App-key session is
    admitted only on the same-App branch. SESSION_NOT_IN_APP and
    SESSION_WORKER_NOT_IN_APP are retired; CHANNEL_HOST_NOT_WRITABLE is the
    successor code.

    Error codes (extensions.code): TEAM_CHAT_BODY_TOO_LARGE,
    TEAM_CHAT_REPLY_NOT_FOUND, SESSION_NOT_FOUND, SESSION_ENDED,
    SESSION_NOT_LIVE (dormant or ineligible for lapsed-session resume),
    SESSION_NOT_WORKER_BOUND, CHANNEL_HOST_NOT_WRITABLE, WORKER_RETIRED,
    SESSION_EXPIRED (encrypted team memory without an active session key),
    TEAM_AGENT_NOT_FOUND / TEAM_AGENT_AMBIGUOUS (first-post bootstrap could
    not locate the Team Agent), APP_UNINSTALLED, FORBIDDEN (an authenticated
    caller who is not a participant), UNAUTHENTICATED (no principal at all: no
    token, an expired or unverifiable one; checked before the App is resolved,
    so it answers identically whether or not the App exists).

    appRef accepts the entity's ID or URN; sessionRef is the session id.
    """
    createTeamChatMessage(
      appRef: ID!
      body: String!
      replyToSeq: Int
      sessionRef: ID
    ): TeamChatMessage!

    """
    Spec 049 Phase 8 — post into ANY Channel by ref (its id, or its address —
    \`Channel.chatRootUrn\`, #1171): the
    createTeamChatMessage contract (author derivation, mentions, replyToSeq,
    the body cap, item J) addressed by Channel. While TEAM_TAGS_ENABLED (default
    off) a post also carries the sender's team tags, and an invalid
    \`@team.<head>.all\` target refuses the whole post TEAM_CHAT_TEAM_HEAD_INVALID. createTeamChatMessage is the
    appRef → App.defaultChannel convenience over this — one gate, two entry
    points. A Channel you may not read is CHANNEL_NOT_FOUND; one you may read
    but not post into is FORBIDDEN.
    """
    createChannelMessage(
      channelRef: ID!
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
      "Optional explicit model report (#1398). Takes precedence over the session's model; a model switch or a late record should pass the model that actually did the work. Empty string is refused — pass nothing to fall back to the session's model."
      model: String
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
    role does NOT trigger the maxMembers check. The primary installed Agent
    (the oldest AppAgent) supplies this policy; no installed Agent refuses
    OrphanAppError. Only an App member manager may call this: the user-owner,
    an owner-role AppMember, or owning-org ADMIN (including platform admins
    for org-owned Apps). The manager gate runs before target-user lookup.

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
    joins the App as an AppMember without requiring an OrgMember row.
    App lifecycle checks run before the existing-member return and self-join
    policy check.

    #1714: self-join is closed by default. It is open only when the App's
    primary Agent declares installation_policy.selfJoinRole, which must be
    one of its memberRoles and is never "owner"; the joiner gets that role.
    Self-join never assigns owner. Explicit role changes use ensureAppMember,
    by an App member manager. Idempotent — if the user is already an AppMember
    of the App, the existing row is returned, before the gate is consulted.

    Error codes (GraphQLError extensions.code, Error.name style):
      - UNAUTHENTICATED — no logged-in user in context.
      - AppNotFoundError — the App does not exist or is soft-deleted.
      - AppUninstalledError — the App is in the spec-021 soft-uninstall
        lifecycle phase.
      - SelfJoinNotAllowedError — the App's Agent has not opted into
        self-service joining (including an App with no installed Agent).
        Checked before capacity, so it reveals nothing about maxMembers.
      - OrphanAppError — the App lost its installed Agents while the
        join was in flight.
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
        differentiate between a missing/deleted memory and a memory the
        caller does not own — both return FORBIDDEN before grantee lookup.
        An owner of a wrong-class memory (for example private) can pass that
        principal check and receive InvalidMemoryClassForShareError.
      - MemoryShareGranteeMissingError — granteeId doesn't resolve to
        an existing User. Only reachable when the caller passes the
        principal guard.
      - CrossOrgShareNotAllowedError — the grantee is not a member of an
        org-owned personal memory's org (the #778 audience rule above).
      - InvalidMemoryClassForShareError — the principal addressed a memory
        whose class is not personal; private memories cannot be shared.
      - MemoryNotFoundForShareError — retained controller-level lifecycle
        refusal; the ordinary GraphQL principal precheck conceals absence.
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
    Mint a new AppKey for an App. Only whoever manages the App, as themselves
    (hrn:node:hadronmemory.com:specs:cor:dmo:050:05; hrn:node:hadronmemory.com:specs:cor:acl:010:01).
    Never an App key, a bound worker session or an impersonated request; new keys hold no scopes.
    Granting or revoking scopes uses the same manager audience.

    Accepts the entity's ID or URN.
    """
    createAppKey(appRef: ID!, label: String): AppKeyCreated!
    """
    Revoke an AppKey. Only whoever manages the App, as themselves
    (hrn:node:hadronmemory.com:specs:cor:dmo:050:05; hrn:node:hadronmemory.com:specs:cor:acl:010:01).
    Never an App key, a bound worker session or an impersonated request. AppKey has no URN; the id is raw ID-only.
    """
    revokeAppKey(id: ID!): Boolean!
    """
    #1749 — give an App key a scope (hrn:node:hadronmemory.com:specs:cor:aut:010:04). Only whoever manages the App, as
    themselves: never an App key, a worker's session or an impersonation. Granting a scope the key holds changes nothing.
    A new key, and a rotated one, holds none. Unknown scope: BAD_USER_INPUT.
    #1709: host:operate is granted for ONE host, named by hostId (hrn:node:hadronmemory.com:specs:cor:agt:070:04), and
    hostId is refused for any other scope. A key already operating as another host is refused
    APP_KEY_SCOPE_HOST_CONFLICT: revoke host:operate first.
    """
    grantAppKeyScope(id: ID!, scope: String!, hostId: String): AppKey!
    "#1749 — take a scope back. The key's next call is refused. Revoking a scope it does not hold changes nothing."
    revokeAppKeyScope(id: ID!, scope: String!): AppKey!

    """
    025-oauth-for-mcp FR-004: mint a new user-scoped API key for the
    calling User. Returns the raw key exactly once (the server stores
    only the SHA-256 hash). Rejected with UNAUTHENTICATED for AppKey-
    resolved callers (no user in context). Impersonation is refused; an
    MCP-only OAuth credential cannot mint API keys. label is optional and
    limited to 200 JavaScript string code units. Minting from a user API key
    retains its minting-key ancestry and sign-in root; an ended sign-in root
    refuses minting.
    """
    createUserApiKey(label: String): UserApiKeyCreateResult!

    """
    025-oauth-for-mcp FR-004: revoke a user-scoped API key owned by
    the calling User, together with every recorded descendant. Unrelated
    roots and siblings stay live; unknown legacy parents are not inferred.
    Returns the named UserApiKey with its revokedAt. Idempotent for
    already-revoked keys. NOT_FOUND for both unknown and foreign keys;
    UNAUTHENTICATED for AppKey-resolved callers.
    """
    revokeUserApiKey(id: ID!): UserApiKey!

    """
    #2298: hide (or unhide) one of the caller's own REVOKED API keys in the default
    myUserApiKeys list. Hiding an active key is refused with BAD_USER_INPUT,
    reason KEY_ACTIVE, and changes nothing. Idempotent: the first hiddenAt is kept.
    Touches no validity, revocation time, lineage or descendant. Same authority as
    revokeUserApiKey (own user only; unknown and foreign ids are NOT_FOUND).
    """
    setUserApiKeyHidden(id: ID!, hidden: Boolean!): UserApiKey!

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

    # Identity lifecycle — this mutation plus the session group below.
    """
    App Key callers only: vouch for a user, creating (or returning) the User
    this App knows by \`externalId\`. Managing that user's SESSIONS is the
    startAgentSession / endAgentSession pair below, not this call.
    The legacy email argument accepts only empty values; identity addresses
    are established through verified sign-in.
    """
    createAppUser(externalId: String!, handle: String, name: String, email: String): User!

    """
    Multi-user-agent session lifecycle (renamed to avoid collision with
    the developer/guided startSession and endSession mutations).
    Supply a base64-encoded 32-byte key beside the operation through the
    x-hadron-operation-key header when identifyUserMethod is SECRET.
    The key is verified for an existing encrypted memory and held only
    after the new session commits; USER_ID mode rejects key supply.
    Only one key-consuming operation may use the header in a request;
    a second attempt is BAD_UNLOCK_INPUT.
    """
    startAgentSession(
      agentId: ID!
      externalUserId: String
      sessionTimeoutSeconds: Int
    ): Session!
    endAgentSession(sessionId: ID!): Boolean!

    """
    Link this App's live plaintext anonymous memory to a real user.
    Providing x-hadron-operation-key in the request header claims private
    ownership and encrypts live nodes; remaining fields and history complete
    in bounded passes. Only one key-consuming operation may use the header
    per request; a second is BAD_UNLOCK_INPUT. After a committed claim,
    interrupted completion allows the strict owner or owning App key to call
    encryptMemory with the existing key. A registered holding cannot be linked again.

    Accepts the entity's ID or URN.
    """
    linkMemoryToUser(memoryId: ID!, externalUserId: String!): Memory!

    """
    Convert a plaintext PRIVATE memory to encrypted (spec 041, caller-held
    keys). Exactly one of dataKey (base64, 32 bytes) / passphrase (scrypt-
    derived; salt + params stored on the memory, the key itself never).
    First encryption requires the strict owner. The owning App key may only
    complete already-encrypted private memory using its existing dataKey and
    matching verifier; impersonation and sibling Apps grant no authority. Live and
    historical node fields are converted in bounded locked passes. One-way
    without the key: the server cannot recover the content.

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
    """
    #1115 — ALWAYS NULL since 2026-09-04. It used to fire every 20 messages
    and ask the caller to produce a summary, but the summary it asked for is
    replayed to the model as an ordinary user turn beside the messages it
    summarises, so the loop made the transcript longer. Disarmed rather than
    removed: the field is nullable, was absent 19 turns in 20, and every
    caller already handles that. Re-arming needs the design in #1115.
    """
    summarizationNeeded: SummarizationRequest
  }

  """
  Retained for ChatPromptResult.summarizationNeeded, which is currently always
  null (#1115). Kept so the schema does not break clients that still select
  the field.
  """
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

  # ── #1705 Agent tasks (Task Management T1, epic #1704; hrn:node:hadronmemory.com:specs:cor:agt:050) ──────

  """
  An agent task's status (hrn:node:hadronmemory.com:specs:cor:agt:050:02). FINISHED and CANCELLED are the end states.
  BACKLOG (#1754) is parked: no assignee, never matched, never waited on, no alarms; assigning it or making it
  ready moves it to PENDING.
  """
  enum AgentTaskStatus {
    BACKLOG
    PENDING
    STARTED
    FINISHED
    CANCELLED
  }

  "The statuses a task may be CREATED in (#1754, hrn:node:hadronmemory.com:specs:cor:agt:050:02): every other status is reached by a move."
  enum AgentTaskCreateStatus {
    BACKLOG
    PENDING
  }

  "Whether a task party is a team Worker or a person."
  enum AgentTaskPartyKind {
    WORKER
    USER
  }

  """
  A task's owner, assignee or audit actor, as a sanitized projection: the
  Worker's name and URN, or the person's handle. Never the User object, so a
  task never exposes another person's account fields.
  """
  type AgentTaskParty {
    kind: AgentTaskPartyKind!
    id: ID!
    "The Worker's name, or the person's handle."
    name: String
    "The Worker's URN; null for a person."
    urn: String
  }

  """
  Names exactly one task party: a worker of the task's App (its id, URN or
  name), or a person who participates in the App (their user id or handle).
  """
  input AgentTaskPartyInput {
    worker: String
    user: String
  }

  "What the platform's matcher must respect when it chooses an assignee (plan design:agent-tasks section 3.1; consumed by T3)."
  type AgentTaskRequirements {
    role: String
    familyIn: [String!]
    familyNotIn: [String!]
    excludeWorkerIds: [ID!]
  }

  input AgentTaskRequirementsInput {
    role: String
    "Model families the assignee must run as. Give this or familyNotIn, not both."
    familyIn: [String!]
    familyNotIn: [String!]
    "Workers of this App (id, URN or name) the matcher must not pick."
    excludeWorkers: [String!]
  }

  "A finished task's result (hrn:node:hadronmemory.com:specs:cor:agt:050:01)."
  type AgentTaskResult {
    "One word: succeeded, failed, or a word the team chooses."
    outcome: String!
    summary: String
    "A URL or a node URN."
    evidence: String
  }

  input AgentTaskResultInput {
    "One word (letters, digits, underscore, hyphen or dot; up to 64 characters), e.g. succeeded or failed. It is copied into the event stream, which never holds free text."
    outcome: String!
    summary: String
    evidence: String
  }

  "#2068 (hrn:node:hadronmemory.com:specs:cor:agt:080:01, :10) — why a ticker fires. A closed set; several fire it when any one holds."
  enum TickerReason {
    "Fires only when the subscriber has relevant unread in the ticker's channels (what relevance counts is the ticker's relevance)."
    READ_TEAM_CHANNEL
    "Fires on every tick, with or without unread. The floor, budget, pause and dormancy still apply."
    EVERY_TICK
    "#2138: fires when the subscriber has not checked its team channel within the ticker's cadence, whatever is unread, and never for a worker not expected to check (no task, isolated, paused, or a team pause)."
    LIVE_CHECK
  }

  "#1747 — how a ticker relevance narrows what can make a subscriber due (hrn:node:hadronmemory.com:specs:cor:agt:080:01)."
  enum TickerRelevance {
    ALL
    MENTIONS
  }

  "#1747 — whether a mention wakes a worker at once. There is no ON_TICK mode."
  enum MentionWake {
    IMMEDIATE
    OFF
  }

  "#1747 — the closed list of named App grants."
  enum AppGrantName {
    "Subscribe and unsubscribe OTHER workers of the App, at any cadence."
    TICKER_SUBSCRIBE_WORKERS
  }

  enum DueWakeStatus {
    OK
    "The App's daily wake budget is spent; the withheld wakes stay due (hrn:node:hadronmemory.com:specs:cor:agt:080:15)."
    WAKE_BUDGET_EXHAUSTED
  }

  enum WakeKind {
    MENTION
    TICK
    "#1708 — a task event the worker must act on (an assignment, a child's finish, an alarm's woken position, #1709 a request to end its session). Wakes at once, like a mention."
    TASK
    "#2022 — a stop-signal notice (hrn:node:hadronmemory.com:specs:cor:agt:090:04): ahead of everything else, past the floor, the busy delay and the budget's refusal. Offered only to a dueWakes call that lists STOP in accepts (#2169)."
    STOP
  }

  "#1708 — which task event a TASK reason is for."
  enum TaskWakeEvent {
    ASSIGNED
    REASSIGNED
    "The platform's matcher assigned it (hrn:node:hadronmemory.com:specs:cor:agt:060:06)."
    MATCHED
    "A child task finished; the reason names the child (hrn:node:hadronmemory.com:specs:cor:agt:050:16)."
    CHILD_FINISHED
    "An unacknowledged alarm's currently-woken chain position (hrn:node:hadronmemory.com:specs:cor:agt:050:19). Delivering it never acknowledges the alarm."
    ALARM
    "#1709 — the task was cancelled and asks its assignee to end its session (hrn:node:hadronmemory.com:specs:cor:agt:050:10). Due while that session is open and the platform has not yet ended it through a host."
    END_SESSION
  }

  "#1708 — the task a TASK reason is for: shown only to a caller who may read the App's tasks (hrn:node:hadronmemory.com:specs:cor:agt:050:21)."
  type DueTaskReason {
    "The task's id (for CHILD_FINISHED, the child's)."
    id: ID!
    "The event delivered; acknowledging the wake records delivery on it."
    eventId: ID!
    "0, or the alarm chain position woken."
    chainIndex: Int!
    event: TaskWakeEvent!
    "The task's title, for the nudge text."
    title: String!
    "A stable label for the reason, e.g. TASK:<id>:assigned."
    ref: String!
    "S7 (#2023, R90) — on an assignment to a worker that was on standby: how many messages were held from it and passed by the delivered mark. Returned with this one event, so once."
    standbyHeld: Int
  }

  "#1748 — one page of due wakes. Counts and ranges only (hrn:node:hadronmemory.com:specs:cor:agt:080:23)."
  type DueWakePage {
    status: DueWakeStatus!
    "Wakes held back by the daily budget; each stays due."
    withheld: Int!
    wakes: [DueWake!]!
    "Dormant workers with relevant mentions, and how many: withheld, never dropped silently."
    dormant: [DormantWithheld!]!
    pageInfo: DueWakePageInfo!
  }

  "#2017 (S1) — one page of delivery batches."
  type DeliveryBatchPage {
    batches: [DeliveryBatch!]!
    pageInfo: DueWakePageInfo!
  }

  "One ready-to-type delivery for one worker. The id is a signed proof bound to the key, the host and the rendered ranges: hand it back to acknowledgeDeliveryBatches after typing."
  type DeliveryBatch {
    id: String!
    worker: Worker!
    "The whole delivery, one line, written by the server (hrn:node:hadronmemory.com:specs:cor:agt:080:26). Type it unchanged."
    text: String!
    "Not before this moment (the batching window / busy deadline of the oldest waiting message)."
    deliverAfter: DateTime!
    "The latest moment a busy worker may be made to wait for this delivery."
    busyDeadline: DateTime!
    "Always false until stop signals ship (S6)."
    interrupt: Boolean!
    ranges: [DeliveryBatchRange!]!
    "Eligible messages left for the next batch."
    overflow: Int!
  }

  input BatchThrough {
    channelId: ID!
    "A seq this batch rendered in that channel."
    seq: Int!
  }

  type DeliveryBatchRange {
    channel: Channel!
    incarnation: Int!
    fromSeq: Int!
    throughSeq: Int!
    "Exactly the message seqs this batch rendered."
    seqs: [Int!]!
  }

  type DueWakePageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  "One merged wake: every reason, one seq range per channel. A wake never moves a read position."
  type DueWake {
    worker: Worker!
    reasons: [WakeReason!]!
    channels: [DueChannel!]!
    unread: Int!
    unreadMentions: Int!
    "Carried, never an exclusion (hrn:node:hadronmemory.com:specs:cor:agt:060:02)."
    availability: DueWakeAvailability
    "Hand this back to acknowledgeWakes after delivering. Bound to the requester; good for 15 minutes."
    proof: String!
    """
    #2017 R63 — when the earliest waiting reason became due: a mention's first still-due post, a tick's OLDEST unacknowledged
    tick time, a task event's time. Never restarted by a re-offer or a join (hrn:node:hadronmemory.com:specs:cor:agt:080:27).
    """
    anchorAt: DateTime!
    "Not before this moment: the anchor plus the App's batching window (the shared cadence floor)."
    deliverAfter: DateTime!
    "The latest a busy worker may be made to wait: the anchor plus the App's busy delay."
    busyDeadline: DateTime!
  }

  type DueWakeAvailability {
    state: String!
    reason: String
    until: DateTime
    setAt: DateTime!
  }

  type DueChannel {
    channel: Channel!
    fromSeq: Int!
    throughSeq: Int!
    latestMentionSeq: Int
  }

  type DormantWithheld {
    worker: Worker!
    mentions: Int!
  }

  type WakeReason {
    kind: WakeKind!
    ticker: Ticker
    "Set for kind TASK."
    task: DueTaskReason
    "#2022 — set for kind STOP."
    stop: DueStopReason
  }

  "#2022 — whether a stop notice tells the worker to stop or that it may resume."
  enum StopNoticeKind {
    STOP
    RESUME
  }

  "#2022 — the stop-signal notice a STOP reason delivers. Acknowledging the wake records its delivery; it moves no chat mark."
  type DueStopReason {
    "The notice; acknowledging the wake records delivery on it."
    eventId: ID!
    signalId: ID!
    level: StopSignalLevel!
    notice: StopNoticeKind!
    "True only for a halt's stop notice: the one notice that interrupts the worker."
    interrupt: Boolean!
  }

  "#2022 (hrn:node:hadronmemory.com:specs:cor:agt:090:01) — a stop signal's level. Each stops everything the one before it does."
  enum StopSignalLevel {
    "Stops assignment only: matching skips the covered workers and a manual assignment to one is refused (TASK_STOPPED). Its coordinators are told, by a consumer that has declared their lane (a set is refused until one has)."
    PAUSE_DISPATCH
    "Also stops ticks and stall time. Each covered worker is told to finish or stop at its next sub-task, by a consumer that has declared its lane (a set is refused until one has)."
    PAUSE
    "Also tells each covered worker to save its work and write a hand-off now. The notice is typed as an ordinary message into a verified-empty input, with no interrupt key (Holger, option A, 2026-10-24); one that cannot be typed is logged and flagged to the coordinator."
    HALT
  }

  "#2022 — a stop signal's scope: one worker, a team (its head and the whole reporting tree under it), or the workers a host registration lists."
  enum StopSignalScope {
    WORKER
    TEAM
    HOST
  }

  enum StopSignalEndKind {
    LIFTED
    EXPIRED
  }

  "#2022 (hrn:node:hadronmemory.com:specs:cor:agt:090:01) — a stop signal. Ids and times only; it never changes once set, except that its end is recorded."
  type StopSignal {
    id: ID!
    level: StopSignalLevel!
    scope: StopSignalScope!
    "WORKER and TEAM: the target worker (a team by its head)."
    targetWorkerId: ID
    "HOST: the target host's id."
    targetHostId: String
    setAt: DateTime!
    "When it ends on its own, if set to."
    until: DateTime
    "The person who set it; null when a host key did."
    setByUserId: ID
    setByHostKey: Boolean!
    "Not ended and its until, when given, still ahead."
    live: Boolean!
    "When it was lifted, or its until (an expiry is in effect at its until)."
    endedAt: DateTime
    endKind: StopSignalEndKind
    endedByUserId: ID
    endedByHostKey: Boolean!
  }

  type StopSignalPage {
    signals: [StopSignal!]!
    pageInfo: DueWakePageInfo!
  }

  type LiftStopSignalResult {
    signal: StopSignal!
    "False when it had already ended: nothing changed and nobody was told again."
    changed: Boolean!
  }

  input SetTeamStopSignalInput {
    appRef: String!
    level: StopSignalLevel!
    scope: StopSignalScope!
    "WORKER and TEAM: the target worker (a team by its head)."
    worker: String
    "HOST: the host's id. A host key may omit it: its own host is taken from its binding."
    host: String
    "When it ends on its own; later than now. Omitted: until lifted."
    until: DateTime
  }

  type AcknowledgeWakesResult {
    "Wakes that moved the delivery record."
    acknowledged: Int!
    "Repeats: already delivered, counted nowhere twice."
    unchanged: Int!
  }

  "#1747 — whether the team-chat post for a grant use went out."
  enum GrantAnnouncement {
    POSTED
    FAILED
  }

  "#1747 — why a subscription ended. Never dormancy."
  enum TickerSubscriptionEndReason {
    UNSUBSCRIBED
    WORKER_RETIRED
    TICKER_DELETED
  }

  "#2213 — one page of tickers; hasMore is whether rows remain past it."
  type TickerPage {
    items: [Ticker!]!
    total: Int!
    hasMore: Boolean!
  }

  "#2212 — one page of a node's revision snapshots, counted over the snapshots the caller may read."
  type NodeRevisionPage {
    items: [NodeRevision!]!
    total: Int!
    hasMore: Boolean!
  }

  "#2212 — one page of sessions in the caller's session scope."
  type SessionPage {
    items: [Session!]!
    total: Int!
    hasMore: Boolean!
  }

  "#2212 — one page of usage events in the caller's readable memories."
  type UsageEventPage {
    items: [UsageEvent!]!
    total: Int!
    hasMore: Boolean!
  }

  "#2213 — one page of an org's exchange connections."
  type ExchangeConnectionPage {
    items: [ExchangeConnection!]!
    total: Int!
    hasMore: Boolean!
  }

  "#2213 — one page of the caller's saved widget presets."
  type DashboardWidgetPresetPage {
    items: [DashboardWidgetPreset!]!
    total: Int!
    hasMore: Boolean!
  }

  """
  #2024 — one ticker an Agent declares. Casting a worker from the Agent into an App creates the worker's tickers from the live
  templates and subscribes it, in the cast's own transaction. A SNAPSHOT: a later edit or removal reaches only future casts;
  existing workers and tickers are untouched. Identity is the id, never the name or the position. The cadence is the requested
  one; the cast raises it to the App's floor. Reasons are never empty.
  """
  type AgentTickerTemplate {
    id: ID!
    agent: Agent!
    "Counts edits; an update or delete must name the revision it saw, and a stale one is refused with TICKER_TEMPLATE_REVISION_MISMATCH."
    revision: Int!
    "The shape of this record. Only 1 exists."
    shapeVersion: Int!
    name: String!
    cadenceSeconds: Int!
    "A timezone and weekly windows; null when none."
    quietHours: JSON
    relevance: TickerRelevance!
    reasons: [TickerReason!]!
    createdAt: DateTime!
    updatedAt: DateTime
  }

  input AgentTickerTemplateInput {
    name: String!
    cadenceSeconds: Int!
    quietHours: JSON
    relevance: TickerRelevance
    "Absent = [READ_TEAM_CHANNEL]; an empty list is refused."
    reasons: [TickerReason!]
  }

  "Absent fields are unchanged. Use clearQuietHours to remove the quiet hours."
  input AgentTickerTemplatePatch {
    name: String
    cadenceSeconds: Int
    quietHours: JSON
    clearQuietHours: Boolean
    relevance: TickerRelevance
    "An empty list is refused."
    reasons: [TickerReason!]
  }

  """
  #1747 — a named wake schedule owned by one team App (hrn:node:hadronmemory.com:specs:cor:agt:080:01). Its URN is hrn:ticker:ROOT:APP-SLUG:SLUG,
  computed from the App and the permanent slug. Ticks are computed, not stored; nothing reads a ticker until due wakes ship.
  """
  type Ticker {
    id: ID!
    "The canonical URN. Null when it cannot be composed."
    urn: String
    name: String!
    "Permanent: a re-created name gets a new slug (engineering-2)."
    slug: String!
    app: App!
    cadenceSeconds: Int!
    anchorAt: DateTime!
    "A timezone and weekly windows; null when none."
    quietHours: JSON
    "The channels named, limited to those the reader can read. Empty means every channel the subscriber watches."
    channels: [Channel!]!
    relevance: TickerRelevance!
    "#2068 — why the ticker fires. Never empty; existing tickers are READ_TEAM_CHANNEL."
    reasons: [TickerReason!]!
    enabled: Boolean!
    owner: ActorRef
    "The next moment this ticker ticks, quiet hours skipped; null when disabled."
    nextTickAt: DateTime
    "The moment of the current tick; null when none has fired or it cannot tick."
    lastTickAt: DateTime
    "Live subscriptions."
    subscribers(first: Int, after: String): TickerSubscriptionPage!
    createdAt: DateTime!
    updatedAt: DateTime
  }

  type TickerSubscriptionPage {
    items: [TickerSubscription!]!
    hasNextPage: Boolean!
    endCursor: String
  }

  "#1747 — a worker subscription to one ticker (hrn:node:hadronmemory.com:specs:cor:agt:080:02)."
  type TickerSubscription {
    id: ID!
    ticker: Ticker!
    worker: Worker!
    "Who subscribed the worker."
    createdBy: ActorRef
    "True when made through the may-subscribe-workers grant."
    viaGrant: Boolean!
    createdAt: DateTime!
    endedAt: DateTime
    endedReason: TickerSubscriptionEndReason
  }

  type SubscribeResult {
    subscription: TickerSubscription!
    "Set only when the call used the grant: whether the team-chat post went out."
    announcement: GrantAnnouncement
  }

  "#1747 — a worker wake settings (hrn:node:hadronmemory.com:specs:cor:agt:080:03)."
  type WorkerWakeSettings {
    worker: Worker!
    mentions: MentionWake!
    "A pause belongs to the worker, not to a session."
    pausedUntil: DateTime
    "Live subscriptions."
    subscriptions: [TickerSubscription!]!
    "The fastest live subscription on an enabled ticker; null when none."
    effectiveCadenceSeconds: Int
    "None of the worker's sessions has had activity within the App's dormancy period (hrn:node:hadronmemory.com:specs:cor:agt:080:07). A dormant worker is never woken."
    dormant: Boolean!
    "S7 (#2023, R85) — isolation is its own state, never pausedUntil. While live the worker gets no chat batches or ordinary wakes and is not matched."
    isolatedUntil: DateTime
    isolatedAt: DateTime
    "The handle of the person who set it: only a person managing the App or holding the worker, acting as themselves, can."
    isolatedByHandle: String
    "Live: isolatedUntil is in the future."
    isolated: Boolean!
  }

  "#2138: the App's team pause. teamPausedAt is null when the team is not paused."
  type TeamPause {
    teamPausedAt: DateTime
  }

  "Delivery timing per App. Busy/stuck bounds and relation are Proposed (hrn:node:hadronmemory.com:specs:cor:agt:080:05)."
  type AppDeliverySettings {
    "The existing ticker cadence floor and wake-rate ceiling, also the batching window. Changing it affects ticker cadence. DEPRECATED (#2138): push batching is superseded by channel checks; kept readable, no new consumer."
    batchWindowSeconds: Int!
    "Whole seconds, 1..86400; default 600. DEPRECATED (#2138): superseded by channel checks."
    busyDelaySeconds: Int!
    "Whole seconds, 1..604800; default 900. Must exceed busy delay plus batch window. DEPRECATED (#2138): superseded by channel checks."
    stuckWindowSeconds: Int!
    "#2138: a worker with a task is expected to check its team channel every period. Whole seconds, 60..86400; default 600. Set together with the team ticker's cadence."
    checkPeriodSeconds: Int!
    "#2138: a worker with a task is OVERDUE after this many missed periods plus 5 minutes. Whole number, 1..100; default 2."
    failedChecksToOverdue: Int!
    "Stored configuration; default false. Enabling is refused until standby behavior ships."
    standbyEnabled: Boolean!
    "False until S7 supplies standby behavior; configuration alone has no effect."
    standbyEffective: Boolean!
  }

  "Atomic patch: omit to preserve, explicit null refuses. Empty patch returns the current authorized settings."
  input AppDeliverySettingsInput {
    "Shared ticker floor/window; existing floor, self-cadence and live-ticker limits apply."
    batchWindowSeconds: Int
    busyDelaySeconds: Int
    stuckWindowSeconds: Int
    standbyEnabled: Boolean
    "#2138: whole seconds, 60..86400."
    checkPeriodSeconds: Int
    "#2138: whole number, 1..100."
    failedChecksToOverdue: Int
  }

  "#1747 — an App ticker settings (hrn:node:hadronmemory.com:specs:cor:agt:080:05)."
  type AppTickerSettings {
    minCadenceSeconds: Int!
    selfSubscribeCadenceSeconds: Int!
    liveCap: Int!
    dailyWakeBudget: Int!
    "True when the budget is derived from the roster rather than set."
    dailyWakeBudgetDerived: Boolean!
  }

  "#1747 — a narrow, named permission held by one worker (hrn:node:hadronmemory.com:specs:cor:agt:080:24)."
  type AppGrant {
    id: ID!
    app: App!
    worker: Worker!
    name: AppGrantName!
    grantedAt: DateTime!
    revokedAt: DateTime
  }

  input TickerInput {
    name: String!
    cadenceSeconds: Int!
    "Tick counting starts here. Defaults to now."
    anchorAt: DateTime
    quietHours: JSON
    channelIds: [ID!]
    relevance: TickerRelevance
    "Absent on create = [READ_TEAM_CHANNEL]; an empty list is refused. On update, absent = unchanged."
    reasons: [TickerReason!]
    enabled: Boolean
  }

  "Absent fields are unchanged. Use clearQuietHours / clearChannels to remove those."
  input TickerPatch {
    name: String
    cadenceSeconds: Int
    anchorAt: DateTime
    quietHours: JSON
    clearQuietHours: Boolean
    channelIds: [ID!]
    clearChannels: Boolean
    relevance: TickerRelevance
    "Absent on create = [READ_TEAM_CHANNEL]; an empty list is refused. On update, absent = unchanged."
    reasons: [TickerReason!]
    enabled: Boolean
  }

  input AppTickerSettingsInput {
    minCadenceSeconds: Int
    selfSubscribeCadenceSeconds: Int
    liveCap: Int
    wakeDailyBudget: Int
    "Return to the derived budget."
    clearWakeDailyBudget: Boolean
  }

  input WorkerWakeSettingsInput {
    mentions: MentionWake
    pausedUntil: DateTime
    clearPause: Boolean
  }

  """
  One piece of work a team App has assigned, or wants assigned
  (hrn:node:hadronmemory.com:specs:cor:agt:050:01). The platform records who holds it, since when and how it
  ended; it never reads what the work is. Readable by the App's participants,
  workers acting through their sessions included (hrn:node:hadronmemory.com:specs:cor:agt:050:21).
  """
  type AgentTask {
    id: ID!
    appId: ID!
    title: String!
    description: String
    "Opaque origin reference (an issue URL, a node URN). Not interpreted."
    source: String
    "Null for a root task."
    parentTaskId: ID
    owner: AgentTaskParty!
    "Null while the task is queued."
    assignee: AgentTaskParty
    requirements: AgentTaskRequirements
    status: AgentTaskStatus!
    "Derived (hrn:node:hadronmemory.com:specs:cor:agt:050:03): pending with no assignee. Never stored."
    queued: Boolean!
    "Derived (hrn:node:hadronmemory.com:specs:cor:agt:050:04): started with at least one pending or started child task. Never stored."
    waitingOnChildren: Boolean!
    startBy: DateTime
    startedAt: DateTime
    finishedAt: DateTime
    cancelledAt: DateTime
    "Set only on a finished task."
    result: AgentTaskResult
    tags: [String!]!
    """
    Whether finishing or cancelling asks the assignee to end its worker session
    (hrn:node:hadronmemory.com:specs:cor:agt:050:10). Set by whoever assigns. #1709: carried out; see sessionEndRequest.
    """
    closeSessionWhenDone: Boolean!
    """
    #1709 — the request this task's finish or cancellation made that its worker assignee end its session
    (hrn:node:hadronmemory.com:specs:cor:agt:050:10); null when none was made (closeSessionWhenDone false, a person
    assignee, or no open session). A worker that finishes its own task reads it here: end the session, with a handoff,
    before dueAt, or the platform ends it through a live host.
    """
    sessionEndRequest: AgentTaskSessionEndRequest
    assignedAt: DateTime
    assignedBy: AgentTaskParty
    createdAt: DateTime!
    createdBy: AgentTaskParty
    "The headless run that created the task (hrn:node:hadronmemory.com:specs:cor:agt:050:06); then createdBy is null."
    createdByRunId: ID
    updatedAt: DateTime
  }

  "#1709 — a task's request that its assignee end its session (hrn:node:hadronmemory.com:specs:cor:agt:050:10)."
  type AgentTaskSessionEndRequest {
    "The session asked to end: only this one is ever ended, never a later replacement."
    sessionId: ID!
    requestedAt: DateTime!
    "When the App's grace runs out (default 10 minutes after the request)."
    dueAt: DateTime!
    "Null while open; else ENDED (the session ended), END_ISSUED (the platform issued worker.end through a live host) or NO_LIVE_HOST (nothing more happens)."
    resolution: AgentTaskSessionEndResolution
    resolvedAt: DateTime
    "The worker.end operation the platform issued (END_ISSUED)."
    operationId: ID
  }

  enum AgentTaskSessionEndResolution {
    ENDED
    END_ISSUED
    NO_LIVE_HOST
  }

  """
  One append-only record of something that happened in a team App's task work
  (hrn:node:hadronmemory.com:specs:cor:agt:050:11). Never changed or removed; an alarm's acknowledgement is the
  one thing added later. payload carries ids, counts and outcome words only,
  never message or description text.
  """
  type AgentTeamEvent {
    id: ID!
    appId: ID!
    "e.g. task.created, task.assigned, task.reassigned, task.started, task.progress, task.finished, task.cancelled; the alarms stall.not-started, stall.no-progress, stall.owner-unreactive, assignment.unassignable; availability.changed; assignment.queued, assignment.matched (the platform's assignment, hrn:node:hadronmemory.com:specs:cor:agt:060:06); host.registered, host.lost; host.operation.succeeded, host.operation.failed (hrn:node:hadronmemory.com:specs:cor:agt:070:02)."
    type: String!
    taskId: ID
    "Who acted: the Worker when the request was bound to a worker session, else the person."
    actor: AgentTaskParty
    "#1833 — the headless run that acted, when a run made this event (actor is then null: a run is never a person or a worker). Null otherwise. Matches AgentTask.createdByRunId for the task a run created."
    actorRunId: ID
    "The worker the event concerns, e.g. a new assignee."
    subjectWorker: AgentTaskParty
    "ALARM for an alarm; null for an ordinary event."
    severity: AgentTeamEventSeverity
    "Alarms only: the owner chain when the alarm was raised, nearest first."
    chain: JSON
    acknowledgedBy: AgentTaskParty
    acknowledgedAt: DateTime
    payload: JSON!
    createdAt: DateTime!
    """
    #1706 — stall alarms only: when the stall episode began (hrn:node:hadronmemory.com:specs:cor:agt:050:13),
    the instant of the move that began the condition. One alarm per task,
    rule and episodeStart.
    """
    episodeStart: DateTime
    "#1706 — alarms only: who the alarm wakes and when, nearest owner first (hrn:node:hadronmemory.com:specs:cor:agt:050:19). Null for an ordinary event."
    wakes: [AgentTeamAlarmSchedule!]
  }

  enum AgentTeamEventSeverity {
    ALARM
  }

  """
  #1706 — one owner in an alarm's chain, and when the alarm wakes them
  (hrn:node:hadronmemory.com:specs:cor:agt:050:19). The nearest owner is woken when the alarm is raised; owner
  i falls due i windows later, and is woken only while the alarm is
  unacknowledged (hrn:node:hadronmemory.com:specs:cor:agt:050:20). This is the platform's record that the owner
  is due a wake-up; delivering it is the heartbeat slice's.
  """
  type AgentTeamAlarmSchedule {
    "The owner's position in the chain, 0 for the nearest."
    chainIndex: Int!
    owner: AgentTaskParty
    dueAt: DateTime!
    "Null until woken; stays null on an alarm acknowledged before it fell due."
    wokenAt: DateTime
  }

  enum AvailabilityState {
    AVAILABLE
    UNAVAILABLE
  }

  "Why a worker or a model family is unavailable for work (hrn:node:hadronmemory.com:specs:cor:agt:060:02; held was dropped, team chat #7449)."
  enum AvailabilityReason {
    STALLED
    OUT_OF_TOKENS
    HOST_DOWN
    OTHER
    "#2162 — a context reset is in progress (hrn:node:hadronmemory.com:specs:cor:agt:050:27). Set only by the platform; no caller sets it."
    RESETTING
  }

  "Who set a worker's availability (hrn:node:hadronmemory.com:specs:cor:agt:060:08)."
  enum AvailabilitySetter {
    "The worker itself; only ever to unavailable."
    WORKER
    "The person holding the worker's name."
    HOLDER
    "Whoever manages the App."
    APP_MANAGER
    "#1759 — the worker it reports to directly, clearing a mark the stall rule set (hrn:node:hadronmemory.com:specs:cor:agt:060:11): only to AVAILABLE."
    REPORTS_TO
    "The stall rule (hrn:node:hadronmemory.com:specs:cor:agt:060:07): an alarm marked it, or its next activity cleared it."
    STALL_RULE
    "A host that registered the worker (the host-operations slice)."
    HOST
    "#1766 — the platform, recording that an until passed (hrn:node:hadronmemory.com:specs:cor:agt:060:02): the record is then AVAILABLE, set at the instant it lapsed."
    LAPSE
    "#2162 — the platform's context reset (hrn:node:hadronmemory.com:specs:cor:agt:050:27): it set RESETTING, or released it."
    CONTEXT_RESET
  }

  """
  #1706 — one worker's availability for work (hrn:node:hadronmemory.com:specs:cor:agt:060:02). A worker with
  no record is available.
  """
  type WorkerAvailability {
    worker: AgentTaskParty!
    state: AvailabilityState!
    "Set exactly when unavailable."
    reason: AvailabilityReason
    "When an unavailable record lapses. A passed until reads as available at once; within a minute the record is rewritten to AVAILABLE, set by LAPSE, and one availability.changed event records it (hrn:node:hadronmemory.com:specs:cor:agt:060:02)."
    until: DateTime
    setAt: DateTime!
    setBy: AvailabilitySetter!
    "#1709 — the host that set it, when setBy is HOST."
    setByHostId: String
    "Who acted, when a worker or a person set it; null when the stall rule or a lapse did."
    setByParty: AgentTaskParty
    """
    Whether this record makes the worker unavailable right now: unavailable,
    not lapsed, and (for STALLED) the worker has not acted since it was set
    (hrn:node:hadronmemory.com:specs:cor:agt:060:07).
    """
    inEffect: Boolean!
  }

  "#1709 — a host's registration (hrn:node:hadronmemory.com:specs:cor:agt:070:01)."
  type HostRegistration {
    "The host's id within its App: the one its key's host:operate scope names."
    hostId: String!
    label: String!
    pollIntervalSeconds: Int!
    registeredAt: DateTime!
    refreshedAt: DateTime!
    "Refreshed within the App's lapse count of its poll intervals, now."
    live: Boolean!
    "#2162 — the capability-gated operation types this host declared it performs (hrn:node:hadronmemory.com:specs:cor:agt:070:01, Proposed): worker.reset-context. A host is never issued one it did not declare."
    capabilities: [String!]!
    workers: [HostRegistrationWorker!]!
  }

  "#1709 — a worker a host can launch: the family it would run as, and its existing worktrees there."
  type HostRegistrationWorker {
    workerId: ID!
    worker: Worker
    family: String!
    worktrees: [String!]!
  }

  "#1709 — a host operation's status (hrn:node:hadronmemory.com:specs:cor:agt:070:02; COLLECTED is #1709's, Proposed)."
  enum HostOperationStatus {
    ISSUED
    COLLECTED
    SUCCEEDED
    FAILED
  }

  "#1709 — who issued a host operation."
  enum HostOperationIssuer {
    USER
    WORKER
    PLATFORM
  }

  "#1709 — a host's report: done, or failed with a reason."
  enum HostOperationOutcome {
    SUCCEEDED
    FAILED
  }

  """
  #1709 — one typed operation issued to one host (hrn:node:hadronmemory.com:specs:cor:agt:070:02, :03). type is one of
  worktree.create, worker.start, worker.deliver, worker.end, worktree.remove, worker.reset-context; args are its typed
  arguments (ids and name tokens only, never a command): worktree.create {workerId, repo, baseBranch, branchName,
  label}; worker.start {workerId, worktree, family, taskId?}; worker.deliver {workerId, sessionId, eventId}; worker.end
  {workerId, sessionId}; worktree.remove {workerId, worktree}; worker.reset-context {workerId, sessionId, taskId,
  resetId} (#2162). The per-type arguments are #1709's design, Proposed.
  """
  type HostOperation {
    id: ID!
    appId: ID!
    hostId: String!
    type: String!
    args: JSON!
    workerId: ID!
    worker: Worker
    status: HostOperationStatus!
    issuedBy: HostOperationIssuer!
    issuedByUserId: ID
    issuedByWorkerId: ID
    issuedAt: DateTime!
    collectedAt: DateTime
    finishedAt: DateTime
    "A success's typed result: {worktree} for worktree.create."
    result: JSON
    "Why it failed, as the host said it."
    failureReason: String
    """
    #1709 — worker.start only, and only in collectHostOperations' answer: the single-use launch grant to pass to the
    agent the host starts (it redeems it at startSession with its holder's own token). Short-lived; never stored in clear
    and never shown again. #1928: while it is live, a re-collection leaves the start out of the answer; once it expires,
    the next collection revokes it and delivers the start with a fresh one; once redeemed, the start is delivered with
    null here, so a restarted host can still report it. Null everywhere else.
    """
    launchGrant: String
  }

  type HostOperationPage {
    items: [HostOperation!]!
    hasNextPage: Boolean!
    "Pass as after for the next page."
    endCursor: String
  }

  input RegisterHostWorkerInput {
    "The worker: its id, URN or name within the App."
    worker: String!
    "The model family it would run as here, e.g. claude or codex."
    family: String!
    "Its existing worktrees on this host, as the host names them (at most 32 name tokens)."
    worktrees: [String!]
  }

  input RegisterHostInput {
    appRef: String!
    label: String!
    "How often the host checks in; it lapses after the App's count of these without one."
    pollIntervalSeconds: Int!
    "The whole list: it replaces the last registration's."
    workers: [RegisterHostWorkerInput!]
    "#2162 — the capability-gated operation types this host performs, in full at every refresh: worker.reset-context. Omitted means none. Anything else is BAD_HOST_REGISTRATION."
    capabilities: [String!]
  }

  "#2162 — the agent process a host observed: its pid and the kernel's start time for it (a token)."
  input ObservedProcessInput {
    pid: Int!
    startTime: String!
  }

  "#2162 — a context reset step: the reset and the epoch the host holds (0 until claimed)."
  input ContextResetStepInput {
    appRef: String!
    resetId: ID!
    epoch: Int!
  }

  input ClaimContextResetInput {
    appRef: String!
    resetId: ID!
    "The epoch the reset was collected at: 0."
    epoch: Int!
    "The agent process the host observed idle, which a later stop must still match."
    process: ObservedProcessInput!
  }

  input RegisterContextResetRecoveryInput {
    appRef: String!
    resetId: ID!
    epoch: Int!
    "The checkpoint node the host wrote: its id or full URN, in the worker's own working memory."
    checkpointNode: String!
    "The reset's own session and task."
    sessionId: ID!
    taskId: ID!
  }

  input AuthorizeContextResetStopInput {
    appRef: String!
    resetId: ID!
    epoch: Int!
    "The agent process about to be stopped: the one the claim observed."
    process: ObservedProcessInput!
  }

  input ReportContextResetRelaunchedInput {
    appRef: String!
    resetId: ID!
    epoch: Int!
    "The relaunched agent process."
    process: ObservedProcessInput!
  }

  input ReportContextResetRelaunchFailedInput {
    appRef: String!
    resetId: ID!
    epoch: Int!
    "CHECKPOINT_FAILED, STAGING_FAILED, RELAUNCH_UNVERIFIED or RELAUNCH_BLOCKED."
    reason: String!
  }

  """
  #2162 — a worker's context reset (hrn:node:hadronmemory.com:specs:cor:agt:050:27): a shed, never a session end. One per
  task at most. phase is requested, claimed, checkpointed, stop-granted, agent-stopped, relaunched, done, refused or
  failed; reason names why a reset was refused or failed, from a closed set. epoch moves at the claim and at every
  cancellation: a host step naming another is STALE_EPOCH.
  """
  type ContextReset {
    id: ID!
    appId: ID!
    workerId: ID!
    sessionId: ID!
    taskId: ID!
    hostId: String
    hostOperationId: ID
    phase: String!
    reason: String
    epoch: Int!
    requestedAt: DateTime!
    claimedAt: DateTime
    recoveryRegisteredAt: DateTime
    "When the single stop was granted; the host may act on it only within stopLeaseMs of its own send time."
    stopGrantedAt: DateTime
    stopLeaseMs: Int
    agentStoppedAt: DateTime
    relaunchedAt: DateTime
    "When a cancellation found a stop lease outstanding: the resetting mark lifts no earlier than this."
    releasePendingAt: DateTime
    endedAt: DateTime
  }

  "#2162 — what a context reset step answered."
  type ContextResetStep {
    reset: ContextReset!
    "This step refused or failed the reset, and why; the reset has ended. Null when the step was accepted."
    refused: String
    "The step had already been made: the recorded answer is returned, nothing changed."
    replayed: Boolean!
  }

  input ReportHostOperationInput {
    appRef: String!
    id: ID!
    outcome: HostOperationOutcome!
    "worktree.create's success only: the worktree it created."
    worktree: String
    "FAILED only: why, 1 to 2000 characters."
    failureReason: String
  }

  input SetHostWorkerAvailabilityInput {
    appRef: String!
    "A worker this host registers: its id, URN or name within the App."
    worker: String!
    state: AvailabilityState!
    "UNAVAILABLE only: OUT_OF_TOKENS or HOST_DOWN."
    reason: AvailabilityReason
    "Optional, UNAVAILABLE only, in the future."
    until: DateTime
  }

  input IssueHostOperationInput {
    appRef: String!
    "The registered host to run it."
    hostId: String!
    "The worker it is for: its id, URN or name within the App."
    worker: String!
    "One of the closed set; see HostOperation."
    type: String!
    "The type's arguments, without workerId (taken from worker)."
    args: JSON
  }

  "#1706 — one model family's availability for work in one App (hrn:node:hadronmemory.com:specs:cor:agt:060:03). A family with no record is available."
  type ModelFamilyAvailability {
    appId: ID!
    "The model family, e.g. claude or codex (hrn:node:hadronmemory.com:specs:cor:agt:060:04)."
    family: String!
    state: AvailabilityState!
    reason: AvailabilityReason
    until: DateTime
    setAt: DateTime!
    setBy: AgentTaskParty
    "Unavailable and not lapsed."
    inEffect: Boolean!
  }

  """
  #1707 — a worker's derived state on the team roster (plan
  design:agent-tasks §7.4). Plan-derived, not a spec. A worker can be in
  several at once; it is shown in the first that holds, in this order.
  """
  enum TeamRosterState {
    "Woken on an unacknowledged alarm (hrn:node:hadronmemory.com:specs:cor:agt:050:19), or a child task it owns finished or was cancelled after it last acted (hrn:node:hadronmemory.com:specs:cor:agt:050:16)."
    YOUR_MOVE
    "Its own availability record, or every model family it can run as, says unavailable now (hrn:node:hadronmemory.com:specs:cor:agt:060:01); a stall mark included (hrn:node:hadronmemory.com:specs:cor:agt:060:07)."
    UNAVAILABLE
    "The assignee of a started task with open children (hrn:node:hadronmemory.com:specs:cor:agt:050:04)."
    WAITING
    "The assignee of a started task."
    WORKING
    "The assignee of a pending task."
    ASSIGNED_NOT_STARTED
    "Free for work (hrn:node:hadronmemory.com:specs:cor:agt:060:05), including an unbound worker a live host can launch, which the matcher assigns to, and a bound worker whose session is quiet, which the matcher leaves alone until its session is live again (see liveSession)."
    AVAILABLE
    "Bound, but its session reported no model family, so it can't be matched until one is given (hrn:node:hadronmemory.com:specs:cor:agt:060:04)."
    NO_FAMILY
    "Unbound, and no live host registration lists it."
    NOT_LAUNCHABLE
  }

  "#2138 §3.4 (experimental) — a worker's check status. Draft spec: hrn:node:hadronmemory.com:hadron-dev-team-vera:work:2138-experiment-spec."
  enum WorkerCheckState {
    "No live session."
    NO_SESSION
    "Not expected to check now; pendingReason says why."
    PENDING
    "Has a task and checked within failedChecksToOverdue × checkPeriodSeconds + 5 minutes."
    OK
    "Has a task and hasn't checked for longer than that. Long turns show here on purpose."
    OVERDUE
  }

  "#2138 §3.4 — why a worker is PENDING. Precedence: TEAM_PAUSED, STOPPED, PAUSED, ISOLATED, STANDBY, NO_TASK."
  enum WorkerPendingReason {
    "A team pause is in force (App.teamPausedAt); the worker can't lift it."
    TEAM_PAUSED
    "#2022: a PAUSE or HALT stop signal covers the worker, so it is not ticked (hrn:node:hadronmemory.com:specs:cor:agt:090:03)."
    STOPPED
    "Its own pause (pausedUntil) is in force."
    PAUSED
    "In isolation (unreachable until isolation is built)."
    ISOLATED
    "On standby (unreachable until standby is built)."
    STANDBY
    "No open task assigned, and its Agent uses tasks."
    NO_TASK
  }

  """
  #2138 §3.4 — a worker's check status. A worker HAS A TASK when an open task is
  assigned to it or its Agent has usesTasks: false. The OVERDUE clock runs from
  the latest of lastCheckedAt, its newest open assignment, its live session's
  start and the end of its own pause.
  """
  type WorkerCheckStatus {
    status: WorkerCheckState!
    "Set only when status is PENDING."
    pendingReason: WorkerPendingReason
    "When it last checked the App's team channel through its own session; null if never."
    lastCheckedAt: DateTime
  }

  "A readable open assignment selected for display, independently of session liveness or execution eligibility."
  type TeamRosterTaskSummary {
    id: ID!
    title: String!
    status: AgentTaskStatus!
  }

  "#2061 — active roster workers grouped by their direct reportsTo claim."
  type TeamComposition {
    appId: ID!
    asOf: DateTime!
    "Lanes ordered by coordinator name (case-insensitive), then URN; the unassigned lane is last. Empty teams have no lanes."
    lanes: [TeamCompositionLane!]!
  }

  "A direct-report group, not a hierarchy rollup. A coordinator's own row belongs only in its own reportsTo lane."
  type TeamCompositionLane {
    "Sanitized coordinator identity, including retired coordinators; null for the single unassigned lane."
    coordinator: AgentTaskParty
    coordinatorRetired: Boolean!
    "Non-retired workers only, retaining roster name order. No role, including saas-pm, is excluded."
    workers: [TeamCompositionWorker!]!
    "Plain headcounts, role ascending with null last; null is its own bucket."
    countsByRole: [TeamRoleCount!]!
    "Plain headcounts by role then family, null last in each dimension; nulls are retained as their own buckets."
    countsByRoleFamily: [TeamRoleFamilyCount!]!
  }

  "A closed roster projection; no task, holder or raw Worker fields."
  type TeamCompositionWorker {
    worker: AgentTaskParty!
    role: String
    family: String
    bound: Boolean!
    liveSession: Boolean!
    state: TeamRosterState!
  }
  type TeamRoleCount {
    role: String
    count: Int!
  }
  type TeamRoleFamilyCount {
    role: String
    family: String
    count: Int!
  }

  "#1707 — one worker on the team roster."
  type TeamRosterEntry {
    worker: AgentTaskParty!
    role: String
    state: TeamRosterState!
    "Bound: has an open session, live or quiet. Going quiet never unbinds; ending the session does."
    bound: Boolean!
    "Has a live session (hrn:node:hadronmemory.com:specs:cor:agt:020:11). The matcher assigns to a BOUND worker only while it has one and has reported a family; an unbound worker is matched when a live host can launch it."
    liveSession: Boolean!
    "The binding's model family: its newest open session's (hrn:node:hadronmemory.com:specs:cor:agt:060:04), kept while the session is quiet. Null when unbound or none was reported."
    family: String
    "Self-reported model of the same newest open binding as family, retained while quiet. Null when unbound or unreported; advisory, never authorization."
    model: String
    "When that binding last reported its model; null when unbound or never reported. Not inferred from session activity."
    modelReportedAt: DateTime
    "Coarse tier from the server model mapping: high, mid or low. Null when unbound, unreported or unmapped; advisory, never authorization."
    tier: String
    "Families a live host registration can launch it as (hrn:node:hadronmemory.com:specs:cor:agt:070:01)."
    launchableFamilies: [String!]!
    "Free for work (hrn:node:hadronmemory.com:specs:cor:agt:060:05)."
    freeForWork: Boolean!
    "The families it is free for work as now; empty when not free."
    freeFamilies: [String!]!
    "Set when its own availability record makes it unavailable now."
    unavailableReason: AvailabilityReason
    unavailableUntil: DateTime
    "Families it could run as that are unavailable in the App now (hrn:node:hadronmemory.com:specs:cor:agt:060:03)."
    unavailableFamilies: [String!]!
    "Started tasks it is the assignee of."
    startedTasks: [ID!]!
    "Pending tasks it is the assignee of."
    pendingTasks: [ID!]!
    "WAITING: the open children of its started tasks."
    waitingOn: [ID!]!
    "WAITING: when the oldest of those was created."
    waitingSince: DateTime
    "YOUR_MOVE: unacknowledged alarms it has been woken on."
    alarms: [ID!]!
    "YOUR_MOVE: a finished or cancelled child it hasn't reacted to."
    unreactedChildTask: ID
    lastActiveAt: DateTime
    "When it was last assigned a task; the matcher picks the least recent (hrn:node:hadronmemory.com:specs:cor:agt:060:06)."
    lastAssignedAt: DateTime
    "S12 recorded choice; null means withheld, never UNSET or NO_TEAM."
    teamPlacement: WorkerTeamPlacement
    "#1726 — the worker it reports to; group by this for the team's structure. Read it with lastActiveAt: nothing clears a claim automatically."
    reportsTo: AgentTaskParty
    "#1726 — it reports to a worker that has since retired (retirement leaves the claim; the roster flags it)."
    reportsToRetired: Boolean!
    "#2138 §3.4 (experimental) — whether it is checking its team channel as expected."
    checkStatus: WorkerCheckStatus
    "The worker's own stored pause timestamp, including expired history; use checkStatus for current pause state. Separate from team pause and availability."
    pausedUntil: DateTime
    "The worker's top open assignment you can read, for display only. STARTED before PENDING, then oldest assignment (null last), creation time and id. Null when none is readable; ending a session does not clear an assignment."
    currentTask: TeamRosterTaskSummary
    """
    #2223 — the person holding this worker's name (hrn:node:hadronmemory.com:specs:cor:agt:020:09), or null:
    nobody holds it, the holder is deleted, or the reader fails the worker working-state gate (the same gate
    as Worker.heldByUserId, which is narrower than the roster's audience).
    """
    heldBy: WorkerHolder
    "When the current hold was taken. Null exactly when heldBy is; masked the same way."
    heldAt: DateTime
  }

  """
  #2223 — a sanitized identity for the person holding a worker's name. A closed projection, never User:
  User's default-resolved tail (policy, identityProvider, externalId, githubId, roles, maxReferrals) must
  not come along (hrn:node:hadronmemory.com:specs:cor:acl:110:01). The same four fields as ReleasedFromUser.
  """
  type WorkerHolder {
    id: ID!
    handle: String
    "Canonical hrn:user:<handle> URN (hrn:node:hadronmemory.com:specs:cor:urn:010:01). Null for a handle-less user."
    urn: String
    """
    Behind the #384 gate, as User.name: the holder, a platform admin, or a co-member of one of their orgs.
    Null both when withheld and when unset, so a masked name cannot be told from an unnamed user.
    """
    name: String
  }

  "#1707 — the team roster of one App."
  type TeamRoster {
    appId: ID!
    asOf: DateTime!
    workers: [TeamRosterEntry!]!
  }

  "#1706 — every availability record in one App."
  type TeamAvailability {
    workers: [WorkerAvailability!]!
    families: [ModelFamilyAvailability!]!
  }

  """
  #1706 — an App's effective stall windows, in minutes (hrn:node:hadronmemory.com:specs:cor:agt:050:14–:17).
  Tunables, not contract: the platform defaults are 15, 60, 20 and 30.
  """
  type AgentTaskStallSchedule {
    appId: ID!
    "Not started (hrn:node:hadronmemory.com:specs:cor:agt:050:14): counted from the assignment when the task has no later start-by time."
    notStartedMinutes: Int!
    "No progress (hrn:node:hadronmemory.com:specs:cor:agt:050:15). Also the escalation step for that alarm."
    noProgressMinutes: Int!
    "Owner didn't react to a finished or cancelled child task (hrn:node:hadronmemory.com:specs:cor:agt:050:16)."
    ownerReactionMinutes: Int!
    "Couldn't be assigned (hrn:node:hadronmemory.com:specs:cor:agt:050:17)."
    assignmentMinutes: Int!
    "#1763 — how many of a host's own check-in intervals may pass without a refresh before its registration in this App lapses (hrn:node:hadronmemory.com:specs:cor:agt:070:01): 2 to 10, default 3."
    hostLapseCheckIns: Int!
    "#1709 — how many minutes a worker asked to end its session on its task's finish or cancellation has before the platform ends it through its host (hrn:node:hadronmemory.com:specs:cor:agt:050:10): 1 to 1440, default 10."
    sessionEndGraceMinutes: Int!
    "#1881 — how many minutes a host has to report an operation it collected before the platform fails it (hrn:node:hadronmemory.com:specs:cor:agt:070:02): 5 to 1440, default 60."
    hostReportTimeoutMinutes: Int!
    "When the App last changed them; null while every window is the default."
    updatedAt: DateTime
  }

  "An omitted field keeps its value; null returns it to the platform default. Each window is 1 to 10080 minutes; hostLapseCheckIns is 2 to 10; sessionEndGraceMinutes is 1 to 1440; hostReportTimeoutMinutes is 5 to 1440."
  input AgentTaskStallScheduleInput {
    notStartedMinutes: Int
    noProgressMinutes: Int
    ownerReactionMinutes: Int
    assignmentMinutes: Int
    hostLapseCheckIns: Int
    sessionEndGraceMinutes: Int
    hostReportTimeoutMinutes: Int
  }

  input SetWorkerAvailabilityInput {
    "The worker: its id or URN, or its name together with appRef."
    worker: String!
    appRef: ID
    state: AvailabilityState!
    "Required when UNAVAILABLE; refused when AVAILABLE."
    reason: AvailabilityReason
    "Optional, UNAVAILABLE only, in the future."
    until: DateTime
  }

  input SetModelFamilyAvailabilityInput {
    appRef: ID!
    "A lowercase token, e.g. claude or codex."
    family: String!
    state: AvailabilityState!
    reason: AvailabilityReason
    until: DateTime
  }

  """
  createAgentTask input. A ROOT task names appRef; any App participant may
  create one (hrn:node:hadronmemory.com:specs:cor:agt:050:06). A CHILD task names parentTaskId; only the
  parent's assignee may create one, and it owns it (hrn:node:hadronmemory.com:specs:cor:agt:050:07).
  """
  input CreateAgentTaskInput {
    "The team App (id or URN). Required for a root task; for a child task it is taken from the parent and, if given, must match."
    appRef: ID
    parentTaskId: ID
    title: String!
    description: String
    source: String
    """
    Defaults to the creator. A root task's creator may name any other
    participating worker or person as owner (#1757, hrn:node:hadronmemory.com:specs:cor:agt:050:01);
    a ref outside the App's participants is TASK_OWNER_INVALID. Never for a
    child task, whose owner is its parent's assignee (TASK_CHILD_OWNER_MISMATCH).
    """
    owner: AgentTaskPartyInput
    "Omit to leave the task queued."
    assignee: AgentTaskPartyInput
    requirements: AgentTaskRequirementsInput
    startBy: DateTime
    tags: [String!]
    "Defaults to false: the assignee's session ends only when whoever assigns the task asks (hrn:node:hadronmemory.com:specs:cor:agt:050:10)."
    closeSessionWhenDone: Boolean
    """
    #1754 — PENDING (the default) or BACKLOG
    (hrn:node:hadronmemory.com:specs:cor:agt:050:02). A BACKLOG task is parked: it takes no assignee (BAD_USER_INPUT),
    never enters the queue, and is moved to pending by assigning it or making it ready.
    """
    status: AgentTaskCreateStatus
  }
`;
