# Contract: node.yaml importer/exporter — abstractOriginHash round-trip

Spec source: FR-013.

## Importer surface — `src/integrations/localFs/loadNodeFromFs.ts`

### YAML schema

The frontmatter `NodeYaml` interface gains an optional key:

```typescript
interface NodeYaml {
  // ... existing keys ...
  abstract?: string;
  /** Spec 032 — fingerprint of `content` at the time `abstract` was
   *  authored. Present in YAML round-trip from a hadron-server export;
   *  may be absent in YAML authored by hand (importer recomputes from
   *  `content` in that case). */
  abstractOriginHash?: string;
  // ... rest unchanged ...
}
```

### Importer behaviour (FR-013 validate-on-import model)

When parsing a node's frontmatter:

```typescript
import { computeContentHash } from '../../lib/contentHash.js';

// ... existing parse + normalize ...

const normalizedAbstract = normalizeImportedAbstract(meta.abstract);
let abstractOriginHash: string | null;

if (normalizedAbstract === null) {
  // No abstract → no hash (parallel to FR-006 write-path rule)
  abstractOriginHash = null;
} else {
  // Compute the canonical hash from the imported content.
  const computed = computeContentHash(content);
  const yamlHash = meta.abstractOriginHash;

  // Defensive type handling (only `string` is acceptable; null/object/
  // number/array all fall through to "recompute" — same pattern as
  // spec 031's normalizeImportedAbstract rejection).
  if (typeof yamlHash !== 'string') {
    // YAML omits the key OR carries a malformed value → recompute
    // (treats the import as a fresh authored write — safe default).
    abstractOriginHash = computed;
  } else if (yamlHash === computed) {
    // YAML value matches our recomputed value — clean round-trip.
    abstractOriginHash = yamlHash;
  } else {
    // YAML carries a hash that disagrees with computed(content).
    // This means EITHER the export captured a legitimately-stale
    // state (content updated after abstract on the source side) OR
    // the YAML was tampered with externally. Accept the YAML value
    // (preserves round-trip integrity of legitimately-stale exports)
    // but emit a warning in the sync log so tampering is observable.
    console.warn(
      `[loadNodeFromFs] abstractOriginHash mismatch for loc=${loc}: ` +
        `YAML claims ${yamlHash}, computed ${computed}. Accepting YAML ` +
        `value (FR-013 round-trip preservation); possible tampering ` +
        `or legitimate exported-stale state.`,
    );
    abstractOriginHash = yamlHash;
  }
}

return {
  node: {
    // ... existing fields ...
    abstract: normalizedAbstract,
    abstractOriginHash,
    content,
    // contentHash is NOT touched by this spec — existing semantics preserved
    // ... rest ...
  },
  edges,
};
```

**Trust model**: the YAML producer is in the trust boundary (the importer is a privileged sync surface), so the importer accepts a YAML-supplied hash even when it disagrees with the recomputed value. The warning is observability — it surfaces the disagreement in the sync log without blocking the import. PR-207 review item additional-1 surfaced this design space; FR-013 codifies the middle-ground "accept + warn" choice.

### Defensive type handling

The `typeof yamlHash !== 'string'` check above covers all malformed shapes (null, object, array, number, boolean) by falling through to the "recompute" branch. Same pattern as spec 031's `normalizeImportedAbstract` object-rejection (PR-201 round-2 fix). The check is universal: only a string-shaped YAML value is even considered for the round-trip path.

## Exporter surface — `src/integrations/github/writeNodeToGit.ts`

### YAML schema

The frontmatter object construction adds an optional key:

```typescript
const frontmatter: Record<string, unknown> = {
  name: node.name,
  id: node.id,
};
if (node.alias) frontmatter.alias = node.alias;
if (node.description) frontmatter.description = node.description;
if (node.abstract) frontmatter.abstract = node.abstract;
// Spec 032 — export the hash so import round-trips preserve staleness.
// Omitted when null per the existing omit-on-null convention.
if (node.abstractOriginHash) {
  frontmatter.abstractOriginHash = node.abstractOriginHash;
}
if (node.tags.length > 0) frontmatter.tags = node.tags;
```

### `NodeForGit` interface

Extend the existing interface:

```typescript
export interface NodeForGit {
  // ... existing fields ...
  abstract?: string | null;
  /** Spec 032 — fingerprint exported alongside `abstract` so round-trip
   *  preserves the staleness signal byte-for-byte. */
  abstractOriginHash?: string | null;
  content?: string | null;
  // ... rest ...
}
```

The `upsertNode` resolver and the MCP write paths that call `writeNodeToGit(...)` MUST be updated to include `abstractOriginHash` in the payload (same pattern as `abstract` from spec 031).

## Round-trip property

Per FR-013 + SC-006 (validate-on-import with accept + warn):

1. Write a node with `abstract: "X"`, `content: "Y"` (hash `hash("Y")` stored).
2. Update only content to `"Y'"` (`abstractOriginHash` stays at `hash("Y")` — stale).
3. Export to YAML: frontmatter contains `abstractOriginHash: <hash("Y")>` AND content body of `"Y'"`.
4. Re-import: importer computes `hash("Y'")`, compares to YAML's `hash("Y")` → mismatch → emit warning in sync log, accept YAML value. Live row: `abstractOriginHash = hash("Y")`, `content = "Y'"`.
5. Read with `contentScope: 'all'`: `Source: abstract-stale` marker present.

The staleness state survives the round-trip; the warning surfaces the disagreement during import. Without FR-013's accept-on-mismatch, the importer would silently recompute (= `hash("Y'")`), masking the staleness — exactly the failure mode the spec exists to prevent.

## Test coverage

(in `src/integrations/localFs/loadNodeFromFs.test.ts`)

- YAML with `abstractOriginHash:` that **matches** the computed hash of imported content: clean round-trip, no warning emitted.
- YAML with `abstractOriginHash:` that **disagrees** with computed: importer accepts the YAML value AND emits a warning (assert via `vi.spyOn(console, 'warn')`).
- YAML without `abstractOriginHash:` key: importer recomputes from content; no warning (this is the "first-time import" case, not a tampering signal).
- YAML with `abstract` absent: importer sets `abstractOriginHash = null` regardless of what YAML says.
- YAML with non-string `abstractOriginHash:` (number, boolean, object, array): defensive fall-through to recompute (parallel to spec 031's object-rejection in `normalizeImportedAbstract`); no warning (treated same as "missing").

And the round-trip test extending an existing fixture in `src/test/integration/node-abstract.test.ts`: write stale node → export → import → verify (a) staleness state preserved AND (b) the disagreement warning fired.
