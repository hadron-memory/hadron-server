# Contract: `h-update-node` — abstractOriginHash maintenance with partial-update semantics

Spec source: FR-003, FR-004, FR-005, FR-006, FR-007.

## Input surface

`abstractOriginHash` is system-managed and is **never** caller-settable.

**One caller-supplied parameter, added by #1126**: `abstractStillAccurate?: boolean`. It sets no value — it is an assertion that re-fingerprints the abstract already stored. See the matrix row and the properties below.

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
| absent + **`abstractStillAccurate: true`** | absent *or* string `Y'` | **set to `computeContentHash(...)` over the `content` supplied in this call, or `existing.content` as read by this call when `content` is omitted** (#1126 — the caller asserts the STORED abstract survives this edit, so it is re-fingerprinted against what this write leaves; identical outcome to re-saving that same abstract text, row 4). **Guarded on the node actually having an abstract** — without the guard this mints a ghost fingerprint on an abstract-less node, contradicting FR-006/FR-007. With `content: null` it lands on FR-007 (`computeContentHash(null)` is null) rather than needing its own row. |

*(Row 3, `absent` / `null`, is unaffected by #1128: the read-time check still requires non-null content, so a preserved hash there fires nothing.)*

### `abstractStillAccurate` — properties of the contract, not of the implementation

- **It is an assertion, not a setting, and it suppresses a correctness check.** It writes no text; it only re-fingerprints the abstract already stored. The marker exists to catch an abstract that quietly stopped matching its node, and this is the one flag that can hide exactly that.
- **Ignored, not rejected, when `abstract` is also supplied** — that path already re-fingerprints, so both spellings mean the same thing and the outcome is identical.
- **Ignored when the node has no abstract** (the guard above).
- **It binds to NEITHER half — and the two halves fail in OPPOSITE directions**, which is the part worth knowing before relying on it (@codex, PR #1139):

- **Abstract side — unsafe.** It re-fingerprints whatever abstract is *stored* when the write lands. A concurrent writer who swapped the abstract in between gets that new text **certified unseen**, and the marker is suppressed on an abstract the caller never read. Pinned by `binds to NEITHER half — an interleaved abstract swap is certified unseen`.
- **Content side — fails safe.** The hash is computed from the `content` supplied in *this* call, or, when `content` is omitted, from `existing.content` as read before the write and outside any lock. If a concurrent writer changes content after that read, this call stores a hash of the **old** body while the row keeps the **new** one — they disagree, so **the marker stays armed**. The assertion silently fails to take effect rather than certifying something false.

So a lost race costs you a suppressed marker on the abstract side and a wasted assertion on the content side. Neither side is checked against what the caller read. If another writer changed either one in between, the caller certifies text they never saw and the marker is suppressed on it. **The fully-bound form needs no flag at all**: pass `abstract` and `content` together and you are writing exactly the two things you compared.

  This was weighed against making the assertion bind (compare-and-swap on the values the caller read) and **declined** — @Holger's ruling, 2026-09-03. Recorded here because a reader who reaches for the flag needs to know what it does not promise.

The load-bearing row is the second: **content updated without abstract → abstractOriginHash is left untouched**. The stored hash will compare unequal to `computeContentHash(new content)` at next read; the staleness signal is armed.

### Schema scope expansion — `content: null` and `abstract: null` must both be valid inputs

The existing `h-update-node` zod schema (per spec 031) declares `content: z.string().optional()`. This matrix's rows that send `content: null` require `content: z.string().nullable().optional()`. Same change is already in place for `abstract` per spec 031 (clearing via `null`); this contract adds the parallel change to `content`. **The zod schema delta MUST land with this contract** (PR-207 review item 3 caught the omission). The plan/tasks treat this as a one-line schema widening, not a feature scope expansion — it's the existing partial-update convention reaching its consistent shape.

## Implementation sketch *(illustrative — not load-bearing; integrate with existing patterns)*

```typescript
import { computeContentHash } from '../lib/contentHash.js';

// ... existing length-cap + trim-then-check on abstract ...

// The encryption-parity follow-up this sketch anticipated HAS shipped
// (spec 041 PR-2, closing #206): h-update-node decrypts `existing` with
// the session key before hashing, and encrypts before persisting. So
// `existing.content` is plaintext by construction rather than by the old
// surface asymmetry, and the decrypt call the sketch predicted is real.
const currentContent = existing.content; // plaintext (decrypted above)

// abstractOriginHash semantics:
let nextAbstractOriginHash: string | null | undefined;
if (normalizedAbstract === undefined) {
  // #1126 — the tenth row. `abstractStillAccurate` is the caller asserting
  // the STORED abstract survives this edit, so re-fingerprint it against
  // what this call is writing. Guarded on an abstract actually existing:
  // without that guard this mints a hash for an abstract that is not
  // there, contradicting FR-006/FR-007.
  const hasStoredAbstract =
    typeof existing.abstract === 'string' && existing.abstract.trim() !== '';
  if (abstractStillAccurate === true && hasStoredAbstract) {
    const nextContent = content !== undefined ? content : currentContent;
    // computeContentHash(null) is null, so clearing content through this
    // branch lands on FR-007 rather than needing its own row.
    nextAbstractOriginHash = computeContentHash(nextContent ?? null);
  } else {
    // abstract not supplied and no assertion — preserve
    nextAbstractOriginHash = undefined; // Prisma: leave column untouched
  }
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

## NodeRevision snapshot

Before the `db.node.update` runs, the existing `nodeRevision.create` site MUST capture `existing.abstractOriginHash` in the snapshot (per FR-002). This is the same lesson learned from spec 031.

```typescript
await db.nodeRevision.create({
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

The **10-row** matrix above is each one acceptance scenario. Plus:
- NodeRevision snapshot captures `existing.abstractOriginHash` on every update path — including an update that ONLY re-stamps the fingerprint, which is still a change to restorable state (#1127).
- Encrypted-memory matrix mirror: same rows. Since spec 041 the handler decrypts before hashing and encrypts before persisting, so the DB row's `content` is ciphertext while `abstractOriginHash` is plaintext computed from the plaintext body.
- **`abstractStillAccurate` (row 10)**: the assertion clears the marker and gives a never-fingerprinted node its first hash; it is IGNORED when `abstract` is also supplied and when the node has no abstract (no ghost fingerprint); and both halves of its race are pinned — an interleaved **abstract** swap is certified unseen (marker suppressed), while an interleaved **content** change leaves the stamped hash disagreeing with the row (marker stays armed, assertion wasted).
