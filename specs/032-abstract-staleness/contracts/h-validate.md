# Contract: `h-validate` — `[stale-abstract]` warning

Spec source: FR-011, plus US3 acceptance scenarios.

## Behaviour

Before the existing per-node loop in `h-validate` (find via the `h-validate` tool body in `src/mcp/server.ts`, near the existing sparse-node and broken-edge checks), compute the encryption gate once. Inside the loop, add a third check using the same staleness predicate as `h-read-node`:

```typescript
import { computeContentHash } from '../lib/contentHash.js';

// Compute the encryption gate once before the loop (see "Encrypted
// memories" section below).
const memEnc = await db.memory.findUnique({
  where: { id: memory.id },
  select: { isEncrypted: true },
});
const checkStale = !memEnc?.isEncrypted;

for (const node of nodes) {
  // Existing checks: sparse-node, broken-edge
  if (!node.description && !node.content && !node.abstract) {
    issues.push(`[sparse] ${nUrn} — no description, content, or abstract`);
  }
  // ... broken-edge check ...

  // Spec 032 — stale-abstract warning (FR-011), post-#1128. Compares
  // against a COMPUTED-AT-READ value, not the stored Node.contentHash
  // column.
  //
  // The `abstractOriginHash != null` guard is GONE (it was PR-207 review
  // item 5). An absent fingerprint now warns exactly as a disagreeing one
  // does — and a missing fingerprint is precisely what an operator running
  // the validator wants told.
  //
  // The predicate is the SAME function the read path uses,
  // isAbstractUnverified. The `checkStale` gate is NOT shared: it is
  // derived from the memory row and h-validate never decrypts, so this
  // surface still skips encrypted memories whether or not a key is held.
  // h-read-node's equivalent gate lifted with spec 041; this one did not.
  if (checkStale && isAbstractUnverified(node)) {
    issues.push(`[stale-abstract] ${nUrn} — abstract may not reflect current content`);
  }
}
```

## Issue-list semantics

Stale-abstract warnings count alongside sparse-node and broken-edge warnings in the existing "Found N issue(s) in M nodes" summary. The consumer-facing report shape is unchanged: one issue list, one count. Each issue type uses its own bracket tag (`[sparse]`, `[broken-ref]`, `[stale-abstract]`) for grepability.

## Selection delta — none required

Same situation as spec 031's `h-validate` extension: the existing `findMany` uses `include` (auto-projects all scalar columns), so `abstractOriginHash` and `contentHash` are already on the returned objects without any select change. No `db.node.findMany` edit required for this contract.

## Encrypted memories

`h-validate` doesn't decrypt nodes. This contract was originally drafted under the assumption that the staleness check would compare two stored hash columns — that design was rejected in PR-207 review in favor of compare-at-read against `computeContentHash(node.content)`. The post-correction predicate computes the hash from `node.content` at read time, so on encrypted memories `node.content` is ciphertext and `computeContentHash(ciphertext)` compares unequal to every plaintext-derived `abstractOriginHash` — false-positive on every node.

**v1 short-circuits the staleness check on encrypted memories** via a `!memory.isEncrypted` gate (matching the h-read-node US2 gate). When the encryption-parity follow-up ([#206](https://github.com/hadron-memory/hadron-server/issues/206)) lands and adds the decrypt step, the gate lifts and the test flips from "zero `[stale-abstract]` warnings on encrypted memory" to "stale nodes flagged regardless of encryption." Tracked under [#206](https://github.com/hadron-memory/hadron-server/issues/206).

Implementation: a single `db.memory.findUnique({ select: { isEncrypted: true } })` before the per-node loop; `const checkStale = !memEnc?.isEncrypted` then guards the predicate inside the loop.

## Test coverage

(in `src/mcp/server.nodeAbstractStaleness.test.ts`)

- Memory with one stale node: report contains `[stale-abstract] <urn>` line for that node.
- Memory with three nodes — fresh / stale / no-abstract: only the stale node is flagged; zero false positives.
- Memory with mix of `[sparse]` + `[broken-ref]` + `[stale-abstract]` issues: each type appears with its own tag; total count is the sum across types.
- Memory dominated by legacy nodes (`abstractOriginHash IS NULL`): zero `[stale-abstract]` warnings (the predicate's NULL check short-circuits). Per D5, this is the "stays quiet by design" property.
- Encrypted memory: zero `[stale-abstract]` warnings — the `!memory.isEncrypted` gate skips the check entirely in v1. Lifts when [#206](https://github.com/hadron-memory/hadron-server/issues/206) ships.
