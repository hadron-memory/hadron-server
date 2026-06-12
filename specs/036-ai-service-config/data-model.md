# Data Model: AI Service Config Registry (036)

## New model: `AiServiceConfig` → table `ai_service_configs`

```prisma
/// Named AI service configuration (spec 036). Owned by exactly one of
/// HadronServer / Organization / App / Agent (chk_ai_service_config_owner).
/// Resolved by name walking App -> Agent -> Org(of the App) -> HadronServer;
/// well-known fallback name: 'default'. Replaces the legacy Agent.ai_* /
/// App.ai_* columns, which the 036 migration drops outright (stored values
/// confirmed disposable 2026-06-11; re-entered manually).
model AiServiceConfig {
  id              String        @id @default(cuid())
  /// Lookup name, unique per owner (partial unique indexes). Conventional
  /// names: 'default' (resolution fallback), 'fast', 'frontier'.
  name            String
  // ── owner (exactly one non-null; real FKs, cascade on owner delete) ──
  hadronServerId  String?       @map("hadron_server_id")
  organizationId  String?       @map("organization_id")
  appId           String?       @map("app_id")
  agentId         String?       @map("agent_id")
  /// Provider identifier; v1 known: 'anthropic' | 'openai' | 'glm' | 'bedrock'.
  provider        String
  /// Model identifier, passed verbatim to the provider.
  model           String
  /// AES-256-GCM-encrypted API key (src/lib/crypto.ts encryptToken). For
  /// bedrock this is a JSON-encoded {accessKeyId, secretAccessKey, region}
  /// triple, stored opaque.
  apiKeyEncrypted String?       @map("api_key_encrypted")
  /// '…' + last 4 chars of the raw key for masked display.
  apiKeyPreview   String?       @map("api_key_preview")
  /// Provider-specific knobs (maxTokens, thinking, effort, baseUrl, ...).
  /// Validated per provider by zod in src/lib/aiConfig.ts.
  params          Json?
  /// Disabled configs are skipped by resolution (the walk continues outward).
  enabled         Boolean       @default(true)
  createdAt       DateTime      @default(now()) @map("created_at")
  createdBy       String?       @map("created_by")
  updatedAt       DateTime?     @updatedAt @map("updated_at")
  updatedBy       String?       @map("updated_by")

  hadronServer HadronServer? @relation(fields: [hadronServerId], references: [id], onDelete: Cascade)
  organization Organization? @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  app          App?          @relation(fields: [appId], references: [id], onDelete: Cascade)
  agent        Agent?        @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@index([hadronServerId])
  @@index([organizationId])
  @@index([appId])
  @@index([agentId])
  @@map("ai_service_configs")
}
```

Back-relations added on `HadronServer`, `Organization`, `App`, `Agent`:
`aiServiceConfigs AiServiceConfig[]`.

Notes:
- Has an `id` column → **no** `MODELS_WITHOUT_ID` change (constitution S4).
- Hard delete (no `deletedAt`): configs are operational settings, not user content;
  audit trail is `createdBy`/`updatedBy` + the usage-event layer if/when needed.
- No `visibility`/`payedBy` columns — deferred scope (spec Assumptions).

## Database constraints (migration + `post-push.sql` + `globalSetup.ts` — keep in sync, never `IF NOT EXISTS` on the CHECK)

```sql
-- 036-ai-service-config: a config belongs to exactly one owner.
ALTER TABLE ai_service_configs
  DROP CONSTRAINT IF EXISTS chk_ai_service_config_owner;
ALTER TABLE ai_service_configs
  ADD CONSTRAINT chk_ai_service_config_owner
  CHECK (num_nonnulls(hadron_server_id, organization_id, app_id, agent_id) = 1);

-- Per-owner name uniqueness (Prisma cannot express partial uniques).
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_server_name_uniq
  ON ai_service_configs (hadron_server_id, name) WHERE hadron_server_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_org_name_uniq
  ON ai_service_configs (organization_id, name) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_app_name_uniq
  ON ai_service_configs (app_id, name) WHERE app_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_agent_name_uniq
  ON ai_service_configs (agent_id, name) WHERE agent_id IS NOT NULL;
```

## Legacy column drop (in the same migration, after table + constraints)

```sql
-- 036: legacy per-Agent / per-App AI settings do not survive (confirmed
-- disposable 2026-06-11). No backfill; operators re-enter configs manually.
ALTER TABLE agents
  DROP COLUMN IF EXISTS ai_provider,
  DROP COLUMN IF EXISTS ai_model,
  DROP COLUMN IF EXISTS ai_api_key_encrypted,
  DROP COLUMN IF EXISTS ai_api_key_preview;
ALTER TABLE apps
  DROP COLUMN IF EXISTS ai_provider,
  DROP COLUMN IF EXISTS ai_model,
  DROP COLUMN IF EXISTS ai_api_key_encrypted;
```

The Prisma model fields are removed from `Agent`/`App` in `schema.prisma` in the same
change, so `db push` databases (`hadron_dev`/`hadron_test`) converge on the same shape.

## Resolution semantics

Context: `{ name?, appId?, agentId?, organizationId? }`.

1. Effective org = App's `organizationId` when `appId` present, else `organizationId`
   arg, else Agent's `organizationId`.
2. Walk levels in order, skipping absent ones: **App → Agent → Org → HadronServer**
   (host row: the deployment's `HadronServer` row; SaaS = `organizationId IS NULL`).
3. At each level: `findFirst({ ownerFk, name, enabled: true })`. First hit wins.
4. `resolveAiConfigWithFallback`: explicit name miss → repeat walk with `'default'` →
   miss → `NoAiConfigAvailableError` (states name + context, never key material).
5. A resolved config with no `apiKeyEncrypted` is returned by resolution but execution
   paths treat it as unusable (typed config error naming config + owner level).

## Validation rules (application layer, `src/lib/aiConfig.ts`)

- `name`: non-empty, trimmed, max 64 chars, `[a-z0-9][a-z0-9-_]*` (case-insensitive
  match rejected at create — names are lower-case canonical).
- `provider`: must be in the provider registry (`anthropic` | `openai` | `glm` |
  `bedrock`) → else `UnknownAiProviderError`.
- `params`: per-provider zod schema, passthrough-permissive on unknown keys; type-checks
  well-known keys (`maxTokens` positive int, `baseUrl` http(s) URL, etc.).
- `apiKey` write semantics: omitted ⇒ keep stored key; empty string ⇒ clear; non-empty ⇒
  encrypt + recompute preview. (Matches the existing `updateAgentAIConfig` semantics.)

## State transitions

`enabled` toggling is the only state machine: `enabled=false` removes the row from
resolution without deleting credentials. Delete is hard and immediate; owner-entity
delete cascades.

## Legacy surface (transition state)

| Surface | After this feature |
|---|---|
| `agents.ai_*` / `apps.ai_*` columns | **Dropped** by the 036 migration (no backfill) |
| `agentAIConfig` / `appAIConfig` / `updateAgentAIConfig` / `clearAgentAIConfig` / `hasAiApiKey` + AI field reads | Keep shapes/auth, registry-backed (the entity's `default` row); removal is a follow-up gated on portal migration |
