# Search-replace governed skip under the key (#1213 S3)

The controlling contract is re-gate 3 (issue comment 6431257002), Ada's input-triggered ruling (6430918174), and `cor:acl:130:02`. S2 landed as #4649 / 89800a9a; S3 changes only the search-replace adopter's current-state skip. Ordinary roles with configurable writer levels retain their existing authority gate.

## Protocol and scope

Search-replace preserves its authority prefix and existing complete selected-memory `channel-host:` key set before memory/node row locks. It then reads current `role`/`isRunnable` from the locked planned rows. Any governed kind is skipped unconditionally, even for a manager who could edit it through its own door. Removing a plan and its id from the revision work set happens before minted-tag checks, revision reconciliation, OCC and authoring/write work. Ordinary survivors retain all existing checks and commit in the same transaction. Plans are unique by node id, so a row contributes one governed skip even if selection mentions it multiple times.

S2's participating signal and owning writers hold the same key before loc/node locks. It is therefore legal for a replacement to commit before a later promotion, or for a promotion to commit first and the replacement to skip that row. No new key, transaction or broader writer-participation rule is introduced here. Dry runs remain the existing non-writing preview; this change claims no serializable preview snapshot. Channel/protected-address classification, open-role writer levels, encryption, authoring and ordinary-row OCC are unchanged.

## Reproducible pins

`resolvers.searchReplaceGovernance1213.test.ts` runs real PostgreSQL transactions with an org OWNER/platform ADMIN manager and real `writeNodeCore` review/task doors:

- Planner reads the row while ordinary. The promoting door finishes its actual work but holds commit; the bulk then queues on that exact holder PID/database/physical memory key. After promotion commits, bulk skips once, never calls `ensureCurrentNodeRevisionInTransaction` for that id, and leaves the door's full node/revision snapshot unchanged. Both a mixed ordinary survivor and an all-plans-skipped batch are covered for both role and runnable promotion.
- Bulk finishes its actual work but retains the key before commit; the promoting door is observed waiting on the same exact key and holder. After release, both operations succeed, the replacement remains, and the governed signal is present.
- The selected memory plus duplicate explicit ids exercise the deduplicated selector.

The snapshot baseline is captured inside the promoting transaction after its work and before release; taking it after unlock would permit the competing bulk to race the baseline itself. Holders and contenders are released/drained in `finally`. A missing wait fails explicitly; a timeout is never treated as successful serialization.

Red-first commit `7488abdd0` on main `89800a9a`: both door-first cases fail because the batch rejects with the stale-plan conflict; both bulk-first controls pass. The final matrix adds all-skipped controls and tighter helper typing/diagnostics.

## Mutation controls and local validation

Each mutation is applied separately and restored:

| Mutation | Expected pin failure |
| --- | --- |
| Remove the unconditional governed-kind skip | All four door-first cases reject with stale-plan conflict |
| Reconcile every planned row before the skip | All four door-first cases observe one reconciliation call instead of zero |
| Count a dropped plan twice | All four door-first cases observe incorrect skip totals |

The restored final source passes 160 tests in seven focused files: the new S3 matrix, search-replace, role-writer levels, S2 governance memory barriers (including merge and extract in both orders), revision drift, memory-before-node order and governed roles. Seven structural checks pass. Hosted CI and independent exact-head seats remain separate evidence; no full local suite, Incus stack, production probe or latency measurement is claimed. Local mutation runs cover S3's three controls, not every existing guard in search-replace.
