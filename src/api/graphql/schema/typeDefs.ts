export const typeDefs = `#graphql
  enum Role {
    OWNER
    ADMIN
    CONTRIBUTOR
    READER
  }

  enum ClientType {
    WORKSTATION
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

  enum Visibility {
    PUBLIC
    PRIVATE
  }

  type Node {
    id: ID!
    memoryId: String!
    loc: String!
    isLink: Boolean!
    name: String!
    title: String!
    alias: String
    description: String
    content: String
    tokens: Int
    tags: [String!]!
    namespace: String!
    ownerRepo: String
    isRunnable: Boolean
    createdAt: String!
    updatedAt: String!
    outgoingEdges: [Edge!]!
    incomingEdges: [Edge!]!
  }

  type Edge {
    id: ID!
    source: Node!
    target: Node!
    label: String!
  }

  type Session {
    id: ID!
    type: String!
    clientId: String
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
    clientId: String
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
    title: String!
    alias: String
    description: String
    content: String
    tags: [String!]!
    editedBy: String
    createdAt: String!
  }

  # A client's subscription to a memory bundle.
  type ClientBundleSub {
    id: ID!
    bundle: MemoryBundle!
    subscriptionType: SubscriptionType!
    trainingMode: Boolean!
    createdAt: String!
  }

  type Client {
    id: ID!
    label: String!
    clientType: ClientType!
    description: String
    role: Role!
    apiKeyShown: Boolean!
    namespace: String
    organizationId: String
    userId: String
    user: User
    bundleSubscriptions: [ClientBundleSub!]!
    expiresAt: String
    createdAt: String!
    lastUsedAt: String
  }

  # Returned once at creation — the raw key is never stored
  type ClientCreated {
    client: Client!
    rawKey: String!
  }

  type User {
    id: ID!
    githubId: Int!
    githubUsername: String!
    identityProvider: String
    name: String
    email: String
    avatarUrl: String
    roles: [Role!]!
    maxReferrals: Int
  }

  # A company or team that owns one or more Hadron memories.
  type Organization {
    id: ID!
    name: String!
    domain: String!
    isPersonal: Boolean!
    githubInstallationId: Int
    githubAppId: String
    hasGithubAppPrivateKey: Boolean!
    members: [OrgMember!]!
    memories: [Memory!]!
    memoryBundles: [MemoryBundle!]!
    subscriptions: [MemorySubscription!]!
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
    name: String!
    source: String
    readBranch: String
    writeBranch: String
    visibility: Visibility!
    syncStatus: SyncStatus!
    syncError: String
    pendingEdgeCount: Int!
    lastSyncedAt: String
    createdAt: String!
    updatedAt: String!
    subscriptions: [MemorySubscription!]!
  }

  # A named grouping of memories; clients subscribe to bundles.
  type MemoryBundle {
    id: ID!
    organizationId: String!
    name: String!
    description: String
    items: [MemoryBundleItem!]!
    createdAt: String!
  }

  type MemoryBundleItem {
    id: ID!
    memory: Memory!
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

  # Outgoing edge on a node, used in NodeInput.edges
  input NodeEdgeInput {
    targetId: String!
    label: String
  }

  input NodeInput {
    id: String
    memoryId: String!
    loc: String!
    name: String!
    title: String!
    alias: String
    description: String
    content: String
    tags: [String!]
    ownerRepo: String
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

  type Query {
    # Get a single node by its dotted loc
    node(loc: String!): Node

    # List or search nodes; optionally filter by namespace prefix or tags
    nodes(
      namespace: String
      tags: [String!]
      search: String
      limit: Int
    ): [Node!]!

    # All nodes whose loc starts with the given prefix
    subtree(prefix: String!): [Node!]!

    # Usage stats for a node (most recent events first)
    nodeUsage(loc: String!, limit: Int): [UsageEvent!]!

    # Version history for a node
    nodeVersions(nodeId: ID!, limit: Int): [NodeVersion!]!

    # Aggregated usage counts per node and type for a memory
    memoryUsageSummary(memoryId: ID!): [UsageSummaryEntry!]!

    # Sessions, most recent first
    sessions(type: String, repo: String, customerId: String, limit: Int): [Session!]!
    session(id: ID!): Session

    # Clients (admin only)
    clients: [Client!]!
    client(id: ID!): Client
    # Clients owned by the current user
    myClients: [Client!]!

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

    # Public memory marketplace — any authenticated user
    publicMemories: [Memory!]!

    # Memories the caller should sync (via bundle subscriptions)
    myMemories: [Memory!]!
  }

  type Mutation {
    # Create or update a single node
    upsertNode(input: NodeInput!): Node!

    # Delete a node by loc within a specific memory
    deleteNode(loc: String!, memoryId: String!): Boolean!

    # Restore a node to a previous version (creates a new version snapshot first)
    restoreNodeVersion(versionId: ID!): Node!

    # Move a node to a new loc within a specific memory (keeps same id and all incoming edge references)
    moveNode(from: String!, to: String!, memoryId: String!): Node!

    # Replace all nodes under a namespace owned by a repo (collection tool)
    replaceSubtree(namespace: String!, ownerRepo: String!, memoryId: String!, nodes: [NodeInput!]!, edges: [EdgeInput!]!): Int!

    # Session lifecycle
    startSession(input: SessionInput!): Session!
    endSession(id: ID!, summary: String, inputTokens: Int, outputTokens: Int, turnCount: Int, errorCount: Int): Session!

    # Record a usage event
    recordUsage(event: UsageEventInput!): Boolean!

    # Client management
    createClient(label: String!, clientType: ClientType!, role: Role!, description: String, namespace: String, organizationId: String, userId: String, expiresAt: String): ClientCreated!
    regenerateApiKey(id: ID!): ClientCreated!
    revokeClient(id: ID!): Boolean!

    # Client bundle subscriptions (org ADMIN or platform ADMIN)
    subscribeClientToBundle(clientId: ID!, bundleId: ID!, subscriptionType: SubscriptionType, trainingMode: Boolean): Client!
    unsubscribeClientFromBundle(clientId: ID!, bundleId: ID!): Client!

    # User management (admin only)
    updateUserRoles(userId: ID!, roles: [Role!]!): User!

    # Organization management
    createOrganization(name: String!, domain: String!): Organization!
    updateOrganization(id: ID!, name: String, domain: String): Organization!
    deleteOrganization(id: ID!): Boolean!

    # Link a GitHub App installation to an organization (org ADMIN or platform ADMIN)
    linkGithubApp(orgId: ID!, installationId: Int!): Organization!

    # Set GitHub App credentials for an organization (encrypted at rest)
    updateOrgGithubApp(orgId: ID!, appId: String!, privateKey: String!): Organization!

    # Remove all GitHub App config from an organization
    unlinkGithubApp(orgId: ID!): Organization!

    # Organization membership (platform ADMIN or org OWNER/ADMIN)
    addOrgMember(orgId: ID!, userId: ID!, role: Role!): OrgMember!
    updateOrgMember(orgId: ID!, userId: ID!, role: Role!): OrgMember!
    removeOrgMember(orgId: ID!, userId: ID!): Boolean!

    # Memory management (org ADMIN)
    createMemory(orgId: ID!, name: String!, source: String, readBranch: String, writeBranch: String, visibility: Visibility): Memory!
    updateMemory(id: ID!, source: String, readBranch: String, writeBranch: String, visibility: Visibility): Memory!
    deleteMemory(id: ID!): Boolean!
    # Set encrypted source token for non-GitHub-App repos
    setMemorySourceToken(id: ID!, token: String!, expiresAt: String): Memory!

    # Memory bundle management (org ADMIN)
    createMemoryBundle(orgId: ID!, name: String!, description: String): MemoryBundle!
    updateMemoryBundle(id: ID!, name: String, description: String): MemoryBundle!
    deleteMemoryBundle(id: ID!): Boolean!
    addMemoryToBundle(bundleId: ID!, memoryId: ID!): MemoryBundle!
    removeMemoryFromBundle(bundleId: ID!, memoryId: ID!): MemoryBundle!

    # Memory subscriptions (cross-org)
    createMemorySubscription(memoryId: ID!, orgId: ID!, role: Role!): MemorySubscription!
    updateMemorySubscription(memoryId: ID!, orgId: ID!, role: Role!): MemorySubscription!
    deleteMemorySubscription(memoryId: ID!, orgId: ID!): Boolean!

    # Trigger an on-demand sync for one memory (org ADMIN or CONTRIBUTOR)
    syncMemory(id: ID!): Memory!

    # Add a public memory to the current user's personal workspace
    addToMyMemories(memoryId: ID!): Boolean!
  }
`;
