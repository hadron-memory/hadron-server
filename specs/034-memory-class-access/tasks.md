---
description: "Task list — Spec 034: memory access rules (class-driven, user-ownable)"
---

# Tasks: Memory access rules — class-driven, user-ownable

**Input**: `specs/034-memory-class-access/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md)
**Tests**: REQUIRED — constitution Principle I mandates an integration test in `src/test/integration/` for every access-control mutation.

## Format: `[ID] [P?] [Story] Description`

- **[P]** = parallelizable (different file, no incomplete deps)
- **[US#]** = user-story phase tasks only

## Path conventions

Single web-service repo. Schema `prisma/schema.prisma`; CHECKs `prisma/post-push.sql`;
migration `prisma/migrations/<ts>_memory_class_access/`; GraphQL
`src/api/graphql/schema/{resolvers,typeDefs}.ts`; predicate
`src/lib/auth/resolveMemoryAuthorization.ts`; MCP gate `src/mcp/access-control.ts`;
tests `src/test/integration/`.

> **Ordering reality:** this is a schema refactor, so the `Memory.type` /
> `MemoryVisibility` removal and the keep-the-build-green code edits are
> **Foundational** (Phase 2), not isolated to US3 — dropping a column while code
> still reads it breaks the build. US1 is the headline new capability (MVP); US2/US3
> are largely verification + the genuinely new behavior on top.

---

## Phase 1: Setup

- [ ] T001 Confirm `hadron_test` is reachable and the baseline suite is green (`pnpm test`, `pnpm tsc --noEmit`) before changing the schema, so regressions are attributable.

## Phase 2: Foundational (schema + keep-green code + constraints) — BLOCKS all stories

- [ ] T002 In `prisma/schema.prisma`: make `Memory.organizationId` **nullable**; make `Memory.visibility` **nullable**, **remove its `@default(PRIVATE)`** (the value is being pruned — leaving it breaks `prisma generate`), and prune `MemoryVisibility` to `{ PUBLIC, ORGANIZATION, GROUP }`; **remove** `Memory.type` and the `MemoryType` enum; keep `MemoryClass` unchanged. Run `prisma generate`. (The DB-level column default on `visibility` must also be dropped in the migration — T005.)
- [ ] T003 Replace every `Memory.type` read with a `class` equivalent so the build compiles after the column drop: in `src/api/graphql/schema/resolvers.ts` (`type === 'AGENT_SYSTEM'` → `class === 'system'`; `type: { not: 'AGENT_SYSTEM' }` filters → `class: { not: 'system' }`; the `type: 'AGENT_SYSTEM'` writes → drop, rely on `class='system'`) and in `src/api/graphql/schema/typeDefs.ts` (remove `MemoryType` from the SDL + the `type` field + its doc-comment). First verify `type='AGENT_SYSTEM' ⇔ class='system'` holds in dev data.
- [ ] T004 Remove/repoint `'PERSONAL'` and `'PRIVATE'` visibility literals in code so nothing references the removed enum values: `src/api/graphql/schema/resolvers.ts` `createMemory` default (`visibility ?? 'PRIVATE'` → `ORGANIZATION` for knowledge / `null` for personal-private) and any remaining `visibility: 'PRIVATE'|'PERSONAL'` filters; grep the repo for the two literals and reconcile each.
- [ ] T005 Create `prisma/migrations/<ts>_memory_class_access/migration.sql` (hand-authored, ordered per data-model.md): (1) drop `Memory.type` + `MemoryType`; (2) `MemoryVisibility` value removal via **new enum type + column swap**, mapping `class IN (personal,private)` → `NULL`, `class=knowledge` `PRIVATE`→`ORGANIZATION`, `group`→`GROUP`; (3) make `organization_id`, `visibility` nullable. Add a README/comment header explaining intent (constitution II).
- [ ] T006 Re-key the CHECK constraints in **all sync locations** (`prisma/post-push.sql`, the new migration, `src/test/globalSetup.ts`, and any test-lifecycle hook — see the inline-constraint-sync gotcha): replace `chk_personal_visibility_user` with `chk_memory_personal_owner` (`class=personal ⇒ user_id NOT NULL`); add `chk_memory_private_owner` (`class=private ⇒ user_id NOT NULL`); add `chk_memory_visibility_class` (`visibility NOT NULL` only for `class IN (knowledge,group)`); relax `chk_memory_class_app_id` to `class=app ⇒ app_id NOT NULL`; keep `chk_memory_group_visibility`.
- [ ] T007 [P] Add `src/test/integration/034-constraints.test.ts` (constitution S5): assert each new/changed CHECK exists and rejects a violating row (personal/private with NULL `userId`; non-knowledge/group with non-NULL `visibility`; `app` with NULL `app_id`; and that `personal`/`private` with NULL `app_id` is **accepted**).
- [ ] T008 Update `prisma/seed.ts` fixtures that set `Memory.type` or `visibility = PERSONAL|PRIVATE`; re-seed dev (`pnpm db:dev-reset` is human-run) and confirm `prisma/post-push.sql` re-applies cleanly.

**Checkpoint:** schema migrated, build + `tsc` green, constraints enforced. Stories can start.

## Phase 3: User Story 1 — a user owns an owner-only memory, anywhere (P1) 🎯 MVP

**Goal:** create + use a `private`/`personal` memory (incl. free-standing, no app), owner-only, no ADMIN/OWNER bypass.
**Independent test:** quickstart §1 — owner r/w; peer/org-ADMIN/platform-OWNER denied on every surface.

- [ ] T009 [US1] In `src/lib/auth/resolveMemoryAuthorization.ts`: reshape the `personal`/`private` branch — direct owner call (Step 3a) is **allow iff `callerUserId === Memory.userId`** with no agent/license gate; drop the `userMemoryOfAgentId`-non-null requirement. ⚠️ **Move the `AgentSubscription` license check from the up-front Step 1 into the agent-on-behalf branch (Step 3b)** — it MUST still gate *agent-mediated* access, or an installed agent could read/write a user's `personal`/`private` memory without the user holding an active subscription (licensing/security bypass). Keep the optional agent-on-behalf branch (when the agent context matches) and `MemoryShare(personal)`; `private` stays non-shareable.
- [ ] T010 [US1] In `src/mcp/access-control.ts`: bring `canReadMemory`/`canWriteToMemory` to parity — free-standing (`app_id NULL`) `personal`/`private` resolve owner-only with no agent/subscription gate; owner = `Memory.userId`, never `createdBy`.
- [ ] T011 [US1] In `src/api/graphql/schema/typeDefs.ts`: extend the `createMemory` mutation args to accept `class ∈ {knowledge, group, personal, private}`, optional `appId`, **make `orgId` optional (`orgId: ID!` → `orgId: ID`)** (free-standing memories have no org), and `encrypted`; update doc-comments (no raw backticks — constitution S3).
- [ ] T012 [US1] In `src/api/graphql/schema/resolvers.ts` `createMemory`: accept `personal`/`private`; set `userId = caller`; force `visibility = NULL`; allow free-standing (`app_id` NULL) and `(app, user)` (`app_id` set); **for `personal`/`private` with no `orgId`, skip org resolution + `requireOrgRole` and set `organizationId = null`** (`knowledge`/`group` still require an org); `encrypted=true` only for `private`; **typed rejections** (S2) for: app-key caller (no `userId`), `visibility` passed for personal/private, `encrypted` on non-private.
- [ ] T013 [US1] In `src/api/graphql/schema/resolvers.ts`: ensure the read/write surfaces honor class owner-only for `personal`/`private` with no ADMIN/OWNER bypass and no `createdBy` use — `getAccessibleMemoryIds`, `Query.memory(id)`, `Query.myMemories`, `Organization.memories`, and `requireMemoryWriteAccess`.
- [ ] T014 [US1] Verify/raise a **typed rejection** when `MemoryShare` create targets a `class=private` memory (in the `MemoryShare` create path / resolver).
- [ ] T015 [P] [US1] Add `src/test/integration/034-owner-only-memory.test.ts`: createMemory `private` & `personal`, free-standing and in-app; owner (an org READER, and a user with no org) can r/w; peer member, org ADMIN, and platform OWNER are denied on read/write/list/open/search.
- [ ] T016 [P] [US1] Add `src/test/integration/034-memoryshare-personal.test.ts`: `MemoryShare(writer)` grants r/w on a `personal` memory and revoke (row delete) removes it immediately; `MemoryShare` on a `private` memory is rejected.

**Checkpoint:** US1 independently shippable — the original incident is fixed.

## Phase 4: User Story 2 — class governs access; knowledge stays org-shared (P1, no regression)

**Goal:** `knowledge` read per `visibility` (ORG / PUBLIC-unauth), `app` members r/w, `system` members read-only — unchanged for existing data.
**Independent test:** quickstart §3 — `accessControl` suite green; PUBLIC knowledge readable unauthenticated.

- [ ] T017 [US2] In `src/api/graphql/schema/resolvers.ts` + `src/mcp/access-control.ts`: confirm `knowledge` read resolves `ORGANIZATION` → org members and `PUBLIC` → any caller incl. unauthenticated; `app` → app-member r/w; `system` → app-member read, builder write. Adjust only where the pruned visibility enum changed a code path.
- [ ] T018 [P] [US2] Add `src/test/integration/034-class-access.test.ts`: `knowledge` `ORGANIZATION` (org-only) vs `PUBLIC` (unauthenticated read); `app` member r/w; `system` member read-but-not-write. Confirm `resolvers.accessControl.test.ts` stays green.

## Phase 5: User Story 3 — visibility/type cleanup verified (P2)

**Goal:** prove the Phase-2 schema cleanup holds end-to-end.
**Independent test:** quickstart §4 — `MemoryVisibility` = `{PUBLIC,ORGANIZATION,GROUP}`, NULL for non-knowledge/group; `Memory.type` gone; system handling class-derived.

- [ ] T019 [P] [US3] Add `src/test/integration/034-visibility-type-cleanup.test.ts`: assert visibility is NULL for `system/app/personal/private`, set only for `knowledge`/`group`; `Memory.type` no longer selectable; system-memory listing/handling unchanged (parity with pre-change behavior).
- [ ] T020 [US3] Repo-wide grep for residual `AGENT_SYSTEM`, `'PERSONAL'`, `'PRIVATE'` references (`src/`, `prisma/`) and reconcile any stragglers (tests, seed, helpers) to class-based / pruned-enum forms.

## Phase 6: Polish & cross-cutting

- [ ] T021 [P] Document the canonical **class → access** rule in the platform-specs corpus (`access-control:memory` node) so the doc matches enforcement (constitution II; the discussion's "matrix → docs" intent, minus groups).
- [ ] T022 [P] Update the GraphQL doc-comments in `typeDefs.ts` for the changed `MemoryVisibility` / removed `MemoryType` / `createMemory` (co-canonical surface, constitution II).
- [ ] T023 Run full `pnpm test` + `pnpm tsc --noEmit`; confirm SC-001…006 are exercised and green.

---

## Dependencies

- **Phase 1 → Phase 2 → (Phase 3 = MVP) → Phase 4 → Phase 5 → Phase 6.**
- Phase 2 (schema/migration/constraints + keep-green edits) **blocks everything** — a column can't be dropped while code reads it.
- Within Phase 2: T002 (schema) → T003/T004 (keep-green code) → T005/T006 (migration + CHECKs) → T007/T008 (tests + seed). T003 and T004 touch the same files (`resolvers.ts`, `typeDefs.ts`) → **not** parallel with each other.
- US1 (Phase 3) is the MVP and is independently shippable once Phase 2 is done.
- US2/US3 are mostly verification on top of Phase 2 + US1.

## Parallel execution examples

- **Phase 2:** T007 (constraints test) ∥ T008 (seed) after T006.
- **Phase 3:** T015 ∥ T016 (separate new test files) after T009–T014.
- **Phase 4/5:** T018 ∥ T019 (separate new test files).
- **Phase 6:** T021 ∥ T022 (docs).

## Implementation strategy

- **MVP = Phase 2 + Phase 3 (US1).** That ships the user-owned, owner-only memory (the original incident fix) on the cleaned-up schema. US2 (no-regression proof) and US3/Polish (cleanup verification + docs) follow.
- Land the predicate reshape (T009/T010) behind the existing access-control layer only — no resolver bypass (constitution V).
- Every access-control mutation gets its integration test (Principle I): T015, T016, T018 (+ the constraint test T007).
