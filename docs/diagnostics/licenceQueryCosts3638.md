# Personal-org Agent licence-check SQL diagnostic (#3638)

Product baseline `cd0da474f51b8742754ed6456db9987b86c7fc77`; diagnostic revision `adb21b402b1252462ecc97aca481219010ef0819`, harness SHA256 `9008c08a6e0023f6d8cd70b88e5ba07b7eb3a28dd715a912f4f5dd75c2d1a6a5`. PostgreSQL `PostgreSQL 17.11 (Debian 17.11-0+deb13u1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`, Prisma `6.19.2`. Node `v22.23.3`. Synthetic run-owned local database only; no product changes, tuning, cache, SQL ceilings, latency or production measurement.

## Reproduction

Use a NEW artifact path (an existing path is refused to prevent stale-success evidence):

```sh
HADRON_3638_ARTIFACT=/private/scratch/new-licence-count.json HADRON_TEST_MAX_WORKERS=2 NODE_OPTIONS=--max-old-space-size=4096 node_modules/.bin/vitest run src/test/diagnostics/queryCount3638.test.ts src/api/graphql/schema/resolvers.licenceQueryCosts3638.test.ts
```

The parallel harness creates its schema-specific run-owned worker clone. Before cleanup/seeding the diagnostic requires parallel mode, the scope/PID/pool-derived worker DB name, exact configured URL pathname, and current_database() equality on BOTH fixture and measured clients. No shared dev/production/serial/base DB may be used. The dedicated measured client disconnects in afterAll; clone cleanup belongs to the test harness.

## Observer and workload

Actual dedicated Prisma query events, not source estimates or model-operation counts. Setup uses a separate client outside spans; initial client/ownership/version queries are outside the span. A later named SELECT event drains awaited work, then is excluded; an exact SELECT 1 positive control catches a silent listener or counted barrier. Span overlap refuses. Table histograms count statements mentioning quoted tables through FROM/JOIN/UPDATE/INTO; joins make categories overlap, so never sum them as SQL totals. No query params, full SQL, credentials or real data are persisted.

Each of 1 and 3 DISTINCT Agents has its own org-owned definition and physical App install; one install memory per Agent, one App, no imported/derived witnesses. First Agent alone gets an approved compiled prompt for preview/chat. Both owner and outsider are AppMembers; only owner is an org READER. Active subscriptions are seeded for the owner. States: active personal-org; owner membership soft-revoked; current-owner licence with outsider viewer; no-user App principal (function-level shape, not middleware/wire auth); PUBLIC org Agent; org-owned App control. Each path runs twice consecutively using the same explicit Context and client. No HTTP/requestAsyncLocalStorage/warm-pool/cache-hit claim. No genuine concurrent revocation/race or expired/deleted subscription workload.

The direct text/license helpers report only THEIR extra qualification, not overall authorization. Thus boot preview can serve for outsider/userless diagnostic shapes while the caller-facing pointer gate is NOT being exercised. getAppMemoryCandidates returns provenance candidates, NOT an authorization decision; downstream path outputs are separately checked. org-App helper zero-query qualification bypass is not proof of overall access. Point/chat paths select the first Agent only, whereas helper/roster paths process all 1/3; their scaling dimensions are intentionally different.

Fixed roster: 6 states × 2 Agent counts × 9 paths × 2 repeats =216 observations plus1 observer control. Each Agent-count test requires108 selected rows; artifact complete=true requires217. A filtered single-count run writes complete=false. Output starts as incomplete and an existing artifact refuses. Numeric values below are observations only; tests assert semantics/instrumentation, NOT these counts as budgets. The JSON is immutable initial evidence, not an imported assertion baseline. Source-before/after regression cost and caller traffic weights are not measured.

## Measured SQL counts

| State | Path | 1 Agent first/repeat | 3 Agents first/repeat |
|---|---|---:|---:|
| active | licence-helper | 3 / 3 | 7 / 7 |
| active | text-helper | 5 / 5 | 11 / 11 |
| active | installed-licence | 8 / 8 | 18 / 18 |
| active | app-memory-candidates | 17 / 17 | 29 / 29 |
| active | readable-install-memories | 8 / 8 | 14 / 14 |
| active | participant-system-folds | 17 / 17 | 29 / 29 |
| active | chat-carrier-apps | 17 / 17 | 17 / 17 |
| active | serve-chat-prompt | 27 / 27 | 27 / 27 |
| active | boot-serve-preview | 19 / 19 | 19 / 19 |
| owner-revoked | licence-helper | 2 / 2 | 4 / 4 |
| owner-revoked | text-helper | 3 / 3 | 5 / 5 |
| owner-revoked | installed-licence | 7 / 7 | 15 / 15 |
| owner-revoked | app-memory-candidates | 13 / 13 | 19 / 19 |
| owner-revoked | readable-install-memories | 6 / 6 | 8 / 8 |
| owner-revoked | participant-system-folds | 13 / 13 | 19 / 19 |
| owner-revoked | chat-carrier-apps | 11 / 11 | 11 / 11 |
| owner-revoked | serve-chat-prompt | 13 / 13 | 13 / 13 |
| owner-revoked | boot-serve-preview | 3 / 3 | 3 / 3 |
| outsider | licence-helper | 3 / 3 | 7 / 7 |
| outsider | text-helper | 5 / 5 | 11 / 11 |
| outsider | installed-licence | 8 / 8 | 18 / 18 |
| outsider | app-memory-candidates | 16 / 16 | 28 / 28 |
| outsider | readable-install-memories | 8 / 8 | 14 / 14 |
| outsider | participant-system-folds | 16 / 16 | 28 / 28 |
| outsider | chat-carrier-apps | 17 / 17 | 17 / 17 |
| outsider | serve-chat-prompt | 19 / 19 | 19 / 19 |
| outsider | boot-serve-preview | 19 / 19 | 19 / 19 |
| userless | licence-helper | 3 / 3 | 7 / 7 |
| userless | text-helper | 4 / 4 | 8 / 8 |
| userless | installed-licence | 8 / 8 | 18 / 18 |
| userless | app-memory-candidates | 15 / 15 | 25 / 25 |
| userless | readable-install-memories | 0 / 0 | 0 / 0 |
| userless | participant-system-folds | 0 / 0 | 0 / 0 |
| userless | chat-carrier-apps | 15 / 15 | 15 / 15 |
| userless | serve-chat-prompt | 16 / 16 | 16 / 16 |
| userless | boot-serve-preview | 19 / 19 | 19 / 19 |
| public | licence-helper | 1 / 1 | 1 / 1 |
| public | text-helper | 1 / 1 | 1 / 1 |
| public | installed-licence | 6 / 6 | 12 / 12 |
| public | app-memory-candidates | 11 / 11 | 13 / 13 |
| public | readable-install-memories | 4 / 4 | 4 / 4 |
| public | participant-system-folds | 11 / 11 | 13 / 13 |
| public | chat-carrier-apps | 11 / 11 | 11 / 11 |
| public | serve-chat-prompt | 20 / 20 | 20 / 20 |
| public | boot-serve-preview | 17 / 17 | 17 / 17 |
| org-app | licence-helper | 0 / 0 | 0 / 0 |
| org-app | text-helper | 0 / 0 | 0 / 0 |
| org-app | installed-licence | 4 / 4 | 6 / 6 |
| org-app | app-memory-candidates | 9 / 9 | 9 / 9 |
| org-app | readable-install-memories | 3 / 3 | 3 / 3 |
| org-app | participant-system-folds | 9 / 9 | 9 / 9 |
| org-app | chat-carrier-apps | 9 / 9 | 9 / 9 |
| org-app | serve-chat-prompt | 19 / 19 | 19 / 19 |
| org-app | boot-serve-preview | 16 / 16 | 16 / 16 |

The same-context repeat counts match the first observations in this campaign; that is not a universal no-cache claim. Active licence helper 1→3 Agents gives3→7 statements; active text helper gives5→11. Compatible Agent findUnique calls batch: three-Agent licence calls have1 Agent-reading SQL plus3 membership and3 subscription statements; text calls have2 Agent-reading SQL plus6 membership and3 subscription statements. Organization joins overlap membership counts. Consequently neither raw3N nor5N is an observed general cost formula. Single-Agent chat serve27 includes qualification, current Agent/App reads, compiled-prompt resolution and other serving work; it is not all attributable to this one helper.

## Source-current inventory and scope gaps

All entries refer to product baseline cd0da474; line numbers are navigation, not SQL-count estimates.

| Location | Role / measured path |
|---|---|
| src/lib/auth/personalOrgAgentInstall.ts:21,37,49 | licence/text helper and nested call; directly measured |
| src/mcp/access-control.ts:162,663 | buildAppMemoryMap and installedSystemMemoryFolds; reached through getAppMemoryCandidates / participantSystemMemoryFolds |
| src/lib/auth/installMemory.ts:122,168 | point audience and readable list; list measured, point audience inventory only |
| src/lib/appAgent.ts:61,156 | active install licence loops; isAgentInstalledAndLicensed and chat carrier measured |
| src/api/graphql/schema/agentChatAccess.ts:53 | carrier admission, directly measured |
| src/api/graphql/schema/resolvers.mutation.chat.ts:154,246,618,1197 | serve helper directly measured; startChat known-install branch and public start/send transactions NOT executed |
| src/api/graphql/schema/resolvers.worker.ts:2595 | recorded/live worker text inventory only |
| src/lib/auth/sessionScopedMemoryIds.ts:103 | session scope inventory only |
| src/lib/bootPrompt/serve.ts:101 | shared serve licence through preview/chat |
| src/lib/workerCasting.ts:89 | cast/preview plan inventory only |

Not a complete cost census: no end-to-end MCP/HTTP, full chat lifecycle, worker/session/cast paths, transaction contention, item/derived/shared-target installations, many Apps, opposing async contexts or production cardinalities. Existing #3459 measures a DIFFERENT roster and cannot be subtracted from these counts as an optimization baseline. This campaign establishes an initial reproducible workload; any batching/memoization/tuning suggestion needs a separate issue/law/gate. No numeric ceilings approved here.

Validation: observer red checkpoint3bf8e0ced0 gives2failed/1passed; completed observer+campaign5/5. Silent-listener and counted-barrier faults each fail the exact SELECT1 discriminator (0/2 instead of1), byte-restored; full repeated217-row observations, table histograms and semantics matched exactly. Initial tsc found an implicit-any roster, fixed; follow-up tsc passed. Final provenance/userless-role adjustment remeasured all217 observations unchanged. No local full suite or stack; hostedCI is separate.

Path SQL totals remain entirely observational, including zero-query cases; only the separate SELECT1 instrumentation control asserts an exact statement count. The latest repeated roster matches all prior217counts and semantics after this assertion-only tightening.
