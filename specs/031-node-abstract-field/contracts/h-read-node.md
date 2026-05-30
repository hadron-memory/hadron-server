# Contract: `h-read-node` — `contentScope` parameter + fallback marker

Spec source: FR-005 (the load-bearing one), edge cases for `contentScope`, plus US1 acceptance
scenarios 3–6 and 10–13.

## Input surface delta

The zod input schema at [server.ts:1081](../../../src/mcp/server.ts#L1081) gains one optional
parameter:

```typescript
{
  urn: z.string().describe(...),  // unchanged
  contentScope: z.enum(['content', 'abstract', 'all'])
    .optional()
    .default('content')
    .describe("Selects what the response includes. 'content' (default): meta block + body, with the abstract substituted into the body slot when content is null/empty (a `Source: abstract-fallback` line appears in the meta block when this happens). 'abstract': meta block + abstract, no body. 'all': meta block + abstract + body. Spec 031."),
}
```

## Response shape by `contentScope` × abstract-state × content-state

The full nine-cell matrix:

| Scope | content present | abstract present | Response shape |
|-------|-----------------|------------------|----------------|
| `'content'` | yes | yes | `<meta>\n\n---\n\n<content>` (pre-spec; abstract NOT surfaced) |
| `'content'` | yes | no | `<meta>\n\n---\n\n<content>` (byte-identical to pre-spec) |
| `'content'` | no | yes | `<meta-with-Source:-abstract-fallback>\n\n---\n\n<abstract>` (FALLBACK fires) |
| `'content'` | no | no | `<meta>\n\n---\n\n` (empty body — byte-identical to pre-spec) |
| `'abstract'` | yes | yes | `<meta>\n\n<abstract>` (no `---`, no body) |
| `'abstract'` | yes | no | `<meta>` alone |
| `'abstract'` | no | yes | `<meta>\n\n<abstract>` |
| `'abstract'` | no | no | `<meta>` alone |
| `'all'` | yes | yes | `<meta>\n\n<abstract>\n\n---\n\n<content>` |
| `'all'` | yes | no | `<meta>\n\n---\n\n<content>` (no abstract section) |
| `'all'` | no | yes | `<meta>\n\n<abstract>` (no `---`, no body — same as `'abstract'`) |
| `'all'` | no | no | `<meta>` alone |

**Critical properties**:
- `Source: abstract-fallback` marker appears in exactly ONE row: `contentScope: 'content'` + content
  absent + abstract present. Never under `'abstract'` or `'all'`.
- The default-scope row (any content + no abstract) is byte-identical to pre-spec. SC-004 backstop.
- The `'all'` no-body case collapses to the same shape as `'abstract'` no-content — this is the
  intended structural signal (missing `---` = no real body).

## Meta block layout

Existing meta block at [server.ts:1149-1162](../../../src/mcp/server.ts#L1149-L1162):

```
**<name>**
<urn>
> <description>                ← when non-null
Type: <nodeType>
Tags: <tags joined>            ← when non-empty
Seq: <seq>                     ← when non-null
Properties: <json>             ← when non-null
Data: <json>                   ← when non-null
Related: <outgoing edges>      ← when non-empty
Referenced by: <incoming>      ← when non-empty
```

Post-spec meta block (only difference: optional Source line):

```
**<name>**
<urn>
> <description>
Type: <nodeType>
Source: abstract-fallback      ← NEW, ONLY when contentScope='content' AND content is null/empty AND abstract is non-null
Tags: ...
Seq: ...
Properties: ...
Data: ...
Related: ...
Referenced by: ...
```

The Source line follows the same conditional-emission pattern as the existing lines (built into
the meta array, `.filter(Boolean).join('\n')`). When the fallback condition isn't met, no line is
emitted — no blank line, no placeholder.

## Implementation sketch

```typescript
const requestedScope = contentScope ?? 'content';
const hasContent = Boolean(node.content && node.content.length > 0);
const hasAbstract = Boolean(node.abstract && node.abstract.length > 0);
const isFallback = requestedScope === 'content' && !hasContent && hasAbstract;

const metaLines = [
  `**${node.name}**`,
  urn,
  node.description ? `> ${node.description}` : '',
  `Type: ${node.nodeType}`,
  isFallback ? 'Source: abstract-fallback' : '',
  // ... rest of meta block unchanged ...
];
const meta = metaLines.filter(Boolean).join('\n');

// Body selection per the matrix above
let body: string;
switch (requestedScope) {
  case 'content':
    body = hasContent ? node.content! : (hasAbstract ? node.abstract! : '');
    return textResult(`${meta}\n\n---\n\n${body}`);
  case 'abstract':
    return hasAbstract
      ? textResult(`${meta}\n\n${node.abstract}`)
      : textResult(meta);
  case 'all': {
    const parts = [meta];
    if (hasAbstract) parts.push(node.abstract!);
    if (hasContent) parts.push(`---\n\n${node.content}`);
    return textResult(parts.join('\n\n'));
  }
}
```

## Error responses

- **`InvalidContentScopeError`** — raised when `contentScope` is outside the enum. Zod's `.enum()`
  produces the validation error at the MCP boundary; the typed error class exists for any internal
  caller that re-validates.
- All existing `h-read-node` error paths (URN not qualified, memory not found, node not found,
  access denied) are unchanged.

## Test coverage

- US1 acceptance scenarios 3, 4, 5 — three contentScope happy paths with both content + abstract.
- US1 acceptance scenarios 10, 11, 12 — content-less abstract-having node under each scope.
- US1 acceptance scenario 13 — sparse node (both null) under default scope is byte-identical.
- US1 acceptance scenario 9 — invalid contentScope is rejected.
- Edge case: `contentScope: 'abstract'` + null abstract = meta block alone, no error.
- Edge case: `contentScope: 'all'` + null abstract = byte-identical to `contentScope: 'content'`
  for that node.
- Snapshot fixtures cover all 12 active cells in the matrix above (the 13th — invalid scope — is
  a thrown-error test).
