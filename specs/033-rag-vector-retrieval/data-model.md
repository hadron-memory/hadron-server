# Data Model — Spec 033 RAG vector retrieval

**Authoritative source**: `hadron-server/prisma/schema.prisma`. This document is the design map; the schema + migration are the contract. All new columns are additive; no existing column changes shape or semantics.

---

## 1. New enum — `EmbeddingSource`

```prisma
enum EmbeddingSource {
  abstract                              // default — embed Node.abstract
  contentChunks  @map("content_chunks") // embed content chunks
  both                                  // embed both
}
```

Mirrors the existing `MemoryClass`/`MemoryVisibility` enum style (`schema.prisma:193,252`). `@map` keeps the DB value snake_case.

## 2. New enum — `EmbeddingKind`

```prisma
enum EmbeddingKind {
  abstract   // one row per node — vector of Node.abstract
  chunk      // N rows per node — vector of one content chunk
}
```

---

## 3. `Memory` — new config columns (spec 024 shape, landed here; D-R6)

Added to the `Memory` model (`schema.prisma:483`). All nullable/defaulted; existing rows are unaffected (index off by default).

```prisma
  /// 033 — opt-in: when true, this memory's nodes are vector-indexed.
  /// DB default is `false` (safe); the **class-derived default** is applied at
  /// createMemory — a `knowledge`-class, non-encrypted memory is created with
  /// `true`; all other classes and any encrypted memory stay `false` (FR-001).
  /// Always individually flippable thereafter.
  vectorIndexEnabled        Boolean          @default(false) @map("vector_index_enabled")
  /// 033 — what the vector index is built from. Memory property, NOT a
  /// query parameter (D1/FR-002). Only meaningful when vectorIndexEnabled.
  embeddingSource           EmbeddingSource  @default(abstract) @map("embedding_source")
  /// 033 — per-memory chunking dials (FR-003). NULL ⇒ platform default
  /// (512 / 64). Only consulted when embeddingSource includes chunks.
  chunkTokens               Int?             @map("chunk_tokens")
  chunkOverlap              Int?             @map("chunk_overlap")
  /// 033 — force fixed-size chunking, bypassing structure-aware (FR-015).
  forceFixedSize            Boolean          @default(false) @map("force_fixed_size")
  /// 033 — timestamp the owner acknowledged the embedding-inversion
  /// disclosure for an ENCRYPTED memory (FR-026). NULL ⇒ not acknowledged.
  /// Gates encrypted-memory indexing via chk_memory_vector_encrypted_ack.
  vectorIndexEncryptedAckAt DateTime?        @map("vector_index_encrypted_ack_at")

  embeddings NodeEmbedding[]   // back-relation (denormalized memoryId on NodeEmbedding)
```

### CHECK constraints (constitution S5 — in `post-push.sql` + migration + `globalSetup.ts` + a regression test)

| Name | Predicate | Enforces |
|---|---|---|
| `chk_memory_vector_encrypted_ack` | `NOT (is_encrypted AND vector_index_enabled) OR vector_index_encrypted_ack_at IS NOT NULL` | FR-026 — an encrypted memory cannot have the index enabled without a recorded disclosure acknowledgment (structural "no silent indexing"). |
| `chk_memory_chunk_tokens_positive` | `chunk_tokens IS NULL OR chunk_tokens > 0` | FR-003 sanity |
| `chk_memory_chunk_overlap_valid` | `chunk_overlap IS NULL OR (chunk_overlap >= 0 AND (chunk_tokens IS NULL OR chunk_overlap < chunk_tokens))` | overlap must be < window |

---

## 4. `Node` — new durable embedding-state markers (D-R3)

Added to the `Node` model (`schema.prisma:721`), adjacent to `abstractOriginHash`. Drive the async queue, sweep, and backfill.

```prisma
  /// 033 — set when this node needs (re-)embedding; cleared on success.
  /// Durable marker drained by the embedding worker (FR-006/FR-007).
  embeddingPendingAt  DateTime? @map("embedding_pending_at")
  /// 033 — set when an embed attempt failed; retried by the sweep (FR-009).
  embeddingFailedAt   DateTime? @map("embedding_failed_at")
  /// 033 — attempt counter for backoff / give-up diagnostics.
  embeddingAttempts   Int       @default(0) @map("embedding_attempts")
  /// 033 — last embed error (diagnosability; surfaced by h-validate).
  embeddingError      String?   @map("embedding_error")

  embeddings NodeEmbedding[]
```

### Indexes (partial — created in raw SQL, post-push.sql + migration)

```sql
CREATE INDEX IF NOT EXISTS nodes_embedding_pending_idx ON nodes (embedding_pending_at) WHERE embedding_pending_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS nodes_embedding_failed_idx  ON nodes (embedding_failed_at)  WHERE embedding_failed_at  IS NOT NULL;
```

Partial indexes keep the sweep's "find work" query cheap (it scans only marked rows).

**NodeVersion**: embedding markers are **live-only operational state**, NOT versioned content — `NodeVersion` is deliberately NOT extended (unlike `abstract`/`abstractOriginHash`). Rationale: an embedding marker describes the index's catch-up state at a moment, not a snapshot of authored content; restoring an old version re-stamps `embeddingPendingAt` through the normal write path anyway. (Documented so the spec-031 "curated subset" lesson isn't mis-applied here.)

---

## 5. New table — `NodeEmbedding` (vectors for abstracts + chunks; D-R2)

```prisma
model NodeEmbedding {
  id        String        @id @default(cuid())
  nodeId    String        @map("node_id")
  /// Denormalized for fast per-memory similarity filtering (the search
  /// query filters by memory before ORDER BY distance).
  memoryId  String        @map("memory_id")
  kind      EmbeddingKind
  /// Stored embedding provider — e.g. "local" | "openai" | "voyage". Sibling
  /// to `model`; disambiguates provenance and makes a provider/model swap
  /// (re-embed) auditable and filterable. v1 is always "local".
  provider  String
  /// Stored model id (FR-014) — e.g. "nomic-embed-text-v1.5". Forward-compat
  /// for a deliberate re-embed when the platform model changes.
  model     String
  /// Vector dimension (sanity / forward-compat guard).
  dim       Int
  // ── chunk-only locators (NULL for kind = abstract); FR-016 ──
  chunkIndex Int?         @map("chunk_index")
  charStart  Int?         @map("char_start")
  charEnd    Int?         @map("char_end")
  chunkText  String?      @map("chunk_text")
  // ── the vector — pgvector; Prisma has no native type ──
  embedding  Unsupported("vector(768)")
  createdAt  DateTime     @default(now()) @map("created_at")

  node   Node   @relation(fields: [nodeId], references: [id], onDelete: Cascade)
  memory Memory @relation(fields: [memoryId], references: [id], onDelete: Cascade)

  @@unique([nodeId, kind, chunkIndex])  // dedupes CHUNK rows. NOTE: abstract rows have
                                        // chunkIndex = NULL, and Postgres treats NULLs as
                                        // distinct — so this does NOT dedupe abstract rows.
                                        // Abstract uniqueness is enforced by a partial unique
                                        // index (below) instead.
  @@index([nodeId])
  @@index([memoryId])
  @@map("node_embeddings")
}
```

- **Own `id`** → NOT a composite-PK model → no `MODELS_WITHOUT_ID` change (constitution S4 N/A).
- **Writes use raw SQL** (`$executeRaw … $1::vector`) because Prisma can't bind the `Unsupported` vector type. Reads of non-vector columns can use the Prisma client; similarity reads use `$queryRaw`.
- **Re-index a node** = `DELETE FROM node_embeddings WHERE node_id = $1 AND kind = $2` then insert fresh (FR-004/FR-017). `onDelete: Cascade` cleans up when a node is hard-deleted.
- **One abstract vector per node** (kind=abstract, chunkIndex NULL); **N chunk vectors** (kind=chunk, chunkIndex 0..n-1).

### HNSW index (raw SQL — post-push.sql + migration; Prisma can't express it)

```sql
CREATE INDEX IF NOT EXISTS node_embeddings_embedding_hnsw
  ON node_embeddings USING hnsw (embedding vector_cosine_ops);

-- One abstract vector per node. The @@unique above can't enforce this
-- (NULL chunkIndex ⇒ NULLs distinct in Postgres), so a partial unique index does.
CREATE UNIQUE INDEX IF NOT EXISTS node_embeddings_abstract_uniq
  ON node_embeddings (node_id) WHERE kind = 'abstract';
```

---

## 6. pgvector enablement (D-R2)

```prisma
generator client {
  provider        = "prisma-client-js"
  output          = "../src/generated/prisma"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}
```

Plus, in the migration **and** `post-push.sql` **and** `src/test/globalSetup.ts`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Infra prerequisite** (D-R1): the Postgres server must have the pgvector library installed — `pgvector/pgvector:pg17` image for dev/test (replacing `postgres:17-alpine`), pgvector package on the prod host. `CREATE EXTENSION` fails otherwise.

---

## 7. Entity relationships (new)

```
Memory ─┬─ (config) vectorIndexEnabled, embeddingSource, chunk dials, encrypted-ack
        └─1───∞─ NodeEmbedding   (denormalized memoryId; per-memory similarity scope)

Node ───┬─ (markers) embeddingPendingAt / embeddingFailedAt / attempts / error
        └─1───∞─ NodeEmbedding   (1 abstract row + N chunk rows; Cascade delete)
```

## 8. State: a node's embedding lifecycle

```
write (abstract/content changed, memory.vectorIndexEnabled)
   └─ set embedding_pending_at = now()  ───────────────►  [PENDING]
        │                                                    │
   setImmediate prompt-drain (in-closure plaintext)          │ periodic sweep
        │  success                       failure             │ (rows still PENDING/FAILED)
        ▼                                   ▼                 ▼
   write vectors, clear markers      set embedding_failed_at, attempts++, error
        │                                   │
        ▼                                   └─ retried by next sweep ─► (PENDING)
   [INDEXED]  ◄── re-stamped PENDING on any later content/abstract edit (latest-wins)
```

## 9. What is NOT changed

- `Node.contentHash`, `Node.abstractOriginHash` — untouched (032's domains preserved). The staleness predicate the search reuses is read-time `abstractOriginHash != computeContentHash(node.content)` (FR-023), abstract-only.
- `NodeVersion` — not extended (markers are operational, §4).
- Existing `h-find-nodes` keyword behavior, `matchesQuery`, and the default (no-`mode`) result shape — unchanged (FR-018, SC-007).
