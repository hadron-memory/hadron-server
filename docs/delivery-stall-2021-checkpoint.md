# S5 #2021 implementation checkpoint

Owner: Diego. Branch: `feature/2021-delivery-stall`. This is an unfinished foundation, not a frozen review head or an activated delivery alarm service.

## File reservations

S5 owns its additions to `prisma/schema.prisma`, its delivery-wait migration and invariant SQL, `src/lib/tickers/deliveryWait.ts`, `src/lib/tickers/deliveryState.ts`, `src/lib/tickers/deliveryHolds.ts`, `src/lib/tickers/deliveryHealthRead.ts` and their tests, plus delivery event writers in `src/lib/agentTasks/events.ts` and the task/delivery escalation separation in `stall.ts`. Coordinate changes to these files with Diego.

Anne owns S13 read projection, GraphQL/SDL/MCP composition and new deliveryHealth2029 tests. The complete internal DTO is now exported as `DeliveryHealthSnapshot` by `deliveryHealthRead.ts`. This confirms the read shape for S13 integration; it does not freeze the overall draft or enable an unauthenticated report path.

## Implemented foundation

Metadata-only per-message interval union, selective range coverage, explicit rollout/completeness state, one worker alarm anchor, persisted uncovered-wait escalation baselines, acknowledgment stopping escalation, committed-mark or R62 channel-lifecycle closure, and immediate aged successor selection. Policy writes and alarm evaluation share authority/App-budget/worker locks. SQL rejects invalid coverage and extra delivery-event metadata. Historical events remain immutable. The effective transition seam now supports early cancellation/replacement of a future policy expiry without changing certified past time. Alarm owners are derived from the canonical reportsTo walk under its shared graph lock, with current-manager fallback only when no reporting line exists. Interval reads are restricted to time intersecting the pending candidates or active anchor.

## Integrated dependency

Merged current main at `41f6afd7` (merge commit, no rebase), bringing S9's persisted `loadDeliverySettings` seam. Both alarm creation and escalation load the deciding App's effective stuck window; callers no longer supply a local window override. A 30-minute nondefault window is pinned against the former 15-minute assumption.

## Outstanding before freeze

Wire canonical policy producers and authoritative reached-message selection; integrate mark reconciliation with S1/S2, and deliver owner wakes rather than only recording schedules. The internal accepted-hold writer and current hold projection exist; S1-dependent authenticated delivery.held reporting remains pending S1. Add integration/race coverage for each connected producer and public gate. Integrate the complete pending enumeration supplied by Anne beside the S1 loader. No production sweep or public report API is enabled here, so incomplete observation cannot silently become zero deducted time.

## Evidence

Red commits `f420cd61` and `006d5b8f` precede implementation. Targeted standard Vitest run: 163/163 passing across deliveryWait, deliveryState, deliveryPolicy, deliveryScenarios, deliveryInvariants, existing task stall and task invariant suites, S9 settings/resolver suites, and the closed Worker-reference fence inventory. Persisted S7 pause carry and S8 selective-coverage pins reload state between deciding transactions. TypeScript check passed. Tests use an isolated local PostgreSQL database and repository-managed per-run clones.

## Candidate S13 seams (not the complete frozen DTO)

`loadDeliveryWait(tx, message, asOf)` returns `{ waitedMs, waitAsOf, suppressed }` using the ledger and explicit completeness certificate. `deliveryAlarmSnapshot(tx, workerId, asOf)` returns null or `{ episodeId, eventId, channelId, channelIncarnation, firstPendingSeq, waitedMs, waitAsOf, state: ACTIVE | SUPPRESSED, acknowledgedAt }`. Both require authorized callers. They throw `DELIVERY_WAIT_INCOMPLETE` rather than fabricate zero deducted time. Raw exception evidence never leaves these seams. Current-alarm reads also exclude anchors already covered by a committed read/delivery mark, without appending or altering history. The per-channel hold projection still needs S1 integration, so this is not the complete S13 current-health DTO or an invitation to activate the path.

The policy-owner seam is `transitionDeliveryException(tx, { workerId, cause, coverage, effectiveAt, active, until? })`, inside the common lock transaction, after re-reading the owning policy. Coverage is whole-worker or exact channel/incarnation/seq range. Policy producers must be integrated before completeness can be certified or the affected evaluator path enabled.

## Test-harness finding

Negative delivery SQL pins now use PostgreSQL structured code/constraint fields, avoiding Prisma source-decorated error-text false positives. Numeric payload slots and timestamp shapes are checked, not just root key names. Captured at `hrn:node:hadronmemory.com:hadron-server:findings:prisma-source-snippet-false-positive-constraint-test`.

## R56/R62 alignment (050:26 rev 12)

R56 confirms that either committed read or delivery coverage ends the episode. R62 also ends it when its channel is deleted, physically removed, or replaced by another incarnation. A missing candidate alone still proves nothing. The platform reconciliation writer records one `delivery.resumed` with `reason: channel-deleted`, the old channel/incarnation, server timestamp and `principal: { kind: platform }`; it deliberately omits `throughSeq`, since channel retirement is no mark movement. Encoding this end as resumed retains the spec's explicit Proposed status. The history row is immutable. Stale candidates cannot re-raise an episode for the old occupancy, and escalation also reconciles this end before requiring additional clock coverage.

The current-alarm read seam returns null for a retired/replaced channel even before the next write reconciliation; a read itself appends nothing. The lifecycle transaction/evaluator still needs integration before activation. S13 should project this canonical currentness rather than treating a retained anchor row as an active alarm. R65 adds no draft-cleared event.

The three new Worker-reference tables install the #1162 MVCC fence through the additive S5 SQL source. The already-deployed #1162 migration remains unchanged; its closed inventory test includes the newer source. This closes the first draft CI failure.

## Migration smoke baseline

The smoke workflow now applies main's post-push SQL while main's prisma tree is still checked out, before restoring this PR and deploying its new migration. A schema-only baseline had omitted the already-deployed #1162 function, causing a false 42883 failure when the new S5 triggers called it. An isolated main-to-S5 migrate-deploy replay and the workflow's unchanged drift verification pass; the disposable smoke database was removed. Captured at `hrn:node:hadronmemory.com:hadron-server:findings:migration-smoke-baseline-needs-main-raw-sql`.

## Confirmed S5 read DTO for S13 (internal, complete pending required)

`deliveryHealthSnapshot(tx, { appId, workerId, asOf, pending, limit? })` exports its inferred result as `DeliveryHealthSnapshot`. The caller must use the existing App read gate and one consistent transaction/asOf. The S1 adapter must walk every page for the selected worker at the same `now`, then supply `pending: { complete: true, asOf, messages }`. Each message is `{ workerId, channelId, channelIncarnation, seq, dueSince }`; `dueSince` is post time. Rename S1's `incarnation` at the adapter boundary. Include timing-withheld and rendered-overflow messages, omit encrypted channels without trace. `state=due` is S4 plus timing eligibility, independent of renderer limits; neither that label nor `withheldReason` is evidence of a policy-clock interval. Missing/incomplete/mismatched snapshots fail with `DELIVERY_PENDING_INCOMPLETE`. Missing producer coverage fails with `DELIVERY_WAIT_INCOMPLETE`, including when pending is empty.

The result is `{ appId, workerId, asOf, pendingMessageCount, heldChannelCount, activeAlarmCount, suppressedAlarmCount, alarm, channels, totalChannels, hasMore }`. Counts cover the whole current set; active/suppressed alarm counts are independently 0 or 1. `alarm` is null or `{ episodeId, eventId, anchor: { channelId, channelIncarnation, seq }, state: ACTIVE|SUPPRESSED, waitedMs, waitAsOf, suppressionClassification: NONE|EXCEPTION, acknowledgedAt, acknowledgedBy }`. Ack is independent of currentness/closure. `acknowledgedBy` is null or a typed worker/user id.

Each channel is `{ channelId, channelIncarnation, hold, pendingMessageCount, candidate }`. The candidate is null or `{ channelId, channelIncarnation, seq, dueSince, waitedMs, waitAsOf, suppressionClassification }`. Selection prefers an uncovered qualifying message, then uncovered younger messages, then suppressed messages, in post-time/sequence order. This prevents an older selectively suppressed message from hiding a later qualifying one. Raw ledger evidence is never returned. Details sort by channel id (only one current incarnation/hold per channel), default 50, clamp 1..200; truncation changes neither counts nor the singular alarm.

`recordDeliveryHold` is an internal trusted write primitive under the common worker lock, not an authenticated reporting API. It persists a separate hold id, stable `since`, latest semantically changed `observedAt`, closed reason, opaque nullable terminal id and normalized host-key or self-session principal. Duplicate observations append nothing. Semantic changes retain identity; covering max(read,delivered) starts a new hold identity on the next accepted report. SQL allowlists both mutable row and immutable `delivery.held` payload; held events never invent an alarm episode id. Worker/session references use the #1162 fence. Current reads exclude covered or retired/replaced holds without rewriting history. Full policy-owner/report integration is still required before activation.

Red commit `bbec7d31` fails because the two new service modules do not exist. Green evidence: 168/168 tests in 11 suites, then 21/21 affected tests including the additional mark-covered currentness pin; TypeScript passes, raw migration replay from main plus the existing drift verifier passes; disposable replay database removed. This extends the previous CI-green checkpoint; the new pushed head must finish CI before any freeze claim.

## S1 enumeration integration (frozen #2079 e3179735)

Merged the frozen S1 dependency by merge commit, without editing its batch/ack reservations. `deliveryPendingSnapshot.ts` now exports `loadPendingDeliverySnapshot(tx, {ctx,app,hostId,workerId,asOf,first?})` and `loadDeliveryHealthSnapshot(tx, {...args,limit?})`. These are internal seams after the existing App/S1 host or own-session authority gate, not new reporting or read APIs. The second facade enumerates and reads canonical health inside the same transaction. S13 may call it in its authorized snapshot; it never grants access itself.

The transaction must be REPEATABLE READ or SERIALIZABLE; pooled clients and READ COMMITTED are refused as `DELIVERY_SNAPSHOT_REQUIRED`. Every page starts from the first cursor, selects only the named worker, uses the same transaction and fixed copied asOf, and discards request caches. Complete means all pages exhausted. Any failure, contradictory completion/cursor, empty incomplete page, cursor cycle, duplicate/foreign metadata or invalid identity/time fails instead of returning partial counts. Mapping keeps post-time dueSince and renames incarnation; timing labels and renderer caps never filter the complete set. The adapter never certifies policy coverage; the health facade still refuses `DELIVERY_WAIT_INCOMPLETE`, even when the enumeration is complete.

Red pins at `1ff58f02` (ten absent-adapter failures) and `4b3f5e12` (absent health facade) precede implementation. Real DB tests include a covering read mark committed on another connection between pages: the original snapshot retains all 13 messages, the next transaction sees none. The integration/clock regression run passes 60/60 across eight suites. Four independent mutants (isolation validation, first-page-only completion, pooled-context binding, duplicate identity acceptance) are killed by the new pins; restored-source verification and full-suite validation follow on the pushed head. Captured test-harness finding: `hrn:node:hadronmemory.com:hadron-server:findings:prisma-transaction-proxy-vitest-identity-formatting`.

Ada #21994 assigns the held-report resolver/MCP wiring to S5; batch mark-transaction reconciliation remains S1's. Final held wire naming/proof spelling and the accepted host/self gate reuse are being reconciled with Liam/Xavier before transport implementation. No evaluator/public read activation is enabled by the adapter.

## Authenticated held reporting (Ada #21994; scoped fit #22030/#22152)

S5 now owns `reportDeliveryHold(input: DeliveryHoldReportInput!)` and `hadron_report_delivery_hold`. `batchId` is the single signed `DeliveryBatch.id` from S1, not batchKey and not a separate proof field. The only other fields are the accepted closed reason and nullable/omitted opaque terminalId. Unknown fields and invalid values are refused before writes with a fixed error. The S1 self gate is reused by the one-word `ownBatchSession` export Liam approved; its body and batch/ack files remain unchanged.

The facade acquires the common authority -> reporting graph -> App budget -> worker wake order, including caller/holder/channel-memory authorities before lower locks. It reloads current caller authority, host scopes/registration or own live session, current recipient and shared S1 eligibility. Every rendered seq must remain pending in its current channel incarnation. Signature/requester binding and deciding-server-time freshness remain mandatory. All channel holds, immutable allowlisted events and host-use audit commit atomically. Duplicate observations retain hold identity/since and append no new event. Output omits principal/proof/body and includes exhausted pageInfo: the verifier permits at most ten rendered seqs and therefore at most ten channel holds; nothing is truncated. No marks/ack receipts/ticks/reservations/budget charges or policy-clock certification occur.

The MCP registration preserves unknown fields through SDK validation so the shared parser can refuse them instead of silently stripping private draft/body/proof metadata. Both direct and actual SDK JSON-RPC transport tests cover the no-echo refusal. GraphQL keeps its typed input. Stock GraphQL variable-coercion errors can echo the supplied object before the resolver; Xavier #22152/#22163 and Ada #22167 assign shared redaction to Anne's #2087/#2090. The exact real-HTTP signed-batchId privacy pin is currently `it.fails`; it must become a required pass after integrating the shared fix, before any final readiness. The proposed JSON input workaround is SUPERSEDED; no input typing is lost. `hrn:node:hadronmemory.com:hadron-server:findings:typed-graphql-variable-errors-echo-secret-values` records the evidence/routing without secrets.

Red held pins: `00b0d239`; concurrency/atomicity/privacy pins: `2371e7e5`. The initial held implementation is pushed at `8c2a2145`, explicitly not frozen. Seven independent guard mutants are caught by real cases: signature; receiving key on the same host; deciding freshness; host scope recheck after lock wait; own-session liveness after lock wait; partial rendered coverage; strict input allowlist. An initially malformed scope mutant did not collect tests and is NOT evidence; its corrected form fails the actual queued-scope assertion. The adapter/held latest focused run is 48 passes plus one expected privacy failure across 49 tests, including a real ten-channel accepted / eleven-seq refused verifier-boundary case. Typecheck passes. Full local validation is running on the current implementation; the earlier full run was cancelled after the S1 base changed and is not acceptance evidence.

Still unfinished: S1/S2 mark-transaction reconciliation (Liam-owned), policy producer coverage/certification, evaluator/lifecycle hooks and current-authority owner-wake delivery. The public held facade is implemented on the draft; it is not a deployed activation claim or authority to enable an incomplete evaluator. S13 may consume the internal same-snapshot health facade after its own gates; it does not infer wall-clock eligibility or repair missing policy coverage.


## Projection privacy and deciding row fences

Author review found two integration gaps before readiness. Red db29a0c3 proves that encrypted pending omission alone could still expose a stored hold/current alarm through the facade. The facade now obtains S1's authorized channel set in the same snapshot and passes it to the canonical health projection for the stored hold query, alarm anchor and counts too. Caller-denied and holder-denied cases are also pinned. Hidden metadata is omitted; reads do not alter retained history. Raw deliveryHealthSnapshot is a trusted whole-worker primitive; caller-scoped S13/host/self reads must use loadDeliveryHealthSnapshot or an equivalently authorized visibility mask. Finding: hrn:node:hadronmemory.com:hadron-server:findings:delivery-health-stored-metadata-needs-channel-visibility.

Red f19a3a3f adds a real memory-row visibility-change barrier. The old facade acquired advisory authorities but never waited for the changing memory row. Held reporting now enters through existing withAuthorizedTx: authority anchors AND current caller/owner/memory rows are fenced before reporting-graph/budget/worker locks. lockDeliveryState shares the existing S5 lower lock order without a nested transaction or duplicated public gate. App/memory ownership drift refuses rather than using a stale anchor set. S1's session helper body and proof/ack files remain unchanged.

Prior full-suite attempts were cancelled for the upstream base change and substantive author-review fixes; they are not acceptance evidence. Final focused/typecheck/full/CI results are recorded on the later pushed head. No new platform rule or citation is minted: this implements existing no-trace visibility, transactional authority and the accepted held contract.


## Current checkpoint validation (27c9a057)

Current-source full suite completed successfully: 759 files, 13,264 passed tests, one expected privacy failure, seven skipped (426.41s). Typecheck and git diff --check pass. Latest focused five-file run: 66 passes plus that same expected privacy failure. The expected failure is the real HTTP typed-variable signed-batchId non-echo pin; it is not a waiver and must become a required pass after frozen shared #2090 integration. Earlier interrupted broad runs remain excluded from acceptance evidence.

This is still a draft checkpoint. The private evaluator boundary has Xavier's scoped engineering fit (#2021 comments 6258953175/6258957002), with Vera's caller-less/unheld-reader product fit pending. Liam owns the separate S1 enumeration and mark integration. Policy producer coverage/certification, lifecycle/evaluator and current-authority owner-wake hooks remain incomplete; no activation or final review/QA claim. Ada's S10 #2026 follow-on starts after S5 freezes.
