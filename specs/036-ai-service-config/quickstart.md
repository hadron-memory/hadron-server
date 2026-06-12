# Quickstart: AI Service Config Registry (036)

## Try it locally (after implementation)

```bash
# 1. Push schema + re-apply constraints to dev DB
DATABASE_URL='postgresql://holger@localhost:5432/hadron_dev' pnpm prisma db push
psql postgresql://holger@localhost:5432/hadron_dev -v ON_ERROR_STOP=1 -f prisma/post-push.sql

# 2. Re-seed (seed adds demo configs on the Mealplan/Juno fixtures)
DATABASE_URL='postgresql://holger@localhost:5432/hadron_dev' pnpm tsx prisma/seed.ts

# 3. Run the feature tests
pnpm vitest run src/test/integration/036-ai-service-config.test.ts src/lib/aiConfig.test.ts

# 4. Full gate
pnpm test && pnpm tsc --noEmit
```

## Smoke via GraphQL (org-admin JWT)

```graphql
mutation {
  createAiServiceConfig(
    ownerType: ORGANIZATION
    ownerId: "<orgId>"
    input: { name: "fast", provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: "sk-ant-..." }
  ) { id name hasApiKey apiKeyPreview }   # preview only — never the key
}

query {
  resolveAIConfig(name: "fast", appId: "<appId>") {
    ownerType provider model apiKey       # decrypted — org-ADMIN-gated
  }
}
```

Expected: with no App/Agent `fast` config, resolution lands on the org level
(`ownerType: ORGANIZATION`). Add an App-owned `fast` config and re-run — the App wins.

## Verify migration backfill equivalence (SC-002)

```bash
# Pre-deploy sanity on a prod-like dump: every populated legacy column-set
# must have a matching 'default' registry row after `prisma migrate deploy`.
psql "$DATABASE_URL" -c "
  SELECT count(*) FROM agents a
  WHERE a.ai_provider IS NOT NULL AND a.ai_model IS NOT NULL AND a.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM ai_service_configs c
                    WHERE c.agent_id = a.id AND c.name = 'default');"
# expected: 0   (and the app-side twin of this query: 0)
```

## What did NOT change

- hadron-portal works unmodified: `agentAIConfig`, `appAIConfig`,
  `updateAgentAIConfig`, `clearAgentAIConfig`, and `hasAiApiKey` keep their
  shapes/auth — they now read/write the registry under the hood.
- Legacy `ai_*` columns still exist (frozen). Dropping them is the follow-up spec,
  gated on the portal moving to the new surface.
