# MCP team cut S1 — review evidence (#3082)

The code switch is `offTeamTool(server)` → `off(...)`. It does not register the preserved callbacks and has no configuration or test re-enable. Both unmodified source scrapers skip that spelling. Runner tools are unchanged; `hadron_task_create` remains in the CLI union through its runner definition, while absent from MCP discovery.

The ruled 71-tool list is frozen literally in `server.mcpTeamCut3082.test.ts`. Source registration keeps 71 tools, of which three signing tools were already opt-in: ordinary runtime discovery keeps 68. The golden removes 71 entries for user variants and 67 for App-key/impersonation variants (four attention tools were already user-only), with only start/end/whoami hashes changed.

## Preserved contracts

`server.mcpTeamCut3082.test.ts` executes each GraphQL family: resume claims/session resume, worker read, register, chat, paged attention, tasks, roster, stop signals and tickers. The retired attention-v1 refusal remains; the family pin uses the supported page operation. The deeper rules remain in `resolvers.sessionWorker.test.ts`, `resolvers.resumeClaim1956.test.ts`, `resolvers.worker.test.ts`, `resolvers.register*.test.ts`, `resolvers.teamChat*.test.ts`, `resolvers.channelChat.test.ts`, `lib/teamAttention.test.ts`, `resolvers.agentTask*.test.ts`, `lib/agentTasks/stall*.test.ts`, `lib/stopSignals/*.test.ts`, `resolvers.ticker.test.ts`, `lib/sessionActivity.*.test.ts` and their focused follow-up suites.

Kept core attribution is exercised over real HTTP in the new `server.mcpTeamCut3082.http.test.ts` (GraphQL-started worker: header and per-tool argument; ended/expired/dormant header: no revival or attribution). Existing core Node, comments and governed create/update doors are retained with GraphQL-started sessions; named concurrent Node batch actor isolation is retained. No wrapper is re-enabled for a test.

## Per-file dispositions

Rows below describe test edits, not a claim that a sibling suite has identical wrapper-format assertions. The wrapper formats are intentionally retired; authoritative behavior remains on GraphQL/lib paths. Mixed tests retain GraphQL assertions; empty retired suites are removed. Historical recovery fixture `testdata/worker-auto-shed.pre2163` remains unchanged.

| File | Disposition |
| --- | --- |
| `scripts/orca-attention-router/router.test.ts` | Updated emitted-text pins to CLI-only instructions, retained recovery/transport controls and historical fixture. |
| `scripts/worker-auto-shed/worker-auto-shed.test.ts` | Updated emitted-text pins to CLI-only instructions, retained recovery/transport controls and historical fixture. |
| `src/api/graphql/deliveryPending2026.test.ts` | Preserved footer contract and parallel named-session isolation; re-seated on a kept core write and pinned CLI remedy text. |
| `src/api/graphql/schema/resolvers.agentTaskFilters2647.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.agentTaskMatching.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.agentTaskRegression2697.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.agentTaskText2664.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.agentTickerTemplate2024.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.bootPromptLint2048.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.castReporting2028.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.closeSessionDefault2249.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.deliveryBatch.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.deliveryBatchSelf.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.deliverySettings2025.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.hostOperation.terminal.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.isolationCapability2660.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.matcher2191Transport.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.minTier2252Transport.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.modelGroups2831Transport.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.openSessionAgent2493.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.resumeClaim1956.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.resumeRefresh2086.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.rosterSummary2178.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.sessionHardExpiry1036.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.startSessionWorkerOracle1937.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.taskEdit2645.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.taskProperties2420.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.teamChatMentions2020.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.teamWork.model1398.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.tickerHostKeyRead2931.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.workerCheckStatus2138.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.workerMiscast1162.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.workerNoSessionReason3077.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.workerProfile1149.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/resolvers.workerSignature1602.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/api/graphql/schema/staffingActEvents2766.test.ts` | Kept resolver/GraphQL cases; removed retired MCP wrapper assertions. Mixed wire tests retain their GraphQL arm; no test-only registration path. |
| `src/lib/appKeyScopes/appKeyScopes.test.ts` | Kept library/resolver coverage; retired MCP-only wrapper assertions. |
| `src/lib/bootPromptPointer2045.test.ts` | Kept library/resolver coverage; retired MCP-only wrapper assertions. |
| `src/lib/channelIncarnation2181.test.ts` | Kept library/resolver coverage; retired MCP-only wrapper assertions. |
| `src/lib/nodeMoveAlias.test.ts` | Preserved core MCP alias/batch/move and resolver concealment assertions; removed only two retired Channel-read wrapper assertions. |
| `src/lib/teamAttention.test.ts` | Kept library/resolver coverage; retired MCP-only wrapper assertions. |
| `src/mcp/apiKeyPropagation1868.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.agentAttribution.test.ts` | Retained core tool behavior; worker fixtures start through GraphQL. Obsolete implicit MCP-worker-binding assertions retired; explicit named/header attribution remains. |
| `src/mcp/server.agentTaskAlarmTools.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.agentTaskAppKey1755.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.agentTaskTools.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.ambientAppPrecedence.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.appKeyScope1749.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.appScopePinning.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.bindReceipt1599.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.callerSessionGate1701.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.castWorker.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.changeWorkerAgent2458.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.channelChat.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.channelPostAuthorship1697.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.chatReplies2841.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.clientKeyHeader.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.commentTools.test.ts` | Retained core tool behavior; worker fixtures start through GraphQL. Obsolete implicit MCP-worker-binding assertions retired; explicit named/header attribution remains. |
| `src/mcp/server.crossAppWorker1597.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.governedDoorShared1769.test.ts` | Retained core tool behavior; worker fixtures start through GraphQL. Obsolete implicit MCP-worker-binding assertions retired; explicit named/header attribution remains. |
| `src/mcp/server.listWorkers.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.mcpTeamCut3082.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.oneMark2018.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.reconnectLegibility.test.ts` | Retained core tool behavior; worker fixtures start through GraphQL. Obsolete implicit MCP-worker-binding assertions retired; explicit named/header attribution remains. |
| `src/mcp/server.register.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.requestSession2123.test.ts` | Retired team-wrapper-only #2123 cases; preserved main's independent #3107 retained-rate-manifest startup regression on merge. Core HTTP attribution/header controls remain in the new cut suite. |
| `src/mcp/server.sessionHeartbeat.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.sessionVocabulary.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.sharedToolShapes2260.test.ts` | Intentional golden cut; invert team presence and retain all remaining shared-schema/heap checks. |
| `src/mcp/server.stallScheduleTools.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.startSessionWorker.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.stopSignalTools.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.taskWarnings2198.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.taskWarnings2607.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.teamChat.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.teamChatDuplicate2015.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.teamChatPostAuthorship1967.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.teamChatSearch2299.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.teamWork.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.tickCode2733.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.tickerTools.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.transportBounds2261.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.unhosted2136.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.workerActivity2103.test.ts` | Retired wrapper-only suite; this MCP endpoint or connection worker-bind workflow no longer exists. Shared GraphQL/lib rules stay; see family coverage below. |
| `src/mcp/server.workerPortalUrl.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |
| `src/mcp/server.workerRecovery.test.ts` | Retained core tool behavior; worker fixtures start through GraphQL. Obsolete implicit MCP-worker-binding assertions retired; explicit named/header attribution remains. |
| `src/test/integration/2087-error-diagnostics.test.ts` | Kept supported tool/GraphQL controls; retired worker-bind/team-wrapper assertions or updated advertised text. |

## Release and downstream limits

No MCP `instructions` text exists in the server to rewrite. The header/auth middleware and shared session settlement are unchanged. Existing pre-cut worker sessions can still attribute core calls; a deployment restart discards in-memory connection bindings. No migration/origin marker is introduced. The non-team `session-app-recovery` token is retained with a narrowed description: kept `end_session` still calls `adoptAppFromSession(id)` and its reconnect pin passes. It promises no MCP worker bind/resume. Other team tokens are removed. MCP end-session may still issue a claim, redeemable with CLI `hadron team session start` without `--as`.

**MERGE/DEPLOY HOLD:** Petra must post phase-2 sweep-clear on #3082 and a CLI release newer than v0.33.0 containing C1–C3 and M5 must be published. S2 cli#1511 and P2 portal#1550 regenerate at the deployed S1 SHA, not this build. Vera owns S3 spec marking; Victor S4 Built lines after deploy. This PR does not modify those repos or mint specs.

## Validation correction before freeze

The first WIP validation pass at 3e1515bfb was stopped and is EXCLUDED: review of the test migration found overly broad edits that removed GraphQL callback execution and race waits. Nine mixed suites were restored from the red-first base, then changed with explicit MCP-only cuts; the waits and callback execution are preserved. Corrected focused run: 10 files, 288 tests pass. This draft had no frozen head or seat verdict to carry. A corrected full-suite run is required. Three additional caller-text pins were red before the fix (worker-binding parameter advice, SDL remedy, actual whoami/claim-end receipts).

## Final fixture audit

The completed native full run at 02d9c1341 reported 20,652 passed, 1 expected fail, 27 failed and 8 skipped (peak load 16.63); the 27 failures exactly matched hosted shards 2/3/4. They were residual MCP-only wrapper cases, retired-tool fixture setup and old capability/remedy text. Nine explicit migrations then passed 268/268: chat-reply setup now uses `createTeamChatMessage` with all GraphQL read assertions preserved; open-session placement, worker-name concealment, signature edits, ticker due times and error diagnostics retain their GraphQL/lib cases while retiring only the removed MCP endpoint cases. Channel creation was removed from the generic MCP oracle table so unknown-tool equality cannot masquerade as an authorization test. Team-attention capability is pinned absent even for an admitted App, and the stop-signal text pin uses the CLI remedy. No production files changed in this correction.

Additional per-file dispositions: `resolvers.workerSignature1602.test.ts` keeps GraphQL wire and H26 guard pins; `lib/tickers/tickDueAt2790.test.ts` keeps all GraphQL/lib timing assertions; `lib/stopSignals/stopSignals2022.test.ts` changes expected remedy only; `lib/teamAttention.test.ts` retains the admitted/uninstalled/nonparticipant capability cases with absent capability; `mcp-existence-oracle-1316.test.ts` retains all core-memory doors and controls.

CLI syntax audit: `hadron team stop lift --help` specifies a positional signal id. The remedy pin was red (1 failure/45 controls) with the obsolete `id=` spelling, then corrected to `hadron team stop lift <id>`.
