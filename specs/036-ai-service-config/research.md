# Research: AI Service Config Registry (036)

No NEEDS CLARIFICATION markers remained in the spec; the design was settled in the
2026-06-11 discussion building on the 2026-05-03 ai-config and 2026-05-02 webhook
design discussions. This file records the decisions and the codebase facts they rest on.

## D1 — Reuse `HadronServer` as the host-level owner

**Decision**: No new `HadronHost` entity; `HadronServer` (schema.prisma:1370) is the
outermost config owner. The Baragaun SaaS host is the row with `organizationId = NULL`.
**Rationale**: An entity meaning "this deployment" already exists; a second one would rot.
**Alternatives**: New `HadronHost` entity (rejected — duplicate concept); global configs
with all-NULL owner (rejected — breaks the exactly-one-owner invariant and FK integrity).

## D2 — Precedence: App → Agent → Org(App's) → HadronServer

**Decision**: Install-time overrides design-time. The Organization consulted is the
App's org (the installation's org), never the Agent builder's org. In contexts without
an App (portal agent chat pre-install, curation jobs), absent levels are skipped — an
agent-only context walks Agent → Agent's org → Host; a platform job walks Host only.
**Rationale**: Matches shipped semantics — `App.aiProvider` is documented as the
deploy-time *override* of the Agent's default (schema.prisma:1156–1160, 1756–1760), and
`agentChatTurn` resolution honors it. The operator deploying a third-party Agent supplies
their own key; cost ownership follows the installation.
**Alternatives**: Agent-over-App (the original proposal — rejected as a silent behavior
change to live installations); Agent's-org in the walk (rejected — leaks the builder's
org key into other orgs' installations).

## D3 — Single entity, not the config/detail split

**Decision**: One row = one (name, provider, model, key, params) tuple. The
2026-05-03 two-entity split (`AiServiceConfig` + `AiServiceConfigDetail` sharing keys)
is collapsed for v1.
**Rationale**: Bias for speed; one CRUD surface, no join. Re-normalizing later is
additive if key rotation across many configs becomes painful.

## D4 — Consumers reference by name only

**Decision**: Configs are owned at 4 levels; consumers (future `AgentWebhook.aiConfigName`,
chat sessions, curation, scheduled tasks) carry only an optional name. Explicit-name miss
falls back to `default`; `default` miss is a typed error (`NoAiConfigAvailableError`).
**Rationale**: Webhook design decision 5 (2026-05-02) already specifies exactly this.
Five owner levels would multiply management UI and rotation surface for no benefit.

## D5 — Exactly-one-owner via 4 nullable FKs + CHECK, not a discriminator pair

**Decision**: `hadron_server_id` / `organization_id` / `app_id` / `agent_id`, all
nullable with real FKs (`ON DELETE CASCADE`), plus
`CHECK (num_nonnulls(hadron_server_id, organization_id, app_id, agent_id) = 1)` named
`chk_ai_service_config_owner`.
**Rationale**: Real referential integrity + cascade deletes (FR-016), which a polymorphic
`ownerType`/`ownerId` pair cannot give in Postgres/Prisma. `num_nonnulls` is the idiomatic
exactly-one form. House rules apply: the constraint is synchronized across the migration,
`prisma/post-push.sql`, and `src/test/globalSetup.ts`; CHECK adds never use `IF NOT EXISTS`
(always `DROP CONSTRAINT IF EXISTS` then `ADD`); a regression test asserts presence.
**Alternatives**: discriminator pair (rejected — no FK integrity); 4 child tables
(rejected — quadruples surface area).

## D6 — Per-owner name uniqueness via partial unique indexes

**Decision**: Four partial unique indexes, e.g.
`CREATE UNIQUE INDEX ai_service_configs_agent_name_uniq ON ai_service_configs (agent_id, name) WHERE agent_id IS NOT NULL`
(and the server/org/app equivalents). Prisma cannot express these; they live in the
migration + `post-push.sql` (+ `globalSetup.ts`), same as the CHECKs. Resolver maps the
unique violation to `DuplicateAiServiceConfigNameError`. Per the upsert-not-race-safe
finding, create-paths treat P2002 as the duplicate-name error, not a retry.

## D7 — Key handling: encrypt with existing helpers; masked management, privileged resolution

**Decision**: `encryptToken`/`decryptToken` (AES-256-GCM, `HADRON_ENCRYPTION_KEY`) —
formerly private helpers in resolvers.ts, extracted to `src/lib/tokenCrypto.ts` by this
spec so the lib and resolver layer share one implementation; preview = `…` + last 4.
Management/list surfaces expose only `hasApiKey` + `apiKeyPreview`. A privileged
`resolveAIConfig` query returns the decrypted key — successor to `agentAIConfig` /
`appAIConfig`, which today return decrypted keys to org ADMINs because the **portal's
server-side LLM runtime** (`hadron-portal/src/lib/server/llm/agentChatTurn.ts`, and the
`/api/agent-chat/ai-config` test endpoint) executes the LLM calls. Auth: same gates as
those queries (org ADMIN of the context org, or platform ADMIN/OWNER).
**Codebase facts**: `agentAIConfig` (resolvers.ts:2520) requires org ADMIN;
`appAIConfig` (resolvers.ts:3201) requires org ADMIN or platform admin.

## D8 — Legacy surface becomes shims; columns dropped, no backfill

**Decision**: Single source of truth from day one. Existing stored AI configurations are
disposable (Holger, 2026-06-11: "None of the existing AI configuration need to survive.
We can manually fill them back in. Nothing in production depends on it."), so the
migration **drops** the `agents.ai_*` and `apps.ai_*` columns outright — no backfill, no
data-equivalence guarantee. Operators re-enter keys manually. Then:
- `agentAIConfig` / `appAIConfig` queries → read the registry (the entity's own `default`
  row; `appAIConfig` keeps returning only the App-level row, preserving its current
  single-entity contract).
- `updateAgentAIConfig` / `clearAgentAIConfig` (and the App equivalent mutation path) →
  upsert/delete the entity's `default` registry row.
- `Agent.hasAiApiKey` / `App.hasAiApiKey` field resolvers → derive from the registry.
**Rationale**: Shims keep the portal working without code changes (it sees "not
configured" until keys are re-entered); dropping the columns now removes the follow-up
column-cleanup spec entirely.
**Alternatives**: backfill + frozen columns (rejected — pure overhead once the data was
confirmed disposable); dual-write (rejected — skew risk).

## D9 — Provider registry + params validation

**Decision**: Known providers v1: `anthropic`, `openai`, `glm`, `bedrock` (the set the
portal agent surface offers — per the `llm-provider-config-surfaces` finding). Bedrock's
"key" is a JSON-encoded `{accessKeyId, secretAccessKey, region}` triple — stored opaque in
the encrypted key field, preserved as-is. `params Json?` holds provider-specific knobs
(maxTokens, thinking, effort, baseUrl, …) validated by a per-provider zod schema in
`src/lib/aiConfig.ts`; unknown provider → `UnknownAiProviderError` at write time (FR-012).
Params schemas are permissive (passthrough with typed well-known keys) so new provider
knobs don't require server releases.

## D10 — Cut-over verification strategy

**Decision**: No backfill to verify. The migration (prod path: `prisma migrate deploy`
on container start, per the prisma-deploy-flow ops node) creates the table and drops the
legacy columns. Verification is behavioral: integration tests exercise every legacy
GraphQL operation against the registry-backed implementation and assert unchanged shapes
+ auth (revised SC-002), including the "nothing configured yet" state a freshly-migrated
deployment is in.

## D11 — Resolution helper shape

**Decision**: `src/lib/aiConfig.ts` exports:
- `resolveAiConfig(db, { name, appId?, agentId?, organizationId? })` — explicit-name walk;
- `resolveDefaultAiConfig(db, ctx)` — same walk with `name = 'default'`;
- callers that need fallback semantics use `resolveAiConfigWithFallback` (named → default → typed error).
The walk computes the org level from the App when `appId` is present, else from the
Agent's `organizationId`. One query per level, first enabled hit wins (≤ 4 indexed point
reads). `default` and conventional names (`fast`, `frontier`) are documented in typeDefs
doc-comments, not enforced.
