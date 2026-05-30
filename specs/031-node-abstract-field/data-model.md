# Phase 1 — Data Model: Node `abstract` field

Concrete schema-level changes. The spec's Entity Impact section is the source of intent; this
document is the operational diff: Prisma definition, migration SQL, GraphQL surface, and the
validation rules that ride on top of the schema.

## Prisma model diff — `prisma/schema.prisma`

The `Node` model (find via `model Node {` in `prisma/schema.prisma`) gains one new column,
positioned between the existing `description` and `content` fields:

```prisma
model Node {
  // ... existing fields ...

  /// Human-friendly display name of this node.
  name        String
  /// Alternative name.
  alias       String?
  /// Colon-delimited path within the memory (e.g. "auth:tokens").
  loc         String
  isLink      Boolean   @default(false) @map("is_link")
  description String?
  /// Paragraph-length summary of this node — used as a richer preview in
  /// h-find-nodes results, as an opt-in alternative content surface on
  /// h-read-node via `contentScope`, and as the substrate for the upcoming
  /// RAG / vector-retrieval layer (spec 031). Cap is 2000 chars, enforced
  /// at the API boundary (not as a DB CHECK). When `content` is null/empty
  /// and `abstract` is non-null, `h-read-node` with default `contentScope`
  /// substitutes the abstract for the body slot — see spec 031 FR-005 +
  /// edge cases.
  abstract    String?
  /// The topic content (topic.md full text).
  content     String?

  // ... rest of the model unchanged ...
}
```

**Map**: column name in DB is `abstract` (no `@map` needed — Prisma's default snake_case is
identical here).

**Doc-comment**: Inline triple-slash comment per the model's existing convention. Cites spec 031
inline so future readers see the rationale without jumping out.

**Indexes**: None added. The two existing indexes (`@@index([loc])`, `@@index([memoryId])`) remain
the only ones on the model.

## Migration SQL — `prisma/migrations/<timestamp>_node_abstract/migration.sql`

Hand-authored migration directory (per CLAUDE.md — Prisma's `migrate dev` is broken on this repo
due to the historical `stations` table reference). Timestamp follows the `YYYYMMDDHHMMSS`
convention used by recent migrations.

```sql
-- Migration: node_abstract
-- Spec: hadron-server/specs/031-node-abstract-field/spec.md
-- Adds an optional `abstract` text column to `nodes`. Nullable, no default,
-- no CHECK constraint. Validation (2000-char cap) lives at the API boundary
-- per the typed-error pattern in src/lib/entityRef/errors.ts (S2).

ALTER TABLE "nodes" ADD COLUMN "abstract" TEXT;
```

**Online-safe** with one operational caveat (PR-196 review item 5): adding a nullable column with
no default is metadata-only on Postgres ≥ 11 — zero table rewrite, zero row lock at the data
level. BUT `ALTER TABLE` still takes an `ACCESS EXCLUSIVE` lock on `nodes` for the catalog update
itself. Under normal load this is milliseconds; under lock contention (a long-running transaction
already holding any other lock on `nodes`, or a stuck read), the ALTER queues behind it and every
new request touching `nodes` queues behind the ALTER. Operational recommendation:

- Run the migration off-peak.
- Use `SET LOCAL lock_timeout = '5s';` before the ALTER so the migration aborts cleanly rather
  than queueing the entire request pool. Operator can retry after investigating the contention.

Migration tooling should support setting `lock_timeout` per-statement; if not, do it inline in the
SQL file.

**No backfill**: Existing rows backfill to `NULL`. Spec FR-001 makes this explicit ("The column is
additive — no existing column changes shape or semantics").

**Reversibility**: `ALTER TABLE "nodes" DROP COLUMN "abstract";` if a rollback is ever needed. Not
included in the migration file (no down-migration convention in this repo).

## GraphQL schema diff — `src/api/graphql/schema/typeDefs.ts`

The `Node` type (find via `type Node {` in `src/api/graphql/schema/typeDefs.ts`) gains the
`abstract` field, positioned between the existing `description` and `content` fields:

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
  "Paragraph-length summary of this node. See spec 031 for surfacing rules: always in h-find-nodes previews, opt-in on h-read-node via contentScope, never in h-list-nodes. Cap is 2000 characters; longer values are rejected with NodeAbstractTooLongError."
  abstract: String
  content: String
  # ... rest of the Node type unchanged ...
}
```

**Doc-comment**: Triple-quoted string inside the template literal. Uses single quotes for the
`NodeAbstractTooLongError` reference per S3 (no raw backticks in `typeDefs.ts`). Co-canonical with
`hadron-docs` per refinement II.

**Mutation surface** (verified 2026-05-30 against `typeDefs.ts`): the GraphQL write path for
nodes is a single mutation `upsertNode(input: NodeInput!): Node!`, and `NodeInput` (find via
`input NodeInput {`) gains an optional `abstract: String` field positioned between `description`
and `content`:

```graphql
input NodeInput {
  id: String
  memoryId: String!
  nodeType: String
  loc: String!
  name: String!
  alias: String
  description: String
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

Same partial-update semantics as the MCP layer:

- `upsertNode(input: { ..., abstract: "..." })` — persists.
- `upsertNode(input: { ..., abstract: null })` — clears (when updating an existing row).
- `upsertNode(input: { ... })` without `abstract` key — preserves existing.

GraphQL doesn't distinguish "field omitted" from "field set to null" at the resolver-args level
the way MCP's JSON does — the resolver MUST inspect the parsed input object for key presence (
`'abstract' in input`), not just value-null. The existing `description` and `content` handling in
the `upsertNode` resolver is the model; `abstract` joins it.

`createOnly: Boolean` (existing flag on `NodeInput`) is orthogonal to the new field; abstract
write behavior is the same under `createOnly: true` and `false`.

**Query side**: No new arguments on existing queries. Read tools that return `Node` automatically
include `abstract` when callers request it.

## Validation rules (API boundary)

Two new validation gates, both producing typed errors per S2:

### V1 — Length cap (FR-008)

| Site | Mechanism | Error class |
|------|-----------|-------------|
| `h-add-node` (MCP) | `z.string().max(2000)` in the zod schema | `NodeAbstractTooLongError` |
| `h-update-node` (MCP) | same zod schema, applied when `abstract` is present | `NodeAbstractTooLongError` |
| GraphQL `createNode` / `updateNode` (if surfaced) | resolver-level length check before DB write | `NodeAbstractTooLongError` |
| node.yaml importer | length check at parse time | `NodeAbstractTooLongError` (or upstream validation error wrapping it) |

The typed error payload carries `length: number` (offending length) and `max: number` (the cap)
so the caller can render an actionable message.

### V2 — `contentScope` enum (FR-005)

| Site | Mechanism | Error class |
|------|-----------|-------------|
| `h-read-node` (MCP) | `z.enum(['content', 'abstract', 'all']).optional()` in the zod schema | `InvalidContentScopeError` (zod's own validation error wraps it for the MCP response) |
| GraphQL `node(id)` query | not applicable — GraphQL doesn't run `contentScope` at the query level (the field is per-tool, not per-type) | n/a |

Note that V2's invalid-value path is a zod-layer rejection (the MCP server's existing zod
integration handles enum validation). The typed error class exists so that any post-zod code path
that re-validates (e.g., an internal caller bypassing the MCP boundary) has the canonical error
class to throw.

### V3 — Empty + whitespace-only normalization (FR-009, extended PR-196)

Both `abstract: ""` (empty string) AND whitespace-only abstracts (e.g., `"   "`, `"\n\n"`, tabs)
are normalized to `NULL` at write time. Implementation: trim leading + trailing whitespace; if the
trimmed value is empty, persist `NULL`:

```typescript
const trimmed = abstract?.trim() ?? '';
const normalizedAbstract = trimmed === '' ? null : abstract;
```

Note the asymmetry — we normalize to `NULL` based on the *trimmed* value, but persist the
*untrimmed* value when non-empty. This preserves intentional leading/trailing whitespace on a
real paragraph (rare, but lossless), while preventing ghost-whitespace abstracts from polluting
previews.

Validation order:

1. Length-cap check on the raw input (`abstract.length > 2000 → NodeAbstractTooLongError`).
2. Trim-then-check normalization.
3. DB write.

This mirrors how `description` and `content` are treated in the existing write paths (though
those don't currently trim — abstract sets the convention for the trim-then-check rule; future
clean-up could backport it).

## Audit + soft-delete (FR-012)

No new audit logic needed. The existing audit columns (`createdAt`/`By`, `updatedAt`/`By`,
`deletedAt`/`By` per the model doc-comment header) auto-bump on any column update including
`abstract`. Soft-delete preserves the column value on the tombstoned row; restore (if/when added)
recovers it unchanged.

## What is NOT in this data model

- **No CHECK constraint** for the length cap (see research.md D2).
- **No trigram or GIN index** on the abstract (see research.md D10).
- **No history table** for abstract changes beyond what `NodeVersion` already records — and
  `NodeVersion` automatically captures any column update (per its existing usage on description /
  content); abstract rides on that machinery without code change.
- **No vector embedding column** — that's the follow-up RAG spec, explicitly out of scope here per
  the spec Background.
