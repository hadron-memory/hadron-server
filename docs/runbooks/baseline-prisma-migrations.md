# Baseline Prisma migrations — operator runbook

## Context

In May 2026 we squashed 39 historical Prisma migrations into a single
`baseline_init` migration. Reason: replaying the old history into a
fresh shadow DB was broken at `20260320044143_add_agent_tools_to_client`
because that migration referenced a `stations` table that no migration
ever created (the table came into existence via `prisma db push` during
the Client → Station rename on 2026-03-23, outside the migration
system). Full diagnosis lives in GitHub issue #139.

The baseline reset is a **one-time** operation. After this runbook is
executed, normal `prisma migrate deploy` continues as before.

## What the baseline contains

The new `baseline_init` migration's `migration.sql` is structured in
two sections:

1. **Prisma-generated CREATE statements** — produced by
   `prisma migrate diff --from-empty --to-schema-datamodel
   prisma/schema.prisma`. Tables, columns, enums, indexes, FKs.
2. **Post-baseline appendix** — DDL that the Prisma schema language
   can't express but prod relies on:
   - `NOT NULL` on `agents.surfaces` and `apps.surfaces`
   - Partial indexes (URN-migration sweep, staged-asset indexes,
     `apps_urn_active_uniq`)
   - Partial overrides of `memories_user_id_idx` and
     `users_external_app_id_external_id_key`
   - The five `chk_memory_*` CHECK constraints

The appendix mirrors `prisma/post-push.sql`, which is the equivalent
that `db push`–based dev/test setup applies after introspection.

## Prod-side runbook (one-time, after PR merges)

```bash
# On alpha, before any subsequent `prisma migrate deploy` runs.
# This writes a single row into `_prisma_migrations` with the new
# init's checksum, **without re-running the CREATE TABLEs** — prod's
# data and schema are untouched.

ssh root@alpha
cd /path/to/hadron-server  # not actually on-host; see "From a laptop" below
```

Since hadron-server source is not deployed on alpha (Komodo builds
images), the resolve must be run from a developer machine with
access to prod's Postgres. The trust boundary is the SSH session.

**From a laptop with SSH access to alpha:**

```bash
# 1. Open an SSH tunnel to alpha's Postgres.
ssh -fN -L 25432:127.0.0.1:5432 root@alpha

# 2. Configure pg_hba on alpha to accept the tunneled connection
#    (one-time). If TCP-localhost peer auth isn't already set up,
#    use the `postgres` shell account directly instead — see (3-alt).

# 3. Run migrate resolve through the tunnel:
DATABASE_URL='postgresql://postgres@127.0.0.1:25432/hadron' \
  pnpm exec prisma migrate resolve --applied 20260519180903_baseline_init

# 3-alt. Or directly on alpha via psql (no Prisma needed):
#   - Compute the checksum locally:
CHECKSUM=$(sha256sum prisma/migrations/20260519180903_baseline_init/migration.sql | awk '{print $1}')
echo "$CHECKSUM"
#   - Then on alpha:
ssh root@alpha "sudo -u postgres psql -d hadron -c \"
  BEGIN;
  DELETE FROM _prisma_migrations;
  INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
  VALUES (gen_random_uuid()::text, '$CHECKSUM', now(), '20260519180903_baseline_init', 1);
  COMMIT;
\""

# 4. Verify:
ssh root@alpha "sudo -u postgres psql -d hadron -c \"SELECT migration_name, applied_steps_count, finished_at FROM _prisma_migrations;\""
# Expected: exactly one row — 20260519180903_baseline_init.

# 5. Close the tunnel:
pkill -f "ssh -fN -L 25432"
```

After step 4, `prisma migrate deploy` runs from a server container
will be a no-op (no pending migrations) until the next migration PR
merges. That next PR's migration applies cleanly on top of the
baseline.

## Backup before running

Always take a pre-action backup. Live runbook: `/root/CLAUDE.md` on
alpha covers the `pg_dump` flow.

```bash
ssh root@alpha 'TS=$(date -u +%Y-%m-%d-%H%M); \
  sudo -u postgres pg_dump -Fc -d hadron > /root/backup/hadron-alpha-pre-baseline-${TS}.dump'
```

The backup taken just before the May 2026 baseline reset:
`hadron-alpha-2026-05-19-1706.dump` (692 KB).

## If the baseline fails to apply (fresh DB)

If `prisma migrate deploy` against an empty DB fails, the most likely
cause is enum-value or constraint drift between the baseline appendix
and current `schema.prisma`. Check:

1. The five `chk_memory_*` CHECK constraints in the appendix must
   reference enum values that exist in `MemoryClass` /
   `MemoryVisibility`. If you've added a new memory class, the
   appendix's `chk_memory_class_app_id` may need an update.
2. The partial-index column references must still exist with the same
   names in `schema.prisma`.

Cross-check against `prisma/post-push.sql` — the two files **must
stay in sync** for the `db push` (dev/test) and `migrate deploy`
(prod/CI) paths to produce equivalent schemas.

## Known acceptable drift

`prisma migrate diff --from-url <DB-after-baseline> --to-schema-datamodel schema.prisma`
will always report two lines of drift:

```
-- CreateIndex
CREATE INDEX "memories_user_id_idx" ON "memories"("user_id");
-- CreateIndex
CREATE UNIQUE INDEX "users_external_app_id_external_id_key" ON "users"("external_app_id", "external_id");
```

This is Prisma trying to "fix" the partial indexes back to non-partial.
The Prisma schema language can't express the `WHERE` clauses. The CI
gate (`.github/workflows/migration-smoke-test.yml`) explicitly allow-
lists these two lines; any other diff is real drift and must fail CI.

When running `prisma migrate dev` locally, you'll see the same two
lines as the suggested next migration. Discard them.

## Known prod drift (NOT addressed by the baseline)

The baseline captures prod's **actual** state, including one bug:

- `chk_memory_class_app_id` on prod is the pre-023 form — missing the
  `'group'` value in the second `IN (...)` array. Migration
  `20260516233753_023_app_shape_additions` is marked applied in
  `_prisma_migrations` but its `ALTER TABLE` for this constraint
  didn't take effect. Zero `class='group'` memories exist on prod, so
  the bug hasn't bitten yet.

**Fix:** a follow-up migration `<ts>_fix_chk_memory_class_app_id_group`
that runs `ALTER TABLE memories DROP CONSTRAINT ... ADD CONSTRAINT ...`
with the corrected `IN ('system', 'knowledge', 'group')` clause.
Apply via `prisma migrate deploy`. The baseline's appendix already
has the correct version, so fresh DBs (CI, future dev) get the
right constraint immediately; the follow-up migration only touches
prod.
