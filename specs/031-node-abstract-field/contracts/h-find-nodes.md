# Contract: `h-find-nodes` — abstract in preview (haystack unchanged)

Spec source: FR-006. User story US2.

**Scope note (PR-196 review)**: US3 / FR-007 — extending the search haystack to include
abstract — is **deferred to the RAG / vector-retrieval follow-up**. This contract describes the
preview-rendering change ONLY. The substring search haystack remains `name + loc + description +
tags` (pre-spec behavior), unchanged.

## Input surface

**No new parameters.** The existing zod input schema on the `'h-find-nodes'` tool registration
in `src/mcp/server.ts` is unchanged:

```typescript
{
  query: z.string(),
  brief: z.boolean().optional(),
  memoryUrn: z.string().optional(),
  parentRel: z.string().optional(),
}
```

The existing tool docstring on `brief` ("Return index info only: name, description, edges") is
also unchanged — it remains accurate post-spec.

## Search haystack — unchanged

`matchesQuery` (find the helper in `src/mcp/server.ts` — currently named `matchesQuery` and
takes a node + terms array) joins `name`, `loc`, `description`, and `tags` into the substring
target. Post-spec: **no change**. `abstract` is NOT added to the haystack.

A term appearing only in a node's abstract continues to produce zero hits via `h-find-nodes`
until the RAG layer ships. Brief mode is therefore symmetric: it doesn't return the abstract,
and it doesn't search against it either.

## Preview shape delta (FR-006)

The existing preview renderer lives inside the `'h-find-nodes'` tool body in `src/mcp/server.ts`
(search for `server.tool('h-find-nodes'` and find the result-rendering block). Per-result, it
currently emits:

```
<urn> — <name>
  > <description>          ← when description is non-null
```

Post-spec (when `brief: false`, the default):

```
<urn> — <name>
  > <description>          ← when description is non-null
  | <abstract>             ← NEW, when abstract is non-null AND brief: false
```

- The `> ` prefix on description is preserved (existing quote-mark convention for the headline).
- The `| ` prefix on abstract distinguishes it as a paragraph block (per research.md D5a). See
  research.md note: empirical verification in a markdown-rendering client is recommended before
  freezing this choice.
- Multi-paragraph abstracts (rare, but allowed up to 2000 chars) get the prefix on EACH line.
- When abstract is `null`, no line is emitted — preview is byte-identical to pre-spec.

When `brief: true`, the abstract is excluded from the response shape entirely — same as pre-spec
brief mode.

## Implementation sketch *(illustrative — not load-bearing; integrate with existing patterns)*

```typescript
// Selection — abstract joins the column projection
const nodes = await db.node.findMany({
  where: { /* ... existing filters ... */ },
  select: { id: true, loc: true, memoryId: true, name: true, description: true, abstract: true, tags: true, /* ... */ },
});

// Filter via matchesQuery — UNCHANGED haystack, abstract NOT added
const hits = nodes.filter((n) => matchesQuery(n, terms));

// Preview render
const lines: string[] = [];
for (const n of hits) {
  const urn = await nodeUrn(n.loc, n.memoryId);   // illustrative — respect any batched-urn
                                                    // pattern that has resolved the existing
                                                    // N+1 here
  lines.push(`${urn} — ${n.name}`);
  if (n.description) lines.push(`  > ${n.description}`);
  if (!brief && n.abstract) {                     // brief is the off-switch for preview
    const abstractLines = n.abstract.split('\n').map((l) => `  | ${l}`);
    lines.push(...abstractLines);
  }
}
```

The sketch above shows the *shape* of the preview-rendering change. The existing per-result
`await nodeUrn(...)` produces an N+1 lookup; that pattern predates this spec and is preserved
faithfully in the sketch, but if a batched-urn resolution has landed in the meantime, integrate
with that instead. The `if (!brief && n.abstract)` branch is the load-bearing addition.

## Response when `brief: true`

The existing brief-mode response shape is preserved byte-for-byte — `name`, `description`, and
edges. The abstract is NOT included in the response body, and (per US3 deferral) is NOT searched
against either.

```typescript
if (brief) {
  // Existing brief-mode rendering — unchanged. Does NOT emit abstract.
  // Does NOT extend the haystack (US3 deferred — RAG follow-up).
}
```

## Test coverage

- **US2 acceptance scenario 1** — node with abstract emits the `| <abstract>` block.
- **US2 acceptance scenario 2** — node without abstract is byte-identical to pre-spec.
- **US2 acceptance scenario 3** — `brief: true` excludes abstract from response; preserves the
  pre-spec brief shape byte-for-byte. (With US3 deferred, no asymmetric-search test needed.)
- **US2 acceptance scenario 4** — `h-list-nodes` byte-identical to pre-spec for every node
  (covered in `h-list-nodes` test surface).

US3 acceptance scenarios are **deferred to the RAG follow-up spec** — not implemented here.
