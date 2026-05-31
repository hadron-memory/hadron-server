# Contract: `h-validate` — `[stale-abstract]` warning

Spec source: FR-011, plus US3 acceptance scenarios.

## Behaviour

Inside the existing per-node loop in `h-validate` (find via the `h-validate` tool body in `src/mcp/server.ts`, near the existing sparse-node and broken-edge checks), add a third check using the same staleness predicate as `h-read-node`:

```typescript
import { computeContentHash } from '../lib/contentHash.js';

// Existing checks: sparse-node, broken-edge
if (!node.description && !node.content && !node.abstract) {
  issues.push(`[sparse] ${nUrn} — no description, content, or abstract`);
}
// ... broken-edge check ...

// Spec 032 — stale-abstract warning (FR-011). Compares against a
// COMPUTED-AT-READ value, not the stored Node.contentHash column.
// The explicit abstractOriginHash != null guard prevents false
// positives on legacy nodes (PR-207 review item 5).
if (
  node.abstract != null && node.abstract.length > 0 &&
  node.content != null && node.content.length > 0 &&
  node.abstractOriginHash != null &&
  node.abstractOriginHash !== computeContentHash(node.content)
) {
  issues.push(`[stale-abstract] ${nUrn} — abstract may not reflect current content`);
}
```

## Issue-list semantics

Stale-abstract warnings count alongside sparse-node and broken-edge warnings in the existing "Found N issue(s) in M nodes" summary. The consumer-facing report shape is unchanged: one issue list, one count. Each issue type uses its own bracket tag (`[sparse]`, `[broken-ref]`, `[stale-abstract]`) for grepability.

## Selection delta — none required

Same situation as spec 031's `h-validate` extension: the existing `findMany` uses `include` (auto-projects all scalar columns), so `abstractOriginHash` and `contentHash` are already on the returned objects without any select change. No `db.node.findMany` edit required for this contract.

## Encrypted memories

`h-validate` doesn't decrypt nodes — the validation logic runs against the DB row directly. Since `abstractOriginHash` and `contentHash` are plaintext metadata (per FR-009), the staleness check works on encrypted memories without any decryption step. The validator doesn't care that `content` is ciphertext for this check — it's comparing two hash columns, not the content itself.

## Test coverage

(in `src/mcp/server.nodeAbstractStaleness.test.ts`)

- Memory with one stale node: report contains `[stale-abstract] <urn>` line for that node.
- Memory with three nodes — fresh / stale / no-abstract: only the stale node is flagged; zero false positives.
- Memory with mix of `[sparse]` + `[broken-ref]` + `[stale-abstract]` issues: each type appears with its own tag; total count is the sum across types.
- Memory dominated by legacy nodes (`abstractOriginHash IS NULL`): zero `[stale-abstract]` warnings (the predicate's NULL check short-circuits). Per D5, this is the "stays quiet by design" property.
- Encrypted memory: the predicate evaluates correctly without decryption.
