# Contract: `h-validate` — sparse-node rule extension

Spec source: FR-011.

## Current behavior

The sparse-node check at
[server.ts:2445](../../../src/mcp/server.ts#L2445) currently is:

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

The `select` clause at [server.ts:2624](../../../src/mcp/server.ts#L2624) that pulls nodes for the
validator MUST include `abstract`:

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
