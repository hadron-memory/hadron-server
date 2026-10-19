# S5 #2021 implementation checkpoint

Owner: Diego. Branch: `feature/2021-delivery-stall`. This is an unfinished foundation, not a frozen review head or an activated delivery alarm service.

## File reservations

S5 owns its additions to `prisma/schema.prisma`, its delivery-wait migration and invariant SQL, `src/lib/tickers/deliveryWait.ts`, `src/lib/tickers/deliveryState.ts` and their tests, plus delivery event writers in `src/lib/agentTasks/events.ts` and the task/delivery escalation separation in `stall.ts`. Coordinate changes to these files with Diego.

Anne owns S13 read projection, GraphQL/SDL/MCP composition and new deliveryHealth2029 tests. No frozen read DTO is promised by this checkpoint; `deliveryAlarmSnapshot` is a candidate internal seam only.

## Implemented foundation

Metadata-only per-message interval union, selective range coverage, explicit rollout/completeness state, one worker alarm anchor, persisted uncovered-wait escalation baselines, acknowledgment stopping escalation, committed-mark or R62 channel-lifecycle closure, and immediate aged successor selection. Policy writes and alarm evaluation share authority/App-budget/worker locks. SQL rejects invalid coverage and extra delivery-event metadata. Historical events remain immutable. The effective transition seam now supports early cancellation/replacement of a future policy expiry without changing certified past time. Alarm owners are derived from the canonical reportsTo walk under its shared graph lock, with current-manager fallback only when no reporting line exists. Interval reads are restricted to time intersecting the pending candidates or active anchor.

## Integrated dependency

Merged current main at `41f6afd7` (merge commit, no rebase), bringing S9's persisted `loadDeliverySettings` seam. Both alarm creation and escalation load the deciding App's effective stuck window; callers no longer supply a local window override. A 30-minute nondefault window is pinned against the former 15-minute assumption.

## Outstanding before freeze

Wire canonical policy producers and authoritative reached-message selection; integrate mark reconciliation with S1/S2, and deliver owner wakes rather than only recording schedules. S1-dependent authenticated delivery.held reporting and channel hold observations remain pending S1. Add integration/race coverage for each connected producer and public gate. Complete S13 safe projection contract with Anne. No production sweep or public report API is enabled here, so incomplete observation cannot silently become zero deducted time.

## Evidence

Red commits `f420cd61` and `006d5b8f` precede implementation. Targeted standard Vitest run: 163/163 passing across deliveryWait, deliveryState, deliveryPolicy, deliveryScenarios, deliveryInvariants, existing task stall and task invariant suites, S9 settings/resolver suites, and the closed Worker-reference fence inventory. Persisted S7 pause carry and S8 selective-coverage pins reload state between deciding transactions. TypeScript check passed. Tests use an isolated local PostgreSQL database and repository-managed per-run clones.

## Candidate S13 seams (not the complete frozen DTO)

`loadDeliveryWait(tx, message, asOf)` returns `{ waitedMs, waitAsOf, suppressed }` using the ledger and explicit completeness certificate. `deliveryAlarmSnapshot(tx, workerId, asOf)` returns null or `{ episodeId, eventId, channelId, channelIncarnation, firstPendingSeq, waitedMs, waitAsOf, state: ACTIVE | SUPPRESSED, acknowledgedAt }`. Both require authorized callers. They throw `DELIVERY_WAIT_INCOMPLETE` rather than fabricate zero deducted time. Raw exception evidence never leaves these seams. The per-channel hold projection still needs S1 integration, so this is not the complete S13 current-health DTO or an invitation to activate the path.

The policy-owner seam is `transitionDeliveryException(tx, { workerId, cause, coverage, effectiveAt, active, until? })`, inside the common lock transaction, after re-reading the owning policy. Coverage is whole-worker or exact channel/incarnation/seq range. Policy producers must be integrated before completeness can be certified or the affected evaluator path enabled.

## Test-harness finding

Negative delivery SQL pins now use PostgreSQL structured code/constraint fields, avoiding Prisma source-decorated error-text false positives. Numeric payload slots and timestamp shapes are checked, not just root key names. Captured at `hrn:node:hadronmemory.com:hadron-server:findings:prisma-source-snippet-false-positive-constraint-test`.

## R56/R62 alignment (050:26 rev 12)

R56 confirms that either committed read or delivery coverage ends the episode. R62 also ends it when its channel is deleted, physically removed, or replaced by another incarnation. A missing candidate alone still proves nothing. The platform reconciliation writer records one `delivery.resumed` with `reason: channel-deleted`, the old channel/incarnation, server timestamp and `principal: { kind: platform }`; it deliberately omits `throughSeq`, since channel retirement is no mark movement. Encoding this end as resumed retains the spec's explicit Proposed status. The history row is immutable. Stale candidates cannot re-raise an episode for the old occupancy, and escalation also reconciles this end before requiring additional clock coverage.

The current-alarm read seam returns null for a retired/replaced channel even before the next write reconciliation; a read itself appends nothing. The lifecycle transaction/evaluator still needs integration before activation. S13 should project this canonical currentness rather than treating a retained anchor row as an active alarm. R65 adds no draft-cleared event.

The three new Worker-reference tables install the #1162 MVCC fence through the additive S5 SQL source. The already-deployed #1162 migration remains unchanged; its closed inventory test includes the newer source. This closes the first draft CI failure.
