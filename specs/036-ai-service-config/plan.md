# Implementation Plan: AI Service Config Registry

**Branch**: `036-ai-service-config` | **Date**: 2026-06-11 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/036-ai-service-config/spec.md`

## Summary

Introduce one new table, `AiServiceConfig` — named AI configurations (provider, model,
encrypted key, params JSON, enabled) owned by exactly one of HadronServer / Organization /
App / Agent — plus a resolution helper that walks **App → Agent → Org-of-the-App →
HadronServer** and returns the first enabled config matching a name (well-known fallback
name: `default`). The existing `agentAIConfig`/`appAIConfig` queries and
`updateAgentAIConfig`/`clearAgentAIConfig` mutations become shims over the registry so
hadron-portal keeps working unchanged across the deploy; legacy `ai_*` columns are
backfilled into `default`-named rows in the migration and frozen (removal is a follow-up
spec gated on portal migration).

## Technical Context

**Language/Version**: TypeScript (strict) on Node.js ≥ 22 (constitution S1)
**Primary Dependencies**: Prisma + PostgreSQL, GraphQL via `src/api/graphql/`, zod for input validation
**Storage**: PostgreSQL — new `ai_service_configs` table; CHECK + partial unique indexes in hand-written migration + `prisma/post-push.sql` + `src/test/globalSetup.ts` (S5)
**Testing**: Vitest against `hadron_test` (integration tests in `src/test/integration/`, unit tests next to `src/lib/aiConfig.ts`)
**Target Platform**: hadron-server (the portal/UI follow-up is a separate hadron-portal change)
**Project Type**: web service (GraphQL API + Prisma)
**Performance Goals**: resolution is ≤ 4 indexed point lookups per session start; no measurable session-start regression
**Constraints**: zero behavioral regression for live installations (Micromentor); legacy GraphQL fields keep working; keys never plaintext on management surfaces
**Scale/Scope**: one new model, ~6 new GraphQL operations + 4 legacy shims, one migration with backfill, one resolution lib module

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Gate | Status | How the plan satisfies it |
|---|---|---|
| I — Pragmatic test-first: every mutation touching access control has an integration test against real Postgres | PASS | All new CRUD mutations + the privileged `resolveAIConfig` query get integration tests in `src/test/integration/036-ai-service-config.test.ts` (auth matrix, masked exposure, resolution precedence) |
| II — Docs-concurrent: typeDefs doc-comments in same PR; migration intent in migration header | PASS | New types/fields/args documented in `typeDefs.ts`; migration SQL carries a header comment explaining table + backfill |
| III / S2 — Typed errors only across the wire | PASS | New typed errors (`AiServiceConfigNotFoundError`, `DuplicateAiServiceConfigNameError`, `UnknownAiProviderError`, `NoAiConfigAvailableError`) join the `src/lib/entityRef/errors.ts` pattern; P2002 on create mapped to the duplicate-name error |
| V — Zero-trust: all reads/writes through access-control layer | PASS | CRUD + resolution gate via `requireOrgRole` / platform-admin checks per owner level; no App-supplied claims trusted |
| S3 — `typeDefs.ts` single template literal, no raw backticks in doc-comments | PASS | Doc-comments use single quotes |
| S4 — Composite-PK models registered in `MODELS_WITHOUT_ID` | N/A | `AiServiceConfig` has a cuid `id` |
| S5 — CHECK constraints in `post-push.sql` + regression test | PASS | `chk_ai_service_config_owner` (`num_nonnulls(...) = 1`) + 4 partial unique indexes added to migration, `post-push.sql`, `globalSetup.ts`; regression test asserts constraint presence and rejects bad rows. Per the inline-constraint-synchronization rule: no `IF NOT EXISTS` on CHECK adds — `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` |
| S6 — CI grep gates | N/A | No station/agent-specific code involved |

Post-design re-check: no violations introduced; Complexity Tracking left empty.

## Project Structure

### Documentation (this feature)

```text
specs/036-ai-service-config/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── graphql.md       # GraphQL surface contract
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
prisma/
├── schema.prisma                          # + model AiServiceConfig (+ back-relations on
│                                          #   HadronServer, Organization, App, Agent)
├── post-push.sql                          # + chk_ai_service_config_owner + 4 partial uniques
└── migrations/20260611120000_ai_service_config/
    └── migration.sql                      # CREATE TABLE + constraints + backfill INSERTs

src/
├── lib/
│   ├── aiConfig.ts                        # NEW — resolution walk, provider/params zod
│   │                                      #   validation, key preview helper
│   ├── aiConfig.test.ts                   # NEW — unit tests (validation, walk ordering)
│   └── entityRef/errors.ts                # + typed errors (or sibling module per pattern)
├── api/graphql/schema/
│   ├── typeDefs.ts                        # + AiServiceConfig type, queries, mutations;
│   │                                      #   legacy AIConfig types kept
│   └── resolvers.ts                       # + CRUD/resolve resolvers; legacy
│                                          #   agentAIConfig/appAIConfig/updateAgentAIConfig/
│                                          #   clearAgentAIConfig re-pointed at the registry
└── test/
    ├── globalSetup.ts                     # + constraint DDL (4th sync point)
    └── integration/036-ai-service-config.test.ts   # NEW

prisma/seed.ts                             # + a couple of demo configs (optional, portal demo)
```

**Structure Decision**: single-project hadron-server layout; all paths above are real
directories in this repo. Portal changes (config UIs, `/api/agent-chat/ai-config`
endpoint migration) are explicitly out of scope here and tracked for a hadron-portal
follow-up.

## Complexity Tracking

*No constitution violations — table intentionally left empty.*
