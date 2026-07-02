# Implementation Plan — Node Import (`importNode`: URL or inline content → Markdown → Node)

**Feature**: A client (first consumer: the `hadron-chrome-extension` **Web Clipper**, already
built — [hadron-chrome-extension#1](https://github.com/hadron-memory/hadron-chrome-extension/pull/1))
sends **either a web URL or inline captured content** plus a destination node reference
through a new `importNode` GraphQL mutation (issue
[#457](https://github.com/hadron-memory/hadron-server/issues/457)). Inline content is
converted (via `hadrontool-pdf`) and stored **synchronously**. A URL is recorded as a
`WebImportTask` and scheduled over NATS; a worker fetches the page (SSRF-guarded),
converts HTML → Markdown, writes the node through the shared node-write core, and
generates an abstract via the org-resolved `AiServiceConfig`.

**Date**: 2026-07-02 (decisions resolved 2026-07-01) · **Status**: Draft plan (no spec.md
yet — promote via speckit if desired)

---

## 0. Decisions (resolved with Holger, 2026-07-01)

These supersede the open questions the first draft carried (old §11) and fold in the
review feedback on PR #458:

| # | Decision |
|---|---|
| D1 | **Prerequisite API cleanup (own PR, before Phase 3)**: split `upsertNode` into `createNode` + `updateNode` and **remove `upsertNode` from the public GraphQL surface** (no deprecation window — all first-party clients lift the same day: portal, Go CLI, MCP internals, chrome extension). The current resolver body becomes a **shared internal core** that keeps upsert semantics for server-internal callers (`syncGraph`, `mergeNodes`, `restoreNodeVersion`, and this feature's import path). The `createOnly` flag dies with the split (`createNode` *is* create-only). |
| D2 | **Node identification convention**: mutations that change an existing object identify it by `id` accepting **PK or fully-qualified URN** (spec 007 ID-or-URN dispatch), XOR the (`memoryId`, `loc`) combo — supplying both is a typed error. `memoryId` itself keeps accepting ID or URN. In `createNode`, `id` only ever means "create with this PK" (importer/git-sync use case); in `updateNode`, `id` only ever means "the node to change" — the dual meaning the single upsert input had is gone. |
| D3 | **Update never moves**: `updateNode` rejects an attempt to change `loc`/`memoryId`; relocation stays `moveNode`'s job. A URN-form target that doesn't resolve is `NodeNotFoundError` on `updateNode`; the import path (upsert semantics via the internal core) creates it. |
| D4 | **`name`**: required on create (typed resolver error if absent — no magic default), optional on update (omit = preserve, like `abstract`/`tags`). |
| D5 | **Mutation name + scope**: `importNode`, per issue #457 — accepts `url` XOR inline `content` (the clipper captures the authenticated DOM; a server fetch can never see gated pages, so the inline path is load-bearing, not a convenience). `contentType` field from day one; v1 accepts `text/html`; `application/pdf` is the first follow-up (the clipper will send PDFs; the tool already converts them). |
| D6 | **Sync now, async later**: inline `content` converts + stores synchronously in the mutation (quick win; no NATS needed — works on a bare open-core install). Eventually the inline path also goes async (large payloads + AI work don't belong in a request cycle); at that point the import payload moves to **object storage (Hetzner Object Storage)** rather than into task rows. The URL path is async from day one. |
| D7 | **Abstract config resolution**: registry-idiomatic org-walk `'default'` resolution (`resolveAiConfigWithFallback`), **not** literal first-row-by-createdAt — consumers reference configs by name per the spec-036 registry design. |
| D8 | **Overwrite semantics**: import behaves like the write core — target exists ⇒ content replaced (NodeVersion snapshot is the undo); target absent ⇒ created. No `mode: CREATE_ONLY` input; no warn-mode in the API. |
| D9 | **Encrypted memories**: out of scope for v1 — typed error at enqueue/import time. |
| D10 | **JetStream retention** (WorkQueue vs Limits+durable): deferred to Phase 1 implementation, with a note in the bus module. |
| D11 | **Extension auth**: already resolved by reality — the clipper ships OAuth 2.1 + PKCE + DCR (mirrors CLI/macOS app). No PAT path needed. |
| D12 | **`taskUrn` post-processing hand-off** (issue #457's third leg): deferred to a follow-up. Additive to the input later; the extension's synchronous `runTask` keeps working meanwhile. |

## 1. Grounding — prior decisions this plan implements or touches

| Decision / source | What it dictates here |
|---|---|
| Issue [#457](https://github.com/hadron-memory/hadron-server/issues/457) (web-clipper ingest API) | The API contract this plan implements: **`url` XOR inline `content`** + target node, sync store for content / async fetch for URL, background job for the fetch path. Names the SSRF, content-cleaning, and gated-content questions this plan answers. |
| D-2026-06-11-006/007 (message-bus session) | NATS **JetStream** is the platform bus. Fronted by a deliberately narrow **`BusClient`** interface (`publish`, `subscribeQueue`, `subscribePubSub`, `requestReply`); no broker-specific features leak past it. Delivery = **at-least-once + idempotency key required on every handler**. V1 tenancy is application-level (org/app in payload + subject convention). This feature is the **first real BusClient consumer** — V1's "background jobs" scope made concrete. |
| D-2026-06-11-008 | Transactional enqueue via the **outbox pattern**: the DB transaction that records the request also persists the durable job record; a relay/sweep guarantees delivery if the broker publish fails. |
| D-2026-06-17-002 | NATS is **internal-only**. The chrome extension never touches NATS — it calls the GraphQL API; only hadron-server (and first-party tools) speak NATS. |
| D-2026-06-17-003 | Bus contracts are **versioned, dot-delimited subjects** owned by hadron-server: `webimport.requested.v1` follows the `asset.uploaded.v1` naming precedent. |
| D-2026-06-17-004 | The open core must run **standalone without NATS**. The task table is the durable source of truth; NATS is the wake-up transport. With `NATS_URL` unset, a sweep loop (the established `embedNodes.ts` idiom) still drains tasks — feature degrades to polling latency, never breaks. (The sync inline-content path doesn't touch NATS at all.) |
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
- **hadron-chrome-extension is a working Web Clipper**
  ([PR #1](https://github.com/hadron-memory/hadron-chrome-extension/pull/1)): MV3,
  OAuth 2.1 + PKCE + Dynamic Client Registration against `srv.hadronmemory.com`
  (`lib/oauth.js`), toolbar popup with memory picker + URL-vs-Full-HTML toggle, capture of
  the **already-rendered, already-authenticated DOM** (client-side slimming strips
  scripts/styles/comments/large data-URIs, `lib/capture.js`). Today it writes via the
  `upsertNode` mutation directly and optionally hands off to a **synchronous** `runTask`.
  URL mode is verified end-to-end; full-HTML mode waits on the server body-limit deploy.
- **Staged in hadron-server working tree**: `express.json({ limit: '25mb' })` in
  `src/server.ts` (default 100kb 413s full-page clips). Ships with the sync-path PR
  (Phase 3) rather than floating uncommitted.
- **Node-write invariants** (from `findings:node-write-surface-invariants` +
  `resolvers.mutation.node.ts`): any write surface must go through the canonical
  node-write path (per-memory auth, encryption, NodeVersion snapshot,
  `abstractOriginHash` recompute on plaintext, re-embed enqueue, git mirror). MCP tools
  already model the delegation pattern: build a `Context` and call the resolver
  (`src/mcp/server.ts:2716-2730`). After the D1 refactor the canonical path is the
  shared internal core behind `createNode`/`updateNode`.

## 3. Architecture overview

```
hadron-chrome-extension (Web Clipper)             hadron-server                             hadrontool-pdf
        │                                              │                                          │
        │ importNode(target, content|url)              │                                          │
        ├────────────────────────────────────────────► │ 1. auth + memory-write check             │
        │   (GraphQL, OAuth bearer)                    │                                          │
        │                                              │                                          │
        │              ── inline-content path (SYNC) ──│                                          │
        │                                              ├── POST /convert/html-to-markdown ──────► │
        │                                              │ ◄──────── { markdown, title } ───────────┤
        │                                              │ write via internal node-write core       │
        │ ◄── { node, status: "stored" } ──────────────┤ (+ abstract, Phase 5, also sync-capable) │
        │                                              │                                          │
        │              ── URL path (ASYNC) ────────────│                                          │
        │                                              │ 2. tx: insert WebImportTask (PENDING)    │
        │ ◄── { task, status: "fetch_pending" } ───────┤ 3. post-commit: bus.publish              │
        │                                              │    webimport.requested.v1 {taskId}       │
        │                                              ▼                                          │
        │                     ┌─ NATS JetStream (alpha, internal) ─┐                              │
        │                     └──────────────┬─────────────────────┘                              │
        │                                    ▼                                                    │
        │                       webimport worker (durable consumer,                               │
        │                       queue group; sweep-loop fallback)                                 │
        │                                    │ a. claim task row (atomic status flip)             │
        │                                    │ b. fetch URL (SSRF-guarded, caps)                  │
        │                                    ├── POST /convert/html-to-markdown ────────────────► │
        │                                    │ ◄──────── { markdown, title } ────────────────────┤
        │                                    │ c. write via internal node-write core              │
        │                                    │    (synthesized Context)                           │
        │                                    │ d. resolve AiServiceConfig (org walk)              │
        │                                    │ e. LLM → abstract → internal update {id, abstract} │
        │ ◄── webImportTask(id) polling ──── │ f. mark COMPLETED / FAILED                         │
```

Two-write shape in step c/e is deliberate: the content write must not be held hostage by
the LLM call (abstract generation can fail or be slow; the page content is already safe).
Step e goes through the internal write core so `abstractOriginHash` stays consistent
automatically — and with D2/D4 the abstract update is exactly `{ id, abstract }` (no
`name`/`loc` re-send).

**Async evolution (D6)**: when the inline path goes async, the captured payload is staged
in **Hetzner Object Storage** and the task row carries a reference — task rows never hold
multi-MB blobs. Not built in v1; noted here so the sync mutation's shape (returns
`status`) doesn't need to change when it lands.

## 4. Data model (Prisma)

New model — mirrors the embedding-queue durability pattern, but row-per-task because tasks
carry request payload and caller principal. **URL path only** (inline content is sync in
v1 and never creates a task row):

```prisma
enum WebImportTaskStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
}

model WebImportTask {
  id              String    @id            // also the bus idempotency key
  url             String
  memoryId        String                   // resolved from the target ref at enqueue
  nodeLoc         String                   // loc within the memory
  status          WebImportTaskStatus @default(PENDING)
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

- Enum-add note: `WebImportTaskStatus` is a **new** enum created in the same migration as
  the table — the two-file enum-add rule only bites when adding values to an *existing*
  enum referenced by a CHECK in the same transaction. No CHECK references this enum.
- The row **is** the outbox (D-2026-06-11-008, simplified): `publishedAt IS NULL` rows are
  re-published by the sweep. No separate outbox table until a second bus producer needs one.
- `attempts` cap (default 5) + `FAILED` terminal state; retries via JetStream redelivery
  AND the sweep (whichever fires first — the atomic claim makes them race-safe).
- Composite-PK note from CLAUDE.md doesn't apply (single `id` PK; no
  `MODELS_WITHOUT_ID` change needed).
- Apply via `pnpm db:dev-setup` locally (never bare `db push` — HNSW index), plus a
  hand-timestamped migration for prod.

## 5. API contract (GraphQL)

### 5a. Prerequisite PR — `createNode` / `updateNode` split (D1–D4)

Own PR, lands before Phase 3. Not part of this feature's diff but its contract is:

```graphql
type Mutation {
  createNode(input: CreateNodeInput!): Node!
  updateNode(input: UpdateNodeInput!): Node!
  # upsertNode REMOVED — portal, Go CLI, MCP internals, and the chrome
  # extension migrate the same day (no legacy-client support needed).
}

input CreateNodeInput {
  memoryId: String!   # ID or fully-qualified URN (spec 007 / 022, unchanged)
  loc: String!
  name: String!       # required on create (D4) — no magic default
  id: String          # optional forced PK (git-sync/importer UUIDv7) — only ever a create-id here
  # ... all other node fields optional (nodeType, abstract, content, tags, edges, ...)
}

input UpdateNodeInput {
  id: String          # PK or fully-qualified node URN — "the node to change"
  memoryId: String    # ... XOR this combo; supplying both id and the combo is a typed error
  loc: String
  # every content field optional = preserve (name included, D4)
  # loc/memoryId are selectors ONLY — updateNode never moves (D3; moveNode's job)
}
```

Internally the current upsert body becomes a shared core (per-memory write auth,
encryption, NodeVersion, `abstractOriginHash`, re-embed, git mirror) that both resolvers
plus `syncGraph` / `mergeNodes` / `restoreNodeVersion` delegation call. The core **keeps
upsert semantics for internal callers** — the import path uses it (D8) so target-exists ⇒
replace, target-absent ⇒ create, without a public upsert surface.

### 5b. This feature — `importNode` (issue #457)

New mutation + status query in `typeDefs.ts` / new `resolvers.mutation.importNode.ts`
(follow the module-split convention from the resolver carve-up, PR #400):

```graphql
type Mutation {
  "Import external content into a node: inline content converts + stores synchronously; a url is fetched + converted asynchronously."
  importNode(input: ImportNodeInput!): ImportNodeResult!
}
input ImportNodeInput {
  # Target node — id (PK|URN) XOR (memoryId + loc), per D2. Created if absent,
  # content REPLACED if present (D8; NodeVersion is the undo).
  id: String
  memoryId: String
  loc: String

  # Source — exactly one of:
  url: String          # http/https only; async fetch over NATS
  content: String      # inline captured content (the clipper's authenticated-DOM capture); sync
  contentType: String  # default "text/html"; v1 accepts text/html only — application/pdf is the first follow-up (D5)

  name: String         # optional; defaults to converted <title> ?? url on create
}
type ImportNodeResult {
  status: String!      # "stored" (sync inline path) | "fetch_pending" (URL path)
  node: Node           # set on the sync path
  task: WebImportTask  # set on the URL path — poll webImportTask(id)
}
type Query {
  webImportTask(id: ID!): WebImportTask
}
type WebImportTask { id, url, status, error, resultNodeId, createdAt, finishedAt … }
```

Resolver behavior:
1. Resolve the target: `id` via `resolveNodeRef`-style dispatch (URN-form may name a
   not-yet-existing node — that's a create), or (`memoryId`, `loc`) via `resolveMemoryRef`
   (spec-027-safe parsing throughout — never string-concatenate memory URN + loc).
2. Authorize: the caller must have **write access to the target memory** — the same gate
   the write core uses. Reject encrypted memories (D9) and free-standing edge cases per §8.
   This is the `cor:acl:040` platform floor, checked pre-enqueue.
3. **Inline `content` path (sync)**: validate `contentType` (v1: `text/html`), call
   `POST /convert/html-to-markdown`, write via the internal node-write core
   (`name ?? title ?? url-less fallback`), return `{ status: "stored", node }`. Abstract
   generation (Phase 5) also runs inline here — with the same complete-without-abstract
   degradation as the async path.
4. **`url` path (async)**: validate URL (scheme http/https, well-formed, ≤2k chars —
   fast-fail nicety; SSRF enforcement happens at fetch time, §8). Insert the task row;
   after commit, `bus.publish('webimport.requested.v1', { taskId })` + stamp
   `publishedAt`; on publish failure, leave `publishedAt` NULL (sweep recovers). Never
   fail the mutation because the broker is down. Return `{ status: "fetch_pending", task }`.
5. Per-org quota stopgap (§8): cap PENDING+RUNNING tasks at enqueue.

MCP parity (`hadron_import_node`) is deliberately **out of v1**: exposing fetch to
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
  durable consumer — **decide at Phase 1** with a note in the bus module (D10); WorkQueue
  matches job semantics), durable consumer `webimport-worker`, explicit ack, `ack_wait`
  ≥ 120s (fetch+convert+LLM can be slow), `max_deliver` aligned with the `attempts` cap.
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
   (`text/html`/`application/xhtml+xml`; reject PDFs etc. in v1 — the `contentType`
   branch in `importNode` is where `application/pdf` lands later, the tool already
   supports it). SSRF guard per §8.
2. **Convert**: `POST ${PDF_SERVICE_URL}/convert/html-to-markdown` with `{ html, baseUrl }`
   → `{ markdown, title }`. New sibling of `renderMarkdownToPdf` in `src/lib/pdfClient.ts`
   (same bearer auth, timeout, typed-error shape). Tool-side work in §7a.
3. **Write content**: synthesize a `Context` from the captured principal
   (`{ db, userId: requestedByUserId, appId, organizationId, roles }` — the MCP delegation
   pattern, `src/mcp/server.ts:2716`) and call the **internal node-write core** (D1) with
   the task's stored `memoryId` + `nodeLoc` and
   `{ name: title ?? url, content: markdown, data: { sourceUrl, fetchedAt, contentHash } }`.
   This re-runs write auth at execution time (authority may have narrowed since enqueue —
   `cor:acl:040:02` conjunction) and gets encryption-handling, NodeVersion, re-embed, and
   git mirror for free. **Never write via Prisma directly.**
   Overwrite semantics per D8: existing node content is replaced; NodeVersion snapshot
   preserves the prior state (this is the documented recovery path).
4. **Resolve AI config**: `resolveAiConfigWithFallback(db, null, { organizationId })` —
   the org walk ending at the Host `'default'` (D7; named-config resolution per the
   spec-036 registry design, org level first).
5. **Generate abstract** (`src/lib/llm/`, net-new — §7b): one completion call — system
   prompt frames the task; the fetched markdown is wrapped as quoted document data (§8).
   Output ≤ ~500 chars. Then an internal update with `{ id: resultNodeId, abstract }` —
   through the write core so `abstractOriginHash` is recomputed against the just-written
   content (D2/D4 make this two-field call legal; no `name`/`loc` re-send). On
   `NoAiConfigAvailableError` or LLM failure: task still **COMPLETES** with a warning in
   `error` (content is imported; abstract is enhancement, not requirement — matches the
   "don't slow/block on AI" platform rule from D-2026-05-31-002).
6. **Finish**: status `COMPLETED` + `resultNodeId` + `finishedAt`; ack the JetStream
   message. On step 1–3 failure: record `error`; if `attempts < max` reset to `PENDING`
   (+ nak with delay), else `FAILED` (+ ack — poison-message terminal state, the DLQ-lite
   until a real DLQ lands with the webhook dispatcher).

The sync inline-content path (§5b step 3) is steps 2–5 of this pipeline invoked in the
request cycle with the mutation's own `Context` — same convert client, same write core,
same abstract degradation. Factor the shared portion so the two paths can't drift.

### 7a. hadrontool-pdf: new `/convert/html-to-markdown` endpoint

- `POST /convert/html-to-markdown` — `{ html, baseUrl? }` → `{ markdown, title }`.
  Behind the existing `requireAuth` bearer gate.
- Implementation: `turndown` + `turndown-plugin-gfm` (tables, strikethrough), plus a
  pre-pass to strip `<script>/<style>/<nav>/<footer>` and optionally Readability
  (`@mozilla/readability` + `linkedom`) for article extraction — start with
  turndown+strip, add Readability behind a `{ extract: 'article' }` option if raw pages
  come out noisy. `baseUrl` resolves relative links/images to absolute. (The clipper
  already slims its captures client-side; the strip pre-pass must stay idempotent over
  pre-slimmed input.)
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
  link-local/169.254 incl. cloud metadata, ULA/IPv6 equivalents); prevent DNS rebinding
  via a **custom `lookup` function on the HTTP agent/dispatcher** (undici `Agent` connect
  options or `https.Agent.lookup`) that validates the resolved IP while keeping the
  original hostname in the URL — **never** by substituting the IP into the URL, which
  breaks SNI/TLS certificate validation; re-validate per redirect hop; cap redirects,
  size, and time. hadrontool-pdf's request-interception guard is prior art for posture,
  not reusable code. Unit-test the guard against the classic bypasses (decimal IPs,
  `[::1]`, `0.0.0.0`, redirect-to-internal, rebinding TTL flip).
- **Inline content is NOT SSRF-relevant** (nothing is fetched) but is attacker-shaped
  input to the converter and the LLM — same prompt-injection posture as fetched HTML.
- **Indirect prompt injection** (web-fetch stub D1): imported markdown enters exactly one
  LLM call (abstract generation). Wrap it as a delimited quoted document with a system
  prompt that instructs summarize-only-ignore-instructions; the LLM output lands in a
  plain-text `abstract` field — it is never executed, never fed to a tool-using agent in
  this flow. Provenance (`sourceUrl`/`capturedAt`, `fetchedAt`, `contentHash` in
  `Node.data`) marks the node as externally-sourced for future consumers (stub D4).
- **Authorization** (`cor:acl:040`): platform-floor check at enqueue, re-check at
  execution via the synthesized Context through the write core. The worker holds no
  ambient authority — it acts strictly as the captured principal.
- **Encrypted memories**: out of scope in v1 (D9) — typed error at import time. Lifts
  later by letting the write core do its encrypt-on-write job (the abstract-stale meta
  caveat #206 applies then). Plaintext page content transits hadron-server ↔
  hadrontool-pdf inside the trust boundary only (same posture as PDF export).
- **Quotas** (`cor:acl:050`, headless launch gate): not implemented platform-wide yet.
  V1 stopgap: per-org cap on PENDING+RUNNING tasks (e.g. 20) checked at enqueue — cheap,
  and honest about the unbuilt ticket system. The sync path is naturally rate-limited by
  the request cycle; revisit when it goes async (D6).

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
| **0. Node-write API split** (prereq, D1–D4) | hadron-server (+ same-day client lifts) | `createNode` / `updateNode` replacing `upsertNode` (removed, no deprecation window); shared internal write core; `id` PK-or-URN selector; `createOnly` flag retired; portal, Go CLI, MCP-internal delegation, and the chrome extension migrated the same day. | — |
| **1. Bus foundation** | hadron-server | `src/lib/bus/` (interface + NATS impl + null fallback), compose `nats` service, env plumbing, boot wiring. No feature code — testable via a throwaway echo subject. | — |
| **2. HTML→Markdown capability** | hadrontool-pdf | `/convert/html-to-markdown` (turndown+gfm, strip pre-pass, `baseUrl`), `/convert/info` advert, tests (incl. round-trip fixture). Deployable independently. | — |
| **3. `importNode` sync path (quick win)** | hadron-server | `importNode` mutation with the inline-`content` path (convert → write core), target/source XOR validation, encrypted-memory + quota gates, `pdfClient.convertHtmlToMarkdown`, the staged 25mb `express.json` limit. **No NATS dependency** — full-HTML clipping works end-to-end after this. | 0, 2 |
| **4. URL async path** | hadron-server | `WebImportTask` model + migration + `WebImportTaskStatus` enum, `url` branch of `importNode`, `webImportTask` query, `src/lib/webFetch.ts` (SSRF-guarded), worker + sweep loop. Ships without abstract generation. | 1, 3 |
| **5. Abstract generation** | hadron-server | `src/lib/llm/` (Vercel AI SDK, provider dispatch), org-walk config resolution, abstract write (`{ id, abstract }` via write core), complete-with-warning semantics — wired into BOTH the sync path and the worker. | 4 |
| **6. Extension migration** | hadron-chrome-extension | Move the clipper off `upsertNode` (removed in Phase 0) onto `importNode` for both modes: Full HTML → inline `content` (sync, immediate result), URL mode → async task + badge/poll on `webImportTask`. The synchronous `runTask` hand-off stays as-is (D12). | 3 (URL-mode polish after 4) |

Phases 0–2 are mutually parallelizable. Phase 3 is the demo-able quick win ("clip an
authenticated page → Markdown node"); Phase 4 adds the server-fetch path. Spec-kit id:
`039-web-page-import` (dir name kept; the surface outgrew "web page" to `importNode` —
rename to `039-node-import` only if the speckit promotion happens).

## 11. Resolved questions (log)

The first draft carried five open questions; all resolved 2026-07-01 with Holger — see §0
for the full decision table. Summary: D7 (org-walk config, not first-row), D8 (replace
semantics, no CREATE_ONLY mode), D9 (encrypted memories out of scope), D10 (JetStream
retention deferred to Phase 1), D11 (extension auth = OAuth, already shipped). Newly
decided in the same session: the `createNode`/`updateNode` split (D1–D4), `importNode`
naming + inline-content scope from issue #457 (D5), sync-now-async-later with object
storage (D6), and the `taskUrn` deferral (D12).

Remaining genuinely open (deferred, not blocking):
- `application/pdf` inline imports (D5 follow-up — clipper-sent PDFs through the tool's
  existing pdf→markdown capability).
- Async inline-content path + Hetzner Object Storage staging (D6 follow-up).
- MCP exposure (`hadron_import_node`) — parked until the web-fetch-tool stub's agent-gating
  discussion converges.
- `taskUrn` post-import processing hand-off (D12 follow-up).
