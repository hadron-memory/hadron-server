# pg3601: bounded PostgreSQL lab for server#3601

Host tooling for the proposal
`hrn:node:hadronmemory.com:hadron-dev-team-hugo:proposals:3601-bounded-pg` (r3).
**Nothing here runs without Holger's register rows A and B, which quote these files' hashes.**
Not a product change, and not part of any PR.

Order (one attempt, never re-armed):

1. `prepare-debs.sh`: host only, before the lease. Pins the postgresql-17 17.11 + python3 + python3-psycopg closure to the apt index sha256.
2. `arm.sh`: starts the 60-min lease, the lifecycle monitor (identity recorded) and the reboot teardown. No Incus object exists yet.
3. `setup.sh`: inside the lease.
   - Creates the objects (no NIC) and runs the quota fill proof.
   - Installs offline, then verifies both JSON manifests.
   - Creates the cluster and sandbox, and the root stop-request endpoint.
   - Installs (does not start) the adapter's slice and broker units, then runs the bootstrap.
4. `verify.sh`: read-only checks V1 to V8. Any FAIL means no handover, then `teardown.sh normal`.
5. `handover.sh`: refuses if less than 35 min of lease is left.
   - Arms the 30-min hard stop and logs the opening heartbeat.
   - Authors the root-owned descriptor and grant.
   - Prints Atilla's one declared launch (`exec-declared.sh`).
6. `verify.sh client`: one exec snapshot of the client slice during the run.
7. `collect.sh`: pulls results to a 0700 host directory (restricted material) and logs the closing heartbeat.
8. `teardown.sh normal|lease|boot`: deletes everything, writes the proof, then runs `audit-lifecycle.sh` (CLEAN or INCONCLUSIVE).

`stop.sh` is fired only by the stop timer. Every exec goes through the declared-exec ledger in `common.sh`.
