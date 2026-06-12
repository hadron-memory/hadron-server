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
    name: "fast"
    provider: "anthropic"
    model: "claude-haiku-4-5-20251001"
    apiKey: "sk-ant-..."
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

## Consumer convention (US4)

Consumers (future `AgentWebhook.aiConfigName`, scheduled tasks, curation jobs,
the portal chatbot) carry an optional config **name** only — never credentials
or provider details. At execution time, resolve via `resolveAIConfig(name,
appId, agentId)` (GraphQL) or `resolveAiConfigWithFallback` (`src/lib/aiConfig.ts`):
explicit name → miss falls back to `default` → miss throws
`NoAiConfigAvailableError`. Conventional names: `default` (reserved fallback),
`fast`, `frontier` (documented, not enforced).

## After deploying (manual step)

Stored AI configurations were deliberately dropped by the migration (confirmed
disposable, 2026-06-11) — re-enter keys via the portal's existing AI-config UIs
(which hit the legacy operations, now registry-backed) or via
`createAiServiceConfig`. Until then every surface reports "not configured"
without errors.

## What did NOT change

- hadron-portal works unmodified: `agentAIConfig`, `appAIConfig`,
  `updateAgentAIConfig`, `clearAgentAIConfig`, and `hasAiApiKey` keep their
  shapes/auth — they now read/write the registry under the hood.
- Removal of those legacy GraphQL operations is the follow-up, gated on the
  portal moving to the new surface.
