---
target-repositories:
  - hadron-server
---

# Feature Specification: Node `abstract` field — paragraph-length preview

**Feature Branch**: `031-node-abstract-field`
**Created**: 2026-05-28
**Status**: Draft
**Input**: User description: "add-node-abstract" (clarified during specify: add an optional
`abstract` column on `Node` for a paragraph-length summary, distinct from one-line `description` and
full `content`. Always surfaced in `h-find-nodes` previews; opt-in on `h-read-node` via a new
`contentScope` parameter; not surfaced in `h-list-nodes`).

## Background

Today every `Node` carries three text-shaped columns: `name` (display label), `description` (
one-line short, surfaced in find/list previews and in `h-read-node`'s meta block), and `content` (
full topic.md body, returned after the `---` separator in `h-read-node`). Agents browsing a memory
frequently use `h-find-nodes` or `h-list-nodes` to triage candidates, then call `h-read-node` on the
most promising hits to inspect the body. That second call is expensive: it loads the whole body just
to confirm relevance.

This spec adds a fourth, optional column — `abstract` — that sits between `description` and
`content` in length and purpose. It is the node's paragraph-length elevator pitch: enough to decide
whether to read the body, short enough to ship in every triage-mode preview. It is additive (
existing nodes get `NULL`), authored on demand, and surfaced asymmetrically across the read tools:
`h-find-nodes` always shows it in previews (when present) because triage is the whole job; whereas
`h-read-node` returns it only when the caller opts in via the new `contentScope` parameter (default
`'content'` preserves pre-spec output byte-for-byte). `h-list-nodes` does NOT surface it at all —
the tree's line-density is the value of the tool, and paragraph previews would destroy it.

A separate concept already exists in the schema with the same word: `nodeType='abstract'` (
per [schema.prisma:693](../../prisma/schema.prisma#L693)) marks a *node* as the condensed
representation of an external source (paper abstracts, TL;DRs). The new `Node.abstract` *column* is
orthogonal to that node-type — any node of any type may carry an abstract column value, and a
`nodeType='abstract'` node may itself also have an `abstract` column populated (rare, but
permitted). See Assumptions for the naming-collision rationale.

**This field is also the substrate for an upcoming RAG / vector-retrieval layer.** A follow-up spec
will introduce embeddings and semantic search over the memory graph; the abstract is the text that
layer will vectorize. Embedding full `content` is noisy (too long, mixes topic with mechanics) and
embedding `description` is too thin to carry semantic signal. A paragraph-length abstract is the
natural unit: long enough for the embedding to capture what the node is *about*, short enough to
embed cheaply and stay under typical model context limits. The 2000-character cap (see Assumptions)
was chosen with that downstream use in mind — comfortably under the per-input limit of every
embedding model we are likely to use. Vectorization itself is **out of scope** for this spec; it
ships the column, the authoring path, and the preview / keyword-search consumers. The vector layer
arrives later and reads the same column.

## User Scenarios & Testing

### User Story 1 — Author attaches a paragraph summary to a node and reads it back (Priority: P1)

An author (human via portal, or AI agent via MCP) creates or updates a node and supplies an optional
`abstract` — a 1–3 sentence summary of what the node is about. On a subsequent read with
`contentScope: 'abstract'` or `'all'`, the abstract round-trips unchanged. Default reads
(`contentScope: 'content'` or omitted) preserve pre-spec output byte-for-byte: the abstract is
persisted but not surfaced. Until the author supplies a value, the field is `NULL` and the node
behaves exactly as today regardless of `contentScope`.

**Why this priority**: This is the schema + write + read foundation. Without it, no consumer (
search, previews, importer) has anything to consume. It is also the smallest end-to-end slice that
delivers durable value: the abstract is *persisted* and *retrievable*, even before any preview
surface changes. The `contentScope` parameter ships with this story so that callers can verify the
round-trip without depending on US2 (preview surfacing).

**Independent Test**: An agent calls `h-add-node` (or `h-update-node`) on a memory, passing an
`abstract` parameter. A follow-up `h-read-node` with `contentScope: 'abstract'` returns the same
string. A default `h-read-node` (no `contentScope`) returns output byte-identical to today's. Nodes
that omit the parameter retain `NULL` and exhibit no change in any `contentScope`.

**Acceptance Scenarios**:

1. **Given** an existing memory, **When** an agent calls `h-add-node` with a fully-qualified `urn`
   (bare `org::memory::loc` or `urn:node:`-prefixed form) and
   `abstract: "Short paragraph summary."`, **Then** the node is created with `abstract` persisted to
   that value.
2. **Given** a node with `abstract: "Original."`, **When** an agent calls `h-update-node` with
   `abstract: "Revised."`, **Then** the persisted value is `"Revised."`.
3. **Given** a node with a persisted abstract, **When** `h-read-node` is invoked with no
   `contentScope` (or `contentScope: 'content'`), **Then** the returned output is byte-identical to
   pre-spec — meta block + `---` + body, no abstract surfaced anywhere.
4. **Given** a node with a persisted abstract, **When** `h-read-node` is invoked with
   `contentScope: 'abstract'`, **Then** the response is meta block + abstract (no `---`, no body).
5. **Given** a node with a persisted abstract, **When** `h-read-node` is invoked with
   `contentScope: 'all'`, **Then** the response is meta block + abstract + `---` + body.
6. **Given** a node created without an `abstract` parameter, **When** read back with any
   `contentScope` value, **Then** the abstract field is `NULL` and the response contains no abstract
   section. For `contentScope: 'content'` the response is byte-identical to a pre-spec read.
7. **Given** an `h-update-node` call that does NOT include `abstract` in its arguments, **When** the
   update is applied, **Then** the existing abstract value is preserved (partial update; absent ≠
   clear).
8. **Given** an `h-update-node` call that explicitly sets `abstract: null`, **When** the update is
   applied, **Then** the abstract is cleared.
9. **Given** an `h-read-node` call with `contentScope: 'something-else'` (a value not in the allowed
   set), **When** the request is validated, **Then** the call is rejected with a typed validation
   error citing the allowed values (`'content' | 'abstract' | 'all'`).
10. **Given** a node with `abstract: "Paper abstract text."` and `content: NULL` (or empty), **When**
    `h-read-node` is invoked with default `contentScope` (or `'content'`), **Then** the response is
    meta block + `---` + the abstract text — the content-fallback rule fills the body slot from the
    abstract.
11. **Given** a node with `abstract: "..."` and `content: NULL`, **When** `h-read-node` is invoked
    with `contentScope: 'abstract'`, **Then** the response is meta block + abstract (the
    `'abstract'` scope never falls back to content; the inverse is asymmetric to `'content'`).
12. **Given** a node with `abstract: "..."` and `content: NULL`, **When** `h-read-node` is invoked
    with `contentScope: 'all'`, **Then** the response is meta block + abstract (no `---`, because
    there is no body) — the response collapses to the same shape as `contentScope: 'abstract'` for
    this node.
13. **Given** a node with `abstract: NULL` and `content: NULL` (a sparse node), **When**
    `h-read-node` is invoked with default `contentScope`, **Then** the response is meta block +
    `---` + empty body — byte-identical to pre-spec output for sparse nodes.

---

### User Story 2 — h-find-nodes previews include the abstract alongside the description (Priority: P2)

When an agent surveys a memory via `h-find-nodes`, the result list includes the abstract (when
present) in addition to the existing description. The description remains the one-line headline;
the abstract appears as a paragraph preview beneath it. Nodes without an abstract render exactly as
today (description-only). `h-list-nodes` and `h-read-node` are deliberately NOT in scope here:
list-nodes stays line-dense (no paragraph previews in the tree); read-node returns the abstract
only when the caller opts in via `contentScope` (covered by US1).

**Why this priority**: This is where the round-trip savings show up — agents triaging via search
get richer previews and skip the follow-up `h-read-node` they would otherwise need. Without preview
surfacing, the column is dead weight at the search surface. P2 (not P1) only because the column
has to exist and round-trip first.

**Independent Test**: Seed two nodes — one with `abstract` populated, one without. Run
`h-find-nodes` with a query that matches both by name. The first node's preview includes its
abstract; the second's looks identical to its pre-spec form.

**Acceptance Scenarios**:

1. **Given** a node with `description: "Auth tokens."` and
   `abstract: "JWT issuance, refresh, and revocation flow for the MCP server."`, **When**
   `h-find-nodes` returns it in a result list, **Then** the preview renders the description as the
   one-line headline AND the abstract as a paragraph preview beneath it.
2. **Given** a node with only `description` (abstract `NULL`), **When** `h-find-nodes` renders its
   preview, **Then** the output is byte-identical to today's behavior.
3. **Given** `brief: true` on `h-find-nodes`, **When** the response is emitted, **Then** the
   abstract is NOT included in the response (preserves the brief contract), even though the
   abstract IS still part of the search haystack (see US3).
4. **Given** `h-list-nodes` emits the tree, **When** a node has an abstract, **Then** the tree
   output is byte-identical to pre-spec — `h-list-nodes` does not surface the abstract.

---

### User Story 3 — Keyword search matches against abstract content (Priority: P3)

`h-find-nodes` already does substring/keyword matching across `name`, `loc`, `description`, and
`tags` (per the tool's own contract in [server.ts:939](../../src/mcp/server.ts#L939)). After this
spec, the search haystack also includes the abstract. Agents searching for a term that appears only
in a node's abstract — not in its name, loc, or tags — get a hit they would have missed before.

**Why this priority**: Search recall is a real win but strictly additive on top of US2. Without US2,
the abstract is invisible. Without US3, the abstract is visible but not searchable — still useful.
Shipping P3 separately keeps the search-behavior change isolated for measurement.

**Independent Test**: Seed a node with a unique discriminator term appearing ONLY in its abstract.
Run `h-find-nodes` for that term. Pre-spec: zero hits. Post-spec: the node is returned.

**Acceptance Scenarios**:

1. **Given** a node with a unique term `"deduplication"` appearing only in its abstract (not in
   name/loc/description/tags), **When** `h-find-nodes` is called with `query: "deduplication"`, *
   *Then** the node appears in the results.
2. **Given** the existing search semantics (substring, case-insensitive, ALL whitespace-separated
   terms must appear), **When** the haystack is extended to include `abstract`, **Then** every node
   that matched pre-spec still matches (search is monotonically additive — no removals).
3. **Given** a `query: "*"` survey, **When** the haystack changes, **Then** the result set is
   identical to today (survey mode matches every live node regardless of haystack content).

---

### Edge Cases

- **Abstract on a `nodeType='abstract'` node**: a "node abstract" (the field) on an "abstract
  node" (the type) is permitted but semantically redundant. The spec does not forbid it;
  documentation should call out that authors usually pick one or the other. See Assumptions.
- **Empty string vs `NULL`**: `abstract: ""` is normalized to `NULL` at write time. There is no
  observable difference between "absent" and "empty"; both render as no abstract.
- **Maximum length**: An abstract longer than 2000 characters (see Assumptions) is rejected at write
  time with a clear, typed error citing the cap. The cap applies to both create and update paths.
- **Soft-deleted node with abstract**: identical lifecycle to other text columns — the abstract is
  preserved on the soft-deleted row, hidden from find/list/read output, restored if the node is
  restored. No separate handling.
- **Importer round-trip**: the node.yaml importer reads/writes `abstract` symmetrically; a YAML
  round-trip (export → re-import) preserves the value byte-for-byte. The 008-agent-installation
  export path must include it.
- **`h-validate` sparse-node rule**: a node with no `description`, no `content`, AND no `abstract`
  is sparse (extends the current rule at [server.ts:2445](../../src/mcp/server.ts#L2445)). A node
  with only an abstract is NOT sparse — the abstract counts as legitimate content for the
  validator's purpose.
- **`h-update-node` with `abstract` field omitted**: omission means "leave it alone" (partial-update
  semantics), consistent with how `description` and `content` behave today. To clear, the caller
  passes `abstract: null` explicitly.
- **Search interaction with `brief: true`**: the existing `brief` mode on `h-find-nodes` returns "
  index info only: name, description, edges". When `brief: true`, the abstract is NOT included in
  the response (preserves the contract). The abstract IS still searched against, however — `brief`
  controls output shape, not the search haystack.
- **`contentScope: 'abstract'` on a node with `NULL` abstract**: response is the meta block alone,
  no error. The caller asked for the abstract; the node has none; the response says so by omission.
  No fallback to content (asymmetric to the `'content'`-fallback rule per FR-005).
- **`contentScope: 'all'` on a node with `NULL` abstract**: response is meta block + `---` + body —
  byte-identical to a `contentScope: 'content'` read. The abstract section gracefully drops out.
- **`contentScope` with an invalid value** (e.g., `'summary'`): rejected at the API boundary with a
  typed validation error naming the allowed values. The DB is not touched.
- **Content-less node with an abstract under default `contentScope`** (the common
  `nodeType='abstract'` case where the source is archived): the abstract fills the body slot per
  FR-005 — response is meta block + `---` + abstract. The caller does not need to know the
  difference; the abstract IS the content for this node. Callers that need to distinguish "got
  body" from "got fallback abstract" can use `contentScope: 'all'`, which collapses to meta +
  abstract (no `---`) when there is no body — the missing separator is the signal.
- **Content-less node with an abstract under `contentScope: 'all'`**: meta block + abstract, no
  `---`, no body. The collapsed shape distinguishes this case from a body-having node.

## Requirements

### Functional Requirements

- **FR-001**: `Node` MUST gain an optional `abstract` text column. Existing rows backfill to `NULL`.
  The column is additive — no existing column changes shape or semantics.
- **FR-002**: `abstract`, `description`, and `content` MUST remain three independent,
  separately-persisted fields. Any may be `NULL`. No derivation rule (e.g., "abstract = first
  paragraph of content") is applied automatically.
- **FR-003**: `h-add-node` MUST accept an optional `abstract` parameter and persist it verbatim (
  after the length-cap and empty-string normalization rules in FR-007 and FR-008).
- **FR-004**: `h-update-node` MUST accept an optional `abstract` parameter with partial-update
  semantics: omitted = preserve, `null` = clear, string = replace.
- **FR-005**: `h-read-node` MUST accept an optional `contentScope` parameter with allowed values
  `'content'`, `'abstract'`, or `'all'`. Default is `'content'`. The parameter selects what the
  response includes, with one fallback rule: when the caller asks for `'content'` but the node has
  no body, the abstract is substituted (the abstract IS the content for content-less nodes —
  matches the schema doc's intent for `nodeType='abstract'` nodes whose source is archived). The
  fallback is **asymmetric**: `'content'` falls back to abstract, but `'abstract'` does NOT fall
  back to content (the caller explicitly asked for the abstract, not "give me something").
    - `'content'` (default) — meta block + `---` + body, where the body slot is filled by:
        1. the node's `content` value when non-null and non-empty; OR
        2. the node's `abstract` value when `content` is null/empty AND `abstract` is non-null (
           fallback); OR
        3. empty string when both `content` and `abstract` are null/empty (pre-spec behavior).
    - `'abstract'` — meta block + abstract paragraph. No `---` separator. No body. If `abstract` is
      `NULL`, the response is meta block alone (no fallback to `content`).
    - `'all'` — meta block + abstract paragraph (when non-null) + `---` + body (when non-null /
      non-empty). Sections collapse cleanly when components are missing: only-abstract → meta +
      abstract (no `---`); only-content → meta + `---` + content; both-null → meta alone.
  A `contentScope` value not in the allowed set MUST be rejected with a typed validation error
  citing the allowed values.
- **FR-006**: `h-find-nodes` MUST surface `abstract` in its preview output when non-null AND when
  `brief: false` (the default). Preview shape: description remains the one-line headline; abstract
  appears as a paragraph preview beneath it. Nodes with `abstract IS NULL` MUST render
  byte-identically to pre-spec output. `brief: true` is the off-switch — the abstract is excluded
  from the response shape per FR-007. `h-list-nodes` is explicitly NOT extended — tree output
  remains byte-identical to pre-spec for every node regardless of abstract value (the tree's
  line-density is the tool's job; paragraph previews belong in find/read, not list).
- **FR-007**: `h-find-nodes` search MUST include `abstract` in its substring/keyword haystack (
  joined with name, loc, description, tags). Existing search semantics — ALL whitespace-separated
  terms must appear, case-insensitive, no fuzzy / no stemming — apply unchanged. `brief: true` mode
  preserves its existing response shape (excludes the abstract from the response) but still searches
  against it. The existing tool docstring on the `brief` parameter ("Return index info only: name,
  description, edges") MUST NOT be revised — it remains accurate post-spec because brief
  deliberately excludes the abstract.
- **FR-008**: System MUST reject `abstract` values longer than 2000 characters with a clear, typed
  validation error citing the cap and the offending length. The cap applies on both create and
  update.
- **FR-009**: `abstract: ""` (empty string) MUST be normalized to `NULL` at write time (parity with
  how the existing text columns treat semantic absence).
- **FR-010**: The node.yaml importer/exporter MUST round-trip `abstract` symmetrically. An
  export-then-import cycle preserves the value byte-for-byte; absent in YAML = `NULL`.
- **FR-011**: `h-validate`'s sparse-node check MUST be extended: a node is sparse iff it has no
  `description`, no `content`, AND no `abstract`. Nodes with only an `abstract` are not flagged as
  sparse.
- **FR-012**: Soft-delete, restore, and the audit columns (`createdAt/By`, `updatedAt/By`,
  `deletedAt/By`) MUST treat `abstract` identically to other text columns. Updating only `abstract`
  bumps `updatedAt/By` per existing rules.

### Entity Impact

**Modified**:

- **Node** ([schema.prisma:721](../../prisma/schema.prisma#L721)) — adds an optional text column
  `abstract` between `description` and `content` in the model layout. Nullable; no default; no CHECK
  constraint. Existing rows backfill to `NULL`. No index added in v1 (search remains a sequential
  scan over the text haystack today; if abstract search materially shifts query latency, a trigram
  index is a follow-up, not in scope here).

**Source of truth**: `hadron-server/prisma/schema.prisma` (Prisma schema + migration tracked in
tasks.md).

## Success Criteria

### Measurable Outcomes

- **SC-001**: Round-trip works end-to-end. An agent that calls `h-add-node` with an `abstract`, then
  `h-read-node` on the same URN with `contentScope: 'abstract'` (or `'all'`), sees the abstract
  returned verbatim — confirmed by an integration test in the same release.
- **SC-002**: Preview surfaces include the abstract where they should. `h-find-nodes` output for a
  node with `abstract IS NOT NULL` includes the abstract text in the rendered preview; a node with
  `abstract IS NULL` renders byte-identically to pre-spec output. `h-list-nodes` tree output is
  byte-identical to pre-spec for every node. `h-read-node` with default `contentScope` (or
  `'content'`) is byte-identical to pre-spec for every node; `'abstract'` and `'all'` surface the
  abstract per FR-005 — all four shapes confirmed by golden-file / snapshot tests.
- **SC-003**: Search recall improves measurably for abstract-only terms. A keyword that appears ONLY
  in a node's abstract (not in name/loc/description/tags) returns that node from `h-find-nodes`
  post-spec; the same query returns zero hits pre-spec. Demonstrated by a regression test seeded
  with such a node.
- **SC-004**: Zero behavior change for any pre-spec node (which by definition has `abstract IS
  NULL`). Every default-mode output (`h-find-nodes` default, `h-list-nodes` default, `h-read-node`
  with default `contentScope` or `'content'`) for a node whose abstract is `NULL` is byte-identical
  to its pre-spec output — no extra blank line, no stray header, no shape change. `h-list-nodes` is
  byte-identical to pre-spec for ALL nodes (including those with `abstract IS NOT NULL`) — tree
  rendering is untouched. The content-fallback case (`abstract IS NOT NULL` AND `content` empty
  under default `contentScope`, per FR-005) is new behavior with no pre-spec output to match
  against — a node that fell into this state pre-spec would necessarily have had `abstract IS NULL`
  and so emitted an empty body. Verified by snapshot tests on a representative cross-section of
  seed nodes, plus a dedicated fixture for the fallback case.
- **SC-005**: Importer round-trips abstract losslessly. A node exported to YAML and re-imported
  produces an identical row (including a `NULL` abstract for nodes that never had one). Confirmed by
  the existing importer round-trip test extended with abstract fixtures.

## Assumptions

- **Length cap = 2000 characters.** Rationale: keeps abstracts shippable in every preview without
  ballooning find/list payloads; fits comfortably in an LLM context window for a list of ~50
  results. If we later need longer, the cap is a configuration value; widening it is
  forward-compatible.
- **No data migration.** Existing rows get `NULL`. Authors backfill abstracts on demand. There is no
  auto-derivation from `content` (e.g., "first paragraph") — implicit derivation would mask
  authoring gaps and create lossy round-trips when the content changes.
- **Naming collision is acceptable.** `Node.abstract` (the column) and `nodeType='abstract'` (the
  type) share the word "abstract" but describe orthogonal axes: the type marks a *node* as a
  condensed representation of an external source; the column carries a *paragraph summary* of any
  node regardless of its type. The schema doc and the tool descriptions will explicitly call out the
  distinction. Renaming either would cost more than it saves at this point: the type is established
  and referenced in seed data and existing platform-specs; the column name "abstract" is the natural
  English word for what it is.
- **Target repository is `hadron-server` only.** Schema, MCP tools, importer, validator. Portal-side
  UI (rendering the abstract in tree hover, list cards, etc.) is a follow-up gated on this spec but
  not in scope here — once the API returns `abstract`, portal rendering is a localized component
  change that doesn't need a separate spec unless it requires non-trivial UX work.
- **Search remains a sequential text scan.** No trigram or full-text index is added in this spec.
  Existing `h-find-nodes` performance budget (linear in node count, dominated by I/O) is assumed
  sufficient with one more text field in the haystack. If profiling shows the additional column
  materially shifts p50/p95, indexing is a follow-up spec.
- **Partial-update semantics match the existing convention** for `description` / `content` on
  `h-update-node`: omitted field = preserve, explicit `null` = clear, explicit string = replace. No
  new convention is introduced.
- **`brief: true` on `h-find-nodes` continues to exclude body-like content** from the response (
  preserves the existing contract that brief mode returns "index info only"). The abstract is
  searched against but not returned in brief responses.
- **Read/find asymmetry on abstract surfacing is intentional.** `h-find-nodes` always shows the
  abstract in previews (when present); `h-read-node` shows it only when the caller opts in via
  `contentScope`. Rationale: find-nodes is the triage tool where richer preview *is* the job, and
  the per-result cost is bounded by the 50-result default limit. read-node is the "commit to
  reading" tool where the body is what the caller asked for; adding the abstract by default would
  silently inflate every existing caller's context budget. Opt-in keeps the existing contract
  byte-identical and gives the small-LLM caller (who wants only the abstract) a cheap peek mode
  without re-reading the full body. The cost model differs between the two surfaces, so the default
  behavior differs.
- **Content-fallback is one-directional (`'content'` falls back to abstract; `'abstract'` does
  not).** When `contentScope: 'content'` is requested on a content-less node with an abstract, the
  abstract fills the body slot — the abstract IS the content for these nodes, and callers (humans
  or agents) get something useful instead of an empty body. This matches the schema doc's
  long-standing intent for `nodeType='abstract'` ("may be the only representation if the source is
  archived"). The inverse fallback — `'abstract'` returning content when the abstract is `NULL` —
  is **not** added: the caller explicitly asked for the abstract, and silently substituting content
  would surprise them (especially small-LLM callers using `'abstract'` as a cheap peek). Callers
  that want a "give me something" semantics use the default `'content'` scope; callers that want
  full disambiguation use `'all'`.
