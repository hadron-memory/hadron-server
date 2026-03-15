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
    graphId: String!
    loc: String!
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

  # A client's subscription to a graph bundle.
  type ClientBundleSub {
    id: ID!
    bundle: GraphBundle!
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

  # A company or team that owns one or more Hadron graphs.
  type Organization {
    id: ID!
    name: String!
    domain: String!
    isPersonal: Boolean!
    githubInstallationId: Int
    githubAppId: String
    hasGithubAppPrivateKey: Boolean!
    members: [OrganizationMember!]!
    graphs: [Graph!]!
    graphBundles: [GraphBundle!]!
    subscriptions: [GraphSubscription!]!
    createdAt: String!
    updatedAt: String!
  }

  # Per-organization membership record for a user.
  type OrganizationMember {
    id: ID!
    user: User!
    role: Role!
    canInvite: Boolean!
    createdAt: String!
  }

  # A Hadron graph (git repo + branch settings).
  type Graph {
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
    subscriptions: [GraphSubscription!]!
  }

  # A named grouping of graphs; clients subscribe to bundles.
  type GraphBundle {
    id: ID!
    organizationId: String!
    name: String!
    description: String
    graphs: [GraphBundleGraph!]!
    createdAt: String!
  }

  type GraphBundleGraph {
    id: ID!
    graph: Graph!
    createdAt: String!
  }

  # An organization's subscription to a graph it does not own.
  type GraphSubscription {
    id: ID!
    graph: Graph!
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
    graphId: String!
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

    # Aggregated usage counts per node and type for a graph
    graphUsageSummary(graphId: ID!): [UsageSummaryEntry!]!

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

    # Public graph marketplace — any authenticated user
    publicGraphs: [Graph!]!

    # Graphs the caller should sync (via bundle subscriptions)
    myGraphs: [Graph!]!
  }

  type Mutation {
    # Create or update a single node
    upsertNode(input: NodeInput!): Node!

    # Delete a node by loc
    deleteNode(loc: String!): Boolean!

    # Restore a node to a previous version (creates a new version snapshot first)
    restoreNodeVersion(versionId: ID!): Node!

    # Move a node to a new loc (keeps same id and all incoming edge references)
    moveNode(from: String!, to: String!): Node!

    # Replace all nodes under a namespace owned by a repo (collection tool)
    replaceSubtree(namespace: String!, ownerRepo: String!, graphId: String!, nodes: [NodeInput!]!, edges: [EdgeInput!]!): Int!

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
    addOrganizationMember(orgId: ID!, userId: ID!, role: Role!): OrganizationMember!
    updateOrganizationMember(orgId: ID!, userId: ID!, role: Role!): OrganizationMember!
    removeOrganizationMember(orgId: ID!, userId: ID!): Boolean!

    # Graph management (org ADMIN)
    createGraph(orgId: ID!, name: String!, source: String, readBranch: String, writeBranch: String, visibility: Visibility): Graph!
    updateGraph(id: ID!, source: String, readBranch: String, writeBranch: String, visibility: Visibility): Graph!
    deleteGraph(id: ID!): Boolean!
    # Set encrypted source token for non-GitHub-App repos
    setGraphSourceToken(id: ID!, token: String!, expiresAt: String): Graph!

    # Graph bundle management (org ADMIN)
    createGraphBundle(orgId: ID!, name: String!, description: String): GraphBundle!
    updateGraphBundle(id: ID!, name: String, description: String): GraphBundle!
    deleteGraphBundle(id: ID!): Boolean!
    addGraphToBundle(bundleId: ID!, graphId: ID!): GraphBundle!
    removeGraphFromBundle(bundleId: ID!, graphId: ID!): GraphBundle!

    # Graph subscriptions (cross-org)
    createGraphSubscription(graphId: ID!, orgId: ID!, role: Role!): GraphSubscription!
    updateGraphSubscription(graphId: ID!, orgId: ID!, role: Role!): GraphSubscription!
    deleteGraphSubscription(graphId: ID!, orgId: ID!): Boolean!

    # Trigger an on-demand sync for one graph (org ADMIN or CONTRIBUTOR)
    syncGraph(id: ID!): Graph!

    # Add a public graph to the current user's personal workspace
    addToMyGraphs(graphId: ID!): Boolean!
  }
`;
