# Branch-aware Git mirror debt rollout (#3042)

The migration adds `branch text NOT NULL DEFAULT ''` and widens the obligation primary key to `(memory_id, node_id, kind, remove_loc, branch)`. Empty means a legacy unknown branch. There is no guessed backfill and no database branch-shape CHECK; the final branch passes the existing TypeScript validator before any Git command.

**One-deploy exception — Holger ruling 0076, 2026-11-02:** the old-writers-drained precondition is waived for the one automatic deploy shipping #3102; Holger accepts its old/new code swap window. See [rulings:0076](https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:hadron-dev-team-shared:rulings:0076). Every merge to main deploys automatically; there is no separate named deploy-owner step.

The risk remains real: an old failure upsert no longer has a matching conflict target, and an old success DELETE can erase another client's branch debt. Migration-before-new-process-start, zero rows at one instant, or pausing only the sweep do not prove all-writer exclusion. The ruling accepts that window for this one deploy; it does not claim safe coexistence or authorize manual production operations.

Forward fixes are the supported recovery path. Do not collapse the new primary key or run old code against it. A destructive old-code rollback requires a separate explicit authorized decision at that time.

Legacy empty-branch rows in a currently templated memory remain durable and unroutable: no retry, no guess and no branch-specific clear. This includes missing/tombstoned nodes. Existing validation (#884) reports WRITE debt only while its node is live; retaining tombstone debt does not create a new finding. Retirement of legacy debt is an operator/product decision outside this change.

For fixed current configuration, retries use the current branch and atomically settle the captured old key. Newer captured debt is a no-op; a newer destination is retained byte-for-byte. Failed older debts merge their attempt counts with the existing cap. Branch-specific success never clears another client's debt, except that a successful fixed-branch ordinary write can cover the legacy empty key. An explicit not-mirrored configuration clear remains branch-agnostic and fenced.

This is internal retry durability. It adds no writer-side PENDING stamp, new write/delete trigger, clone authority, encrypted-memory export, production provider access or new write-back policy.
