export const typeDefs = `#graphql
  enum Role {
    ADMIN
    CONTRIBUTOR
    READER
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

  type ApiKey {
    id: ID!
    label: String!
    role: Role!
    namespace: String
    expiresAt: String
    createdAt: String!
    lastUsedAt: String
  }

  # Returned once at creation — the raw key is never stored
  type ApiKeyCreated {
    apiKey: ApiKey!
    rawKey: String!
  }

  type User {
    id: ID!
    githubId: Int!
    login: String!
    role: Role!
  }

  input NodeInput {
    loc: String!
    name: String!
    alias: String
    description: String
    content: String
    tags: [String!]
    ownerRepo: String!
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

    # API keys (admin only)
    apiKeys: [ApiKey!]!

    me: User
  }

  type Mutation {
    # Create or update a single node
    upsertNode(input: NodeInput!): Node!

    # Delete a node by loc
    deleteNode(loc: String!): Boolean!

    # Replace all nodes under a namespace owned by a repo (collection tool)
    replaceSubtree(namespace: String!, ownerRepo: String!, nodes: [NodeInput!]!, edges: [EdgeInput!]!): Int!

    # Session lifecycle
    startSession(input: SessionInput!): Session!
    endSession(id: ID!, summary: String, inputTokens: Int, outputTokens: Int, turnCount: Int, errorCount: Int): Session!

    # Record a usage event
    recordUsage(event: UsageEventInput!): Boolean!

    # API key management (admin only)
    createApiKey(label: String!, role: Role!, namespace: String, expiresAt: String): ApiKeyCreated!
    revokeApiKey(label: String!): Boolean!
  }
`;
