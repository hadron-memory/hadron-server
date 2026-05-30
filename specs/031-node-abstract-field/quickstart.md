# Quickstart: Node `abstract` field

Manual smoke recipe for verifying the feature works end-to-end in a dev environment. Aimed at the
implementing engineer or a reviewer doing a hands-on verification pass before merge.

## Prerequisites

- Local Postgres running with `hadron_dev` (per CLAUDE.md).
- `prisma db push` has applied the schema delta (including the new `abstract` column).
- `prisma/post-push.sql` re-applied (constitution S5 — though no new CHECK constraint in this
  spec, the existing ones must still be in place).
- Dev server running locally: `pnpm tsx src/index.ts` (default port 4000).
- A valid App Key (`hdr_app_…`) for an Org/Memory you can read/write. Get one from `prisma/seed.ts`
  output after running the seed script (see CLAUDE.md).

## Smoke recipe — end to end

### Step 1: Create a node with an abstract

Via MCP (e.g. with an MCP-capable client pointed at `http://localhost:4000/mcp`):

```
h-add-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  name: Abstract smoke test
  description: One-line headline.
  abstract: This is a paragraph-length summary of what the node is about. It sits between description (the headline) and content (the body) in length and purpose, and is the substrate for an upcoming RAG layer.
  content: |
    # Full body
    Rich markdown content goes here.
```

**Expected**: success response. Node is created in the active memory at the given URN.

### Step 2: Read it back with the default `contentScope`

```
h-read-node
  urn: hadronmemory.com::dev::test:abstract-smoke
```

**Expected**: response is meta block + `---` + the full body (the `# Full body` markdown above).
The abstract does NOT appear anywhere. NO `Source: abstract-fallback` line. This is the "byte-
identical to pre-spec" guarantee for callers that don't opt in.

### Step 3: Read it back with `contentScope: 'abstract'`

```
h-read-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  contentScope: abstract
```

**Expected**: response is the meta block followed (after a blank line) by the abstract paragraph.
No `---` separator. No body. The meta block contains `**Abstract smoke test**`, the urn, the
`> One-line headline.` description, `Type: info` (or whatever you set), tags if any, etc. — but
NO `Source:` line, because no fallback occurred.

### Step 4: Read it back with `contentScope: 'all'`

```
h-read-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  contentScope: all
```

**Expected**: meta block + abstract paragraph + `---` + body. Both surfaces present. Still no
`Source: abstract-fallback` line (the body exists; the fallback didn't fire).

### Step 5: Create a content-less node with an abstract (the fallback case)

```
h-add-node
  urn: hadronmemory.com::dev::test:abstract-only
  name: Abstract-only archive node
  nodeType: abstract
  description: Archived paper — only the abstract is preserved.
  abstract: The original paper proposes a novel approach to X. Key result: Y. Source: archived; only this abstract remains in our memory.
  # NOTE: no content field
```

### Step 6: Read the content-less node with default `contentScope`

```
h-read-node
  urn: hadronmemory.com::dev::test:abstract-only
```

**Expected (THE FALLBACK)**: meta block + `---` + the abstract text. The meta block contains a
`Source: abstract-fallback` line positioned just after `Type: abstract`. The body slot (after the
`---`) carries the abstract content (because there is no real body to show). The caller gets
something useful instead of an empty body — the abstract IS the content for this node.

### Step 7: Read the content-less node with `contentScope: 'all'`

```
h-read-node
  urn: hadronmemory.com::dev::test:abstract-only
  contentScope: all
```

**Expected**: meta block + abstract paragraph (no `---`, no body — the body section collapses
because there is none). The missing `---` separator is the structural signal that the node has no
real body. NO `Source:` line — fallback semantics only apply under `'content'` scope, and this is
`'all'` scope.

### Step 8: ~~Find the node by a term that's only in the abstract~~ — DEFERRED to RAG follow-up

US3 / FR-007 (search haystack extension to include abstract) was **deferred during the PR-196
review**. Search acceleration over abstract content is the natural job of the upcoming RAG /
vector-retrieval layer; this spec does not extend the substring haystack. To verify the deferral:

```
h-find-nodes
  query: <a unique term that appears ONLY in the abstract — e.g. "novel" if used above>
```

**Expected**: zero hits. The abstract is NOT searched against — same as pre-spec. Skip ahead to
Step 9 (preview-rendering verification, which IS in scope).

### Step 9: Verify preview includes the abstract for a node found by name

```
h-find-nodes
  query: archive            # matches the Step-5 archive node by its name
```

**Expected**: the archive node appears in results. Its preview renders with the description as
the headline AND the abstract as a paragraph block:

```
<urn> — <name>
  > <description>
  | <abstract>
```

The `| ` prefix on the abstract distinguishes it from `> ` on description (per research.md D5a).
Multi-paragraph abstracts get the prefix on each line.

### Step 10: Brief-mode excludes abstract from response (and from search — symmetric)

```
h-find-nodes
  query: archive
  brief: true
```

**Expected**: the archive node still appears (because the query matches its name), but the
response shape is index-only: name + description + edges. No `| <abstract>` lines. The existing
`brief` docstring ("Return index info only: name, description, edges") is accurate unchanged.
Brief mode is symmetric: doesn't return abstract, doesn't search abstract.

### Step 11: Partial-update preserves abstract

```
h-update-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  name: Renamed but abstract preserved
  # NOTE: no abstract field in the request
```

Then:

```
h-read-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  contentScope: abstract
```

**Expected**: the abstract from Step 1 is still there, unchanged. Omitted `abstract` field on
update = preserve.

### Step 12: Explicit `null` clears the abstract

```
h-update-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  abstract: null
```

Then:

```
h-read-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  contentScope: abstract
```

**Expected**: response is meta block alone. No abstract section. The column is now `NULL`. The
node's content (from Step 1) is still there — verify with default `contentScope`.

### Step 12a: Whitespace-only abstract normalizes to NULL (FR-009 extended)

```
h-add-node
  urn: hadronmemory.com::dev::test:whitespace-only
  name: Whitespace abstract
  abstract: "   \n\n   "        # whitespace only
```

Then:

```
h-read-node
  urn: hadronmemory.com::dev::test:whitespace-only
  contentScope: abstract
```

**Expected**: response is meta block alone — the abstract was normalized to NULL at write time
(trim-then-check). No abstract section.

Cleanup: `h-delete-node urn=hadronmemory.com::dev::test:whitespace-only hard=true`

### Step 13: Length-cap rejection

```
h-add-node
  urn: hadronmemory.com::dev::test:overlong
  name: Over-long abstract
  abstract: <2001 chars of text>
```

**Expected**: rejected with a typed error mentioning the 2000-char cap and the offending length
(2001). No row created.

### Step 14: Invalid contentScope rejection

```
h-read-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  contentScope: summary
```

**Expected**: rejected with a typed validation error citing the allowed values: `'content' |
'abstract' | 'all'`.

### Step 15: Sparse-node validator

```
h-add-node
  urn: hadronmemory.com::dev::test:sparse
  name: Sparse
  # NOTE: no description, no content, no abstract
```

Then:

```
h-validate
  memoryUrn: hadronmemory.com::dev
```

**Expected**: validator reports the sparse node with the new message: `[sparse] urn:node:... — no
description, content, or abstract`. A node with only an abstract is NOT flagged as sparse — verify
by adding an abstract to the sparse node above and re-running.

## Cleanup

```
h-delete-node
  urn: hadronmemory.com::dev::test:abstract-smoke
  hard: true
h-delete-node
  urn: hadronmemory.com::dev::test:abstract-only
  hard: true
h-delete-node
  urn: hadronmemory.com::dev::test:sparse
  hard: true
```

## Expected outcomes summary

| Check | Pre-spec | Post-spec |
|-------|----------|-----------|
| Step 2 default-scope read | meta + body | byte-identical (meta + body, no abstract surfaced) |
| Step 3 abstract-scope read | n/a | meta + abstract, no `---`, no body |
| Step 4 all-scope read | n/a | meta + abstract + `---` + body |
| Step 6 fallback read | meta + `---` + empty | meta + `Source: abstract-fallback` + `---` + abstract |
| Step 8 search recall | zero hits | **still zero hits — US3 deferred to RAG follow-up** |
| Step 9 preview shape | description-only | description + abstract block when found by other means |
| Step 10 brief mode | unchanged | unchanged — symmetric: doesn't return AND doesn't search abstract |
| Step 12a whitespace normalization | n/a | persists as NULL (trim-then-check, FR-009 extended) |
| Steps 11, 12 update semantics | n/a | partial-update preserves; null clears |
| Step 13 length cap | n/a | rejected with typed error |
| Step 14 invalid scope | n/a | rejected with typed error |
| Step 15 sparse validator | flag if no desc + no content | flag if no desc + no content + no abstract |
