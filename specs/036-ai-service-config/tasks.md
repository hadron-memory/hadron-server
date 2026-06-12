# Tasks: AI Service Config Registry

**Input**: Design documents from `/specs/036-ai-service-config/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/graphql.md](contracts/graphql.md)

**Tests**: Included — the server constitution (Refinement I) mandates integration tests
for every GraphQL mutation/query touching access control, against real Postgres.

## Phase 1: Setup (schema + constraints)

- [x] T001 Add `AiServiceConfig` model + back-relations (`aiServiceConfigs AiServiceConfig[]` on `HadronServer`, `Organization`, `App`, `Agent`) to `prisma/schema.prisma` per data-model.md, then run `pnpm prisma generate`
- [x] T002 Hand-write `prisma/migrations/20260611120000_ai_service_config/migration.sql`: header comment (migration intent incl. deliberate no-backfill data drop, Constitution II), CREATE TABLE, `chk_ai_service_config_owner` CHECK (`num_nonnulls(...) = 1`), 4 partial unique indexes, 4 FK indexes, DROP of `agents.ai_provider/ai_model/ai_api_key_encrypted/ai_api_key_preview` and `apps.ai_provider/ai_model/ai_api_key_encrypted`; remove the corresponding fields from `Agent`/`App` in `prisma/schema.prisma` (part of T001's schema edit)
- [x] T003 [P] Append the CHECK + partial unique indexes to `prisma/post-push.sql` (036 section; `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` for the CHECK — never `IF NOT EXISTS` on a CHECK)
- [x] T004 [P] Add the same constraint DDL to `src/test/globalSetup.ts` (4th sync point — migration, post-push.sql, globalSetup.ts must stay textually in sync)

**Checkpoint**: `pnpm prisma db push` against `hadron_test` + post-push DDL applies cleanly.

## Phase 2: Foundational (blocking all user stories)

- [x] T005 Add typed errors `AiServiceConfigNotFoundError`, `DuplicateAiServiceConfigNameError`, `UnknownAiProviderError`, `NoAiConfigAvailableError` following the pattern in `src/lib/entityRef/errors.ts` (S2; stable `extensions.code`)
- [x] T006 Create `src/lib/aiConfig.ts`: provider registry (`anthropic`/`openai`/`glm`/`bedrock`), per-provider zod params schemas (passthrough-permissive, typed well-known keys), name validation (`[a-z0-9][a-z0-9-_]*`, max 64), key preview helper (`…` + last 4), apiKey write semantics (omit=keep, empty=clear, value=encrypt via `src/lib/tokenCrypto.ts`)
- [x] T007 Implement the resolution walk in `src/lib/aiConfig.ts`: `resolveAiConfig(db, {name, appId?, agentId?, organizationId?})` (App → Agent → Org-of-App-else-Agent → HadronServer, skip absent levels, `enabled: true` only), `resolveDefaultAiConfig`, `resolveAiConfigWithFallback` (named → 'default' → `NoAiConfigAvailableError`)
- [x] T008 [P] Unit tests in `src/lib/aiConfig.test.ts`: provider/params validation, name rules, preview, walk ordering incl. absent-level skipping and disabled-skip
- [x] T009 [P] Constraint regression test (S5) in `src/test/integration/036-ai-service-config.test.ts`: assert `chk_ai_service_config_owner` exists; INSERT with zero owners and with two owners both rejected; duplicate (owner, name) rejected by partial unique

**Checkpoint**: lib + DB invariants proven; GraphQL work can start.

## Phase 3: User Story 1 — resolution core (P1) 🎯 MVP

**Goal**: Named configs at four levels, resolved App → Agent → Org → Host, `default` fallback.
**Independent test**: Seed configs at multiple levels (raw Prisma in test), query `resolveAIConfig`, verify precedence/fallback/error matrix.

- [x] T010 [US1] Add `AiConfigOwnerType` enum, `ResolvedAiConfig` type, and `resolveAIConfig(name, appId, agentId)` query to `src/api/graphql/schema/typeDefs.ts` with doc-comments per contracts/graphql.md (no raw backticks — S3)
- [x] T011 [US1] Implement `resolveAIConfig` resolver in `src/api/graphql/schema/resolvers.ts`: ID-or-URN refs via `resolveAppRef`/`resolveAgentRef` (007 pattern), effective-org computation, auth = org ADMIN of effective org or platform ADMIN/OWNER (mirrors `agentAIConfig`/`appAIConfig` gates), decrypt key, map walk-miss to `NoAiConfigAvailableError`
- [x] T012 [US1] Integration tests in `src/test/integration/036-ai-service-config.test.ts`: precedence matrix (App>Agent>Org>Host; disabled skipped; absent levels skipped), explicit-name → default fallback, default-miss error, auth denials (non-admin, wrong org), agent-only context uses Agent's org, App context uses App's org (Juno two-install fixture shape)

**Checkpoint**: US1 fully functional — MVP. Resolution demonstrable with seeded data.

## Phase 4: User Story 2 — CRUD with masked secrets (P2)

**Goal**: Manage configs per owner; keys write-only on management surfaces.
**Independent test**: Create/list/update/delete via GraphQL; assert masked exposure and key-preserve-on-update.

- [x] T013 [US2] Add `AiServiceConfig` type, `AiServiceConfigInput`/`AiServiceConfigUpdateInput`, `aiServiceConfigs` query, `createAiServiceConfig`/`updateAiServiceConfig`/`deleteAiServiceConfig` mutations to `src/api/graphql/schema/typeDefs.ts` per contracts/graphql.md
- [x] T014 [US2] Implement CRUD resolvers in `src/api/graphql/schema/resolvers.ts`: per-owner-level auth (platform admin for HADRON_SERVER; org ADMIN for ORGANIZATION / App's org / Agent's org), provider+params validation via `src/lib/aiConfig.ts`, P2002 → `DuplicateAiServiceConfigNameError` (no retry — upsert-not-race-safe finding), apiKey omit/empty/value semantics, masked output mapping (`hasApiKey`, `apiKeyPreview`, never key material)
- [x] T015 [US2] Integration tests in `src/test/integration/036-ai-service-config.test.ts`: full CRUD per owner level, duplicate-name rejection, update-without-key preserves stored key (resolve afterwards and verify decrypted key unchanged), masked-only assertion on every management response (SC-003), auth matrix incl. platform-admin-only host configs

**Checkpoint**: Portal-ready management surface; US1 + US2 = usable registry.

## Phase 5: User Story 3 — legacy cut-over + shims (P2)

**Goal**: Legacy columns dropped (no backfill — data confirmed disposable); legacy API operations keep shapes/auth over the registry.
**Independent test**: With columns gone, exercise every legacy GraphQL operation end-to-end against the registry-backed implementation, including the freshly-migrated "nothing configured" state.

- [x] T016 [US3] Re-point legacy surface in `src/api/graphql/schema/resolvers.ts`: `agentAIConfig`/`appAIConfig` read the entity's `'default'` registry row (same shape + auth, no walk); `updateAgentAIConfig` upserts / `clearAgentAIConfig` deletes that row; `Agent.hasAiApiKey`/`App.hasAiApiKey` + `aiProvider`/`aiModel`/`aiApiKeyPreview` field resolvers derive from the registry (columns no longer exist); add deprecation doc-comments in `src/api/graphql/schema/typeDefs.ts` pointing at the new surface
- [x] T017 [US3] Update existing tests that exercise the legacy columns/paths (`src/api/graphql/schema/resolvers.agentChat.test.ts`, `src/test/integration/008-build-install-run.test.ts`, `src/integrations/db/app-schema-phase1.test.ts`) to the registry-backed behavior; keep assertions on response *shape* unchanged (that is the SC-002 regression guard)
- [x] T018 [US3] Shim integration tests in `src/test/integration/036-ai-service-config.test.ts`: `updateAgentAIConfig` creates/updates the registry row; `clearAgentAIConfig` deletes it; `agentAIConfig`/`appAIConfig` return decrypted `'default'` row with legacy auth gates and return null cleanly when nothing is configured (fresh-migration state); App-overrides-Agent precedence preserved end-to-end through `resolveAIConfig`

**Checkpoint**: Deploy-safe — portal unchanged against an initially-empty registry; keys re-entered manually post-deploy.

## Phase 6: User Story 4 — name-referenced consumers (P3)

**Goal**: Consumers select cost/model behavior by name only.
**Independent test**: `resolveAiConfigWithFallback` behavior via the lib + GraphQL query (name-hit, name-miss→default, default-miss→typed error).

- [x] T019 [US4] Integration tests in `src/test/integration/036-ai-service-config.test.ts` covering the consumer contract through `resolveAIConfig`: explicit `fast` hit uses `fast`; `fast` missing falls back to `default`; neither → `NoAiConfigAvailableError` with name + context (and no key material) in the message
- [x] T020 [US4] Document the consumer convention (name-only reference, conventional names `default`/`fast`/`frontier`, future `AgentWebhook.aiConfigName`) in the `resolveAIConfig` doc-comment in `src/api/graphql/schema/typeDefs.ts` and a short section in `specs/036-ai-service-config/quickstart.md`

**Checkpoint**: Contract ready for the headless-runner/webhook spec to consume.

## Phase 7: Polish & cross-cutting

- [x] T021 [P] Seed demo configs in `prisma/seed.ts` (org-level `default` on Acme; agent-level `fast` on Juno) so portal sessions can demo resolution without setup
- [x] T022 [P] Doc-comment + contract review pass: every new/changed type, field, arg in `src/api/graphql/schema/typeDefs.ts` documented (Constitution II); migration header complete
- [x] T023 Full gate: `pnpm test` and `pnpm tsc --noEmit` green; run quickstart.md smoke against `hadron_dev`
- [x] T024 Record the pattern in the Hadron dev graph (CLI: `hadron node add`): a `findings:`/`conventions:` node for the AI-config registry + resolution order, and a symptom trigger in `urn:node:hadronmemory.com::dev::start-here` (supersedes the `llm-provider-config-surfaces` routing for server-side config); note the portal follow-up (config UIs + `/api/agent-chat/ai-config` → new surface)

## Dependencies

- Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US2) → Phase 5 (US3) → Phase 6 (US4) → Phase 7
- US2 depends on US1 only for shared typeDefs scaffolding (T010); could run parallel after T010 if needed
- US3 depends on US1 (resolution) but not US2
- US4 is test/documentation work over Phase 2's `resolveAiConfigWithFallback`

## Parallel opportunities

- T003 + T004 (different files) after T002
- T008 + T009 after T007
- T021 + T022 during polish
- Within stories, typeDefs and resolver tasks are sequential (same two files dominate — `typeDefs.ts`, `resolvers.ts` — so most GraphQL tasks are deliberately not [P])

## Implementation strategy

MVP = Phases 1–3 (US1): registry table + resolution query, demonstrable with seeded
data. Ship-gate = through Phase 5 (US3): the column drop and the shims must land
together (the schema change breaks the old resolvers), so Phases 1–5 belong in one PR
(bundle-PRs working agreement). Phases 6–7 can ride along or follow immediately.
Post-deploy manual step: re-enter AI keys (stored configs deliberately dropped).
