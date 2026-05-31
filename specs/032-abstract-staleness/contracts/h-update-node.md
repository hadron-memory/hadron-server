# Contract: `h-update-node` — abstractOriginHash maintenance with partial-update semantics

Spec source: FR-003, FR-004, FR-005, FR-006, FR-007.

## Input surface

**No new parameters.** `abstractOriginHash` is system-managed.

## Behaviour matrix

`h-update-node` is a partial update; the abstractOriginHash semantics depend on which of `abstract` / `content` were supplied:

| `abstract` field | `content` field | Behaviour on abstractOriginHash | Behaviour on contentHash |
|---|---|---|---|
| absent | absent | preserve existing | preserve existing |
| absent | string `Y'` | **preserve existing** (FR-004 — staleness signal arms) | update to `computeContentHash("Y'")` |
| absent | `null` | preserve existing (FR-007 — ghost-hash case; doesn't fire staleness because content is null) | update to `null` |
| string `X'` | absent | **set to `computeContentHash(current content)`** (FR-003 — author affirms abstract matches current content) | preserve existing |
| string `X'` | string `Y'` | **set to `computeContentHash("Y'")`** (FR-005 — both writes match) | update to `computeContentHash("Y'")` |
| string `X'` | `null` | set to `null` (FR-007 — no content = no hash) | update to `null` |
| `null` | absent | **set to `null`** (FR-006 — no abstract = no hash) | preserve existing |
| `null` | string `Y'` | set to `null` (FR-006) | update to `computeContentHash("Y'")` |
| `null` | `null` | both null | both null |

The load-bearing row is the second: **content updated without abstract → abstractOriginHash is left untouched**. The stored hash now differs from the new contentHash; the staleness signal is armed.

## Implementation sketch *(illustrative — not load-bearing; integrate with existing patterns)*

```typescript
import { computeContentHash } from '../lib/contentHash.js';

// ... existing length-cap + trim-then-check on abstract ...

// Read current state once for the partial-update decision.
const currentContent = existing.content;

// abstractOriginHash semantics:
let nextAbstractOriginHash: string | null | undefined;
if (normalizedAbstract === undefined) {
  // abstract not supplied — preserve unless content also got cleared
  nextAbstractOriginHash = undefined; // Prisma: leave column untouched
} else if (normalizedAbstract === null) {
  // abstract cleared — clear the hash too
  nextAbstractOriginHash = null;
} else {
  // abstract supplied (string) — set to hash of "current content"
  // ("current" means: post-update if content also supplied, else existing)
  const nextContent =
    content !== undefined ? content : currentContent;
  nextAbstractOriginHash = computeContentHash(nextContent);
}

// contentHash semantics: always reflect the post-update content value
let nextContentHash: string | null | undefined;
if (content === undefined) {
  nextContentHash = undefined; // preserve
} else {
  nextContentHash = computeContentHash(content);
}

const data: Prisma.NodeUpdateInput = {
  // ... other partial-update fields ...
  ...(normalizedAbstract !== undefined && { abstract: normalizedAbstract }),
  ...(nextAbstractOriginHash !== undefined && {
    abstractOriginHash: nextAbstractOriginHash,
  }),
  ...(content !== undefined && { content, contentHash: nextContentHash }),
};
```

**Key point on "abstract supplied, content absent" (the FR-003 reset case)**: when the caller updates only the abstract, we treat them as affirming "this abstract matches the **current** content right now." The hash is computed against the unchanged `existing.content`. The staleness signal clears.

## NodeVersion snapshot

Before the `db.node.update` runs, the existing `nodeVersion.create` site MUST capture `existing.abstractOriginHash` in the snapshot (per FR-002). This is the same lesson learned from spec 031.

```typescript
await db.nodeVersion.create({
  data: {
    // ... existing snapshot fields ...
    abstract: existing.abstract,
    abstractOriginHash: existing.abstractOriginHash, // NEW
    content: existing.content,
    // ... rest ...
  },
});
```

## Edge cases

- **abstract value unchanged but supplied** (e.g., caller sends `abstract: "X"` and existing was also `"X"`, no content change): hash gets re-computed but to the same value. No behavioural change. Cheap; not worth a fast-path branch.
- **content unchanged but supplied** (caller sends the same content string): contentHash gets re-computed to the same value. Same as above.
- **encrypted memory**: hash computation runs on plaintext content (passed by caller, OR the existing decrypted value from `existing.content` after `decryptNodeFields` runs on the read of `existing`). The hash column stays plaintext.

## Test coverage

(in `src/mcp/server.nodeAbstractStaleness.test.ts`)

The 9-row matrix above is each one acceptance scenario. Plus:
- NodeVersion snapshot captures `existing.abstractOriginHash` on every update path.
- Encrypted-memory matrix mirror: same 9 rows, but the DB row's `content` column is ciphertext while `abstractOriginHash` is plaintext computed from the plaintext input.
