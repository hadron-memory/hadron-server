# Contract — Embedding worker + EmbeddingClient

## EmbeddingClient (HTTP, self-hosted; D-R1)

```ts
interface EmbeddingClient {
  /** Returns one vector per input, each of length EMBEDDING_DIM (768). */
  embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>;
  readonly model: string;   // e.g. "nomic-embed-text-v1.5"  (stored per vector, FR-014)
  readonly dim: number;     // 768; MUST equal the pgvector column dimension
}
```

- **nomic task prefixes are mandatory** (D-R1): `purpose:'document'` prepends `search_document: ` to each text; `purpose:'query'` prepends `search_query: `. Getting this wrong silently degrades recall — covered by a unit test asserting the prefix.
- HTTP impl POSTs to `EMBEDDING_API_URL` (OpenAI-compatible `/v1/embeddings` or Ollama `/api/embeddings`); optional `Authorization: Bearer EMBEDDING_API_KEY`. Batches inputs. Validates returned dimension == `dim` (else throw → marks the node failed).
- **Env** (CLAUDE.md convention): `EMBEDDING_API_URL` (required when any `vectorIndexEnabled` memory exists), `EMBEDDING_MODEL` (default `nomic-embed-text-v1.5`), `EMBEDDING_DIM` (default `768`), `EMBEDDING_API_KEY` (optional). A startup check warns if vector-indexed memories exist but `EMBEDDING_API_URL` is unset.

## Write-path hook (every surface; D-R3)

At each write surface that sets/changes `abstract` or `content` — GraphQL `upsertNode` (`resolvers.ts`), MCP `h-add-node`/`h-update-node`, importer, `restoreNodeVersion` — mirror the `computeContentHash` call sites:

1. If `memory.vectorIndexEnabled`: set `embeddingPendingAt = now()` in the same write (durable).
2. After the response is sent, `setImmediate(() => embedNodeNow(db, nodeId, { plaintextContent, plaintextAbstract }, memoryConfig))` — the **prompt-drain**, using in-closure plaintext (works for encrypted-via-GraphQL too).
3. `embedNodeNow` failure leaves the markers for the sweep (no throw onto the request path).

Mirrors the existing fire-and-forget `writeNodeToGit` pattern at the same call sites.

## Worker job (`src/jobs/embedNodes.ts`; mirrors `cleanupAnonymousMemories.ts`)

```ts
// Core, testable, transport-agnostic (FR-010):
async function drainEmbeddingQueue(db, opts?): Promise<{ embedded: number; failed: number; skipped: number }>;
// Loop wrapper started from src/server.ts:
function startEmbeddingWorkerLoop(db, opts?): NodeJS.Timeout;   // setTimeout initial → setInterval
```

`drainEmbeddingQueue` selects up to `batchSize` nodes where `embedding_pending_at IS NOT NULL OR embedding_failed_at IS NOT NULL` (respecting an attempts cap / backoff), and for each calls `embedNode`.

### `embedNode(db, node, plaintext?, config)` — the unit of work

1. Resolve effective config (memory `embeddingSource`, chunk dials with platform defaults).
2. Determine source text:
   - plaintext provided (prompt-drain) → use it;
   - else read the row (sweep). If `memory.isEncrypted` AND the row is ciphertext (GraphQL-written) AND no decrypt path → set `embedding_failed_at`, `embeddingError = 'encrypted-no-plaintext (#206)'`, and stop (documented v1 boundary, D-R3).
3. `DELETE FROM node_embeddings WHERE node_id = $node AND kind IN (<sources>)` (clean re-index).
4. For `abstract` source: if abstract non-empty, `embed([abstract],'document')` → insert one `kind='abstract'` row.
5. For `content-chunks` source: `chunkNode(content, config)` → `embed(chunks,'document')` → insert `kind='chunk'` rows with `chunkIndex/charStart/charEnd/chunkText`.
6. On success: clear `embedding_pending_at`, `embedding_failed_at`, `embeddingError`; leave `embeddingAttempts` as audit.
7. **Latest-wins**: capture `computeContentHash(sourceContent)` at start; before the final clear, if the node's current content hash differs, leave `embedding_pending_at` set (a newer write supersedes) so the next drain re-embeds (Edge Case).

All embedding inserts use raw SQL (`$executeRaw … $1::vector`).

## Vector search query (read path; D-R5)

```sql
-- node-level (default): best chunk/abstract per node
SELECT ne.node_id, MIN(ne.embedding <=> $queryVec::vector) AS distance
FROM node_embeddings ne
JOIN nodes n ON n.id = ne.node_id AND n.deleted_at IS NULL
WHERE ne.memory_id = $memoryId
GROUP BY ne.node_id
ORDER BY distance ASC
LIMIT $k;

-- chunk-level (granularity:'chunk'): passages
SELECT ne.node_id, ne.chunk_index, ne.char_start, ne.char_end, ne.chunk_text,
       (ne.embedding <=> $queryVec::vector) AS distance
FROM node_embeddings ne
JOIN nodes n ON n.id = ne.node_id AND n.deleted_at IS NULL
WHERE ne.memory_id = $memoryId AND ne.kind = 'chunk'
ORDER BY distance ASC
LIMIT $k;
```

`score = 1 - distance` (cosine). HNSW index serves the `<=>` ordering. Memory scope + `deleted_at IS NULL` enforced in the query; caller access-control upstream (constitution V).

## Tests (constitution I)

- write → marker set → drain → vector present → query returns it (SC-001).
- write returns before marker cleared (SC-002, non-blocking).
- forced embed failure → `embedding_failed_at` set, retried by next drain, eventually embedded, zero lost (SC-003).
- backfill: opt-in after seeding → sweep stamps & embeds existing nodes (SC-004).
- nomic prefix unit test; dimension-mismatch rejection.
- latest-wins: two quick writes → final vector is of the latest content.
