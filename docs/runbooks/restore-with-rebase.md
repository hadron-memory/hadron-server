# Logical restore with the event-key rebase — operator runbook

hadron-server#4111. The only supported way to restore a Hadron database from a logical dump (`pg_dump`). It applies
to any restore that copies rows into a cluster other than the one that wrote them. Physical restores, PITR and
`pg_upgrade` keep transaction ids and do not need it.

This runbook authorizes nothing. Running it against a production cluster, creating its roles or template, and any
cutover (pointing `DATABASE_URL` at the restored database) each need their own grant. Where production stands is
deployment state, kept in Hadron (`ops:alpha:db-access`), not here.

## Why plain `pg_restore` is not enough

`agent_team_events.tx_id` holds the id of the transaction that wrote each event (#4084). Ids are local to a cluster.
The changed-since read (`agentTaskExternalIdChanges`) serves a row only once `tx_id` is below the cluster's oldest
running transaction, and it pages by `(tx_id, created_at, id)`. Restored into a cluster whose id counter is lower,
rows keep the source's ids and the read hides them, with no error, until the new cluster catches up.

The pipeline rewrites every nonzero key to a small number (`3..K+2`, where K is the number of ascending runs) so that
every App's events keep their exact order and every key sorts below every id the new cluster will hand out. Cursors
already given to clients resume at exactly the next change: nothing skipped, nothing replayed. The read path is
unchanged.

A server started on a database that still holds foreign keys refuses to boot (`FOREIGN_EVENT_KEYS`, from
`assertEventKeysLocal` in `src/server.ts`). It runs before the bootstrap's first database write (the rate-metadata
seeding in `assertRateReadiness`), so a refused boot writes nothing to the database and never listens. Its remedy is this runbook, into a NEW database.
There is no in-place repair of a serving database.

## Prerequisites (checked by the pipeline, never created by it)

| | What | Made by |
|---|---|---|
| P1 | A login role `restore_admin`: `LOGIN CREATEDB`, not superuser, no `CREATEROLE`, plus `GRANT <owner_role> TO restore_admin WITH INHERIT FALSE, SET TRUE` (PostgreSQL 16+). No other path may let it inherit the owner role's privileges either (the check is `pg_has_role(restore_admin, <owner>, 'USAGE')` = false, not only the direct grant's INHERIT option). | a superuser, once |
| P2 | A quiescent `IS_TEMPLATE` database, made by a superuser, holding every extension the dump needs (`vector`, which is not a trusted extension). It must admit connections (`datallowconn`) and `restore_admin` needs `CONNECT` on it: S0 reads its extensions over a `restore_admin` session. No session may be open on it during S0. | a superuser, once |
| P3 | Read access to the dump, disk and WAL room for a second copy of the database, `pg_restore` 16 or later on the path. | the operator |
| | The owner role (owns every `public` relation) and the serve role (`hadron_app` unless `RUNTIME_ROLE_NAME` says otherwise) exist on the target cluster. Neither, nor any `--connect-role`, may be a superuser, and the serve role must not be the owner role. | as for any deployment |
| | Enough transaction-id headroom: the target cluster's next xid, read at S4 after `pg_restore` has run, must exceed K + 3. K is not known before the run. A fresh cluster with a large, many-run history may not have it; the pipeline then refuses at S4 and tears the restored target down (see "Refusals"). | — |

Missing P1 or P2 refuses at S0, before anything is created.

`RESTORE_ADMIN_URL` is the only connection setting: the pipeline's own sessions and its `pg_restore` child both take
host, port, user, password and TLS from it, and every inherited `PG*` variable except `PGPASSFILE` is dropped from the
child's environment. The URL must name the user (without one node-postgres would take `PGUSER` and libpq the OS
account). The password comes from the URL or, for a password-less URL, from the password file (`PGPASSFILE`
or `~/.pgpass`) on both sides; `PGPASSWORD` set beside a password-less URL is refused at S0, since the pipeline's own
sessions would use it and `pg_restore` would not. Accepted query parameters: `sslmode` (`disable`, the default when absent; `require`; `verify-ca`,
which needs `sslrootcert`; `verify-full`), `sslrootcert`, and `sslcert` with `sslkey` (file paths, for certificate
authentication). Anything else (`prefer`, `allow`, `no-verify`, `require` with `sslrootcert`, `host`, `options`,
`service`, …) is refused at S0, before anything is created. A verifying mode without `sslrootcert` uses the system trust
store on the `pg_restore` side and Node's bundled store on the other; name `sslrootcert` explicitly for a private CA.

## Run

```bash
export RESTORE_ADMIN_URL='postgresql://restore_admin:…@host:5432/postgres'   # the maintenance database
pnpm ops:restore-with-rebase run \
  --dump /path/to/hadron.dump \
  --target hadron_restored_20261113 \
  --owner-role <owner_role> \
  --template <template_db> \
  --serve-role hadron_app \
  --connection-limit <steady limit> \
  --db-settings-from-env SOURCE_DATABASE_URL     # or --db-settings-file settings.json
```

- `--target` must not exist. The pipeline never takes an existing, already restored or serving database.
- Database-level settings (`ALTER DATABASE … SET`) are not in a dump. Give them either from the source
  (`--db-settings-from-env` names an environment variable holding the source URL; it reads `pg_db_role_setting`) or
  as a JSON object of name to value. Neither: refused. `{}` is an explicit "none".
- `--connect-role` (repeatable) adds login roles that get `CONNECT` at the end. The owner role always gets it.
- `--connection-limit` is a positive integer; `-1` (unlimited) is refused at S0.
- No URL is printed. Progress is JSON lines on stderr; the result is one JSON line on stdout.

### What happens, in order

| Stage | Who can connect to the target | What it does |
|---|---|---|
| S0 | (no target yet) | Read-only preflight: P1, P2, the target name is free, every extension the dump declares is in the template. Logs the dump's sha256. |
| S1 | nobody (`ALLOW_CONNECTIONS false`) | `CREATE DATABASE … OWNER <owner> TEMPLATE <tpl> … OID <n>`, under a random free oid this run chose (logged in the S1 `creating` line); records it. If the server refuses the statement with an ERROR, the CREATE rolled back: an existing database of that name belongs to someone else and is reported as `teardown: uncertain`, never dropped. If the reply is lost (the session or connection died), the catalog is re-read from a fresh connection: absent means nothing was created; a database that is provably this run's (the chosen oid, its owner, admission off, the working connection limit, the default ACL, created after S0) is torn down; anything else is reported as `teardown: uncertain` and left for the operator. |
| S2 | `restore_admin` only (ACL fence) | Revokes `CONNECT`/`TEMPORARY` from `PUBLIC`, the owner, serve and app roles; grants `CONNECT` to `restore_admin`; verifies the ACL from the catalog; then admits connections for the working phase. |
| S3 | `restore_admin` only | `pg_restore --role=<owner> --no-owner --no-privileges --exit-on-error -L <list>` (template extensions filtered out of the list); applies the database-level settings. |
| S4 | `restore_admin` only | The key rebase, in one transaction (below). |
| Hard fence | nobody new (`ALLOW_CONNECTIONS false`); the pipeline asserts it is the only session | `prisma/runtime-role.sql` as the owner, `CONNECT` to the owner/serve/app roles, final verification (order, keys, ownership, no dump ACLs), the audit row in `hadron_restore.restore_provenance`, the steady connection limit, and `restore_admin`'s own `CONNECT` revoked. |
| Release | everyone granted | One statement, last: `ALTER DATABASE … ALLOW_CONNECTIONS true`. |

`runtime-role.sql` runs under the hard fence, not in S3, because it grants `CONNECT` to the serve role; during the
working phase that would open the ACL fence.

### The rebase transaction (S4)

1. `LOCK TABLE agent_team_events IN EXCLUSIVE MODE` (no writer; takes no xid).
2. Read `X0 = pg_snapshot_xmax(pg_current_snapshot())` in its own statement, asserting the transaction has no xid
   yet. A transaction that already holds one is refused before any write.
3. `LOCK … IN ACCESS EXCLUSIVE MODE` (no reader either), count the runs K, refuse if `K > X0 - 3`.
4. Disable `agent_team_event_append_only` by exact name, update the keys, re-enable it. Before commit it proves that
   only `tx_id` changed in every row, that every other trigger is in its starting state and this one is `O` again,
   that `session_replication_role` stayed `origin`, and that the serving order is identical. Any difference rolls
   the whole transaction back (keys, columns, trigger state).

The rebase is idempotent: run again on its own result it writes nothing (`state: local-only`). The CLI cannot do that
to a released database (`run` refuses an existing target); the route is to dump the result and restore that dump into
another new target.

The before/after comparisons (serving order, every non-key column) are sha256 digests streamed through a cursor 10,000
rows at a time, so neither memory nor a single-value size limit bounds the history the pipeline can verify; the
database's own sort and window spills to disk.

## Result

```json
{"runId":"…","oid":16420,"dumpSha256":"…","rebase":{"state":"rebased","rows":…,"nonzeroRows":…,"runs":…,"x0":"…","capacity":"…","updated":…,"maxKey":"…"},"status":"RELEASED"}
```

`rebase.state` is one of `empty`, `zero-only`, `local-only` (nothing to map, zero writes), `rebased`, or
`no-event-table` / `no-key-column` for a dump from an image older than #4084. The same values are in the audit row:

```sql
SELECT * FROM hadron_restore.restore_provenance;   -- run id, dump sha256, K, max key, oid, stage
```

The audit row records what was done. Nothing reads it to make a decision.

## Refusals and failures

Every failure before the release statement tears the target down: from a fresh connection, by the recorded oid, with
a plain `DROP DATABASE` (never `FORCE`). The error names the stage, the teardown outcome and the oid:
`[S4] … (teardown: dropped, oid 16420)`.

| Message | Meaning | Do |
|---|---|---|
| `needs K xids of headroom, cluster has C` | The target cluster's id counter is too low for this history. The check runs at S4, after `pg_restore` has already written the target (and spent xids); the rebase itself writes nothing and the target is torn down. | Restore into a cluster whose counter is higher, or consume ids on the target first. A retry on the same cluster may pass, because the failed attempt consumed ids. |
| `foreign session` at the hard fence | Something else is connected to the target (a superuser can connect past `ALLOW_CONNECTIONS false`). It is never killed. | The teardown's plain `DROP` does not wait: it fails at once with `teardown: drop-failed` and the target stays `FENCED`. Find the session; once it has gone, run `teardown` with the oid from the error line (or from `status`). |
| `CREATE DATABASE outcome uncertain` (`teardown: uncertain`) | S1's statement was refused (another creator holds the name) or lost its reply, and a database with the target's name exists that is not provably this run's (or the catalog could not be re-read). Nothing was dropped. | Inspect it (`status <target>`); if it is this run's, `teardown` it with its oid. |
| `template … must exist, be IS_TEMPLATE and be superuser-made`, `template … is not quiescent`, `template … admits no connection` | P2 missing. Nothing created. | Fix the template. |
| `<role> needs GRANT <owner> TO <role> WITH INHERIT FALSE, SET TRUE and no inherited path (P1)`, `… is a superuser`, `… lacks CREATEDB`, `… has CREATEROLE`, `role … is a superuser`, `the serve role must not be the owner role` | P1 or a role prerequisite missing. Nothing created. | Fix the role. |
| `unsupported connection parameter: …`, `unsupported sslmode …`, `sslcert and sslkey must be given together`, … | `RESTORE_ADMIN_URL` has a setting the pipeline cannot hand to both its sessions and `pg_restore`. Nothing created. | Use the accepted parameters above. |
| a dump extension the template lacks | Nothing created. | Add the extension to the template (superuser). |

### Status and teardown

```bash
pnpm ops:restore-with-rebase status <target>               # ABSENT | FENCED | WORKING | RELEASED, and the oid; read-only
pnpm ops:restore-with-rebase teardown <target> --oid <oid> --owner-role <owner_role>
```

The oid is in the failed run's error line and its S1 `created` stderr line, and `status` prints it.

`teardown` checks the recorded oid first: `absent` (already gone), `name-mismatch` (the oid now has another name;
refuses, alert), `released-kept` (the database was released; it is never dropped), else `dropped` or `drop-failed`.

Exit codes: `run` 0 when RELEASED, 1 on any refusal or failure; `status` 0, 1 on an error; `teardown` 0 for `dropped`
and `absent`, 1 for `released-kept`, `name-mismatch` and `drop-failed` (a script must read the printed outcome, not
only the code, to tell a kept released database from a failure); every command exits 2 on a usage error or a missing
`RESTORE_ADMIN_URL`.

If the reply to the release statement is lost (connection drop, operator interrupt), run `status`. `RELEASED` means
the restore is complete. Never drop a released database to "retry".

## After the release

- Point a server at it only under a cutover grant. The server's boot check passes on a pipeline output.
- Keep the dump and the pipeline's JSON output with the change record.

## Limits, stated

- `ALLOW_CONNECTIONS false` is not documented to stop a superuser; the session check before the final steps and the
  release is a detector, not a fence. (Observed on PostgreSQL 17: it refused even a superuser's new connection; a
  superuser already connected stays connected.)
- The connection limit is not a fence; only `ALLOW_CONNECTIONS` and the ACL are.
- A superuser dropping and recreating the target's name between teardown's lookup and its `DROP` is a named residual.
- The boot check is defense in depth, not proof of a database's history: a restore whose keys all happen to sit below
  the new cluster's counter boots, and is served correctly.
