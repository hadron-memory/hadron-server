# #2277 remaining source writers: analysis and red-first attaches

Status: ANALYSIS + RED TESTS ONLY (tasks 01a166f962a2731a8a73ba6ab62bdb3b, 01a166f96535723293fe86497d6f72f9, 01a166f96832777da36c4d5b5d87c7e7). No production change. Each production delta needs its own CHECKED attach (Xylon #31455). Method and primitive as in comment-source-fence-2277.md: F first via #2273's shared option or `withIncludeHistoryTransaction`; fence only a SOURCE memory (class `system`), class re-checked under the lock; no competing helper or epoch code.

Red tests: `src/api/graphql/schema/resolvers.sourceWritersRed2277.test.ts` (3 RED, 1 scope control green). They fail today because the writer commits while F is held.

## Row 1: Channel-root writers (Vera #31252: Channel roots in a source memory ARE source writers)
Actual admission: Anne's diagnostic (createChannel then explicit source URN include) records the empty-body root in compile provenance.

| Writer | Root today | Source effect |
|---|---|---|
| createChannel / ensureChannelWithRoot (also ensureDefaultChannelForApp) | `db.$transaction` inside `ensureChannelWithRoot` (src/lib/channels.ts:377): `lockMemoryForChannelChange`, memory FOR SHARE, ancestor locks, then root + `:messages` node create/restore | new/restored root and `:messages` nodes (name, loc, liveness) |
| deleteChannel | `ctx.db.$transaction` in resolvers.channel.ts: `lockMemoryForChannelChange`, path lock, channel tombstone + root soft delete | root liveness |
| updateChannel | single `channel.update` (name/description of the Channel ROW only) | none: does not write the root Node |
| appendChatMessage / updateChatRootData | per-message `<loc>:messages` node create + root `data.messageCount` | message nodes in a source memory; high frequency; see decision 2 |

Proposed attach: `ensureChannelWithRoot` and `deleteChannel` open `withIncludeHistoryTransaction` (READ COMMITTED, as their bodies already use) when the host memory is class `system`; the class is read before and re-checked after `lockMemoryForChannelChange`/the memory FOR SHARE (mismatch refuses before any write and retries the attempt). Order below F is unchanged (memory channel lock, memory SHARE, ancestor locks). Both `db` parameters become the prepared client for the fenced branch.

Decisions for Xylon: (1) fence `ensureChannelWithRoot`'s other callers (default channel for an App, team chat) the same way, they pass through the same core; (2) chat message appends in a source memory: a Channel in a system memory is not a supported chat host in practice, so propose NOT fencing per-message appends but refusing a Channel in a system memory instead is a contract change and out of scope; recommend fencing appends only if Anne's census shows an admitted message node in compile provenance (her diagnostic covers the root only).

## Row 2: revisions:* creation (Xylon #31226: classify the actual writer)
Writer: `createRevision` (resolvers.mutation.session.ts:2067). Today: `db.node.upsert` of the `revisions` parent (outside any transaction, swallowed errors), then `db.$transaction` with `lockAncestorsForCreate` + `node.create` of `revisions:rev-N` carrying the whole snapshot in `data`. Admission: confirmed (Anne): the new node compiles via an explicit URN include, empty body, snapshot in data. Also called by restoreRevision's auto-save (line ~2205).

Proposed attach: wrap the parent upsert AND the create in one `withIncludeHistoryTransaction` (the Agent's system memory is always class `system`, so no class condition), F first, then `lockAncestorsForCreate`. This also removes the unfenced parent upsert as a separate writer. The snapshot READS (nodes/edges) move inside the same transaction so the snapshot and the insert are one state. READ COMMITTED matches the existing create transaction.

Risk to call out: the snapshot read of the entire system memory under the exclusive F lengthens the F hold for large memories; measure before the production delta.

## Row 3: old-Agent entitlement deletion on tombstone (needs Vera's fit first)
Writer: `createAgentCore` reclaim path (resolvers.mutation.agent.ts:~166) hard-deletes a tombstoned Agent by `agent.delete`, which cascades its AgentOrgGrant / subscription rows (actual counterparty effect, Anne d35a00ab: `counterparty-pending`). The system Memory, its source nodes and history are retained (Anne's diagnostic), so this is a GRANT writer like revoke, not a source-node writer.

Two candidate attaches, to be chosen on Vera's fit before any red test: (a) fence the reclaim delete (F first, `withIncludeHistoryTransaction`, the same shape as `deleteAgent`, which #2263 fences); (b) leave it unfenced and revalidate grants at the compile's deciding read. Fence (a) is the consistent choice with #2263's grant revokers; (b) needs the compile (#2258) to re-verify entitlement after F. Fresh allocation (a new Agent not yet includable) needs no fence (Anne's pin); promotion of an existing supplied Memory in the same function remains unclosed and is a separate decision.

No red test is written for this row until the fit decides the contract.
