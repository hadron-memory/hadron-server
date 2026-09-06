# Contract: `h-update-node` — abstractOriginHash maintenance with partial-update semantics

Spec source: FR-003, FR-004, FR-005, FR-006, FR-007.

## Input surface

**No new parameters.** `abstractOriginHash` is system-managed.

## Behaviour matrix

`h-update-node` is a partial update; the abstractOriginHash semantics depend on which of `abstract` / `content` were supplied. The matrix below covers only `abstractOriginHash` behaviour — `Node.contentHash` is **NOT** touched by this spec (see data-model.md):

| `abstract` field | `content` field | Behaviour on abstractOriginHash |
|---|---|---|
| absent | absent | preserve existing |
| absent | string `Y'` | **preserve existing** (FR-004 — staleness signal arms; the stored hash will compare unequal to `computeContentHash("Y'")` at next read) |
| absent | `null` | preserve existing (FR-007 — ghost-hash; doesn't fire staleness because the read-time check requires content non-null) |
| string `X'` | absent | **set to `computeContentHash(existing.content)`** (FR-003 — author affirms abstract matches **current** content; "current" = existing because content wasn't supplied) |
| string `X'` | string `Y'` | **set to `computeContentHash("Y'")`** (FR-005 — both writes match) |
| string `X'` | `null` | set to `null` (FR-007 — no content = no hash) |
| `null` | absent | **set to `null`** (FR-006 — no abstract = no hash) |
| `null` | string `Y'` | set to `null` (FR-006) |
| `null` | `null` | hash set to null |
| absent + **`abstractStillAccurate: true`** | absent *or* string `Y'` | **set to `computeContentHash(next content)`** (#1126 — the caller asserts the STORED abstract survives this edit, so it is re-fingerprinted against what this write leaves; identical outcome to re-saving that same abstract text, row 4). **Guarded on the node actually having an abstract** — without the guard this mints a ghost fingerprint on an abstract-less node, contradicting FR-006/FR-007. With `content: null` it lands on FR-007 (`computeContentHash(null)` is null) rather than needing its own row. |

*(Row 3, `absent` / `null`, is unaffected by #1128: the read-time check still requires non-null content, so a preserved hash there fires nothing.)*

### `abstractStillAccurate` — properties of the contract, not of the implementation

- **It is an assertion, not a setting, and it suppresses a correctness check.** It writes no text; it only re-fingerprints the abstract already stored. The marker exists to catch an abstract that quietly stopped matching its node, and this is the one flag that can hide exactly that.
- **Ignored, not rejected, when `abstract` is also supplied** — that path already re-fingerprints, so both spellings mean the same thing and the outcome is identical.
- **Ignored when the node has no abstract** (the guard above).
- **It binds to NEITHER half.** It re-fingerprints whatever abstract is *stored* when the write lands, against whatever content that write *leaves* — neither is checked against what the caller read. If another writer changed either one in between, the caller certifies text they never saw and the marker is suppressed on it. **The fully-bound form needs no flag at all**: pass `abstract` and `content` together and you are writing exactly the two things you compared.

  This was weighed against making the assertion bind (compare-and-swap on the values the caller read) and **declined** — @Holger's ruling, 2026-09-03. Recorded here because a reader who reaches for the flag needs to know what it does not promise.

The load-bearing row is the second: **content updated without abstract → abstractOriginHash is left untouched**. The stored hash will compare unequal to `computeContentHash(new content)` at next read; the staleness signal is armed.

### Schema scope expansion — `content: null` and `abstract: null` must both be valid inputs

The existing `h-update-node` zod schema (per spec 031) declares `content: z.string().optional()`. This matrix's rows that send `content: null` require `content: z.string().nullable().optional()`. Same change is already in place for `abstract` per spec 031 (clearing via `null`); this contract adds the parallel change to `content`. **The zod schema delta MUST land with this contract** (PR-207 review item 3 caught the omission). The plan/tasks treat this as a one-line schema widening, not a feature scope expansion — it's the existing partial-update convention reaching its consistent shape.

## Implementation sketch *(illustrative — not load-bearing; integrate with existing patterns)*

```typescript
import { computeContentHash } from '../lib/contentHash.js';

// ... existing length-cap + trim-then-check on abstract ...

// On encrypted memories, existing.content arrives ciphertext via
// db.node.findUnique (no decryptNodeFields call in h-update-node today
// — pre-existing surface asymmetry per spec 031 round-2 review and
// gap-tracking issue #206). For non-encrypted memories OR for encrypted
// memories accessed via MCP today (where content is stored plaintext
// per the same asymmetry), `existing.content` IS plaintext.
// When the MCP encryption-parity follow-up ships, this sketch grows
// a `decryptNodeFields(existing, memEncInfo)` call here.
const currentContent = existing.content;

// abstractOriginHash semantics:
let nextAbstractOriginHash: string | null | undefined;
if (normalizedAbstract === undefined) {
  // abstract not supplied — preserve
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

const data: Prisma.NodeUpdateInput = {
  // ... other partial-update fields ...
  ...(normalizedAbstract !== undefined && { abstract: normalizedAbstract }),
  ...(nextAbstractOriginHash !== undefined && {
    abstractOriginHash: nextAbstractOriginHash,
  }),
  ...(content !== undefined && { content }),
  // contentHash is NOT touched — see data-model.md
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
