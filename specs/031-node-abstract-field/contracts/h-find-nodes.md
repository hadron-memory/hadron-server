# Contract: `h-find-nodes` — abstract in preview + haystack

Spec source: FR-006, FR-007. User stories US2 and US3.

## Input surface

No new parameters. The existing zod schema at
[server.ts:939-947](../../../src/mcp/server.ts#L939-L947) is unchanged:

```typescript
{
  query: z.string(),
  brief: z.boolean().optional(),
  memoryUrn: z.string().optional(),
  parentRel: z.string().optional(),
}
```

`brief: true` becomes the off-switch for the abstract in the preview shape (per FR-006). The tool
docstring on `brief` ("Return index info only: name, description, edges") MUST NOT be revised — it
remains accurate post-spec because brief deliberately excludes the abstract.

## Search haystack delta (FR-007)

The existing match function at
[server.ts:402-414](../../../src/mcp/server.ts#L402-L414) currently joins `name`, `loc`,
`description`, and `tags` into the substring search target. Post-spec, abstract joins the join:

```typescript
function matchesQuery(
  node: { name: string; loc: string; description: string | null; abstract: string | null; tags: string[] },
  terms: string[]
): boolean {
  const haystack = [
    node.name,
    node.loc,
    node.description || '',
    node.abstract || '',     // ← NEW
    ...node.tags,
  ].join(' ').toLowerCase();
  return terms.every((t) => haystack.includes(t.toLowerCase()));
}
```

Search semantics are unchanged otherwise — case-insensitive substring, ALL whitespace-separated
terms must appear, no fuzzy / no stemming. `query: "*"` and `query: ""` survey-mode behavior is
unchanged (matches all live nodes; haystack content doesn't affect membership).

## Preview shape delta (FR-006)

The existing preview renderer at
[server.ts:1056-1075](../../../src/mcp/server.ts#L1056-L1075) emits per-result:

```
<urn> — <name>
  > <description>          ← when description is non-null
```

Post-spec (when `brief: false`, the default):

```
<urn> — <name>
  > <description>          ← when description is non-null
  | <abstract>             ← NEW, when abstract is non-null
```

- The `> ` prefix on description is preserved (existing quote-mark convention for the headline).
- The `| ` prefix on abstract distinguishes it as a paragraph block (per research.md D5a).
- Multi-paragraph abstracts (rare, but allowed up to 2000 chars) get the prefix on EACH line.
- When abstract is `null`, no line is emitted — preview is byte-identical to pre-spec.

When `brief: true`, the abstract is excluded from the response shape entirely — only `name`,
`description`, and edges remain (per the existing brief docstring).

## Implementation sketch

```typescript
// Selection — abstract joins the column projection
const nodes = await db.node.findMany({
  where: { /* ... existing filters ... */ },
  select: { id: true, loc: true, memoryId: true, name: true, description: true, abstract: true, tags: true, ... },
});

// Filter via matchesQuery (now reads node.abstract too)
const hits = nodes.filter((n) => matchesQuery(n, terms));

// Preview render
const lines: string[] = [];
for (const n of hits) {
  const urn = await nodeUrn(n.loc, n.memoryId);
  lines.push(`${urn} — ${n.name}`);
  if (n.description) lines.push(`  > ${n.description}`);
  if (!brief && n.abstract) {                     // ← NEW: brief carve-out
    const abstractLines = n.abstract.split('\n').map((l) => `  | ${l}`);
    lines.push(...abstractLines);
  }
}
```

## Response when `brief: true`

The existing brief-mode response shape is preserved — `name`, `description`, and edges. The
abstract is searched against (per FR-007's "still searches against it") but not included in the
response body.

```typescript
if (brief) {
  // Existing brief-mode rendering — unchanged. Does NOT emit abstract.
}
```

## Test coverage

- US2 acceptance scenario 1 — node with abstract emits the `| <abstract>` block.
- US2 acceptance scenario 2 — node without abstract is byte-identical to pre-spec.
- US2 acceptance scenario 3 — `brief: true` excludes abstract from response but still searches.
- US3 acceptance scenario 1 — keyword matching an abstract-only term returns the node.
- US3 acceptance scenario 2 — monotonic-additive search property: every pre-spec hit still hits.
- US3 acceptance scenario 3 — `query: "*"` survey-mode is unchanged.
