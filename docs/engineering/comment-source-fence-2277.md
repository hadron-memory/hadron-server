# #2277: comment writers and source-memory restoreNode under the include-history fence (analysis, red-first)

Status: ANALYSIS + RED TESTS ONLY. No production change. Checked by Xylon before any implementation (task 01a1666ff79c7b19a8133e3638dd1f5d). Separate main-based cut; no edits to #2263 / #2258 / #2273.

## Scope (Xylon #31226, Vera FIT #31196)
Fence comment create / reply / edit / delete / thread-delete and `restoreNode` in a SOURCE memory (Agent system memory or install memory, cor:dmo:040:08). Do not exclude comment nodeType. Channel/chat, revisions:* classification, the createAgent pin and #2274 rename writers are out of scope here.

## Writer inventory (main c8da96c1)
All comment writers reach one of three authorized-memory transactions in `resolvers.comments.ts`:

| Writer | Transaction root | Effect on a source node |
|---|---|---|
| createComment, replyToComment, editComment, resolve/reopen, deleteCommentThread | `commentTx` -> `withAuthorizedMemoryTx` (changeComment for edit/resolve/reopen) | new comment Node; body/quote overwrite + `revSeq` bump + fingerprint refresh (`reviseComment`); thread state only for resolve/reopen |
| deleteComment (author or manager) | `deleteCommentReadable` -> `withAuthorizedMemoryTx` | stub overwrite (revSeq bump) or soft delete (liveness) |
| deleteComment (author, no access) | `deleteOwnCommentWithoutAccess` -> `withAuthorizedMemoryTx` | same as above |
| restoreNode | explicit `ctx.db.$transaction` (READ COMMITTED) in `resolvers.recovery.ts` | clears `deletedAt` (liveness); restores TARGET-deleted comment threads |

Target deletion / revival cascading into comment threads happens inside the node writers (`writeNodeCore` family, `softDeleteThreadsOfTargets` / `restoreThreadsOfTargets`) and is owned by the generic node-writer migration (#2273 census), not this cut.

## Proposed attach (F-first, epoch)
1. F is `withIncludeHistoryTransaction` (exclusive advisory, FIRST statement, READ COMMITTED, no isolation override). Where #2263 is present it also advances the epoch once per committed holder; no separate epoch code is written here.
2. Comment roots: add the same opt-in `fence` option to `withAuthorizedMemoryTx` / `withAuthorizedTx` that #2273 and #2263 already introduce (`authorizedTx.ts`). To avoid a three-way conflict this cut TAKES THAT OPTION VERBATIM (decision needed: land after #2273's primitive, or carry the identical hunk and drop it on rebase).
3. restoreNode: replace `ctx.db.$transaction(..., ReadCommitted)` by `withIncludeHistoryTransaction` + `includeHistoryClient`. The isolation level already matches; `lockInstallAuthorityFirst` is the first statement of the old body and becomes the first after F.
4. Lock order is unchanged below F: install authority / anchors (org, user, app, memory SHARE), Channel/path locks, then thread root FOR UPDATE before the addressed comment (`lockInThread`), then removal rows. F precedes all of them, the compile's order.

## Conditional fence (scope decision for Xylon)
Fence only when the memory is a source: `class = 'system'` (agent system memory, or install memory, which is also class system). Comments in knowledge/app/group/personal memories are not boot-prompt sources; an unconditional exclusive database-wide advisory lock per comment would serialize every comment write in the platform. The class is decided before the transaction (cheap read) and RE-CHECKED under the memory lock; a changed class refuses with a retryable conflict. The control tests pin that a knowledge-memory comment edit and restoreNode do NOT queue on F (green before and after).

## Open decisions
- resolve/reopen change only `comment_meta` (no text, no revSeq, no liveness). They share `changeComment`'s root, so fencing them is free uniformity; excluding them needs a second code path. Recommendation: fence uniformly.
- Source predicate: `class = 'system'` vs the compile's exact source set (system memory of a live Agent + install memory). A class-system memory that no Agent references is fenced needlessly (harmless).
- Primitive dependency (item 2 above).

## Red tests
`src/api/graphql/schema/resolvers.commentSourceFence2277.test.ts`: for each writer above, real resolver, F held in an outer transaction, the writer must queue on the advisory lock. Red on main (the writer commits while F is held: Anne's witness); green with the change: every writer (including reopen and the no-current-read author delete), a reverse-order holder, the locked class-drift retry, and 2 non-source controls that must NOT queue.
