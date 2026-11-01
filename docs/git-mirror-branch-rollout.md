# Branch-aware Git mirror debt rollout (#3042)

The migration adds `branch text NOT NULL DEFAULT ''` and widens the obligation primary key to `(memory_id, node_id, kind, remove_loc, branch)`. Empty means a legacy unknown branch. There is no guessed backfill and no database branch-shape CHECK; the final branch passes the existing TypeScript validator before any Git command.

Old writers must be drained **before** the migration applies. An old failure upsert no longer has a matching conflict target, but an old success DELETE still runs and can erase another client's branch debt. This is unsafe coexistence, not compatibility. Migration-before-new-process-start does not demonstrate that old writers have stopped.

The authorized deploy owner must establish and record drainage under their own grant. This code change, issue gate and PR authorize no production operation. Coordinate the normal merge-to-auto-deploy path with that owner before landing; do not infer that a single configured container proves stop/start order.

Forward fixes are the supported recovery path. Do not collapse the new primary key or run old code against it. A destructive old-code rollback requires a separate explicit authorized decision at that time.

Legacy empty-branch rows in a currently templated memory remain durable and unroutable: no retry, no guess and no branch-specific clear. This includes missing/tombstoned nodes. Existing validation (#884) reports WRITE debt only while its node is live; retaining tombstone debt does not create a new finding. Retirement of legacy debt is an operator/product decision outside this change.

For fixed current configuration, retries use the current branch and atomically settle the captured old key. Newer captured debt is a no-op; a newer destination is retained byte-for-byte. Failed older debts merge their attempt counts with the existing cap. Branch-specific success never clears another client's debt, except that a successful fixed-branch ordinary write can cover the legacy empty key. An explicit not-mirrored configuration clear remains branch-agnostic and fenced.

This is internal retry durability. It adds no writer-side PENDING stamp, new write/delete trigger, clone authority, encrypted-memory export, production provider access or new write-back policy.
