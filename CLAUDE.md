# Agent dev guide — hadron-server

## Use of Hadron

Hadron is this project's institutional memory — assume it covers things that aren't
obvious from code alone (past incidents, decisions whose rationale isn't in the code,
conventions baked into several places). Relevant memories:

- `hrn:mem:hadronmemory.com:dev` — findings, conventions, ops, tasks (the routing index)
- `hrn:mem:hadronmemory.com:hadron-server` — newer server findings/conventions
- `hrn:mem:hadronmemory.com:specs` — product specs (loc-as-citation; `hadron spec …`)
- `hrn:mem:hadronmemory.com:hadron-portal` — portal-specific patterns

(1) **Query Hadron before reading project code.** For the topics, entities, and decision
areas in a request, run `hadron_find_nodes` first, then `hadron_get_node` on promising hits.
Cite node `loc` values when you reference what you found.

(2) Call `hadron_get_node` with `urn: "hrn:node:hadronmemory.com:dev:instructions"` to load
the project introduction (what Hadron is, URN grammar, the specs corpus
(`hrn:mem:hadronmemory.com:specs`), core architecture). Read it once per session.

(3) At the start of **every change** — before drafting a plan — call `hadron_get_node` with
`urn: "hrn:node:hadronmemory.com:dev:preflight"`. It's a symptom-to-pattern routing
index into the findings, conventions, and ops branches (portal-specific patterns live in
the `hrn:mem:hadronmemory.com:hadron-portal` memory). Search both
`hrn:mem:hadronmemory.com:dev` and `hrn:mem:hadronmemory.com:hadron-server`.

(4) When a non-obvious finding emerges — a convention you discovered, a gotcha you hit, a
node that turned out to be wrong — capture, fix, or delete it immediately via
`hadron_create_node` / `hadron_update_node` (don't batch to end-of-session; context decays).

(5) The **Hadron CLI is a superset of the MCP tools** — use it as needed, e.g.
`hadron node get hrn:node:hadronmemory.com:dev:preflight`, `hadron spec ls -m hadronmemory.com:specs`.
(A **bare** v2 node URN is ambiguous to the CLI — keep the `hrn:node:` prefix, or pass
`-m <org:memory>` with a bare loc.)
When referring a human to a node, link `https://hadronmemory.com/app/u/<URN>`.

Quick reference for AI agents working in this repo. Updated 2026-06-25.

## Production DB (alpha)

Alpha is the prod host (Debian, Hetzner Oregon). Postgres runs **bare metal**;
Hadron runs in Docker via Komodo. The container no longer ships `psql` and
`DATABASE_URL` is not a plain container env var (only `DOPPLER_TOKEN` is —
Doppler injects the URL at process start). To run an app-user query, fetch the
URL via Doppler and run the **host's** psql against it (keep it in a var so the
password isn't echoed):

```bash
ssh root@alpha   # holger is not in the docker group; root for docker/pg ops
URL=$(docker exec hadron-server sh -c 'doppler run -- printenv DATABASE_URL' | tr -d '\r' | sed 's/host.docker.internal/localhost/')
psql "$URL" -c 'SELECT ...'
# Superuser ops (DDL you don't own, P3009 recovery): sudo -u postgres psql -d hadron
```

Full runbook (SSH accounts, Prisma/P3009 recovery, ownership fixes, Komodo
layout, network notes): [`ops:alpha:db-access`](https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:dev:ops:alpha:db-access).

## Local Postgres setup

The trust boundary is the LX container. The OS user (`root`) and the Postgres
user (`holger`) are intentionally different — that arrangement is fine and
should not be changed.

| DB | Purpose | Owner | Connection string |
|---|---|---|---|
| `hadron` | Local development — **the canonical dev DB.** `.env` `DATABASE_URL` points here; the app, `prisma/seed.ts`, and `prisma db push` all use it. | `holger` | `postgresql://holger@localhost:5432/hadron` |
| `hadron_test` | Vitest test runs (cleared between tests) | `holger` | `postgresql://holger@localhost:5432/hadron_test` |
| `hadron_dev` | **Deprecated / unused.** Older docs + the `db:dev-reset` script pointed here while `.env` actually used `hadron`; that split caused a long-running "phantom drift" confusion. Don't rely on it. | `holger` | `postgresql://holger@localhost:5432/hadron_dev` |

Both `hadron` and `hadron_test` are managed via `prisma db push` (no migration
history on these DBs — `prisma migrate dev/deploy` does not work cleanly because
older migrations reference the dropped `stations` table).

**`.env` (gitignored) is the single source of truth for which DB local dev uses**
— currently `hadron`. It holds the dev `DATABASE_URL` plus per-host secrets
(JWT_SECRET, HADRON_ENCRYPTION_KEY); anything Prisma-related picks it up
automatically. For tests, `vitest.config.ts` pins `DATABASE_URL` to
`hadron_test` regardless of `.env`, so test runs never touch dev data. Keep the
`db:dev-*` scripts following `.env` (don't reintroduce a hardcoded DB name —
that drift is what the deprecated `hadron_dev` row above warns about).

> **Don't run a bare `prisma db push` / `pnpm db:push` against the dev DB.**
> Prisma's schema language can't model the pgvector **HNSW index**
> (`node_embeddings_embedding_hnsw`, created by raw SQL in `post-push.sql`), so
> every `db push` / `migrate diff` reports it as drift and a bare push **drops
> it** (and never rebuilds it). The push can also abort on a "possible data
> loss" prompt for the nullable `users` composite-unique even when no row data
> is at risk — which silently blocks unrelated additive changes behind it. Use
> **`pnpm db:dev-setup`** (push **then** `post-push.sql`, which rebuilds the
> HNSW index) to sync schema without wiping, or **`pnpm db:dev-reset`** for a
> clean wipe + reseed. Both follow `.env`.
>
> `pnpm db:test-setup` rebuilds the `hadron_test` template the same way, and
> needs `--accept-data-loss` for the same reason (added #796): post-push.sql
> also creates the `nodes.tsv` GENERATED column, which Prisma can't model, so a
> push against an established test DB always proposes dropping it and aborts on
> the prompt. Both objects are rebuilt by post-push.sql moments later, and
> neither holds row data — `tsv` is derived from other columns.

## Common commands

```bash
# Run the test suite. Files run in PARALLEL, each vitest worker against its own
# clone of hadron_test (`hadron_test_<VITEST_POOL_ID>`, created lazily from the
# template by src/test/perWorkerDb.ts and dropped at teardown) — ~6-7x faster
# than the old serial mode. `hadron_test` is still the template you build with
# `pnpm db:test-setup`. Set HADRON_TEST_PARALLEL=0 to fall back to the single-DB
# serial mode (e.g. to debug a suspected cross-file ordering issue). A test that
# opens its OWN raw pg connection must read `process.env.DATABASE_URL` (the
# per-worker URL), NOT `TEST_DATABASE_URL`, or it splits across two DBs.
pnpm test

# Typecheck
pnpm tsc --noEmit

# Inspect dev data
psql -U holger -h localhost -d hadron -c '\dt'
psql postgresql://holger@localhost:5432/hadron   # interactive

# Sync the dev DB to the current schema WITHOUT wiping data (push +
# post-push.sql, which rebuilds the HNSW index). Use this instead of a bare
# `pnpm db:push`, which would drop the pgvector index. Works for AI agents.
pnpm db:dev-setup

# Reset + reseed the dev DB from scratch (the human runs this; Prisma blocks
# AI agents from invoking --force-reset without explicit consent)
pnpm db:dev-reset

# Re-seed without resetting (works for AI agents)
DATABASE_URL='postgresql://holger@localhost:5432/hadron' pnpm tsx prisma/seed.ts

# Re-apply CHECK constraints + the pgvector HNSW index after a bare `db push`
# (Prisma's schema language models neither)
psql postgresql://holger@localhost:5432/hadron -v ON_ERROR_STOP=1 -f prisma/post-push.sql

# Restore a PROD snapshot into a SEPARATE local DB (refuses to touch `hadron`).
# Excludes _prisma_migrations; restores as `holger`. Encrypted columns won't
# decrypt locally without the prod key — don't copy it. Add --sync to bring the
# snapshot up to your working schema.prisma.
PROD_DATABASE_URL='postgresql://…prod…' pnpm db:dev-from-prod

# Mint the FIRST hdr_user_* token for a portal-less server (issue #300,
# Option 3 — no browser, no IdP). Requires an EXISTING user; never creates
# one. Identify by exactly one of --email / --user-id / --handle. Runs against
# DATABASE_URL; raw key printed once. After this, `hadron auth token create`
# (hadron-cli#68) covers the rest. Core logic: src/admin/mint-bootstrap-token.ts.
pnpm admin:mint-token --email you@example.com
```

## Common environment variables

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | Prisma client | (none, required) | Per-DB connection string. `.env` sets the dev value; `vitest.config.ts` overrides for tests. |
| `JWT_SECRET` | `src/auth/jwt.ts` | (none, required for signing) | HS256 secret. Per-host; `.env`-managed. |
| `JWT_EXPIRY` | `src/auth/jwt.ts` | `7d` | jose-style duration string; the GitHub-OAuth callback's Option-C `hadron_token` cookie derives `maxAge` from the issued JWT's `exp` claim (so they expire together). |
| `PORT` | `src/index.ts` | `4000` | Dev server listen port. |
| `FRONTEND_URL` | `src/server.ts` CORS + OAuth redirect | `http://localhost:5173` | Portal origin for cross-origin auth flow. |
| `TEST_PORT` | `prisma/seed.ts` (`'test'` OAuthClient redirectUri) | `4000` | Fixture-time port for Phase-2 OAuth integration tests' mock callback servers. **Distinct from `PORT`** — the dev server doesn't host this callback; Phase 2 tests spin up their own callback receiver and need a redirectUri that matches the seeded `OAuthClient('test')` row. |
| `CLOUDFLARE_IPS_API_URL` / `CLOUDFLARE_IPS_CACHE_PATH` / `HADRON_MULTIPLE_APPS_DOCS_URL` | spec 025 — boot-policy + multi-app docs link | see `src/auth/cloudflare-ips.ts`, `src/mcp/server.ts` | Overrides for the production-hardened trust-proxy fetch + the multi-App-resolved error's docs URL. |
| `RUN_DEFAULT_TOKEN_BUDGET` / `RUN_DEFAULT_ACTION_BUDGET` / `RUN_DEFAULT_TIMEOUT_MS` / `QUOTA_RUNS_PER_DAY_APP` / `QUOTA_RUNS_PER_DAY_ORG` / `QUOTA_TOKENS_PER_DAY_APP` / `QUOTA_TOKENS_PER_DAY_ORG` / `QUOTA_SMS_PER_DAY_APP` / `QUOTA_SMS_PER_DAY_ORG` / `WEBHOOK_TOKEN_TTL` / `DISABLE_RUN_WORKER` / `DISABLE_SCHEDULER` | spec 040 — headless runs (`src/jobs/appRuns.ts`, `src/jobs/scheduler.ts`, `src/api/webhooks.ts`) | budgets 100k tokens / 50 actions / 120s; quotas 200 & 1k runs/day, 2M & 10M tokens/day, 50 & 200 SMS/day; hpt TTL `90d`; workers ON | Per-run budgets are seeds; per-App/org quota LIMITS live on the QuotaCounter rows (the env values only seed first touch — operators tune the rows). The SMS counters are deliberately small (internal/staff notifications, not campaigns — the `hadron_send_sms` mass-messaging brake). `DISABLE_RUN_WORKER` also disables the scheduler; `DISABLE_SCHEDULER` disables only the cron loop. |
| `BILLING_DEBIT_ENABLED` / `CREDIT_MARKUP_PERCENT` | spec 046 — usage metering / AI-credit billing Phase 0 (`src/lib/metering/index.ts`) | Debits OFF; markup `0` | `BILLING_DEBIT_ENABLED=true` turns on automatic credit-ledger debits for PLATFORM-KEY LLM spend (`keyOwnerType='HADRON_SERVER'` — BYOK never debits); the pilot stays free while unset even though costs are being recorded. Markup precedence: `AiModelPrice.markupBasisPoints` (per-tier, effective-dated; 2500 = 25%) wins; `CREDIT_MARKUP_PERCENT` (e.g. `25`, fractions OK) is only the fleet-wide fallback for rows without one. Rates live in the `AiModelPrice` table (`setAiModelPrice`, platform admin; micro-cents per MTok, keyed `provider+model+tier+effectiveAt` — tier 1-3 is schema headroom, everything resolves tier 1 today); an unpriced triple yields cost NULL, never a blocked call. Credits are minted with `grantCredits` (platform admin only). |
| `NATS_URL` / `NATS_TOKEN` | spec 039 Phase 1 — platform message bus (`src/lib/bus/index.ts`) | Both unset (bus OFF) | **Optional by design** (D-2026-06-17-004): unset ⇒ `getBusClient()` resolves `null` and features fall back to their DB-backed sweep loops — a missing broker never breaks boot or the API. Dev: `nats://localhost:4222` (compose `nats` service). Alpha: the Docker bridge gateway (NATS runs bare-metal on the host) + the static token once the §9 ops step lands. Test gate: `BUS_TEST_NATS_URL` enables the broker integration tests in `src/lib/bus/bus.test.ts` (CI leaves it unset). |
| `EMBEDDING_BACKEND` | spec 033 — RAG vector retrieval (`src/lib/embedding/index.ts`) | `http` | Selects the embedding-client implementation. `http` (default) uses `EMBEDDING_API_URL` + the HTTP client; `sagemaker` uses the SageMaker Runtime SDK + `EMBEDDING_SAGEMAKER_*` vars. Case-insensitive; an unknown value throws at first call. |
| `EMBEDDING_API_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` / `EMBEDDING_API_KEY` | spec 033 — RAG vector retrieval (`src/lib/embedding/client.ts`) | URL: none (required when `EMBEDDING_BACKEND=http` AND any memory has `vectorIndexEnabled`). MODEL: `nomic-embed-text` (the Ollama tag; serves nomic-embed-text-v1.5). DIM: `768`. KEY: none (optional). | HTTP-backend env vars. Dev: Ollama (`ollama pull nomic-embed-text`, batch endpoint `…/api/embed` → `{embeddings: number[][]}`). The client also accepts the OpenAI `{data:[{embedding}]}` shape and the TEI raw 2D-array shape. `EMBEDDING_MODEL` is sent verbatim to the endpoint (must match the served tag). `EMBEDDING_DIM` MUST equal the pgvector `vector(N)` column dimension (768) or embeds are rejected. No node plaintext leaves Hadron infra (privacy posture, FR-026). |
| `EMBEDDING_SAGEMAKER_ENDPOINT_NAME` / `EMBEDDING_SAGEMAKER_REGION` / `EMBEDDING_SAGEMAKER_INFERENCE_COMPONENT` | spec 033 — SageMaker backend (`src/lib/embedding/client-sagemaker.ts`) | ENDPOINT_NAME: none (required when `EMBEDDING_BACKEND=sagemaker`). REGION: none (required when `EMBEDDING_BACKEND=sagemaker`). INFERENCE_COMPONENT: none (optional, for multi-model endpoints). | Production-path env vars. Hosts `nomic-embed-text-v1.5` on a SageMaker Real-Time Inference endpoint via the HuggingFace TEI container. Privacy posture preserved — AWS-tenant compute, no plaintext to a hosted-inference vendor. **Register in Doppler.** |
| `EMBEDDING_SAGEMAKER_ACCESS_KEY_ID` / `EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY` / `EMBEDDING_SAGEMAKER_SESSION_TOKEN` | spec 033 — SageMaker dedicated credentials (`src/lib/embedding/client-sagemaker.ts`) | All optional. | **Recommended hardening.** When both KEY_ID and SECRET are set, the SageMaker client uses these explicitly — a leaked key only buys `sagemaker:InvokeEndpoint` on the configured endpoint ARN, not whatever the host's default AWS identity can reach. Half-configured pair (only one of the two set) throws at first call. When neither is set, the SDK falls through to its standard credential chain (IAM role on host, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID/SECRET`) — usable for dev / single-tenant deploys where a separate IAM principal isn't worth the Doppler overhead. SESSION_TOKEN is optional (STS path; only needed for temporary credentials). The minimal IAM policy on the dedicated user is `sagemaker:InvokeEndpoint` on `arn:aws:sagemaker:<region>:<account>:endpoint/<endpoint-name>`. |
| `EMBEDDING_PROVIDER` | spec 033 — per-vector lineage label (`Node.embeddingProvider`) | http backend: `local`. sagemaker backend: `aws-sagemaker`. | Stored on every embedded vector for FR-014 future-migration observability (so a platform-wide re-embed can target specific lineages). The default tracks the backend; override to disambiguate multi-tenant deploys (e.g. `mm-prod` vs `hadron-prod`). |
| `MS_EXCHANGE_TOOL_URL` / `MS_EXCHANGE_TOOL_TOKEN` | #396 — email provider tool client (`src/lib/emailClient.ts`) | URL: none (required for any mail operation — unset ⇒ typed `EMAIL_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-ms-exchange` capability tool (alpha: `http://hadrontool-ms-exchange:8080`; token in Doppler on both sides). Mail operations are OWNER-ONLY via `requireEmailConnection` — the ONE shared gate; the future `AgentEmailGrant` swap (spec 002 US3) happens there. Provider dispatch is per-connection (`ExchangeConnection.provider`) via the `PROVIDER_TOOLS` registry. |
| `GMAIL_TOOL_URL` / `GMAIL_TOOL_TOKEN` | #580 — email provider tool client (`src/lib/emailClient.ts`, `PROVIDER_TOOLS['gmail']`) | URL: none (required for any Gmail mail operation — unset ⇒ typed `EMAIL_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-gmail` capability tool (alpha: `http://hadrontool-gmail:8080`; token in Doppler on both sides). Same contract, gates, and error surface as the ms-exchange rows — every existing email operation works for `provider: 'gmail'` connections with zero resolver changes (spec 002 US4). **Register in Doppler (dev + prd).** |
| `GMAIL_CLIENT_ID` | #580 — Gmail mailbox-connect authorize URL (`src/integrations/gmail/auth.ts`, `/auth/gmail` trio via `src/integrations/mailboxConnect.ts`) | none (`/auth/gmail` + `/auth/gmail/start` answer 503; Gmail connect is off) | Client id of the MAILBOX GCP project's OAuth client (restricted scopes `gmail.modify` + `gmail.send` + `openid email`) — a DIFFERENT project/client than Sign-in-with-Google's `GOOGLE_CLIENT_ID` (#583 keeps login out of restricted-scope verification). The client SECRET lives only in hadrontool-gmail's Doppler config (the tool does the code exchange). Authorized redirect URI on the client: `${BASE_URL}/auth/gmail/callback` (+ the localhost variant for dev). While the consent screen is in Testing status: 100-user cap, 7-day refresh tokens. |
| `GOOGLE_CAL_TOOL_URL` / `GOOGLE_CAL_TOOL_TOKEN` | hadrontool-google-cal — calendar provider tool client (`src/lib/emailClient.ts`, `PROVIDER_TOOLS['google-cal']`) | URL: none (required for any Google Calendar operation — unset ⇒ typed `EMAIL_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-google-cal` capability tool (alpha: `http://hadrontool-google-cal:8080`; token in Doppler on both sides). Calendar connections are `ExchangeConnection` rows with `provider: 'google-cal'` on the same owner-only + ConnectionGrant gate as mail (`requireEmailConnection`); read ops map to `calendar.read`/`calendar.freebusy` grant scopes, mutations are owner-only (unmapped, fail-closed). The tool is internal-only in v1 (no event plane). **Register in Doppler (dev + prd).** |
| `GOOGLE_DRIVE_TOOL_URL` / `GOOGLE_DRIVE_TOOL_TOKEN` | #749 — drive provider tool client (`src/lib/emailClient.ts`, `PROVIDER_TOOLS['google-drive']`) | URL: none (required for any Drive operation — unset ⇒ typed `EMAIL_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-google-drive` capability tool (alpha: `http://hadrontool-google-drive:8080`; token in Doppler on both sides). Drive connections are `ExchangeConnection` rows with `provider: 'google-drive'` on the same owner-only + ConnectionGrant gate as mail/calendar (`requireEmailConnection`); read ops (`list-files`/`search-files`/`get-file`/`export-file`/`download-file`) map to the `drive.read` grant scope, the one mutation (`create-doc`, reached via `exportNodeToGoogleDoc`) is owner-only (unmapped, fail-closed). Run tools `drive_search`/`drive_get_file`/`drive_export_file` (cost 0, reads). No event plane in v1. **Register in Doppler (dev + prd).** |
| `GOOGLE_DRIVE_CLIENT_ID` | #749 — Drive-connect authorize URL (`src/integrations/googleDrive/auth.ts`, `/auth/google-drive` trio via `src/integrations/mailboxConnect.ts`) | none (`/auth/google-drive` + `/auth/google-drive/start` answer 503; Drive connect is off) | Client id of the DRIVE OAuth client (RESTRICTED scope `drive.readonly` + `drive.file` + `openid email profile`) — a DIFFERENT client than Sign-in-with-Google (`GOOGLE_CLIENT_ID`), the Gmail client (`GMAIL_CLIENT_ID`), and the Calendar client (`GOOGLE_CAL_CLIENT_ID`): drive.readonly is Gmail-tier restricted (CASA — #750 tracks the assessment + the possible shared-client-with-Gmail decision, to be made BEFORE Gmail's verification is submitted). The client SECRET lives only in hadrontool-google-drive's Doppler config (the tool does the code exchange). Authorized redirect URI on the client: `${BASE_URL}/auth/google-drive/callback` (+ the localhost variant for dev). Testing status: 100-user cap, 7-day refresh tokens. |
| `GOOGLE_CAL_CLIENT_ID` | hadrontool-google-cal — calendar-connect authorize URL (`src/integrations/googleCal/auth.ts`, `/auth/google-cal` trio via `src/integrations/mailboxConnect.ts`) | none (`/auth/google-cal` + `/auth/google-cal/start` answer 503; calendar connect is off) | Client id of the CALENDAR OAuth client (sensitive scopes `calendar.events` + `calendar.readonly` + `openid email profile`) — a DIFFERENT client than both Sign-in-with-Google's `GOOGLE_CLIENT_ID` (login carries no API scopes, #583) and the Gmail client `GMAIL_CLIENT_ID` (adding calendar scopes to the verified restricted-scope Gmail client would re-open its review). The client SECRET lives only in hadrontool-google-cal's Doppler config (the tool does the code exchange). Authorized redirect URI on the client: `${BASE_URL}/auth/google-cal/callback` (+ the localhost variant for dev). Testing status: 100-user cap, 7-day refresh tokens. |
| `SLACK_TOOL_URL` / `SLACK_TOOL_TOKEN` | spec 043 — Slack tool client (`src/lib/slackClient.ts`) | URL: none (required for any Slack operation — unset ⇒ typed `SLACK_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-slack` capability tool (alpha: `http://hadrontool-slack:8080`; token in Doppler on both sides). The tool's inbound events land at `POST /internal/slack-events` (same `CORE_EVENTS_TOKEN` as email events); dispatch dedupes on `(connectionId, envelopeId)` — the ingress is at-least-once by design (the tool's persist-before-ack inbox). Provider dispatch follows the emailClient `PROVIDER_TOOLS` pattern. **Register in Doppler (dev + prd).** |
| `TWILIO_TOOL_URL` / `TWILIO_TOOL_TOKEN` | hadrontool-twilio — SMS run tool (`src/lib/smsClient.ts`, `src/lib/runner/tools/smsTools.ts`) | URL: none (required for any SMS send — unset ⇒ typed `SMS_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-twilio` capability tool — a STATELESS, DB-less conduit to the Twilio REST API; the platform Twilio account lives in the TOOL's Doppler, not core (alpha: `http://hadrontool-twilio:8080`; token in Doppler on both sides). One run tool: `hadron_send_sms` (outbound only, v1) — every send walks the policy chain as `tool.hadron_send_sms` (cost 1), consumes `sms.send` daily quota at BOTH app and org scope, and burns one `comm.outbound` ActionTicket (cor:acl:050:04 — outbound communication never happens off-ledger). Sends are never auto-retried (no idempotency ledger; a retry can double-message a human). Intent: internal/staff notifications — enforced by quotas, not rules. The tool's contract carries a BYO inline-credentials seam (unused by core v1; a deferred org-scoped registry lands with zero tool changes). **Register in Doppler (dev + prd).** |
| `MCP_TOOL_URL` / `MCP_TOOL_TOKEN` | hadrontool-mcp — external MCP servers as run tools (`src/lib/mcpToolClient.ts`, `src/lib/runner/tools/mcpTools.ts`) | URL: none (required for any external-MCP operation — unset ⇒ typed `MCP_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-mcp` capability tool — a STATELESS, DB-less conduit that speaks MCP (Streamable HTTP) to registered external servers per request (alpha: `http://hadrontool-mcp:8080`; token in Doppler on both sides). Registered servers live in the org-scoped `McpServer` table (`createMcpServer` etc., org-ADMIN; static headers encrypted via tokenCrypto, write-only); a flow node declares `mcp__<slug>__<tool>` in `data.tools`, and every call walks the policy chain as `tool.mcp__<slug>__<tool>` and costs 1 action. v1 posture: no OAuth to upstream servers, no stateful upstream sessions. **Register in Doppler (dev + prd).** |
| `WEBFETCH_TOOL_URL` / `WEBFETCH_TOOL_TOKEN` | #628/#667 — web fetch/request + polling client (`src/lib/webfetchClient.ts`; run tools in `src/lib/runner/tools/webTools.ts` and `webPollTools.ts`) | URL: none (required for any web operation — unset ⇒ typed `WEBFETCH_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-webfetch` capability tool (alpha: `http://hadrontool-webfetch:8080`; token in Doppler on both sides). The `/ops` plane remains stateless (`fetch-url` / `check-url` / `http-request`) and the client performs exactly one request per call with no retries. The `/polls` plane owns durable GET-only watch state, schedules, condition evaluation, snapshots, and delivery retries; core owns authorization, the immutable job→origin-run routing binding, and `/internal/webfetch-events`. `web_poll_start` / `cancel` / `list` share policy action `tool.web_poll`; start/cancel cost 1 and list costs 0. Optional credentials come from a readable node via `credentialsNodeUrn`: core enforces its origin/path `urlPrefix`, decrypts auth once, and passes it inline only at job creation. **Register in Doppler (dev + prd).** |
| `WEBSEARCH_TOOL_URL` / `WEBSEARCH_TOOL_TOKEN` / `WEBSEARCH_PROVIDER` / `WEBSEARCH_PROVIDER_API_KEY` / `WEBSEARCH_PROVIDER_AUTH` / `WEBSEARCH_PROVIDER_HEADER` | #647 (specs `cor:web:020*`) — stateless web **search** tool client (`src/lib/webSearchClient.ts`; run tool `web_search` in `src/lib/runner/tools/searchTools.ts`) | TOOL_URL: none (required for any search — unset ⇒ typed `WEBSEARCH_TOOL_NOT_CONFIGURED`). TOOL_TOKEN: none (optional; internal-plane bearer when set). PROVIDER / PROVIDER_API_KEY: none (optional; when the key is unset core sends NO credential and the tool answers from its own provider relationship). PROVIDER_AUTH: `bearer` (default) \| `header`. PROVIDER_HEADER: none (required when PROVIDER_AUTH=`header`, e.g. `X-Subscription-Token`). | Base URL + internal-plane bearer of the internal, **stateless** `hadrontool-websearch` capability tool (alpha: `http://hadrontool-websearch:8080`; token in Doppler on both sides) — a SEPARATE capability + SEPARATE tool from web fetch/request (#628), gated under its own `tool.web_search` handle. Single op, `POST /ops/search`, speaking the versioned **provider-agnostic contract** (`web-search@1`): request = query + generic refinements (count/freshness/locale) + opaque provider options → ordered `{title,url,snippet,rank}` tagged `source:'external'`. Callers depend only on the envelope, never on which provider answered, so a conforming tool is swappable. Destinations are NOT caller-supplied — a request names a PROVIDER the tool resolves from its own allowlist (materially lower SSRF risk than fetch; no connection-pinning; `cor:web:020:02`). `web_search` is cost **0** (a GET-idempotent read returning references — retry-safe; the search tool never fetches result pages, core orchestrates `search → choose → fetch` via #628). **Provider credential is core-sourced** (`providerCredentialFromEnv`) and passed **inline per request** via `auth` (bearer/named-header — never a URL query param, never stored in the tool); the org-scoped multi-provider trust-tier registry + the shared conformance-fixture harness (`cor:web:020:01/02`) are the deferred follow-ups. **Register in Doppler (dev + prd).** |
| `HA_TOOL_URL` / `HA_TOOL_TOKEN` | hadrontool-home-assistant — Home Assistant ops as run tools (#640; `src/lib/haToolClient.ts`, `src/lib/homeAssistant.ts`, `src/lib/runner/tools/haTools.ts`) | URL: none (required for any Home Assistant operation — unset ⇒ typed `HA_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-home-assistant` capability tool — a STATELESS, DB-less bridge that speaks the HA REST API per request (alpha: `http://hadrontool-home-assistant:8080`; token in Doppler on both sides). Registered instances live in the org-scoped `HomeAssistantInstance` table (`createHomeAssistantInstance` etc., org-ADMIN; long-lived access token encrypted via tokenCrypto, write-only; `opAllowlist` over the CLOSED six-op catalog in `HA_OPS` — call_service/get_state/list_states/render_template/fire_event/list_services — permits read-only registrations); a flow node declares `ha__<slug>__<op>` in `data.tools`, every call walks the policy chain as `tool.ha__<slug>__<op>` and costs 1 action (even reads — Holger 2026-07-12). Tool-side `HA_TOOL_ALLOW_PRIVATE_NETWORKS=true` is a SUPPORTED self-hosted posture (Hadron next to HA on one LAN); the hosted platform leaves it unset. v1: no event plane (the ha-hadron HA custom component covers inbound), no OAuth. **Register in Doppler (dev + prd).** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | #581 — Sign-in-with-Google (`src/auth/google.ts`, `/auth/google` + `/auth/google/callback` in `src/server.ts`) | Both unset (`/auth/google` answers 503; Google login is off) | OAuth client of the LOGIN-ONLY GCP project (scopes `openid email profile` — never add gmail scopes to this client; the Gmail tool (#580) uses a separate client in a separate project, so login never enters restricted-scope verification). Register in Doppler (dev + prd). Authorized redirect URIs on the client: `${BASE_URL}/auth/google/callback` (prod) + `http://localhost:4000/auth/google/callback` (dev). Identity comes from the verified ID-token claims (jose + Google JWKS); email-based account linking requires `email_verified: true`. |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | #584 — Sign in with Apple (`src/auth/apple.ts`, `/auth/apple` + `POST /auth/apple/callback` in `src/server.ts`) | All unset (`/auth/apple` answers 503 unless ALL FOUR are set; Apple login is off) | CLIENT_ID is the Services ID (e.g. `com.hadronmemory.signin`); TEAM_ID + KEY_ID + PRIVATE_KEY (the `.p8` PEM — multi-line in Doppler, `\n`-escaped tolerated) mint the per-request ES256 client-secret JWT (Apple has no static secret). Login-only scopes `name email`; identity from the verified ID token (jose + Apple JWKS); the callback is a form POST (`response_mode=form_post`) and the user's name arrives on FIRST auth only. Apple refuses localhost/http return URLs — dev round-trips need a tunnel with `BASE_URL` set to its origin. Register the return URL `${BASE_URL}/auth/apple/callback` on the Services ID. |
| `REVIEW_DEMO_EMAIL` / `REVIEW_DEMO_CODE` | App Review demo bypass (`src/auth/oauth.ts` — email-entry + `/oauth/authorize/email/code`) | Both unset (bypass does not exist) | ACTIVE only when BOTH are set: the OAuth email-entry page, for exactly this address (case-insensitive), sends no mail and instead renders a code-entry form; the correct code (constant-time compare, failure-counting 10/15min/IP limiter) signs into the EXISTING user with that email — never auto-creates; every failure shape is one generic 400. Purpose: Apple App Review access on a password-less platform (Holger 2026-07-27 — curated, trackable reviewer account). Keep the demo account permission-minimal. **Register in Doppler (prd) only while an app review is in flight; unset afterwards.** |
| `DEV_LOGIN_ENABLED` | #792 — dev-only login endpoint (`src/auth/devLogin.ts`, `GET /auth/dev/login`) | unset (endpoint answers as a nonexistent route) | `true` enables one-navigation sign-in as an EXISTING user (`?email=…&redirect=…`) via the #477 handoff path — for local agent browser-driving and E2E, no Resend side effects. Triple-gated per-request: flag AND `NODE_ENV !== 'production'` AND genuinely-local connection (loopback TCP peer via `req.socket.remoteAddress` — a LAN peer can forge `Host: localhost` — plus raw `Host` header localhost/127.0.0.1, not `req.hostname`, which honors `X-Forwarded-Host`); any gate failure falls through to Express's default 404. Never auto-creates users; the handoff code is unbound (no #505 fixation binding — localhost-only makes that acceptable). **NEVER set in a deployed env / never register in Doppler.** |
| `CORE_EVENTS_TOKEN` | #396/#667 — internal provider-event ingress (`POST /internal/email-events`, `/internal/slack-events`, `/internal/webfetch-events`) | none (unset ⇒ each ingress answers 503; its event plane is off) | Shared bearer presented by capability tools when delivering normalized events. Webfetch poll events are deduped on `(jobId,snapshotHash,kind)`, validated against the immutable core routing binding, and acknowledged only after an INTEGRATION AppRun plus completed-dispatch receipt are durable; external excerpts are framed as untrusted content before entering run data. |
| `BASE_URL` | `src/auth/oauth.ts` (`getServerOrigin`) + `src/auth/email.ts` + `src/auth/github.ts` + `src/auth/google.ts` + `src/auth/apple.ts` + `src/integrations/exchange/auth.ts` + `src/mcp/server.ts:getDeploymentInfo` (#187/#190 diagnostics) | OAuth path: per-request `${req.protocol}://${req.get('host')}`. email.ts / github.ts / mcp/server.ts:getDeploymentInfo: `http://localhost:${process.env.PORT \|\| 4000}` (`\|\|` so empty-string falls back — PR-194 review aligned the three). exchange/auth.ts: hardcoded `http://localhost:4000` (no `PORT` lookup). | **Project-wide canonical-origin env var.** Already used by email verification, GitHub OAuth callbacks, Exchange auth, and `/mcp` discovery (spec 025 added OAuth metadata + `/mcp` 401 `WWW-Authenticate`; #187/#190 added the diagnostic surface). **Strongly recommended in production** so every server-emitted absolute URL agrees on the same origin. Without it OAuth-metadata URLs derive from per-request headers, which depends on `trust proxy` + `X-Forwarded-Proto` being honored by every upstream hop — a single misconfigured request can emit `http://` URLs that Claude Desktop refuses to accept (EF-003). **Strict shape on the OAuth path** (`<scheme>://<host>[:<port>]`, lowercase scheme, no trailing slash / path / query / fragment / whitespace / underscore / IPv6 brackets): malformed value throws at boot via the OAuth module's IIFE. The other consumers don't validate; they concat raw. The unset-defaults aren't fully consistent (exchange/auth.ts hardcodes 4000 vs the others honoring PORT); centralizing behind one helper is a known follow-up. If `BASE_URL` is wrong on the OAuth side it's wrong on the others too, so fail-loud is right. |

## Seed fixtures (post-008-agent-installation)

`prisma/seed.ts` is anonymized — no real PII. The fixture set is built around
the spec-008 narrative scenarios so portal sessions can demonstrate the
two-layer model without further setup:

- **Mealplan @ Acme** — single-org install (`memberRoles: owner/cook/eater`,
  `maxMembers: unlimited`). Members: bob (owner), alice (cook).
- **Juno @ Mentor Co** + **Juno @ Client Co** — multi-install: same Juno agent,
  two different Apps in two different Orgs, same end-user (mike) in both.
  Demonstrates the `(app_id, user_id)` personal-memory isolation that 008
  hangs on.
- All three Apps print their raw `hdr_app_…` keys at the end of `seed.ts`
  output for paste-into-portal.

## Where things live

- **Schema**: `prisma/schema.prisma` (Postgres). The other two `.prisma`
  files are stale leftovers from a Postgres/SQLite toggle that's no longer
  maintained.
- **Migrations**: `prisma/migrations/<timestamp>_<name>/migration.sql`.
  Hand-edited where Prisma's generator can't express what's needed (the 005
  + 008 migrations both have hand-crafted SQL). The migration directory's
  timestamp is fixed-date by convention (recent migrations all use a
  `YYYYMMDDHHMMSS` prefix typed by hand, not generated).
- **Spec kits**: `../spec-kits/specs/<NNN>-<name>/` (sibling repo). Read
  `spec.md` first, then `plan.md`, then `tasks.md`. The spec corpus is the
  source of truth for what the schema means.

## Things to know before editing

- **Memory owner invariant**: `class IN ('personal','private') ⇔ user_id IS NOT NULL`.
  Enforced by `chk_personal_visibility_user` (the name predates 035 — it's now
  keyed on `class`, not a `visibility = 'PERSONAL'` value, which no longer
  exists). Set the owner whenever creating a personal/private memory.
- **Memory app_id invariant** (008, relaxed by 034 and #653): `app_id` is
  REQUIRED for `class='app'`, FORBIDDEN for `class='system'` (an agent's own
  definition is never app-scoped), and OPTIONAL for
  `knowledge`/`group`/`personal`/`private` — set when provisioned inside an App
  (e.g. the `(app_id, user_id)` scope for personal), NULL when **free-standing**
  (created via the CLI or Cowork outside any App). #653 moved `knowledge` +
  `group` from forbidden to optional so those shared classes can attach to an
  App. Enforced by `chk_memory_class_app_id`.
  The agent (`user_memory_of_agent_id`) is required for personal/private only
  when `app_id` is set (`chk_memory_personal_agent_id`). **MCP gate:**
  `canReadMemory` / `canWriteToMemory` treat a free-standing row (app_id + agent
  both NULL) as owner-only and short-circuit the App-isolation checks.
- **Composite-PK models** (`AgentSubscription`, `AppMember`, `AgentImport`,
  `AgentOrgGrant`) have no `id` column. The Prisma client extension at
  `src/integrations/db/client.ts` keeps these out of the auto-id-injection
  list — add new composite-PK models to `MODELS_WITHOUT_ID` there.

## Authorization invariants

Access-control bugs here are **cross-tenant leaks, not cosmetic**. When a change
touches a read/list/resolve surface or an auth gate, hold these invariants —
they are **first-class review criteria**, not "general security" to defer:

- **Reuse the shared access gate; a bespoke per-resolver gate drifts.** Route
  reads through `getAccessibleMemoryIds` / `memoryAccessFilter` / `requireOrgRole`
  (or delegate to the resolver that already does). A hand-rolled admin-or-member
  check falls out of sync with the shared predicates — `effectiveAccess` is the
  tell (READ ✓ there but `Forbidden` in a per-kind query ⇒ the gate drifted). (#362)
- **Honor every `visibility` value on every read surface.** If an entity's
  visibility enum has `PUBLIC`, then `<entity>(ref:)`, the list query, and
  `resolveUrn` must **all** honor it — the memory and agent surfaces stay in
  parity rather than each hand-rolling a gate. (#362 / #551)
- **Relaxing a read gate re-derives the whole field surface it admits.** A
  GraphQL field that returns **another entity's object** hands the caller that
  entity's field resolvers, which assume the *outer* query already authorized
  them and do **not** re-check (`App.keys` / `App.members` don't). So widening a
  parent's read gate (a `PUBLIC` branch, a cross-org list) silently exposes every
  nested object reachable through it. Scope such fields to the caller's **own**
  access (e.g. `getMemberOrgIds`) or return a sanitized projection; never lean on
  the parent gate to protect a child entity's secrets. Distinguish the entity's
  OWN data (may be public by design) from OTHER tenants' identity/secrets
  (never). (#552)
- **Revoked membership must not authorize.** Use `findFirst` + `deletedAt: null`
  on the composite-PK `OrgMember` (a `findUnique` can't filter `deletedAt`), per
  `requireOrgRole`. (PR #475)

The Hadron review flow (`hrn:node:hadronmemory.com:hadron-server:review`) carries the
runnable checklists for these; the `findings:` branch has the incidents.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
[specs/036-ai-service-config/plan.md](specs/036-ai-service-config/plan.md)
<!-- SPECKIT END -->
