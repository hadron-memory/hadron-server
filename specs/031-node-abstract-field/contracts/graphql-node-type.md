# Contract: GraphQL `Node` type — abstract field

Spec source: FR-001 (column exists), FR-002 (independence from description/content), FR-008
(length cap propagates to mutations), FR-009 (empty-string normalization).

## Type definition delta

`Node` type in [typeDefs.ts:55-79](../../../src/api/graphql/schema/typeDefs.ts#L55) gains one
field, positioned between `description` and `content`:

```graphql
type Node {
  id: ID!
  memoryId: String!
  nodeType: String!
  loc: String!
  isLink: Boolean!
  name: String!
  alias: String
  description: String
  "Paragraph-length summary of this node. Always surfaced in h-find-nodes previews; opt-in on h-read-node via the contentScope parameter; never in h-list-nodes. Cap is 2000 characters; longer values are rejected with NodeAbstractTooLongError. See spec 031."
  abstract: String
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
```

**Doc-comment constraints (S3)**: the description string above uses double quotes; the inline
references to `h-find-nodes`, `h-read-node`, `h-list-nodes`, `contentScope`, and
`NodeAbstractTooLongError` use no backticks. They are bare identifiers in the doc-comment per the
`typeDefs.ts` template-literal constraint.

## Resolver delta

The `Node` field resolver in `src/api/graphql/schema/resolvers.ts` passes the column through
unchanged — Prisma's auto-projection includes `abstract` in the model's default selection. No
explicit resolver function for the field is needed unless Apollo's behavior changes.

## Mutation argument delta

If `createNode` / `updateNode` mutations exist on the GraphQL surface (verify during
implementation — many tools land via MCP only), each gains `abstract: String` as an optional
argument:

```graphql
type Mutation {
  createNode(
    memoryId: ID!
    name: String!
    nodeType: String
    description: String
    abstract: String          # ← NEW
    content: String
    # ... rest of arguments unchanged ...
  ): Node!

  updateNode(
    id: ID!
    name: String
    nodeType: String
    description: String
    abstract: String          # ← NEW
    content: String
    # ... rest unchanged ...
  ): Node!
}
```

**Partial-update semantics on `updateNode`**: GraphQL doesn't distinguish "field omitted" from
"field set to null" — both are `undefined` in the resolver's args object after parsing. The
resolver MUST detect key presence at the schema-argument level (Apollo's `info.fieldNodes`
inspection) or accept the established repo convention (currently — check during implementation
whether the repo uses an `_unset` sentinel value or relies on `info`). This is the same problem
the existing `description` and `content` updates already solve; `abstract` joins the existing
pattern unchanged.

## Validation

- 2000-char cap enforced in the resolver before the Prisma write. Throws `NodeAbstractTooLongError`
  with `{ length, max: 2000 }` in the typed extension.
- Empty-string normalization (`abstract: "" → null`) applied AFTER cap validation.

## Error responses

`NodeAbstractTooLongError` propagates through the GraphQL error formatter with
`extensions.code: 'NodeAbstractTooLongError'` and `extensions.length: <N>`,
`extensions.max: 2000`. Consumer message: `"Abstract exceeds 2000-character cap (got <N> chars).
Use a shorter summary or expand content for the long form."`

## Test coverage

- GraphQL integration test (`src/test/integration/node-abstract.test.ts`):
  - `createNode` with abstract: persists.
  - `createNode` with abstract > 2000 chars: throws typed error with correct extensions.
  - `updateNode` with abstract: replaces.
  - `updateNode` with abstract: null: clears.
  - `updateNode` without abstract arg: preserves.
  - `node(id)` query returns abstract.
  - `findNodes(query)` returns nodes whose abstract matches.
