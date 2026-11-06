# Installation roster diagnostics (#3459)

Observed on production source `6ea55eec762dd8014351cb6a958cf6c7df439f00`, synthetic owned run-private Postgres, dedicated Prisma6.19.2 client. No production observation, latency threshold, cache or optimization. The original 53 numeric ceilings were approved without slack in Xavier ruling 6696871831. The original observed JSON remains immutable baseline evidence; approved ceilings are stored separately in `installationCosts3459.approved.json`. The two additional distinct-Agent ceilings below were approved exactly in Xavier ruling 6697041514.

Reproduce with `HADRON_3459_ARTIFACT=/private/scratch/metrics.json HADRON_3459_HEAD=$(git rev-parse HEAD) node node_modules/vitest/vitest.mjs run src/api/graphql/schema/resolvers.installationCosts3459.test.ts`. The normal test setup creates the checkout-specific run-owned DB; the test refuses dev/base DB names. The optional artifact contains synthetic SQL text and response data, no connection strings or real corpus. The logged client is disconnected in afterAll; run-owned DB cleanup remains the test harness's responsibility.

SQL counts are dedicated-client query events within the measured span, after setup, with a named later SQL log barrier excluded. Prisma operations are separate model-extension entries (raw barrier excluded); page reads are App.findMany/select.appAgents operations. Exported helper-entry spies are separately labeled; same-module direct calls may bypass them. One Prisma operation can emit multiple SQL statements. Projected rows count selected top-level Agent/install/import/role rows, not database fetched rows. GraphQL response bytes are UTF8 JSON singleResult including data envelope; API requests mean in-process GraphQL operations, not HTTP. Direct single-install/marker helpers have zero API requests and null response bytes. No DB-wire-byte claim.

A1 is one App; A3 extends the fixture to three Apps. Each has two physical and two distinct licensed derived Agents, including a duplicate import witness. A shared derived target is installed across all Apps. One foreign physical Agent is unreadable for the partial caller and causes whole-App audit masking. ImportedBy one-Agent-1/3-alias rows are one/three aliases of the same readable target, intentionally exposing repeated identical parent-field work; not three distinct targets. Role definition/marker cases use one/four installed Agents, at most two nodes each. Fresh Context and opposing principals plus inactive/revoked/expired holder-license requests assert semantic outputs; no Proposed audit rule is described as Decided law.

## Observed table

| Shape | SQL | Prisma ops | Page ops | Helper entries (list/load/resolve) | GraphQL ops | Projected rows | Response bytes |
|---|---:|---:|---:|---|---:|---:|---:|
| A1/agents/partial/cold | 21 | 11 | 1 | [1, 0, 0] | 1 | 2 | 112 |
| A1/agents/partial/same-context-repeat | 21 | 11 | 1 | [1, 0, 0] | 1 | 2 | 112 |
| A1/agents/partial/fresh-context | 21 | 11 | 1 | [1, 0, 0] | 1 | 2 | 112 |
| A1/agents/full/cold | 16 | 6 | 1 | [1, 0, 0] | 1 | 4 | 196 |
| A1/agents/full/same-context-repeat | 16 | 6 | 1 | [1, 0, 0] | 1 | 4 | 196 |
| A1/agents/full/fresh-context | 16 | 6 | 1 | [1, 0, 0] | 1 | 4 | 196 |
| A1/audits/partial/cold | 25 | 15 | 1 | [1, 0, 0] | 1 | 4 | 525 |
| A1/audits/partial/same-context-repeat | 25 | 15 | 1 | [1, 0, 0] | 1 | 4 | 525 |
| A1/audits/partial/fresh-context | 25 | 15 | 1 | [1, 0, 0] | 1 | 4 | 525 |
| A1/audits/full/cold | 16 | 6 | 1 | [1, 0, 0] | 1 | 4 | 763 |
| A1/audits/full/same-context-repeat | 16 | 6 | 1 | [1, 0, 0] | 1 | 4 | 763 |
| A1/audits/full/fresh-context | 16 | 6 | 1 | [1, 0, 0] | 1 | 4 | 763 |
| A1/siblings/partial/cold | 39 | 23 | 2 | [2, 0, 0] | 1 | 6 | 620 |
| A1/siblings/partial/same-context-repeat | 39 | 23 | 2 | [2, 0, 0] | 1 | 6 | 620 |
| A1/siblings/partial/fresh-context | 39 | 23 | 2 | [2, 0, 0] | 1 | 6 | 620 |
| A1/siblings/full/cold | 26 | 10 | 2 | [2, 0, 0] | 1 | 8 | 942 |
| A1/siblings/full/same-context-repeat | 26 | 10 | 2 | [2, 0, 0] | 1 | 8 | 942 |
| A1/siblings/full/fresh-context | 26 | 10 | 2 | [2, 0, 0] | 1 | 8 | 942 |
| A1/reverse/partial | 61 | 34 | 5 | [5, 0, 0] | 1 | 1 | 224 |
| A1/reverse/full | 48 | 21 | 5 | [5, 0, 0] | 1 | 1 | 224 |
| A3/agents/partial/cold | 63 | 33 | 3 | [3, 0, 0] | 1 | 6 | 316 |
| A3/agents/partial/same-context-repeat | 63 | 33 | 3 | [3, 0, 0] | 1 | 6 | 316 |
| A3/agents/partial/fresh-context | 63 | 33 | 3 | [3, 0, 0] | 1 | 6 | 316 |
| A3/agents/full/cold | 48 | 18 | 3 | [3, 0, 0] | 1 | 12 | 568 |
| A3/agents/full/same-context-repeat | 48 | 18 | 3 | [3, 0, 0] | 1 | 12 | 568 |
| A3/agents/full/fresh-context | 48 | 18 | 3 | [3, 0, 0] | 1 | 12 | 568 |
| A3/audits/partial/cold | 75 | 45 | 3 | [3, 0, 0] | 1 | 12 | 1555 |
| A3/audits/partial/same-context-repeat | 75 | 45 | 3 | [3, 0, 0] | 1 | 12 | 1555 |
| A3/audits/partial/fresh-context | 75 | 45 | 3 | [3, 0, 0] | 1 | 12 | 1555 |
| A3/audits/full/cold | 48 | 18 | 3 | [3, 0, 0] | 1 | 12 | 2269 |
| A3/audits/full/same-context-repeat | 48 | 18 | 3 | [3, 0, 0] | 1 | 12 | 2269 |
| A3/audits/full/fresh-context | 48 | 18 | 3 | [3, 0, 0] | 1 | 12 | 2269 |
| A3/siblings/partial/cold | 117 | 69 | 6 | [6, 0, 0] | 1 | 18 | 1840 |
| A3/siblings/partial/same-context-repeat | 117 | 69 | 6 | [6, 0, 0] | 1 | 18 | 1840 |
| A3/siblings/partial/fresh-context | 117 | 69 | 6 | [6, 0, 0] | 1 | 18 | 1840 |
| A3/siblings/full/cold | 78 | 30 | 6 | [6, 0, 0] | 1 | 24 | 2806 |
| A3/siblings/full/same-context-repeat | 78 | 30 | 6 | [6, 0, 0] | 1 | 24 | 2806 |
| A3/siblings/full/fresh-context | 78 | 30 | 6 | [6, 0, 0] | 1 | 24 | 2806 |
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
| grant/active/partial | 25 | 15 | 1 | [1, 0, 0] | 1 | 4 | 525 |
| grant/inactive/fresh | 23 | 13 | 1 | [1, 0, 0] | 1 | 3 | 420 |
| grant/revoked/fresh | 23 | 13 | 1 | [1, 0, 0] | 1 | 3 | 420 |
| grant/expired/fresh | 23 | 13 | 1 | [1, 0, 0] | 1 | 3 | 420 |

## Interpretation and limits

Repeated same-Context and fresh-Context samples have the same measured counts/bytes for the selected shapes. A3 sibling full lists use six page operations for three Apps. Reverse audit projection uses 13 page operations at A3 (five at A1), consistent with repeated whole-App audit fallback decisions. These are observed duplicate operations, not a proven production regression. Any later request-context memo needs a separate scoped FIT/security schedule and must preserve every holder-license, whole-App audit, request/principal boundary. No optimization is implemented here.

Xavier must approve numeric regression budgets after this baseline. Candidate policy is to pin these fixed-shape SQL/operation/page/row/byte values, without elapsed-time thresholds, then show +1 page/audit read and unused-text projection mutants fail. Instrument disabled/reset-early controls already fail the positive SQL discriminator. Existing semantic suites remain authoritative for derived membership, licensing, audit/date and role-tier guards; the #3048 28-operation ticker budget is unchanged and is not this roster budget.

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

Named controls: an additional page query raises A1/agents/partial/cold SQL from 21 to 27 and fails its 21 ceiling; a repeated whole-App audit lookup raises A1/reverse/partial SQL from 61 to 93 and fails its 61 ceiling; selecting unused 4096-byte Agent descriptions raises A1/agents/partial/cold response bytes from 112 to 8338 and fails its 112 ceiling. Each control was applied separately and restored. These are discrimination proofs, not production regressions or performance improvements.
