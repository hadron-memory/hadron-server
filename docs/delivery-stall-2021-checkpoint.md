# S5 #2021 implementation checkpoint

Owner: Diego. Branch: `feature/2021-delivery-stall`. This is an unfinished foundation, not a frozen review head or an activated delivery alarm service.

## File reservations

S5 owns `prisma/schema.prisma`, its delivery-wait migration and invariant SQL, `src/lib/tickers/deliveryWait.ts`, `src/lib/tickers/deliveryState.ts` and their tests, plus delivery event writers in `src/lib/agentTasks/events.ts` and the task/delivery escalation separation in `stall.ts`. Coordinate changes to these files with Diego.

Anne owns S13 read projection, GraphQL/SDL/MCP composition and new deliveryHealth2029 tests. No frozen read DTO is promised by this checkpoint; `deliveryAlarmSnapshot` is a candidate internal seam only.

## Implemented foundation

Metadata-only per-message interval union, selective range coverage, explicit rollout/completeness state, one worker alarm anchor, persisted uncovered-wait escalation baselines, acknowledgment stopping escalation, committed-mark-only closure, and immediate aged successor selection. Policy writes and alarm evaluation share authority/App-budget/worker locks. SQL rejects invalid coverage and extra delivery-event metadata. Historical events remain immutable.

## Outstanding before freeze

Wire canonical policy producers and authoritative reached-message selection; consume persisted S9 timing; integrate mark reconciliation with S1/S2, and deliver owner wakes rather than only recording schedules. S1-dependent authenticated delivery.held reporting and channel hold observations remain pending S1. Add integration/race coverage for each connected producer and public gate. Complete S13 safe projection contract with Anne. No production sweep or public report API is enabled here, so incomplete observation cannot silently become zero deducted time.

## Evidence

Red commits `f420cd61` and `006d5b8f` precede implementation. Targeted standard Vitest run: 128/128 passing across deliveryWait, deliveryState, deliveryInvariants, existing task stall and task invariant suites. TypeScript check passed. Tests use an isolated local PostgreSQL database and repository-managed per-run clones.
