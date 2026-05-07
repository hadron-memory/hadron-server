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

  enum MemoryVisibility {
    PUBLIC
    PRIVATE
    ORGANIZATION
    PERSONAL
  }

  enum MemoryType {
    KNOWLEDGE
    AGENT_SYSTEM
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

  type Node {
    id: ID!
    memoryId: String!
    nodeType: String!
    loc: String!
    isLink: Boolean!
    name: String!
    alias: String
    description: String
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
    label: String!
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
    createdAt: String!
  }

  type NodeVersion {
    id: ID!
    nodeId: String!
    loc: String!
    name: String!
    alias: String
    description: String
    content: String
    tags: [String!]!
    editedBy: String
    createdAt: String!
  }

  type User {
    id: ID!
    handle: String
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
    organizationId: String!
    organization: Organization
    # 008-agent-installation: direct FK replaces the AppAgent join.
    agentId: ID
    agent: Agent
    trainingMode: Boolean!
    surfaces: [String!]!
    members: [AppMember!]!
    memberCount: Int!
    appType: AppType!
    role: AppMembershipRole!
    description: String
    systemPrompt: String
    agentTools: [String!]!
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
    Soft-deprecated convenience: returns a single-element list with App.agent
    (or empty if agent_id is NULL). Pre-008, an App could reference multiple
    Agents through the AppAgent join; that join is gone, so post-008 there
    is at most one Agent per App. Use App.agent directly.
    """
    agents: [Agent!]! @deprecated(reason: "Use App.agent (singular). 008-agent-installation dropped the AppAgent join in favor of a direct FK.")
    keys: [AppKey!]!
    createdAt: String!
    updatedAt: String
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
    isVisible: Boolean
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

  # Per-organization membership record for a user.
  type OrgMember {
    id: ID!
    user: User!
    role: Role!
    canInvite: Boolean!
    createdAt: String!
  }

  # A Hadron memory (git repo + branch settings).
  type Memory {
    id: ID!
    organizationId: String!
    organization: Organization
    urn: String!
    name: String!
    shortDescription: String
    description: String
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
    visibility: MemoryVisibility!
    type: MemoryType!
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
    userMemoryOfAgentId: String
    anonymousExpiresAt: String
    # 008-agent-installation: app pivot for app/personal-class memories.
    # Required when class IN ('app', 'personal'); NULL otherwise.
    appId: ID
    app: App
    # Populated only for type = AGENT_SYSTEM — the agent this memory is
    # the system memory of. Null for regular knowledge memories.
    agent: Agent
    syncStatus: SyncStatus!
    syncError: String
    pendingEdgeCount: Int!
    lastSyncedAt: String
    createdAt: String!
    updatedAt: String!
    subscriptions: [MemorySubscription!]!
  }

  # The definition (one per Agent) — what a Builder creates and what the
  # marketplace sells. Per 008-agent-installation. An App is the deployment
  # of an Agent in some org.
  type Agent {
    id: ID!
    organizationId: String!
    urn: String!
    name: String!
    description: String
    systemPrompt: String
    systemMemoryId: String
    visibility: MemoryVisibility!
    type: AgentType!
    surfaces: [String!]!
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
    Apps that deploy this Agent (App.agent_id = this.id). Resolvable to
    ADMIN/OWNER of the Agent's owning org; non-admins see an empty list.
    """
    apps: [App!]!
    appCount: Int!
    """
    Org grants for this Agent. Resolvable to ADMIN/OWNER of the Agent's
    owning org only.
    """
    orgGrants: [AgentOrgGrant!]!
    createdAt: String!
  }

  # Decrypted AI config for an agent. Only returned to org admins — the
  # portal backend uses it to make LLM calls on behalf of the logged-in user.
  type AgentAIConfig {
    provider: String!
    apiKey: String!
    model: String!
  }

  # A saved chat in a user's personal memory for an agent.
  type Chat {
    id: ID!
    loc: String!
    title: String!
    conversationName: String
    stageName: String
    messageCount: Int!
    createdAt: String!
    lastMessageAt: String
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

  # Microsoft Exchange connection for an organization (OAuth delegated).
  type ExchangeConnection {
    id: ID!
    organizationId: String!
    userId: String!
    mailboxEmail: String!
    displayName: String
    syncEnabled: Boolean!
    syncStatus: SyncStatus!
    lastSyncAt: String
    lastError: String
    createdAt: String!
    updatedAt: String!
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
    (urn:node:<memory-urn>:<loc>), a memory-prefixed loc
    (<memory-urn>:<loc>), or a short loc resolved within the source
    node's memory.
    """
    targetId: String!
    label: String
  }

  input NodeInput {
    id: String
    memoryId: String!
    nodeType: String
    loc: String!
    name: String!
    alias: String
    description: String
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
    # When true, reject the mutation with NodeLocConflictError if a node
    # already exists at (loc, memoryId). Default false preserves the
    # legacy upsert-on-collision behavior. Set true from create-only
    # callers (e.g., the portal new-node form per spec 011) so a colliding
    # loc surfaces as a clean error instead of silently overwriting the
    # existing node.
    createOnly: Boolean
  }

  input EdgeInput {
    sourceLoc: String!
    targetLoc: String!
    label: String!
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
    uploadedBy:  ID!
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
    """Accepts the entity's ID or URN."""
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
    """Accepts the entity's ID or URN."""
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

  type Query {
    # Get a single node by its loc path (raw: true to skip template compilation)
    node(loc: String!, raw: Boolean): Node

    # Get a single node by its ID (raw: true to skip template compilation)
    nodeById(id: ID!, raw: Boolean): Node

    # List or search nodes; optionally filter by tags and nodeType
    nodes(
      nodeType: String
      tags: [String!]
      search: String
      prefix: String
      limit: Int
      offset: Int
    ): [Node!]!

    # All nodes whose loc starts with the given prefix
    subtree(prefix: String!): [Node!]!

    # Usage stats for a node (most recent events first)
    nodeUsage(loc: String!, limit: Int): [UsageEvent!]!

    # Usage events (most recent first), optionally filtered by type or nodeLoc
    usageEvents(type: String, nodeLoc: String, limit: Int, offset: Int): [UsageEvent!]!

    # Version history for a node
    nodeVersions(nodeId: ID!, limit: Int): [NodeVersion!]!

    """
    Aggregated usage counts per node and type for a memory.

    Accepts the entity's ID or URN.
    """
    memoryUsageSummary(memoryId: ID!): [UsageSummaryEntry!]!

    # Sessions, most recent first
    sessions(type: String, repo: String, customerId: String, limit: Int, offset: Int): [Session!]!
    session(id: ID!): Session

    # Users (admin only)
    users: [User!]!
    # Search users by name, email, or GitHub username
    searchUsers(query: String!): [User!]!

    # Current authenticated user
    me: User

    # Organizations
    organizations: [Organization!]!       # platform ADMIN: all orgs
    myOrganizations: [Organization!]!     # authenticated user: their memberships
    """
    Fetch an Organization by id (org member or platform ADMIN).

    Accepts the entity's ID or URN.
    """
    organization(id: ID!): Organization

    # Invitation lookup (public — no auth required, used by invite acceptance page)
    invitation(slug: String!): UserInvitation

    # Public memory marketplace — any authenticated user
    publicMemories: [Memory!]!

    """
    Fetch a single Memory (org member or platform ADMIN).

    Accepts the entity's ID or URN.
    """
    memory(id: ID!): Memory

    """
    System memories belonging to an org (org member or platform ADMIN).

    Accepts the entity's ID or URN.
    """
    orgSystemMemories(orgId: ID!): [Memory!]!

    # Memories accessible to the caller. Agent system memories are hidden
    # by default; pass includeAgentSystem: true on the memories list page
    # to surface them.
    myMemories(includeAgentSystem: Boolean): [Memory!]!

    """
    Exchange connections for an org.

    Accepts the entity's ID or URN.
    """
    exchangeConnections(orgId: ID!): [ExchangeConnection!]!
    exchangeMessages(connectionId: ID!, top: Int, filter: String): [ExchangeMessage!]!
    exchangeFolders(connectionId: ID!): [ExchangeFolder!]!

    """
    Apps in an organization (org ADMIN).

    Accepts the entity's ID or URN.
    """
    apps(orgId: ID!): [App!]!

    """
    Fetch an App.

    Accepts the entity's ID or URN.
    """
    app(id: ID!): App
    # The App authenticated by the current AppKey (null for JWT users without an App)
    myApp: App
    # Apps where the current user is a member of the App's org
    myApps: [App!]!
    # 005-agent-subscription FR-005: AgentSubscriptions held by the
    # authenticated user. Read-only in v1.
    myAgentSubscriptions: [AgentSubscription!]!

    """
    005-agent-subscription FR-022: list all AgentSubscriptions for an
    Agent. Authorized for ADMIN/OWNER of the Agent's owning org.

    Accepts the entity's ID or URN.
    """
    agentSubscriptions(agentId: ID!): [AgentSubscription!]!

    """
    All nodes accessible by an App (across all subscribed memories).

    Accepts the entity's ID or URN.
    """
    appNodes(appId: ID!, limit: Int): [Node!]!

    """
    Decrypted AI config for an App (org ADMIN of the App's org).

    Accepts the entity's ID or URN.
    """
    appAIConfig(appId: ID!): AppAIConfig

    """
    List keys for an App (org ADMIN of the App's org).

    Accepts the entity's ID or URN.
    """
    appKeys(appId: ID!): [AppKey!]!

    """
    Agent AI config (org ADMIN) — returns the decrypted API key so the
    portal backend can make LLM calls on behalf of the user.

    Accepts the entity's ID or URN.
    """
    agentAIConfig(agentId: ID!): AgentAIConfig

    """
    Saved chats for the current user in their personal memory for an
    agent. Newest first.

    Accepts the entity's ID or URN.
    """
    myChats(agentId: ID!, limit: Int, offset: Int): [Chat!]!

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
  }

  type Mutation {
    # Create or update a single node
    upsertNode(input: NodeInput!): Node!

    # Delete a node by loc within a specific memory
    deleteNode(loc: String!, memoryId: String!): Boolean!

    # Restore a node to a previous version (creates a new version snapshot first)
    restoreNodeVersion(versionId: ID!): Node!

    # Move a node to a new loc, optionally across memories (keeps same id and all incoming edge references)
    moveNode(from: String!, to: String!, memoryId: String!, targetMemoryId: String): Node!

    # Replace all nodes owned by a repo within a memory (collection tool)
    replaceSubtree(ownerRepo: String!, memoryId: String!, nodes: [NodeInput!]!, edges: [EdgeInput!]!): Int!

    # Edge CRUD
    createEdge(sourceNodeId: ID!, targetNodeId: ID!, label: String!, condition: JSON, priority: Int, data: JSON): Edge!
    updateEdge(edgeId: ID!, label: String, condition: JSON, priority: Int, data: JSON): Edge!
    deleteEdge(edgeId: ID!): Boolean!

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

    # Organization management
    createOrganization(name: String!, urn: String!): Organization!

    """
    Update an Organization.

    Accepts the entity's ID or URN.
    """
    updateOrganization(id: ID!, name: String, urn: String, isVisible: Boolean): Organization!

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
    Create a Memory in an organization.

    Accepts the entity's ID or URN.
    """
    createMemory(orgId: ID!, name: String!, shortDescription: String, description: String, tags: [String!], license: String, category0: String, category1: String, category2: String, iconUrl: String, heroUrl: String, homeUrl: String, source: String, readBranch: String, writeBranch: String, visibility: MemoryVisibility, type: MemoryType): Memory!

    """
    Update a Memory.

    Accepts the entity's ID or URN.
    """
    updateMemory(id: ID!, name: String, urn: String, organizationId: ID, shortDescription: String, description: String, tags: [String!], license: String, category0: String, category1: String, category2: String, iconUrl: String, heroUrl: String, homeUrl: String, source: String, readBranch: String, writeBranch: String, visibility: MemoryVisibility): Memory!

    """
    Soft-delete a Memory.

    Accepts the entity's ID or URN.
    """
    deleteMemory(id: ID!): Boolean!
    """
    Set encrypted source token for non-GitHub-App repos.

    Accepts the entity's ID or URN.
    """
    setMemorySourceToken(id: ID!, token: String!, expiresAt: String): Memory!

    # Agent management (org ADMIN)
    """
    Create an Agent in an organization.

    Accepts the entity's ID or URN.
    """
    createAgent(orgId: ID!, name: String!, description: String, systemPrompt: String, systemMemoryId: String, visibility: MemoryVisibility, type: AgentType, surfaces: [String!]): Agent!

    """
    Update an Agent.

    Accepts the entity's ID or URN.
    """
    updateAgent(id: ID!, name: String, urn: String, description: String, systemPrompt: String, systemMemoryId: String, visibility: MemoryVisibility, type: AgentType, surfaces: [String!]): Agent!

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
    exchangeReply(connectionId: ID!, messageId: ID!, body: String!): Boolean!
    exchangeMoveMessage(connectionId: ID!, messageId: ID!, folderId: String!): Boolean!

    # ── Chat API ──────────────────────────────────────────────────────
    """
    Start a chat session (creates chat nodes, loads conversation, returns
    compiled prompt). When called by a JWT user, the chat is created in
    that user's personal memory for the agent (provisioned lazily if
    needed).

    Accepts the entity's ID or URN.
    """
    startChat(agentId: ID!, userId: String, conversationName: String): ChatStartResult!
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

    Accepts the entity's ID or URN.
    """
    updateAgentAIConfig(agentId: ID!, provider: String!, model: String!, apiKey: String): Agent!

    """
    Clear an Agent's AI provider config.

    Accepts the entity's ID or URN.
    """
    clearAgentAIConfig(agentId: ID!): Agent!

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
      orgId: ID!
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
    Set the App's Agent. 008-agent-installation: App→Agent is a direct FK
    on App.agent_id; this mutation is a setter (not a join-row creator).
    The legacy role arg is gone — system memory is universally read-only
    from any App context per R-10.

    Accepts the entity's ID or URN.
    """
    addAgentToApp(
      appId: ID!
      agentId: ID!
      trainingMode: Boolean
    ): App!

    """
    Clear the App's Agent (sets App.agent_id to NULL). Idempotent — clears
    only if the current agentId matches the supplied agentId.

    Accepts the entity's ID or URN.
    """
    removeAgentFromApp(appId: ID!, agentId: ID!): App!

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
    Convert an existing plaintext memory to an encrypted one. The caller
    provides the data key; all existing node content/data is re-written
    as ciphertext in a single transaction.

    Accepts the entity's ID or URN.
    """
    encryptMemory(memoryId: ID!, dataKey: String!): Memory!
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
