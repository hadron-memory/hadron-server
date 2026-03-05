export const typeDefs = `#graphql
  enum Role {
    ADMIN
    CONTRIBUTOR
    READER
  }

  enum OrgRole {
    ADMIN
    CONTRIBUTOR
    READER
  }

  type HadronGraph {
    name: String
    nodes: [Node]
  }

  type Node {
    id: ID!
    loc: String!
    name: String!
    alias: String
    description: String
    content: String
    tags: [String!]!
    namespace: String!
    ownerRepo: String!
    createdAt: String!
    updatedAt: String!
    outgoingEdges: [Edge!]!
    incomingEdges: [Edge!]!
  }

  type Edge {
    id: ID!
    source: Node!
    target: Node!
    label: String
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
    createdAt: String!
  }

  enum ClientType {
    WORKSTATION
    CLOUD
    IOT
    AGENT
  }

  # A client's subscription to a specific graph, including access metadata.
  type ClientGraphSub {
    id: ID!
    graph: GraphConfig!
    subscriptionType: String!   # "READ_ONLY" | "READ_WRITE"
    namespace: String           # optional namespace restriction
    createdAt: String!
  }

  type Client {
    id: ID!
    label: String!
    type: ClientType!
    description: String
    roles: [Role!]!
    namespace: String
    organizationId: String
    userId: String
    user: User
    graphs: [GraphConfig!]!          # graphs this client is subscribed to
    subscriptions: [ClientGraphSub!]! # same, with access metadata
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
    login: String!
    name: String
    avatarUrl: String
    roles: [Role!]!
  }

  # A company or team that owns one or more Hadron graphs.
  type Organization {
    id: ID!
    name: String!
    slug: String!
    githubInstallationId: Int
    owner: User
    members: [OrganizationMember!]!
    graphs: [GraphConfig!]!
    subscriptions: [GraphSubscription!]!  # graphs this org subscribes to
    createdAt: String!
    updatedAt: String!
  }

  # Per-organization membership record for a user.
  type OrganizationMember {
    id: ID!
    user: User!
    role: OrgRole!
    createdAt: String!
  }

  # A Hadron graph configuration (git repo + branch settings).
  # Named GraphConfig to distinguish from the in-memory HadronGraph type.
  type GraphConfig {
    id: ID!
    organizationId: String!
    owner: User
    name: String!
    source: String
    readBranch: String
    writeBranch: String
    visibility: String!    # "PUBLIC" | "PRIVATE"
    version: String
    lastSyncedAt: String
    createdAt: String!
    updatedAt: String!
    subscriptions: [GraphSubscription!]!
  }

  # An organization's subscription to a graph it does not own.
  type GraphSubscription {
    id: ID!
    graph: GraphConfig!
    organization: Organization!
    role: String!          # "READER" | "CONTRIBUTOR"
    createdAt: String!
    updatedAt: String!
  }

  # Outgoing edge on a node, used in NodeInput.edges
  input NodeEdgeInput {
    targetId: String!
    label: String
  }

  input NodeInput {
    id: String
    loc: String!
    name: String!
    alias: String
    description: String
    content: String
    tags: [String!]
    ownerRepo: String!
    # Replace all outgoing edges when provided (omit to leave edges unchanged)
    edges: [NodeEdgeInput!]
  }

  input EdgeInput {
    sourceLoc: String!
    targetLoc: String!
    label: String
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
    clientId: String
    sessionId: String
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

    # Sessions, most recent first
    sessions(type: String, repo: String, customerId: String, limit: Int): [Session!]!
    session(id: ID!): Session

    # Clients (admin only)
    clients: [Client!]!
    client(label: String!): Client
    # Clients owned by the current user
    myClients: [Client!]!

    # Users (admin only)
    users: [User!]!

    # Current authenticated user
    me: User

    # Organizations
    organizations: [Organization!]!       # platform ADMIN: all orgs
    myOrganizations: [Organization!]!     # authenticated user: their memberships
    organization(id: ID!): Organization   # org member or platform ADMIN

    # Public graph marketplace — any authenticated user
    publicGraphs: [GraphConfig!]!

    # Graphs the caller should sync:
    #   API-key client → its explicit ClientGraphSubscriptions
    #   JWT/OAuth user → all graphs accessible to all orgs they belong to
    myGraphs: [GraphConfig!]!
  }

  type Mutation {
    # Create or update a single node
    upsertNode(input: NodeInput!): Node!

    # Delete a node by loc
    deleteNode(loc: String!): Boolean!

    # Move a node to a new loc (keeps same id and all incoming edge references)
    moveNode(from: String!, to: String!): Node!

    # Replace all nodes under a namespace owned by a repo (collection tool)
    replaceSubtree(namespace: String!, ownerRepo: String!, nodes: [NodeInput!]!, edges: [EdgeInput!]!): Int!

    # Session lifecycle
    startSession(input: SessionInput!): Session!
    endSession(id: ID!, summary: String, inputTokens: Int, outputTokens: Int, turnCount: Int, errorCount: Int): Session!

    # Record a usage event
    recordUsage(event: UsageEventInput!): Boolean!

    # Client management (admin only)
    createClient(label: String!, type: ClientType!, roles: [Role!]!, description: String, namespace: String, organizationId: String, userId: String, expiresAt: String): ClientCreated!
    regenerateApiKey(id: ID!): ClientCreated!
    revokeClient(label: String!): Boolean!

    # Client graph subscriptions (org ADMIN or platform ADMIN)
    # graphId must be accessible to the client's org (owned or org-subscribed)
    subscribeClientToGraph(clientId: ID!, graphId: ID!, subscriptionType: String, namespace: String): Client!
    unsubscribeClientFromGraph(clientId: ID!, graphId: ID!): Client!

    # User management (admin only)
    updateUserRoles(userId: ID!, roles: [Role!]!): User!

    # Organization management (platform ADMIN)
    createOrganization(name: String!, slug: String!): Organization!
    updateOrganization(id: ID!, name: String, slug: String): Organization!
    deleteOrganization(id: ID!): Boolean!

    # Link a GitHub App installation to an organization (org ADMIN or platform ADMIN)
    linkGithubApp(orgId: ID!, installationId: Int!): Organization!

    # Organization membership (platform ADMIN or org ADMIN)
    addOrganizationMember(orgId: ID!, userId: ID!, role: OrgRole!): OrganizationMember!
    updateOrganizationMember(orgId: ID!, userId: ID!, role: OrgRole!): OrganizationMember!
    removeOrganizationMember(orgId: ID!, userId: ID!): Boolean!

    # Graph config management (org ADMIN)
    createGraphConfig(orgId: ID!, name: String!, source: String, readBranch: String, writeBranch: String, visibility: String, version: String): GraphConfig!
    updateGraphConfig(id: ID!, source: String, readBranch: String, writeBranch: String, visibility: String, version: String): GraphConfig!
    deleteGraphConfig(id: ID!): Boolean!

    # Graph subscriptions
    # PUBLIC graph: any org admin may subscribe for their own org (READER only by default)
    # PRIVATE graph: only the owner org ADMIN or platform ADMIN may add subscribers
    createGraphSubscription(graphId: ID!, orgId: ID!, role: String!): GraphSubscription!
    updateGraphSubscription(graphId: ID!, orgId: ID!, role: String!): GraphSubscription!
    # Callable by: owner ADMIN, platform ADMIN, or the subscribing org itself
    deleteGraphSubscription(graphId: ID!, orgId: ID!): Boolean!

    # Transfer ownership
    transferOrganizationOwnership(orgId: ID!, newOwnerId: ID!): Organization!
    transferGraphOwnership(graphId: ID!, newOwnerId: ID!): GraphConfig!

    # Trigger an on-demand sync for one graph (org ADMIN or CONTRIBUTOR)
    syncGraphConfig(id: ID!): GraphConfig!
  }
`;
