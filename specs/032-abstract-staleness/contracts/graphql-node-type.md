# Contract: GraphQL `Node` type — abstractOriginHash exposure (read-only)

Spec source: FR-012, plus SC-005.

## Type definition delta

The `Node` type (find via `type Node {` in `src/api/graphql/schema/typeDefs.ts`) gains one field, positioned adjacent to `contentHash`:

```graphql
type Node {
  # ... existing fields ...
  abstract: String
  content: String
  contentHash: String
  "Spec 032 — fingerprint of the `content` value at the time `abstract` was authored. When this differs from `contentHash` and both are non-null, the abstract is stale (summary may no longer match current content). System-managed; never settable. Consumed by the upcoming RAG layer to skip / re-queue stale embeddings."
  abstractOriginHash: String
  tokens: Int
  # ... rest unchanged ...
}
```

**Doc-comment constraints**: triple-quoted string, no backticks (S3). No mention of `extensions.code` because there's no typed error attached to this field — read-only field, no failure modes the caller can encounter.

## `NodeInput` — explicit non-modification

The `NodeInput` input type does **NOT** gain a corresponding field. FR-012 requires `abstractOriginHash` to be system-managed; allowing caller-supplied values would defeat the staleness invariant (a buggy or malicious caller could write `abstractOriginHash = contentHash` and lie about freshness).

**Contract test (SC-005)** asserts the field is absent from `NodeInput`. Use GraphQL introspection at test time:

```typescript
it('NodeInput does NOT expose abstractOriginHash (system-managed, never settable)', async () => {
  const inputType = await introspectInputType('NodeInput');
  const fieldNames = inputType.inputFields.map((f) => f.name);
  expect(fieldNames).not.toContain('abstractOriginHash');
});
```

If a future contributor adds `abstractOriginHash: String` to `NodeInput`, this test fails — the FR-012 invariant is pinned at the schema layer.

**Implementation-level invariant** (per SC-005 strengthening from PR-207 review): every server-side write to `nodes.abstract_origin_hash` MUST flow through `computeContentHash`. The simplest pin is a CI grep gate or a static-analysis unit test:

```typescript
it('every assignment to abstractOriginHash uses computeContentHash', async () => {
  const srcFiles = await glob('src/**/*.ts', { ignore: ['**/*.test.ts', '**/generated/**'] });
  for (const file of srcFiles) {
    const src = await readFile(file, 'utf8');
    // Find lines that assign to abstractOriginHash:
    const assignments = src.matchAll(/abstractOriginHash:\s*([^,}\n]+)/g);
    for (const [match, rhs] of assignments) {
      // Allowed RHS shapes: a call to computeContentHash, a value derived
      // from one (e.g., `nextAbstractOriginHash` local), or `null` /
      // `undefined`. Any literal hash value is suspicious.
      const trimmed = rhs.trim();
      const looksLikeHashLiteral = /^['"`][0-9a-f]+['"`]$/i.test(trimmed);
      expect(looksLikeHashLiteral, `Suspicious abstractOriginHash literal in ${file}: ${match}`).toBe(false);
    }
  }
});
```

The check is heuristic (a clever contributor could route a hash through a variable to bypass it), but it catches the obvious failure mode of "someone hardcoded an `abstractOriginHash: 'abc12345'` to make a test pass" or "someone copied a value from one row to another without recomputing."

## Resolver delta

The `Node` field resolver in `src/api/graphql/schema/resolvers.ts` requires **no explicit resolver function** — Prisma auto-projects the column on `node.findUnique` / `findMany` calls. The field flows through automatically.

The `upsertNode` resolver gains the hash-computation logic per the MCP write-path contracts; the resulting `node.abstractOriginHash` is included in the returned object automatically.

## Test coverage

(in `src/test/integration/node-abstract.test.ts`)

- `upsertNode` create with `abstract + content`: returned `node.abstractOriginHash === computeContentHash(content)`.
- `upsertNode` update with content only: returned `node.abstractOriginHash` is unchanged from prior write.
- `upsertNode` update with abstract only: returned `node.abstractOriginHash` re-computed to match current content.
- `node(loc)` query returns `abstractOriginHash` field for a stale node.
- **SC-005 contract test**: `NodeInput.abstractOriginHash` does not exist (asserted via introspection).
