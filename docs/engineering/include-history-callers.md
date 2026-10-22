# Include-history caller migration (#2063)

This is a staged migration inventory, not proof that every writer is fenced.
Cut 1 migrates the canonical read reconciliation transactions below. Remaining
writer paths keep their existing behavior and are NOT claimed to serialize with
these reads yet. No include-retention/coverage/maintenance state is activated.

| Migrated outer entry | Nested operation | Budget (transaction / pool) |
| --- | --- | --- |
| GraphQL `node(ref:)` finish | prepared reconcile and same-tx row refetch | 5s / 2s |
| GraphQL `nodeBatch` per-node read | prepared reconcile, existing final access-filtered refetch | 60s / 15s |
| GraphQL `reconciledNodeForParent` | row check, prepared reconcile, matching projection | 5s / 2s |
| MCP `loadCurrentReadProjection` | prepared reconcile and same-tx row refetch; shared single/batch | 5s / 2s |

All four share `withReconciledNodeRead`. An unchanged row is checked and
projected in one **read-only REPEATABLE READ** snapshot, without advisory or row
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

## Remaining participants

Standalone skill-plan and spec-corpus reconciliation; canonical node writers
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
anchor. Skill-plan currently uses REPEATABLE READ for a properties-size bound;
its later cut must preserve that coherent limit with an explicit row-lock or
revalidation design under the fence's READ COMMITTED contract.

The four inherited nonblocking foundation P3s remain: late callback lock waits
retain full lock_timeout; the maximum PostgreSQL timeout cap is not validated;
callback expiry starts after Prisma starts its deadline; detached ALS stores
can outlive the transaction. Callers do no external work under this fence.

## Snapshot/reconciliation API census at base e6d7b1e4 + cut 1

This records source call sites (including internal bridge calls), not a claim
of independently reviewed complete migration. The accompanying static pin
requires every API use to remain classified when later code adds or moves one.
The four migrated sites now call `withReconciledNodeRead` (two query sites,
one parent, one MCP); its single slow-path call to
`reconcileNodeWithIncludeHistory` is also counted. The historical listing below
records the remaining base sites; the JSON census is the current exact map.

```text
src/api/graphql/schema/resolvers.decisions.ts:350:  await ensureCurrentNodeRevisionInTransaction(tx, logId, { expectedMemoryId: memoryId });
src/api/graphql/schema/resolvers.decisions.ts:391:  await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: memoryId });
src/api/graphql/schema/resolvers.mutation.memory.ts:2577:              const revision = await ensureCurrentNodeRevisionInTransaction(tx, node.id, {
src/api/graphql/schema/resolvers.mutation.node.ts:1179:              await ensureCurrentNodeRevisionInTransaction(tx, current.id, { expectedMemoryId: input.memoryId });
src/api/graphql/schema/resolvers.mutation.node.ts:1275:              await createNodeRevision(tx, {
src/api/graphql/schema/resolvers.mutation.node.ts:1479:              await ensureCurrentNodeRevisionInTransaction(tx, authoritative.id, { expectedMemoryId: input.memoryId });
src/api/graphql/schema/resolvers.mutation.node.ts:1497:              await createNodeRevision(tx, {
src/api/graphql/schema/resolvers.mutation.node.ts:2826:          await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: planMemory.get(id)! });
src/api/graphql/schema/resolvers.mutation.node.ts:2843:          await createNodeRevision(
src/api/graphql/schema/resolvers.mutation.node.ts:3650:        if ((await ensureCurrentNodeRevisionInTransaction(tx, selectedSource.id, {
src/api/graphql/schema/resolvers.mutation.node.ts:4026:          await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: endpointMemory.get(id)! });
src/api/graphql/schema/resolvers.mutation.node.ts:4057:        await createNodeRevision(
src/api/graphql/schema/resolvers.mutation.node.ts:4435:        await ensureCurrentNodeRevisionInTransaction(tx, node.id, { expectedMemoryId: node.memoryId });
src/api/graphql/schema/resolvers.mutation.node.ts:4551:          await createNodeRevision(tx, {
src/api/graphql/schema/resolvers.mutation.session.ts:2243:              await ensureCurrentNodeRevisionInTransaction(tx, prior.id, { expectedMemoryId: sysMemId });
src/api/graphql/schema/resolvers.mutation.session.ts:2260:                await createNodeRevision(
src/api/graphql/schema/resolvers.query.skill.ts:772:            if ((await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: candidateMemory.get(id)! })) == null) return null;
src/api/graphql/schema/resolvers.searchReplaceSpec.ts:378:      await createNodeRevision(tx, buildNodeRevisionSnapshot(node.raw, editorFromAuth(ctx), {
src/api/graphql/schema/resolvers.specCorpus.ts:1070:      ensureCurrentNodeRevisionInTransaction(tx, node!.id, { expectedMemoryId: corpus.id }),
src/controller/operations/cloneMemory.ts:208:        const rev = await ensureCurrentNodeRevisionInTransaction(tx, n.id, { expectedMemoryId: source.id });
src/controller/operations/createNode.ts:73:    if (prior) await ensureCurrentNodeRevisionInTransaction(tx, prior.id, { expectedMemoryId: node.memoryId });
src/controller/operations/createNode.ts:89:        await createNodeRevision(
src/controller/operations/extractParentNode.ts:244:        const rev = await ensureCurrentNodeRevisionInTransaction(tx, n.id, { expectedMemoryId: args.sourceMemoryId });
src/controller/operations/mergeMemories.ts:588:            await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: sourceMemoryId });
src/controller/operations/mergeMemories.ts:609:            await createNodeRevision(
src/controller/operations/mergeMemories.ts:730:        const reconciled = await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: foldMemory.get(id)! });
src/controller/operations/mergeMemories.ts:775:        await createNodeRevision(
src/integrations/github/syncGraphFromGithub.ts:225:    await ensureCurrentNodeRevisionInTransaction(tx, current.id, { expectedMemoryId });
src/integrations/github/syncGraphFromGithub.ts:270:    await createNodeRevision(
src/integrations/github/syncGraphFromGithub.ts:1139:              await ensureCurrentNodeRevisionInTransaction(tx, occupant.id, { expectedMemoryId: graph.id });
src/lib/nodeApproval.ts:166:  const revision = await ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: opts.memoryId });
src/lib/nodeRevisionSnapshot.ts:216:  return ensureCurrentNodeRevisionInTransaction(includeHistoryClient(history), nodeId, opts);
src/lib/nodeRevisionSnapshot.ts:225:export async function ensureCurrentNodeRevisionInTransaction(
src/lib/nodeRevisionSnapshot.ts:257:  await createNodeRevision(
src/lib/nodeRevisionSnapshot.ts:350:export async function createNodeRevision(
src/lib/nodeSubtreeMove.ts:364:    await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: srcMemoryId });
src/lib/nodeSubtreeMove.ts:633:    await createNodeRevision(
src/lib/signing/requests.ts:103:  const revision = await ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: opts.memoryId });
src/mcp/server.ts:4046:            await ensureCurrentNodeRevisionInTransaction(tx, prior.id, { expectedMemoryId: memoryId });
src/mcp/server.ts:4068:            await createNodeRevision(tx, {
src/mcp/server.ts:6212:        await ensureCurrentNodeRevisionInTransaction(tx, pre.id, { expectedMemoryId: memoryId });
src/mcp/server.ts:6214:        await createNodeRevision(tx, {
src/mcp/server.ts:6736:            await ensureCurrentNodeRevisionInTransaction(tx, existing.id, { expectedMemoryId: memory.id });
src/mcp/server.ts:6773:            await createNodeRevision(tx, {
src/mcp/server.ts:7905:              await ensureCurrentNodeRevisionInTransaction(tx, existing.id, { expectedMemoryId: fromMemory.id });
src/mcp/server.ts:7910:              await createNodeRevision(tx, {
```
