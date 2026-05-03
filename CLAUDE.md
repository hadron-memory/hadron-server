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
