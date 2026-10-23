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

## PR publishing

When opening pull requests for this repo, open them **ready for review** by
default. Use a draft PR only when the human explicitly asks for a draft, when
the work is intentionally incomplete, or when a known blocker is called out in
the PR body.

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
| `hadron_test` | Vitest's base name. **Parallel mode (default) never reads it** (#1922): each run clones `hadron_test_s<fingerprint>`, a template globalSetup builds from EMPTY for the checkout's schema. Serial mode (`HADRON_TEST_PARALLEL=0`) runs against `hadron_test` itself, rebuilt by `pnpm db:test-setup`. | `holger` | `postgresql://holger@localhost:5432/hadron_test` |
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

## Test-run ownership (#1137)

`HADRON_TEST_RUN_ID` remains the bare vitest main PID. Global setup overwrites
`HADRON_TEST_RUN_SCOPE` from Linux boot identity and PID-namespace device/inode,
then workers inherit it unchanged. Database names and graph roots use the full
scope-plus-PID token; shared loopback or Unix sockets do not establish ownership.
Native non-Linux retains parallel mode in an explicit platform/machine scope with
the existing local-machine assumption. Linux without verifiable `/proc` identity
refuses parallel mode; `HADRON_TEST_PARALLEL=0` remains available.

Automatic cleanup preserves previous-boot, foreign, unknown and legacy names.
Their disk/inode cost is **unbounded**, including old graph roots (#1951).
Manual maintenance must establish quiescence of **all** namespaces sharing the
Postgres endpoint or temporary directory; local PID absence is insufficient.
`db:test-prune-legacy` does not prove ownership and does not collect pid-only
`r<pid>` clones or graph roots. No boot-mismatch deletion rule is authorized.
Keep checkout/venv/probe scratch in a private disk-backed `TMPDIR` when `/tmp`'s
inode limit is tight; never clear another run's files based on local PID absence.

## Common commands

```bash
# Run the test suite (always against hadron_test)
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
| `TEAM_RECORD_KEYRING` | #1615 — team-record codec | unset (record operations unavailable) | JSON with `current` key id and a `keys` map of ids to 64 lowercase hex chars (32 random bytes). Invalid configured values refuse boot without printing the input. Register privately in Doppler dev/prd under AM Q13. Rotate by adding a new key and changing `current`, retain old verification keys while teams re-apply/reseal, then remove old entries. Unknown old key ids yield `TEAM_RECORD_UNVERIFIABLE`; never use an unkeyed fallback. |
| `JWT_SECRET` | `src/auth/jwt.ts` | (none, required for signing) | HS256 secret. Per-host; `.env`-managed. |
| `JWT_EXPIRY` | `src/auth/jwt.ts` | `7d` | jose-style duration string; the GitHub-OAuth callback's Option-C `hadron_token` cookie derives `maxAge` from the issued JWT's `exp` claim (so they expire together). |
| `PORT` | `src/index.ts` | `4000` | Dev server listen port. |
| `FRONTEND_URL` | `src/server.ts` CORS + OAuth redirect | `http://localhost:5173` | Portal origin for cross-origin auth flow. |
| `TEST_PORT` | `prisma/seed.ts` (`'test'` OAuthClient redirectUri) | `4000` | Fixture-time port for Phase-2 OAuth integration tests' mock callback servers. **Distinct from `PORT`** — the dev server doesn't host this callback; Phase 2 tests spin up their own callback receiver and need a redirectUri that matches the seeded `OAuthClient('test')` row. |
| `CLOUDFLARE_IPS_API_URL` / `CLOUDFLARE_IPS_CACHE_PATH` / `HADRON_MULTIPLE_APPS_DOCS_URL` | spec 025 — boot-policy + multi-app docs link | see `src/auth/cloudflare-ips.ts`, `src/mcp/server.ts` | Overrides for the production-hardened trust-proxy fetch + the multi-App-resolved error's docs URL. |
| `RUN_DEFAULT_TOKEN_BUDGET` / `RUN_DEFAULT_ACTION_BUDGET` / `RUN_DEFAULT_TIMEOUT_MS` / `QUOTA_RUNS_PER_DAY_APP` / `QUOTA_RUNS_PER_DAY_ORG` / `QUOTA_TOKENS_PER_DAY_APP` / `QUOTA_TOKENS_PER_DAY_ORG` / `QUOTA_EMAILS_PER_DAY_APP` / `QUOTA_EMAILS_PER_DAY_ORG` / `WEBHOOK_TOKEN_TTL` / `DISABLE_RUN_WORKER` / `DISABLE_SCHEDULER` | spec 040 — headless runs (`src/jobs/appRuns.ts`, `src/jobs/scheduler.ts`, `src/api/webhooks.ts`) | budgets 100k tokens / 50 actions / 120s; quotas 200 & 1k runs/day, 2M & 10M tokens/day, 25 & 100 agent emails/day; hpt TTL `90d`; workers ON | Per-run budgets are seeds; per-App/org quota LIMITS live on the QuotaCounter rows (the env values only seed first touch — operators tune the rows). `DISABLE_RUN_WORKER` also disables the scheduler; `DISABLE_SCHEDULER` disables only the cron loop. |
| `BILLING_DEBIT_ENABLED` / `CREDIT_MARKUP_PERCENT` | spec 046 — usage metering / AI-credit billing Phase 0 (`src/lib/metering/index.ts`) | Debits OFF; markup `0` | `BILLING_DEBIT_ENABLED=true` turns on automatic credit-ledger debits for PLATFORM-KEY LLM spend (`keyOwnerType='HADRON_SERVER'` — BYOK never debits); the pilot stays free while unset even though costs are being recorded. Markup precedence: `AiModelPrice.markupBasisPoints` (per-tier, effective-dated; 2500 = 25%) wins; `CREDIT_MARKUP_PERCENT` (e.g. `25`, fractions OK) is only the fleet-wide fallback for rows without one. Rates live in the `AiModelPrice` table (`setAiModelPrice`, platform admin; micro-cents per MTok, keyed `provider+model+tier+effectiveAt` — tier 1-3 is schema headroom, everything resolves tier 1 today); an unpriced triple yields cost NULL, never a blocked call. Credits are minted with `grantCredits` (platform admin only). |
| `NATS_URL` / `NATS_TOKEN` | spec 039 Phase 1 — platform message bus (`src/lib/bus/index.ts`) | Both unset (bus OFF) | **Optional by design** (D-2026-06-17-004): unset ⇒ `getBusClient()` resolves `null` and features fall back to their DB-backed sweep loops — a missing broker never breaks boot or the API. Dev: `nats://localhost:4222` (compose `nats` service). Alpha: the Docker bridge gateway (NATS runs bare-metal on the host) + the static token once the §9 ops step lands. Test gate: `BUS_TEST_NATS_URL` enables the broker integration tests in `src/lib/bus/bus.test.ts` (CI leaves it unset). |
| `EMBEDDING_BACKEND` | spec 033 — RAG vector retrieval (`src/lib/embedding/index.ts`) | `http` | Selects the embedding-client implementation. `http` (default) uses `EMBEDDING_API_URL` + the HTTP client; `sagemaker` uses the SageMaker Runtime SDK + `EMBEDDING_SAGEMAKER_*` vars. Case-insensitive; an unknown value throws at first call. |
| `EMBEDDING_API_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` / `EMBEDDING_API_KEY` | spec 033 — RAG vector retrieval (`src/lib/embedding/client.ts`) | URL: none (required when `EMBEDDING_BACKEND=http` AND any memory has `vectorIndexEnabled`). MODEL: `nomic-embed-text` (the Ollama tag; serves nomic-embed-text-v1.5). DIM: `768`. KEY: none (optional). | HTTP-backend env vars. Dev: Ollama (`ollama pull nomic-embed-text`, batch endpoint `…/api/embed` → `{embeddings: number[][]}`). The client also accepts the OpenAI `{data:[{embedding}]}` shape and the TEI raw 2D-array shape. `EMBEDDING_MODEL` is sent verbatim to the endpoint (must match the served tag). `EMBEDDING_DIM` MUST equal the pgvector `vector(N)` column dimension (768) or embeds are rejected. No node plaintext leaves Hadron infra (privacy posture, FR-026). |
| `EMBEDDING_SAGEMAKER_ENDPOINT_NAME` / `EMBEDDING_SAGEMAKER_REGION` / `EMBEDDING_SAGEMAKER_INFERENCE_COMPONENT` | spec 033 — SageMaker backend (`src/lib/embedding/client-sagemaker.ts`) | ENDPOINT_NAME: none (required when `EMBEDDING_BACKEND=sagemaker`). REGION: none (required when `EMBEDDING_BACKEND=sagemaker`). INFERENCE_COMPONENT: none (optional, for multi-model endpoints). | Production-path env vars. Hosts `nomic-embed-text-v1.5` on a SageMaker Real-Time Inference endpoint via the HuggingFace TEI container. Privacy posture preserved — AWS-tenant compute, no plaintext to a hosted-inference vendor. **Register in Doppler.** |
| `EMBEDDING_SAGEMAKER_ACCESS_KEY_ID` / `EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY` / `EMBEDDING_SAGEMAKER_SESSION_TOKEN` | spec 033 — SageMaker dedicated credentials (`src/lib/embedding/client-sagemaker.ts`) | All optional. | **Recommended hardening.** When both KEY_ID and SECRET are set, the SageMaker client uses these explicitly — a leaked key only buys `sagemaker:InvokeEndpoint` on the configured endpoint ARN, not whatever the host's default AWS identity can reach. Half-configured pair (only one of the two set) throws at first call. When neither is set, the SDK falls through to its standard credential chain (IAM role on host, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID/SECRET`) — usable for dev / single-tenant deploys where a separate IAM principal isn't worth the Doppler overhead. SESSION_TOKEN is optional (STS path; only needed for temporary credentials). The minimal IAM policy on the dedicated user is `sagemaker:InvokeEndpoint` on `arn:aws:sagemaker:<region>:<account>:endpoint/<endpoint-name>`. |
| `EMBEDDING_PROVIDER` | spec 033 — per-vector lineage label (`Node.embeddingProvider`) | http backend: `local`. sagemaker backend: `aws-sagemaker`. | Stored on every embedded vector for FR-014 future-migration observability (so a platform-wide re-embed can target specific lineages). The default tracks the backend; override to disambiguate multi-tenant deploys (e.g. `mm-prod` vs `hadron-prod`). |
| `MS_EXCHANGE_TOOL_URL` / `MS_EXCHANGE_TOOL_TOKEN` | #396 — email provider tool client (`src/lib/emailClient.ts`) | URL: none (required for any mail operation — unset ⇒ typed `EMAIL_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-ms-exchange` capability tool (alpha: `http://hadrontool-ms-exchange:8080`; token in Doppler on both sides). Mail operations are OWNER-ONLY via `requireEmailConnection` — the ONE shared gate; the future `AgentEmailGrant` swap (spec 002 US3) happens there. Provider dispatch is per-connection (`ExchangeConnection.provider`) via the `PROVIDER_TOOLS` registry. |
| `RESEND_TOOL_URL` / `RESEND_TOOL_TOKEN` / `RESEND_PLATFORM_ORG_IDS` | headless run email capability (`src/lib/resendToolClient.ts`, `src/lib/runner/tools/emailTools.ts`) | URL: none (agent email off; unset ⇒ typed `RESEND_TOOL_NOT_CONFIGURED`). TOKEN: none (optional bearer). PLATFORM_ORG_IDS: empty (platform fallback denied). | Base URL + shared bearer of stateless internal `hadrontool-resend` (alpha: `http://hadrontool-resend:8080`). Normal path: one org-owned `ResendSender` row in core; API key encrypted via tokenCrypto and passed inline only for that request. `hadron_send_email` then enforces policy, app+org `email.send` quotas, and one `comm.outbound` ticket. Only org PKs explicitly listed in `RESEND_PLATFORM_ORG_IDS` may fall back to the sidecar's platform account. **Register URL/token in Doppler (dev + prd); leave fallback empty unless approving a trusted pilot.** |
| `GMAIL_TOOL_URL` / `GMAIL_TOOL_TOKEN` | #580 — email provider tool client (`src/lib/emailClient.ts`, `PROVIDER_TOOLS['gmail']`) | URL: none (required for any Gmail mail operation — unset ⇒ typed `EMAIL_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-gmail` capability tool (alpha: `http://hadrontool-gmail:8080`; token in Doppler on both sides). Same contract, gates, and error surface as the ms-exchange rows — every existing email operation works for `provider: 'gmail'` connections with zero resolver changes (spec 002 US4). **Register in Doppler (dev + prd).** |
| `GMAIL_CLIENT_ID` | #580 — Gmail mailbox-connect authorize URL (`src/integrations/gmail/auth.ts`, `/auth/gmail` trio via `src/integrations/mailboxConnect.ts`) | none (`/auth/gmail` + `/auth/gmail/start` answer 503; Gmail connect is off) | Client id of the MAILBOX GCP project's OAuth client (restricted scopes `gmail.modify` + `gmail.send` + `openid email`) — a DIFFERENT project/client than Sign-in-with-Google's `GOOGLE_CLIENT_ID` (#583 keeps login out of restricted-scope verification). The client SECRET lives only in hadrontool-gmail's Doppler config (the tool does the code exchange). Authorized redirect URI on the client: `${BASE_URL}/auth/gmail/callback` (+ the localhost variant for dev). While the consent screen is in Testing status: 100-user cap, 7-day refresh tokens. |
| `SLACK_TOOL_URL` / `SLACK_TOOL_TOKEN` | spec 043 — Slack tool client (`src/lib/slackClient.ts`) | URL: none (required for any Slack operation — unset ⇒ typed `SLACK_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-slack` capability tool (alpha: `http://hadrontool-slack:8080`; token in Doppler on both sides). The tool's inbound events land at `POST /internal/slack-events` (same `CORE_EVENTS_TOKEN` as email events); dispatch dedupes on `(connectionId, envelopeId)` — the ingress is at-least-once by design (the tool's persist-before-ack inbox). Provider dispatch follows the emailClient `PROVIDER_TOOLS` pattern. **Register in Doppler (dev + prd).** |
| `MCP_TOOL_URL` / `MCP_TOOL_TOKEN` | hadrontool-mcp — external MCP servers as run tools (`src/lib/mcpToolClient.ts`, `src/lib/runner/tools/mcpTools.ts`) | URL: none (required for any external-MCP operation — unset ⇒ typed `MCP_TOOL_NOT_CONFIGURED`). TOKEN: none (optional; sent as bearer when set). | Base URL + shared bearer of the internal `hadrontool-mcp` capability tool — a STATELESS, DB-less conduit that speaks MCP (Streamable HTTP) to registered external servers per request (alpha: `http://hadrontool-mcp:8080`; token in Doppler on both sides). Registered servers live in the org-scoped `McpServer` table (`createMcpServer` etc., org-ADMIN; static headers encrypted via tokenCrypto, write-only); a flow node declares `mcp__<slug>__<tool>` in `data.tools`, and every call walks the policy chain as `tool.mcp__<slug>__<tool>` and costs 1 action. v1 posture: no OAuth to upstream servers, no stateful upstream sessions. **Register in Doppler (dev + prd).** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | #581 — Sign-in-with-Google (`src/auth/google.ts`, `/auth/google` + `/auth/google/callback` in `src/server.ts`) | Both unset (`/auth/google` answers 503; Google login is off) | OAuth client of the LOGIN-ONLY GCP project (scopes `openid email profile` — never add gmail scopes to this client; the Gmail tool (#580) uses a separate client in a separate project, so login never enters restricted-scope verification). Register in Doppler (dev + prd). Authorized redirect URIs on the client: `${BASE_URL}/auth/google/callback` (prod) + `http://localhost:4000/auth/google/callback` (dev). Identity comes from the verified ID-token claims (jose + Google JWKS); email-based account linking requires `email_verified: true`. |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | #584 — Sign in with Apple (`src/auth/apple.ts`, `/auth/apple` + `POST /auth/apple/callback` in `src/server.ts`) | All unset (`/auth/apple` answers 503 unless ALL FOUR are set; Apple login is off) | CLIENT_ID is the Services ID (e.g. `com.hadronmemory.signin`); TEAM_ID + KEY_ID + PRIVATE_KEY (the `.p8` PEM — multi-line in Doppler, `\n`-escaped tolerated) mint the per-request ES256 client-secret JWT (Apple has no static secret). Login-only scopes `name email`; identity from the verified ID token (jose + Apple JWKS); the callback is a form POST (`response_mode=form_post`) and the user's name arrives on FIRST auth only. Apple refuses localhost/http return URLs — dev round-trips need a tunnel with `BASE_URL` set to its origin. Register the return URL `${BASE_URL}/auth/apple/callback` on the Services ID. |
| `CORE_EVENTS_TOKEN` | #396 Phase 4 — email events ingress (`src/api/emailEvents.ts`, `POST /internal/email-events`) | none (unset ⇒ the ingress answers 503; the event plane is off) | Bearer the provider tools present when delivering normalized `email.received` / `email.sent` events (the tool's `CORE_EVENTS_URL` points at this route and carries the same token value). v1 dispatch resolves the connection + logs; consumers (AgentWebhook fan-out, spec-039 bus publish) attach in `dispatchEmailEvent` — agent-pong#1 prerequisite 2. |
| `BASE_URL` | `src/auth/oauth.ts` (`getServerOrigin`) + `src/auth/email.ts` + `src/auth/github.ts` + `src/auth/google.ts` + `src/auth/apple.ts` + `src/integrations/exchange/auth.ts` + `src/mcp/server.ts:getDeploymentInfo` (#187/#190 diagnostics) | OAuth path: per-request `${req.protocol}://${req.get('host')}`. email.ts / github.ts / mcp/server.ts:getDeploymentInfo: `http://localhost:${process.env.PORT \|\| 4000}` (`\|\|` so empty-string falls back — PR-194 review aligned the three). exchange/auth.ts: hardcoded `http://localhost:4000` (no `PORT` lookup). | **Project-wide canonical-origin env var.** Already used by email verification, GitHub OAuth callbacks, Exchange auth, and `/mcp` discovery (spec 025 added OAuth metadata + `/mcp` 401 `WWW-Authenticate`; #187/#190 added the diagnostic surface). **Strongly recommended in production** so every server-emitted absolute URL agrees on the same origin. Without it OAuth-metadata URLs derive from per-request headers, which depends on `trust proxy` + `X-Forwarded-Proto` being honored by every upstream hop — a single misconfigured request can emit `http://` URLs that Codex Desktop refuses to accept (EF-003). **Strict shape on the OAuth path** (`<scheme>://<host>[:<port>]`, lowercase scheme, no trailing slash / path / query / fragment / whitespace / underscore / IPv6 brackets): malformed value throws at boot via the OAuth module's IIFE. The other consumers don't validate; they concat raw. The unset-defaults aren't fully consistent (exchange/auth.ts hardcodes 4000 vs the others honoring PORT); centralizing behind one helper is a known follow-up. If `BASE_URL` is wrong on the OAuth side it's wrong on the others too, so fail-loud is right. |

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

- **Schema**: `prisma/schema.prisma` (Postgres, the only supported
  database). The old SQLite/Postgres toggle's alternate schemas and
  `db:use-*` scripts were removed in #426; `src/integrations/db/provider.ts`
  is the toggle's remaining vestige (a pass-through unless `DB_PROVIDER` is set).
- **Migrations**: `prisma/migrations/<timestamp>_<name>/migration.sql`.
  Hand-edited where Prisma's generator can't express what's needed (the 005
  + 008 migrations both have hand-crafted SQL). The migration directory's
  timestamp is fixed-date by convention (recent migrations all use a
  `YYYYMMDDHHMMSS` prefix typed by hand, not generated).
- **Specs**: the platform law corpus, `hrn:mem:hadronmemory.com:specs`, is the
  source of truth for what the schema and the platform mean. Read a rule with
  `hadron spec get <citation>`. The older Spec Kit trees (the sibling
  `../spec-kits/specs/` and this repo's former `specs/`) are retired history.
  Older code comments still cite them for background, but they are not law (see
  "Specs and the constitution" below).

## Things to know before editing

- **Memory owner invariant**: `class IN ('personal','private') ⇔ user_id IS NOT NULL`.
  Enforced by `chk_personal_visibility_user` (the name predates 035 — it's now
  keyed on `class`, not a `visibility = 'PERSONAL'` value, which no longer
  exists). Set the owner whenever creating a personal/private memory.
- **Memory app_id invariant** (008, 034, #653, #2064;
  `hrn:node:hadronmemory.com:specs:cor:dmo:060:01`): `app_id` is REQUIRED for
  `class='app'`. For `class='system'`, it is NULL on an Agent's own system
  memory and set only on an install memory (`is_install_memory = true`).
  `install_of_agent_id` names that install's Agent while present; it may be
  NULL after erasure detaches the retained App-owned install memory. Other
  classes require `is_install_memory = false` and `install_of_agent_id` NULL.
  `app_id` is OPTIONAL for
  `knowledge`/`group`/`personal`/`private` — set when provisioned inside an App
  (e.g. the `(app_id, user_id)` scope for personal), NULL when **free-standing**
  (created via the CLI or Cowork outside any App). #653 moved `knowledge` +
  `group` from forbidden to optional so those shared classes can attach to an
  App; an app-scoped knowledge/group row is App-internal (excluded from every
  org-wide read/write grant — `getOrgReadableMemoryIds`, `requireMemoryWriteAccess`).
  Enforced by `chk_memory_class_app_id`.
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

## Specs and the constitution

Spec Kit, meaning both the working docs that lived under `specs/` and its
tooling (`.specify/`, the `speckit-*` skills), was retired on 2026-09-22.
Durable contracts live in the platform law corpus,
`hrn:mem:hadronmemory.com:specs`: read the corpus (`hadron spec get <citation>`),
not a plan. The retired docs remain in git history (commit "chore(specs): retire
the Spec Kit working docs").

The server constitution came from Spec Kit and was retired with it. Comments that cite
"Constitution Invariant #N" name the parent Hadron constitution in the sibling
`spec-kits` repo; the server's own refinements remain in git history. The
`no-agent-specific-code` CI guard's exemptions live in
`.github/no-agent-specific-exemptions.txt`.
