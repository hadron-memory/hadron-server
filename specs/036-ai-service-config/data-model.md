# Data Model: AI Service Config Registry (036)

## New model: `AiServiceConfig` → table `ai_service_configs`

```prisma
/// Named AI service configuration (spec 036). Owned by exactly one of
/// HadronServer / Organization / App / Agent (chk_ai_service_config_owner).
/// Resolved by name walking App -> Agent -> Org(of the App) -> HadronServer;
/// well-known fallback name: 'default'. Supersedes the legacy Agent.ai_* /
/// App.ai_* columns (backfilled as 'default' rows; columns frozen, removal
/// is a follow-up spec).
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

## Backfill (in the same migration, after table + constraints)

```sql
-- Backfill legacy per-Agent / per-App AI settings as 'default' configs.
-- Encrypted blobs copy verbatim (same HADRON_ENCRYPTION_KEY; no re-encryption).
-- Idempotent: ON CONFLICT against the partial uniques.
INSERT INTO ai_service_configs
  (id, name, agent_id, provider, model, api_key_encrypted, api_key_preview, enabled, created_at)
SELECT 'aisc_' || md5(random()::text || id), 'default', id, ai_provider, ai_model,
       ai_api_key_encrypted, ai_api_key_preview, true, now()
FROM agents
WHERE ai_provider IS NOT NULL AND ai_model IS NOT NULL AND deleted_at IS NULL
ON CONFLICT (agent_id, name) WHERE agent_id IS NOT NULL DO NOTHING;
-- (App equivalent mirrors this with app_id / apps.)
```

*(Exact id-generation in the final SQL follows whatever the latest hand-written
migration uses for app-layer-style ids in SQL; if none exists, `gen_random_uuid()`-based
text is acceptable — ids are opaque cuid-like strings, not validated by shape.)*

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

## Legacy columns (transition state)

| Column set | After this feature |
|---|---|
| `agents.ai_provider/ai_model/ai_api_key_encrypted/ai_api_key_preview` | Backfilled, frozen (no writes), still readable by old code paths; dropped in follow-up spec |
| `apps.ai_provider/ai_model/ai_api_key_encrypted` | Same (note: `apps` has no preview column today — backfill leaves `api_key_preview` NULL for App rows) |
