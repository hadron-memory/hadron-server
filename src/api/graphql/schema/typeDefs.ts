export const typeDefs = `#graphql
  enum Role {
    OWNER
    ADMIN
    CONTRIBUTOR
    READER
  }

  enum StationType {
    WORKSTATION
    CHATBOT
    AGENT
    AUTOMATION
    CLOUD
    IOT
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
    stationId: String
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
    appId: String
    stationId: String @deprecated(reason: "Use appId. Removed in 003-station-to-app Phase 4.")
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

  # A station's subscription to an agent.
  # DEPRECATED — use AppAgentSub. Removed in 003-station-to-app Phase 4.
  type StationAgentSub {
    id: ID!
    agent: Agent!
    subscriptionType: SubscriptionType!
    trainingMode: Boolean!
    createdAt: String!
  }

  # DEPRECATED — use App. Removed in 003-station-to-app Phase 4.
  type Station {
    id: ID!
    urn: String!
    name: String!
    stationType: StationType!
    description: String
    systemPrompt: String
    role: Role!
    apiKeyShown: Boolean!
    agentTools: [String!]!
    aiProvider: String
    aiModel: String
    hasAiApiKey: Boolean!
    organizationId: String
    userId: String
    user: User
    agentSubscriptions: [StationAgentSub!]!
    expiresAt: String
    createdAt: String!
    lastUsedAt: String
  }

  # Returned once at creation — the raw key is never stored
  # DEPRECATED — use AppCreated. Removed in 003-station-to-app Phase 4.
  type StationCreated {
    station: Station!
    rawKey: String!
  }

  # DEPRECATED — use AppKey. Removed in 003-station-to-app Phase 4.
  type StationKey {
    id: ID!
    stationId: String!
    userId: String!
    label: String
    keyPreview: String
    lastUsedAt: String
    createdAt: String!
    revokedAt: String
  }

  # Returned once at key creation — the raw key is never stored
  # DEPRECATED — use AppKeyCreated. Removed in 003-station-to-app Phase 4.
  type StationKeyCreated {
    key: StationKey!
    rawKey: String!
  }

  # Decrypted AI config for chatbot use (only returned to station owner)
  # DEPRECATED — use AppAIConfig. Removed in 003-station-to-app Phase 4.
  type StationAIConfig {
    provider: String!
    apiKey: String!
    model: String!
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
  }

  # A third-party application (e.g. Micromentor's backend) that calls Hadron on
  # behalf of its own users. Owns long-lived App Keys and a set of agents it may
  # operate.
  type App {
    id: ID!
    name: String!
    urn: String!
    organizationId: String!
    organization: Organization
    # Absorbed from Station in 003-station-to-app Phase 1 (2026-04-28).
    # appType replaces Station.stationType; role replaces Station.role.
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
    agents: [Agent!]!
    # Membership rows linking this App to agents — replaces
    # Station.agentSubscriptions with the AppAgent model. Each row carries
    # the AppAgentRole (operate | develop, per Constitution Invariant #6),
    # the (carried-over) subscriptionType, and trainingMode.
    agentSubscriptions: [AppAgentSub!]!
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

  enum AppAgentRole {
    OPERATE
    DEVELOP
  }

  # An App's link to an Agent — mirrors StationAgentSub (which is deprecated).
  type AppAgentSub {
    appId: String!
    agentId: String!
    agent: Agent!
    role: AppAgentRole!
    subscriptionType: SubscriptionType!
    trainingMode: Boolean!
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

  # Decrypted AI config for an App (owner / org admin only) — mirrors StationAIConfig.
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
    isEncrypted: Boolean!
    userMemoryOfAgentId: String
    anonymousExpiresAt: String
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

  # A named agent configuration; groups memories and (future) tools.
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
    agentUrn:        String!
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

    # Aggregated usage counts per node and type for a memory
    memoryUsageSummary(memoryId: ID!): [UsageSummaryEntry!]!

    # Sessions, most recent first
    sessions(type: String, repo: String, customerId: String, limit: Int, offset: Int): [Session!]!
    session(id: ID!): Session

    # Stations (admin only) — DEPRECATED, use App-shaped queries below.
    # Removed in 003-station-to-app Phase 4.
    stations: [Station!]! @deprecated(reason: "Use apps. Removed in 003-station-to-app Phase 4.")
    station(id: ID!): Station @deprecated(reason: "Use app(id). Removed in 003-station-to-app Phase 4.")
    myStations: [Station!]! @deprecated(reason: "Use myApps. Removed in 003-station-to-app Phase 4.")
    stationNodes(stationId: ID!, limit: Int): [Node!]! @deprecated(reason: "Use appNodes. Removed in 003-station-to-app Phase 4.")
    stationAIConfig(stationId: ID!): StationAIConfig @deprecated(reason: "Use appAIConfig. Removed in 003-station-to-app Phase 4.")
    stationKeys(stationId: ID!): [StationKey!]! @deprecated(reason: "Use appKeys. Removed in 003-station-to-app Phase 4.")

    # Users (admin only)
    users: [User!]!
    # Search users by name, email, or GitHub username
    searchUsers(query: String!): [User!]!

    # Current authenticated user
    me: User

    # Organizations
    organizations: [Organization!]!       # platform ADMIN: all orgs
    myOrganizations: [Organization!]!     # authenticated user: their memberships
    organization(id: ID!): Organization   # org member or platform ADMIN

    # Invitation lookup (public — no auth required, used by invite acceptance page)
    invitation(slug: String!): UserInvitation

    # The station authenticated by the current API key (null for JWT users)
    myStation: Station @deprecated(reason: "Use myApp. Removed in 003-station-to-app Phase 4.")

    # Public memory marketplace — any authenticated user
    publicMemories: [Memory!]!

    # Fetch a single memory by ID (org member or platform ADMIN)
    memory(id: ID!): Memory

    # System memories belonging to an org (org member or platform ADMIN)
    orgSystemMemories(orgId: ID!): [Memory!]!

    # Memories accessible to the caller. Agent system memories are hidden
    # by default; pass includeAgentSystem: true on the memories list page
    # to surface them.
    myMemories(includeAgentSystem: Boolean): [Memory!]!

    # Exchange integration
    exchangeConnections(orgId: ID!): [ExchangeConnection!]!
    exchangeMessages(connectionId: ID!, top: Int, filter: String): [ExchangeMessage!]!
    exchangeFolders(connectionId: ID!): [ExchangeFolder!]!

    # Apps (org ADMIN)
    apps(orgId: ID!): [App!]!
    app(id: ID!): App
    # The App authenticated by the current AppKey (null for JWT users without an App)
    myApp: App
    # Apps where the current user is a member of the App's org
    myApps: [App!]!
    # All nodes accessible by an App (across all subscribed memories)
    appNodes(appId: ID!, limit: Int): [Node!]!
    # Decrypted AI config for an App (org ADMIN of the App's org)
    appAIConfig(appId: ID!): AppAIConfig
    # List keys for an App (org ADMIN of the App's org)
    appKeys(appId: ID!): [AppKey!]!

    # Agent AI config (org ADMIN) — returns the decrypted API key so the
    # portal backend can make LLM calls on behalf of the user.
    agentAIConfig(agentId: ID!): AgentAIConfig

    # Saved chats for the current user in their personal memory for an
    # agent. Newest first.
    myChats(agentId: ID!, limit: Int, offset: Int): [Chat!]!

    # Message history for a saved chat. Returns plain role/content pairs
    # suitable for feeding back into an LLM.
    chatHistory(chatId: String!, limit: Int): [ChatMessage!]!

    # ── Assets (spec 004-asset-upload) ────────────────────────────────
    # List the calling user's assets in their per-agent memory,
    # paginated, optionally filtered by MIME.
    agentAssets(
      agentUrn:       String!
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

    # Asset upload (spec 004-asset-upload)
    beginAssetUpload(input: BeginAssetUploadInput!): BeginAssetUploadResult!
    completeAssetUpload(input: CompleteAssetUploadInput!): Asset!
    setAgentAssetUploadEnabled(input: SetAgentAssetUploadEnabledInput!): App!
    softDeleteAsset(assetId: ID!): Asset!
    restoreAsset(assetId: ID!): Asset!

    # Session lifecycle
    startSession(input: SessionInput!): Session!
    endSession(id: ID!, summary: String, inputTokens: Int, outputTokens: Int, turnCount: Int, errorCount: Int): Session!

    # Record a usage event
    recordUsage(event: UsageEventInput!): Boolean!

    # Station management — DEPRECATED, use the App-shaped mutations
    # (createApp, updateApp, regenerateAppKey, deleteApp / revokeApp).
    # Removed in 003-station-to-app Phase 4.
    createStation(name: String!, stationType: StationType!, role: Role!, description: String, systemPrompt: String, organizationId: String, userId: String, expiresAt: String, agentTools: [String!], aiProvider: String, aiModel: String, aiApiKey: String): StationCreated! @deprecated(reason: "Use createApp + createAppKey. Removed in 003-station-to-app Phase 4.")
    updateStation(id: ID!, name: String, urn: String, stationType: StationType, description: String, systemPrompt: String, agentTools: [String!], aiProvider: String, aiModel: String, aiApiKey: String): Station! @deprecated(reason: "Use updateApp. Removed in 003-station-to-app Phase 4.")
    regenerateApiKey(id: ID!): StationCreated! @deprecated(reason: "Use regenerateAppKey. Removed in 003-station-to-app Phase 4.")
    revokeStation(id: ID!): Boolean! @deprecated(reason: "Use deleteApp. Removed in 003-station-to-app Phase 4.")

    # Station key management — DEPRECATED.
    createStationKey(stationId: ID!, label: String): StationKeyCreated! @deprecated(reason: "Use createAppKey. Removed in 003-station-to-app Phase 4.")
    revokeStationKey(keyId: ID!): Boolean! @deprecated(reason: "Use revokeAppKey. Removed in 003-station-to-app Phase 4.")

    # Station agent subscriptions — DEPRECATED.
    subscribeStationToAgent(stationId: ID!, agentId: ID!, subscriptionType: SubscriptionType, trainingMode: Boolean): Station! @deprecated(reason: "Use addAgentToApp (with role / subscriptionType / trainingMode args). Removed in 003-station-to-app Phase 4.")
    unsubscribeStationFromAgent(stationId: ID!, agentId: ID!): Station! @deprecated(reason: "Use removeAgentFromApp. Removed in 003-station-to-app Phase 4.")

    # App key management beyond what's already declared in the Apps section
    # below — adds the regenerate path that the deprecated regenerateApiKey
    # mirrors. The basic createAppKey / revokeAppKey / deleteApp are
    # declared with the other App mutations.
    regenerateAppKey(id: ID!): AppCreated!

    # User management
    updateMyProfile(name: String, handle: String, email: String): User!
    updateUserRoles(userId: ID!, roles: [Role!]!): User!

    # Organization management
    createOrganization(name: String!, urn: String!): Organization!
    updateOrganization(id: ID!, name: String, urn: String, isVisible: Boolean): Organization!
    deleteOrganization(id: ID!): Boolean!

    # Link a GitHub App installation to an organization (org ADMIN or platform ADMIN)
    linkGithubApp(orgId: ID!, installationId: Int!): Organization!

    # Set GitHub App credentials for an organization (encrypted at rest)
    updateOrgGithubApp(orgId: ID!, appId: String!, privateKey: String!): Organization!

    # Remove all GitHub App config from an organization
    unlinkGithubApp(orgId: ID!): Organization!

    # User invitations (org ADMIN or platform ADMIN)
    createUserInvitation(orgId: ID!, memberRole: Role!, name: String, email: String, githubUsername: String, maxActivations: Int, expiresInDays: Int): UserInvitation!
    # Platform invite — no org association, just onboards a new user
    inviteUser(name: String, email: String, githubUsername: String, maxActivations: Int, expiresInDays: Int): UserInvitation!
    acceptInvitation(slug: String!): Boolean!

    # Organization membership (platform ADMIN or org OWNER/ADMIN)
    addOrgMember(orgId: ID!, userId: ID!, role: Role!): OrgMember!
    updateOrgMember(orgId: ID!, userId: ID!, role: Role!): OrgMember!
    removeOrgMember(orgId: ID!, userId: ID!): Boolean!

    # Memory management (org ADMIN)
    createMemory(orgId: ID!, name: String!, shortDescription: String, description: String, tags: [String!], license: String, category0: String, category1: String, category2: String, iconUrl: String, heroUrl: String, homeUrl: String, source: String, readBranch: String, writeBranch: String, visibility: MemoryVisibility, type: MemoryType): Memory!
    updateMemory(id: ID!, name: String, urn: String, organizationId: ID, shortDescription: String, description: String, tags: [String!], license: String, category0: String, category1: String, category2: String, iconUrl: String, heroUrl: String, homeUrl: String, source: String, readBranch: String, writeBranch: String, visibility: MemoryVisibility): Memory!
    deleteMemory(id: ID!): Boolean!
    # Set encrypted source token for non-GitHub-App repos
    setMemorySourceToken(id: ID!, token: String!, expiresAt: String): Memory!

    # Agent management (org ADMIN)
    createAgent(orgId: ID!, name: String!, description: String, systemPrompt: String, systemMemoryId: String, visibility: MemoryVisibility, type: AgentType, surfaces: [String!]): Agent!
    updateAgent(id: ID!, name: String, urn: String, description: String, systemPrompt: String, systemMemoryId: String, visibility: MemoryVisibility, type: AgentType, surfaces: [String!]): Agent!
    deleteAgent(id: ID!): Boolean!
    addMemoryToAgent(agentId: ID!, memoryId: ID!, role: String): Agent!
    updateAgentMemoryRole(agentId: ID!, memoryId: ID!, role: String!): Agent!
    removeMemoryFromAgent(agentId: ID!, memoryId: ID!): Agent!

    # Memory subscriptions (cross-org)
    createMemorySubscription(memoryId: ID!, orgId: ID!, role: Role!): MemorySubscription!
    updateMemorySubscription(memoryId: ID!, orgId: ID!, role: Role!): MemorySubscription!
    deleteMemorySubscription(memoryId: ID!, orgId: ID!): Boolean!

    # Trigger an on-demand sync for one memory (org ADMIN or CONTRIBUTOR)
    syncMemory(id: ID!): Memory!

    # Push all nodes in a memory to its configured git repo
    pushMemoryToGit(id: ID!): Boolean!

    # Add a public memory to the current user's personal workspace
    addToMyMemories(memoryId: ID!): Boolean!

    # Exchange integration (connection created via OAuth at /auth/microsoft)
    deleteExchangeConnection(id: ID!): Boolean!
    testExchangeConnection(id: ID!): Boolean!
    exchangeReply(connectionId: ID!, messageId: ID!, body: String!): Boolean!
    exchangeMoveMessage(connectionId: ID!, messageId: ID!, folderId: String!): Boolean!

    # ── Chat API ──────────────────────────────────────────────────────
    # Start a chat session (creates chat nodes, loads conversation, returns compiled prompt).
    # When called by a JWT user, the chat is created in that user's
    # personal memory for the agent (provisioned lazily if needed).
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
    updateAgentAIConfig(agentId: ID!, provider: String!, model: String!, apiKey: String): Agent!
    clearAgentAIConfig(agentId: ID!): Agent!

    # Chatbot revisions (org ADMIN)
    createRevision(agentId: ID!, description: String): RevisionResult!
    publishRevision(agentId: ID!, revisionLoc: String!, versionLabel: String): RevisionResult!
    restoreRevision(agentId: ID!, revisionLoc: String!): RevisionResult!

    # Editor lock (org ADMIN)
    acquireEditorLock(agentId: ID!): EditorLockResult!
    releaseEditorLock(agentId: ID!): Boolean!

    # Public mutations (no auth required)
    joinWaitingList(email: String!, requestedFeatures: String): Boolean!
    sendContactMessage(name: String!, email: String!, message: String!): Boolean!

    # ── Apps and multi-user-agent sessions ────────────────────────────

    # App management (org ADMIN) — the unified caller-identity entity per
    # Constitution Invariant #6. Absorbs the legacy Station entity; the
    # *appType, role, description, systemPrompt, agentTools, aiProvider,
    # aiModel, aiApiKey, expiresAt* fields below were absorbed from
    # Station in 003-station-to-app Phase 1 (2026-04-28) and exposed on
    # this surface in Phase 3a-2.
    createApp(
      orgId: ID!
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
      createUserPermission: CreateUserPermission
      identifyUserMethod: IdentifyUserMethod
      sessionTimeoutSeconds: Int
      anonymousTtlDays: Int
    ): App!
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
      createUserPermission: CreateUserPermission
      identifyUserMethod: IdentifyUserMethod
      sessionTimeoutSeconds: Int
      anonymousTtlDays: Int
    ): App!
    deleteApp(id: ID!): Boolean!
    # Add an Agent to an App's membership graph. role / subscriptionType /
    # trainingMode were added in Phase 3a-2 (per Constitution Invariant #6
    # for AppAgent.role; subscriptionType + trainingMode carried over from
    # the legacy StationAgentSubscription).
    addAgentToApp(
      appId: ID!
      agentId: ID!
      role: AppAgentRole
      subscriptionType: SubscriptionType
      trainingMode: Boolean
    ): App!
    removeAgentFromApp(appId: ID!, agentId: ID!): App!
    createAppKey(appId: ID!, label: String): AppKeyCreated!
    revokeAppKey(id: ID!): Boolean!

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

    # Link an anonymous memory to a real user (converts session memory ownership).
    # Providing dataKey encrypts the memory in place atomically with the link.
    linkMemoryToUser(memoryId: ID!, externalUserId: String!, dataKey: String): Memory!

    # Convert an existing plaintext memory to an encrypted one. The caller
    # provides the data key; all existing node content/data is re-written as
    # ciphertext in a single transaction.
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
