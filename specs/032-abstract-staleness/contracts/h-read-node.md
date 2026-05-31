# Contract: `h-read-node` — `Source: abstract-stale` marker

Spec source: FR-010, plus US2 acceptance scenarios.

## Input surface

**No new parameters.** The existing `contentScope` enum from spec 031 is unchanged.

## Behaviour

The predicate runs on `node.content` as-stored. **The MCP read path does NOT call `decryptNodesBatch` today** (asymmetry tracked by [#206](https://github.com/hadron-memory/hadron-server/issues/206)) — on encrypted memories `node.content` is ciphertext, and `computeContentHash(ciphertext)` would compare unequal to every plaintext-derived `abstractOriginHash` (false-positive on every node). **v1 short-circuits the predicate on encrypted memories** via a `!memory.isEncrypted` gate; the encryption-parity follow-up lifts the gate by adding a decrypt step before the predicate. This contract was originally drafted under the assumption that h-read-node already decrypted — it does not, and the gate is the safe v1 posture. Symmetric with the h-validate gate (US3).

Compute staleness once at the top of the response-shape branch:

```typescript
import { computeContentHash } from '../lib/contentHash.js';

const hasContent = !!(node.content && node.content.length > 0);
const hasAbstract = !!(node.abstract && node.abstract.length > 0);
const isFallback = scope === 'content' && !hasContent && hasAbstract;

// Scope gate hoisted ABOVE the predicate so the default 'content' scope
// skips the encryption check, the null-hash guard, AND the SHA-256
// recomputation entirely — byte-identical-pre-spec read path stays
// zero-cost (PR-210 review).
const shouldCheckStale = scope === 'abstract' || scope === 'all';

// Spec 032 — staleness check. Note the comparison is against a
// COMPUTED-AT-READ value, NOT the stored Node.contentHash column (which
// has its own domain from external producers; see data-model.md "What
// is NOT in this data model"). The explicit `!= null` on
// abstractOriginHash is load-bearing: legacy nodes have null hash even
// when abstract + content are populated, and `null !== "abc12345"`
// evaluates true — that would fire the marker falsely without the guard.
let includeStaleMarker = false;
if (
  shouldCheckStale &&
  !node.memory.isEncrypted &&     // v1 gate; see #206
  hasAbstract &&
  hasContent &&
  node.abstractOriginHash != null
) {
  includeStaleMarker =
    node.abstractOriginHash !== computeContentHash(node.content);
}

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
- Encrypted memory: marker is SUPPRESSED in v1 (the `!memory.isEncrypted` gate skips the predicate entirely). When the encryption-parity follow-up ([#206](https://github.com/hadron-memory/hadron-server/issues/206)) lands and adds a decrypt step before the predicate, this test flips to "marker emits if stale on encrypted memories too" — tracked alongside [#211](https://github.com/hadron-memory/hadron-server/issues/211).
