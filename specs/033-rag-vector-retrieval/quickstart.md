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
