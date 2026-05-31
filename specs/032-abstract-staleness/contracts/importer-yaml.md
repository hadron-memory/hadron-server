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

### Importer behaviour

When parsing a node's frontmatter:

```typescript
import { computeContentHash } from '../../lib/contentHash.js';

// ... existing parse + normalize ...

// Spec 032 — handle abstractOriginHash per FR-013:
//   - YAML carries the key → trust the value (preserves staleness state
//     across export → import round-trips, even when the YAML was edited
//     externally and the hash no longer matches content)
//   - YAML omits the key → recompute from imported content (treats the
//     YAML as a fresh authored write; safe default)
//   - The abstract is null → abstractOriginHash MUST be null regardless
//     of what YAML says (parallel to the FR-006 write-path rule)
let abstractOriginHash: string | null;
const normalizedAbstract = normalizeImportedAbstract(meta.abstract);
if (normalizedAbstract === null) {
  abstractOriginHash = null;
} else if (typeof meta.abstractOriginHash === 'string') {
  abstractOriginHash = meta.abstractOriginHash;
} else {
  abstractOriginHash = computeContentHash(content);
}

return {
  node: {
    // ... existing fields ...
    abstract: normalizedAbstract,
    abstractOriginHash,
    content,
    contentHash: computeContentHash(content),
    // ... rest ...
  },
  edges,
};
```

(The `computeContentHash(content)` call for `contentHash` is the spec-032-implicit fix for "server doesn't compute contentHash today" — the importer was the only server-side surface that previously stored contentHash, and it pulled it from `meta.contentHash`. Now the importer computes it from content with a fallback to the YAML value. Documented as a side-effect in research D3; not a separate FR.)

### Defensive type handling

The same `typeof raw === 'object'` rejection from spec 031's `normalizeImportedAbstract` applies for `abstractOriginHash` too — YAML's loose typing means a frontmatter shape like `abstractOriginHash:\n  nested: true` would parse as an object. Reject defensively:

```typescript
const yamlHash = meta.abstractOriginHash;
if (typeof yamlHash === 'string') {
  abstractOriginHash = yamlHash;
} else if (yamlHash == null || typeof yamlHash === 'object') {
  // Missing or malformed → recompute (or null if no content)
  abstractOriginHash = computeContentHash(content);
}
```

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

Per FR-013 + SC-006:

1. Write a node with `abstract: "X"`, `content: "Y"` (hash `hash("Y")` stored).
2. Update only content to `"Y'"` (`abstractOriginHash` stays at `hash("Y")` — stale).
3. Export to YAML: frontmatter contains `abstractOriginHash: <hash("Y")>` AND content body of `"Y'"`.
4. Re-import: live row's `abstractOriginHash = hash("Y")`, `content = "Y'"`, `contentHash = hash("Y'")`.
5. Read with `contentScope: 'all'`: `Source: abstract-stale` marker present.

The staleness state survives the round-trip. Without FR-013, the importer would recompute `abstractOriginHash` from imported content (`= hash("Y'")`), masking the staleness.

## Test coverage

(in `src/integrations/localFs/loadNodeFromFs.test.ts`)

- YAML with `abstractOriginHash:` populated: importer trusts the value (doesn't recompute).
- YAML without `abstractOriginHash:` key: importer recomputes from content.
- YAML with `abstract` absent: importer sets `abstractOriginHash = null` regardless of what YAML says.
- YAML with object-shaped `abstractOriginHash:`: defensive rejection → recompute (parallel to spec 031's object-rejection in `normalizeImportedAbstract`).

And the round-trip test extending an existing fixture in `src/test/integration/node-abstract.test.ts`: write → export → import → verify staleness state preserved.
