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

  type UsageEvent {
    id: ID!
    type: String!
    nodeLoc: String
    actionArgs: JSON
    success: Boolean
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

  input UsageEventInput {
    type: String!
    nodeLoc: String
    actionArgs: JSON
    success: Boolean
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

    # Record a usage event
    recordUsage(event: UsageEventInput!): Boolean!

    # API key management (admin only)
    createApiKey(label: String!, role: Role!, namespace: String, expiresAt: String): ApiKeyCreated!
    revokeApiKey(label: String!): Boolean!
  }
`;
