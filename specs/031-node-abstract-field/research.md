# Phase 0 — Research: Node `abstract` field

This document captures the design decisions made during planning, with rationale and alternatives
considered. The spec already resolved the major axes during `/speckit-specify` and the PR-194
review cycle; this file consolidates them and records the few Phase-0-specific decisions that
emerged from looking at the code surfaces.

**Reading note**: This document and the `contracts/` siblings reference existing code surfaces by
**symbolic name** (function, tool-registration block, zod schema name) rather than line numbers,
so the docs don't rot as `src/mcp/server.ts` and friends accumulate edits. Implementation should
grep for the named anchor; line numbers are not load-bearing. (PR-196 review item 1.)

**Code sketches throughout these docs are illustrative, not load-bearing.** They show the
*shape* of the change to a particular surface (where to slot a new branch, what the response
matrix looks like, etc.); the implementer is expected to integrate them with the surrounding code
idiomatically, including respecting any N+1 or batching patterns that have been resolved
elsewhere since the sketch was written.

## D1 — Column placement on `Node`

**Decision**: `abstract` is added immediately after `description` and before `content` in both
`prisma/schema.prisma` and the generated GraphQL `Node` type.

**Rationale**: The Entity Impact section of the spec specifies this position. It mirrors the
field's semantic place in the description/abstract/content gradient (short → paragraph → full).
Reviewers reading `schema.prisma` see a coherent group of three text-shaped columns. The Prisma
client extension auto-id-injection (per S4) is unaffected — `Node` is not a composite-PK model.

**Alternatives considered**:
- Append at end of the text-column group (before audit columns): keeps the diff smaller but breaks
  the semantic ordering and makes the relationship between the three fields less obvious to future
  readers.
- Pre-pend before `description`: would imply abstract is the shorter form, which it isn't.

## D2 — Migration shape

**Decision**: A single hand-authored migration `YYYYMMDDHHMMSS_node_abstract/migration.sql` doing
`ALTER TABLE nodes ADD COLUMN abstract TEXT;` (nullable, no default, no CHECK). The migration's
directory carries a header comment citing spec 031 (constitution refinement II).

**Rationale**: A nullable text column is a fast online ALTER on Postgres — no table rewrite, no
locking concern at production scale. No backfill: existing rows get `NULL`. No CHECK constraint —
the 2000-char cap is API-boundary validation per S5's framing ("application code is the
user-friendly error-message layer; the database is the truth-keeper" applies to *invariants* like
the bidirectional-memory rule, not soft limits like length caps).

**Alternatives considered**:
- DB-level `CHECK (length(abstract) <= 2000)`: would belt-and-suspenders the cap but conflicts with
  the spec's framing of the cap as a *configuration value* ("the cap is a configuration value;
  widening it is forward-compatible"). A CHECK constraint would require a migration to widen.
- `prisma migrate dev` workflow: rejected per CLAUDE.md ("`prisma migrate dev/deploy` does not work
  cleanly because older migrations reference the dropped `stations` table"). Use `prisma db push`
  on dev/test DBs; hand-author the migration for production.

## D3 — Typed errors

**Decision**: Two new error classes in `src/lib/entityRef/errors.ts`:

- `NodeAbstractTooLongError` — raised when an abstract longer than 2000 characters is submitted on
  `h-add-node` / `h-update-node` / GraphQL mutations. Carries the offending length in the typed
  payload.
- `InvalidContentScopeError` — raised when `h-read-node` is called with a `contentScope` value
  outside `'content' | 'abstract' | 'all'`. Carries the offending value and the allowed set.

**Rationale**: Constitution refinement III + invariant S2 require typed errors at the GraphQL
boundary. Zod validation at the MCP layer rejects bad input before the resolver runs; resolvers
explicitly throw the typed error class so the GraphQL layer's `formatError` hook maps it to a
proper `extensions.code`.

**Alternatives considered**:
- Generic `ValidationError` with a string discriminator: rejected — S2's pattern is one class per
  error condition with a stable `extensions.code` matching the class name.
- DB-level rejection (CHECK constraint): rejected per D2.

## D4 — `Source: abstract-fallback` marker placement in the meta block

**Decision**: The marker line is emitted immediately after `Type:` in the meta block ordering. The
existing meta block is built in the `h-read-node` tool handler in `src/mcp/server.ts` as a
filtered string-array join — find the `metaLines` (or similarly-named) array at the tool-
registration block keyed by `'h-read-node'`. Pre-spec shape:

```
**name**
urn
> description
Type: <nodeType>
Tags: ...
Seq: ...
Properties: ...
Data: ...
Related: ...
Referenced by: ...
```

Post-spec ordering when `contentScope: 'content'` fallback fires:

```
**name**
urn
> description
Type: <nodeType>
Source: abstract-fallback         ← NEW (only when fallback fires)
Tags: ...
...
```

**Rationale**: `Source:` describes a property of *the body slot being filled by something other
than `content`*. Placing it next to `Type:` (which describes "what kind of node is this") makes the
two related-but-orthogonal classifiers visually adjacent. Insertion is at a fixed position so
golden-file fixtures and snapshot tests don't have to handle position variance.

**Alternatives considered**:
- At the top of the meta block (right after the urn): more prominent but disrupts the existing
  visual hierarchy (name → urn → headline → metadata → relations).
- At the bottom of the meta block (after `Referenced by:`): would visually associate with relations
  rather than with content-source semantics. Wrong group.
- Inline in the body separator (e.g., `--- (abstract-fallback)`): the spec already says the body
  separator is the *secondary* disambiguator (via `contentScope: 'all'` shape collapse). Mixing the
  marker into the separator would conflate the two channels.

## D5 — `h-find-nodes` preview rendering shape

**Decision**: When `brief: false` (default) AND `abstract IS NOT NULL`, the preview emits the
existing description line followed by the abstract on the next visual block. Concretely, the
existing preview renderer lives inside the `'h-find-nodes'` tool-registration block in
`src/mcp/server.ts` (search for `server.tool('h-find-nodes'`) and appends two lines per node:
`<urn> — <name>` and `  > <description>` (indented). Post-spec, when an abstract is present, a
third indented block of abstract text follows:

```
<urn> — <name>
  > <description>
  | <abstract>           ← NEW when abstract IS NOT NULL
```

The `> ` prefix on description is preserved (quote-mark for the headline); the abstract block uses
a different prefix (`| ` or similar — see D5a) so visual scanning distinguishes the two.

### D5a — Abstract prefix character

**Decision (revised 2026-05-30 per PR-197 review)**: Use `  ` (two-space indent + no character
prefix) — the same format as the existing `<description>` line in `h-find-nodes` previews. No
`| `, no `> `, just an indented block.

**Why revised**: the original D5a posited `| ` as a way to distinguish abstract from a `> `-
prefixed description. PR-197 review surfaced that `> ` is `h-read-node`'s convention, NOT
`h-find-nodes`'. The actual find-nodes description format is `  ${description}` (two-space
indent, no prefix). Adding `| ` to abstract would have introduced a NEW prefix in a tool that
doesn't use prefixes. The right convention is "match what's already there" — both description
and abstract are simply indented blocks beneath the per-hit header.

Multi-paragraph abstracts (rare, but allowed up to 2000 chars) get the two-space indent on each
line; visual distinction between description (single line) and abstract (multi-line) comes from
the abstract's natural length, not from a prefix character.

**Rationale**: consistency with the surrounding tool format. Avoids introducing a NEW visual
convention in a contract that exists to extend an existing surface.

**Alternatives considered**:
- Original `| ` proposal: rejected because it would have introduced a prefix in a tool that
  doesn't use them.
- Reusing `> `: same problem — `> ` belongs to `h-read-node`, not find-nodes.
- Use `## Abstract` as a header: still heavyweight for a list-of-hits preview.

### D11 — Whitespace-only abstract normalization

**Decision (2026-05-30 per PR-196 review)**: Trim-then-check normalization. The server trims
leading + trailing whitespace from the input; if the trimmed value is empty, persist `NULL`.
Non-empty trimmed values are persisted **as-is (untrimmed)**, preserving intentional surrounding
whitespace on real paragraphs.

**Rationale**: prevents ghost-whitespace abstracts from polluting find-nodes previews while
keeping the persisted value lossless for real content. Symmetric across MCP write paths
(`h-add-node`, `h-update-node`), GraphQL (`upsertNode` resolver), and the node.yaml importer.

**Validation order**:
1. Length-cap check on the **raw** input (`abstract.length > 2000 → NodeAbstractTooLongError`).
2. Trim-then-check normalization (whitespace-only → `null`; otherwise keep raw value).
3. DB write.

**FR codification**: FR-009 was extended in PR-196 round-1 review to cover whitespace-only.
Implementation surfaces this in `data-model.md` V3.

**Alternatives considered**:
- Don't trim (persist `"   "` as-is): more honest about not silently mangling input but leaves
  ghost-whitespace abstracts in previews. Worse agent UX.
- Trim and persist trimmed value: symmetric and simpler, but loses intentional leading/trailing
  whitespace on real paragraphs. Lossy round-trip for the rare but legitimate case.

## D6 — `h-validate` sparse-node rule extension

**Decision**: The existing sparse-node check inside the `'h-validate'` tool-registration block in
`src/mcp/server.ts` (search for the conditional `!node.description && !node.content`) extends to
`if (!node.description && !node.content && !node.abstract)`. The reported issue message also
changes to mention all three fields: "no description, content, or abstract".

**Rationale**: Per FR-011 — a node carrying only an abstract is not sparse. The abstract is
legitimate content for the validator's "this node has zero text" intent.

**Alternatives considered**: None reasonable — the rule is a straight conjunction extension.

## D7 — node.yaml importer/exporter round-trip

**Decision**: The YAML schema for nodes gains an optional `abstract: string` key. The importer at
`src/integrations/github/syncGraphFromGithub.ts` reads it (per the existing pattern for
`description`, `content`, etc.). The exporter at `src/integrations/github/writeNodeToGit.ts`
writes it. Absent in YAML = `NULL` in DB; round-trip is byte-identical for any value within the
2000-char cap.

**Rationale**: FR-010 requires symmetric round-trip. The existing field-by-field pattern for
serializing/deserializing node text columns is the right model; abstract joins the list.

**Alternatives considered**:
- Lazy-add to YAML only when non-null: keeps YAML cleaner but breaks symmetry (a node that had an
  abstract cleared via `h-update-node` would have a stale `abstract:` key on next export unless
  explicitly handled). Not worth the asymmetry — empty string normalization (FR-009) keeps the
  field falsy in YAML when cleared, and `js-yaml`'s default behavior omits null values cleanly.

## D8 — GraphQL `Node.abstract` exposure

**Decision**: Add `abstract: String` to the `Node` type in `src/api/graphql/schema/typeDefs.ts`,
positioned between `description` and `content` (mirroring Prisma layout per D1). Resolver passes
the column through unchanged. The 2000-char cap is enforced at the mutation argument level (zod
or a typed error in the resolver — both paths land at `NodeAbstractTooLongError`).

**Mutation surface** (verified 2026-05-30 against the actual typeDefs.ts): the GraphQL write path
for nodes is a single mutation `upsertNode(input: NodeInput!): Node!`, NOT separate `createNode` /
`updateNode` mutations as originally posited. The `NodeInput` input type (find at `input
NodeInput {` in `typeDefs.ts`) gains an optional `abstract: String` field, positioned between
`description` and `content`. Same partial-update semantics: omitted → preserve, `null` → clear,
string → replace (after trim-then-check normalization per FR-009). The existing `createOnly:
Boolean` flag on `NodeInput` distinguishes "reject on collision" from "upsert"; it does not
interact with the new abstract field.

**Rationale**: GraphQL surface parity with MCP — GraphQL callers (portal, programmatic users)
should be able to read and write abstracts without dropping to MCP. Doc-comment on the field cites
spec 031 per constitution refinement II.

**Alternatives considered**:
- MCP-only exposure, no GraphQL: would create an MCP/GraphQL feature asymmetry that future
  contributors would trip over. Cheap to maintain parity.

## D9 — Test layout

**Decision**: Three test files carry the abstract coverage:

1. **`src/mcp/server.findReadList.test.ts`** (extend existing) — adds cases for `h-find-nodes`
   preview rendering with/without abstract, `brief: true` byte-identical carve-out, and
   `h-list-nodes` byte-identical assertion. NO search-recall tests over abstract content (per
   PR-196 deferral of US3/FR-007).
2. **`src/mcp/server.nodeAbstract.test.ts`** (NEW) — the dedicated abstract-surface test file.
   Covers: round-trip on `h-add-node` + `h-update-node` + `h-read-node`; all three `contentScope`
   values × abstract-state × content-state cells (matrix snapshot fixtures); the `Source:
   abstract-fallback` marker emission; partial-update semantics (`null` clears, omitted
   preserves); length-cap rejection (NodeAbstractTooLongError); invalid contentScope rejection
   (InvalidContentScopeError); empty-string AND whitespace-only normalization to NULL (FR-009);
   `h-validate` sparse-node rule with abstract present/absent.
3. **`src/test/integration/node-abstract.test.ts`** (NEW) — GraphQL `upsertNode` mutation +
   `node(id)` query integration pinning the same matrix against the GraphQL surface (per
   constitution refinement I — graph-touching mutations get integration tests). Includes
   `NodeInput.abstract` round-trip + length-cap rejection over GraphQL.

**Rationale**: Dedicated test file (`server.nodeAbstract.test.ts`) keeps the matrix coverage
discoverable and reviewable. Existing files get small extensions for the rendering changes that
naturally live there. The integration file targets `upsertNode` (the actual GraphQL write
surface) rather than the originally-posited createNode/updateNode pair (D8 update).

**Alternatives considered**:
- One big file extending `server.findReadList.test.ts`: would balloon that file; matrix coverage
  gets lost in unrelated cases.
- Split contentScope vs preview vs validation into three new files: over-fragmented for the scope.

## D10 — Performance posture

**Decision**: No index added in v1. Per the PR-196 deferral of US3/FR-007, the abstract is also
NOT added to `h-find-nodes`' haystack — so search performance is byte-identical to pre-spec for
this surface. Search recall over abstract content is the natural job of the upcoming RAG /
vector-retrieval layer (see spec Background); we deliberately don't ship a trigram-or-vector
acceleration here that would compete with that follow-up.

**Rationale**: Spec Assumptions section already commits to this. Premature indexing adds migration
complexity and a write-amplification cost we'd pay forever for a problem we don't know we have.
And shipping substring acceleration over abstract immediately before the RAG layer arrives would
build infrastructure we'd then shadow with semantic search.

**Alternatives considered**: Pre-emptive trigram index — rejected per the above. Extending
`h-find-nodes` haystack to include abstract without an index (the original US3) — deferred to
RAG follow-up per PR-196 review.
