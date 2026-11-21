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
