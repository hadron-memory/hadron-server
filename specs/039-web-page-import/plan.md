# Implementation Plan — Web Page Import (URL → Markdown → Node, over NATS)

**Feature**: A client (first consumer: `hadron-chrome-extension`) sends a web URL plus a
destination node URN through a new API surface. The server records an import task and
schedules it over NATS. A NATS listener performs the task: fetch the URL's HTML, convert
it to Markdown (via `hadrontool-pdf`), save it into the target node, and generate an
abstract using the first available `AiServiceConfig` resolved for the organization.

**Date**: 2026-07-02 · **Status**: Draft plan (no spec.md yet — promote via speckit if desired)

---

## 1. Grounding — prior decisions this plan implements or touches

| Decision / source | What it dictates here |
|---|---|
| D-2026-06-11-006/007 (message-bus session) | NATS **JetStream** is the platform bus. Fronted by a deliberately narrow **`BusClient`** interface (`publish`, `subscribeQueue`, `subscribePubSub`, `requestReply`); no broker-specific features leak past it. Delivery = **at-least-once + idempotency key required on every handler**. V1 tenancy is application-level (org/app in payload + subject convention). This feature is the **first real BusClient consumer** — V1's "background jobs" scope made concrete. |
| D-2026-06-11-008 | Transactional enqueue via the **outbox pattern**: the DB transaction that records the request also persists the durable job record; a relay/sweep guarantees delivery if the broker publish fails. |
| D-2026-06-17-002 | NATS is **internal-only**. The chrome extension never touches NATS — it calls the GraphQL API; only hadron-server (and first-party tools) speak NATS. |
| D-2026-06-17-003 | Bus contracts are **versioned, dot-delimited subjects** owned by hadron-server: `webimport.requested.v1` follows the `asset.uploaded.v1` naming precedent. |
| D-2026-06-17-004 | The open core must run **standalone without NATS**. The task table is the durable source of truth; NATS is the wake-up transport. With `NATS_URL` unset, a sweep loop (the established `embedNodes.ts` idiom) still drains tasks — feature degrades to polling latency, never breaks. |
| D-2026-06-17-005 | **Core owns the canonical write; the tool owns transformation.** hadron-server authorizes, orchestrates, and writes the node; `hadrontool-pdf` does the stateless HTML→Markdown conversion. |
| Headless-runner D23 + `cor:acl:040` | Background work runs under an explicit principal with the platform authorizing the action **before** it runs. Here: capture the caller's principal (`userId`/`appId`/`organizationId`) at enqueue, check memory write access **at enqueue time**, and re-check with a synthesized `Context` **at execution time** (authority may have narrowed in between). |
| `STUBBED-web-fetch-tool` (2026-06-03) | This feature is the stub's listed **promote-trigger** ("a spec that exposes external content to the agent surface"). Its threat model binds: fetched content is **data, not instructions** (indirect-prompt-injection defense), write-after-fetch is the blast-radius case, provenance must be recorded. |
| Spec 036 / `findings:ai-service-config-registry` | `AiServiceConfig` registry + resolution walk (App → Agent → Org → Host) **shipped** in `src/lib/aiConfig.ts`. Spec 036 explicitly names "scheduled tasks" as an intended consumer; this feature is the **first headless LLM consumer** and must build the missing LLM-invocation layer. |
| `hadrontool-pdf` overview node + ops:deployment | The tool is live on alpha (Komodo, internal-only, `http://hadrontool-pdf:8080`, bearer token). It is the platform's capability-tool testbed; adding a conversion direction there is the intended growth path. |

**Note on the 2026-06-19 permissions discussion**: no folder or file with that date exists
in the local `hadron-concept` checkout (verified via `grep -rl "2026-06-19"` across the
tree and a `git pull`). The permissions decisions of that period are encoded in the
platform-specs ACL module — `cor:acl:040` (allow-only rules, default-deny, conjunctive
delegation ceiling, processor secondary gates, tools as action-vocabulary entries) and
`cor:acl:050` (two-tier quotas, **headless launch gate**, activation tokens). This plan
treats those spec nodes as the permissions contract.

## 2. Verified current state (2026-07-02)

- **NATS on alpha (prod)**: `nats-server` v2.10.27, bare-metal systemd unit (enabled,
  running since 2026-06-12), **JetStream enabled** (`/var/lib/nats`, 512MB mem / 10GB file
  caps), listening `0.0.0.0:4222` (Hetzner cloud firewall blocks external access;
  containers connect via Docker gateway), monitoring on `127.0.0.1:8222`. **No auth
  configured yet** — D-2026-06-11-007's V1 static token is an ops prerequisite (§9).
  Note: deployment is bare-metal, not the "extra container via Komodo" the discussion
  assumed — fine, but the connection URL for containers is the Docker bridge gateway, not
  a `komodo_default` DNS name.
- **hadron-server has no NATS code** — no client dependency, nothing in `src/`. The
  established background-job idiom is the spec-033 embedding worker: durable marker
  columns + `setImmediate` prompt-drain + `setInterval` sweep
  (`src/jobs/embedNodes.ts:332`, `src/services/embedding/enqueue.ts:29`).
- **hadron-server never calls an LLM.** `src/lib/aiConfig.ts` resolves configs
  (`resolveAiConfigWithFallback` at `aiConfig.ts:295`); nothing consumes one. No
  anthropic/openai SDK dependency. Abstracts are client-supplied; the server only computes
  `abstractOriginHash` (`resolvers.mutation.node.ts:253-332`).
- **hadrontool-pdf does Markdown↔PDF only** — no HTML→Markdown capability (no turndown or
  equivalent anywhere in the org's repos). Its renderer is SSRF-hardened: JS disabled,
  request interception aborts all non-`data:` requests unless `PDF_ALLOW_REMOTE=true`
  (`src/lib/htmlToPdf.ts:19-35`); prod deploys with `PDF_ALLOW_REMOTE=false`.
  hadron-server already has the client template: `src/lib/pdfClient.ts`
  (`renderMarkdownToPdf`, bearer auth, 30s timeout, typed errors).
- **hadron-chrome-extension is an empty stub** — README + LICENSE, single initial commit.
  No manifest, no code. The client side of this feature is greenfield; this plan defines
  the server contract it will consume and an MVP extension scope (§10, Phase 5).
- **Node-write invariants** (from `findings:node-write-surface-invariants` +
  `resolvers.mutation.node.ts`): any write surface must go through
  `resolvers.Mutation.upsertNode` (per-memory auth, encryption, NodeVersion snapshot,
  `abstractOriginHash` recompute on plaintext, re-embed enqueue, git mirror). MCP tools
  already model the delegation pattern: build a `Context` and call the resolver
  (`src/mcp/server.ts:2716-2730`).

## 3. Architecture overview

```
hadron-chrome-extension                     hadron-server                                    hadrontool-pdf
        │                                        │                                                │
        │ importWebPage(url, nodeUrn)            │                                                │
        ├──────────────────────────────────────► │ 1. auth + memory-write check                   │
        │   (GraphQL, hdr_user_* key)            │ 2. tx: insert WebImportTask (PENDING)          │
        │ ◄── task {id, status: PENDING} ────────┤ 3. post-commit: bus.publish                    │
        │                                        │    webimport.requested.v1 {taskId}             │
        │                                        ▼                                                │
        │                     ┌─ NATS JetStream (alpha, internal) ─┐                              │
        │                     └──────────────┬─────────────────────┘                              │
        │                                    ▼                                                    │
        │                       webimport worker (durable consumer,                               │
        │                       queue group; sweep-loop fallback)                                 │
        │                                    │ a. claim task row (atomic status flip)             │
        │                                    │ b. fetch URL (SSRF-guarded, caps)                  │
        │                                    ├── POST /convert/html-to-markdown ────────────────► │
        │                                    │ ◄──────── { markdown, title } ────────────────────┤
        │                                    │ c. upsertNode via synthesized Context              │
        │                                    │ d. resolve AiServiceConfig (org walk)              │
        │                                    │ e. LLM → abstract → upsertNode(abstract)           │
        │ ◄── webImportTask(id) polling ──── │ f. mark COMPLETED / FAILED                         │
```

Two-write shape in step c/e is deliberate: the content write must not be held hostage by
the LLM call (abstract generation can fail or be slow; the page content is already safe).
Step e reuses `upsertNode` so `abstractOriginHash` stays consistent automatically.

## 4. Data model (Prisma)

New model — mirrors the embedding-queue durability pattern, but row-per-task because tasks
carry request payload and caller principal:

```prisma
model WebImportTask {
  id              String    @id            // also the bus idempotency key
  url             String
  memoryId        String                   // resolved from nodeUrn at enqueue
  nodeLoc         String                   // loc within the memory
  status          WebImportTaskStatus @default(PENDING)  // PENDING|RUNNING|COMPLETED|FAILED
  attempts        Int       @default(0)
  error           String?
  // captured principal — replayed into the execution Context (headless-runner D23 analogue)
  requestedByUserId String?
  appId           String?
  organizationId  String                   // drives AiServiceConfig resolution
  publishedAt     DateTime?                // outbox marker: NULL ⇒ sweep must (re)publish
  startedAt       DateTime?
  finishedAt      DateTime?
  resultNodeId    String?
  createdAt       DateTime  @default(now())

  @@index([status, publishedAt])
  @@map("web_import_tasks")
}
```

- The row **is** the outbox (D-2026-06-11-008, simplified): `publishedAt IS NULL` rows are
  re-published by the sweep. No separate outbox table until a second bus producer needs one.
- `attempts` cap (default 5) + `FAILED` terminal state; retries via JetStream redelivery
  AND the sweep (whichever fires first — the atomic claim makes them race-safe).
- Composite-PK note from CLAUDE.md doesn't apply (single `id` PK; no
  `MODELS_WITHOUT_ID` change needed).
- Apply via `pnpm db:dev-setup` locally (never bare `db push` — HNSW index), plus a
  hand-timestamped migration for prod.

## 5. API contract (GraphQL)

New mutation + status query in `typeDefs.ts` / new `resolvers.mutation.webImport.ts`
(follow the module-split convention from the resolver carve-up, PR #400):

```graphql
type Mutation {
  "Fetch a web page, convert to Markdown, and import it into the node at nodeUrn (async)."
  importWebPage(input: ImportWebPageInput!): WebImportTask!
}
input ImportWebPageInput {
  url: String!        # http/https only
  nodeUrn: String!    # destination node — created if absent, content REPLACED if present
}
type Query {
  webImportTask(id: ID!): WebImportTask
}
type WebImportTask { id, url, nodeUrn, status, error, resultNodeId, createdAt, finishedAt … }
```

Enqueue-time resolver behavior:
1. Resolve `nodeUrn` with the spec-027-safe parser (canonical memory URN + explicit `::`
   + loc — do **not** string-concatenate; see `spec-027-node-urn-parser-ambiguity`).
2. Authorize: the caller must have **write access to the target memory** — reuse the
   exact gate `upsertNode` uses (per-memory write auth). Reject free-standing/encrypted
   edge cases per §8. This is the `cor:acl:040` platform floor, checked pre-enqueue.
3. Validate URL (scheme http/https, well-formed, ≤2k chars). SSRF enforcement happens
   again at fetch time (§8) — enqueue validation is a fast-fail nicety, not the defense.
4. Insert the task row; after commit, `bus.publish('webimport.requested.v1', { taskId })`
   + stamp `publishedAt`; on publish failure, leave `publishedAt` NULL (sweep recovers).
   Never fail the mutation because the broker is down.
5. Return the task (client polls `webImportTask(id)` — no callback/subscription in v1).

MCP parity (`hadron_import_web_page`) is deliberately **out of v1**: exposing fetch to
agents is exactly the web-fetch-tool stub's unresolved gating question (D2/D5 there).
The chrome extension is a *user-initiated* surface — much smaller threat surface. Revisit
when the web-fetch discussion converges.

## 6. Bus layer — `BusClient` + NATS (first implementation)

New `src/lib/bus/`:

- `types.ts` — the narrow interface from D-2026-06-11-007, verbatim:
  `publish(subject, payload, opts?)`, `subscribeQueue(subject, queueGroup, handler)`,
  `subscribePubSub(subjectPattern, handler)`, `requestReply(subject, payload, timeoutMs)`.
  V1 implements `publish` + `subscribeQueue` for real; the other two may throw
  `NotImplemented` (interface complete, implementation on demand — keeps the abstraction
  honest without gold-plating).
- `natsBusClient.ts` — `nats` (nats.js v2) implementation. JetStream: one stream
  `WEBIMPORT` (subjects `webimport.>`, file storage, `WorkQueue` retention or `Limits` +
  durable consumer — decide at impl; WorkQueue matches job semantics), durable consumer
  `webimport-worker`, explicit ack, `ack_wait` ≥ 120s (fetch+convert+LLM can be slow),
  `max_deliver` aligned with the `attempts` cap.
- `index.ts` — `getBusClient()`: returns the NATS client when `NATS_URL` is set, else
  `null`. **Absence of NATS must not break boot or the API** (D-2026-06-17-004).
- Env: `NATS_URL` (e.g. `nats://172.17.0.1:4222` from the container — the Docker bridge
  gateway, since NATS is bare-metal on the host), `NATS_TOKEN` (static token, V1 auth
  tier), `DISABLE_WEBIMPORT_WORKER` (mirrors `DISABLE_EMBED_WORKER`).
- Boot wiring in `server.ts` next to the embedding-loop start (`server.ts:882-893`
  pattern): connect, start the durable consumer, and start the **sweep loop**
  (`src/jobs/webImport.ts`) that every 60s claims PENDING tasks that are unpublished or
  stale (RUNNING longer than a lease window ⇒ crashed worker). The sweep is both the
  no-NATS fallback and the redelivery net.
- **Idempotency (required by D-2026-06-11-007)**: the handler's first action is an atomic
  claim — `updateMany({ where: { id, status: 'PENDING' }, data: { status: 'RUNNING',
  startedAt, attempts: { increment: 1 } } })`; claim count 0 ⇒ ack and drop (duplicate
  delivery or sweep already took it). Same guard the upsert-race finding
  (`prisma-upsert-not-race-safe`) teaches: never assume single delivery.
- Local dev: add a `nats` service to `docker-compose.yaml` (`nats:2.10-alpine`,
  `-js` flag) — NATS is not installed locally; compose is the dev path. Tests exercise
  the sweep path with `NATS_URL` unset (no broker needed in CI), plus one optional
  integration test gated on a running broker.

## 7. Worker pipeline (`src/jobs/webImport.ts`)

Per task, after the atomic claim:

1. **Fetch** (`src/lib/webFetch.ts`, net-new): `fetch` with redirect limit (≤3, re-validating
   each hop), 30s timeout, `Accept: text/html`, response cap (5 MB), content-type check
   (`text/html`/`application/xhtml+xml`; reject PDFs etc. in v1 — a `pdf-to-markdown`
   follow-up can branch here later, the tool already supports it). SSRF guard per §8.
2. **Convert**: `POST ${PDF_SERVICE_URL}/convert/html-to-markdown` with `{ html, baseUrl }`
   → `{ markdown, title }`. New sibling of `renderMarkdownToPdf` in `src/lib/pdfClient.ts`
   (same bearer auth, timeout, typed-error shape). Tool-side work in §7a.
3. **Write content**: synthesize a `Context` from the captured principal
   (`{ db, userId: requestedByUserId, appId, organizationId, roles }` — the MCP delegation
   pattern, `src/mcp/server.ts:2716`) and call `resolvers.Mutation.upsertNode` with
   `{ urn: destination, name: title ?? url, content: markdown, data: { sourceUrl, fetchedAt,
   contentHash } }`. This re-runs write auth at execution time (authority may have
   narrowed since enqueue — `cor:acl:040:02` conjunction) and gets encryption, NodeVersion,
   re-embed, and git mirror for free. **Never write via Prisma directly.**
   Overwrite semantics: existing node content is replaced; NodeVersion snapshot preserves
   the prior state (this is the documented recovery path).
4. **Resolve AI config**: `resolveAiConfigWithFallback(db, null, { organizationId })` —
   the org walk ending at the Host `'default'`. This is the registry-idiomatic reading of
   "first available AiServiceConfig for the organization" (named-config resolution, org
   level first). If literal first-by-createdAt is wanted instead, swap for a
   `findFirst({ where: { organizationId, enabled: true }, orderBy: { createdAt: 'asc' } })`
   — flagged as an open question (§11), default is the registry walk.
5. **Generate abstract** (`src/lib/llm/`, net-new — §7b): one completion call — system
   prompt frames the task; the fetched markdown is wrapped as quoted document data (§8).
   Output ≤ ~500 chars. Then a second `upsertNode` with `{ urn, abstract }` so
   `abstractOriginHash` is recomputed against the just-written content. On
   `NoAiConfigAvailableError` or LLM failure: task still **COMPLETES** with a warning in
   `error` (content is imported; abstract is enhancement, not requirement — matches the
   "don't slow/block on AI" platform rule from D-2026-05-31-002).
6. **Finish**: status `COMPLETED` + `resultNodeId` + `finishedAt`; ack the JetStream
   message. On step 1–3 failure: record `error`; if `attempts < max` reset to `PENDING`
   (+ nak with delay), else `FAILED` (+ ack — poison-message terminal state, the DLQ-lite
   until a real DLQ lands with the webhook dispatcher).

### 7a. hadrontool-pdf: new `/convert/html-to-markdown` endpoint

- `POST /convert/html-to-markdown` — `{ html, baseUrl? }` → `{ markdown, title }`.
  Behind the existing `requireAuth` bearer gate.
- Implementation: `turndown` + `turndown-plugin-gfm` (tables, strikethrough), plus a
  pre-pass to strip `<script>/<style>/<nav>/<footer>` and optionally Readability
  (`@mozilla/readability` + `linkedom`) for article extraction — start with
  turndown+strip, add Readability behind a `{ extract: 'article' }` option if raw pages
  come out noisy. `baseUrl` resolves relative links/images to absolute.
- Pure function of input — preserves the tool's stateless contract. **No fetching in the
  tool**; `PDF_ALLOW_REMOTE=false` posture unchanged. (A future
  `/convert/url-to-markdown` with Puppeteer `page.goto` for JS-heavy pages is the noted
  V2 — it needs its own SSRF story and deliberately conflicts with current hardening.)
- Advertise in `GET /convert/info` (`directions` array) — the capability-catalog seed the
  tool's overview node describes.
- Update the tool's Hadron memory node (`hadronmemory.com::hadrontool-pdf`) when shipped.

### 7b. LLM invocation layer (`src/lib/llm/`)

Net-new; the first consumer of a resolved `AiServiceConfig`. Modeled on the embedding
client split (`src/lib/embedding/client.ts` / `client-sagemaker.ts`):

- `index.ts` — `generateText(config: ResolvedAiConfig, req: { system, prompt, maxTokens })`,
  dispatching on `config.provider` (`anthropic | openai | glm | bedrock` per
  `KNOWN_AI_PROVIDERS`, `aiConfig.ts:62`).
- Use the **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`, `@ai-sdk/openai`,
  `@ai-sdk/amazon-bedrock`) — headless-runner D1 already decided this layer; one
  dependency family covers all four providers (glm via the OpenAI-compatible adapter).
  Decrypt the key with `decryptToken` (`src/lib/tokenCrypto.ts`); bedrock key is the JSON
  triple convention.
- Keep it deliberately small (single-shot text generation). The headless agent runner
  will grow the real AI-call layer later; this module is its seed, not a framework.

## 8. Security

- **SSRF (the main new attack surface)** — `src/lib/webFetch.ts` must: allow only
  `http:`/`https:`; resolve DNS and reject private/reserved ranges (RFC1918, loopback,
  link-local/169.254 incl. cloud metadata, ULA/IPv6 equivalents); pin the resolved IP for
  the actual request (DNS-rebinding guard) or re-validate per redirect hop; cap redirects,
  size, and time. hadrontool-pdf's request-interception guard is prior art for posture,
  not reusable code. Unit-test the guard against the classic bypasses (decimal IPs,
  `[::1]`, `0.0.0.0`, redirect-to-internal).
- **Indirect prompt injection** (web-fetch stub D1): fetched markdown enters exactly one
  LLM call (abstract generation). Wrap it as a delimited quoted document with a system
  prompt that instructs summarize-only-ignore-instructions; the LLM output lands in a
  plain-text `abstract` field — it is never executed, never fed to a tool-using agent in
  this flow. Provenance (`sourceUrl`, `fetchedAt`, `contentHash` in `Node.data`) marks the
  node as externally-sourced for future consumers (stub D4).
- **Authorization** (`cor:acl:040`): platform-floor check at enqueue, re-check at
  execution via the synthesized Context through `upsertNode`. The worker holds no
  ambient authority — it acts strictly as the captured principal.
- **Encrypted memories**: `upsertNode` handles encrypt-on-write, but the abstract-stale
  meta caveat (#206) applies; nothing special needed in v1 beyond letting the resolver do
  its job. Plaintext page content transits hadron-server ↔ hadrontool-pdf inside the
  trust boundary only (same posture as PDF export).
- **Quotas** (`cor:acl:050`, headless launch gate): not implemented platform-wide yet.
  V1 stopgap: per-org cap on PENDING+RUNNING tasks (e.g. 20) checked at enqueue — cheap,
  and honest about the unbuilt ticket system.

## 9. Ops checklist (alpha)

1. Add auth to `nats-server.conf` (V1 static token per D-2026-06-11-007 tiering):
   `authorization { token: <from Doppler> }`; restart unit. Currently **no auth** — do
   this before the app connects, not after.
2. Confirm container→host reachability: `komodo_default` bridge gateway →
   `nats://<gateway-ip>:4222` (NATS already binds 0.0.0.0; host firewall stays closed
   externally). Set `NATS_URL` + `NATS_TOKEN` in Doppler `hadron-server/prd`.
3. hadrontool-pdf: deploy the new endpoint (push to `main` → Komodo webhook auto-builds);
   no config change (reuses `PDF_SERVICE_TOKEN`).
4. Migration deploys via the container entrypoint (`ops:alpha:prisma-deploy-flow` —
   migrations run on restart).
5. Observability v1 (message-bus D9/D10): structured worker logs; `nats` CLI + the 8222
   monitoring endpoint; `webImportTask` query is the user-facing status surface.

## 10. Phased delivery (each phase one PR, per project convention)

| Phase | Repo | Contents | Depends on |
|---|---|---|---|
| **1. Bus foundation** | hadron-server | `src/lib/bus/` (interface + NATS impl + null fallback), compose `nats` service, env plumbing, boot wiring. No feature code — testable via a throwaway echo subject. | — |
| **2. HTML→Markdown capability** | hadrontool-pdf | `/convert/html-to-markdown` (turndown+gfm, strip pre-pass, `baseUrl`), `/convert/info` advert, tests (incl. round-trip fixture). Deployable independently. | — |
| **3. Task + API + worker (content path)** | hadron-server | `WebImportTask` model + migration, `importWebPage` / `webImportTask` GraphQL surface, `src/lib/webFetch.ts` (SSRF-guarded), `pdfClient.convertHtmlToMarkdown`, worker + sweep loop, `upsertNode` delegation. Ships without abstract generation (step 5 skipped). | 1, 2 |
| **4. Abstract generation** | hadron-server | `src/lib/llm/` (Vercel AI SDK, provider dispatch), org-walk config resolution, abstract write, complete-with-warning semantics. | 3 |
| **5. Chrome extension MVP** | hadron-chrome-extension | Greenfield: MV3 manifest, service worker, context-menu "Save page to Hadron", options page storing server URL + `hdr_user_*` key, destination-node picker (memory list + loc input, via existing queries), calls `importWebPage`, badge/poll for status. | 3 |

Phases 1+2 are parallelizable. Phase 3 is the demo-able core ("URL lands as a Markdown
node"). Suggested spec-kit id: `039-web-page-import` (038 is the current max).

## 11. Open questions (decide before/at Phase 3–4)

1. **"First available config for the organization"** — registry-idiomatic org-walk
  `'default'` resolution (planned default) vs. literal first-enabled-by-createdAt?
  The registry finding says consumers reference configs **by name only**; a literal
  "first row" contradicts that design. Recommend: org walk with `'default'`, and if the
  org has no configs the Host default applies. Confirm with Holger.
2. **Destination overwrite UX** — v1 replaces node content (NodeVersion is the undo).
  Should the extension warn when the target node already has content, or should the API
  offer `mode: CREATE_ONLY`? Cheap to add to the input now, deferrable.
3. **Which memory classes are importable** — any writable memory (planned), or exclude
  encrypted memories in v1 to dodge the abstract-staleness/#206 caveat?
4. **JetStream retention** — WorkQueue vs Limits+durable. Implementation detail; decide
  in Phase 1 with a note in the bus module.
5. **Extension auth** — `hdr_user_*` PAT paste-in (planned v1, matches CLI PAT fallback)
  vs. OAuth device flow (better UX, real work). PAT first; OAuth when the extension
  graduates.
