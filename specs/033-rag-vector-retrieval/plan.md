# Implementation Plan: RAG vector retrieval

**Branch**: `033-rag-vector-retrieval-plan` | **Date**: 2026-06-01 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/033-rag-vector-retrieval/spec.md`

## Summary

Add vector/semantic retrieval over Hadron memory. A memory opts into a vector index; the platform embeds each node's **abstract** (default) and/or **content chunks** **asynchronously on write** using a **self-hosted** embedding model (`nomic-embed-text-v1.5`, 768-dim), storing vectors in **Postgres + pgvector**; clients retrieve by meaning through a new `mode: vector | keyword | hybrid` parameter on the **existing** `h-find-nodes` tool (plus a GraphQL `nodeSearch`). Staleness is served-and-marked (abstract-only, reusing spec 032). Encrypted-memory indexing is opt-in behind a disclosed acknowledgment, backstopped by a CHECK constraint. The async transport is an interim durable-marker queue on Postgres (tracked tech-debt, migrates to the message bus later).

Approach is grounded in a codebase survey ([research.md](./research.md)): greenfield for embeddings/pgvector; reuses the spec-031/032 write-path hook points, the `cleanupAnonymousMemories` job pattern, and the existing `h-find-nodes` surface.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js ≥ 22 (constitution S1; Dockerfile currently node:20 — bump tracked)
**Primary Dependencies**: Prisma 6.x + PostgreSQL 17 **+ pgvector**; GraphQL (existing schema/resolver layer); `@modelcontextprotocol/sdk` (MCP); a tokenizer for chunk sizing (`gpt-tokenizer`/`js-tiktoken`); self-hosted embedding model server (Ollama dev / TEI prod) reached over HTTP
**Storage**: Postgres `hadron_dev` / `hadron_test` (`prisma db push` + `post-push.sql`); new `node_embeddings` table (pgvector `vector(768)`, HNSW/cosine); new `Memory` config columns + `Node` marker columns
**Testing**: Vitest against `hadron_test` (real Postgres + pgvector); integration tests for every MCP tool + GraphQL mutation touched (constitution I)
**Target Platform**: Linux server (the LX container; prod bare-metal Postgres on `alpha`)
**Project Type**: single web-service (hadron-server)
**Performance Goals**: writes never blocked by embedding (SC-002); vector top-K via HNSW index (sub-second at this corpus scale)
**Constraints**: no plaintext leaves Hadron infra (self-hosted embeddings); eventual consistency accepted; single platform-fixed model/dimension in flight (FR-013)
**Scale/Scope**: single-customer MVP corpus; single-loop worker sufficient (pooling deferred)

## Constitution Check

*GATE: re-checked after Phase 1 design — PASS with two documented notes.*

| Item | Status |
|---|---|
| **I — Pragmatic test-first (server scope)** | PASS. `h-find-nodes` extension (MCP contract boundary), `createMemory`/`updateMemory` config (Memory mutation), the embedding worker, and vector search all get integration tests against `hadron_test` (which must `CREATE EXTENSION vector` in `globalSetup.ts`). Unit tests for chunking/RRF/prefix. See [quickstart.md](./quickstart.md) test plan. |
| **II — Docs-concurrent** | PASS. `typeDefs.ts` doc-comments updated for the new `Memory` fields + `nodeSearch` in the same PR; migration intent recorded in the migration header. |
| **III / S2 — Typed-error boundary** | PASS. New typed errors `EncryptedVectorIndexNotAcknowledgedError`, `InvalidChunkConfigError` (join `src/lib/entityRef/errors.ts` pattern). The "no vector index" condition is a flagged **result**, not an error (by design). No raw Prisma escapes — config validation + raw-SQL vector ops wrapped. |
| **V — Zero-trust enforcement** | PASS. Vector/hybrid/expand go through the existing memory read-access gate; similarity SQL is `WHERE memory_id = $caller-readable`; config mutations gated like other `updateMemory` fields. **Note**: spec defers embedding **cost-control/rate-limiting**, which the constitution calls a server concern — acceptable as an explicit v1 deferral (spec Assumptions/Reserved), flagged here. |
| **S1 — Stack pin** | PASS. TS/Prisma/Postgres/Vitest/GraphQL unchanged; pgvector is a Postgres **extension**, not a stack swap. Node bump to ≥22 already required by S1. |
| **S3 — `typeDefs.ts` single backtick literal** | PASS (constraint noted for implementers: no raw backticks in new doc-comments). |
| **S4 — Composite-PK → MODELS_WITHOUT_ID** | N/A. `NodeEmbedding` has its own `id` (not composite-PK). No change to `MODELS_WITHOUT_ID`. |
| **S5 — CHECK constraints in `post-push.sql` (+ migration + globalSetup + regression test)** | PASS. `chk_memory_vector_encrypted_ack`, `chk_memory_chunk_tokens_positive`, `chk_memory_chunk_overlap_valid`, the HNSW index, partial marker indexes, and `CREATE EXTENSION vector` all live in `post-push.sql` AND the migration AND `globalSetup.ts`, with a regression test asserting constraint presence. |
| **S6 — CI grep gates** | N/A (no new grep-gated invariant). |
| **Spec Workflow (specs live in `spec-kits/`)** | **DEVIATION (pre-existing, not introduced here).** The constitution's Spec Workflow says server specs live under `spec-kits/specs/`. In current practice specs 031, 032, and 033 live in-repo under `hadron-server/specs/` (per CLAUDE.md + dev `start-here`). Per the constitution's "unresolved tension MUST be called out in plan.md" clause, recording it here: this plan follows the established in-repo precedent of 031/032; reconciling the constitution text with practice is a separate housekeeping item, out of scope for spec 033. |

No unjustified violations → **gate passes**.

## Project Structure

### Documentation (this feature)

```text
specs/033-rag-vector-retrieval/
├── plan.md              # this file
├── research.md          # Phase 0 — decisions D-R1..D-R6
├── data-model.md        # Phase 1 — schema additions
├── contracts/
│   ├── h-find-nodes.md      # extended search surface
│   ├── memory-config.md     # per-memory config GraphQL
│   └── embedding-worker.md  # worker + EmbeddingClient + vector SQL
├── quickstart.md        # Phase 1 — dev setup + smoke + test plan
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source code (new + touched)

```text
prisma/
├── schema.prisma                         # +EmbeddingSource/EmbeddingKind enums, Memory config cols,
│                                         #  Node marker cols, NodeEmbedding model, pgvector enablement
├── post-push.sql                         # +CREATE EXTENSION vector, HNSW index, partial idx, CHECKs
└── migrations/<ts>_spec033_rag/migration.sql

src/
├── lib/
│   ├── embedding/
│   │   ├── client.ts                     # EmbeddingClient (HTTP, nomic prefixes, dim guard)
│   │   └── index.ts                      # env wiring (EMBEDDING_API_URL/MODEL/DIM/KEY)
│   ├── chunking.ts                       # structure-aware + fixed-size chunker (char offsets)
│   ├── rrf.ts                            # reciprocal-rank fusion (k=60)
│   └── entityRef/errors.ts               # +EncryptedVectorIndexNotAcknowledgedError, +InvalidChunkConfigError
├── jobs/
│   └── embedNodes.ts                     # drainEmbeddingQueue + startEmbeddingWorkerLoop + embedNode
├── services/embedding/
│   ├── enqueue.ts                        # set markers on write; setImmediate prompt-drain
│   ├── upsertVectors.ts                  # raw-SQL delete+insert of node_embeddings
│   └── vectorSearch.ts                   # raw-SQL similarity (node + chunk granularity) + expand BFS
├── mcp/server.ts                         # h-find-nodes: +mode/expand/granularity dispatch + flags
├── api/graphql/schema/
│   ├── typeDefs.ts                       # Memory config fields; nodeSearch + enums; doc-comments
│   └── resolvers.ts                      # create/updateMemory config; nodeSearch resolver;
│                                         #  embedding-marker hooks in upsertNode + restoreNodeVersion
├── integrations/localFs/loadNodeFromFs.ts# importer: stamp embedding marker
├── server.ts                             # start the embedding worker loop
└── test/
    ├── globalSetup.ts                    # CREATE EXTENSION vector + index/constraints
    └── integration/033-*.test.ts         # per the quickstart test plan
```

**Structure Decision**: single web-service (hadron-server), extending existing `src/` layout. New embedding concerns grouped under `src/lib/embedding`, `src/jobs`, `src/services/embedding`; everything else hooks into existing files.

## Implementation phasing (maps user stories → buildable slices)

1. **Foundation** (blocks all): pgvector enablement + image bump; schema (`NodeEmbedding`, Memory/Node columns, enums); `post-push.sql` + migration + `globalSetup`; CHECK constraints + regression test; `EmbeddingClient`; env wiring.
2. **US1 (P1) — vector over abstracts** (MVP): write-path markers + prompt-drain + worker loop + sweep + backfill; `upsertVectors` (abstract); `vectorSearch` (node-level); `h-find-nodes mode:vector` + `no_vector_index` flag; config mutation (`vectorIndexEnabled`). → SC-001/002/003/004/008.
3. **US2 (P2) — content chunks**: `chunking.ts`; `embeddingSource` contentChunks/both; chunk rows; `granularity:chunk` passages; chunk dials + validation. → SC-005/006.
4. **US3 (P2) — unified surface**: `mode:keyword|hybrid`, RRF, `expand` BFS; GraphQL `nodeSearch` parity. → SC-007.
5. **US4 (P3) — staleness**: reuse spec 032 predicate on abstract hits; mark + self-heal; chunk hits unmarked. → SC-009.
6. **US5 (P3) — encrypted opt-in**: disclosure + `acknowledgeVectorInversionRisk` + `vectorIndexEncryptedAckAt` + CHECK; revoke-removes-vectors; encrypted-via-GraphQL sweep boundary (#206). → SC-010.

Each slice is independently testable per the spec's Independent Test definitions.

## Key risks / watch-items

- **pgvector availability** is an infra prerequisite (image/package) — gate Foundation on it (quickstart §0). **Prod ownership**: the pgvector package install on the prod host is to be done via **hadron-cloud** (infra-as-code), not a manual one-off on `alpha` — sequence that hadron-cloud change before the prod migration runs.
- **nomic task prefixes** (`search_document:`/`search_query:`) are correctness-critical — unit-tested.
- **Encrypted-via-GraphQL sweep recovery** is bounded by #206 — documented boundary, not a blocker (prompt-drain covers the common path).
- **Cost-control deferral** vs constitution V's "rate-limits are server concerns" — explicit v1 deferral, flagged above.
- **`nodeSearch` vs evolving `nodes`** — choose at `/tasks` based on whether any external caller depends on `nodes`' exact `[Node!]!` return type.

## Complexity Tracking

No constitution violations requiring justification. The one deviation (spec location) is pre-existing and documented above, not a new complexity introduced by this feature.
