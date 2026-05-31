# Phase 1 — Data Model: Node `abstractOriginHash`

Concrete schema-level changes. The spec's Entity Impact section is the source of intent; this document is the operational diff: Prisma deltas, migration SQL, GraphQL surface, validation rules.

## Prisma model diff — `prisma/schema.prisma`

Two models gain the same nullable text column. The migration adds the column to both tables in one file.

### `Node` model

Find via `model Node {` in `prisma/schema.prisma`. New column positioned adjacent to the existing `contentHash` field (the two hashes belong visually together):

```prisma
model Node {
  // ... existing fields including `abstract` (from spec 031) and `content` ...

  /// SHA256(content)[0:8] for change detection.
  contentHash      String?  @map("content_hash")
  /// Spec 032 — fingerprint of the `content` value at the time the
  /// abstract was authored (matches `contentHash` format: SHA-256 truncated
  /// to 8 hex chars). When `contentHash != abstractOriginHash` AND both
  /// are non-null, the abstract is stale (it summarises an older content
  /// version). The staleness signal is the contract that `h-read-node`'s
  /// `Source: abstract-stale` marker, `h-validate`'s `[stale-abstract]`
  /// warning, and the upcoming RAG layer all consume. System-managed:
  /// never settable via GraphQL `NodeInput`. See spec 032 FR-001 + FR-012.
  abstractOriginHash String? @map("abstract_origin_hash")

  // ... rest unchanged ...
}
```

### `NodeVersion` model

Find via `model NodeVersion {` in `prisma/schema.prisma`. New column positioned adjacent to the existing `abstract` column (from spec 031's PR-201-round-2 follow-up):

```prisma
model NodeVersion {
  // ... existing fields ...

  description      String?
  abstract         String?  // spec 031
  /// Spec 032 — snapshot of `Node.abstractOriginHash` at the time of
  /// version capture. Restored verbatim by `restoreNodeVersion`; legacy
  /// versions (pre-spec) have `NULL` here, which short-circuits the
  /// staleness check on the live row after restore (no false positives).
  abstractOriginHash String? @map("abstract_origin_hash")
  content          String?

  // ... rest unchanged ...
}
```

**Map**: PostgreSQL column name is `abstract_origin_hash` in both tables (snake_case per the existing convention; matches `content_hash` / `created_at` / etc.).

**Doc-comment**: triple-slash inline comments per the existing convention. Both cite spec 032 inline.

**Indexes**: none added. Same posture as spec 031 / per research D10.

## Migration SQL — `prisma/migrations/<timestamp>_abstract_origin_hash/migration.sql`

Hand-authored migration directory (per CLAUDE.md — `prisma migrate dev` is broken on this repo). Timestamp follows the `YYYYMMDDHHMMSS` convention used by recent migrations. **One migration file adds the column to both tables** — cheap, atomic, both ALTERs share the same transactional `lock_timeout` envelope.

```sql
-- Migration: abstract_origin_hash
-- Spec: specs/032-abstract-staleness/spec.md
-- Plan: specs/032-abstract-staleness/plan.md
--
-- Adds an optional `abstract_origin_hash` text column to BOTH `nodes` AND
-- `node_versions`. Stores SHA-256(content)[0:8] at the time the abstract
-- was authored, so consumers can detect staleness via `abstract_origin_hash
-- != content_hash`. Per spec 032 FR-001 + FR-002.
--
-- Online safety + BEGIN/COMMIT runner-independence per the convention
-- established in spec 031's migrations. Two ALTERs in one transaction so
-- either both succeed or both abort under lock contention.
--
-- No backfill: existing rows get NULL in both tables. Pre-spec abstracts
-- naturally won't trigger the staleness signal (check short-circuits when
-- either side is null). See spec 032 Assumptions.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "nodes" ADD COLUMN "abstract_origin_hash" TEXT;
ALTER TABLE "node_versions" ADD COLUMN "abstract_origin_hash" TEXT;

COMMIT;
```

**Online-safe**: both ALTERs are nullable additive columns; metadata-only on Postgres ≥ 11. The `ACCESS EXCLUSIVE` lock on each table is brief; the BEGIN/COMMIT wraps both so the migration aborts as a unit if either lock is contested.

**Reversibility**: `BEGIN; ALTER TABLE "nodes" DROP COLUMN "abstract_origin_hash"; ALTER TABLE "node_versions" DROP COLUMN "abstract_origin_hash"; COMMIT;`. Not included in the migration file (no down-migration convention in this repo).

## GraphQL schema diff — `src/api/graphql/schema/typeDefs.ts`

The `Node` type (find via `type Node {`) gains `abstractOriginHash: String`, positioned adjacent to `contentHash`:

```graphql
type Node {
  # ... existing fields ...
  abstract: String
  content: String
  "SHA-256(content)[0:8] — system-managed change-detection fingerprint."
  contentHash: String
  "Spec 032 — fingerprint of the `content` value at the time `abstract` was authored. When this differs from `contentHash` and both are non-null, the abstract is stale. Read-only; never settable via NodeInput."
  abstractOriginHash: String
  # ... rest unchanged ...
}
```

**`NodeInput` does NOT gain a corresponding field.** FR-012 — `abstractOriginHash` is system-managed; allowing caller-supplied values would defeat the staleness invariant. The implementer MUST verify this absence is asserted by a contract test (SC-005).

## Validation rules (API boundary)

No new validation gates. `abstractOriginHash` is computed server-side from already-validated content; there's no caller-supplied input to validate beyond what spec 031 already covers (the length cap on `abstract` and `content` is unchanged).

The **staleness check** is read-side computation, not a validation gate:

```typescript
const isStale =
  node.abstract != null &&
  node.content != null &&
  node.abstractOriginHash != null &&
  node.contentHash != null &&
  node.abstractOriginHash !== node.contentHash;
```

(In practice the `null` checks on the hash columns are belt-and-suspenders — when abstract/content are non-null, the hash columns should also be populated by the write path. The defensive null check covers (a) legacy nodes from before this spec ships, and (b) future migration scenarios where a hash is intentionally cleared.)

## Hash computation — `src/lib/contentHash.ts` (NEW)

Per research D3:

```typescript
import { createHash } from 'crypto';

/**
 * Compute the canonical content fingerprint used by `Node.contentHash`
 * and `Node.abstractOriginHash`. SHA-256 truncated to the first 8 hex
 * chars. Returns `null` for empty / null input so the column-level
 * "no content → no hash" invariant holds without callers having to
 * branch on emptiness.
 *
 * The hash is over the PLAINTEXT content. On encrypted memories,
 * callers MUST compute the hash before invoking the encryption
 * envelope (see spec 032 FR-009).
 *
 * Spec 032 introduces this helper; spec 031's `contentHash` was
 * previously set externally (YAML frontmatter / Git sync) and now
 * uses the same function for server-side writes.
 */
export function computeContentHash(content: string | null | undefined): string | null {
  if (content == null || content === '') return null;
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}
```

Test fixtures will assert against known values, e.g.:
- `computeContentHash("hello") === createHash('sha256').update("hello").digest('hex').slice(0, 8)` → `2cf24dba`
- `computeContentHash("") === null`
- `computeContentHash(null) === null`

## Audit + soft-delete (FR-012 from spec 031 still applies)

No new audit logic. The existing audit columns (`createdAt/By`, `updatedAt/By`, `deletedAt/By`) auto-bump on any column update including `abstractOriginHash`. Updating only the hash is unusual (the hash is derived from content + abstract writes; it shouldn't be touched in isolation) but the audit fields handle it correctly.

Soft-delete: same as content/abstract — preserved on the tombstoned row; restored if/when the node is restored.

## What is NOT in this data model

- **No CHECK constraint** on `abstractOriginHash` format / length (it's machine-generated; a CHECK adds maintenance for no real protection).
- **No index** on `abstractOriginHash` or `contentHash` for staleness scans (research D10).
- **No derived `is_stale` column** (storage + sync-failure surface for negligible read-time savings).
- **No update to `Node.contentHash` write semantics** in this spec. `contentHash` continues to be set wherever it is today (importer, Git sync). If the implementer notices `contentHash` is unset on some server-side write paths, that's a pre-existing gap worth fixing in a separate change.
- **No new typed error class.** Staleness is observable, not throwable.
- **No new MCP tool.** Two existing read tools (`h-read-node`, `h-validate`) gain new output; no new tool surface.
