# GraphQL Contract: AI Service Config Registry (036)

All additions to `src/api/graphql/schema/typeDefs.ts` (single template literal — no raw
backticks in doc-comments, S3). Doc-comments below are normative for the PR.

## Types

```graphql
enum AiConfigOwnerType {
  HADRON_SERVER
  ORGANIZATION
  APP
  AGENT
}

# Masked management view. Never carries key material beyond the preview.
type AiServiceConfig {
  id: ID!
  name: String!
  ownerType: AiConfigOwnerType!
  # ID of the owning HadronServer / Organization / App / Agent.
  ownerId: ID!
  provider: String!
  model: String!
  hasApiKey: Boolean!
  # '…' + last 4 characters of the stored key; null when no key.
  apiKeyPreview: String
  params: JSON
  enabled: Boolean!
  createdAt: DateTime!
  updatedAt: DateTime
}

# Privileged resolution result (decrypted) — successor to AgentAIConfig /
# AppAIConfig. Only returned by resolveAIConfig (see auth below).
type ResolvedAiConfig {
  configId: ID!
  name: String!
  # Which level matched: APP | AGENT | ORGANIZATION | HADRON_SERVER.
  ownerType: AiConfigOwnerType!
  provider: String!
  model: String!
  # Decrypted key. For provider 'bedrock' this is the JSON-encoded
  # {accessKeyId, secretAccessKey, region} triple.
  apiKey: String!
  params: JSON
}
```

## Queries

```graphql
# Masked list of configs owned by one entity. Auth: admin rights on the owner
# (platform ADMIN/OWNER for HADRON_SERVER; org ADMIN for ORGANIZATION and for
# the org of an APP/AGENT owner).
aiServiceConfigs(ownerType: AiConfigOwnerType!, ownerId: ID!): [AiServiceConfig!]!

# Privileged: resolve a config name for an execution context and return the
# DECRYPTED credentials. Walk: App -> Agent -> Org(of the App, else of the
# Agent) -> HadronServer; disabled configs are skipped. When name is omitted,
# 'default' is resolved. When an explicit name misses, falls back to 'default';
# if that also misses, errors with NoAiConfigAvailableError.
# Auth: org ADMIN of the effective context org, or platform ADMIN/OWNER —
# the same gate as the legacy agentAIConfig/appAIConfig queries it succeeds.
# appId/agentId accept ID or URN (007-entity-id-or-urn).
resolveAIConfig(name: String, appId: ID, agentId: ID): ResolvedAiConfig!
```

## Mutations

```graphql
input AiServiceConfigInput {
  name: String!
  provider: String!
  model: String!
  # Omitted = keep stored key (update) / no key (create). Empty string = clear.
  apiKey: String
  params: JSON
  enabled: Boolean
}

# Auth for all three: admin rights on the owning entity (as aiServiceConfigs).
createAiServiceConfig(ownerType: AiConfigOwnerType!, ownerId: ID!, input: AiServiceConfigInput!): AiServiceConfig!
updateAiServiceConfig(id: ID!, input: AiServiceConfigUpdateInput!): AiServiceConfig!   # all input fields optional
deleteAiServiceConfig(id: ID!): Boolean!
```

## Typed errors (S2 — `extensions.code`)

| Code | When |
|---|---|
| `AiServiceConfigNotFoundError` | update/delete on unknown id, or caller lacks visibility |
| `DuplicateAiServiceConfigNameError` | create/update collides on (owner, name) — P2002 mapped, not retried |
| `UnknownAiProviderError` | provider not in registry, or params fail the provider schema |
| `NoAiConfigAvailableError` | resolution walk exhausted (explicit name AND 'default' missed) |

Existing auth errors (`Unauthenticated`, org-role denials) follow current patterns.

## Legacy surface — kept, re-pointed at the registry (no portal change required)

| Operation | New behavior |
|---|---|
| `agentAIConfig(agentId)` | Returns the Agent-owned `default` registry row (decrypted), same shape/auth as today; null when none |
| `appAIConfig(appId)` | Returns the App-owned `default` registry row (decrypted); null when none — keeps its single-entity contract (no walk) |
| `updateAgentAIConfig(agentId, provider, model, apiKey)` | Upserts the Agent's `default` registry row; legacy columns no longer written |
| `clearAgentAIConfig(agentId)` | Deletes the Agent's `default` registry row |
| `Agent.hasAiApiKey` / `App.hasAiApiKey` (and `aiProvider`/`aiModel`/`aiApiKeyPreview` field reads) | Field resolvers derive from the entity's `default` registry row |

Deprecation: legacy operations get a doc-comment note pointing at the new surface
(`@deprecated` directives on fields where the schema already uses them); removal is the
follow-up spec gated on portal migration.
