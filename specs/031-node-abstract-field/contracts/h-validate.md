# Contract: `h-validate` — sparse-node rule extension

Spec source: FR-011.

## Current behavior

The sparse-node check inside the `'h-validate'` tool handler in `src/mcp/server.ts` (find the
conditional `!node.description && !node.content` within the `h-validate` tool body) currently is:

```typescript
if (!node.description && !node.content) {
  issues.push(`[sparse] ${nUrn} — no description and no content`);
}
```

A node carrying only a description, only a content, or both, escapes the sparse warning. A node
with neither gets flagged.

## Post-spec behavior

The rule extends to consider `abstract` as a third legitimate text source:

```typescript
if (!node.description && !node.content && !node.abstract) {
  issues.push(`[sparse] ${nUrn} — no description, content, or abstract`);
}
```

A node carrying ONLY an abstract (e.g., a `nodeType='abstract'` archive node) is NOT sparse — the
abstract counts as legitimate content for the validator's "this node has zero text" intent.

## Selection delta

The `select` clause inside `h-validate` that pulls nodes for the validator (find via the Prisma
`db.node.findMany({ ... select: { id: true, loc: true, name: true, description: true, ... } })`
call within the `h-validate` tool body) MUST include `abstract`:

```typescript
const nodes = await db.node.findMany({
  where: { memoryId: memory.id, deletedAt: null },
  select: {
    id: true,
    loc: true,
    name: true,
    description: true,
    abstract: true,     // ← NEW
    content: true,
    data: true,
    nodeType: true,
  },
});
```

**Bandwidth note** (PR-196 review item 9): adding `abstract` to the select widens the per-node
payload by up to 2000 chars. For a memory with N nodes, `h-validate` pulls `O(N × avg_abstract_
size)` extra bytes. For typical memory sizes (hundreds to a few thousand nodes), this is noise
relative to the existing `description` + `content` projection. If `h-validate` ever needs to
scale to memories with tens of thousands of nodes, consider streaming or a two-pass approach (id-
only first, then per-node fetch on-demand). Out of scope here.

## Issue message wording

Single-line, current style. Before: `[sparse] urn:node:... — no description and no content`.
After: `[sparse] urn:node:... — no description, content, or abstract`.

## Test coverage

- Node with only description: NOT sparse (unchanged).
- Node with only content: NOT sparse (unchanged).
- Node with only abstract: NOT sparse (NEW — would have been sparse pre-spec).
- Node with abstract + description: NOT sparse.
- Node with abstract + content: NOT sparse.
- Node with none of the three: SPARSE, message names all three fields.
