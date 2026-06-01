# Contract — Memory vector-index config (GraphQL)

Per-memory config landed as direct `Memory` columns (D-R6). Exposed on the `Memory` type and the `createMemory` / `updateMemory` mutations.

## `Memory` type — new read fields (`typeDefs.ts:619`)

```graphql
type Memory {
  # ...existing...
  vectorIndexEnabled: Boolean!
  embeddingSource: EmbeddingSource!          # abstract | contentChunks | both
  chunkTokens: Int                            # null ⇒ platform default (512)
  chunkOverlap: Int                           # null ⇒ platform default (64)
  forceFixedSize: Boolean!
  vectorIndexEncryptedAckAt: DateTime         # null ⇒ encrypted disclosure not acknowledged
}
enum EmbeddingSource { abstract contentChunks both }
```

## Mutation inputs — `createMemory` / `updateMemory`

New optional inputs (omitted ⇒ preserve on update / default on create):

```graphql
vectorIndexEnabled: Boolean
embeddingSource: EmbeddingSource
chunkTokens: Int
chunkOverlap: Int
forceFixedSize: Boolean
acknowledgeVectorInversionRisk: Boolean   # caller affirms the disclosure (sets vectorIndexEncryptedAckAt)
```

## Rules (resolver-enforced; FR-001–FR-004, FR-026)

1. **Enabling on an encrypted memory requires acknowledgment.** If `isEncrypted` and the result state would be `vectorIndexEnabled = true` and `vectorIndexEncryptedAckAt IS NULL` and `acknowledgeVectorInversionRisk` is not `true` → reject with **`EncryptedVectorIndexNotAcknowledgedError`** (typed, S2). When `acknowledgeVectorInversionRisk: true`, set `vectorIndexEncryptedAckAt = now()`. The CHECK constraint `chk_memory_vector_encrypted_ack` is the structural backstop.
2. **Disclosure content** (FR-026 — the authoritative text lives in `hadron-docs` + is returned in the error/confirmation): MUST state (a) vectors are stored **plaintext**; (b) embedding inversion can **partially** reconstruct source text; (c) anyone with **database access** is a potential viewer; (d) the opt-in is **revocable** and revoking removes stored vectors.
3. **Chunk dials** validated: `chunkTokens > 0`, `0 <= chunkOverlap < chunkTokens` → else **`InvalidChunkConfigError`** (typed). CHECK constraints backstop.
4. **Changing `embeddingSource` or chunk dials, or enabling the index** triggers a **re-index** of the memory: stamp `embeddingPendingAt = now()` on all of the memory's live nodes (backfill path, FR-004/FR-008). **Disabling / revoking** (`vectorIndexEnabled → false`) deletes the memory's `node_embeddings` rows (FR-026 revocation).
5. Access control: only a caller with memory-owner/write rights may change these (constitution V — same gate as other `updateMemory` fields).

## Tests (constitution I)

- enable on encrypted memory without ack → `EncryptedVectorIndexNotAcknowledgedError`; with ack → succeeds, `vectorIndexEncryptedAckAt` set (SC-010).
- un-acknowledged encrypted memory stores no vectors; revoking removes them (SC-010).
- invalid chunk dials → `InvalidChunkConfigError`; CHECK constraint present (S5 regression test).
- switching `embeddingSource` re-stamps all nodes pending (SC-004 backfill).
