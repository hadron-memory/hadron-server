# Phase 1 — Data Model: Node `abstract` field

Concrete schema-level changes. The spec's Entity Impact section is the source of intent; this
document is the operational diff: Prisma definition, migration SQL, GraphQL surface, and the
validation rules that ride on top of the schema.

## Prisma model diff — `prisma/schema.prisma`

The `Node` model at [schema.prisma:721-781](../../prisma/schema.prisma#L721-L781) gains one new
column between `description` (line 735) and `content` (line 737):

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

**Online-safe**: Adding a nullable column with no default is metadata-only on Postgres ≥ 11. Zero
table rewrite, zero row lock beyond the brief catalog update. Safe at any production scale.

**No backfill**: Existing rows backfill to `NULL`. Spec FR-001 makes this explicit ("The column is
additive — no existing column changes shape or semantics").

**Reversibility**: `ALTER TABLE "nodes" DROP COLUMN "abstract";` if a rollback is ever needed. Not
included in the migration file (no down-migration convention in this repo).

## GraphQL schema diff — `src/api/graphql/schema/typeDefs.ts`

`Node` type at [typeDefs.ts:55-79](../../src/api/graphql/schema/typeDefs.ts#L55) gains the
`abstract` field between `description` (line 63) and `content` (line 64):

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

**Mutation arguments**: If GraphQL `createNode` / `updateNode` resolvers exist in the surface
(they may; check during implementation), each gains an optional `abstract: String` argument
matching the partial-update semantics from the MCP layer:

- `createNode(abstract: "...")` — persists.
- `updateNode(id, abstract: null)` — clears.
- `updateNode(id, abstract: "new")` — replaces.
- `updateNode(id)` (no abstract field) — preserves existing.

GraphQL doesn't distinguish "field omitted" from "field set to null" the way MCP's JSON does — the
update resolver MUST inspect the parsed args object for key presence, not just value-null. (This
is the same pattern `description`/`content` use today; abstract joins it.)

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

### V3 — Empty-string normalization (FR-009)

`abstract: ""` is normalized to `NULL` at write time. Implementation: in the resolver / tool body,
before the DB write:

```typescript
const normalizedAbstract = abstract === '' ? null : abstract;
```

This mirrors how `description` and `content` are treated in the existing write paths. The
normalization is applied AFTER length-cap validation (an empty string passes the cap; it then
becomes null).

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
