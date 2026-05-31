# Contract: `h-add-node` — abstractOriginHash maintenance

Spec source: FR-003 (set on abstract+content write), FR-007 (content=null edge case), FR-009 (encrypted memory).

## Input surface

**No new parameters.** The existing zod input from spec 031 is unchanged; `abstractOriginHash` is system-managed.

## Behaviour

After the existing validation + normalization (length cap on abstract, trim-then-check, edge resolution) and BEFORE the upsert payload is built, compute the hash:

```typescript
import { computeContentHash } from '../lib/contentHash.js';

// ... existing validation ...

// Spec 032 — compute abstractOriginHash when the write touches abstract.
// If content is null/empty, the hash is null (FR-007 edge case).
// Hash is computed on plaintext content BEFORE encryption (FR-009).
let nextAbstractOriginHash: string | null = null;
if (normalizedAbstract !== null) {
  nextAbstractOriginHash = computeContentHash(content);
}
```

Add to both `create` and `update` branches of the upsert:

```typescript
const upserted = await db.node.upsert({
  where: { loc_memoryId: { loc, memoryId } },
  create: {
    // ... existing fields ...
    abstract: normalizedAbstract,
    abstractOriginHash: nextAbstractOriginHash,
    content: content ?? null,
    contentHash: computeContentHash(content),  // also maintain contentHash server-side
    // ... rest ...
  },
  update: {
    // ... existing fields ...
    abstract: normalizedAbstract,
    abstractOriginHash: nextAbstractOriginHash,
    content: content ?? null,
    contentHash: computeContentHash(content),
    // ... rest ...
  },
});
```

**`h-add-node` is upsert-semantically a "fresh write"**: every call writes the full set of provided fields. There's no "preserve existing abstractOriginHash" branch — if the caller is supplying both `abstract` and `content`, both hashes get recomputed; if the caller omits one, the column goes to null per the existing zod-coerced semantics.

## Edge cases

- **abstract null, content set**: `abstractOriginHash = null` (no abstract = no staleness signal). `contentHash` is computed normally.
- **abstract set, content null**: `abstractOriginHash = null` per FR-007 (no content to hash; the abstract is the only representation, can't be stale).
- **both null**: both hashes null.
- **encrypted memory**: hash is computed on the plaintext content the caller supplied, BEFORE the existing encryption pass runs. The encryption envelope wraps content but NOT the hash columns; the hash stays plaintext (it's a non-sensitive fingerprint).

## Test coverage

(in `src/mcp/server.nodeAbstractStaleness.test.ts`)

- Write `abstract: "X"` + `content: "Y"`: `abstractOriginHash === computeContentHash("Y")` and equals `contentHash`.
- Write `abstract: "X"` + `content: null`: both hashes null.
- Write `abstract: null` + `content: "Y"`: `abstractOriginHash === null`, `contentHash === computeContentHash("Y")`.
- Write both null: both hashes null.
- On encrypted memory: hash matches `computeContentHash(plaintext)`, NOT `computeContentHash(ciphertext)`. DB row carries plaintext hash next to ciphertext content.
