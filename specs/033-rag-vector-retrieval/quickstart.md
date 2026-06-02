# Quickstart — Spec 033 RAG vector retrieval

How to stand up, seed, and smoke-test vector retrieval locally. Assumes the implementation has landed.

## 0. Infra prerequisite — pgvector in Postgres

`postgres:17-alpine` does **not** ship pgvector. Before anything works:

- **dev/test**: switch the Postgres container image to `pgvector/pgvector:pg17` (drop-in; same data dir).
- **prod (`alpha`, bare-metal Postgres)**: install the pgvector package for the PG major version, then it's available to `CREATE EXTENSION`.

Verify: `psql … -c 'CREATE EXTENSION IF NOT EXISTS vector;'` succeeds.

## 1. Self-hosted embedding model

Dev (lowest-ops): **Ollama**

```bash
ollama pull nomic-embed-text          # nomic-embed-text-v1.5, 768-dim
ollama serve                          # serves http://localhost:11434
```

Env (`.env`, gitignored):

```
EMBEDDING_API_URL=http://localhost:11434/api/embeddings
EMBEDDING_MODEL=nomic-embed-text-v1.5
EMBEDDING_DIM=768
# EMBEDDING_API_KEY=        # only if the endpoint is authenticated
```

Prod: HF Text-Embeddings-Inference (TEI) or vLLM serving the same model; point `EMBEDDING_API_URL` at it.

## 2. Apply schema + constraints

```bash
# dev DB (managed via db push per CLAUDE.md)
DATABASE_URL='postgresql://holger@localhost:5432/hadron_dev' pnpm prisma db push
psql postgresql://holger@localhost:5432/hadron_dev -v ON_ERROR_STOP=1 -f prisma/post-push.sql   # CREATE EXTENSION vector, HNSW index, CHECK constraints, partial indexes
```

`hadron_test` gets the same via `src/test/globalSetup.ts` (must `CREATE EXTENSION vector` + apply the index/constraints before tests run).

## 3. Smoke test (manual)

```bash
DATABASE_URL='postgresql://holger@localhost:5432/hadron_dev' pnpm tsx prisma/seed.ts
# paste an hdr_app_… key into your MCP client, then:
```

1. **Enable the index** on a memory (GraphQL `updateMemory` or portal): `vectorIndexEnabled: true` (default `embeddingSource: abstract`). For an **encrypted** memory you must also pass `acknowledgeVectorInversionRisk: true` or you'll get `EncryptedVectorIndexNotAcknowledgedError`.
2. **Write nodes** with distinct abstracts via `h-add-node` (e.g. one on database backups, one on auth, one on recipes).
3. Wait a moment for the worker to drain (or watch `embedding_pending_at` clear):
   ```sql
   SELECT loc, embedding_pending_at, embedding_failed_at FROM nodes WHERE memory_id = '…';
   SELECT node_id, kind, model, dim FROM node_embeddings WHERE memory_id = '…';
   ```
4. **Search semantically**:
   - `h-find-nodes mode:vector query:"how do I restore data after a crash"` → the backups node ranks first (no keyword overlap — proves it's semantic).
   - `h-find-nodes mode:hybrid query:"backup"` → fused ranking.
   - `h-find-nodes mode:vector` on a **non-indexed** memory → `[no_vector_index]` note + 0 hits (not an error).
5. **Content-chunks**: set `embeddingSource: contentChunks`, write a long structured markdown node, then `h-find-nodes mode:vector granularity:chunk query:"…"` → returns the matching passage with `[chunk N @ chars a–b]`.

## 4. Test plan (Vitest, `hadron_test`)

Integration tests (constitution I — real Postgres + pgvector, real worker drain):

| Test | SC |
|---|---|
| semantic retrieval, incl. zero-keyword-overlap query | SC-001 |
| write returns before marker cleared (non-blocking) | SC-002 |
| forced embed failure → retried → zero lost | SC-003 |
| opt-in after seeding → backfill embeds existing nodes | SC-004 |
| chunk-level passages: char offset + chunk index + parent URN | SC-005 |
| chunking auto-select + dial changes alter boundaries | SC-006 |
| no-`mode` == keyword (snapshot); hybrid RRF ordering | SC-007 |
| vector/hybrid on unindexed → documented flags | SC-008 |
| stale abstract-vector served + marked; chunk hits unmarked; self-heal | SC-009 |
| encrypted opt-in + disclosure + revocation removes vectors | SC-010 |
| CHECK-constraint presence (`chk_memory_vector_encrypted_ack`, chunk dials) | S5 |

Unit tests: `chunkNode` (structure-aware vs fixed-size, overlap, dials, char offsets); RRF fusion determinism; nomic prefix application; dimension-mismatch rejection.

## 5. Rollback / disable

Set `vectorIndexEnabled: false` on a memory → its `node_embeddings` rows are deleted and writes stop stamping markers. The feature is dormant for memories that never opt in (no embedding work, no `EMBEDDING_API_URL` needed).

## 6. Performance sanity — HNSW serves the vector query (T059)

Recorded on `hadron_dev` 2026-06-02 (PR #226). 5,200 abstract-vector rows in a single memory; query embedding generated inline via `(ARRAY(SELECT random() FROM generate_series(1, 768)))::vector` to avoid model dependency.

The inner ANN query (the one `vectorSearchNodes` issues) is served by the HNSW index, NOT a sequential scan:

```
->  Index Scan using node_embeddings_embedding_hnsw on node_embeddings ne
      (cost=77.84..9610.00 rows=5200 width=15) (actual time=0.379..1.005 rows=100 loops=1)
      Order By: (embedding <=> ((InitPlan 1).col1)::vector)
      Filter: (memory_id = 'perf-mem'::text)
      Buffers: shared hit=457
```

Full query (ANN + node join + dedupe to top 10) executes in **1.86 ms** on this row count.

**Caveat**: the planner picks Seq Scan instead of HNSW when the table is small (verified at ~200 rows). This is correct cost-based behaviour — a sequential scan of 200 vectors is cheaper than the HNSW lookup overhead. HNSW kicks in once the row count crosses the planner's cost threshold (a few thousand rows in our tests). No tuning needed for typical prod-scale memories.

**Method (reproducible)**:

```bash
psql "$DATABASE_URL" <<'SQL'
EXPLAIN (ANALYZE, BUFFERS)
WITH ann AS (
  SELECT ne.node_id, ne.embedding <=> (ARRAY(SELECT random() FROM generate_series(1, 768)))::vector AS distance
  FROM node_embeddings ne
  WHERE ne.memory_id = '<some-memory-id>'
  ORDER BY ne.embedding <=> (ARRAY(SELECT random() FROM generate_series(1, 768)))::vector
  LIMIT 100
)
SELECT a.node_id, MIN(a.distance) AS distance
FROM ann a
JOIN nodes n ON n.id = a.node_id AND n.deleted_at IS NULL
GROUP BY a.node_id
ORDER BY distance ASC
LIMIT 10;
SQL
```

Look for `Index Scan using node_embeddings_embedding_hnsw` in the inner CTE. If the plan shows `Seq Scan on node_embeddings`, the table is too small for the index to win cost — populate more vectors or run `ANALYZE node_embeddings` to refresh planner stats.
