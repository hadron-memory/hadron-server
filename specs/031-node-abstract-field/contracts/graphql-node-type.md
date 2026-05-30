# Contract: GraphQL `Node` type — abstract field

Spec source: FR-001 (column exists), FR-002 (independence from description/content), FR-008
(length cap propagates to mutations), FR-009 (empty-string normalization).

## Type definition delta

The `Node` type (find via `type Node {` in `src/api/graphql/schema/typeDefs.ts`) gains one field,
positioned between `description` and `content`:

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

## Mutation surface delta

**Verified 2026-05-30** against the real `typeDefs.ts`: there is one node write mutation,
`upsertNode(input: NodeInput!): Node!` (find via the `upsertNode:` line in the `Mutation` block).
The accompanying `input NodeInput {` carries the field set; `abstract: String` joins it,
positioned between `description` and `content`:

```graphql
input NodeInput {
  id: String
  memoryId: String!
  nodeType: String
  loc: String!
  name: String!
  alias: String
  description: String
  "Paragraph-length summary. Cap is 2000 characters; longer values are rejected with NodeAbstractTooLongError. Empty + whitespace-only values normalize to null. Spec 031."
  abstract: String          # ← NEW
  content: String
  seq: Int
  tags: [String!]
  properties: JSON
  data: JSON
  ownerRepo: String
  llmModel: String
  aiAgent: String
  edges: [NodeEdgeInput!]
  createOnly: Boolean
}
```

**Doc-comment on the new field**: triple-quoted string, no backticks (S3). Same constraint as the
`Node.abstract` field doc-comment above.

**Partial-update semantics on `upsertNode`** (matching the MCP `h-update-node` contract):

| Input shape | Behavior |
|-------------|----------|
| `input.abstract` key absent | Preserve existing column value. |
| `input.abstract: null` | Clear the column. |
| `input.abstract: "..."` | Replace; empty/whitespace-only normalize to null (FR-009). |

GraphQL doesn't distinguish "field omitted" from "field set to null" at the resolver-args level
the way MCP's JSON does — the `upsertNode` resolver MUST detect key presence on the parsed input
object (e.g., `'abstract' in input`). This is the same problem the existing `description` and
`content` fields already solve in the `upsertNode` resolver body; `abstract` joins that existing
pattern.

**`createOnly: Boolean` interaction**: orthogonal. Abstract write behavior is identical whether
`createOnly` is true or false. `createOnly: true` rejects on `(loc, memoryId)` collision with a
typed error; the new field has no special handling under either mode.

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
  - `upsertNode` create-mode with `input.abstract`: persists.
  - `upsertNode` create-mode with `input.abstract` > 2000 chars: throws typed error
    (`extensions.code: 'NodeAbstractTooLongError'`).
  - `upsertNode` update-mode with `input.abstract: "..."`: replaces.
  - `upsertNode` update-mode with `input.abstract: null`: clears.
  - `upsertNode` update-mode without `input.abstract` key: preserves existing value.
  - `upsertNode` with `input.abstract: ''` or whitespace-only: normalizes to null.
  - `upsertNode` with `createOnly: true` + abstract on a colliding loc: typed conflict error,
    abstract not persisted.
  - `node(id)` query returns abstract.
  - **NOT tested here**: search recall over abstract content (US3 deferred to RAG follow-up per
    PR-196).
