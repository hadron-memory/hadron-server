export const typeDefs = `#graphql
  enum Role {
    OWNER
    ADMIN
    CONTRIBUTOR
    READER
  }

  enum StationType {
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

  enum MemoryVisibility {
    PUBLIC
    PRIVATE
    ORGANIZATION
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
    seq: Int
    ownerRepo: String
    isRunnable: Boolean
    llmModel: String
    aiAgent: String
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
    stationId: String
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
    stationId: String
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
  type StationAgentSub {
    id: ID!
    agent: Agent!
    subscriptionType: SubscriptionType!
    trainingMode: Boolean!
    createdAt: String!
  }

  type Station {
    id: ID!
    urn: String!
    name: String!
    stationType: StationType!
    description: String
    role: Role!
    apiKeyShown: Boolean!
    agentTools: [String!]!
    organizationId: String
    userId: String
    user: User
    agentSubscriptions: [StationAgentSub!]!
    expiresAt: String
    createdAt: String!
    lastUsedAt: String
  }

  # Returned once at creation — the raw key is never stored
  type StationCreated {
    station: Station!
    rawKey: String!
  }

  type User {
    id: ID!
    handle: String
    githubId: Int
    githubUsername: String
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
    urn: String!
    isVisible: Boolean
    githubInstallationId: Int
    githubAppId: String
    hasGithubAppPrivateKey: Boolean!
    members: [OrgMember!]!
    memories: [Memory!]!
    agents: [Agent!]!
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
    properties: JSON
    memoryItems: [AgentMemoryItem!]!
    createdAt: String!
  }

  type AgentMemoryItem {
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

  type Query {
    # Get a single node by its loc path
    node(loc: String!): Node

    # List or search nodes; optionally filter by tags and nodeType
    nodes(
      nodeType: String
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

    # Stations (admin only)
    stations: [Station!]!
    station(id: ID!): Station
    # Stations owned by the current user
    myStations: [Station!]!

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

    # Replace all nodes owned by a repo within a memory (collection tool)
    replaceSubtree(ownerRepo: String!, memoryId: String!, nodes: [NodeInput!]!, edges: [EdgeInput!]!): Int!

    # Session lifecycle
    startSession(input: SessionInput!): Session!
    endSession(id: ID!, summary: String, inputTokens: Int, outputTokens: Int, turnCount: Int, errorCount: Int): Session!

    # Record a usage event
    recordUsage(event: UsageEventInput!): Boolean!

    # Station management
    createStation(name: String!, stationType: StationType!, role: Role!, description: String, organizationId: String, userId: String, expiresAt: String, agentTools: [String!]): StationCreated!
    updateStation(id: ID!, description: String, agentTools: [String!]): Station!
    regenerateApiKey(id: ID!): StationCreated!
    revokeStation(id: ID!): Boolean!

    # Station agent subscriptions (org ADMIN or platform ADMIN)
    subscribeStationToAgent(stationId: ID!, agentId: ID!, subscriptionType: SubscriptionType, trainingMode: Boolean): Station!
    unsubscribeStationFromAgent(stationId: ID!, agentId: ID!): Station!

    # User management (admin only)
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
    acceptInvitation(slug: String!): Boolean!

    # Organization membership (platform ADMIN or org OWNER/ADMIN)
    addOrgMember(orgId: ID!, userId: ID!, role: Role!): OrgMember!
    updateOrgMember(orgId: ID!, userId: ID!, role: Role!): OrgMember!
    removeOrgMember(orgId: ID!, userId: ID!): Boolean!

    # Memory management (org ADMIN)
    createMemory(orgId: ID!, name: String!, shortDescription: String, description: String, tags: [String!], license: String, category0: String, category1: String, category2: String, iconUrl: String, heroUrl: String, homeUrl: String, source: String, readBranch: String, writeBranch: String, visibility: MemoryVisibility): Memory!
    updateMemory(id: ID!, name: String, urn: String, organizationId: ID, shortDescription: String, description: String, tags: [String!], license: String, category0: String, category1: String, category2: String, iconUrl: String, heroUrl: String, homeUrl: String, source: String, readBranch: String, writeBranch: String, visibility: MemoryVisibility): Memory!
    deleteMemory(id: ID!): Boolean!
    # Set encrypted source token for non-GitHub-App repos
    setMemorySourceToken(id: ID!, token: String!, expiresAt: String): Memory!

    # Agent management (org ADMIN)
    createAgent(orgId: ID!, name: String!, description: String): Agent!
    updateAgent(id: ID!, name: String, urn: String, description: String): Agent!
    deleteAgent(id: ID!): Boolean!
    addMemoryToAgent(agentId: ID!, memoryId: ID!): Agent!
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
  }
`;
