---
description: "Implementation tasks for spec 031 — Node `abstract` field"
---

# Tasks: Node `abstract` field — paragraph-length preview

**Input**: Design documents from `specs/031-node-abstract-field/`
**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Not optional for this feature. The server constitution refinement I requires integration tests for graph-touching MCP tools and resolvers (`hadron_test` against a real Postgres). Test tasks below are therefore mandatory; the test-first discipline applies (tests written before implementation, fail expected before they pass).

**Organization**: Tasks are grouped by user story. US3 (search haystack extension) was deferred to the RAG follow-up during PR-196 review and is therefore NOT in this task list.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2). Setup / Foundational / Polish tasks have no story label.
- Include exact file paths in descriptions

## Path conventions

Single-project layout per [plan.md](./plan.md) "Project Structure":

- Schema: `prisma/schema.prisma`, migrations under `prisma/migrations/`
- GraphQL: `src/api/graphql/schema/typeDefs.ts` + `resolvers.ts`
- MCP: `src/mcp/server.ts` (one big file; all five tool-registration blocks live here)
- Typed errors: `src/lib/entityRef/errors.ts`
- Importer/exporter: `src/integrations/github/syncGraphFromGithub.ts` + `writeNodeToGit.ts`
- Tests: adjacent to source (`src/mcp/*.test.ts`), integration under `src/test/integration/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Pre-flight check that the working tree is ready for feature work. No bespoke setup is needed — the repo is already pinned to the stack per S1.

- [ ] T001 Verify dev environment is clean: `pnpm tsc --noEmit && pnpm test` green on `main` before starting; `psql postgresql://holger@localhost:5432/hadron_dev -c '\dt nodes'` confirms the `nodes` table exists.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The schema column has to exist before any tool, resolver, or test can reference it.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T002 [P] Add `abstract String?` column to the `Node` model in `prisma/schema.prisma`, positioned between the existing `description` and `content` fields per [data-model.md](./data-model.md) "Prisma model diff". Include the triple-slash doc-comment block (cites spec 031, surfacing rules, 2000-char cap).
- [ ] T003 [P] Create migration directory `prisma/migrations/YYYYMMDDHHMMSS_node_abstract/` (replace the timestamp with the actual `YYYYMMDDHHMMSS` time of authoring) containing `migration.sql` with: a header comment citing spec 031, `SET LOCAL lock_timeout = '5s';`, and `ALTER TABLE "nodes" ADD COLUMN "abstract" TEXT;` per [data-model.md](./data-model.md) "Migration SQL".
- [ ] T004 Apply schema delta to the dev DB: `DATABASE_URL='postgresql://holger@localhost:5432/hadron_dev' pnpm prisma db push` (NO `--force-reset` — agents are blocked from that per CLAUDE.md), then re-apply CHECK constraints: `psql postgresql://holger@localhost:5432/hadron_dev -v ON_ERROR_STOP=1 -f prisma/post-push.sql`. Depends on T002.

**Checkpoint**: Schema delta live on `hadron_dev`. Both user stories unblocked.

---

## Phase 3: User Story 1 — Author attaches an abstract and reads it back (Priority: P1) 🎯 MVP

**Goal**: Author (human via portal, or AI agent via MCP) creates / updates a node with an `abstract` and reads it back via `h-read-node`'s new `contentScope` parameter. Round-trip works end-to-end. Default reads remain byte-identical to pre-spec. Includes the asymmetric content-fallback rule with `Source: abstract-fallback` meta marker, partial-update semantics, length-cap rejection, invalid-scope rejection, GraphQL parity via `upsertNode`/`NodeInput`, importer/exporter round-trip, and the `h-validate` sparse-node rule extension.

**Independent Test**: An agent calls `h-add-node` with an `abstract`; `h-read-node` with `contentScope: 'abstract'` returns the same string. A default-scope read of a node with `abstract IS NULL` is byte-identical to pre-spec. A content-less abstract-having node read with default scope emits `Source: abstract-fallback` + the abstract in the body slot. All 13 acceptance scenarios in US1 pass.

### Tests for User Story 1 (constitution refinement I — required) ⚠️

> **Test-first discipline**: write the test files below, ensure they FAIL (import-fail or assertion-fail) before implementation begins. As US1 implementation tasks land, tests progressively pass.

- [ ] T005 [P] [US1] Create test scaffold at `src/mcp/server.nodeAbstract.test.ts` covering: (a) round-trip on `h-add-node` → `h-read-node`; (b) the 12-cell `contentScope` × abstract-state × content-state response matrix per [contracts/h-read-node.md](./contracts/h-read-node.md); (c) the `Source: abstract-fallback` marker emission in the meta block; (d) `h-update-node` partial-update semantics (omitted preserves, `null` clears, string replaces); (e) length-cap rejection via `NodeAbstractTooLongError`; (f) invalid `contentScope` rejection via `InvalidContentScopeError`; (g) empty-string AND whitespace-only normalization to `NULL` (FR-009 extended); (h) intentional leading-whitespace abstract persists as-is; (i) `h-validate` sparse-node rule with abstract present / absent.
- [ ] T006 [P] [US1] Create GraphQL integration test at `src/test/integration/node-abstract.test.ts` covering the `upsertNode` + `node(id)` paths per [contracts/graphql-node-type.md](./contracts/graphql-node-type.md) test-coverage section: create-mode persists, update-mode replaces, update-mode null-clears, update-mode omit-preserves, length-cap typed error via GraphQL `extensions.code`, whitespace-only normalization, `createOnly: true` interaction.

### Implementation for User Story 1

- [ ] T007 [P] [US1] Add two new typed error classes in `src/lib/entityRef/errors.ts` (or a sibling under `src/lib/`): `NodeAbstractTooLongError` (carrying `length: number` + `max: 2000`) and `InvalidContentScopeError` (carrying offending value + allowed set). Follow the established typed-error pattern (`extensions.code` matches class name, friendly message). Per [data-model.md](./data-model.md) V1/V2.
- [ ] T008 [P] [US1] Extend the GraphQL schema in `src/api/graphql/schema/typeDefs.ts`: add `abstract: String` field to BOTH the `Node` type AND the `NodeInput` input type, each positioned between the existing `description` and `content` fields. Triple-quoted doc-comments per S3 (no raw backticks). Per [contracts/graphql-node-type.md](./contracts/graphql-node-type.md).
- [ ] T009 [P] [US1] Wire the `upsertNode` resolver in `src/api/graphql/schema/resolvers.ts` to handle `input.abstract`: detect input-key presence (not just value-null) for partial-update semantics, apply trim-then-check normalization (whitespace-only → `null`), throw `NodeAbstractTooLongError` when `> 2000` chars. Depends on T007. Per [contracts/graphql-node-type.md](./contracts/graphql-node-type.md).
- [ ] T010 [P] [US1] Extend the node.yaml importer in `src/integrations/github/syncGraphFromGithub.ts` to read `abstract` from YAML with trim-then-check normalization. Length cap enforced at import time (wrap `NodeAbstractTooLongError` in the upstream sync error envelope). Per [contracts/importer-yaml.md](./contracts/importer-yaml.md).
- [ ] T011 [P] [US1] Extend the node.yaml exporter in `src/integrations/github/writeNodeToGit.ts` to write the `abstract:` key when non-null (omit when null, no `abstract: null` line). Multi-line abstracts use `js-yaml`'s block-scalar (`|`) style. Per [contracts/importer-yaml.md](./contracts/importer-yaml.md).
- [ ] T012 [US1] In `src/mcp/server.ts`, extend the `h-add-node` tool-registration block (find via `server.tool('h-add-node'`): add `abstract` to the zod input schema (`z.string().max(2000).optional()`, positioned after `description`), apply trim-then-check normalization in the handler before the upsert, and ensure length-cap rejection lands as `NodeAbstractTooLongError`. Depends on T007. Per [contracts/h-add-node.md](./contracts/h-add-node.md).
- [ ] T013 [US1] In `src/mcp/server.ts`, extend the `h-update-node` tool-registration block (find via `server.tool('h-update-node'`): add `abstract` to the zod input schema (`z.string().max(2000).nullable().optional()`, positioned after `description`), implement partial-update semantics (key absent = preserve, `null` = clear, string = replace + trim-then-check). Depends on T007. Per [contracts/h-update-node.md](./contracts/h-update-node.md).
- [ ] T014 [US1] In `src/mcp/server.ts`, extend the `h-read-node` tool-registration block (find via `server.tool('h-read-node'`): add `contentScope: z.enum(['content', 'abstract', 'all']).optional().default('content')` to the zod input schema. Implement the 12-cell response matrix per [contracts/h-read-node.md](./contracts/h-read-node.md), including the `Source: abstract-fallback` meta-block line (positioned immediately after `Type:`) when default-scope content-fallback fires. Depends on T007. Pre-spec output byte-identical when abstract is `NULL` (SC-004 backstop).
- [ ] T015 [US1] In `src/mcp/server.ts`, extend the `h-validate` tool-registration block (find the sparse-node check conditional `!node.description && !node.content`): add `abstract` to the `db.node.findMany` select clause, update the sparse condition to include `&& !node.abstract`, update the issue message to "no description, content, or abstract". Per [contracts/h-validate.md](./contracts/h-validate.md).
- [ ] T016 [US1] Run the US1 test files green: `DATABASE_URL='postgresql://holger@localhost:5432/hadron_test' pnpm vitest run src/mcp/server.nodeAbstract.test.ts src/test/integration/node-abstract.test.ts`. All assertions pass.

**Checkpoint**: US1 fully functional. Abstract round-trips on MCP and GraphQL surfaces; the content-fallback rule + marker work; sparse validator updated; importer/exporter symmetric.

---

## Phase 4: User Story 2 — `h-find-nodes` previews include the abstract (Priority: P2)

**Goal**: When an agent surveys a memory via `h-find-nodes`, the result list includes the abstract (when present) as a paragraph preview block beneath the description line. Nodes without an abstract render byte-identically to pre-spec output. `brief: true` is the off-switch — and per the PR-196 deferral of US3, brief is now symmetric (doesn't return abstract, doesn't search it either). `h-list-nodes` tree output is byte-identical to pre-spec for every node.

**Independent Test**: Seed two nodes — one with `abstract` populated, one without. Call `h-find-nodes` with a query that matches both by name. The first node's preview includes the abstract as a `| <abstract>` block beneath `> <description>`; the second renders byte-identically to today's behavior. `brief: true` strips the abstract from the response shape.

### Tests for User Story 2

- [ ] T017 [US2] Extend `src/mcp/server.findReadList.test.ts` with the four US2 acceptance scenarios per [contracts/h-find-nodes.md](./contracts/h-find-nodes.md) "Test coverage": (1) node with abstract emits the `| <abstract>` block; (2) node without abstract is byte-identical to pre-spec; (3) `brief: true` excludes abstract from response byte-identically (and search remains unchanged); (4) `h-list-nodes` tree output byte-identical to pre-spec for every node.

### Implementation for User Story 2

- [ ] T018 [US2] In `src/mcp/server.ts`, extend the `h-find-nodes` Prisma `select` clause (inside the `server.tool('h-find-nodes'` block) to include `abstract: true`. Search haystack (`matchesQuery`) is NOT modified — US3 deferred to RAG follow-up.
- [ ] T019 [US2] In `src/mcp/server.ts`, extend the `h-find-nodes` preview renderer in the same tool block to emit `  | <abstract>` lines beneath the existing `  > <description>` line when `!brief && n.abstract`. Multi-paragraph abstracts get the `| ` prefix on every line (split by `\n`). When abstract is `null` or `brief: true`, no abstract lines are emitted — preview is byte-identical to pre-spec. Per [contracts/h-find-nodes.md](./contracts/h-find-nodes.md).
- [ ] T020 [US2] Run the US2 tests green: `DATABASE_URL='postgresql://holger@localhost:5432/hadron_test' pnpm vitest run src/mcp/server.findReadList.test.ts`. All assertions pass.

**Checkpoint**: US2 fully functional. Find-nodes previews surface the abstract; brief mode preserves pre-spec shape; list-nodes unchanged.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Regression-check the full suite, type-check, and run the manual quickstart end-to-end.

- [ ] T021 [P] Run the full test suite: `pnpm test`. No regressions in any pre-existing test file. Specifically confirm `src/mcp/server.findReadList.test.ts`, `src/mcp/server.replaceOutgoingEdges.test.ts`, `src/mcp/server.deleteMove.test.ts`, `src/mcp/server.serverInfo.test.ts`, and the GraphQL resolver suite all stay green.
- [ ] T022 [P] Run `pnpm tsc --noEmit`. Type-clean. Fix any inference holes introduced by the new field (most likely candidates: GraphQL resolver return types, Prisma `select` projections used elsewhere).
- [ ] T023 Execute the manual smoke recipe in [quickstart.md](./quickstart.md) steps 1–16 against the local dev server (`pnpm tsx src/index.ts` on `:4000`). Confirm every expected outcome in the "Expected outcomes summary" table at the bottom of `quickstart.md`. The fallback case (Step 6) and the whitespace-normalization step (Step 12a) are the most reviewer-visible — verify the `Source: abstract-fallback` line appears at the right position.
- [ ] T024 [P] Update any Hadron memory nodes if non-obvious findings emerged during implementation (e.g., new conventions, unexpected gotchas in `upsertNode` resolver-arg handling, surprising interactions with `NodeVersion` snapshots). Use `h-add-node` / `h-update-node` against `urn:memory:hadronmemory.com::dev` under the `findings` / `conventions` branches per the project's "Help Maintain Hadron Memories" convention. No new node needed if nothing surprising surfaced.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: T001 — no upstream dependencies.
- **Phase 2 (Foundational)**: T002 + T003 [P]; T004 depends on T002+T003. **Blocks all user stories**.
- **Phase 3 (US1)**: Depends on Phase 2. Within US1: test scaffolds (T005, T006) first; typed errors (T007) early; non-server.ts implementation (T008–T011) parallelizable; server.ts implementation (T012–T015) sequential (same file); test-run (T016) last.
- **Phase 4 (US2)**: Depends on Phase 2. Test scaffold T017 → implementation T018+T019 (same file, sequential) → test-run T020.
- **Phase 5 (Polish)**: Depends on US1 and US2 both complete.

### User story dependencies

- **US1 (P1)**: Standalone after Phase 2. No dependency on US2.
- **US2 (P2)**: Standalone after Phase 2. Could be implemented in parallel with US1 by a separate contributor (different surfaces — US1 touches add/update/read/validate/GraphQL/importer; US2 touches find-nodes). Note: US2 implementation reads the `abstract` column written by US1 paths, so end-to-end demo requires at least US1's add path to land first — but the code itself doesn't depend on US1.

### Within each user story

- Test scaffolds (T005, T006, T017) MUST be written first and FAIL (import-fail or assertion-fail) before implementation lands.
- Typed errors (T007) before any server.ts handler that throws them (T012, T013, T014) — and before the GraphQL resolver (T009).
- Non-server.ts changes (T008, T009, T010, T011) parallelizable with each other.
- server.ts changes (T012, T013, T014, T015 in US1; T018, T019 in US2) are sequential within their file — pick an order, land one at a time.
- Test-run task ends each story phase as the gate.

### Parallel opportunities

- T002, T003: write Prisma schema + migration file in parallel.
- T005, T006, T007, T008, T009, T010, T011: all on different files, no inter-dependency once T007 lands → typed errors first, then the rest can run in parallel.
- T021, T022, T024: independent polish tasks, parallelizable.

---

## Parallel Example: US1 implementation kickoff

```bash
# Once Phase 2 (T002–T004) is complete, kick off in parallel:
Task: T005  src/mcp/server.nodeAbstract.test.ts (scaffold)
Task: T006  src/test/integration/node-abstract.test.ts (scaffold)
Task: T007  src/lib/entityRef/errors.ts (typed errors)

# After T007 lands, the rest of the non-server.ts work can run in parallel:
Task: T008  src/api/graphql/schema/typeDefs.ts (Node + NodeInput fields)
Task: T009  src/api/graphql/schema/resolvers.ts (upsertNode resolver)
Task: T010  src/integrations/github/syncGraphFromGithub.ts (importer)
Task: T011  src/integrations/github/writeNodeToGit.ts (exporter)

# Then sequence the server.ts handler edits:
T012 → T013 → T014 → T015 → T016 (test-run)
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (schema column live on `hadron_dev`)
3. Complete Phase 3: US1
4. **STOP and VALIDATE**: Run [quickstart.md](./quickstart.md) Steps 1–7 + 11–15 manually. Demoable: agent can write an abstract, read it back via `contentScope: 'abstract'` or `'all'`, default-scope behavior preserved, fallback case works, length cap rejects, invalid scope rejects, sparse validator extended.

US1 alone is a coherent shippable increment — the column exists, round-trips work, the load-bearing fallback logic is in place. US2 (find-nodes previews) adds discoverability on top.

### Incremental delivery

1. Phase 2 → MVP unblocked.
2. US1 complete → demo round-trip + fallback (MVP).
3. US2 complete → demo find-nodes preview surfacing.
4. Polish: full test sweep + manual quickstart.

### Parallel team strategy

- Contributor A: Phase 2 (schema + migration + db push) → US1 (drives the server.ts changes since they're sequential).
- Contributor B: Phase 2 (review) → US1 parallel work (T008–T011 + tests T005, T006).
- Contributor C: US2 (T017–T020) — can start as soon as Phase 2 lands; no dependency on US1 code.
- All converge at Phase 5 polish.

---

## Notes

- **[P] tasks**: different files, no dependency on incomplete tasks. Multiple [P] tasks can be executed in the same Agent call where the workflow allows.
- **[Story] label**: maps task to its user story. Setup, Foundational, and Polish tasks have no story label.
- **US3 is intentionally absent**: search-haystack extension over abstract was deferred to the RAG / vector-retrieval follow-up during PR-196 review. Do NOT extend `h-find-nodes`' `matchesQuery` haystack in this implementation.
- **Test-first**: per constitution refinement I, tests are not optional here. The integration tests run against `hadron_test` (pinned by `vitest.config.ts`), never `hadron_dev`.
- **Commit cadence**: commit after each task or logical group. Phase boundaries are natural commit points.
- **Avoid**: cross-story dependencies that break independence; vague tasks; modifying the search haystack (US3 territory).
