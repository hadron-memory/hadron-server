# pg3601: bounded PostgreSQL lab for server#3601

Host tooling for the proposal
`hrn:node:hadronmemory.com:hadron-dev-team-hugo:proposals:3601-bounded-pg` (r2).
**Nothing here runs without a register row by Holger quoting these files' hashes.**
Not a product change; not part of any PR.

Order (one attempt, never re-armed):

1. `prepare-debs.sh`: host only, before the lease. Pins the postgresql-17 17.11 closure to the apt index sha256.
2. `arm.sh`: starts the 60-min lease, the lifecycle monitor and the reboot teardown. No Incus object exists yet.
3. `setup.sh`: inside the lease. Creates the profile, volume and instance (no NIC), runs the quota fill proof, does the offline install, cluster, sandbox and adapter bootstrap.
4. `verify.sh`: read-only verifiers V1 to V8. Any FAIL: no handover, `teardown.sh normal`.
5. `handover.sh`: arms the 30-min hard stop and prints Atilla's one client launch. `verify.sh client` snapshots the live client unit.
6. `audit-lifecycle.sh <run-end>`: classifies the run window as CLEAN or INCONCLUSIVE.
7. `teardown.sh normal|lease|boot`: deletes everything and writes the proof.

`stop.sh` is fired only by the stop timer.
