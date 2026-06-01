---
description: "Task list for spec 033 — RAG vector retrieval"
---

# Tasks: RAG vector retrieval

**Input**: Design documents from `specs/033-rag-vector-retrieval/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: REQUIRED. Constitution Principle I mandates integration tests against `hadron_test` for every MCP tool + GraphQL mutation touching the graph/access-control; the spec's Success Criteria (SC-001..SC-010) are the test contracts. Test tasks are included per story.

**Organization**: by user story (spec.md US1–US5) for independent implementation/testing. Phases map to plan.md's 6 implementation slices.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete-task dependency)
- **[Story]**: US1–US5 (user-story phases only)
- Exact file paths included

## Path Conventions

Single web-service (hadron-server). Source at `src/`, schema at `prisma/`, tests at `src/test/`. Paths from plan.md "Project Structure".

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: pgvector availability + Prisma enablement + embedding env wiring. The pgvector prerequisite gates everything.

- [X] T001 [P] Switch the dev/test Postgres image from `postgres:17-alpine` to `pgvector/pgvector:pg17` in `docker-compose.yaml` (same data dir; required for `CREATE EXTENSION vector`)
- [X] T002 [P] Enable pgvector in `prisma/schema.prisma`: add `extensions = [vector]` to the `datasource db` block (and `previewFeatures = ["postgresqlExtensions"]` to `generator client` **if** `postgresqlExtensions` is still preview in the pinned Prisma `6.19.2` — verify; if GA, the flag is unneeded and may warn)
- [X] T003 [P] Add embedding env vars to `.env.example` and the CLAUDE.md env-var table — `EMBEDDING_API_URL`, `EMBEDDING_MODEL` (default `nomic-embed-text-v1.5`), `EMBEDDING_DIM` (default `768`), `EMBEDDING_API_KEY` (optional) — AND register them in **Doppler** (the prod/secrets source), not just `.env`
- [X] T004 **External / hadron-cloud (done 2026-06-01 via a different path than the task assumed).** Alpha's Postgres runs on bare metal, not in a Komodo-managed container, so the task's "switch the Postgres image" path wasn't applicable. Actual install: `apt-get install postgresql-17-pgvector` on the host + `CREATE EXTENSION IF NOT EXISTS vector` per database (Postgres 17, pgvector 0.8.0). Documented in [`baragaun-cloud/hosts/alpha/setup.md`](https://github.com/baragaun/baragaun-cloud/blob/main/hosts/alpha/setup.md) "Extensions — pgvector". The spec-033 migration `20260601120000_spec033_rag_vectors` initially failed pre-install with `extension "vector" is not available` (recorded `applied_steps_count=0`, full rollback); after package install + delete of the stale `_prisma_migrations` row, the migration re-applied cleanly on next container boot.

**Checkpoint**: pgvector available locally; Prisma can express the `vector` extension.

---

## Phase 2: Foundational (blocking prerequisites for ALL stories)

**Purpose**: the single schema migration (enums, Memory config columns, Node markers, `NodeEmbedding` table), CHECK constraints, the embedding client, typed errors. No user story can begin until this is done.

**⚠️ CRITICAL**: blocks Phase 3+.

- [X] T005 Add `EmbeddingSource` (`abstract` | `contentChunks @map("content_chunks")` | `both`) and `EmbeddingKind` (`abstract` | `chunk`) enums to `prisma/schema.prisma` (data-model.md §1–2)
- [X] T006 Add Memory config columns to the `Memory` model in `prisma/schema.prisma`: `vectorIndexEnabled` (DB `@default(false)` — the **class-derived default** is applied at createMemory, not in the column; see T033), `embeddingSource` (default `abstract`), `chunkTokens?`, `chunkOverlap?`, `forceFixedSize` (default false), `vectorIndexEncryptedAckAt?` (data-model.md §3)
- [X] T007 Add Node marker columns to the `Node` model in `prisma/schema.prisma`: `embeddingPendingAt?`, `embeddingFailedAt?`, `embeddingAttempts` (non-null `Int @default(0)`), `embeddingError?` (data-model.md §4)
- [X] T008 Add the `NodeEmbedding` model to `prisma/schema.prisma`: own `id`, `nodeId`/`memoryId`, `kind`, `provider`, `model`, `dim`, chunk locators (`chunkIndex?`/`charStart?`/`charEnd?`/`chunkText?`), `embedding Unsupported("vector(768)")`, relations with `onDelete: Cascade`, `@@unique([nodeId, kind, chunkIndex])`, `@@index([nodeId])`, `@@index([memoryId])` (data-model.md §5)
- [X] T009 Create the migration following the repo convention `prisma/migrations/<YYYYMMDDHHMMSS>_spec033_rag_vectors/migration.sql` (hand-authored header recording intent, per constitution II): `CREATE EXTENSION IF NOT EXISTS vector`; all columns (incl. `node_embeddings.provider`) + enums + `node_embeddings` table; HNSW index `USING hnsw (embedding vector_cosine_ops)` — **state the build params explicitly** (e.g. `WITH (m = 16, ef_construction = 64)`, pgvector defaults) so intent is pinned, not silently inherited; partial unique index `ON node_embeddings (node_id) WHERE kind='abstract'`; partial marker indexes (`WHERE embedding_pending_at IS NOT NULL`, `WHERE embedding_failed_at IS NOT NULL`); CHECK constraints `chk_memory_vector_encrypted_ack`, `chk_memory_chunk_tokens_positive`, `chk_memory_chunk_overlap_valid`
- [X] T010 Mirror the non-schema DDL (CREATE EXTENSION, HNSW + partial + abstract-unique indexes, the three CHECK constraints) into `prisma/post-push.sql` (dev/test path; constitution S5). **DDL-parity note**: this DDL now lives in three places (migration, `post-push.sql`, `globalSetup.ts`); T016 verifies presence on `hadron_test`. Consider a shared `.sql` fragment included by all three to prevent drift — tracked, not blocking.
- [X] T011 Update `src/test/globalSetup.ts` so `hadron_test` gets the full spec-033 surface: `CREATE EXTENSION vector`, the new columns/table (via the harness `db push`), the indexes, and the CHECK constraints (constitution S5)
- [X] T012 Apply the schema to **both** local DBs — `prisma db push` + `post-push.sql` on `hadron_dev`, and confirm `hadron_test` is built equivalently by `globalSetup.ts` (T011) — then regenerate the Prisma client. **Heads-up**: `embedding Unsupported("vector(768)")` is NOT readable/writable through the generated client; every embedding read/write goes through raw SQL (`$queryRaw`/`$executeRaw`, T023/T030/T041) — it intentionally won't appear as a typed field
- [X] T013 [P] Implement the `EmbeddingClient` HTTP impl in `src/lib/embedding/client.ts`: `embed(texts, purpose)` POSTing to `EMBEDDING_API_URL`, prepending the nomic prefix by `purpose` — exactly `search_document:` for documents and `search_query:` for queries — batching, optional `Authorization: Bearer`, and a returned-dimension == `dim` guard (throws on mismatch) — contracts/embedding-worker.md
- [X] T014 [P] Implement embedding config/factory in `src/lib/embedding/index.ts` (read env, construct the client, expose `model`/`dim`)
- [X] T015 [P] Add typed errors `EncryptedVectorIndexNotAcknowledgedError` and `InvalidChunkConfigError` to `src/lib/entityRef/errors.ts` (constitution S2/III)
- [X] T016 [P] Constraint-presence regression test in `src/test/integration/033-constraints.test.ts`: assert `chk_memory_vector_encrypted_ack`, `chk_memory_chunk_tokens_positive`, `chk_memory_chunk_overlap_valid`, and the `node_embeddings_abstract_uniq` partial index exist (constitution S5)
- [X] T017 [P] Unit test for `EmbeddingClient`, colocated at `src/lib/embedding/client.test.ts` (repo convention — unit tests sit next to their source): asserts the correct `search_document:`/`search_query:` prefix per purpose and dimension-mismatch rejection

**Checkpoint**: schema + pgvector + client ready. User stories can begin.

---

## Phase 3: User Story 1 — Semantic vector search over abstracts (Priority: P1) 🎯 MVP

**Goal**: opt a memory in → abstracts embedded async on write → `mode:vector` returns nodes ranked by meaning. End-to-end MVP.

**Independent Test**: opt a memory into `vectorIndexEnabled`, write nodes with distinct abstracts, let the worker drain, `h-find-nodes mode:vector query:"…"` ranks the semantically-closest node first (incl. a zero-keyword-overlap query).

### Tests for User Story 1 ⚠️ (write first, expect fail)

- [X] T018 [P] [US1] Integration test: semantic retrieval, ≥5 query/seed pairs incl. one zero-keyword-overlap (SC-001) in `src/test/integration/033-us1-vector-search.test.ts`
- [X] T019 [P] [US1] Integration test: write returns before `embedding_pending_at` is cleared — non-blocking (SC-002) in `src/test/integration/033-us1-nonblocking.test.ts`
- [X] T020 [P] [US1] Integration test: forced embed-API failure → retried under the attempts cap (SC-003) in `src/test/integration/033-us1-failure-recovery.test.ts`. "No node lost" = every affected node ends **either** embedded (marker cleared) **or**, after the cap, with `embedding_failed_at` set and surfaced via h-validate (T058) — the FR-009 durable-record sense, NOT "always embedded" (which would require the API to recover within the cap)
- [X] T021 [P] [US1] Integration test: opt-in after seeding → backfill sweep embeds existing nodes (SC-004) in `src/test/integration/033-us1-backfill.test.ts`
- [X] T022 [P] [US1] Integration test: `mode:vector` on an unindexed memory → empty + `[no_vector_index]` flag, not an error (SC-008) in `src/test/integration/033-us1-no-index.test.ts`

### Implementation for User Story 1

- [X] T023 [US1] Implement `upsertVectors` (abstract path) in `src/services/embedding/upsertVectors.ts`: raw-SQL `DELETE … WHERE node_id=$ AND kind='abstract'` then `INSERT … $1::vector` for the abstract embedding, storing `provider`/`model`/`dim` from the `EmbeddingClient`
- [X] T024 [US1] Implement `embedNode` in `src/jobs/embedNodes.ts`: resolve effective config, pick source text (in-closure plaintext or row), abstract embedding, **latest-wins** content-hash recheck, and **permanent (`encrypted-no-plaintext`) vs transient** failure handling per contracts/embedding-worker.md
- [X] T025 [US1] Implement `drainEmbeddingQueue` + `startEmbeddingWorkerLoop` in `src/jobs/embedNodes.ts` (select `WHERE embedding_pending_at IS NOT NULL`, attempts cap; mirrors `cleanupAnonymousMemories`) — depends on T024
- [X] T026 [US1] Implement write-path enqueue + `setImmediate` prompt-drain in `src/services/embedding/enqueue.ts` (set `embedding_pending_at` in the write; post-response embed with in-closure plaintext)
- [X] T027 [US1] Hook the marker/enqueue into GraphQL `upsertNode` and `restoreNodeVersion` in `src/api/graphql/schema/resolvers.ts`. **Anchor the plaintext seam to the symbol, not a line number**: the prompt-drain embed reuses the same plaintext that the existing `computeContentHash(...)` call in `upsertNode` runs on (that call site is, by construction, after `decryptNodeFields` and *before* `encryptNodeFieldsWithKey` — i.e. plaintext). Co-locate the enqueue there
- [X] T028 [US1] Hook the marker/enqueue into MCP `h-add-node` and `h-update-node` in `src/mcp/server.ts`, co-located with each handler's existing `computeContentHash(...)` plaintext call site (symbol-anchored, not line-numbered)
- [X] T029 [US1] Hook the marker + prompt-drain into the importer write. **Path-note**: the task originally pointed at `src/integrations/localFs/loadNodeFromFs.ts`, but that file only LOADS plaintext from disk — the importer DB write lives in `src/integrations/github/syncGraphFromGithub.ts` (the `tx.node.upsert` loop). Enqueue collected per-node during the transaction; drained as `void enqueueNodeEmbedding(...)` calls after the `$transaction` commits, mirroring the GraphQL/MCP fire-and-forget pattern. In-closure plaintext (`node.content`, `node.abstract` post-FR-013-reconcile) so encrypted memories embed at write time without the sweep needing a session key (FR-027 + #206).
- [X] T030 [US1] Implement `vectorSearch` node-level query in `src/services/embedding/vectorSearch.ts`: ANN inner query (HNSW-served `ORDER BY <=> LIMIT candidateK`) then dedupe/`MIN` to ranked node ids, joining `nodes` for `deleted_at IS NULL`, scoped `WHERE memory_id=$` (contracts/embedding-worker.md)
- [X] T031 [US1] Extend `h-find-nodes` in `src/mcp/server.ts`: add `mode` to the zod schema, dispatch `mode:vector`, embed the query (`search_query:` prefix), render ranked node hits, and emit the `[no_vector_index]` note line when the memory has no index (FR-021)
- [X] T032 [US1] Added the GraphQL `nodeSearch` query + `NodeSearchResult` envelope (`nodes`/`reason`/`degraded`) + `SearchMode` (keyword/vector/hybrid) and `SearchGranularity` (node/chunk) enums in `typeDefs.ts`; resolver in `resolvers.ts` mirrors `h-find-nodes mode:vector`. Out-of-scope inputs throw `GraphQLError(NOT_YET_IMPLEMENTED)` so the schema stays stable and the caller learns which slice each capability lands in: `mode:keyword`/`hybrid` → US3 (T050); `granularity:chunk` → US2 (T042); `expand>0` → US3 (T049). Legacy `nodes` query untouched.
- [X] T033 [US1] Extend `createMemory`/`updateMemory` in `resolvers.ts` to accept `vectorIndexEnabled`/`embeddingSource`, gate via access control, and stamp `embedding_pending_at` on all live nodes when enabling or changing source (backfill, FR-004/FR-008); add the Memory config read fields + mutation inputs to `typeDefs.ts`. **Class-derived default (FR-001)**: when `createMemory` does not receive an explicit `vectorIndexEnabled`, derive it — `true` for a `knowledge`-class, non-encrypted memory; `false` for every other class and for any encrypted memory. An integration test asserts: knowledge → on (nodes get embedded), `app`/`group`/`personal`/`private`/`system` → off, encrypted-knowledge → off
- [X] T034 [US1] Start `startEmbeddingWorkerLoop` from `src/server.ts`; add a startup warning when `vectorIndexEnabled` memories exist but `EMBEDDING_API_URL` is unset

**Checkpoint**: vector search works end-to-end on abstracts. MVP demoable.

---

## Phase 4: User Story 2 — Content-chunk retrieval (Priority: P2)

**Goal**: `embeddingSource: content-chunks|both` → content chunked (structure-aware/fixed-size) + embedded; node-level default, chunk-level passages opt-in.

**Independent Test**: structured doc chunks along sections, unstructured by fixed windows; `granularity:chunk` returns passages with char offset + chunk index + parent URN; dial changes move boundaries.

### Tests for User Story 2 ⚠️

- [ ] T035 [P] [US2] Integration test: chunk-level passages with correct char offset, chunk index, parent URN; node-level collapses same hits (SC-005) in `src/test/integration/033-us2-chunk-retrieval.test.ts`
- [ ] T036 [P] [US2] Integration test: auto strategy selection + `chunkTokens`/`chunkOverlap`/`forceFixedSize` change boundaries (SC-006) in `src/test/integration/033-us2-chunking.test.ts`
- [ ] T037 [P] [US2] Unit test for `chunkNode` (structure-aware vs fixed-size, overlap, char offsets), colocated at `src/lib/chunking.test.ts` (repo convention)

### Implementation for User Story 2

- [ ] T038 [P] [US2] Implement `chunkNode(content, {chunkTokens, chunkOverlap, forceFixedSize})` in `src/lib/chunking.ts`: markdown-heading structure-aware default + fixed-size token-window fallback (defaults 512/64), char-offset/`chunkIndex` locators (D-R4)
- [ ] T039 [US2] Extend `upsertVectors` (`src/services/embedding/upsertVectors.ts`) with the chunk path: delete+insert `kind='chunk'` rows carrying locators
- [ ] T040 [US2] Extend `embedNode` (`src/jobs/embedNodes.ts`) to honor `embeddingSource` `contentChunks`/`both` (chunk + abstract) and re-derive chunks on content edit (FR-017)
- [ ] T041 [US2] Add the chunk-level query to `vectorSearch` (`src/services/embedding/vectorSearch.ts`) returning passages (span + char offsets + parent URN), and the node-level collapse for chunk hits
- [ ] T042 [US2] Extend `h-find-nodes` (`src/mcp/server.ts`) with the `granularity` param and passage rendering (`[chunk N @ chars a–b]`); add `granularity` to `nodeSearch` in `typeDefs.ts`/`resolvers.ts`
- [ ] T043 [US2] Extend `createMemory`/`updateMemory` (`resolvers.ts`) with `chunkTokens`/`chunkOverlap`/`forceFixedSize` inputs + validation throwing `InvalidChunkConfigError`; add fields to `typeDefs.ts`

**Checkpoint**: chunk indexing + passage retrieval work; US1 still green.

---

## Phase 5: User Story 3 — One surface: keyword, vector, hybrid + expand (Priority: P2)

**Goal**: `mode: keyword|vector|hybrid` + `expand` on one tool; RRF fusion; graph expansion.

**Independent Test**: keyword vs semantic divergence test shows hybrid placing a both-signal node above single-signal; `expand:1` appends neighbors unscored.

### Tests for User Story 3 ⚠️

- [ ] T044 [P] [US3] Integration test: no-`mode` == keyword (snapshot) and `mode:hybrid` RRF ordering on divergent keyword/semantic relevance (SC-007) in `src/test/integration/033-us3-hybrid.test.ts`
- [ ] T045 [P] [US3] Integration test: `expand:1` appends undirected all-edge-type neighbors unscored after ranked hits; `mode:hybrid` on unindexed → keyword hits + `[degraded:no_vector_index]` in `src/test/integration/033-us3-expand-degraded.test.ts`
- [ ] T046 [P] [US3] Unit test for RRF determinism + keyword relevance ranking, colocated at `src/lib/rrf.test.ts` (repo convention)

### Implementation for User Story 3

- [ ] T047 [P] [US3] Implement `rrf.ts` in `src/lib/rrf.ts`: reciprocal-rank fusion, `k=60` fixed, taking pre-ranked keyword + vector lists
- [ ] T048 [US3] Add keyword relevance ranking for RRF (distinct query terms matched, then term frequency, `loc` tiebreak) in `src/mcp/server.ts` so fusion isn't biased by the alphabetical-by-`loc` default order
- [ ] T049 [US3] Implement the `expand: <depth>` BFS helper (undirected, all edge types, neighbors appended unscored) and wire into `h-find-nodes` (`src/mcp/server.ts`) and `nodeSearch` (`resolvers.ts`)
- [ ] T050 [US3] Wire `mode:keyword` (explicit) + `mode:hybrid` dispatch + `[degraded:no_vector_index]` flag into `h-find-nodes` (`src/mcp/server.ts`) and `nodeSearch` (`resolvers.ts`)

**Checkpoint**: all three modes + expand work on both MCP and GraphQL.

---

## Phase 6: User Story 4 — Staleness served-and-marked on vector hits (Priority: P3)

**Goal**: stale abstract-vector hits served + marked (spec 032 predicate, abstract-only); chunk hits unmarked; self-heal via re-embed-on-write.

**Independent Test**: content-only edit → stale-marked hit before re-embed drains → marker clears after drain; chunk hits never marked.

### Tests for User Story 4 ⚠️

- [X] T051 [P] [US4] Integration test at `src/test/integration/033-us4-staleness.test.ts` covering: stale node → hit returned + `Source: abstract-stale`; fresh + legacy null-hash nodes → no marker; self-heal after re-embed; encrypted-memory hit still marked (FR-025: write-time plaintext stamping means the predicate is computable even without read-time decryption — spec 032's `!memory.isEncrypted` gate is intentionally NOT applied here). Chunk-hits-don't-carry-it is vacuous in US1 (no chunks yet); US2 will revise once `vectorSearchNodes` surfaces hit kind.
- [X] T052 [US4] Implemented in `src/mcp/server.ts` h-find-nodes vector render. Four-clause predicate mirrors spec 032 (abstract + content non-empty, `abstractOriginHash != null`, `abstractOriginHash !== computeContentHash(node.content)`), plus a defensive `!isCiphertext(content)` so GraphQL-encrypted rows (ciphertext at rest, #206) fall through quietly rather than false-positive. Marker emits as a `Source: abstract-stale` line right after the hit's score line. GraphQL `nodeSearch` envelope unchanged — clients can compute per-Node staleness from the existing `abstractOriginHash` + `content` fields (the text-marker contract in `contracts/h-find-nodes.md` is MCP-only).

**Checkpoint**: staleness signal on vector hits; self-healing verified.

---

## Phase 7: User Story 5 — Encrypted-memory opt-in, disclosed (Priority: P3)

**Goal**: encrypted memories indexable only behind an explicit, disclosed acknowledgment; revoke removes vectors + clears markers; #206 sweep boundary surfaced.

**Independent Test**: enabling on encrypted without ack → `EncryptedVectorIndexNotAcknowledgedError`; with ack → indexed; un-acked stores nothing; revoke removes vectors.

### Tests for User Story 5 ⚠️

- [ ] T053 [P] [US5] Integration test: enable-on-encrypted without ack errors; with `acknowledgeVectorInversionRisk` succeeds + sets `vectorIndexEncryptedAckAt`; un-acked stores no vectors; revoke removes vectors + clears markers (SC-010) in `src/test/integration/033-us5-encrypted.test.ts`

### Implementation for User Story 5

- [ ] T054 [US5] Extend `createMemory`/`updateMemory` (`resolvers.ts`): when enabling on an `isEncrypted` memory, require `acknowledgeVectorInversionRisk: true` (set `vectorIndexEncryptedAckAt = now()`) else throw `EncryptedVectorIndexNotAcknowledgedError`; include the four-point disclosure text (contracts/memory-config.md); add the input to `typeDefs.ts`
- [ ] T055 [US5] Implement revoke/disable in `resolvers.ts`: on `vectorIndexEnabled → false`, delete the memory's `node_embeddings` rows AND null `embeddingPendingAt`/`embeddingFailedAt`/`embeddingError` and **reset `embeddingAttempts` to `0`** (it's a non-null Int — clearing to null would violate the schema) on its nodes, so the worker stops selecting them
- [ ] T056 [US5] Verify (no new code): assert the `embedNode` encrypted-via-GraphQL **permanent-failure** path (`encrypted-no-plaintext (#206)`) from T024 clears pending + sets failed without retry, and confirm it's exercised by the T053 test — re-tagged as a verification step so it isn't silently checked off

**Checkpoint**: encrypted opt-in gated + disclosed; revocation complete.

---

## Phase 8: Polish & cross-cutting

- [ ] T057 [P] Add a hadron-docs page (and `typeDefs` doc-comments final pass) for the vector-index config + the encrypted-memory inversion disclosure (constitution II). MUST also carry the two spec MUSTs: the **FR-028 abstract-population steering** ("default `abstract` source needs client-authored abstracts; steer credit-constrained / abstract-less corpora to `content-chunks`") and the **FR-029 interim-queue tech-debt** forward-link to the message-bus work
- [ ] T058 [P] Surface embedding-failure diagnosability in `h-validate` (`src/mcp/server.ts`): report nodes with `embedding_failed_at` set (incl. the #206 permanent-failure class) so an empty index is diagnosable
- [ ] T059 [P] Performance sanity: `EXPLAIN ANALYZE` confirms the HNSW index serves the vector query (no full scan) — record in quickstart.md
- [ ] T060 [P] Verify the runtime Node version is ≥ 22 (constitution S1) and bump the Dockerfile base image if still `node:20`
- [ ] T061 Run the quickstart.md smoke test end-to-end against `hadron_dev` (Ollama + nomic-embed-text)
- [ ] T062 [P] Track a latency/throughput benchmark (follow-up, post-MVP) for vector + hybrid search at realistic N (e.g. ~100k embeddings/memory) — SC-002's "same latency envelope" is asserted only at small-N in the integration tests; tracked follow-up, not in the MVP critical path (couples to the deferred cost-control concern)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: T001–T003 parallel; T004 is external (hadron-cloud) and gates only prod deploy, not local dev/tests.
- **Foundational (P2)**: depends on Setup. T005–T008 (schema edits, same file → sequential) → T009 (migration) → T010/T011 (post-push + globalSetup) → T012 (db push + generate). T013–T017 [P] alongside once the client compiles. **Blocks all user stories.**
- **User Stories (P3–P7)**: all depend on Foundational. US1 is the spine (worker + search + config); US2–US5 extend US1's services/handlers.
- **Polish (P8)**: after the desired stories.

### User-story dependencies

- **US1 (P1)**: after Foundational. Self-contained MVP.
- **US2 (P2)**: extends US1's `upsertVectors`/`embedNode`/`vectorSearch`/`h-find-nodes`/config — sequence after US1 (shared files).
- **US3 (P2)**: extends US1's search dispatch + adds `rrf.ts` — after US1 (independent of US2; `rrf.ts` is parallelizable).
- **US4 (P3)**: extends US1/US2 result rendering — after US1 (US2 if testing chunk-unmarked).
- **US5 (P3)**: extends US1's config mutation — after US1.

### Within a story

- Tests first (expect fail) → services → handlers/resolvers → integration. Same-file tasks are sequential; different-file tasks marked [P].

### Parallel opportunities

- Setup T001–T003; Foundational T013–T017; each story's test tasks; `chunking.ts` (T038), `rrf.ts` (T047) are standalone-parallel within their stories.
- After Foundational, US3's `rrf.ts`/`chunking.ts`-independent pieces can progress alongside US1 if staffed; but US2–US5 mostly touch US1's files, so default to sequential by priority.

---

## Implementation strategy

### MVP first (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL — pgvector + schema + client) → 3. Phase 3 US1 → **STOP & validate** semantic search end-to-end → demo.

### Incremental delivery

US1 (MVP) → US2 (chunks) → US3 (hybrid/keyword/expand) → US4 (staleness) → US5 (encrypted opt-in). Each is an independently testable increment that doesn't break the prior.

### Notes

- [P] = different files, no incomplete-task dependency. Most US2–US5 tasks touch files US1 created, so they are NOT [P] across stories.
- pgvector availability (T001/T004) is the one hard external gate — do it first.
- Commit per task or logical group; stop at any checkpoint to validate a story independently.
- Constitution: integration tests against `hadron_test` (which now `CREATE EXTENSION vector` in globalSetup); typed errors at the GraphQL boundary; CHECK constraints in all three places + regression test (T016); no raw backticks in `typeDefs.ts` doc-comments.
