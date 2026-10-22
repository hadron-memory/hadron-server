# Include-history caller migration (#2063)

This is a staged migration inventory, not proof that every writer is fenced.
Cut 1 migrates the canonical read reconciliation transactions below;
dependent cut 2 adds the two standalone reconciliation entries. Remaining
writer paths keep their existing behavior and are NOT claimed to serialize with
these reads yet. No include-retention/coverage/maintenance state is activated.

| Migrated outer entry | Nested operation | Budget (transaction / pool) |
| --- | --- | --- |
| GraphQL `node(ref:)` finish | prepared reconcile and same-tx row refetch | 5s / 2s |
| GraphQL `nodeBatch` per-node read | prepared reconcile, existing final access-filtered refetch | 60s / 15s |
| GraphQL `reconciledNodeForParent` | row check, prepared reconcile, matching projection | 5s / 2s |
| MCP `loadCurrentReadProjection` | prepared reconcile and same-tx row refetch; shared single/batch | 5s / 2s |
| Skill / selected-skill per-node plan transaction (dependent cut 2) | unchanged read-only RR sizing/projection; drift-only fence, fresh authority and selected row lock; prepared reconcile | 60s / 15s |
| Spec renumber standalone prereconcile (dependent cut 2) | fresh write gate; prepared reconcile before later independent CAS rewrite | 5s / 2s |

The first four canonical entries share `withReconciledNodeRead`. Their unchanged
rows are checked and projected in one **read-only REPEATABLE READ** snapshot, without advisory or row
locks. The fingerprint and projection cannot straddle a concurrent raw writer.
Missing/moved/deleted rows refuse without entering a mutation transaction.
The fast GraphQL/MCP authority adapter verifies READ ONLY / REPEATABLE READ at
runtime, then reads live actor/key/sign-in state without credential row locks.
MCP shares the same actor/key/root checks, concealing only typed authority
refusals and preserving DB/transaction faults as errors.
The write/drift authority adapter retains its credential SHARE locks; those
locks are forbidden in a read-only transaction and must not leak into this path.

Drift (including a missing fingerprint) closes the read-only transaction before
opening the exclusive first-statement fence at READ COMMITTED, before node
locks. Authority is re-read after the fence wait on the same transaction client,
including current user roles and the child memory used for inherited reads.
Revision state is rechecked under the fence; another reader may already have
reconciled it. Parent-version checks precede reconciliation, with the existing
Node row lock on this slow path only. Existing memory/address/liveness gates
and final projection logic stay in place. The prepared entry rejects
forged/raw/escaped contexts; legacy snapshot entry points are not its fallback.
The batch's final access-filtered refetch remains outside its per-row transaction;
this does not provide a whole-batch snapshot.

The budgets above apply per transaction, not to both phases combined. Drift
readers still serialize globally and can hold the fence during a Node row-lock
wait; unchanged readers no longer queue behind them. This is not a production
throughput guarantee or a reduction of the T3/§10 caller-integration scope.

Skill / selected-skill final reads use the same two-phase policy: unchanged
fingerprints, credential/authority reads, selected JSON sizing, metadata-only
SKIP and content projection share one read-only RR snapshot with no row or
advisory locks. Only drift closes that snapshot and takes the outer fence,
then refreshes credential/authority and expected-memory checks at RC. Selected
drift rows are locked before JSON sizing and projection. Spec prereconciliation
still always takes the fence; it is not an unchanged read fast path.

## Remaining participants

Standalone skill-plan and spec-corpus reconciliation are migrated in dependent cut 2.
The surrounding spec move and rewrite writers remain outstanding. Canonical node writers
and bulk/import/edge writers; controller create/clone/extract/merge; Git sync
and retry; subtree move/restore/purge/history deletion; approval and signature
qualification changes; worker/session writes and remaining MCP writers.
These require their actual outer authority/path/row-lock maps, including
indirect callers. The API census below is a starting point: it does not cover
all raw SQL, alias/address writers, qualification-only mutations, or hooks.
The final integration gate must include those paths and reject every
unprepared prune-capable production entry before mutation. No silent skip,
base-client fallback, or stub caller may satisfy that gate.

`withAuthorizedTx` has SERIALIZABLE consumers and established authority-anchor
ordering; it must not be globally swapped or nested behind an already-held
anchor. Skill-plan keeps its read-only candidate REPEATABLE READ scan. Its final
unchanged transaction also uses read-only RR. Its drift transaction uses READ
COMMITTED plus a selected Node row lock before measuring or fetching properties,
preserving that coherent size limit without freezing a snapshot before the
outer fence.

The four inherited nonblocking foundation P3s remain: late callback lock waits
retain full lock_timeout; the maximum PostgreSQL timeout cap is not validated;
callback expiry starts after Prisma starts its deadline; detached ALS stores
can outlive the transaction. Callers do no external work under this fence.

## Snapshot/reconciliation API census through dependent cut 2

This records source call sites (including internal bridge calls), not a claim
of independently reviewed complete migration. The accompanying static pin
requires every API use to remain classified when later code adds or moves one.
The four migrated sites now call `withReconciledNodeRead` (two query sites,
one parent, one MCP); its single slow-path call to
`reconcileNodeWithIncludeHistory` is also counted. The historical listing below
records the remaining base sites; the JSON census is the current exact map.

```text
src/api/graphql/schema/resolvers.decisions.ts :: ensureCurrentNodeRevisionInTransaction (2 call sites)
src/api/graphql/schema/resolvers.mutation.memory.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/api/graphql/schema/resolvers.mutation.node.ts :: createNodeRevision (5 call sites)
src/api/graphql/schema/resolvers.mutation.node.ts :: ctx.db.nodeRevision.delete (1 call sites)
src/api/graphql/schema/resolvers.mutation.node.ts :: ctx.db.nodeRevision.deleteMany (1 call sites)
src/api/graphql/schema/resolvers.mutation.node.ts :: ensureCurrentNodeRevisionInTransaction (6 call sites)
src/api/graphql/schema/resolvers.mutation.node.ts :: tx.nodeRevision.deleteMany (1 call sites)
src/api/graphql/schema/resolvers.mutation.session.ts :: createNodeRevision (1 call sites)
src/api/graphql/schema/resolvers.mutation.session.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/api/graphql/schema/resolvers.query.node.ts :: withReconciledNodeRead (2 call sites)
src/api/graphql/schema/resolvers.query.skill.ts :: reconcileNodeWithIncludeHistory (1 call sites)
src/api/graphql/schema/resolvers.searchReplaceSpec.ts :: createNodeRevision (1 call sites)
src/api/graphql/schema/resolvers.specCorpus.ts :: reconcileNodeWithIncludeHistory (1 call sites)
src/api/graphql/schema/resolvers.types.ts :: withReconciledNodeRead (1 call sites)
src/controller/operations/cloneMemory.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/controller/operations/createNode.ts :: createNodeRevision (1 call sites)
src/controller/operations/createNode.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/controller/operations/extractParentNode.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/controller/operations/mergeMemories.ts :: createNodeRevision (2 call sites)
src/controller/operations/mergeMemories.ts :: ensureCurrentNodeRevisionInTransaction (2 call sites)
src/integrations/github/syncGraphFromGithub.ts :: createNodeRevision (1 call sites)
src/integrations/github/syncGraphFromGithub.ts :: ensureCurrentNodeRevisionInTransaction (2 call sites)
src/lib/includes/reconciledNodeRead.ts :: reconcileNodeWithIncludeHistory (1 call sites)
src/lib/nodeApproval.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/lib/nodeRevisionSnapshot.ts :: createNodeRevision (1 call sites)
src/lib/nodeRevisionSnapshot.ts :: db.nodeRevision.deleteMany (1 call sites)
src/lib/nodeRevisionSnapshot.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/lib/nodeSubtreeMove.ts :: createNodeRevision (1 call sites)
src/lib/nodeSubtreeMove.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/lib/signing/requests.ts :: ensureCurrentNodeRevisionInTransaction (1 call sites)
src/mcp/server.ts :: createNodeRevision (4 call sites)
src/mcp/server.ts :: ensureCurrentNodeRevisionInTransaction (4 call sites)
src/mcp/server.ts :: withReconciledNodeRead (1 call sites)
```
