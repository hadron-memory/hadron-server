# Contract: `h-update-node` — abstract parameter with partial-update semantics

Spec source: FR-004, FR-008, FR-009.

## Input surface delta

The zod input schema at [server.ts:1674-1690](../../../src/mcp/server.ts#L1674-L1690) gains one
optional parameter, positioned after `description`:

```typescript
{
  urn: z.string()...,                   // unchanged
  name: z.string().optional()...,       // unchanged
  nodeType: z.string().optional()...,   // unchanged
  description: z.string().optional()..., // unchanged
  abstract: z.string()
    .max(2000, 'Abstract exceeds 2000-character cap')
    .nullable()
    .optional()
    .describe('Paragraph-length summary. Pass null to clear; omit to preserve existing.'),
  content: z.string().optional()...,    // unchanged
  // ... rest unchanged
}
```

Note `.nullable()` — `h-update-node` explicitly supports `abstract: null` to clear the field
(distinct from `abstract: undefined` / omitted which preserves).

## Partial-update semantics

Three possible argument states, three behaviors:

| Argument state | Behavior |
|----------------|----------|
| `abstract` field absent from request body | Preserve existing column value. No update emitted for this column. |
| `abstract: null` | Clear the column (`SET abstract = NULL`). |
| `abstract: "..."` | Replace the column value. Empty string normalizes to `null` per FR-009. |

This matches the existing convention for `description` / `content` per spec Assumptions ("Partial-
update semantics match the existing convention for `description` / `content` on `h-update-node`:
omitted field = preserve, explicit `null` = clear, explicit string = replace").

**Implementation note**: zod's `.optional()` produces `undefined` for omitted fields. The resolver
distinguishes `undefined` (preserve) from `null` (clear) when building the Prisma update payload:

```typescript
const updateData: Prisma.NodeUpdateInput = {
  // ... other fields ...
  ...(abstract !== undefined && { abstract: abstract === '' ? null : abstract }),
};
```

## Audit + version history

- Updating `abstract` bumps `updatedAt` / `updatedBy` per existing audit machinery.
- `NodeVersion` snapshot machinery (in the resolver pre-update) captures the prior abstract value
  along with the rest of the row. No code change needed — `NodeVersion` already snapshots all
  columns.

## Error responses

- **`NodeAbstractTooLongError`** — raised when `abstract.length > 2000`. Same shape as
  `h-add-node`.
- All existing `h-update-node` error paths (URN not qualified, memory not found, node not found,
  write access denied, edge target resolution) are unchanged.

## Response

Unchanged from current `h-update-node` response shape. The `reason` parameter (already optional)
applies to abstract updates as it does to any other column update — gets recorded in the
`NodeVersion` row.

## Test coverage

- US1 acceptance scenario 2 — abstract update persists.
- US1 acceptance scenario 7 — omitted abstract preserves existing value.
- US1 acceptance scenario 8 — `abstract: null` clears the column.
- Length-cap rejection at 2001 chars.
- Empty-string `abstract: ''` → normalizes to null.
- `NodeVersion` snapshot captures the prior abstract value.
