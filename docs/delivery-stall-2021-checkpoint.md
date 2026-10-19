# S5 #2021 implementation checkpoint

Owner: Diego. Branch: `feature/2021-delivery-stall`. This is an unfinished foundation, not a frozen review head or an activated delivery alarm service.

## File reservations

S5 owns `prisma/schema.prisma`, its delivery-wait migration and invariant SQL, `src/lib/tickers/deliveryWait.ts`, `src/lib/tickers/deliveryState.ts` and their tests, plus delivery event writers in `src/lib/agentTasks/events.ts` and the task/delivery escalation separation in `stall.ts`. Coordinate changes to these files with Diego.

Anne owns S13 read projection, GraphQL/SDL/MCP composition and new deliveryHealth2029 tests. No frozen read DTO is promised by this checkpoint; `deliveryAlarmSnapshot` is a candidate internal seam only.

## Implemented foundation

Metadata-only per-message interval union, selective range coverage, explicit rollout/completeness state, one worker alarm anchor, persisted uncovered-wait escalation baselines, acknowledgment stopping escalation, committed-mark-only closure, and immediate aged successor selection. Policy writes and alarm evaluation share authority/App-budget/worker locks. SQL rejects invalid coverage and extra delivery-event metadata. Historical events remain immutable. The effective transition seam now supports early cancellation/replacement of a future policy expiry without changing certified past time. Alarm owners are derived from the canonical reportsTo walk under its shared graph lock, with current-manager fallback only when no reporting line exists. Interval reads are restricted to time intersecting the pending candidates or active anchor.

## Outstanding before freeze

Wire canonical policy producers and authoritative reached-message selection; consume persisted S9 timing; integrate mark reconciliation with S1/S2, and deliver owner wakes rather than only recording schedules. S1-dependent authenticated delivery.held reporting and channel hold observations remain pending S1. Add integration/race coverage for each connected producer and public gate. Complete S13 safe projection contract with Anne. No production sweep or public report API is enabled here, so incomplete observation cannot silently become zero deducted time.

## Evidence

Red commits `f420cd61` and `006d5b8f` precede implementation. Targeted standard Vitest run: 133/133 passing across deliveryWait, deliveryState, deliveryPolicy, deliveryScenarios, deliveryInvariants, existing task stall and task invariant suites. Persisted S7 pause carry and S8 selective-coverage pins reload state between deciding transactions. TypeScript check passed. Tests use an isolated local PostgreSQL database and repository-managed per-run clones.

## Candidate S13 seams (not the complete frozen DTO)

`loadDeliveryWait(tx, message, asOf)` returns `{ waitedMs, waitAsOf, suppressed }` using the ledger and explicit completeness certificate. `deliveryAlarmSnapshot(tx, workerId, asOf)` returns null or `{ episodeId, eventId, channelId, channelIncarnation, firstPendingSeq, waitedMs, waitAsOf, state: ACTIVE | SUPPRESSED, acknowledgedAt }`. Both require authorized callers. They throw `DELIVERY_WAIT_INCOMPLETE` rather than fabricate zero deducted time. Raw exception evidence never leaves these seams. The per-channel hold projection still needs S1 integration, so this is not the complete S13 current-health DTO or an invitation to activate the path.

The policy-owner seam is `transitionDeliveryException(tx, { workerId, cause, coverage, effectiveAt, active, until? })`, inside the common lock transaction, after re-reading the owning policy. Coverage is whole-worker or exact channel/incarnation/seq range. Policy producers must be integrated before completeness can be certified or the affected evaluator path enabled.
