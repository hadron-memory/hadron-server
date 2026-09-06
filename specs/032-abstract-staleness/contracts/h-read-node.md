# Contract: `h-read-node` — `Source: abstract-stale` marker

Spec source: FR-010, plus US2 acceptance scenarios.

## Input surface

**No new parameters.** The existing `contentScope` enum from spec 031 is unchanged.

## Behaviour

The predicate runs on **plaintext** `node.content`. As drafted, the MCP read path did not decrypt, so the predicate was short-circuited on encrypted memories by a `!memory.isEncrypted` gate — otherwise `computeContentHash(ciphertext)` false-positives on every node. **That gate has since lifted** (spec 041 PR-2, closing [#206](https://github.com/hadron-memory/hadron-server/issues/206)): `mcpDecryptOrMark` decrypts when the session holds the memory's key and flips the projection's `isEncrypted` to false, so the marker fires on an **unlocked** encrypted memory and a locked one emits nothing. **No longer symmetric with h-validate**, which never gained a decrypt step and keeps its gate — see that contract.

Compute staleness once at the top of the response-shape branch:

```typescript
import { computeContentHash } from '../lib/contentHash.js';

const hasContent = !!(node.content && node.content.length > 0);
const hasAbstract = !!(node.abstract && node.abstract.length > 0);
const isFallback = scope === 'content' && !hasContent && hasAbstract;

// Scope gate hoisted ABOVE the predicate so the default 'content' scope
// skips the encryption check AND the SHA-256 recomputation entirely —
// the default read path stays zero-cost (PR-210 review).
const shouldCheckStale = scope === 'abstract' || scope === 'all';

// Spec 032 — staleness check, post-#1128. The comparison is against a
// COMPUTED-AT-READ value, NOT the stored Node.contentHash column (which
// has its own domain from external producers; see data-model.md "What
// is NOT in this data model").
//
// The `abstractOriginHash != null` guard is GONE. It was load-bearing
// when every row predated the column; since #1128 an absent fingerprint
// arms the marker exactly as a disagreeing one does, because an abstract
// that was never fingerprinted has never been checked against its body.
//
// The predicate itself now lives in ONE place — isAbstractUnverified in
// src/lib/contentHash.ts — shared with hadron_find_nodes and h-validate.
// The scope and encryption gates stay at the call site: they are
// properties of THIS call, not of the node.
const includeStaleMarker =
  shouldCheckStale &&
  // TRUE for an unlocked encrypted memory: since spec 041,
  // mcpDecryptOrMark sets node.memory.isEncrypted = false on the
  // PROJECTION once it has decrypted, so the gate ADMITS that case and
  // the marker is checked. Only a LOCKED memory is skipped here.
  !node.memory.isEncrypted &&
  isAbstractUnverified(node);

// Marker emission:
//   - Source: abstract-fallback fires under default scope + content-less
//     abstract-having node (spec 031 FR-005)
//   - Source: abstract-stale fires under any scope that surfaces the
//     abstract, IF the node is stale (spec 032 FR-010)
//   The two are mutually exclusive in practice — fallback requires
//   content IS NULL, stale requires content IS NOT NULL.
```

The `memory.isEncrypted` value rides the same `db.node.findFirst` round-trip via `include: { memory: { select: { isEncrypted: true } } }` — no extra DB query (PR-210 review).

## Meta block placement

The new marker sits in the same meta-block slot as `Source: abstract-fallback` (per research D6):

```
**<name>**
<urn>
> <description>
Type: <nodeType>
Source: abstract-stale          ← NEW (FR-010): when isStale + abstract is in response
Source: abstract-fallback       ← from spec 031: when content-less node fires fallback
Tags: ...
Seq: ...
...
```

(Only one `Source:` line emits per response — the two conditions are mutually exclusive.)

## Response-shape matrix delta vs spec 031

The 12-cell contentScope × abstract-state × content-state matrix from spec 031 still applies; spec 032 adds **one signal** that overlays the meta block when the abstract is in the response AND the node is stale. Updated matrix (only the rows where the new marker appears are listed; all other rows render identically to spec 031):

| `contentScope` | abstract | content | stale? | Response shape |
|---|---|---|---|---|
| `'abstract'` | ✓ | ✓ | yes | `meta + Source: abstract-stale + abstract` (no `---`, no body) |
| `'all'` | ✓ | ✓ | yes | `meta + Source: abstract-stale + abstract + --- + content` |

Every other row from spec 031's matrix is unchanged. Notably:
- **Default scope (`'content'`)** never emits `Source: abstract-stale` — the abstract isn't in the response, so the marker would alarm without reason (FR-010).
- **Content-less abstract-having node** under default scope emits `Source: abstract-fallback` per spec 031 — NOT `Source: abstract-stale` (no content to be stale against).

## Implementation sketch *(illustrative)*

```typescript
const metaLines = [
  `**${node.name}**`,
  urn,
  node.description ? `> ${node.description}` : '',
  `Type: ${node.nodeType}`,
  isFallback ? 'Source: abstract-fallback' : '',
  includeStaleMarker ? 'Source: abstract-stale' : '',  // NEW
  node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
  // ... rest unchanged ...
].filter(Boolean).join('\n');

// Body rendering by scope: unchanged from spec 031.
```

## Test coverage

(in `src/mcp/server.nodeAbstractStaleness.test.ts`)

- Fresh node (`abstractOriginHash == contentHash`), `contentScope: 'all'`: NO `Source: abstract-stale` line.
- Stale node, `contentScope: 'all'`: marker present, abstract + content render normally.
- Stale node, `contentScope: 'abstract'`: marker present, abstract only (no body).
- Stale node, `contentScope: 'content'` (default): NO marker (abstract isn't in response).
- Content-less abstract-having node, default scope: `Source: abstract-fallback` from spec 031; NO `Source: abstract-stale`.
- Legacy node (`abstractOriginHash IS NULL`, abstract + content both populated): NO marker — staleness check short-circuits.
- Encrypted memory: marker is SUPPRESSED in v1 (the `!memory.isEncrypted` gate skips the predicate entirely). When the encryption-parity follow-up ([#206](https://github.com/hadron-memory/hadron-server/issues/206)) lands and adds a decrypt step before the predicate, this test flips to "marker emits if stale on encrypted memories too" — tracked under [#206](https://github.com/hadron-memory/hadron-server/issues/206).
