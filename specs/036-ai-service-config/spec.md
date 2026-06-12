# Feature Specification: AI Service Config Registry

**Feature Branch**: `036-ai-service-config`
**Created**: 2026-06-11
**Status**: Draft
**Input**: User description: "AI service config registry (AiServiceConfig) with CSS-like fallback resolution, replacing the ad-hoc per-Agent/per-App AI provider/model/key columns with a named-config registry owned at four levels (HadronServer, Organization, App, Agent), resolved innermost-out, referenced by name from consumers (webhooks, chat sessions, curation jobs, scheduled tasks)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator configures named AI configs and sessions resolve them (Priority: P1)

An org operator (or platform admin, or agent builder) defines one or more **named** AI service configurations — e.g. `default`, `fast`, `frontier` — at the level they control (Organization, App, Agent, or the platform host). When an agent session needs an LLM, the platform resolves the named configuration by walking from the most specific level outward: **App → Agent → Organization (of the installation) → Host**, returning the first enabled config with that name. Install-time configuration overrides design-time defaults: an operator who deploys a third-party Agent into their org can supply their own provider key at the App level, and it wins over the Agent builder's default.

**Why this priority**: This is the core of the feature — the registry plus deterministic resolution. Everything else (consumer references, migration, CRUD UI) builds on it. It is the prerequisite for headless LLM use and the portal chatbot.

**Independent Test**: Seed configs at multiple levels with the same name; ask the resolver for that name in an App session context; verify the App-level config wins, then delete/disable it and verify fallback proceeds Agent → Org → Host in order.

**Acceptance Scenarios**:

1. **Given** an App with a config named `default` and its Agent also has a config named `default`, **When** a session in that App resolves `default`, **Then** the App-level config is returned.
2. **Given** an App with no configs and an Agent with a config named `default`, **When** a session in that App resolves `default`, **Then** the Agent-level config is returned.
3. **Given** neither App nor Agent has a config named `fast` but the App's Organization does, **When** a session resolves `fast`, **Then** the Organization-level config is returned.
4. **Given** no level defines the requested name, **When** resolution runs, **Then** the resolver returns nothing and the caller receives a clear "no AI configuration available" error (no silent fallback to a different name).
5. **Given** a matching config exists at the App level but is disabled, **When** resolution runs, **Then** the disabled config is skipped and the walk continues outward.
6. **Given** no explicit name is requested, **When** a session needs an LLM, **Then** the well-known name `default` is resolved via the same walk.

---

### User Story 2 - CRUD management of configs with masked secrets (Priority: P2)

An authorized user manages (creates, lists, updates, deletes, enables/disables) the AI configs attached to an entity they administer. API keys are write-only: once stored, only a masked preview (last 4 characters) and a "has key" indicator are ever returned; the raw key is never readable through any API.

**Why this priority**: Without management surfaces, configs can only be seeded by hand. Required for the portal UI, but the resolution layer (P1) can be demonstrated with seeded data first.

**Independent Test**: Through the API, create a config on an Agent with a key, list it back, and verify only the masked preview is exposed; update the model without resending the key and verify the stored key survives; delete it and verify resolution no longer finds it.

**Acceptance Scenarios**:

1. **Given** an Agent owner, **When** they create a config with name, provider, model, and API key, **Then** the config is stored with the key encrypted at rest and the response exposes only the masked preview.
2. **Given** an existing config, **When** the owner updates its model or params without supplying a key, **Then** the existing stored key is preserved unchanged.
3. **Given** an existing config named `fast` on an Agent, **When** the owner attempts to create a second config named `fast` on the same Agent, **Then** the request is rejected with a uniqueness error.
4. **Given** a user without admin rights on the owning entity, **When** they attempt to read, create, or modify its configs, **Then** the request is denied.
5. **Given** any read path (list, get, resolution diagnostics), **When** a config with a stored key is returned, **Then** the raw key never appears — only `hasApiKey` and the masked preview.

---

### User Story 3 - Clean cut-over from the legacy per-Agent/per-App AI columns (Priority: P2)

The legacy AI columns on Agent and App are removed outright in this feature's migration — existing stored configurations do **not** survive and are re-entered manually afterwards (confirmed 2026-06-11: nothing in production depends on them). The existing API operations the portal calls (read/update/clear AI config, has-key indicators) keep their shapes but are re-pointed at the registry, so the portal keeps functioning against an initially-empty registry until operators re-enter keys.

**Why this priority**: Micromentor is live; the read path must keep working across the deploy. Migration safety is as important as the new capability, but it depends on P1 existing.

**Independent Test**: With the migration applied (legacy columns gone), exercise the legacy API operations end-to-end: save a config through the legacy update operation, read it back through the legacy read operation, and verify it landed in the registry as the entity's `default` config.

**Acceptance Scenarios**:

1. **Given** the migration has applied, **When** the legacy update operation saves provider/model/key for an Agent, **Then** an Agent-owned registry config named `default` is created and the legacy read operation returns it.
2. **Given** an App-owned `default` config and an Agent-owned `default` config, **When** a session through that App resolves, **Then** the App-level config wins (preserving today's App-overrides-Agent behavior).
3. **Given** the migration has applied and no configs have been re-entered, **When** portal/API clients read the legacy AI fields, **Then** the reads succeed and report "not configured" (no errors, no crashes).
4. **Given** the legacy clear operation runs, **When** the entity has a `default` registry config, **Then** that config is deleted.

---

### User Story 4 - Consumers reference configs by name (Priority: P3)

Platform consumers that trigger LLM work — future webhooks, scheduled/background tasks, curation jobs, the portal chatbot — carry only an optional config **name** (e.g. `fast`). At execution time the platform resolves that name through the standard walk for the execution context. If the consumer names no config, or the named config cannot be resolved, the well-known `default` resolution applies.

**Why this priority**: This is the consumption pattern the registry exists to serve (per the webhook design's per-webhook AI override decision), but the first concrete consumer (headless runner / webhooks) ships separately. P1's resolver API is the deliverable this story validates.

**Independent Test**: Call the resolver with an explicit name plus a context; verify name-hit, name-miss-falls-back-to-default, and default-miss-errors behaviors.

**Acceptance Scenarios**:

1. **Given** a consumer that names `fast` and a `fast` config resolvable in its context, **When** it executes, **Then** the `fast` config's provider/model/key are used.
2. **Given** a consumer that names `fast` but no `fast` config resolves, **When** it executes, **Then** resolution falls back to `default` via the standard walk.
3. **Given** a consumer that names nothing, **When** it executes, **Then** `default` is resolved via the standard walk.

---

### Edge Cases

- Same name defined at multiple levels: innermost (App) wins; ties are impossible because names are unique per owner.
- Config exists but `enabled` is false: skipped; the walk continues outward (it does not stop with an error at that level).
- Config resolves but has no API key stored: treated as unusable for execution; callers receive a clear configuration error identifying the config (by name and owner level) without leaking secrets.
- Agent installed in multiple Apps/Orgs (the Juno pattern): resolution always runs in the context of one installation; the Organization consulted is the App's org, never the Agent builder's org.
- Owner entity is deleted: its configs are deleted with it; resolution simply no longer finds that level.
- Provider-specific parameters that other providers don't understand: stored per-config and validated per provider at write time; unknown providers are rejected at write time.
- Session context without an App (e.g. platform curation job): the walk degrades gracefully — levels that don't exist in the context are skipped (e.g. Host-only resolution for platform jobs).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support named AI service configurations attached to exactly one owner, where the owner is one of: platform host (HadronServer), Organization, App, or Agent.
- **FR-002**: Each configuration MUST carry: a lookup name, a provider identifier, a model identifier, an optional API key (encrypted at rest), an optional masked key preview, optional provider-specific parameters, an enabled flag, and standard audit timestamps.
- **FR-003**: Configuration names MUST be unique per owner entity (an Agent cannot have two configs named `fast`; two different Agents can each have one).
- **FR-004**: Every configuration MUST belong to exactly one owner; ownerless or multi-owner configurations MUST be impossible to persist (enforced at the database layer, not just application code).
- **FR-005**: The system MUST resolve a configuration name for an execution context by walking App → Agent → Organization (the App's organization) → HadronServer and returning the first **enabled** configuration with that name.
- **FR-006**: When no configuration name is specified by the caller, the system MUST resolve the well-known name `default` using the same walk.
- **FR-007**: When an explicitly named configuration does not resolve, consumer execution paths MUST fall back to `default` resolution; if `default` also fails, the caller MUST receive a clear error stating that no AI configuration is available for the context.
- **FR-008**: Disabled configurations MUST be skipped during resolution (the walk continues outward).
- **FR-009**: API keys MUST be stored encrypted at rest using the platform's existing token-encryption mechanism. Management and listing surfaces MUST never return plaintext keys — only a has-key indicator and a masked preview (ellipsis + last 4 characters).
- **FR-009a**: A dedicated, privileged **resolution** surface MUST return the resolved configuration including the decrypted key to authorized execution runtimes (the portal's server-side LLM runtime today; the headless runner later), gated at least as strictly as the existing decrypted-config queries it replaces (org ADMIN of the owning org, or platform admin). This is the successor to the existing `agentAIConfig`/`appAIConfig` queries and MUST apply the standard resolution walk rather than reading a single entity's columns.
- **FR-010**: Authorized users MUST be able to create, list, update, enable/disable, and delete configurations on entities they administer; updating a configuration without supplying a key MUST preserve the stored key.
- **FR-011**: Access control MUST follow the owning entity: only users with administrative rights over the owner (platform admin for Host, org owner/admin for Organization, App administrators for App, Agent owner for Agent) may manage or view its configurations.
- **FR-012**: Provider-specific parameters MUST be validated per provider at write time; configurations for unrecognized providers MUST be rejected.
- **FR-013**: The legacy Agent-level and App-level AI columns MUST be dropped in this feature's migration. Stored values are NOT migrated (confirmed disposable); operators re-enter configurations manually.
- **FR-014**: All session execution paths that previously read the legacy columns MUST read from the registry, preserving the existing App-overrides-Agent precedence.
- **FR-015**: The legacy API operations (read/update/clear AI config, has-key fields) MUST keep their existing shapes and authorization, re-implemented over the registry (the entity's `default` config), so existing clients keep working without code changes; their removal is a follow-up gated on portal migration.
- **FR-016**: Deleting an owner entity MUST delete its configurations.
- **FR-017**: Resolution MUST work in contexts where some levels are absent (e.g. a platform job with no App or Agent resolves against Host only).

### Key Entities

- **AiServiceConfig**: A named AI service configuration. Attributes: lookup name; exactly one owner (HadronServer, Organization, App, or Agent); provider; model; encrypted API key + masked preview; provider-specific parameters; enabled flag; audit timestamps. Uniqueness: (owner, name).
- **HadronServer** *(existing)*: The platform host entity; gains the role of outermost config owner. No new host entity is introduced.
- **Organization / App / Agent** *(existing)*: Gain config ownership; the legacy AI columns on Agent and App are dropped by this feature's migration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any execution context and config name, resolution returns a deterministic result that matches the documented precedence order in 100% of cases (verified by an exhaustive precedence test matrix across all four levels × enabled/disabled × present/absent).
- **SC-002**: All legacy API operations keep their exact shapes and authorization after the cut-over (verified by exercising each against the registry-backed implementation); a freshly-migrated deployment reports "not configured" everywhere without errors until configs are re-entered.
- **SC-003**: No management/listing API response, log line, or error message ever contains a plaintext API key (verified by tests asserting masked-only exposure); decrypted keys flow only through the privileged resolution surface to callers who pass its authorization check.
- **SC-004**: An operator can create a named config and see a session use it without touching any other entity's settings (config changes at one level never require edits at another).
- **SC-005**: A future consumer (webhook, scheduled task, portal chatbot) can select per-invocation model/cost behavior by supplying only a config name — no credentials or provider details at the call site.

## Assumptions

- The existing `HadronServer` entity is the platform-host owner level; no new `HadronHost` entity is introduced. The Baragaun SaaS host is the row with `organizationId = NULL`.
- Resolution precedence is **App → Agent → Organization → Host** (install-time overrides design-time), consistent with the existing App-overrides-Agent column semantics. The Organization consulted is the App's (installation's) org.
- Consumers reference configs by **name only** and never own configs; the future `AgentWebhook` entity will carry an optional config-name field, per the 2026-05-02 webhook design (decision 5).
- One config row = one (provider, model, key, params) tuple; the two-entity split (shared credentials + per-model detail) from the 2026-05-03 discussion is deliberately collapsed for v1 and can be normalized later if key rotation across many configs becomes painful.
- `default` is a reserved-by-convention well-known name, not an enforced enum; additional conventional names (e.g. `fast`, `frontier`) are documented, not enforced.
- User-level personal configs need no new mechanism: a user attaches org-level configs to their personal organization.
- Existing stored AI configurations are disposable (confirmed 2026-06-11): no backfill, no data-equivalence guarantee; the legacy columns are dropped in this migration and operators re-enter keys manually.
- Out of scope (deferred): cross-org config sharing/visibility, `payedBy`/payment semantics, rate limits and token allowances (headless-runner concern; soft limits can live in provider params), URN-based cross-org references, and removal of the legacy GraphQL operations (follow-up gated on portal migration).
- Encryption reuses the platform's existing AES-256-GCM token-encryption helpers and key management; no new key-management mechanism is introduced.
- LLM calls are currently executed by the portal's server-side runtime (and later the headless runner), which fetches decrypted credentials from the platform via the existing `agentAIConfig`/`appAIConfig` queries. The privileged resolution surface (FR-009a) replaces those queries; the portal's `/api/agent-chat/ai-config` save/test/clear endpoint and both portal config UIs (agent detail, App settings) migrate to the new CRUD + resolution surfaces in the portal follow-up.
- Known provider identifiers today: `anthropic`, `openai`, `glm`, `bedrock`. Bedrock stores a JSON-encoded credential triple (access key ID, secret, region) in the key field — provider validation must preserve that behavior.
