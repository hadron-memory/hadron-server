---
target-repositories:
  - hadron-server
---

# Feature Specification: RAG vector retrieval — semantic search over Hadron memory

- **Feature Branch**: `033-rag-vector-retrieval`
- **Created**: 2026-05-31
- **Status**: Draft
- **Input**: User description: promote the long-standing RAG / vector-search work into an implementable spec, built on the closed design discussion at `hadron-concept/design-discussions/information-retrieval/2026-05-31-rag-vector-retrieval/` (nine settled decisions D1–D9, adversarial round survived). Adds vector/semantic retrieval over Hadron memory using Postgres + pgvector, an async embedding worker, a `mode` parameter on `h-find-nodes`, and per-memory indexing config — building on `Node.abstract` (spec 031) and `Node.abstractOriginHash` (spec 032).

## Background

Specs 031 (`Node.abstract`) and 032 (`Node.abstractOriginHash`) both named "the upcoming RAG / vector layer" as their downstream consumer. Spec 031 created a clean paragraph-length summary per node; spec 032 made that summary's staleness observable. The two were sequenced under the working bet that **v1 RAG embeds abstracts, not content**. The design discussion that seeds this spec promoted the long-standing chunking-and-vector-search stub into a real discussion to decide *how* to build RAG on that substrate — and deliberately overturned the abstract-only bet.

Today Hadron retrieval is keyword-only: `h-find-nodes` does substring matching across name/loc/description/tags (not semantic, no fuzzy match). A client asking "find nodes about X" gets only nodes that literally contain the search term. There is no way to retrieve by meaning, and no way for a RAG consumer (an agent stuffing context into a prompt) to pull the passages most semantically relevant to a query.

This spec adds **vector retrieval**: a memory can be opted into a vector index; the platform embeds each node's content (the node's **abstract** by default, or **content chunks**, or **both** — a per-memory choice); embedding happens **asynchronously on write** so the client is never blocked; and a client retrieves by meaning through a new `mode: vector | keyword | hybrid` parameter on the **existing** `h-find-nodes` tool — one search surface, not a second tool with different coverage.

Two design realities shape the whole feature:

1. **The abstract is client-supplied.** A memory whose clients don't author abstracts has an empty abstract index and retrieves nothing — until headless abstract-generation (unbuilt, out of v1) lands. The driving use case — a research agent ingesting scientific articles, where generating an abstract per node burns too much AI credit — therefore needs **content chunks** as its retrieval surface. Chunking needs no LLM in the loop, making it arguably the *more* fundamental retrieval path. This is why `content-chunks` is a first-class, client-facing offering, not a research-only experiment.

2. **Embeddings are derived from content.** Embedding-inversion research (the vec2text line of work) can partially reconstruct source text from embeddings, especially short ones like abstracts. So storing plaintext vectors of an **encrypted** memory's content *is* a privacy exposure to anyone with database access. Rather than refuse or silently defer, v1 **discloses the tradeoff explicitly and makes it the user's choice** via the per-memory opt-in. Telling users exactly what their encrypted memory's vector index can and can't leak is a deliberate trust differentiator.

The design is deliberately **minimal-but-correct**: a single platform-fixed embedding model (one index space, one dimension, one migration story), a durable-marker interim queue (not the full message bus, but not lossy fire-and-forget either), and a serve-and-mark staleness posture that leans on spec 032's signal rather than rebuilding it.

## User Scenarios & Testing

### User Story 1 — Semantic vector search over a memory's abstracts (Priority: P1)

A memory owner opts a memory into vector indexing. With the default embedding source (`abstract`), the platform asynchronously embeds each node's abstract whenever it is written, storing the vector in Postgres alongside the node. A client then calls `h-find-nodes` with `mode: vector` and a natural-language query and receives the memory's nodes ranked by semantic similarity to the query — not by keyword overlap.

This is the headline capability and the minimum coherent slice: opt-in, the async embedding pipeline, vector storage, and the vector query path. Without all four there is nothing to demonstrate; with them, semantic retrieval works end-to-end on the default configuration.

**Why this priority**: This is the feature. Every other story is an extension of, or refinement on, this end-to-end path. Implemented alone it delivers semantic search over any memory whose nodes carry abstracts (the default substrate that specs 031/032 established).

**Independent Test**: Opt a test memory into `vectorIndex`. Write several nodes with distinct abstracts (e.g. one about "database backups", one about "user authentication", one about "holiday recipes"). Wait for the embedding worker to drain. Call `h-find-nodes mode:vector query:"how do I restore data after a crash"`. Assert the backups node ranks first, and that a node with no semantic relation ranks last or is excluded by the similarity threshold. Assert the call returns ranked node URNs in the same envelope shape as a keyword `h-find-nodes` call.

**Acceptance Scenarios**:

1. **Given** a memory NOT opted into `vectorIndex`, **When** a client calls `h-find-nodes mode:vector`, **Then** the call returns an empty, non-error result carrying an explicit `no_vector_index` reason flag (with guidance to enable it) — it does NOT silently fall back to keyword or return an opaque error. (See FR-021 for the `mode:hybrid` variant.)
2. **Given** a memory opted into `vectorIndex` with the default source (`abstract`), **When** a node with a non-null abstract is written via any write surface, **Then** the node is enqueued for embedding (a durable pending marker is set) and the write returns to the client immediately without waiting for the embedding API.
3. **Given** an enqueued node, **When** the embedding worker drains the queue, **Then** the node's abstract is embedded with the platform model, the vector and the model id are stored, and the pending marker is cleared.
4. **Given** a memory whose nodes have been embedded, **When** a client calls `h-find-nodes mode:vector query:"<natural language>"`, **Then** the response is a list of node URNs ranked by semantic similarity to the query, in the existing `h-find-nodes` result envelope.
5. **Given** a just-written node whose embedding has not yet drained, **When** a client searches, **Then** the node is simply not yet retrievable (eventual consistency) — the search does not error and does not block waiting for the embedding.
6. **Given** the embedding API fails for a node, **When** the worker processes it, **Then** the failure is recorded durably (a failure marker), the node is NOT silently dropped, and a later sweep retries it.
7. **Given** abstracts that were written or back-filled *before* the memory was opted in (no write event to trigger on), **When** the memory is opted into `vectorIndex`, **Then** a backfill sweep enqueues the existing un-embedded nodes so they become searchable.

---

### User Story 2 — Content-chunk retrieval for corpora without abstracts (Priority: P2)

A memory owner whose corpus is large and abstract-less (the research-articles driving case) sets the embedding source to `content-chunks` (or `both`). The platform splits each node's content into chunks — structure-aware by default (e.g. markdown-section-aware), with a fixed-size token-window fallback when the content has no usable structure — embeds the chunks, and makes them retrievable. By default a vector search collapses chunk hits to ranked node URNs (uniform with today's `h-find-nodes`); with an opt-in flag, the search returns the matching passages themselves (the span text, its offset, and its parent node URN) — exactly what a RAG consumer needs for context-stuffing.

**Why this priority**: This is what makes RAG affordable for credit-constrained corpora and is the path the driving use case actually needs. It is the second-most-valuable slice but rides on US1's pipeline and query surface, so it is P2, not P1.

**Independent Test**: Opt a memory into `vectorIndex` with source `content-chunks`. Ingest a structured markdown document as one node and an unstructured plain-text blob as another. Assert the structured node is chunked along its sections and the unstructured node is chunked into fixed-size overlapping windows. Run a vector search; assert (default) it returns the parent node URNs ranked by best-chunk similarity. Re-run with the chunk-level flag; assert it returns the matching passages with span text, character offset + chunk index, and parent URN. Adjust `chunkTokens`/`chunkOverlap` in config and assert the chunk boundaries change accordingly.

**Acceptance Scenarios**:

1. **Given** a memory with source `content-chunks`, **When** a node with structured content is written, **Then** the content is split using the structure-aware strategy and each chunk is enqueued for embedding.
2. **Given** a node whose content has no usable structure, **When** it is chunked, **Then** the fixed-size fallback (token windows with overlap, default ~512 tokens / ~64 overlap) is selected automatically.
3. **Given** a memory with per-memory chunking dials set (`chunkTokens`, `chunkOverlap`, `forceFixedSize`), **When** a node is chunked, **Then** the dials are honored (including `forceFixedSize` overriding the structure-aware default).
4. **Given** chunk vectors exist, **When** a client runs a vector search with the default granularity, **Then** chunk hits are collapsed to ranked **node** URNs (one node appears once, ranked by its best-matching chunk).
5. **Given** chunk vectors exist, **When** a client runs a vector search with chunk-level granularity opted in, **Then** the response returns the matching **passages**: the span text, its **character offset** within the node and its **chunk index**, and the parent node URN.
6. **Given** a memory with source `both`, **When** nodes are written, **Then** both the abstract and the content chunks are embedded, and a single vector search ranks across both kinds of vector without the client specifying which (the source is a memory property, not a query parameter).
7. **Given** a node's content is edited, **When** the write completes, **Then** the node's chunks are re-derived and re-enqueued (so the chunk index does not drift from current content).

---

### User Story 3 — One search surface: keyword, vector, and hybrid via `h-find-nodes` (Priority: P2)

A client chooses how to search through a single `mode` parameter on the existing `h-find-nodes` tool: `keyword` (today's substring behavior, now named), `vector` (US1/US2), or `hybrid` (both, fused into one ranked list). Hybrid uses a deterministic score-fusion rule (reciprocal-rank fusion as the boring default) so a node that is both a keyword and a semantic match ranks above one that is only one. An optional `expand: <depth>` argument (default 0/off) additionally pulls in graph neighbors of the hits for callers who want surrounding context.

**Why this priority**: Unifying retrieval behind one tool is what closes the "two-search-surfaces-with-different-coverage" gap (hadron-server #206 gap 4) and is the client-facing API contract for the whole feature. It rides on US1 (the vector path must exist to fuse), so P2.

**Independent Test**: Seed a memory with nodes where keyword and semantic relevance diverge (a node that mentions the query term verbatim but is off-topic, and a node that never uses the term but is on-topic). Run `mode:keyword` — assert the verbatim node ranks high. Run `mode:vector` — assert the on-topic node ranks high. Run `mode:hybrid` — assert the fused ranking places a node strong on both above either single-signal node, per the RRF rule. Run with `expand:1` — assert graph neighbors of the top hits appear in the result.

**Acceptance Scenarios**:

1. **Given** any memory, **When** a client calls `h-find-nodes` with no `mode`, **Then** the behavior is the existing keyword search (backward-compatible default).
2. **Given** a memory with a vector index, **When** a client calls `h-find-nodes mode:keyword`, **Then** the result is the same as the no-`mode` keyword search (the value is explicit, behavior unchanged).
3. **Given** a memory with a vector index, **When** a client calls `h-find-nodes mode:hybrid query:"..."`, **Then** keyword and vector result sets are fused by reciprocal-rank fusion into a single ranked list, and the fusion rule is deterministic for a given input.
4. **Given** a memory WITHOUT a vector index, **When** a client calls `mode:vector`, **Then** the response is an empty result carrying an explicit `no_vector_index` reason flag (no opaque failure, no silent keyword fallback); **and when** a client calls `mode:hybrid`, **Then** the response returns the keyword hits carrying an explicit `no_vector_index` degraded flag (the keyword half still runs, but the missing vector coverage is disclosed, never silently dropped) — per FR-021.
5. **Given** a client supplies `expand: <n>` (n > 0), **When** the search returns hits, **Then** graph neighbors within depth `n` (undirected, all edge types) are appended after the ranked direct hits as unscored expansion context — never interleaved into the similarity ranking; **and** with `expand: 0` (default) only the direct hits are returned.

---

### User Story 4 — Staleness is surfaced on vector hits, not hidden (Priority: P3)

When a vector search surfaces an **abstract-vector** hit whose embedded abstract is stale relative to current content (spec 032's predicate), the response **serves the hit and marks it stale** — it does not skip or block it. Because every content write re-queues the embedding, a hit's embedded abstract is only stale during the brief async window, so the marker is a belt-and-suspenders signal, not a common state. Because embedding happens at write time on plaintext, the origin hash can be stamped at write time — giving even encrypted memories a staleness marker that spec 032's read-time gate could not provide. Staleness is an **abstract-only** concept in v1: content-chunk hits carry no staleness marker because chunks are re-derived from current content on every edit (FR-017) — there is no stored summary that can drift.

**Why this priority**: Correctness hardening on top of the retrieval path. It prevents a confidently-wrong stale summary from being retrieved as authoritative without any warning, but it is not on the critical path to demonstrating retrieval, so P3.

**Independent Test**: Embed a node's abstract, then update only its content (without refreshing the abstract) and immediately run a vector search before the re-embed drains. Assert the node is still returned (not skipped) and carries a staleness marker in the result. Let the re-embed drain; search again; assert the marker clears (self-healing).

**Acceptance Scenarios**:

1. **Given** a vector hit whose `abstractOriginHash` disagrees with the current content hash (spec 032 predicate), **When** the result is returned, **Then** the hit is included and carries a staleness marker — it is neither dropped nor does it block the search.
2. **Given** a content-only write to an embedded node, **When** the re-embed worker drains, **Then** the node is re-embedded from the refreshed-at-write-time abstract origin and the staleness marker clears on the next search (self-healing through re-embed-on-write).
3. **Given** an **encrypted** memory whose vectors were computed at write time on plaintext, **When** a stale hit is returned, **Then** it can still carry a staleness marker (the origin hash was stamped at write time on plaintext), unlike spec 032's read-path gate.
4. **Given** a `content-chunks` memory, **When** a chunk-vector hit is returned, **Then** it carries NO staleness marker (chunk staleness is undefined in v1; chunks self-heal via re-derivation on content edit).

---

### User Story 5 — Encrypted-memory vector indexing is opt-in and fully disclosed (Priority: P3)

A memory owner of an **encrypted** memory can still opt into a vector index, but only after the platform discloses the tradeoff: stored vectors are plaintext, and embedding inversion can partially reconstruct source text from them, so anyone with database access could glean some content. Encrypted memories are **not** excluded by default and are **not** silently indexed — the owner is shown what the index can and cannot leak and makes the choice. Embeddings are computed on plaintext at write time (just before the encryption envelope is applied, using the plaintext the worker already holds at upsert), which sidesteps the read-path-can't-decrypt problem entirely.

**Why this priority**: A privacy/trust slice that gates one class of memory (encrypted). It is independent of the core retrieval path and only matters for encrypted memories, so P3 — but it is load-bearing for the product's "we tell you exactly what your encrypted memory's vector index can and can't leak" positioning.

**Independent Test**: Attempt to enable `vectorIndex` on an encrypted memory; assert the platform surfaces the inversion-risk disclosure and requires an explicit opt-in (the request is not auto-accepted and the memory is not auto-excluded). Enable it; write a node; assert the embedding is computed from plaintext at write time and the stored vector + origin hash are present even though the content row is encrypted. Assert the disclosure text states that stored vectors are plaintext and partially invertible.

**Acceptance Scenarios**:

1. **Given** an encrypted memory not yet opted into `vectorIndex`, **When** the owner enables it, **Then** the platform surfaces the embedding-inversion disclosure and records an explicit opt-in before any vectors are stored.
2. **Given** an encrypted memory NOT opted in, **When** nodes are written, **Then** no vectors are stored for it (encrypted memories are not indexed by default).
3. **Given** an encrypted memory opted in, **When** a node is written, **Then** the embedding is computed from plaintext at write time (before encryption), and the plaintext vector + model id + abstract origin hash are stored even though the content column is encrypted at rest.

---

### Edge Cases

- **Abstract-less memory on the default source**: a memory opted into `vectorIndex` with source `abstract` whose nodes carry no abstracts has an empty index and `mode:vector` returns nothing. This is expected, not a bug — but the platform should make it diagnosable (a memory owner should be able to tell "no hits because nothing is embedded yet" from "no hits because nothing matched"). Steer such corpora to `content-chunks`. Headless abstract-generation that would populate the abstract index is out of v1.
- **Embedding API outage**: writes still succeed (embedding is async); pending markers accumulate; the periodic sweep drains them when the API recovers. No data is lost; the index is simply behind until drain. Searches over the not-yet-embedded nodes return fewer hits in the meantime.
- **Worker restart mid-drain**: because the pending/failure marker is durable (persisted, not in-memory), a restart resumes from the markers — no node is permanently skipped because its in-flight state was lost.
- **Two near-simultaneous writes to the same node** (or a write landing while a worker is mid-embed on the prior version): each write re-arms the durable pending marker, and the worker MUST end with the **latest** content embedded (latest-write-wins), never whichever embed job happens to finish last. The marker is the source of truth; an in-flight embed of superseded content is discarded or harmlessly overwritten. The worker-concurrency mechanism (single loop / pool / per-node leasing) that achieves this is a `/plan` choice; the latest-wins **outcome** is the contract.
- **Re-embed storm on bulk content edit**: a bulk content update re-enqueues many nodes at once. The queue absorbs this; the worker drains at its own pace; clients are never blocked. Throughput, not correctness, is the only concern, and it is bounded by the worker.
- **Switching a memory's embedding source** (e.g. `abstract` → `content-chunks`): the prior vectors are of a different kind. The platform must define whether the old vectors are dropped/rebuilt or retained; v1 treats a source change as a re-index of the memory (enqueue all nodes under the new source). [Documented in Assumptions.]
- **Empty or whitespace-only content/abstract**: nothing to embed; no vector stored; no chunk produced. Not an error.
- **Chunk-level retrieval on an abstract-only memory**: there are no chunks to return passages from; chunk-level granularity degrades to node-level (the only vectors are abstract vectors, which are node-scoped).
- **Platform embedding model change** (future): existing vectors carry a stored `model` id, so a model change is a deliberate, observable re-embed of the whole corpus — not a silent geometry mismatch. **In v1 this case does not arise**: exactly one model is in flight platform-wide (FR-013), so every vector is comparable and there is no mixed-model query to resolve. The migration itself — and its read-path posture (quiesce reads vs. hold the prior model active until re-embed completes) — is Reserved; v1 only preserves the ability to migrate.
- **Very large node** producing thousands of chunks: bounded by the chunking parameters; the spec does not cap chunk count in v1 but notes that pathological inputs are possible. [Documented in Assumptions.]

## Requirements

### Functional Requirements

#### Indexing configuration (per-memory)

- **FR-001**: A memory MUST be able to opt into a vector index through its memory-config (`vectorIndex` opt-in). Memories not opted in store no vectors and incur no embedding work. The opt-in is **per memory** (always individually flippable), but its **default value is class-derived**: a `knowledge`-class, non-encrypted memory defaults to **enabled** (knowledge memories are the corpus meant to be searched); every other class (`system`, `app`, `group`, `personal`, `private`) and **any encrypted memory** (regardless of class — see FR-026) defaults to **disabled**. This keeps "searchable by default" for the knowledge corpus without ever silently indexing private or encrypted content.
- **FR-002**: The embedding source MUST be a per-memory config choice of `abstract` | `content-chunks` | `both`, defaulting to `abstract`. This selects **what the index is built from** and is a property of the memory, NOT a query parameter. A client's query never specifies the source; it asks "search by vector" and gets hits regardless of how the index was built.
- **FR-003**: When the source includes content chunks, the memory-config MUST expose per-memory chunking dials: `chunkTokens` (default ~512), `chunkOverlap` (default ~64), and `forceFixedSize` (force the fixed-size strategy, bypassing structure-aware chunking). Defaults apply when a dial is unset.
- **FR-004**: Changing a memory's embedding source or chunking dials MUST cause the affected nodes to be re-indexed under the new configuration (the existing index does not silently become inconsistent with the config).

#### Async embedding pipeline

- **FR-005**: Embedding MUST happen **asynchronously on write** and MUST NOT block the client write path. The abstract (spec 031) already exists at upsert time; only the embedding API call is deferred. (Elevated to a general platform rule: don't slow the AI agent.)
- **FR-006**: The write path MUST set a **durable** pending marker (a persisted signal, e.g. a nullable `embeddingPendingAt`-style field) for nodes that need (re-)embedding, and a durable failure marker for nodes whose embedding failed. Pure in-memory fire-and-forget is explicitly rejected: it loses data on embedding-API failure and cannot express backfill.
- **FR-007**: A prompt drain trigger (a `setImmediate`-style hand-off on the write path) MUST process freshly-marked nodes promptly, and a cheap periodic sweep MUST additionally drain markers to cover retries, process restarts, and backfill.
- **FR-008**: The pipeline MUST support **backfill**: enqueuing nodes that have no write event to trigger on (opt-in-later corpora; abstracts populated after the fact). Backfill is a required capability, not optional.
- **FR-009**: Embedding-API failures MUST be recorded on the durable failure marker and retried by a later sweep; a failed node MUST NOT be silently dropped from the index.
- **FR-010**: The embedding job's shape MUST be transport-agnostic so the interim Postgres-backed queue can later be replaced by the platform message bus without reshaping the job. This interim queue MUST be registered as tracked tech-debt with a forward link to the message-bus work. [See FR-029.]
- **FR-011**: Eventual consistency is accepted: a just-written node MAY not be retrievable until the worker drains. The system MUST NOT block a write or a search waiting for embedding.

#### Vector storage

- **FR-012**: Vectors MUST be stored in Postgres using pgvector — single database, single backup, no new infrastructure. The interim embedding queue MUST ride the same Postgres.
- **FR-013**: v1 MUST use a single platform-fixed embedding model (one index space, one fixed vector dimension). Per-memory and per-query model selection are explicitly rejected (different models produce geometrically incomparable vectors and collide with pgvector's fixed-dimension columns). In v1 there is **exactly one** embedding model in flight platform-wide at any time — every stored vector shares one model and one dimension, so all vectors are mutually comparable and no mixed-model read path can arise.
- **FR-014**: Each stored vector MUST carry the `model` id it was produced with, preserving forward-compatibility for a deliberate, observable re-embed when the platform model later changes (cross-memory / multi-model search is NOT built in v1 but MUST NOT be foreclosed by the storage shape). A model change is a future whole-corpus re-embed (Reserved); v1 does not perform one, and the **read-path posture during such a migration** (serving while some vectors are model A and some model B) is explicitly out of v1 scope — when a migration is built it will quiesce vector reads or hold the prior model active until the re-embed completes. The stored `model` id exists so that migration can be deliberate and observable, not so v1 serves mixed-model results.

#### Chunking

- **FR-015**: When the source includes content chunks, the system MUST split node content into chunks, selecting the strategy **automatically per node**: a structure-aware strategy (e.g. markdown-tree / section-aware) when the node's content has usable structure, and a fixed-size token-window strategy with overlap otherwise. `forceFixedSize` overrides to the fixed-size strategy.
- **FR-016**: Each chunk MUST retain enough locator metadata to support chunk-level retrieval: its span text, its **character offset** within the parent node's content, its **chunk index** among the node's chunks, and its parent node URN. Offsets are measured in **characters** (stable across re-chunking and independent of any tokenizer), NOT tokens — the token boundaries that drive embedding are an internal detail of the platform-fixed model and are not part of the retrieval contract.
- **FR-017**: When a node's content changes, its chunks MUST be re-derived and re-enqueued so the chunk index tracks current content.

#### Query surface

- **FR-018**: `h-find-nodes` MUST gain a `mode: vector | keyword | hybrid` parameter. `keyword` is the existing substring behavior; absence of `mode` MUST remain backward-compatible keyword search. There MUST NOT be a separate `h-search` tool — one search surface only (closes hadron-server #206 gap 4).
- **FR-019**: `mode:hybrid` MUST fuse the keyword and vector result sets into a single ranked list using a deterministic score-fusion rule (reciprocal-rank fusion as the v1 default). RRF's rank constant `k` (conventionally `60`) is a `/plan`-stage choice fixed at a **single platform value** in v1 — it is NOT a per-query parameter — so the fusion is deterministic and reproducible across calls.
- **FR-020**: `h-find-nodes` MUST accept an optional `expand: <depth>` argument (default `0`/off) that, when > 0, includes graph neighbors within the given depth of the hits. **Neighbor semantics (v1)**: undirected adjacency over **all** edge types — a node reachable from a hit by any edge, in either direction, within depth `n`. Per-edge-type or per-direction filtering is deferred (Reserved). **Ranking**: expanded neighbors are NOT scored against the query (they have no similarity score); they are returned as **expansion context appended after** the ranked direct hits, never interleaved into the similarity ranking. The ranked list keeps meaning "best query matches"; expansion only adds surrounding context for a RAG consumer.
- **FR-021**: On a memory **without** a vector index, the two vector-bearing modes MUST both be explicit — never silent — but they behave differently:
  - `mode:vector` MUST return a normal result envelope carrying an explicit machine-readable reason (e.g. an empty `hits` list plus a `reason: 'no_vector_index'` field on the envelope) — NOT an exception / opaque error, and NOT a silent keyword fallback.
  - `mode:hybrid` MUST still return the **keyword half** of the search (the keyword index is always available) but MUST flag the degraded coverage explicitly on the envelope (e.g. a `degraded: 'no_vector_index'` field) so the caller is not misled into thinking the vector half ran. A silent keyword-only result is forbidden.
  The exact field names are a `/plan` choice; the **shape contract** — a typed reason/flag carried on the result envelope, not an error class and not silent — is pinned here so SC-008 has something concrete to test.
- **FR-022**: Chunk retrieval granularity MUST default to **node-level** — chunk hits are collapsed to ranked node URNs (one node appears once, ranked by its best-matching chunk), uniform with today's `h-find-nodes`. A **chunk-level** granularity MUST be available as an opt-in flag, returning the matching passages (span text + offset + parent node URN).

#### Staleness

- **FR-023**: Staleness marking in v1 applies to **abstract** vectors only. When an **abstract**-vector hit is stale per spec 032's predicate (`abstractOriginHash` disagrees with the current content hash), the response MUST **serve the hit and mark it stale** — it MUST NOT skip or block the hit. **Content-chunk hits do NOT carry a staleness marker in v1**: chunks are re-derived and re-enqueued on every content edit (FR-017), so a chunk that exists is by construction derived from current content (modulo the async window) — there is no stored summary that can silently drift, so no chunk-staleness predicate is defined in v1. Deeper staleness handling (skip/re-queue policies; a chunk-staleness predicate) is out of v1.
- **FR-024**: Because every content write re-queues the node's embedding, a hit's embedded abstract MUST be stale only during the async window; the staleness marker is a secondary signal and the re-embed-on-write is the primary defense (self-healing).
- **FR-025**: Because embeddings are computed at write time on plaintext (FR-027), the abstract origin hash MUST be stampable at write time — so **encrypted** memories MAY carry a staleness marker on vector hits, which spec 032's read-time gate could not provide.

#### Encryption & privacy

- **FR-026**: Vector indexing of an **encrypted** memory MUST be opt-in and MUST surface an explicit disclosure **before any vectors are stored**. The disclosure MUST cover, at minimum: (a) stored vectors are **plaintext** — they are NOT encrypted at rest the way the content column is; (b) embedding inversion can **partially** reconstruct source text from a vector — partial, not full reconstruction; (c) anyone with **database access** is therefore a potential viewer of that partial content, even though the content column itself is encrypted; (d) the opt-in is **revocable**, and revoking it stops further indexing AND removes the memory's already-stored vectors. Encrypted memories MUST NOT be excluded by default and MUST NOT be silently indexed — the owner decides after disclosure. The authoritative disclosure text is a named artifact (a docs/config surface) populated at `/plan`, so SC-010 can assert its content, not merely its existence.
- **FR-027**: Embeddings MUST be computed on **plaintext** content at write time — just before the encryption envelope is applied, using the plaintext the worker already holds at upsert — sidestepping the read-path-can't-decrypt problem (#206). Stored vectors are plaintext regardless of `Memory.isEncrypted`.

#### Carried findings (the spec MUST carry these)

- **FR-028**: The spec and its downstream artifacts MUST document the **abstract-population dependency**: `Node.abstract` is client-supplied, so a memory on the default `abstract` source whose clients don't author abstracts has an empty index and retrieves nothing until headless abstract-generation (out of v1) lands. Guidance MUST steer credit-constrained / abstract-less corpora to `content-chunks`.
- **FR-029**: The spec and its downstream artifacts MUST document the **interim-queue tech-debt** with a forward link to the message-bus work, so "interim" does not silently become permanent.

### Key Entities

- **Memory (config)** — gains vector-index settings: the `vectorIndex` opt-in, `embeddingSource` (`abstract`|`content-chunks`|`both`, default `abstract`), chunking dials (`chunkTokens`, `chunkOverlap`, `forceFixedSize`), and the encrypted-memory opt-in/disclosure acknowledgment. These are memory properties, not query parameters.
- **Node (embedding state)** — gains durable embedding-status markers (pending / failed signals, e.g. `embeddingPendingAt` / `embeddingFailedAt`) that drive the async queue and backfill. Couples to spec 032's `abstractOriginHash` for the write-time staleness stamp.
- **Vector / Embedding record** — a stored pgvector value plus its `model` id, associated with what it was derived from (a node's abstract, or a specific content chunk). Single fixed dimension across the platform.
- **Chunk** — a span of a node's content with locator metadata (span text, character offset within the node, chunk index, parent node URN) and its own embedding record. Produced by the structure-aware or fixed-size strategy.
- **Embedding queue marker** — the durable interim-queue signal (rides Postgres) that the prompt drain trigger and the periodic sweep act on; transport-agnostic by design so it can migrate to the message bus.

**Source of truth**: `hadron-server/prisma/schema.prisma` (schema + migration, including the pgvector extension) and the memory-config surface (spec 024). The design discussion summary at `hadron-concept/design-discussions/information-retrieval/2026-05-31-rag-vector-retrieval/summary.md` is the authoritative record of decisions D1–D9.

## Success Criteria

### Measurable Outcomes

- **SC-001**: End-to-end semantic retrieval works on the default source. After opting a memory into `vectorIndex`, writing nodes with distinct abstracts, and letting the worker drain, a `mode:vector` query returns the semantically-closest node ranked first across a set of at least 5 distinct query/seed pairs — demonstrated by an integration test, with at least one query that has no keyword overlap with the correct node (proving it is semantic, not substring, retrieval).
- **SC-002**: The client write path is never blocked by embedding. **Contract**: a write to an indexed memory completes and returns to the client while the node's embedding pending-marker is still set — i.e. the write does not await the embedding API. Demonstrated by a test asserting the write returns before the marker is cleared; the embedding lands asynchronously thereafter.
- **SC-003**: No node is lost to embedding-API failure. With the embedding API forced to fail then recover, every affected node ends up embedded after a sweep, with zero permanently-dropped nodes. Demonstrated by a fault-injection test.
- **SC-004**: Backfill works. Nodes that existed (or had abstracts populated) before opt-in become retrievable after the memory is opted in and the backfill sweep runs — no write event required. Demonstrated by a test that opts in *after* seeding.
- **SC-005**: Content-chunk retrieval returns passages. On a `content-chunks` memory, a chunk-level vector search returns the matching passage with correct span text, **character offset, chunk index**, and parent URN; the default granularity collapses the same hits to ranked node URNs. Demonstrated by a test exercising both granularities.
- **SC-006**: Chunking strategy is auto-selected and tunable. A structured node is chunked along its structure and an unstructured node by fixed-size windows; changing `chunkTokens`/`chunkOverlap`/`forceFixedSize` changes the chunk boundaries. Demonstrated by a test over both content shapes and a dial change.
- **SC-007**: One search surface, three modes. `h-find-nodes` with no `mode` is **result-compatible** with today's keyword search (identical hit set and ordering) AND the keyword path does NOT echo `mode` or any vector-only field into the response envelope (existing callers see an unchanged shape); `mode:vector` and `mode:hybrid` work on indexed memories; `mode:hybrid` produces a deterministic RRF-fused ranking that places a both-signal node above a single-signal node. Demonstrated by a ranking test where keyword and semantic relevance diverge, plus an envelope-shape assertion on the no-`mode` path.
- **SC-008**: Vector/hybrid on an unindexed memory is diagnosable, never opaque. `mode:vector` returns an empty result carrying the `reason: 'no_vector_index'` envelope flag; `mode:hybrid` returns the keyword hits carrying the `degraded: 'no_vector_index'` envelope flag (never a silent keyword-only result, never an unhandled error). Demonstrated by a contract test asserting the flag on each mode.
- **SC-009**: Stale hits are served and marked, and self-heal. A content-only edit produces a stale-marked hit on the next search before re-embed drains; after drain the marker clears. Demonstrated by a regression test including the encrypted-memory case (marker present despite encryption).
- **SC-010**: Encrypted-memory indexing is opt-in and disclosed. Enabling `vectorIndex` on an encrypted memory surfaces a disclosure covering all four FR-026 points (plaintext vectors / partial inversion / DB-access viewers / revocable opt-in) and records an explicit opt-in; an un-opted-in encrypted memory stores no vectors; revoking the opt-in removes the memory's stored vectors. Demonstrated by a contract test asserting the disclosure content, the no-silent-index behavior, and revocation-removes-vectors.

## Assumptions

- **Decisions D1–D9 are authoritative and already settled.** This spec encodes the closed design discussion; it does not re-open the choices. Where the discussion left a value unpinned (below), this spec records a reasonable default rather than blocking.
- **The specific platform embedding model and its vector dimension are an implementation/ops choice for `/plan`,** not a spec-level decision. The spec requires only that the model be platform-fixed (FR-013), that the dimension be single and fixed, and that each vector carry its `model` id (FR-014). Selecting the concrete model (and thus the dimension and the pgvector column width) is deferred to planning.
- **Switching a memory's embedding source re-indexes that memory** (enqueue all its nodes under the new source); v1 does not attempt to preserve the prior-source vectors across a switch. The simplest correct behavior; tunable later if it proves costly.
- **No chunk-count cap in v1.** Pathologically large nodes can produce many chunks; the spec notes this but does not cap it. A cap (or a max-content-size guard) is a candidate follow-up if real corpora hit it.
- **Embedding cost is uncapped in v1.** Backfill (FR-008), chunk re-derivation on every content edit (FR-017), and re-index on config change (FR-004) all let writes multiplicatively expand embedding-API work. v1 adds no rate-limiting, per-memory cost caps, or per-token quotas — this is an accepted, explicitly-deferred risk (see Reserved). Operators should be aware that bulk edits / backfills generate proportional embedding spend.
- **Worker concurrency model is a `/plan` choice.** Whether the worker is a single drain loop, a pool, or uses per-node leasing is deferred. The spec pins only the **outcome** invariants: latest-write-wins on a node (Edge Cases), no node lost on failure (FR-009), and durable markers surviving restart (FR-006).
- **The interim queue rides Postgres and is explicitly tech-debt** (FR-010/FR-029). It is the minimal-but-correct transport (durable marker + prompt drain + sweep), chosen over both the full message bus (too large to block IR) and lossy fire-and-forget (rejected). The message-bus migration is out of v1.
- **`h-find-nodes` keyword behavior is unchanged** when `mode` is absent or `keyword`. The `mode` parameter is additive; existing callers are unaffected.
- **Target repository is `hadron-server` only.** Prisma schema + pgvector extension/migration, the embedding worker, the `h-find-nodes` MCP surface, the GraphQL surface where applicable, and the memory-config additions (spec 024). Portal-side UI for configuring the vector index and for showing the encrypted-memory disclosure is a follow-up once the API exposes the config and the disclosure contract; it is not part of this server-side spec.

## Reserved for future / out of v1

- **Semantic chunking** (embed-sentences, cut at similarity drops) — the named v2 upgrade over structure-aware/fixed-size chunking (D8).
- **Message-bus transport** for the embedding worker — replaces the interim durable-marker queue when the bus lands (D2/FR-010).
- **Headless-LLM abstract generation** ("turn unused nodes into abstracts") — would unblock the `abstract` source for corpora whose clients don't author abstracts (the FR-028 dependency); itself a message-bus job.
- **Deeper staleness handling** beyond serve-and-mark (D4/FR-023) — skip/re-queue policies on stale hits.
- **Cross-memory / multi-memory search** — preserved as *possible* by the single-model choice (FR-013/FR-014) but not built in v1.
- **Embedding model migration** — the deliberate whole-corpus re-embed when the platform model changes, including the mid-migration read-path posture (quiesce vs. hold-prior-model). Storage is forward-compatible (FR-014) but v1 performs no migration and serves no mixed-model reads (FR-013).
- **Embedding cost-control** — rate-limiting, per-memory embedding-cost caps, and per-token quotas. Deferred but acknowledged (see Assumptions) because FR-008 / FR-017 / FR-004 converge on write-amplified embedding work.
- **`expand` edge-type / direction filtering** — v1 expands undirected over all edge types (FR-020); per-edge-type and per-direction expansion controls are deferred.
- **Additional retrieval-config dials** (expand-depth defaults, further chunking knobs) — tracked under the retrieval-config stub.

## Dependencies

- **Spec 031 (`Node.abstract`, `specs/031-node-abstract-field/`)** — provides the default embedding source. Shipped 2026-05-30.
- **Spec 032 (`Node.abstractOriginHash`, `specs/032-abstract-staleness/`)** — provides the staleness predicate copied into the vector response (FR-023) and the write-time origin-hash stamp reused for encrypted-memory staleness (FR-025). Shipped 2026-05-30.
- **Spec 024 (memory-config)** — the surface the vector-index opt-in, source choice, and chunking dials extend (FR-001–FR-004).
- **pgvector** — Postgres extension for vector storage and similarity search (FR-012).
- **hadron-server #206** — the MCP/GraphQL encryption-parity and "two search surfaces" gaps; FR-018 closes gap 4 (one search surface) and FR-027 sidesteps the read-path-can't-decrypt problem at write time.
- **Message-bus work (stubbed)** — the eventual transport for the embedding worker; the interim queue forward-links to it (FR-010/FR-029).
