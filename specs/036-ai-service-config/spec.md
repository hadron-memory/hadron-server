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

### User Story 3 - Existing per-Agent/per-App AI settings keep working (migration) (Priority: P2)

Agents and Apps that already carry AI settings in the legacy columns continue to work without operator action: their settings are backfilled into the new registry as configs named `default`, and the existing session paths (agent chat, app sessions) read from the registry afterwards. Legacy columns and their API fields remain readable during the transition and are removed only in a follow-up once the portal has migrated.

**Why this priority**: Micromentor is live; the read path must keep working across the deploy. Migration safety is as important as the new capability, but it depends on P1 existing.

**Independent Test**: Seed an Agent and an App with legacy AI columns populated, run the backfill, and verify (a) registry rows named `default` exist with matching provider/model/key, and (b) an agent-chat session resolves the same provider/model/key it would have before.

**Acceptance Scenarios**:

1. **Given** an Agent with legacy provider/model/key columns populated, **When** the backfill runs, **Then** an Agent-owned config named `default` exists carrying the same provider, model, encrypted key, and preview.
2. **Given** an App with legacy override columns populated, **When** the backfill runs, **Then** an App-owned config named `default` exists, and sessions through that App resolve it ahead of the Agent's config (preserving today's App-overrides-Agent behavior).
3. **Given** an Agent with no legacy AI settings, **When** the backfill runs, **Then** no registry row is created for it.
4. **Given** the backfill has run, **When** existing portal/API clients read the legacy AI fields, **Then** the reads still succeed during the transition window.

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
- **FR-009**: API keys MUST be stored encrypted at rest using the platform's existing token-encryption mechanism, and MUST never be returned in plaintext by any API; read surfaces expose only a has-key indicator and a masked preview (ellipsis + last 4 characters).
- **FR-010**: Authorized users MUST be able to create, list, update, enable/disable, and delete configurations on entities they administer; updating a configuration without supplying a key MUST preserve the stored key.
- **FR-011**: Access control MUST follow the owning entity: only users with administrative rights over the owner (platform admin for Host, org owner/admin for Organization, App administrators for App, Agent owner for Agent) may manage or view its configurations.
- **FR-012**: Provider-specific parameters MUST be validated per provider at write time; configurations for unrecognized providers MUST be rejected.
- **FR-013**: Existing Agent-level and App-level AI settings (provider, model, encrypted key, preview) MUST be backfilled into the registry as configurations named `default` owned by the respective Agent/App; entities with no legacy settings produce no rows.
- **FR-014**: After backfill, all session execution paths that previously read the legacy columns MUST read from the registry, preserving the existing App-overrides-Agent precedence.
- **FR-015**: Legacy columns and their API read fields MUST remain functional during the transition; their removal is a separate follow-up feature gated on portal migration (out of scope here).
- **FR-016**: Deleting an owner entity MUST delete its configurations.
- **FR-017**: Resolution MUST work in contexts where some levels are absent (e.g. a platform job with no App or Agent resolves against Host only).

### Key Entities

- **AiServiceConfig**: A named AI service configuration. Attributes: lookup name; exactly one owner (HadronServer, Organization, App, or Agent); provider; model; encrypted API key + masked preview; provider-specific parameters; enabled flag; audit timestamps. Uniqueness: (owner, name).
- **HadronServer** *(existing)*: The platform host entity; gains the role of outermost config owner. No new host entity is introduced.
- **Organization / App / Agent** *(existing)*: Gain config ownership; Agent and App additionally carry legacy AI columns that this feature supersedes (removal deferred).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any execution context and config name, resolution returns a deterministic result that matches the documented precedence order in 100% of cases (verified by an exhaustive precedence test matrix across all four levels × enabled/disabled × present/absent).
- **SC-002**: After backfill, every Agent and App that had working AI settings before the migration produces byte-identical provider/model/key resolution results through the new registry (zero behavioral regressions on live installations).
- **SC-003**: No API response, log line, or error message ever contains a plaintext API key (verified by tests asserting masked-only exposure on every read surface).
- **SC-004**: An operator can create a named config and see a session use it without touching any other entity's settings (config changes at one level never require edits at another).
- **SC-005**: A future consumer (webhook, scheduled task, portal chatbot) can select per-invocation model/cost behavior by supplying only a config name — no credentials or provider details at the call site.

## Assumptions

- The existing `HadronServer` entity is the platform-host owner level; no new `HadronHost` entity is introduced. The Baragaun SaaS host is the row with `organizationId = NULL`.
- Resolution precedence is **App → Agent → Organization → Host** (install-time overrides design-time), consistent with the existing App-overrides-Agent column semantics. The Organization consulted is the App's (installation's) org.
- Consumers reference configs by **name only** and never own configs; the future `AgentWebhook` entity will carry an optional config-name field, per the 2026-05-02 webhook design (decision 5).
- One config row = one (provider, model, key, params) tuple; the two-entity split (shared credentials + per-model detail) from the 2026-05-03 discussion is deliberately collapsed for v1 and can be normalized later if key rotation across many configs becomes painful.
- `default` is a reserved-by-convention well-known name, not an enforced enum; additional conventional names (e.g. `fast`, `frontier`) are documented, not enforced.
- User-level personal configs need no new mechanism: a user attaches org-level configs to their personal organization.
- Out of scope (deferred): cross-org config sharing/visibility, `payedBy`/payment semantics, rate limits and token allowances (headless-runner concern; soft limits can live in provider params), URN-based cross-org references, and removal of the legacy columns (follow-up feature).
- Encryption reuses the platform's existing AES-256-GCM token-encryption helpers and key management; no new key-management mechanism is introduced.
