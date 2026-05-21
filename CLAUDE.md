# Agent dev guide — hadron-server

Quick reference for AI agents working in this repo. Updated 2026-05-02.

## Local Postgres setup

The trust boundary is the LX container. The OS user (`root`) and the Postgres
user (`holger`) are intentionally different — that arrangement is fine and
should not be changed.

| DB | Purpose | Owner | Connection string |
|---|---|---|---|
| `hadron_dev` | Local development (manual portal/server runs, fixture data) | `holger` | `postgresql://holger@localhost:5432/hadron_dev` |
| `hadron_test` | Vitest test runs (cleared between tests) | `holger` | `postgresql://holger@localhost:5432/hadron_test` |
| `hadron_smoke_test` | Pre-existing; reserved for ad-hoc smoke tests | `holger` | `postgresql://holger@localhost:5432/hadron_smoke_test` |

Both `hadron_dev` and `hadron_test` are managed via `prisma db push` (no migration
history on these DBs — `prisma migrate dev/deploy` does not work cleanly because
older migrations reference the dropped `stations` table).

`.env` (gitignored) holds the dev `DATABASE_URL` plus per-host secrets
(JWT_SECRET, HADRON_ENCRYPTION_KEY). Anything Prisma-related picks it up
automatically. For tests, `vitest.config.ts` pins `DATABASE_URL` to
`hadron_test` regardless of `.env`, so test runs never touch dev data.

## Common commands

```bash
# Run the test suite (always against hadron_test)
pnpm test

# Typecheck
pnpm tsc --noEmit

# Inspect dev data
psql -U holger -h localhost -d hadron_dev -c '\dt'
psql postgresql://holger@localhost:5432/hadron_dev   # interactive

# Reset + reseed the dev DB (the human runs this; Prisma blocks AI agents
# from invoking --force-reset without explicit consent)
pnpm db:dev-reset

# Re-seed without resetting (works for AI agents)
DATABASE_URL='postgresql://holger@localhost:5432/hadron_dev' pnpm tsx prisma/seed.ts

# Re-apply CHECK constraints after a `db push` (needed because Prisma's
# schema language doesn't model CHECK constraints)
psql postgresql://holger@localhost:5432/hadron_dev -v ON_ERROR_STOP=1 -f prisma/post-push.sql
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
| `BASE_URL` | `src/auth/oauth.ts` (`getServerOrigin`) + `src/auth/email.ts` + `src/auth/github.ts` + `src/integrations/exchange/auth.ts` | OAuth path: per-request `${req.protocol}://${req.get('host')}`. email.ts / github.ts: `http://localhost:${process.env.PORT ?? 4000}`. exchange/auth.ts: hardcoded `http://localhost:4000` (no `PORT` lookup). | **Project-wide canonical-origin env var.** Already used by email verification, GitHub OAuth callbacks, and Exchange auth; spec 025 added OAuth metadata + `/mcp` 401 `WWW-Authenticate` as consumers. **Strongly recommended in production** so every server-emitted absolute URL agrees on the same origin. Without it OAuth-metadata URLs derive from per-request headers, which depends on `trust proxy` + `X-Forwarded-Proto` being honored by every upstream hop — a single misconfigured request can emit `http://` URLs that Claude Desktop refuses to accept (EF-003). **Strict shape on the OAuth path** (`<scheme>://<host>[:<port>]`, lowercase scheme, no trailing slash / path / query / fragment / whitespace / underscore / IPv6 brackets): malformed value throws at boot via the OAuth module's IIFE. The other 3 consumers don't validate; they concat raw. The four unset-defaults aren't consistent (see "Default" column); centralizing them behind one helper is a known follow-up. If `BASE_URL` is wrong on the OAuth side it's wrong on the other 3 too, so fail-loud is right. |

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

- **No `Station*`**: spec 003 dropped this entity. CI grep gate enforces
  no reintroduction. If you see `station` anywhere in `src/`, that's a bug.
- **Bidirectional Memory invariant**: `visibility = 'PERSONAL' ⇔ user_id IS NOT NULL`.
  Enforced by `chk_personal_visibility_user`. Set both fields together.
- **008 Memory app_id invariant**: `class IN ('app','personal') ⇔ app_id IS NOT NULL`.
  Enforced by `chk_memory_class_app_id`. Personal memory pivots on
  `(app_id, user_id)` (not `(agent_id, user_id)` like 005's effective
  pivot did).
- **Composite-PK models** (`AgentSubscription`, `AppMember`, `AgentImport`,
  `AgentOrgGrant`) have no `id` column. The Prisma client extension at
  `src/integrations/db/client.ts` keeps these out of the auto-id-injection
  list — add new composite-PK models to `MODELS_WITHOUT_ID` there.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->
