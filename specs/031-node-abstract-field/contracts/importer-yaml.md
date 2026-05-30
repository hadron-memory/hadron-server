# Contract: node.yaml importer/exporter — abstract round-trip

Spec source: FR-010.

## Importer surface — `src/integrations/github/syncGraphFromGithub.ts`

The importer reads YAML node files and upserts them into the DB. Currently maps:

```typescript
{
  description: node.description ?? null,
  content: node.content ?? null,
  contentHash: node.contentHash ?? null,
  tags: serializeTags(node.tags ?? []) as string[],
  // ...
}
```

(per [syncGraphFromGithub.ts:94-97](../../../src/integrations/github/syncGraphFromGithub.ts#L94-L97))

Post-spec, abstract joins the map:

```typescript
{
  description: node.description ?? null,
  abstract: node.abstract ?? null,    // ← NEW
  content: node.content ?? null,
  contentHash: node.contentHash ?? null,
  tags: serializeTags(node.tags ?? []) as string[],
  // ...
}
```

## YAML schema

The expected YAML node-file shape (existing convention) gains one optional key:

```yaml
id: 01HXX...
name: Auth tokens
description: One-line headline.
abstract: |
  Paragraph-length summary of what this node covers, used in
  search previews and as the fallback body when no content is
  present.
content: |
  # Auth tokens

  Full body...
tags: [auth, security]
```

The `abstract` key is optional. Absent → DB column is `NULL`. Empty string normalizes to `NULL`
during import (FR-009). Length cap (2000 chars per FR-008) is enforced at import time — files
with over-long abstracts fail the import with `NodeAbstractTooLongError` wrapped in the upstream
sync error envelope.

## Exporter surface — `src/integrations/github/writeNodeToGit.ts`

The exporter writes Node rows back to the repo as YAML. The serialization gains an `abstract:`
key when the column is non-null:

```typescript
// existing pattern (illustrative)
const yamlPayload = {
  id: node.id,
  name: node.name,
  ...(node.description && { description: node.description }),
  ...(node.abstract && { abstract: node.abstract }),    // ← NEW
  ...(node.content && { content: node.content }),
  tags: node.tags,
  // ...
};
```

The `&&` guard omits the key entirely when `null` — keeps the YAML clean for nodes that have no
abstract. `js-yaml` writes block-scalar (`|`) style for any abstract containing a newline; inline
quoted style for single-line abstracts.

## Round-trip property

Per FR-010 and SC-005, the export-then-import cycle is byte-identical for any in-cap abstract
value:

1. Node row with `abstract: "Paragraph text."` → export → YAML contains `abstract: Paragraph
   text.` → import → DB row with `abstract: "Paragraph text."`.
2. Node row with `abstract: NULL` → export → YAML has no `abstract:` key → import → DB row with
   `abstract: NULL`.

The round-trip is verified by extending the existing importer round-trip test (location TBD
during implementation) with abstract fixtures covering: null, short single-line, multi-paragraph,
at-cap (exactly 2000 chars), and an edge with leading/trailing whitespace preserved.

## Test coverage

- Importer test (or its equivalent in `syncGraphFromGithub.test.ts`):
  - YAML with `abstract:` populated → row has the value.
  - YAML without `abstract:` key → row has `NULL`.
  - YAML with `abstract: ''` → row has `NULL` (normalization).
  - YAML with over-long abstract → import fails with typed error.
- Exporter test (or in `writeNodeToGit.test.ts`):
  - Row with abstract → YAML contains the key with the value.
  - Row without abstract → YAML omits the key (no `abstract: null` line).
- Round-trip test: full cycle preserves value byte-for-byte.
