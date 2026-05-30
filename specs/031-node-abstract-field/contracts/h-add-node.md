# Contract: `h-add-node` — abstract parameter

Spec source: FR-001, FR-003, FR-008, FR-009 (extended per PR-196 review for whitespace-only).

## Input surface delta

The zod input schema for `'h-add-node'` (find via `server.tool('h-add-node'` in
`src/mcp/server.ts`) gains one optional parameter, positioned after `description`:

```typescript
{
  urn: z.string().describe(...),       // unchanged
  name: z.string().describe(...),       // unchanged
  nodeType: z.string().optional()...,   // unchanged
  description: z.string().optional()..., // unchanged
  abstract: z.string()
    .max(2000, 'Abstract exceeds 2000-character cap')
    .optional()
    .describe('Paragraph-length summary (max 2000 chars). Surfaced in h-find-nodes previews and on h-read-node via contentScope. Spec 031.'),
  content: z.string().optional()...,    // unchanged
  // ... rest unchanged
}
```

## Behavior

1. **Empty + whitespace-only normalization (FR-009 extended)**: if `abstract.trim() === ''` —
   covering both `''` and whitespace-only inputs (e.g. `'   '`, `'\n\n'`) — persist `null`
   instead. When non-empty after trim, persist the original (untrimmed) value so intentional
   leading/trailing whitespace is preserved. Applied AFTER zod length-cap validation (a
   whitespace-only string passes `max(2000)`; it then becomes `null`).
2. **Persistence**: the value goes into the `nodes.abstract` column via the existing upsert path.
   No additional indirection.
3. **Audit**: existing `createdAt`/`createdBy`/`updatedAt`/`updatedBy` machinery applies — no new
   code.
4. **Edges, properties, data, tags**: unaffected by this change. abstract is purely an additional
   text field.

## Error responses

- **`NodeAbstractTooLongError`** — raised when `abstract.length > 2000`. The zod schema produces
  the typed error at the validation layer; the MCP error path wraps it in the response shape used
  by other zod failures on this tool. Message format: `"Abstract exceeds 2000-character cap (got
  <N> chars). Use a shorter summary or expand `content` for the long form."`
- All existing `h-add-node` error paths (URN not qualified, memory not found, write access denied,
  edge target resolution) are unchanged.

## Response

Unchanged from current `h-add-node` response shape. The abstract is persisted but not echoed in
the success message — the success message just confirms the node was created. Callers wanting to
verify the abstract round-trip use `h-read-node` with `contentScope: 'abstract'` or `'all'`.

## Test coverage

- US1 acceptance scenario 1 — abstract persists on create.
- US1 acceptance scenario 6 — node created WITHOUT `abstract` arg has `abstract IS NULL`.
- Length-cap rejection at 2001 chars.
- Empty-string `abstract: ''` → persists as `null`.
- Whitespace-only `abstract: '   '` → persists as `null` (FR-009 extension).
- Intentional leading-whitespace abstract (`'  This is real.'`) → persists as-is, NOT
  normalized (trim is for the emptiness check only, not for the persisted value).
- Round-trip via `h-read-node` (contentScope='abstract').
