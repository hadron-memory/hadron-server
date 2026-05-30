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

## Selection delta — none required

**Correction (PR-197 review)**: the original draft of this contract claimed `h-validate` uses a
`select` clause that must be extended with `abstract: true`. That's wrong. The relevant
`db.node.findMany` call inside the `h-validate` tool body uses Prisma's `include` mode (find via
`include: { outgoingEdges: true }` near the top of the `h-validate` handler), NOT `select`.

Under `include` with no sibling `select`, Prisma auto-projects ALL scalar columns on the model.
The new `abstract` column will therefore appear on the returned node objects automatically once
the Prisma client is regenerated against the updated schema (T002 / T004). **No code change to
the findMany call is required** — only the conditional + message change below.

**Bandwidth note** (PR-196 review item 9): the auto-projection means `h-validate` pulls the
abstract column whether or not the sparse-node check reads it. For a memory with N nodes,
`h-validate` therefore widens its query payload by up to `2000 × N` bytes. For typical memory
sizes (hundreds to a few thousand nodes) this is noise relative to the existing `description` +
`content` projection. If `h-validate` ever needs to scale to memories with tens of thousands of
nodes, consider switching from `include` to an explicit `select` that lists only the columns the
validator actually reads. Out of scope here.

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
