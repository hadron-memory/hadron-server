# Phase 0 Research — Spec 033 RAG vector retrieval

**Date**: 2026-06-01 · **Branch**: `033-rag-vector-retrieval-plan`

Resolves every NEEDS CLARIFICATION from Technical Context and records the technology decisions, each with rationale + alternatives. Grounded in a codebase survey (see "Codebase reality" below) so the plan builds on what exists rather than inventing patterns.

---

## Codebase reality (survey findings)

- **No embedding/vector code exists.** `grep` for embedding/vector/pgvector/cosine/similarity finds only forward-looking comments in `src/lib/contentHash.ts` and `src/lib/nodeCrypto.ts`. This is greenfield.
- **pgvector is NOT enabled.** `prisma/schema.prisma` datasource declares no `extensions`; the generator has no `postgresqlExtensions` preview feature; no migration runs `CREATE EXTENSION`. The Postgres image is `postgres:17-alpine` (docker-compose), which does **not** bundle pgvector.
- **Spec 024 memory-config is NOT built.** Only `Memory.isEncrypted` exists (`schema.prisma:548`). The 024 config columns are design-only. → Spec 033 lands its **own** config columns directly on `Memory` (the shape 024 intends), self-contained, not blocked on 024.
- **Write paths + the spec-031/032 hook point are well-defined.** `computeContentHash` (`src/lib/contentHash.ts:33`) is called on plaintext just before encryption at: `resolvers.ts:2767` (GraphQL `upsertNode`), `mcp/server.ts:1754` (`h-add-node`), `mcp/server.ts:1975` (`h-update-node`), `loadNodeFromFs.ts:76` (importer), and `restoreNodeVersion` (`resolvers.ts:4205`, verbatim). Embedding-marker maintenance mirrors this exact set.
- **Encryption seam.** `src/lib/nodeCrypto.ts` — GraphQL `upsertNode` decrypts existing content (`resolvers.ts:2760`), computes the hash on plaintext (`:2767`), then encrypts (`:2770-2788`). MCP handlers store plaintext on the row today (the #206 asymmetry, noted at `server.ts:1964-1967`). Plaintext is in-closure in every write handler.
- **`h-find-nodes`** (`mcp/server.ts:957-1110`) fetches nodes and filters **in memory** via `matchesQuery` (`:410-426`) over `name+loc+description+tags`; returns **plain text** via `textResult()` (`:66`). There is no JSON envelope and no shared code with the GraphQL `nodes` query (`resolvers.ts:1706`, which searches `name+description+content` via Prisma `contains`).
- **Async job pattern exists.** `src/jobs/cleanupAnonymousMemories.ts:27` (`startAnonymousMemoryCleanupLoop` = `setTimeout` initial delay → `setInterval`) and `src/jobs/janitorAssets.ts` (standalone-runnable). Started from `src/server.ts`. This is the template for the embedding worker.
- **Raw SQL is available.** The extended Prisma client (`src/integrations/db/client.ts`) supports `$queryRaw`/`$executeRaw` (not yet used) — required for pgvector inserts and similarity queries.
- **Stack**: TypeScript strict, Node 20 (Dockerfile) / ≥22 (constitution S1), Prisma 6.x + Postgres 17, Vitest against `hadron_test`.

---

## D-R1 — Embedding model: self-hosted `nomic-embed-text-v1.5` (768 dims)

**Decision**: Platform-fixed (D7), self-hosted embedding model **`nomic-embed-text-v1.5`**, **768 dimensions**, reached over HTTP at a configurable endpoint. Stored per-vector `model` id = `"nomic-embed-text-v1.5"`.

**Rationale**:
- **Privacy** (the deciding factor, chosen by the platform owner): no node content — including encrypted-memory plaintext — ever leaves Hadron's infrastructure at index time. A hosted API (OpenAI/Voyage) would transmit plaintext to a third party, an exposure beyond the DB-access-holder risk FR-026 already discloses; self-hosting removes it, so **FR-026 needs no transit addendum**.
- **Fit**: nomic-embed-text-v1.5 is Apache-2.0, strong on MTEB for its size, and has an **8192-token context** — comfortably covers ~512-token chunks and whole abstracts. Matryoshka training means dims can later be truncated (768→512/256) without re-training, if storage pressure appears.
- **Low ops**: served in dev by **Ollama** (`ollama pull nomic-embed-text`) and in prod by **HuggingFace Text-Embeddings-Inference (TEI)** or vLLM — a single small container/process. CPU-viable for this corpus size.

**Operational notes that affect correctness**:
- **Task prefixes are mandatory for nomic.** Documents must be embedded with a `search_document: ` prefix and queries with `search_query: `. The `EmbeddingClient` MUST apply the correct prefix per call-site (index vs query) or retrieval quality degrades sharply. Captured as a contract requirement (see `contracts/embedding-client.md`).
- **The Postgres server must have pgvector installed** (the `.so`), not just `CREATE EXTENSION` run. `postgres:17-alpine` lacks it → dev/test switch to the `pgvector/pgvector:pg17` image; prod (bare-metal Postgres on `alpha`) installs the `pgvector` package. **Infra prerequisite, flagged in quickstart + tasks.**

**Alternatives considered**:
- *OpenAI text-embedding-3-small (1536d)* / *Voyage 3.5 (1024d)* — cheaper to operate (no model server) and slightly higher quality, but both transmit plaintext to a third party at index time. Rejected for the privacy posture; either remains a clean future swap via the stored model id + re-embed path (FR-014).
- *bge-small-en-v1.5 (384d)* — lighter (smaller vectors, faster), viable alternative if the model server proves heavy; lower ceiling and a 512-token context (vs nomic's 8192). Kept as the documented fallback.

**Knobs** (env, per the CLAUDE.md env-var convention): `EMBEDDING_API_URL` (required when `vectorIndex` memories exist), `EMBEDDING_MODEL` (default `nomic-embed-text-v1.5`), `EMBEDDING_DIM` (default `768`, MUST equal the pgvector column dimension), `EMBEDDING_API_KEY` (optional, for an authenticated self-hosted endpoint).

---

## D-R2 — Vectors in pgvector; column `vector(768)`, HNSW + cosine

**Decision**: New `node_embeddings` table with a pgvector `vector(768)` column. Cosine distance (`<=>`), `vector_cosine_ops`, **HNSW** index. Enable pgvector via Prisma datasource `extensions = [vector]` + generator `previewFeatures = ["postgresqlExtensions"]`.

**Rationale**:
- pgvector keeps everything in the one Postgres (D3) — single backup, no new infra, and the interim queue rides the same DB.
- **HNSW over IVFFlat**: HNSW needs no training step and gives better recall/latency at this scale; IVFFlat requires a populated table to build good lists, awkward for an index that fills incrementally via the async worker.
- **Cosine** matches how sentence-embedding models (incl. nomic) are trained/normalized.
- The vector column is typed `Unsupported("vector(768)")` in Prisma (Prisma has no native vector type). **Inserts and similarity reads use raw SQL** (`$executeRaw`/`$queryRaw` with `$1::vector`); the model still exists in schema for migration generation, relations, and non-vector reads.
- The **HNSW index is not expressible in Prisma schema** → created in raw SQL in **both** `prisma/post-push.sql` (dev/test) and the migration (prod), exactly like the existing CHECK-constraint two-place convention (constitution S5).

**Alternatives**: a sidecar vector DB (Qdrant/pgvector-less) — rejected (D3, new infra). Storing vectors as `float[]` and computing distance in app — rejected (no index, O(n) scans).

---

## D-R3 — Async pipeline: durable markers on Node + setImmediate prompt-drain + sweep

**Decision**: Add durable markers to `Node` (`embeddingPendingAt`, `embeddingFailedAt`, `embeddingAttempts`, `embeddingError`). The write path sets `embeddingPendingAt` transactionally with the node write. A `setImmediate` **prompt-drain** embeds immediately after the response using **in-closure plaintext**. A periodic **sweep** (`setInterval`, mirroring `cleanupAnonymousMemories`) drains leftover markers for retries/restarts/backfill.

**Rationale**: satisfies D2/FR-005–FR-011. The durable marker is the recovery net (rejects lossy fire-and-forget); the prompt-drain is the fast path; the sweep covers what the prompt-drain misses (failures, restarts, opt-in-later backfill — backfill enqueues by stamping `embeddingPendingAt` on all of a memory's nodes). The job is transport-agnostic (FR-010): the sweep query + `embedNode(nodeId)` unit migrate to the message bus unchanged.

**The encryption reconciliation (load-bearing)** — how "async" (D2) and "embed plaintext" (D6/FR-027) coexist:
- The **prompt-drain** runs in the write handler's closure, so it holds the plaintext regardless of `isEncrypted` — it embeds correctly for **all** memories (incl. encrypted-via-GraphQL).
- The **sweep** re-reads the row. It works wherever the row holds plaintext: all non-encrypted memories, and encrypted memories written via **MCP** (plaintext-on-row today, #206). For an **encrypted-via-GraphQL** node whose prompt-drain embed failed *and* needs sweep recovery, the worker has ciphertext and no session key → it cannot embed. v1 leaves such a node marked `embeddingFailedAt` (diagnosable, surfaced by `h-validate`/a health count), and full recovery lands with the **#206 encryption-parity** follow-up that gives the worker a decrypt step. This is the documented v1 boundary; the common path (prompt-drain at write) covers encrypted memories already, so the gap is narrow.
- Self-hosted embeddings (D-R1) mean the plaintext handed to the model server never leaves Hadron infra — consistent with encrypting at rest.

**Concurrency / latest-wins** (spec Edge Case): every write re-stamps `embeddingPendingAt`. The worker, before writing vectors, re-reads the node and embeds the **current** content; an in-flight embed of superseded content is discarded on write (compare the content hash captured at embed-start vs. current, or simply let the latest re-stamp re-enqueue). Worker concurrency is single-loop in v1 (simplest; the corpus and rate don't need a pool); pooling/leasing is deferred (spec Assumption).

**Alternatives**: pure `setImmediate` fire-and-forget — rejected by the spec (data loss, no backfill). A full message-bus queue now — rejected (D2, too large to block IR).

---

## D-R4 — Chunking: in-house markdown-aware + fixed-size; char-offset locators

**Decision**: A small in-house `src/lib/chunking.ts`. Per node, auto-select: **structure-aware** (split on markdown headings `^#{1,6} `, then sub-split any section exceeding `chunkTokens` by fixed windows) when headings exist and `forceFixedSize` is off; otherwise **fixed-size token windows** with overlap. Defaults 512 tokens / 64 overlap. Each chunk records **character** `charStart`/`charEnd`, `chunkIndex`, and text (FR-016 — char offsets, not token offsets; stable across tokenizer changes).

**Rationale**: no heavyweight dependency (LangChain splitters) needed for this; markdown heading-splitting + windowing is ~100 lines and fully testable. Token counting for *sizing* uses a lightweight tokenizer (`gpt-tokenizer`/`js-tiktoken`, cl100k) — exactness isn't required since the **locators are character offsets**; the tokenizer only bounds window size. Re-chunk on content edit = delete this node's `kind='chunk'` rows and re-insert (FR-017).

**Alternatives**: LangChain `RecursiveCharacterTextSplitter` — more deps, less control; semantic chunking — explicitly v2 (D8).

---

## D-R5 — Query surface: extend `h-find-nodes`; raw-SQL vector search; RRF hybrid; in-process expand

**Decision**:
- Add `mode: 'keyword' | 'vector' | 'hybrid'` (absent ⇒ keyword, backward-compatible), `expand: number` (default 0), and `granularity: 'node' | 'chunk'` (default node) to the `h-find-nodes` zod schema (`mcp/server.ts:957`). Mirror on the GraphQL `nodes` query.
- **keyword**: unchanged path (`matchesQuery`).
- **vector**: embed the query (with `search_query:` prefix), run a raw-SQL similarity query scoped to the memory, join `nodes` for `deletedAt IS NULL` + access control, return ranked node ids (or chunk rows for `granularity:'chunk'`).
- **hybrid**: run keyword + vector, fuse by **Reciprocal-Rank Fusion**, `score = Σ 1/(k + rank)`, **k = 60** fixed platform-wide (FR-019).
- **expand**: in-process BFS over `outgoingEdges`/`incomingEdges` (undirected, all edge types) to depth `n`, neighbors **appended unscored** after ranked hits (FR-020).

**Result-envelope flags within a text tool** (FR-021): `h-find-nodes` returns plain text, so the typed `no_vector_index` reason is surfaced as a **dedicated annotation line** in the text result (e.g. a leading `Note: this memory has no vector index — enable memory.vectorIndex to use mode:vector. [no_vector_index]`), and for `mode:hybrid` a `Note: vector half unavailable (no vector index); showing keyword results only. [degraded:no_vector_index]` line above the keyword hits. The **GraphQL `nodes`** query exposes these as structured envelope fields (`reason`, `degraded`). Same contract, surfaced per transport.

**Rationale**: one search surface (D5, closes #206 gap 4). Vector needs DB-side ORDER BY (raw SQL) — distinct from the in-memory keyword path; that's fine, the tool dispatches by mode. RRF is the boring, dependency-free default.

**Alternatives**: a separate `h-search` tool — rejected (D5). Weighted-sum fusion needing score normalization across incomparable keyword/vector scores — rejected for RRF's rank-only robustness.

---

## D-R6 — Per-memory config as direct `Memory` columns + DB-backstopped invariants

**Decision**: Add config columns directly to `Memory`: `vectorIndexEnabled`, `embeddingSource` (new `EmbeddingSource` enum, default `abstract`), `chunkTokens`, `chunkOverlap`, `forceFixedSize`, `vectorIndexEncryptedAckAt`. Expose on the `Memory` GraphQL type + `createMemory`/`updateMemory` mutations. Back the invariants with Postgres CHECK constraints (constitution S5).

**Rationale**: spec 024 isn't built (survey), and spec 033 must not block on it; direct columns are exactly the shape 024 intends, so 024 can later absorb them without rework. CHECK constraints make the FR-026 "no silent indexing of encrypted memories" a **structural** guarantee, not just app logic:
- `chk_memory_vector_encrypted_ack`: `NOT (is_encrypted AND vector_index_enabled) OR vector_index_encrypted_ack_at IS NOT NULL` — an encrypted memory cannot have the index on without a recorded disclosure-acknowledgment.
- `chk_memory_chunk_tokens_positive` / `chk_memory_chunk_overlap_valid`: `chunk_tokens > 0`; `0 <= chunk_overlap < chunk_tokens`.

Typed errors (constitution S2/III) at the GraphQL boundary for the app-layer rejections that produce friendly messages: `EncryptedVectorIndexNotAcknowledgedError`, `InvalidChunkConfigError`.

**Alternatives**: a JSON `config` column — rejected (loses CHECK-constraint enforceability + typed querying); waiting for spec 024 — rejected (blocks IR).

---

## Resolved unknowns summary

| Unknown | Resolution |
|---|---|
| Embedding model + dimension | self-hosted `nomic-embed-text-v1.5`, 768d (D-R1) |
| Where vectors live | `node_embeddings` table, pgvector `vector(768)`, HNSW/cosine (D-R2) |
| Async transport | durable Node markers + setImmediate prompt-drain + setInterval sweep (D-R3) |
| Embed-on-encrypted | prompt-drain (in-closure plaintext) for all; sweep covers plaintext-on-row; GraphQL-encrypted sweep recovery deferred to #206 (D-R3) |
| Chunking | in-house markdown-aware + fixed-size, char-offset locators (D-R4) |
| Query API | `mode`/`expand`/`granularity` on `h-find-nodes` + GraphQL `nodes`; raw-SQL vector; RRF k=60 (D-R5) |
| Config home | direct `Memory` columns + CHECK constraints; not blocked on spec 024 (D-R6) |
| pgvector availability | Postgres image/package must include pgvector before `CREATE EXTENSION` (D-R1/D-R2) — infra prerequisite |
