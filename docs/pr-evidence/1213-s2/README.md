# #1213 S2 local evidence

Base: `08dd60a5f`. Red pin commits: `caf28546c` and `1fdc529e2` (the latter corrects the observer for S1's singleton string-key fast path). Replacing all seven modified production files with that base, then running the corrected integration file with `-t 'input-triggered writer participation|initial stored-signal snapshot'`, yields seven assertion failures and one passing ordinary-update control. The later parameterized merge snapshot-order pin separately fails when its transaction-entry acquisition is omitted.

The new suites are `src/lib/governanceParticipation1213.test.ts` and `src/api/graphql/schema/resolvers.governanceMemory1213.test.ts`. They use the repository's private per-run PostgreSQL clones. No production database was used. Normal restored-suite results are reported in the PR description.

`mutants.json` records 19 individually restored mutants; each returned exit1 for the relevant assertion or missing observed key wait. They were run one at a time using `pnpm -s vitest run <suite> -t <pin name>`, restoring the original source in `finally` before the next run. The entry-order test was strengthened after the original extract omission survived: the later gate still took the key, so final carry/wait alone did not establish the initial-snapshot boundary.

| Mutation | Detecting assertion |
| --- | --- |
| Remove participation | Signal/kind/create own-memory acquisition count |
| Truthiness instead of definedness | Null role and false/null runnable predicate cases |
| Unconditional participation | Ordinary content-only update acquires zero memory keys |
| Omit kind/create/individual role/individual runnable branch | Corresponding input predicate/acquisition cases |
| Add unread `GovernedState` member | Exact AST member / Proxy-read set equality |
| Infer participation from unlocked existing row | Ordinary prior row with explicit clearing/create/kind input still participates |
| Omit source key on memory or node clone | Actual writer PID must wait on held exact source-memory key |
| Omit task-export entry key | Waiting writer must not already hold its per-node advisory key |
| Omit declared-set guard | Out-of-set endpoint must refuse, preserving content and edges |
| Omit extract/merge relocate entry key | First transaction-client stored-node snapshot follows completed memory acquisition |
| Omit restore/node merge/GraphQL move key | Actual writer PID must wait on held exact source-memory key |
| Omit source from MCP move set | Real MCP move closure's PID waits on source key before destination overwrite |

The runtime's bounded failed-wait exception is intentional mutant evidence, not a timeout-as-success test. Holders and contenders are released and drained even when the expected key wait is missing. S1's existing `channelMemoryLock1213.test.ts` separately covers real physical hash collision, signed key acquisition order and complete-set deduplication; S2 reuses that unchanged helper.

## First hosted run and harness repair

The first full hosted run at `df4155629` exposed six existing test harness assumptions; no production change was needed to address them. The repair changes only tests and evidence:

- `lockAcquisitionOrder.test.ts` now observes only the two-argument loc namespace instead of fabricating a pair from a one-argument memory key. Its new exact-key regression pin is assertion-red with the old observer and green after restoration (one failure, seven controls skipped in that targeted red run).
- `nodeLockCompatibility2054.test.ts` retains the original create-vs-move P-key probe. Owning move/reservation pairs now attribute the earlier C wait to the exact backend/holder/key and assert no old path key is retained while waiting; all committed-state/deadlock assertions remain.
- `resolvers.searchReplace.test.ts` observes the actual moving backend waiting on bulk's exact C key, rather than searching for a query mentioning nodes. Content, move and revision lineage assertions remain; this does not implement S3's governed-skip behavior.
- `server.edgeTools.test.ts` queues the move first and promotion second behind a synthetic C holder, then proves the move waits on the held edge row while promotion waits on the move's C. Releasing both lets promotion retry against the relocated source; existing edge/carry assertions remain.
- `resolvers.attestationSeams3437.test.ts` preserves the ordinary-update no-wait control. An admitted create now proves the task-kind contender waits on C before allowing create to commit, then checks the admitted task revision and later stale-claim refusal. It never awaits the blocked contender from inside the holding transaction.
- `resolvers.legacyChatSeq2987.test.ts` injects the stale absent-target answer through clone's real owning transaction client. The tombstone seq/revision and `SEQ_PROTECTED` assertions remain.

After restoration, 596 tests pass across 29 focused/neighbor files (561 plus 35); the first-head production sources are byte-identical. The next hosted run, not these local results, decides whether the fix head may freeze.

## Main carry before the first freeze

Main `cb7a3f3c381862dc91d2f79b90f2c95eeef565f6` was merged cleanly after the test repair. Shared files: `governedRole.ts` adds Question MCP metadata/refusal guidance in separate hunks from S2's participation helper; `server.ts` imports/registers Question tools separately from the owning-move key set. The merge imports 22 main files, including Question approval/tools/SDL and principal/diagnostic changes; the S2 PR's own diff remains 18 files with no schema/SDL/migration delta.

Post-carry focused validation passes **678 tests in 32 files**, including all six repaired harnesses, the new Question MCP tool suite, Question answers and approvals. Main's Question tools delegate to the existing Question resolver owners; they introduce no additional caller-owned signal transaction outside that audited path. The approval metadata gate does not change role/runnable participation.

## Second main carry before the first freeze

The full hosted run at `828f53a1864a15d6d1a5dbce68faa483d9548d7e` passed. Before freezing, the fresh-main overlap check found `resolvers.mutation.node.ts` changed by #1333/#4613. Main `af2bf70f5bca706637537ce3bcd1ec18b6c872b3` was merged cleanly as `f00160f67da6b3ca693a8eab1a16b38ed2a7c75b`.

The two shared-file changes pass `{ lock: false }` to role-writer preview checks; they remain intact, so preview paths do not reintroduce App/Agent `FOR SHARE` locks. The carry also imports main's OWNER writer semantics and tests, unique-constraint invariant repair and ceremony test changes (16 files total), including schema and SDL description updates. This carry is not test-only; the PR-owned diff still has no schema, SDL or migration change. The S2 participation helper and transaction-entry sets are unchanged. Post-carry checks include the OWNER/role-writer suites as well as S2, its repaired harnesses and owning clone/extract/move neighbors. Exact-head validation results and the eventual frozen head are recorded in signed PR receipts.


### Agent restore concurrency fixture after review fixes

The new required system-memory coordination serializes Agent snapshot restores before their node reads. The old #2477 barrier demanded two simultaneous absent-node reads and therefore timed out at CI head35b42ab75. The repaired test observes the second transaction PID waiting on the exact database/classid/objid/objsubid memory key, blocked by the first PID while the first holds its real absent read. It then verifies the actual read sequence is absent then present, both restores succeed, and the final nodes/edge are intact. Removing the owning restore memory-key acquisition makes the external `observedQueuedPeer` assertion fail; the production source is restored after the mutant. The repaired fixture plus content-validation report suite pass49/49 locally. A separate PG16 CI failure in the report suite was its unordered planner precondition (the two ids reversed), not its behavior assertion; no report code or test is changed here.

Peter’s follow-through: the original #2477 test requires both restore requests to succeed, with two real auto-saves; it does not specify a losing request. The replacement retains both successes and the single final graph, and now explicitly checks exact revision rows: each request returns a distinct auto-save loc, the resulting slot set is exactly the prior slots plus those two, all prior revision rows (id, data and deletion marker) are unchanged, and both new slots are live. This adds no production behavior or change to contentValidationReport1332.
