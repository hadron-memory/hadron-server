# Installation roster diagnostics (#3459)

Observed on production source `6ea55eec762dd8014351cb6a958cf6c7df439f00`, synthetic owned run-private Postgres, dedicated Prisma6.19.2 client. No production observation, latency threshold, cache or optimization. The original 53 numeric ceilings were approved without slack in Xavier ruling 6696871831. The original observed JSON remains immutable baseline evidence; approved ceilings are stored separately in `installationCosts3459.approved.json`. The two additional distinct-Agent ceilings below were approved exactly in Xavier ruling 6697041514.

Reproduce with `HADRON_3459_ARTIFACT=/private/scratch/metrics.json HADRON_3459_HEAD=$(git rev-parse HEAD) node node_modules/vitest/vitest.mjs run src/api/graphql/schema/resolvers.installationCosts3459.test.ts`. The normal parallel test setup creates the checkout-specific run-owned worker DB. Before cleanup, the test requires parallel mode, the exact expected run-scope/PID/pool database name, the matching configured URL, and matching current_database() from BOTH fixture and measured clients; serial/base names refuse. The optional artifact contains synthetic SQL text and response data, no connection strings or real corpus. The logged client is disconnected in afterAll; run-owned DB cleanup remains the test harness's responsibility.

SQL counts are dedicated-client query events within the measured span, after setup, with a named later SQL log barrier excluded. Prisma operations are separate model-extension entries (raw barrier excluded); page reads are App.findMany/select.appAgents operations. Exported helper-entry spies are separately labeled; same-module direct calls may bypass them. One Prisma operation can emit multiple SQL statements. Projected rows count selected top-level Agent/install/import/role rows, not database fetched rows. GraphQL response bytes are UTF8 JSON singleResult including data envelope; API requests mean in-process GraphQL operations, not HTTP. Direct single-install/marker helpers have zero API requests and null response bytes. No DB-wire-byte claim.

A1 is one App; A3 extends the fixture to three Apps. Each has two physical and two distinct licensed derived Agents, including a duplicate import witness. A shared derived target is installed across all Apps. One foreign physical Agent is unreadable for the partial caller and causes whole-App audit masking. ImportedBy one-Agent-1/3-alias rows are one/three aliases of the same readable target, intentionally exposing repeated identical parent-field work; not three distinct targets. Role definition/marker cases use one/four installed Agents, at most two nodes each. Fresh Context and opposing principals plus inactive/revoked/expired holder-license requests assert semantic outputs; no Proposed audit rule is described as Decided law.

## Re-approval for #2089 (server PR #2099)

The withheld-audience guard of #2089 reads the App row once per distinct projected App per request (`loadApp`, request-scoped memoization, #831). It adds that statement to 40 of the 55 shapes: every A1 agents/audits/siblings row (+1 SQL, +1 Prisma operation), every A3 row of those families (+3, one per distinct App; siblings share it within the request), and the four grant rows (+1). The table below shows those values. All other columns, and the 15 other rows, are unchanged. Approved by the change manager (re-ruling https://github.com/hadron-memory/hadron-server/pull/2099#issuecomment-6724585264) at the observed values exactly, no headroom, after the all-55 re-measure was published (`hrn:node:hadronmemory.com:hadron-dev-team-bob:findings:2099-cost-remeasure-d8d51c29`). `installationCosts3459.approved.json` and `installationCosts3459.observed.json` are edited together because the test pins them equal.

## Observed table

| Shape | SQL | Prisma ops | Page ops | Helper entries (list/load/resolve) | GraphQL ops | Projected rows | Response bytes |
|---|---:|---:|---:|---|---:|---:|---:|
| A1/agents/partial/cold | 22 | 12 | 1 | [1, 0, 0] | 1 | 2 | 112 |
| A1/agents/partial/same-context-repeat | 22 | 12 | 1 | [1, 0, 0] | 1 | 2 | 112 |
| A1/agents/partial/fresh-context | 22 | 12 | 1 | [1, 0, 0] | 1 | 2 | 112 |
| A1/agents/full/cold | 17 | 7 | 1 | [1, 0, 0] | 1 | 4 | 196 |
| A1/agents/full/same-context-repeat | 17 | 7 | 1 | [1, 0, 0] | 1 | 4 | 196 |
| A1/agents/full/fresh-context | 17 | 7 | 1 | [1, 0, 0] | 1 | 4 | 196 |
| A1/audits/partial/cold | 26 | 16 | 1 | [1, 0, 0] | 1 | 4 | 525 |
| A1/audits/partial/same-context-repeat | 26 | 16 | 1 | [1, 0, 0] | 1 | 4 | 525 |
| A1/audits/partial/fresh-context | 26 | 16 | 1 | [1, 0, 0] | 1 | 4 | 525 |
| A1/audits/full/cold | 17 | 7 | 1 | [1, 0, 0] | 1 | 4 | 763 |
| A1/audits/full/same-context-repeat | 17 | 7 | 1 | [1, 0, 0] | 1 | 4 | 763 |
| A1/audits/full/fresh-context | 17 | 7 | 1 | [1, 0, 0] | 1 | 4 | 763 |
| A1/siblings/partial/cold | 40 | 24 | 2 | [2, 0, 0] | 1 | 6 | 620 |
| A1/siblings/partial/same-context-repeat | 40 | 24 | 2 | [2, 0, 0] | 1 | 6 | 620 |
| A1/siblings/partial/fresh-context | 40 | 24 | 2 | [2, 0, 0] | 1 | 6 | 620 |
| A1/siblings/full/cold | 27 | 11 | 2 | [2, 0, 0] | 1 | 8 | 942 |
| A1/siblings/full/same-context-repeat | 27 | 11 | 2 | [2, 0, 0] | 1 | 8 | 942 |
| A1/siblings/full/fresh-context | 27 | 11 | 2 | [2, 0, 0] | 1 | 8 | 942 |
| A1/reverse/partial | 61 | 34 | 5 | [5, 0, 0] | 1 | 1 | 224 |
| A1/reverse/full | 48 | 21 | 5 | [5, 0, 0] | 1 | 1 | 224 |
| A3/agents/partial/cold | 66 | 36 | 3 | [3, 0, 0] | 1 | 6 | 316 |
| A3/agents/partial/same-context-repeat | 66 | 36 | 3 | [3, 0, 0] | 1 | 6 | 316 |
| A3/agents/partial/fresh-context | 66 | 36 | 3 | [3, 0, 0] | 1 | 6 | 316 |
| A3/agents/full/cold | 51 | 21 | 3 | [3, 0, 0] | 1 | 12 | 568 |
| A3/agents/full/same-context-repeat | 51 | 21 | 3 | [3, 0, 0] | 1 | 12 | 568 |
| A3/agents/full/fresh-context | 51 | 21 | 3 | [3, 0, 0] | 1 | 12 | 568 |
| A3/audits/partial/cold | 78 | 48 | 3 | [3, 0, 0] | 1 | 12 | 1555 |
| A3/audits/partial/same-context-repeat | 78 | 48 | 3 | [3, 0, 0] | 1 | 12 | 1555 |
| A3/audits/partial/fresh-context | 78 | 48 | 3 | [3, 0, 0] | 1 | 12 | 1555 |
| A3/audits/full/cold | 51 | 21 | 3 | [3, 0, 0] | 1 | 12 | 2269 |
| A3/audits/full/same-context-repeat | 51 | 21 | 3 | [3, 0, 0] | 1 | 12 | 2269 |
| A3/audits/full/fresh-context | 51 | 21 | 3 | [3, 0, 0] | 1 | 12 | 2269 |
| A3/siblings/partial/cold | 120 | 72 | 6 | [6, 0, 0] | 1 | 18 | 1840 |
| A3/siblings/partial/same-context-repeat | 120 | 72 | 6 | [6, 0, 0] | 1 | 18 | 1840 |
| A3/siblings/partial/fresh-context | 120 | 72 | 6 | [6, 0, 0] | 1 | 18 | 1840 |
| A3/siblings/full/cold | 81 | 33 | 6 | [6, 0, 0] | 1 | 24 | 2806 |
| A3/siblings/full/same-context-repeat | 81 | 33 | 6 | [6, 0, 0] | 1 | 24 | 2806 |
| A3/siblings/full/fresh-context | 81 | 33 | 6 | [6, 0, 0] | 1 | 24 | 2806 |
| A3/reverse/partial | 147 | 84 | 13 | [13, 0, 0] | 1 | 3 | 604 |
| A3/reverse/full | 112 | 49 | 13 | [13, 0, 0] | 1 | 3 | 604 |
| importedBy/1-parents | 17 | 12 | 1 | [1, 0, 0] | 1 | 2 | 213 |
| importedBy/3-parents | 51 | 36 | 3 | [3, 0, 0] | 1 | 6 | 619 |
| role-definition/1-agents | 15 | 10 | 1 | [1, 0, 1] | 1 | 1 | 61 |
| role-marker/1-agents | 6 | 2 | 1 | [1, 0, 0] | 0 | 1 | None |
| role-definition/4-agents | 18 | 12 | 1 | [1, 0, 1] | 1 | 1 | 61 |
| role-marker/4-agents | 12 | 7 | 1 | [1, 0, 0] | 0 | 0 | None |
| single/ROW | 2 | 1 | 0 | [0, 0, 1] | 0 | 1 | None |
| single/DERIVED | 9 | 4 | 1 | [0, 0, 1] | 0 | 1 | None |
| single/absent | 6 | 2 | 1 | [0, 0, 1] | 0 | 0 | None |
| grant/active/partial | 26 | 16 | 1 | [1, 0, 0] | 1 | 4 | 525 |
| grant/inactive/fresh | 24 | 14 | 1 | [1, 0, 0] | 1 | 3 | 420 |
| grant/revoked/fresh | 24 | 14 | 1 | [1, 0, 0] | 1 | 3 | 420 |
| grant/expired/fresh | 24 | 14 | 1 | [1, 0, 0] | 1 | 3 | 420 |

## Interpretation and limits

Repeated same-Context and fresh-Context samples have the same measured counts/bytes for the selected shapes. A3 sibling full lists use six page operations for three Apps. Reverse audit projection uses 13 page operations at A3 (five at A1), consistent with repeated whole-App audit fallback decisions. These are observed duplicate operations, not a proven production regression. Any later request-context memo needs a separate scoped FIT/security schedule and must preserve every holder-license, whole-App audit, request/principal boundary. No optimization is implemented here.

Xavier approved the fixed-shape ceilings in rulings 6696871831 and 6697041514, with no slack or elapsed-time thresholds. Instrument disabled/reset-early controls fail the positive SQL discriminator; extra reads fail SQL ceilings, and extra RESPONSE projection fails GraphQL UTF8 byte ceilings. The 4KiB description control is selected into the response, not discarded database over-fetch; unserved DB-column bytes/overfetch are not measured by this diagnostic. Existing semantic suites remain authoritative for derived membership, licensing, audit/date and role-tier guards; the #3048 28-operation ticker budget is unchanged and is not this roster budget.

Reader census refreshed at this source: App.agents/App.appAgents; reverse Agent.appAgents audit fallbacks; Agent.importedBy; resolveAppInstallation ROW/DERIVED/absent; teamRoles explicit definition and locateTeamAgent marker walks. Attendee/register/pointer consumers delegate to single-install/page helpers, but this table is not a fresh execution of every attendee/pointer entry point. They remain pointer-only where so defined. Background/job consumers (App runs, channel backfill, shared-memory adoption) are outside this first request-reader slice. No paging/depth/cap/audience changes.

## Additional distinct-Agent baseline (approved ceilings: 6697041514)

The same four-Agent fixture supplies one or three distinct readable root Agents under the full principal. Root IDs are selected and asserted distinct; importedBy parent IDs and readable nested identities are asserted exactly. These are in-process GraphQL operations, not HTTP. Only this additional test ran; the original 53 observations were not repeated or overwritten.

| Shape | SQL | Prisma | Page | Helper entries | GraphQL | Rows | UTF8 bytes |
|---|---:|---:|---:|---|---:|---:|---:|
| importedBy/1-distinct-Agents/full | 5 | 5 | 0 | [0,0,0] | 1 | 2 | 290 |
| importedBy/3-distinct-Agents/full | 14 | 12 | 0 | [0,0,0] | 1 | 3 | 524 |

Zero exported helper entries retain the same-module spy limitation; they do not prove absence of underlying work. The original observed labels importedBy/1-parents and importedBy/3-parents map to importedBy/one-Agent-1-aliases and importedBy/one-Agent-3-aliases; their values remain unchanged.

## Approved-ceiling discriminators

Ruling 6696871831 approves the original 53 per-shape upper ceilings without slack; semantic projected-row counts and in-process operation counts remain exact, and null response bytes remain unmeasured. Expected ceilings are static checked-in data, never derived from the current run. Positive SQL/Prisma instrumentation checks remain mandatory.

Named controls: an additional page query raises A1/agents/partial/cold SQL from 21 to 27 and fails its 21 ceiling; a repeated whole-App audit lookup raises A1/reverse/partial SQL from 61 to 93 and fails its 61 ceiling; selecting extra 4096-byte Agent descriptions raises A1/agents/partial/cold response bytes from 112 to 8338 and fails its 112 ceiling. Each control was applied separately and restored. These are discrimination proofs, not production regressions or performance improvements.

## Fix-head integrity and interpretation

Run the complete file: afterAll requires exactly 55 measured and approved records, equal label sets and immutable observations mapped to approved records. A filtered run intentionally cannot claim complete coverage. GraphQL operations are counted inside the execution wrapper, not supplied as a literal. Failing observations are retained before assertions, and artifact/coverage errors still run server/client cleanup via finally. Nonzero page/helper baselines also require positive instrumentation.

Cold means a fresh Context, not a cold process. Alias/partial and distinct/full samples use different principals and are NOT a controlled repeated-vs-distinct cost comparison. Reverse samples here select a derived target; they do not prove physical-row reverse audit masking (covered by existing semantic suites). The four-Agent role marker sample intentionally exercises TEAM_AGENT_AMBIGUOUS, not a guaranteed complete role walk. Partial createdAt uses the App date even on masked Agent rows; each grant-state sample pins the remaining visible identities and masked audit/date values. Single-file mutable fixture sections assume normal sequential whole-file execution; automatic test retry and resume mid-file are not supported.

The immutable observation files preserve their historical approval-status strings. Production source is 6ea55eec; original measurements were retained/reproduced at d3c2be02, and the additional batch at 2d5e56f097. approved.json records both batch heads/rulings. Intentional future source changes require publishing changed metrics to the gate owner for explicit new ceilings; do not regenerate expected caps from a passing current run. The all-models hook excludes ALL raw queries, not just the named raw barrier; SQL events remain separately counted.
