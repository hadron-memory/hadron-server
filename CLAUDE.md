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
# App-user query: DATABASE_URL, the SERVE credential
URL=$(docker exec hadron-server sh -c 'doppler run -- printenv DATABASE_URL' | tr -d '\r' | sed 's/host.docker.internal/localhost/')
psql "$URL" -c 'SELECT ...'
# Owner work (migrate, P3009 recovery, ownership fixes, DDL): MIGRATE_DATABASE_URL, the OWNER credential
# (a key that exists in Doppler only after the cutover's config step; until then use the `hadron` URL above)
OWNER_URL=$(docker exec hadron-server sh -c 'doppler run -- printenv MIGRATE_DATABASE_URL' | tr -d '\r' | sed 's/host.docker.internal/localhost/')
# Superuser only for what needs one (CREATE EXTENSION, creating the serve role): sudo -u postgres psql -d hadron
```

### Two credentials (#2413)

The server image boots through `scripts/docker-start.sh`: it runs `prisma generate`,
`prisma migrate deploy`, the post-migrate revoke of the serve role's grant on
`_prisma_migrations`, and the runtime-role verifier **as the owner**
(`MIGRATE_DATABASE_URL`), then starts the server under `DATABASE_URL` with
`MIGRATE_DATABASE_URL` unset. The grants for the serve role (default name
`hadron_app`, override with `RUNTIME_ROLE_NAME`) live in `prisma/runtime-role.sql`;
CI proves a non-owner role can serve in the `serve-role-smoke` lane
(`.github/workflows/migration-smoke-test.yml`).

**Where production stands.** The repo side is merged (S1 #2451, S2 #2453, S3 #2454), but the
production cutover has **not** happened: Doppler `prd` has no `MIGRATE_DATABASE_URL` yet, so the
container boots in the legacy single-role mode and logs `db.runtime_role.owner_serving`, and
`DATABASE_URL` is still the owner (`hadron`) URL. R1 (the second, catalog-only production
read) is NOT done, and R4 (the cutover window that moves `DATABASE_URL` to the serve role) is
NOT done. Each needs its own register grant; do not run either on the strength of this
guide. Never put the owner URL into `DATABASE_URL` yourself: restoring it after a
cutover is the rollback in the runbook, and also needs a grant.

Which URL each procedure uses (after the cutover; before it both are the owner URL):

| Procedure | URL |
|---|---|
| App-user query (snippet above), `scripts/dev-from-prod-snapshot.sh` (SELECT only), every hand-run job under `src/jobs` | `DATABASE_URL` (serve) |
| `prisma migrate deploy`, `prisma migrate resolve` (P3009 recovery) | `MIGRATE_DATABASE_URL` (owner) |
| Ownership fixes (`ALTER ... OWNER TO hadron`) and any hand-run DDL | `MIGRATE_DATABASE_URL` (owner) |
| `psql "$MIGRATE_DATABASE_URL" -f prisma/runtime-role.sql`, `pnpm tsx scripts/db/verify-runtime-role.ts` | `MIGRATE_DATABASE_URL` (owner) |

Recovery DDL starts as the owner (`SET ROLE hadron;` or the owner URL); use `postgres` only for
objects that need a superuser, then `ALTER ... OWNER TO hadron`. Run `runtime-role.sql` as the
owner, never as `postgres`: its default privileges attach to whichever role runs it, and the
owner must stay the only creator of tables. The file refuses a serve role that is the runner,
is a superuser, or is a member of the owner (or the reverse); it does not create the role.

Full runbook (SSH accounts, Prisma/P3009 recovery, ownership fixes, Komodo
layout, network notes): [`ops:alpha:db-access`](https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:dev:ops:alpha:db-access).

## Local Postgres setup

The trust boundary is the LX container. The OS user (`root`) and the Postgres
user (`holger`) are intentionally different — that arrangement is fine and
should not be changed.

Local dev, the test databases and the disposable E2E stacks run **single-role**: `holger` owns
and serves, `.env` holds only `DATABASE_URL`, and `MIGRATE_DATABASE_URL` stays unset (the
entrypoint's legacy mode; `pnpm db:dev-setup`, `db:dev-reset` and the test harness never read it).
The owner/serve split is exercised in CI, not locally, and in production after the cutover; see
"Two credentials" under Production DB.

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
>
> **Test databases are built from empty, per schema (#1922).** Pushing one
> checkout's schema over a database another checkout built mixes two versions:
> an older push silently drops newer columns, and no push removes the newer
> branch's raw-SQL triggers and functions. So parallel runs clone
> `hadron_test_s<fingerprint>`, which globalSetup builds from `template0`. The
> fingerprint (`src/test/schemaTemplate.ts`) covers `schema.prisma`, every
> `prisma/*.sql` and the Prisma version. It is built once per fingerprint
> (about 5s), reused after that, and dropped after 7 idle days. `pnpm
> db:test-setup` is only for serial mode: it empties `public`, rebuilds, and
> stamps the fingerprint, and a serial run refuses a base stamped for another
> schema. Never push into a test template by hand.

## Disposable E2E stacks

For isolated QA on a fresh seeded DB, see [`scripts/e2e/README.md`](scripts/e2e/README.md).
`./scripts/e2e/stack.sh up <worker> <api-port> <portal-port>` creates a private
stack; `down <worker>` tears down only that stack. It never uses the canonical
dev DB or `hadron_test`. Use distinct names and ports for concurrent stacks.

## Common commands

```bash
# Run the test suite. Files run in PARALLEL, each vitest worker against its own
# clone (`hadron_test_r<scope>_p<pid>_<poolId>`, created lazily by
# src/test/perWorkerDb.ts and dropped at teardown) — ~6-7x faster than the old
# serial mode. The clones come from `hadron_test_s<fingerprint>`, which
# globalSetup builds from empty for this checkout's schema (#1922), so no setup
# step is needed. Set HADRON_TEST_PARALLEL=0 to fall back to the single-DB
# serial mode (e.g. to debug a suspected cross-file ordering issue); that mode
# needs `pnpm db:test-setup` after any schema change. A test that
# opens its OWN raw pg connection must read `process.env.DATABASE_URL` (the
# per-worker URL), NOT `TEST_DATABASE_URL`, or it splits across two DBs.
#
# #1137: HADRON_TEST_RUN_ID remains the bare vitest-main PID. globalSetup
# overwrites HADRON_TEST_RUN_SCOPE from Linux boot identity + PID namespace
# device/inode; workers inherit it unchanged. DBs use
# `<base>_r<scope>_p<pid>_<pool|tpl>` and graph roots use
# `<tmpdir>/hadron-test-graph-runs/r<scope>_p<pid>`. Shared loopback or Unix
# sockets do not prove PID-namespace locality. Native non-Linux uses an explicit
# platform/machine scope with the existing local-machine assumption. Unverifiable
# Linux parallel mode refuses; serial mode uses an unknown, non-collectible scope.
#
# Automatic cleanup selects only the exact own token, or a provably dead PID
# in the same verified scope. Prior-boot, foreign, unknown and legacy DBs/roots
# are preserved: crashed runs can accumulate WITHOUT BOUND in disk/inode use.
# Legacy graph roots retain the #1951 inode risk. Manual removal requires ALL
# namespaces sharing that Postgres/tmpdir to be quiescent, not local PID absence.
# The legacy-prune tool below is not proof of that quiescence and does not
# collect pid-only r<pid> clones or old graph roots. No automatic boot-mismatch
# deletion rule exists. Use a private disk-backed TMPDIR for checkouts/fixtures
# when the host's tmpfs inode cap is tight.
#
# On a shared host, cap the forks (each holds its own Postgres clone) with
# HADRON_TEST_MAX_WORKERS=<positive int>. Unset keeps vitest's default; an
# invalid value warns and keeps it too (src/test/dbWorkers.ts testMaxWorkers).
pnpm test

# Drop pre-#1091 `hadron_test_<n>` clones (from a checkout older than run-scoped
# names). The automated sweep leaves these alone on purpose — it can prove a
# run-scoped clone is dead, and can prove nothing about an unscoped one. They
# cost disk only; no run can adopt one. Lists by default, drops with --apply.
pnpm db:test-prune-legacy

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
| `DATABASE_URL` | Prisma client | (none, required) | Per-DB connection string; **the SERVE credential** wherever `MIGRATE_DATABASE_URL` is also set (the server reads only this). `.env` sets the dev value; `vitest.config.ts` overrides for tests. |
| `MIGRATE_DATABASE_URL` / `RUNTIME_ROLE_NAME` | #2413 role split — `scripts/docker-start.sh`, `scripts/db/revoke-runtime-migrations.ts`, `scripts/db/verify-runtime-role.ts`, grants in `prisma/runtime-role.sql` | MIGRATE: unset (legacy single-role boot). ROLE: `hadron_app`. | The OWNER credential: the one role that owns every `public` relation. The container entrypoint uses it for `prisma generate`/`migrate deploy`, the post-migrate revoke of the serve role's grant on `_prisma_migrations`, and the verifier, then **unsets it before starting the server**, so the server never holds it. **Unset** (or empty): everything runs under `DATABASE_URL`, exactly as before the split, and boot logs `db.runtime_role.owner_serving`. The verifier is warn-only at boot in this phase (`db.runtime_role.verify_warning`); revoke, migrate and generate failures stop boot and print only a phase, exit status and Prisma code, never a URL. `RUNTIME_ROLE_NAME` names the serve role for the revoke and verifier; the revoke skips a role that is the connected user or owns the ledger, so naming the owner never strips its own access. Verifier exit codes: 0 ok, 1 rule violated, 2 usage, 3 connect, 4 role missing. `SERVE_DATABASE_URL` is read only by `scripts/db/serve-role-smoke.ts` (CI). **Production: not set yet** (cutover R1/R4 not done); local dev keeps ONE role and must leave it unset, and it is never registered in Doppler `dev`. |
| `DB_POOL_CONNECTION_LIMIT` / `DB_POOL_TIMEOUT_SECONDS` | #448 — Prisma client pool (`src/integrations/db/poolUrl.ts`) | unset (existing Prisma behavior) | Optional positive safe integers for connection count / pool-wait seconds. Existing `connection_limit` / `pool_timeout` URL parameters independently win. Invalid configured settings refuse boot without echoing values or the URL. No production values are selected; no global statement timeout is set. |
| `JWT_SECRET` | `src/auth/jwt.ts`, `src/api/webhooks.ts`; fallback for `TEAM_ATTENTION_TOKEN_SECRET` and `CSRF_SECRET` | (none, required for signing) | HS256 secret. Per-host; `.env`-managed. **#421: production refuses to boot when it is missing or under 32 UTF-8 bytes** (`src/auth/signingSecret.ts`, first thing in `createServer`). Bytes, not characters; the refusal never prints the value or its length. One check covers every fallback, since each falls back to this value, and a strong dedicated secret never excuses a weak one. Dev/test keep short non-empty fixtures. Every `jwtVerify` on it pins `algorithms: ['HS256']`. Confirm prod's length privately before deploying a server that carries the guard. |
| `JWT_EXPIRY` | `src/auth/jwt.ts` | `7d` | jose-style duration string; the GitHub-OAuth callback's Option-C `hadron_token` cookie derives `maxAge` from the issued JWT's `exp` claim (so they expire together). |
| `PORT` | `src/index.ts` | `4000` | Dev server listen port. |
| `FRONTEND_URL` | `src/server.ts` CORS + OAuth redirect; `src/lib/portalUrl.ts` (#881 — the `URL:` line on node reads + `Node.portalUrl`) | `http://localhost:5173` for CORS/redirects; **no default** for portal links | Portal origin for cross-origin auth flow, and (#881) the base of the portal links node reads emit so no agent ever *constructs* one — `<origin>/app/u/<canonical-urn>`, the portal's URN-resolver route. The link path deliberately has NO localhost fallback: unset or malformed (`<scheme>://<host>[:<port>][/<path>]`, warned once) ⇒ the `URL:` line is omitted and `Node.portalUrl` is null, because a link to the wrong host is worse than none. `vitest.config.ts` pins it to `''` so a dev machine's `.env` can't make projections differ from CI's. |
| `TEST_PORT` | `prisma/seed.ts` (`'test'` OAuthClient redirectUri) | `4000` | Fixture-time port for Phase-2 OAuth integration tests' mock callback servers. **Distinct from `PORT`** — the dev server doesn't host this callback; Phase 2 tests spin up their own callback receiver and need a redirectUri that matches the seeded `OAuthClient('test')` row. |
| `CLOUDFLARE_IPS_API_URL` / `CLOUDFLARE_IPS_CACHE_PATH` / `HADRON_MULTIPLE_APPS_DOCS_URL` | spec 025 — boot-policy + multi-app docs link | see `src/auth/cloudflare-ips.ts`, `src/mcp/server.ts` | Overrides for the production-hardened trust-proxy fetch + the multi-App-resolved error's docs URL. |
| `ASSET_STORAGE_ENDPOINT` / `ASSET_STORAGE_REGION` / `ASSET_STORAGE_BUCKET` / `ASSET_STORAGE_ACCESS_KEY_ID` / `ASSET_STORAGE_SECRET_ACCESS_KEY` / `ASSET_STORAGE_FORCE_PATH_STYLE` | asset bytes — spec 004/006 (`src/integrations/r2/client.ts`) | ENDPOINT/BUCKET/credentials: none (required for any asset upload or download — unset ⇒ `ASSET_STORAGE_NOT_CONFIGURED`). REGION: `auto`. FORCE_PATH_STYLE: `true`. | S3-compatible object store holding **Asset** bytes. Named for what the bucket HOLDS, not who provides it, so a provider change needs no rename. **Provider is Hetzner Object Storage** (Holger, 2026-08-06) — the same provider as the hourly Postgres backups, so assets add no second storage vendor; endpoint e.g. `https://nbg1.your-objectstorage.com`, bucket `hadron-assets` (distinct from the backups' `hadron-internal`). **Set `ASSET_STORAGE_REGION` explicitly on Hetzner** (e.g. `nbg1`): R2 accepts the pseudo-region `auto`, but Hetzner signs SigV4 against its real region name, so a wrong value fails **authentication** rather than routing oddly — it reads like a bad key. Path-style addressing is the DEFAULT (Hetzner + MinIO both require it); R2 is the exception and needs `ASSET_STORAGE_FORCE_PATH_STYLE=false`. These names are the **only** ones read: the earlier `OBJECT_STORAGE_*` and `R2_*` spellings were dropped outright rather than kept as fallbacks (asset storage had never actually been configured anywhere, so there was no deployment to preserve, and a silent fallback chain just defers a misconfiguration into a confusing runtime error). The module/directory are still named `r2` for the Cloudflare deployment this was first written for — the code is provider-neutral; renaming the directory is a pending cleanup. Local dev: MinIO. **Registered in Doppler `prd`** (deliberately NOT in `dev` — local dev uses MinIO via `.env`, and a Hetzner endpoint there would put test uploads in the real bucket). |
| `SCAN_TOOL_URL` / `SCAN_TOOL_TOKEN` / `DISABLE_ASSET_SCAN_SWEEP` | #896 — malware scan capability tool (`src/lib/scanClient.ts`, `src/lib/asset/scan.ts`, sweep `src/jobs/scanPendingAssets.ts`) | URL: none (scanner off — the `HADRON_ASSET_SCAN_AUTO_CLEAN` posture applies). TOKEN: none (optional; sent as bearer when set). DISABLE: unset (10-min sweep ON; per-run no-op while URL is unset) | Base URL + shared bearer of the internal `hadrontool-scan` capability tool — a STATELESS, DB-less conduit wrapping ClamAV (alpha: `http://hadrontool-scan:8080`; token in Doppler on both sides). The tool holds NO object-storage credentials: core mints a short-TTL presigned GET on the **promoted** key (never the staging key — that one stays re-PUTtable for its whole presign TTL, the PR-#897 race) and the tool streams those bytes into clamd (`scan@1` contract, provider-neutral so a hosted engine can swap in without core changes). When URL is set, uploads are born PENDING and scanned **inline** in `completeAssetUpload` — the one moment the plaintext storage key is guaranteed in hand, which is what makes ENCRYPTED-memory assets scannable (their `storage_key` column is ciphertext under the memory session key afterwards); `HADRON_ASSET_SCAN_AUTO_CLEAN` is ignored. clean ⇒ CLEAN; infected ⇒ BLOCKED tombstone row (signature in `Asset.scanSignature`, GraphQL-exposed) + object bytes DELETED + typed `MALWARE_BLOCKED` error; tool down ⇒ upload SUCCEEDS with the row left PENDING (fail-closed, downloads gated) for the sweep. Sweep queue = `Asset.scanDueAt` (the #882 embedding-queue pattern: a future-dated stamp IS the queue; every touch pushes it forward, so no row class can starve the batch): PENDING ⇒ scan retry on exponential backoff (`scanAttempts`, 5min→6h, retried indefinitely; encrypted rows recheck every 15min and only scan while a session key is cached), BLOCKED with stamp set ⇒ purge retry for bytes that survived a failed delete. All transitions are guarded `updateMany` on the consumed state — a slow clean verdict can never revive a BLOCKED tombstone — and a definitive verdict requires the tool to declare `contract: scan@1`. Scan-path failures never fail an upload; only a real verdict does. **LIVE + ACTIVE in prd since 2026-08-08**: tool + the official `clamav/clamav:1.4` container deployed on alpha (internal-only; `StreamMaxLength=30M`, `ConcurrentDatabaseReload=no`), `HADRON_ASSET_SCAN_AUTO_CLEAN` deleted in the same change, and verified end-to-end (prod upload → CLEAN through the real path; EICAR upload → `MALWARE_BLOCKED` tombstone, bytes purged, hotlink 404). Note `SCAN_TOOL_TOKEN` is a COPY held in both Doppler projects — rotate in both. Ops record: `hrn:node:hadronmemory.com:dev:ops:alpha:hadrontool-scan`. |
| `HADRON_ASSET_SCAN_AUTO_CLEAN` | asset upload scan gate (`src/controller/operations/completeAssetUpload.ts`) | unset (uploads born `PENDING`) | `true` makes a user upload born **CLEAN** instead of `PENDING` — but **only while no scanner is configured**: once `SCAN_TOOL_URL` is set this flag is ignored and the inline scan (#896, row above) decides. Historical context: there was no malware scanner in the platform — nothing transitioned `PENDING` → `CLEAN`, so an upload left `PENDING` was permanently undownloadable (`mintAssetDownloadUrl` gates on CLEAN). This shipped as an unset dev/test hatch and made uploads dead on arrival in prod; it was set `true` in Doppler `prd` as the deliberate unblock (Holger, 2026-08-06) while no scanner existed, and **deleted from `prd` on 2026-08-08 when `hadrontool-scan` went live** — prod uploads now scan inline for real. The flag remains ONLY as a hatch for dev/test and scanner-less self-hosted deployments; do not set it anywhere a scanner is configured (it would be inert) and never turn it on in prod again without understanding that it serves unscanned bytes, including via the unauthenticated `GET /assets/:id` hotlink. `hadron_store_file` is unaffected — server-authored assets are written CLEAN directly regardless. |
| `ASSET_PUBLIC_HOTLINK_ENABLED` | anonymous asset hotlink (`src/api/assetPublic.ts`, `GET /assets/:id`) | unset (route answers 404) | `true` switches on the **unauthenticated** hotlink: anyone holding an asset id gets the bytes, with no session and no memory read gate. **Default OFF** because an anonymous byte-serving route is opt-in by nature — a deployment that never asked for this must not have it. (The original reason was sharper: bytes were unscanned before #896; since 2026-08-08 the hotlink still gates on `scanStatus=CLEAN` and prod scans for real, so the residual exposure is scanner-less deployments.) Read per request, so toggling it is a restart, not a redeploy. Disabled answers the SAME bare 404 as a missing asset, so it discloses nothing. **#1667: the deployment flag is only the OUTER gate — each asset also needs its own `publicLinkEnabled` opt-in (default off, set by the memory's manager via `setAssetPublicLink` / `hadron_set_asset_public_link`, cor:dmo:060:15); `Asset.publicLinkAvailable` exposes exactly this flag.** Also nulls `Asset.publicUrl`, so clients don't offer a "copy link" action for a URL that 404s. **Set `true` in Doppler `prd`** (Holger has a hotlink use case, 2026-08-06). |
| `DISABLE_ASSET_JANITOR` | asset retention sweep (`src/jobs/janitorAssets.ts`, `startAssetJanitorLoop`) | unset (janitor ON) | `true` disables the hourly sweep that purges soft-deleted assets past their 24h recovery window (object first, then the row). Before this loop existed the janitor had **no scheduler at all** — reachable only by running the file by hand — so expired assets' bytes accumulated in the bucket indefinitely. Also skipped when `NODE_ENV=test` (avoids leaking timers). This sweep only ever acts on a **tombstone** (a row whose `deletedAt` aged out); objects with no row at all belong to the orphan reaper below. |
| `ASSET_ORPHAN_REAP_ENABLED` / `ASSET_ORPHAN_SWEEP_PREFIX` / `DISABLE_ASSET_ORPHAN_SWEEP` | #889 — orphan-object sweep (`src/jobs/reapOrphanAssetObjects.ts`, `startOrphanObjectReaperLoop`) | REAP_ENABLED: unset (**dry run** — reports, deletes nothing). PREFIX: unset (whole bucket). DISABLE: unset (daily sweep ON) | Daily `ListObjectsV2` sweep that deletes bucket objects with **no matching `Asset` row** — the catch-all for every leak path the retention janitor can't see: cascaded rows (`Asset.memoryId` is `onDelete: Cascade`), encrypted memories whose `storageKey` a deletion path can't decrypt (`src/lib/asset/purge.ts`), abandoned uploads, failed `hadron_store_file` compensation, and the #897 staging objects a failed promotion leaves behind. Encryption is **not** an obstacle: the object's key is plaintext and its basename IS the asset id (`buildStorageKey`), so the sweep matches keys against PKs and never decrypts anything. This is the one janitor that deletes on the **absence** of evidence, so: only objects older than `ORPHAN_MIN_AGE_MS` (24h, ≥48× the presign TTL) are candidates — an upload in flight is an object with no row by definition; unrecognized key shapes are skipped loudly, never deleted; **every** candidate is confirmed row-less against the DB, including keys under the `staging/` prefix (a principal named `staging` would otherwise collide — see `RESERVED_ROOT_NAMES`); a failed DB lookup **aborts** the run (`OrphanSweepAbortedError`) rather than reading as "no rows exist"; and deletion is opt-in via `ASSET_ORPHAN_REAP_ENABLED=true` after watching the dry-run output. Set `ASSET_ORPHAN_SWEEP_PREFIX` if the bucket is ever shared with another consumer — keep the Postgres backups in their separate `hadron-internal` bucket. Skipped when `NODE_ENV=test` or asset storage is unconfigured. Hand-run: `pnpm tsx src/jobs/reapOrphanAssetObjects.ts [--apply]`. |
| `DISABLE_ASSET_BYTES_SWEEP` | #1140 slice B — bytes-missing row sweep (`src/jobs/sweepAssetBytes.ts`, `startAssetBytesSweepLoop`; alarm `src/lib/asset/bytesMissingAlarm.ts`) | unset (hourly sweep ON) | `true` disables the hourly, bounded (200 rows/run) sweep that HEADs the object behind each live CLEAN/PENDING Asset row older than `ORPHAN_MIN_AGE_MS` and raises the `asset.bytes_missing` Sentry alarm (source `sweep`) when it is gone — the mirror of the orphan sweep. Read-only against the store. Cursor = `Asset.bytesCheckedAt` (least-recently examined first, NULLs first; survives restarts). A failed HEAD other than not-found ABORTS the run and the failed row is not stamped (rows already examined keep their stamp); encrypted memories with no cached session key are deferred and rotated; at most 20 individual alarms per run, the rest in one summary event. A row that changes while its HEAD is in flight (BLOCKED, deleted, replaced) is re-read and not alarmed; overlapping runs are skipped. Skipped when `NODE_ENV=test` or asset storage is unconfigured. Hand-run: `pnpm tsx src/jobs/sweepAssetBytes.ts`. |
| `SESSION_IDLE_WINDOW_MS` / `SESSION_IDLE_WINDOW_<TYPE>_MS` / `SESSION_KEY_CACHE_TTL_MS` / `DISABLE_SESSION_REAPER` | #930, rewritten by **#1114** — session liveness (`src/lib/sessionActivity.ts`), the key cache (`src/lib/sessionKeyCache.ts`), and the hard-expiry sweep (`src/jobs/reapSessions.ts`, `startSessionReaperLoop`) | IDLE_WINDOW: unset (**24h** for every `SessionType`). `<TYPE>` is `DEVELOPER` / `CHATBOT` / `AUTOMATION` / `EDGE` and wins over the fleet-wide value. KEY_CACHE_TTL: unset (**inherits the widest configured idle window**, so 24h by default). DISABLE: unset (15-min sweep ON) | **#1114 removed the inactivity rule outright: nothing ends a session because it went quiet.** Holger's ruling, and the case that decides it is not an edge case — *"If I have my personal taxes agent, I use it once a year."* **Silence is not evidence of abandonment**, and the old rule inferred abandonment from quiet and then wrote that inference into `endedAt` as a fact — destructively, since ending a session forecloses the handoff it had not written yet. **`SESSION_IDLE_WINDOW_*` therefore no longer ENDS anything; it decides how a session is DESCRIBED.** The env names are unchanged because the quantity is unchanged (how long without a heartbeat before a session counts as idle) — only the consequence moved, so a deployment that tuned one keeps its intent. Getting the number wrong is now a rendering mistake, not a destroyed stint. **Liveness is DERIVED at read time** by `isSessionLive` — the session has not ended AND was driven inside its window, where activity is the greatest of `startedAt`, `updatedAt` and the latest attributed `UsageEvent`. That predicate is shared by the roster (`Worker.hasLiveSession`, aggregated in SQL because it must) and by `startSession`'s `WORKER_TAKEN` gate, which `cor:agt:020:11` requires to be ONE computation; the two implementations are pinned by a differential test in `resolvers.worker.test.ts`. Making the gate derived is also what stops an abandoned session refusing a bind **forever** with `force: true` as the only route. **What survives: hard expiry.** `startAgentSession` stamps `expiresAt` from the App's `sessionTimeoutSeconds` — a promise made at session start rather than an inference from silence — and the 15-minute loop exists for that alone. `startSession` still leaves `expiresAt` null, which since #1114 means nothing but an explicit `endSession` ends a DEVELOPER session. **`SESSION_KEY_CACHE_TTL_MS` is the third consumer and the security-adjacent one:** the in-process cache of encrypted-memory data keys had no expiry of its own — a key was released when the last holding session ENDED, so its eviction policy was a side effect of a durable record's lifecycle, and removing the idle rule would have made those keys immortal. It now has its own idle TTL — defaulting to the WIDEST configured idle window rather than a fixed 24h, so a fleet that tuned one keeps its key-retention policy instead of silently gaining or losing hours — refreshed on every use (so an actively-driven session never loses its key mid-flight), enforced at the point of USE (a read past the TTL returns null and drops the entry rather than resurrecting it), and swept by its OWN timer — deliberately NOT the reaper's, because `DISABLE_SESSION_REAPER=true` would otherwise disable key eviction along with it, which is the same defect wearing a config flag. Skipped when `NODE_ENV=test`. Hand-run: `pnpm tsx src/jobs/reapSessions.ts`. |
| `MCP_TRANSPORT_IDLE_TTL_MS` / `MCP_MAX_SESSIONS_PER_PRINCIPAL` | #2261 (incident #2259: the `/mcp` transport registry leaked ~15 MB per never-closed session) — `src/mcp/server.ts` (`sweepIdleMcpTransports`, `reserveMcpSession`), policy in `src/mcp/transportBounds.ts` | TTL: `3600000` (1 h), integer in `[60000, 604800000]`. CAP: `25`, integer in `[1, 1000]`. Anything else (0, negative, NaN, out of range) falls back to the default with one `mcp_transport_bound_env_invalid` warn line, so neither can be switched off by a typo. Read per use. | **Idle rule:** a transport with NO request in flight and quiet longer than the TTL is closed by a sweep on its OWN unref'd 60 s timer (not the session reaper's, so `DISABLE_SESSION_REAPER` cannot disable it; skipped under `NODE_ENV=test`). **Cap rule (separate):** a principal at its cap has its least-recently-active zero-in-flight transport evicted at once, without waiting for the TTL; when every one is in flight, the new `initialize` gets HTTP 429 + `Retry-After: 30` + JSON-RPC `-32000`, and nothing live is evicted. In-flight is counted off the Node response (arrival to `close`/`finish`, once-guarded), so a held GET/SSE stream or a POST queued behind `requestTail` pins its transport. The principal key is tagged (`user:<userId>` / `appkey:<appKeyId>` / `app:<appId>`), mirroring `sameMcpPrincipal`; `clientId` is never a key. A principal with none of those gets a random `anon:` bucket: that isolates it from others but is **not** a per-attacker or global bound (only the idle TTL bounds it); this is not DoS prevention. Eviction drops connection-local state only: it never ends the durable worker Session or its hold; the client gets the existing 404 / -32001, re-initializes, and rebinds with `hadron_resume_session` onto the SAME open session. Bounded-resource policy, not authorization. |
| `DISABLE_TASK_STALL_EVALUATOR` | #1706 — agent-task stall evaluator (`src/jobs/taskStallEvaluator.ts`, `startTaskStallEvaluatorLoop`; rules in `src/lib/agentTasks/stall.ts`) | unset (1-min loop ON) | `true` disables the loop that raises agent-task stall alarms (not started / no progress / owner didn't react / couldn't be assigned, cor:agt:050:14–:17), wakes the next owner up an unacknowledged alarm's chain (050:19), and records a stalled worker coming back (060:07). Needs no claim race across instances: an alarm is unique per (task, rule, episode start) in the database, so a second pass, or a second instance, inserts nothing. Windows are per App (`setAgentTaskStallSchedule`; defaults 15/60/20/30 min). Skipped when `NODE_ENV=test` — tests drive `taskStallTick(db, now)` with a controllable clock. |
| `DISABLE_TASK_MATCHER` | #1707 — agent-task matcher (`src/jobs/taskMatcher.ts`, `startTaskMatcherLoop`; rules in `src/lib/agentTasks/matcher.ts`) | unset (1-min loop ON, event-driven runs ON) | `true` disables the loop that assigns queued agent tasks to workers free for work (cor:agt:060:05, :06), records lapsed host registrations (`host.lost`, cor:agt:070:01), and records worker availability whose `until` passed (#1766, cor:agt:060:02: the row flips to `available`, set by `lapse`, with exactly one `availability.changed` event, before matching in the same pass), AND the event-driven runs after a task is created with no assignee, finished or cancelled, or an availability record changes. Overlapping runs are safe: each assignment is a guarded update on (pending, no assignee) under a per-worker advisory lock, so no task or worker is double-assigned. Until T6 (#1709) only workers with a live, bound session are matched. A model family is a matching input, never an authorization input. Loop skipped when `NODE_ENV=test` — tests drive `taskMatcherTick(db, now)`; the event-driven runs stay on in tests. |
| `DISABLE_MERGE_CONSENT_SWEEP` | #1770 — account-merge consent retention (`src/jobs/sweepMergeConsents.ts`, `startMergeConsentSweepLoop`; rule in `src/lib/userMergeConsent.ts` `sweepRetiredMergeConsents`) | unset (hourly sweep ON) | `true` disables the sweep that deletes retired (expired or consumed) consent requests 30 days after the later of their expiry and consumption (cor:api:010:02), in bounded batches of 500, at most 20 per run. A live proof and a merge's sealed receipt in `user_merges` are never touched. Skipped when `NODE_ENV=test`. Hand-run: `pnpm tsx src/jobs/sweepMergeConsents.ts`. |
| `OAUTH_CLIENT_GC_ENABLED` / `DISABLE_OAUTH_CLIENT_GC` | #155 — unused DCR OAuth client GC (`src/jobs/gcOauthClients.ts`, `startOauthClientGcLoop`; lifetime rules in `src/lib/oauthClientLifetime.ts`) | ENABLED: unset (**dry run** — logs the count it would collect, changes nothing). DISABLE: unset (daily loop ON) | `/oauth/register` is unauthenticated, so unused clients accumulated forever. A DCR client gets `expiresAt` = now + 30 days at registration, every token redemption pushes it forward, and the daily loop soft-deletes (`deletedBy = 'system:gc'`) a client more than 7 days past it, in batches of 500, at most 20 per run. A collected client is refused at `/authorize` (`invalid_client`) and `/token` (the unknown-code answer), so it must register again; its auth codes and the keys it already issued are untouched. `expiresAt` NULL (seeded `test`, `e2e-review`, hand-made clients) never expires; the migration backfills live DCR clients to deploy time + 30 days. **R220 (Holger, 2026-10-26): dry run until `OAUTH_CLIENT_GC_ENABLED=true`; production enablement waits on that count (#155 Q1). Not set in Doppler `prd`.** Skipped when `NODE_ENV=test`. Hand-run: `pnpm tsx src/jobs/gcOauthClients.ts [--apply]`. |
| `DISABLE_USER_DELETION_NOTICES` | #1647 — notice outbox for admin-initiated account erasure (`src/jobs/sendUserDeletionNotices.ts`, `startUserDeletionNoticeLoop`) | unset (1-min loop ON) | `true` disables the loop that sends the notice an administrator's erasure of ANOTHER user leaves behind (`deleteUser(userRef, reason)`; the reason is required for that case and lands in the append-only `user_deletion_audits` row, never in the notice). The intent (`user_deletion_notices`) is written PENDING in the deletion's own SERIALIZABLE transaction with the recipient address encrypted (tokenCrypto); the post-commit sender moves PENDING→SENT on the provider's ack, retries up to 3 then FAILED, and a missing recipient or unconfigured `RESEND_API_KEY` is UNAVAILABLE; the ciphertext is cleared at every terminal state. At-least-once, never exactly-once. Skipped when `NODE_ENV=test` — tests drive `processUserDeletionNotices(db, stubSender)`. Hand-run: `pnpm tsx src/jobs/sendUserDeletionNotices.ts`. |
| `RUN_DEFAULT_TOKEN_BUDGET` / `RUN_DEFAULT_ACTION_BUDGET` / `RUN_DEFAULT_TIMEOUT_MS` / `QUOTA_RUNS_PER_DAY_APP` / `QUOTA_RUNS_PER_DAY_ORG` / `QUOTA_TOKENS_PER_DAY_APP` / `QUOTA_TOKENS_PER_DAY_ORG` / `QUOTA_SMS_PER_DAY_APP` / `QUOTA_SMS_PER_DAY_ORG` / `WEBHOOK_TOKEN_TTL` / `DISABLE_RUN_WORKER` / `DISABLE_SCHEDULER` | spec 040 — headless runs (`src/jobs/appRuns.ts`, `src/jobs/scheduler.ts`, `src/api/webhooks.ts`) | budgets 100k tokens / 50 actions / 120s; quotas 200 & 1k runs/day, 2M & 10M tokens/day, 50 & 200 SMS/day; hpt TTL `90d`; workers ON | Per-run budgets are seeds; per-App/org quota LIMITS live on the QuotaCounter rows (the env values only seed first touch — operators tune the rows). The SMS counters are deliberately small (internal/staff notifications, not campaigns — the `hadron_send_sms` mass-messaging brake). `DISABLE_RUN_WORKER` also disables the scheduler; `DISABLE_SCHEDULER` disables only the cron loop. |
| `BILLING_DEBIT_ENABLED` / `CREDIT_MARKUP_PERCENT` | spec 046 — usage metering / AI-credit billing Phase 0 (`src/lib/metering/index.ts`) | Debits OFF; markup `0` | `BILLING_DEBIT_ENABLED=true` turns on automatic credit-ledger debits for PLATFORM-KEY LLM spend (`keyOwnerType='HADRON_SERVER'` — BYOK never debits); the pilot stays free while unset even though costs are being recorded. Markup precedence: `AiModelPrice.markupBasisPoints` (per-tier, effective-dated; 2500 = 25%) wins; `CREDIT_MARKUP_PERCENT` (e.g. `25`, fractions OK) is only the fleet-wide fallback for rows without one. Rates live in the `AiModelPrice` table (`setAiModelPrice`, platform admin; micro-cents per MTok, keyed `provider+model+tier+effectiveAt` — tier 1-3 is schema headroom, everything resolves tier 1 today); an unpriced triple yields cost NULL, never a blocked call. Credits are minted with `grantCredits` (platform admin only). |
| `NATS_URL` / `NATS_TOKEN` | spec 039 Phase 1 — platform message bus (`src/lib/bus/index.ts`) | Both unset (bus OFF) | **Optional by design** (D-2026-06-17-004): unset ⇒ `getBusClient()` resolves `null` and features fall back to their DB-backed sweep loops — a missing broker never breaks boot or the API. Dev: `nats://localhost:4222` (compose `nats` service). Alpha: the Docker bridge gateway (NATS runs bare-metal on the host) + the static token once the §9 ops step lands. Test gate: `BUS_TEST_NATS_URL` enables the broker integration tests in `src/lib/bus/bus.test.ts` (CI leaves it unset). |
| `REGEX_SEARCH_TIMEOUT_MS` | #415 Slice 1: regex search database budget (`src/lib/retrieval/regexTimeout.ts`, applied in `postgresRetrievalProvider.regexSearch`) | `5000` | Budget in milliseconds for ONE `findNodes(mode: regex)` statement (GraphQL and the delegated MCP `hadron_find_nodes`). Applied as `SET LOCAL statement_timeout` in a batch transaction on the search's own connection, so Postgres cancels the real statement, and the setting dies with the transaction on commit, rollback or cancellation; it never reaches a pooled connection's session, so no later request inherits it. Read per call. Only a positive integer counts: 0 means "no timeout" to Postgres, so `0`, negatives and junk fall back to the default instead of widening the bound. A cancelled search surfaces through the existing redacted paths (GraphQL `INTERNAL_SERVER_ERROR` with the generic DB message; MCP `[internal_server_error]` via the #1695 boundary), never echoing the pattern; there is no new refusal code. Pattern caps, backreference rejection and throttling are Slice 2, waiting on Holger. |
| `EMBEDDING_BACKEND` | spec 033 — RAG vector retrieval (`src/lib/embedding/index.ts`) | `http` | Selects the embedding-client implementation. `http` (default) uses `EMBEDDING_API_URL` + the HTTP client; `sagemaker` uses the SageMaker Runtime SDK + `EMBEDDING_SAGEMAKER_*` vars. Case-insensitive; an unknown value throws at first call. |
| `EMBEDDING_API_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` / `EMBEDDING_API_KEY` | spec 033 — RAG vector retrieval (`src/lib/embedding/client.ts`) | URL: none (required when `EMBEDDING_BACKEND=http` AND any memory has `vectorIndexEnabled`). MODEL: `nomic-embed-text` (the Ollama tag; serves nomic-embed-text-v1.5). DIM: `768`. KEY: none (optional). | HTTP-backend env vars. Dev: Ollama (`ollama pull nomic-embed-text`, batch endpoint `…/api/embed` → `{embeddings: number[][]}`). The client also accepts the OpenAI `{data:[{embedding}]}` shape and the TEI raw 2D-array shape. `EMBEDDING_MODEL` is sent verbatim to the endpoint (must match the served tag). `EMBEDDING_DIM` MUST equal the pgvector `vector(N)` column dimension (768) or embeds are rejected. No node plaintext leaves Hadron infra (privacy posture, FR-026). |
| `EMBEDDING_MAX_BATCH` | #882 — upstream embed-batch ceiling (`src/lib/embedding/index.ts`, `withMaxBatch`) | `32` | Largest number of inputs any single upstream embed request may carry — a property of the SERVED endpoint (TEI `max_client_batch_size`; 32 on the production SageMaker endpoint). The client factory wraps both backends so an over-long node sub-batches (order-preserving concat) instead of 413ing on every retry — pre-#882 a node chunking past the ceiling could NEVER embed. Positive integer; invalid values throw at first client construction. |
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
| `GRAPHQL_MAX_QUERY_BYTES` / `GRAPHQL_MAX_TOKENS` / `GRAPHQL_MAX_SELECTIONS` / `GRAPHQL_MAX_DEPTH` / `GRAPHQL_MAX_COST` / `GRAPHQL_LIST_FACTOR` / `GRAPHQL_COMPLEXITY_MODE` | request bounds on `/graphql` (`src/api/graphql/admission.ts`; depth and cost in `admissionComplexity.ts`) | 32768 / 4000 / 1000 / 12 / 200000 / 10 / `enforce` | Fleet-wide deployment configuration, read at boot. The numbers must be positive integers and a malformed value refuses boot without echoing it (no zero or off value: raise a number instead). Bytes bound the `query` string, tokens the parser, selections the expanded document; depth and cost apply to the SELECTED operation (cost: a leaf is 1, a list is 1 + size x children, where size is the page-size argument the request states; a paged field with the argument omitted counts as its resolver's default (100 unless listed in `OMITTED_PAGE_SIZE`), a list with no such argument as `GRAPHQL_LIST_FACTOR`, and a wrapper page scales the list inside it). `GRAPHQL_COMPLEXITY_MODE` is exactly `observe` (measure and log what would be refused, then admit) or `enforce` (refuse with `QUERY_TOO_COMPLEX`); the code default is `enforce`, and a boot line `graphql.admission.config` records the effective values. |
| `SIGNUP_TURNSTILE_ENABLED` / `TURNSTILE_SECRET_KEY` | #2257 slice 1 (R210, `cor:aut:030:01`) — Cloudflare Turnstile bot check on the email sign-in send paths (`src/auth/turnstile.ts`, mounted on `POST /auth/email` and `POST /oauth/authorize/email`) | ENABLED: unset (**gate off**, behavior byte-identical to before). SECRET: none. | Only the exact value `true` turns the gate on, read per request. With it on, a send request must carry Cloudflare's `cf-turnstile-response` field (JSON or form). **Fail closed:** no token or a rejected token → 403 `{error:'bot_check_failed', reason:'missing_token'|'invalid_token'}`; Cloudflare unreachable/erroring/malformed, or the secret unset → 503 with reason `provider_error`/`not_configured`; in every case no mail is sent. Only the secret, the token and the client IP go to Cloudflare, never the address. The gate sits after the route's no-send validation and the per-IP limiter and before the recipient limiter, so a refused request burns neither a token nor a victim's budget. **Do not enable in prod until the portal renders the widget** (a later slice; the server-rendered OAuth email page has none yet), and register `TURNSTILE_SECRET_KEY` in Doppler first. The first-account-creation gate, invited skip and per-identity limits are later slices. |
| `CORE_EVENTS_TOKEN` | #396/#667 — internal provider-event ingress (`POST /internal/email-events`, `/internal/slack-events`, `/internal/webfetch-events`) | none (unset ⇒ each ingress answers 503; its event plane is off) | Shared bearer presented by capability tools when delivering normalized events. Webfetch poll events are deduped on `(jobId,snapshotHash,kind)`, validated against the immutable core routing binding, and acknowledged only after an INTEGRATION AppRun plus completed-dispatch receipt are durable; external excerpts are framed as untrusted content before entering run data. |
| `BASE_URL` | Ten localhost-default consumers use `src/lib/baseUrl.ts:getProjectBaseUrl` (login callbacks, verification/fresh-sign-in mail, passkey notices, Exchange/Gmail/Calendar/Drive callbacks). | Shared helper: `http://localhost:${process.env.PORT \|\| 4000}`. Empty BASE_URL/PORT falls back; `/` is unset only under NODE_ENV=test. | Configured nonempty values are returned byte-for-byte, without normalization or validation. The four provider callbacks now honor PORT. `src/auth/oauth.ts` remains separate: strict boot validator and per-request origin fallback. `src/api/assetPublic.ts` and `src/mcp/deploymentInfo.ts` keep their no-default semantics. Strongly recommended in production so emitted URLs agree; this helper does not replace OAuth strict validation. **OAuth strict shape:** `<scheme>://<host>[:<port>]`, lowercase scheme; no trailing slash, path, query, fragment, whitespace, underscore or IPv6 brackets; malformed values fail boot. Without BASE_URL, OAuth metadata derives its origin from per-request headers and depends on `trust proxy` plus `X-Forwarded-Proto` being honored at every upstream hop (EF-003: a misconfigured hop can emit HTTP links rejected by clients). |

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
