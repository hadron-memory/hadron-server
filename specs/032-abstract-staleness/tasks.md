---
description: "Implementation tasks for spec 032 — Node `abstractOriginHash`"
---

# Tasks: Node `abstractOriginHash` — stale-abstract detection

**Input**: Design documents from `specs/032-abstract-staleness/`
**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Not optional. Constitution refinement I requires integration tests for graph-touching MCP tools and resolvers (run against `hadron_test`). Test-first discipline applies — write scaffolds first, watch them fail (import-fail or assertion-fail), then make them pass as implementation lands.

**Organization**: Tasks are grouped by user story (US1 = P1 write-path; US2 = P2 read marker; US3 = P3 validator warning). Smaller surface than spec 031 — one column, ~22 tasks total.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: `[US1]`, `[US2]`, `[US3]` — required for user-story phase tasks; absent for Setup / Foundational / Polish
- Include exact file paths in descriptions

## Path conventions

Single-project layout per [plan.md](./plan.md):

- Schema: `prisma/schema.prisma`, migrations under `prisma/migrations/`
- GraphQL: `src/api/graphql/schema/typeDefs.ts` + `resolvers.ts`
- MCP: `src/mcp/server.ts` (all five tool-registration blocks)
- Hash helper (new): `src/lib/contentHash.ts`
- Importer/exporter: `src/integrations/localFs/loadNodeFromFs.ts`, `src/integrations/github/syncGraphFromGithub.ts`, `src/integrations/github/writeNodeToGit.ts`
- Tests: adjacent to source (`src/mcp/*.test.ts`, `src/lib/*.test.ts`), integration under `src/test/integration/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Pre-flight check. No bespoke setup needed.

- [ ] T001 Verify dev environment is clean: `pnpm tsc --noEmit && pnpm test` green on `main` before starting; `psql postgresql://holger@localhost:5432/hadron_dev -c '\dt nodes node_versions'` confirms both tables exist.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema columns and the shared hash helper must exist before any tool or test can reference them.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T002 Add `abstractOriginHash String? @map("abstract_origin_hash")` to BOTH the `Node` model AND the `NodeVersion` model in `prisma/schema.prisma`, positioned adjacent to each model's existing `contentHash` / `content` field per [data-model.md](./data-model.md). Triple-slash doc-comments in place (cites spec 032). Same file, two edits — sequential by file but one task because the edits are tightly coupled.
- [ ] T003 Create migration directory `prisma/migrations/YYYYMMDDHHMMSS_abstract_origin_hash/` (replace timestamp with actual `YYYYMMDDHHMMSS` time of authoring) containing `migration.sql` per [data-model.md](./data-model.md): header comment citing spec 032, `BEGIN; SET LOCAL lock_timeout = '5s'; ALTER TABLE "nodes" ADD COLUMN "abstract_origin_hash" TEXT; ALTER TABLE "node_versions" ADD COLUMN "abstract_origin_hash" TEXT; COMMIT;`. One migration adds both columns atomically.
- [ ] T004 [P] Create the shared hash helper at `src/lib/contentHash.ts` per [data-model.md](./data-model.md) "Hash computation" section: exports `computeContentHash(content: string | null | undefined): string | null` returning `SHA-256(content)[0:8]` via `crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8)`; returns `null` for null/empty input. Co-locate a unit test at `src/lib/contentHash.test.ts` with known SHA-256 fixtures: `computeContentHash('hello') === '2cf24dba'`, `computeContentHash('') === null`, `computeContentHash(null) === null`.
- [ ] T005 Apply schema delta to the dev DB: `DATABASE_URL='postgresql://holger@localhost:5432/hadron_dev' pnpm prisma db push` (no `--force-reset`), then re-apply CHECK constraints: `psql postgresql://holger@localhost:5432/hadron_dev -v ON_ERROR_STOP=1 -f prisma/post-push.sql`. Depends on T002.
- [ ] T006 Apply schema delta to the test DB: `DATABASE_URL='postgresql://holger@localhost:5432/hadron_test' pnpm prisma db push --skip-generate`, then re-apply post-push.sql to hadron_test. Required before any US1/US2/US3 test can run against the new columns. Depends on T002.

**Checkpoint**: Schema delta live on both `hadron_dev` and `hadron_test`. `computeContentHash` helper available. All user stories unblocked.

---

## Phase 3: User Story 1 — Write paths maintain `abstractOriginHash` correctly (Priority: P1) 🎯 MVP

**Goal**: Every Node write surface (MCP `h-add-node` / `h-update-node`, GraphQL `upsertNode`, importer round-trip, version restore) keeps `abstractOriginHash` in sync with the intent of the write per the 9-row partial-update matrix in [contracts/h-update-node.md](./contracts/h-update-node.md). NodeVersion snapshots capture the hash; `restoreNodeVersion` writes it verbatim. GraphQL exposes the field read-only.

**Independent Test**: Seed a node via every write surface and assert `abstractOriginHash` matches the expected value per the 9-row matrix. Update only content — assert hash unchanged (stale signal armed). Update only abstract — assert hash reset to `computeContentHash(existing.content)`. Clear abstract — assert hash cleared. Restore a version — assert hash matches version's stored value. The column is observable (queryable in DB or via GraphQL) and the contract is testable even before US2/US3 surface the staleness signal.

### Tests for User Story 1

- [ ] T007 [P] [US1] Create test scaffold `src/mcp/server.nodeAbstractStaleness.test.ts` covering: the 9-row matrix on `h-add-node` + `h-update-node`; the `abstract: null` and `content: null` clearing rules; FR-007 ghost-hash case (content cleared without abstract update preserves hash); the `existing.content` "current" reset case (FR-003); NodeVersion snapshot capture on `h-update-node`. Tests should fail (or fail to compile) before T010-T013 implementation lands.
- [ ] T008 [P] [US1] Extend `src/test/integration/node-abstract.test.ts` with: GraphQL `upsertNode` hash matrix (parallel to MCP); `restoreNodeVersion` hash round-trip (version stored hash applied verbatim per plan D4; legacy-version with null hash short-circuits the live row's staleness check); the SC-005 schema contract test asserting `NodeInput.abstractOriginHash` is absent from the input type; the SC-005 implementation-level invariant test (greps src/ for hash-literal RHS assignments per [contracts/graphql-node-type.md](./contracts/graphql-node-type.md)).
- [ ] T009 [P] [US1] Extend `src/integrations/localFs/loadNodeFromFs.test.ts` with: YAML round-trip preserving stale-state (hash mismatch accepted with warning); clean round-trip (hash matches computed); missing-key recompute; non-string YAML value (number/boolean/object/array) fall-through to recompute. Assert the disagreement warning fires via `vi.spyOn(console, 'warn')`.

### Implementation for User Story 1

- [ ] T010 [P] [US1] Extend GraphQL schema in `src/api/graphql/schema/typeDefs.ts`: add `abstractOriginHash: String` field to the `Node` type (positioned adjacent to `contentHash`) per [contracts/graphql-node-type.md](./contracts/graphql-node-type.md). **Do NOT add the field to `NodeInput`** — the absence is what SC-005's schema contract test asserts. Triple-quoted doc-comment per S3 (no raw backticks).
- [ ] T011 [P] [US1] Wire the `upsertNode` resolver in `src/api/graphql/schema/resolvers.ts`: compute `abstractOriginHash` via `computeContentHash` before the upsert per the 9-row matrix in [contracts/h-update-node.md](./contracts/h-update-node.md); include in both `create` and `update` branches; NodeVersion snapshot captures `existing.abstractOriginHash`. Do NOT set `contentHash` (per [data-model.md](./data-model.md) "What is NOT"). Depends on T004 (helper).
- [ ] T012 [P] [US1] Wire `restoreNodeVersion` in `src/api/graphql/schema/resolvers.ts`: pre-restore snapshot captures live `abstractOriginHash`; restore-write applies `version.abstractOriginHash` verbatim (no recomputation per plan D4). Depends on T004.
- [ ] T013 [P] [US1] Extend the node.yaml importer in `src/integrations/localFs/loadNodeFromFs.ts` per [contracts/importer-yaml.md](./contracts/importer-yaml.md) "FR-013 validate-on-import model": compute hash from imported content; compare against YAML's `abstractOriginHash` key; on match accept silently; on mismatch accept YAML value + emit warning via `console.warn`; on missing/non-string fall through to computed. Add the `abstractOriginHash` key to the `NodeYaml` interface. Depends on T004.
- [ ] T014 [P] [US1] Extend `src/integrations/github/syncGraphFromGithub.ts` to pass `node.abstractOriginHash` through to the upsert payload (the importer in T013 populates it on the in-memory node object; this site threads it through the DB write). Depends on T013.
- [ ] T015 [P] [US1] Extend the node.yaml exporter in `src/integrations/github/writeNodeToGit.ts` per [contracts/importer-yaml.md](./contracts/importer-yaml.md) "Exporter surface": add `abstractOriginHash` to the `NodeForGit` interface; write `abstractOriginHash:` to frontmatter when non-null (omit when null, parallel to spec 031's omit-on-null convention). Depends on T004 (the helper is referenced for the round-trip test; this site only writes the stored value).
- [ ] T016 [US1] In `src/mcp/server.ts`, extend the `h-add-node` tool-registration block per [contracts/h-add-node.md](./contracts/h-add-node.md): compute `abstractOriginHash` via `computeContentHash` before the upsert; include in both `create` and `update` branches; do NOT touch `contentHash`. Depends on T004.
- [ ] T017 [US1] In `src/mcp/server.ts`, extend the `h-update-node` tool-registration block per [contracts/h-update-node.md](./contracts/h-update-node.md): **widen the zod schema** so `content: z.string().nullable().optional()` (one-line change; the matrix's `content: null` rows require it); implement the 9-row partial-update matrix; NodeVersion snapshot captures `existing.abstractOriginHash`. Depends on T004 + T016 (same file, sequential).
- [ ] T018 [US1] In `src/mcp/server.ts`, extend the `h-move-node` tool-registration block: NodeVersion snapshot captures `existing.abstractOriginHash` (mirrors the spec-031 lesson — every snapshot site must include the new column). Depends on T017 (same file).
- [ ] T019 [US1] Run US1 test files green: `DATABASE_URL='postgresql://holger@localhost:5432/hadron_test' pnpm vitest run src/lib/contentHash.test.ts src/mcp/server.nodeAbstractStaleness.test.ts src/test/integration/node-abstract.test.ts src/integrations/localFs/loadNodeFromFs.test.ts`. All assertions pass.

**Checkpoint**: US1 fully functional. Every write surface maintains the hash; NodeVersion captures it across all 4 snapshot sites; GraphQL exposes it read-only; importer/exporter round-trip preserves stale state with observability.

---

## Phase 4: User Story 2 — `h-read-node` surfaces `Source: abstract-stale` (Priority: P2)

**Goal**: When `h-read-node` is called and the node is stale (`abstract IS NOT NULL` AND `content IS NOT NULL` AND `abstractOriginHash IS NOT NULL` AND `abstractOriginHash !== computeContentHash(node.content)`), the meta block carries a `Source: abstract-stale` line — positioned adjacent to spec 031's `Source: abstract-fallback` marker, only under `contentScope: 'abstract'` or `'all'`.

**Independent Test**: Seed a fresh node (hashes match) and a stale node (hashes differ). Read both with `contentScope: 'all'`: fresh has no marker; stale has `Source: abstract-stale`. Read stale with default scope: NO marker (abstract not in response). Read a legacy node (null hash): NO marker (short-circuit).

### Tests for User Story 2

- [ ] T020 [US2] Extend `src/mcp/server.nodeAbstractStaleness.test.ts` with the 6 US2 acceptance scenarios per [contracts/h-read-node.md](./contracts/h-read-node.md) "Test coverage": fresh node + `'all'` (no marker); stale + `'all'` (marker present); stale + `'abstract'` (marker present); stale + `'content'` default (no marker); content-less abstract-having node (spec 031 fallback) under default (`Source: abstract-fallback` only, NOT `abstract-stale`); legacy null-hash node (no marker). Plus an encrypted-memory test in `src/api/graphql/schema/resolvers.encryption.test.ts` extending the existing fixture: the staleness predicate evaluates on **plaintext** content because `h-read-node`'s existing `decryptNodesBatch` call runs before the predicate; assert that a fresh-then-stale write cycle on an encrypted memory surfaces the marker on the next read just like on a non-encrypted memory.

### Implementation for User Story 2

- [ ] T021 [US2] In `src/mcp/server.ts`, extend the `h-read-node` tool-registration block per [contracts/h-read-node.md](./contracts/h-read-node.md). The staleness check runs AFTER `decryptNodesBatch` (already invoked on the read path per spec 031), so `node.content` is plaintext at this point on both encrypted and non-encrypted memories. Sketch:

  ```typescript
  // Four-clause guard (FR-010 conditions a–d + FR-007 ghost-case
  // short-circuit). The explicit `abstractOriginHash != null` is the
  // load-bearing one for legacy nodes.
  const isStale =
    !!(node.abstract && node.abstract.length > 0) &&
    !!(node.content && node.content.length > 0) &&
    node.abstractOriginHash != null &&
    node.abstractOriginHash !== computeContentHash(node.content);

  // Marker emission gated by scope (FR-010 condition e).
  const includeStaleMarker = isStale && (scope === 'abstract' || scope === 'all');
  ```

  Add the `includeStaleMarker ? 'Source: abstract-stale' : ''` entry to the meta-block array adjacent to the existing `isFallback ? 'Source: abstract-fallback' : ''` entry (the two are mutually exclusive in practice — fallback requires content null; stale requires content non-null). Depends on T004.
- [ ] T022 [US2] Run US2 tests green: `DATABASE_URL='postgresql://holger@localhost:5432/hadron_test' pnpm vitest run src/mcp/server.nodeAbstractStaleness.test.ts src/api/graphql/schema/resolvers.encryption.test.ts`. All assertions pass.

**Checkpoint**: US2 fully functional. Stale nodes surface the marker on opt-in reads; fresh and legacy nodes render byte-identical to pre-spec; encrypted-memory case verified.

---

## Phase 5: User Story 3 — `h-validate` flags `[stale-abstract]` warnings (Priority: P3)

**Goal**: `h-validate` reports `[stale-abstract] <urn> — abstract may not reflect current content` for every node satisfying the staleness predicate. Warning counts alongside sparse-node and broken-edge issues in the existing summary; zero false positives on fresh and legacy nodes.

**Independent Test**: Seed a memory with three nodes (fresh / stale / no-abstract). Run `h-validate`. Assert exactly one `[stale-abstract]` line citing the stale node's URN; the fresh + no-abstract nodes are not flagged.

### Tests for User Story 3

- [ ] T023 [US3] Extend `src/mcp/server.nodeAbstractStaleness.test.ts` with the 5 US3 acceptance scenarios per [contracts/h-validate.md](./contracts/h-validate.md) "Test coverage": single stale node flagged; clean memory produces zero `[stale-abstract]` warnings; mixed memory (sparse + broken + stale) reports all three with their own tags; legacy-dominated memory produces zero warnings (short-circuit on null hash); **encrypted memory produces zero `[stale-abstract]` warnings** (h-validate doesn't decrypt and the staleness predicate requires plaintext content, so v1 skips the check on encrypted memories — see T024). PR-208 review caught the original "evaluates without decryption" wording as a contradiction; v1 design is **skip-on-encrypted**, encryption-parity follow-up adds the check.

### Implementation for User Story 3

- [ ] T024 [US3] In `src/mcp/server.ts`, extend the `h-validate` tool-registration block per [contracts/h-validate.md](./contracts/h-validate.md): add the stale-abstract check inside the existing per-node loop using the same predicate as `h-read-node` (T021). **Gate the check on `!memory.isEncrypted`** — h-validate doesn't invoke `decryptNodesBatch`, so on encrypted memories `node.content` is ciphertext and `computeContentHash(node.content)` would compare unequal to every `abstractOriginHash` (false-positive on every node). v1 skips the staleness check entirely for encrypted memories; the encryption-parity follow-up will add a decrypt step before the predicate. Sketch:

  ```typescript
  // Existing checks: sparse-node, broken-edge (unchanged) ...

  // Spec 032 stale-abstract check, gated on non-encrypted memories
  // (h-validate doesn't decrypt content; staleness on encrypted memories
  // is deferred to the encryption-parity follow-up — see PR-208 review).
  if (!memory.isEncrypted) {
    if (
      node.abstract != null && node.abstract.length > 0 &&
      node.content != null && node.content.length > 0 &&
      node.abstractOriginHash != null &&
      node.abstractOriginHash !== computeContentHash(node.content)
    ) {
      issues.push(`[stale-abstract] ${nUrn} — abstract may not reflect current content`);
    }
  }
  ```

  No `db.node.findMany` select change needed — `include` mode auto-projects the new column. Depends on T004.
- [ ] T025 [US3] Run US3 tests green: `DATABASE_URL='postgresql://holger@localhost:5432/hadron_test' pnpm vitest run src/mcp/server.nodeAbstractStaleness.test.ts`. All assertions pass.

**Checkpoint**: US3 fully functional. Bulk staleness detection available via `h-validate`; no false positives on fresh or legacy nodes; mixed memories report all issue types with their own tags.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Regression-check the full suite, typecheck, and run the manual quickstart end-to-end.

- [x] T026 [P] Full test suite green at every PR merge gate (#209: 1750/1750; #210: 1758/1758; #212: 1763/1763). No pre-existing test file regressed.
- [x] T027 [P] `pnpm tsc --noEmit` clean at every PR merge gate. The Prisma client's new `abstractOriginHash` column on `Node` + `NodeVersion` projections did not surface any hand-constructed Node literals that needed widening — fixtures all pass `Partial<Node>` or construct via the upsert path.
- [ ] T028 Execute the manual smoke recipe in [quickstart.md](./quickstart.md) steps 1–12 against the local dev server (`pnpm tsx src/index.ts` on `:4000`). Confirm every expected outcome in the "Expected outcomes summary" table. Step 11 (restore-version round-trip) is the highest-value manual check — it pins the plan D4 decision (restore stays verbatim) in observable behavior. **Human task** — handed off to user; not a code-gate blocker for spec close-out.
- [x] T029 [P] **Findings affirmation**: two findings recorded.
  1. **Read-time hash compare for staleness** (PR-207 review-driven design pivot): compare a stored origin-hash against `computeContentHash(node.content)` at read time, NOT against another stored hash column. Decouples hash domains (`Node.contentHash` is for external producers; `Node.abstractOriginHash` is for staleness), no migration of legacy rows, the `!= null` short-circuit on the predicate keeps pre-spec data quiet by design. Recorded in auto-memory `feedback_read_time_hash_compare.md`; should be promoted to the dev memory's `findings:` branch when MCP write access lands in a future session.
  2. **MCP read-side encryption asymmetry forces gating** (spec 032 PR #210 + #212): MCP doesn't decrypt on the read path either (not just the write path), so any predicate that compares a stored plaintext-derived hash against `computeContentHash(node.content)` must gate on `!memory.isEncrypted` to avoid false-positives on every node. Updated the existing `project_mcp_bypasses_encryption.md` auto-memory entry to cover both sides; tracked alongside #206 via the bundled cleanup issue #211.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: T001 — no upstream dependencies.
- **Phase 2 (Foundational)**: T002 + T003 sequential (same file dependency); T004 [P] (different file). T005 depends on T002+T003. T006 depends on T002+T003. **Blocks all user stories.**
- **Phase 3 (US1)**: Depends on Phase 2. Test scaffolds (T007, T008, T009) first; non-server.ts implementation (T010, T011, T012, T013, T014, T015) parallelizable after T004; server.ts implementation (T016 → T017 → T018) sequential within the file; test-run T019 last.
- **Phase 4 (US2)**: Depends on Phase 2. Test scaffold T020 → server.ts edit T021 → test-run T022.
- **Phase 5 (US3)**: Depends on Phase 2. Test scaffold T023 → server.ts edit T024 → test-run T025.
- **Phase 6 (Polish)**: Depends on US1, US2, US3 all complete.

### User story dependencies

- **US1 (P1)**: Standalone after Phase 2. No dependency on US2/US3.
- **US2 (P2)**: Standalone after Phase 2. Reads the column written by US1 paths, so end-to-end demo requires US1's write path to land — but the code itself doesn't depend on US1.
- **US3 (P3)**: Same as US2.

### Within each user story

- Test scaffolds (T007, T008, T009, T020, T023) MUST be written first and FAIL before implementation lands.
- T004 (`computeContentHash` helper) is a prerequisite for every site that uses it — land it early in US1 even though it's labeled Phase 2 (it's mechanically in Phase 2 but US1 implementation tasks reference it).
- server.ts edits (T016, T017, T018 in US1; T021 in US2; T024 in US3) are sequential within the file.
- Test-run task ends each story phase as the gate.

### Parallel opportunities

- T002 + T003 + T004: schema + migration + helper, three independent files.
- T007 + T008 + T009: three test scaffold files, all parallelizable.
- T010 + T011 + T012 + T013 + T014 + T015: six non-server.ts files, all parallelizable after T004 lands.
- T026 + T027 + T029: independent polish tasks.

---

## Parallel Example: US1 implementation kickoff

```bash
# Once Phase 2 (T002–T006) is complete, kick off in parallel:
Task: T007  src/mcp/server.nodeAbstractStaleness.test.ts (scaffold)
Task: T008  src/test/integration/node-abstract.test.ts (extend)
Task: T009  src/integrations/localFs/loadNodeFromFs.test.ts (extend)

# After test scaffolds compile (against T004's helper), kick off
# non-server.ts implementation in parallel:
Task: T010  src/api/graphql/schema/typeDefs.ts (Node.abstractOriginHash field)
Task: T011  src/api/graphql/schema/resolvers.ts (upsertNode hash + snapshot)
Task: T012  src/api/graphql/schema/resolvers.ts (restoreNodeVersion two-edits)
Task: T013  src/integrations/localFs/loadNodeFromFs.ts (importer validate-on-import)
Task: T014  src/integrations/github/syncGraphFromGithub.ts (sync passthrough)
Task: T015  src/integrations/github/writeNodeToGit.ts (exporter)

# T011 + T012 are same-file (resolvers.ts) and may need to land
# sequentially in practice, depending on whether the edits collide.

# Then sequence the server.ts handler edits:
T016 → T017 → T018 → T019 (test-run)
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (schema column live on `hadron_dev` + `hadron_test`; helper exists)
3. Complete Phase 3: US1
4. **STOP and VALIDATE**: Run [quickstart.md](./quickstart.md) Steps 1 + 3 + 7 (the DB-inspection steps that prove the hash is being maintained correctly across write paths). Skip steps 2 / 4 / 5 / 6 / 8 / 9 (those require US2 / US3 surfacing). Step 11 (version restore) IS demoable in MVP — the hash round-trips through NodeVersion.

US1 alone is a coherent shippable increment — the column exists, every write surface maintains it, version history captures it, GraphQL exposes it read-only. The staleness signal is **observable** (you can compute the predicate yourself by comparing `abstractOriginHash` against `computeContentHash(node.content)`) even before any tool **surfaces** it.

**RAG-consumer note** (PR-208 review clarification): "US1 alone unblocks RAG" does not mean the RAG layer reads a pre-computed staleness boolean. The column exposes the **origin of the comparison** (the hash at time of authoring), not the comparison **result**. The RAG layer must:
1. Read `abstractOriginHash` from the row.
2. Compute `computeContentHash(node.content)` itself (using the same shared helper).
3. Treat divergence as the staleness signal.

This is by design (per data-model.md "What is NOT" — no derived `is_stale` column). US2 and US3 surface the computed signal on read tools for human / agent consumers; the RAG layer does its own composition.

### Incremental delivery

1. Phase 2 → MVP unblocked.
2. US1 complete → demo write-path correctness (inspect DB).
3. US2 complete → demo h-read-node marker (the agent-facing signal).
4. US3 complete → demo h-validate bulk warning (the operator-facing signal).
5. Polish: full test sweep + manual quickstart.

### Parallel team strategy

- Contributor A: Phase 2 (T002–T006) → US1 (drives the server.ts edits since they're sequential).
- Contributor B: Phase 2 (T004 helper review) → US1 parallel work (T007, T008, T009 test scaffolds + T010, T013, T015 importer / exporter / GraphQL field).
- Contributor C: US2 (T020–T022) — can start as soon as Phase 2 lands.
- Contributor D: US3 (T023–T025) — same as C.
- All converge at Phase 6 polish.

---

## Notes

- **[P] tasks**: different files, no dependency on incomplete tasks. Multiple [P] tasks can be executed in the same Agent call where the workflow allows.
- **[Story] label**: maps task to its user story. Setup, Foundational, and Polish tasks have no story label.
- **Test-first**: per constitution refinement I, tests are not optional. Run against `hadron_test` (pinned by `vitest.config.ts`), never `hadron_dev`.
- **Sequenced before RAG**: this spec is a precursor. The RAG spec consumes `abstractOriginHash` to skip / re-queue stale embeddings; ship 032 before starting the RAG implementation.
- **Commit cadence**: commit after each task or logical group. Phase boundaries are natural commit points.
- **Avoid**: touching `Node.contentHash` write semantics (different domain, out of scope per data-model.md "What is NOT"); inlining `createHash('sha256')` calls anywhere (use the helper, per SC-005's implementation-level invariant); adding `abstractOriginHash` to `NodeInput` (SC-005's schema contract test will fail).
