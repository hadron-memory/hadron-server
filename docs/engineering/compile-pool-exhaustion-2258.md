# #2258 pool-exhaustion residual: disposition packet (task 01a16b44ba417c6e982068dc921315d0)

Status: ANALYSIS + RED EVIDENCE ONLY, on top of `basil/2046-s94` @c65e694a (the head QA delta 2 approved). No production change, no capacity/retry policy change, no stress run. Addresses Cooper's P3 (comment 6337728465): with the fence held and ~40 managers queued, 3-7 got a generic `INTERNAL_SERVER_ERROR` at 10 s and an anonymous refusal waited 10 s for a pool connection.

## Cause (VERIFIED by reading `compileBootPrompt.ts` at c65e694a)
- The 10 s is Prisma's client pool-acquire timeout (`pool_timeout`, default 10 s; `src/api/health.ts` documents it), surfacing as `PrismaClientKnownRequestError` code `P2024`, not the 5 s `maxWait` the code sets for the fence transaction (`POOL_WAIT_MS`, :69, :250-:409).
- The pre-fence reads run on the pooled client OUTSIDE any budgeted transaction: `loadCompileOwner` (:196) and the lock-free pre-gate `assertMayWriteBootPromptPointer` (:202). Both are raced against the 30 s deadline by `withinBudget`, which is longer than the 10 s pool timeout, so the pool's own timeout fires first.
- `isBudgetFault` (:153) recognizes only P2028 / 55P03 / lock-timeout / expired-transaction text. P2024 is not in the set. The pre-fence reads are also not inside the `try` that applies `isBudgetFault` (:211-:226). So a P2024 from either escapes as a raw error and the GraphQL layer reports `INTERNAL_SERVER_ERROR`.
- The fence transaction's own acquire (`maxWaitMs: poolWait`) throws P2028 and IS already mapped to the sanitized `CONFLICT` (QA saw this at 25 s for a manager behind the held fence).
- The anonymous 10 s wait is the same mechanism: the pre-gate that refuses an anonymous caller is itself a pooled read, so it queues for a connection behind saturated managers.

## Red evidence (deterministic, no stress, no timing)
`src/api/graphql/schema/compileBootPromptPool2258.test.ts` stands in for pool saturation by making the named read fail with the pool's own P2024, and asserts the sanitized answer and that nothing was written:
- P1 owner read (`agent.findUnique`) -> RED: raw error ("Timed out fetching a new connection from the connection pool."), code not CONFLICT.
- P2 pre-gate read (`orgMember.findFirst`) -> RED: same raw P2024.
- P3 control: an unrelated raw error is NOT converted to CONFLICT -> GREEN.
Run on this branch: 1 passed, 2 failed (the two reds). The no-write assertion is in the tests but is only reached once P1/P2 stop failing earlier; nothing is written on these paths today because both fail before any write. Not covered: a real saturated pool, worker-session/impersonated callers, run principal, HTTP layer (Cooper's "not run" list is unchanged).

## Classification proposal (for Xylon to CHECK; not implemented)
1. Treat P2024 as a budget fault: add `code === 'P2024'` to `isBudgetFault`, and route the pre-fence reads (`loadCompileOwner`, the pre-gate) through the same classification so it answers the existing sanitized `CONFLICT` ("could not be compiled right now; retry"), says nothing about the target, leaks no pool detail, and is retryable. This changes an error code on a failing path only; the contract's refusals are unchanged. No automatic retry is added.
2. Open choice, not proposed as default: bound the pre-fence reads at `POOL_WAIT_MS` (5 s) instead of letting Prisma's 10 s decide, by racing them against `min(deadline, POOL_WAIT_MS)`. This shortens the anonymous wait but cannot cancel the queued acquire (the pooled query still holds its place), and adds a second budget. I would not do it without a measurement; the saturation itself (40 managers on one fence) is the real cost and is a capacity matter, out of scope.
3. The fence-held manager's wait stays as is (already CONFLICT at the one 30 s budget).

## Limits
Static plus synthetic: P2024 is injected, not produced by real saturation, so the evidence proves the classification gap, not the saturation timings. The unauthenticated-wait finding is explained by the same cause, not separately reproduced. Final compile-readiness CM/QA obligation is retained by Xylon's disposition.
