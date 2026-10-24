# #2274 source/address and reclaim analysis packet (task 01a16b44b6d3734d9716e10078ff9102)

Status: ANALYSIS ONLY, static reading of `origin/main` @2bdefcd2. No production change, no test run, no red test written yet (the red-first acceptance below is a proposal for Xylon to CHECK). Nothing here is a CHECK, a Vera FIT or a combined-readiness stamp. Every claim is marked VERIFIED (read in code, file:line at that head) or UNPROVEN (needs a red test or a ruling).

Xylon's split (disposition 01a16b3bc4eb, issue comment 6377403277): ROW 1 = owner-handle, org and Memory URN/alias/trigger-entry rewrites; ROW 2 = raw target-namespace Agent/Memory tombstone/source-history cascades. Separate attaches.

## 1. What the compile actually depends on (the question that decides severity)

- VERIFIED: an include tag `{{>urn:...}}` stored in node content names a memory by URN text. Splice resolves it with `db.memory.findUnique({ where: { urn } })`, an EXACT match (`src/lib/includes/spliceIncludes.ts:49-56`, `expandTag` :171-175); write-time resolution is the same (`writeIncludes.ts:47,126`). Neither follows the alias map.
- VERIFIED: the alias map is a read-redirect for `resolve*Ref`, with "a live URN beats an alias" (`src/lib/urnAlias.ts` header rules). It is not consulted by include resolution.
- VERIFIED: none of the three rename helpers rewrites node content (`ownerUrnRename.ts` header "Node/Edge URNs are COMPOSED on read"; `propagateOrgUrnRename.ts` writes only urn_aliases/memories/agents/apps; `mergeOwnerNamespacedUrns.ts` header says content refs are deliberately not rewritten).
- Per #2274 body (Anne census): compiled occurrences store nodeId/revNo/hash/selection/position/parent-order, not the memory URN. Not re-verified by me here.

So the exposure is at TAG RESOLUTION (compile selection time and serve time), not in the stored occurrence rows.

## 2. Findings per writer (ROW 1)

All three run in an unfenced `db.$transaction`; none takes F (`pg_advisory_xact_lock(2063, 1772)`, `includeHistoryFence.ts:63-`), so none serializes against a compile or any F participant.

| Writer | Root today | Rewrites | Notes |
|---|---|---|---|
| `updateMyProfile` -> `renameOwnerNamespacedUrns` (`resolvers.mutation.org.ts:~129`, `ownerUrnRename.ts:53`) | `ctx.db.$transaction`, `users ... FOR UPDATE` | owner's Memory/Agent/App `urn` by `owner_user_id`; aliases; `entry_node_urn` of schedules/webhooks/poll bindings | also ROW 2 (below). Fresh authority is the user row lock only. |
| `updateOrganization` -> `propagateOrgUrnRename` (`resolvers.mutation.org.ts:~362-410`, `propagateOrgUrnRename.ts:31`) | `ctx.db.$transaction`, `organizations ... FOR UPDATE` | org's Memory/Agent/App `urn` by `organization_id`; aliases | does NOT rewrite `entry_node_urn` of triggers (not touched in the helper) - a possible dangling trigger target, UNPROVEN, outside compile. |
| `updateMemory` URN path (`resolvers.mutation.memory.ts:~1070-1215`) | `ctx.db.$transaction`, `memories ... FOR UPDATE`, re-reads ownership and class under the lock | `Memory.urn` and rename alias | the only one that already re-checks class/owner after its lock. |

Candidate additional URN writers NOT in the census (UNPROVEN whether they touch source memories; to be classified, not assumed away):
1. `mergeOwnerNamespacedUrns` (account merge re-root, `src/lib/mergeOwnerNamespacedUrns.ts`): same three tables plus `owner_user_id` moves; surgical tombstone reclaim. Probably inside #2263's account roots; I have not verified that.
2. `linkMemoryToUser` anon-to-user promotion (`resolvers.mutation.memory.ts:2329, 2379`): `UPDATE memories SET urn`. Anonymous memories are not class `system`; likely not a source memory, but the class gate has to be shown, not assumed.

### Effects on a qualified source (all UNPROVEN until a red test pins them)

E1. Served-text break by rename: after any of the three renames, every stored tag still spelling the old memory URN resolves to `BROKEN_INCLUDE_NOTICE` (exact-match lookup, no alias). Availability of provenance, not a leak.
E2. Retarget by reuse: the old URN is freed by the rename. If another memory can then be minted at the old URN (a live URN beats an alias), the same stored tag text resolves to a DIFFERENT memory. That is a wrong-provenance outcome, bounded by the reader's access filter and the `foreign` option, but it is the case that matters. Whether create paths allow minting a freed old URN (or reserve it through the alias map) is not verified; this is the first thing a red test must settle.
E3. Compile-time incoherence: a compile that resolves tag URNs memory by memory (READ COMMITTED, per-compile memo `memoryByUrn`) can see a rename commit between two URN lookups of the same entity; the first lookup returns id, the second a miss. Not serializable against an unfenced rename. F held by the compile would close this against writers that take F.
E4. Stable ids: compiled occurrences hold ids, so a rename after selection does not change an already selected node. That removes a class of harm but, per the issue ("do not infer safety from stable ids"), is not evidence for E1-E3.

## 3. ROW 2: target-namespace tombstone cascades

VERIFIED at `ownerUrnRename.ts` (reclaim block): on a handle change, BEFORE the rewrite, it hard-deletes every soft-deleted `agents` row and `memories` row whose `urn` starts with the NEW handle (`DELETE FROM agents ... / DELETE FROM memories WHERE deleted_at IS NOT NULL AND starts_with(urn, newColon)`). The `memories` delete cascades that memory's nodes and revisions (source and history). It is namespace-wide, not surgical (contrast: merge, which is per-URN). Guard today: `assertNoMintedCorpusCascade` for minted spec corpora only.
Not covered by #2273 reclaim (`createAgentCore`, #2277 row C) nor #2263 account roots (Xylon: separate row).
Effects (UNPROVEN until pinned): a compile that has selected node ids/revNos from a tombstoned memory in the target namespace can have them erased by cascade between selection and commit; whether an occurrence FK or the commit re-check catches that, or the compile commits dangling provenance, must be shown by a red test with F held.

## 4. Proposed attaches (for Xylon's CHECK; none authorized)

Common method (as comment-source-fence-2277): F first via `withIncludeHistoryTransaction`/#2273 `fence` option, ordering F then the existing row locks (user/org/memory FOR UPDATE), authority re-run after the F wait, one contract for every caller, no competing helper.

Open design choice for Xylon (flagged, not decided): a handle/org rename rewrites an unbounded SET of rows that includes system memories, so "decide class, re-check under lock" does not map to one memory. Option 1: fence whenever the owner/org owns any class `system` memory or Agent, decided under the row lock and re-read after F, retry then refuse. Option 2: always fence these three writers (rename is rare; the hold is a bulk UPDATE, not a source read). I lean Option 2 for a simple contract, but its cost and interaction with "fence only source memories" is Xylon's ruling.

- A (ROW 1, three roots): replace `ctx.db.$transaction` with the fenced outer root; F, then the existing `FOR UPDATE` row, re-read ownership/class, then the rewrite unchanged. updateMemory keeps its post-lock ownership refusal.
- B (ROW 2): the namespace-wide tombstone `DELETE` moves under F, and the cascade set (nodes, revisions, edges, assets? - cascade set of `memories` not enumerated by me yet) is counted and refused or reported before delete. Open: surgical per-URN reclaim like merge, rather than namespace-wide, would shrink the blast radius; a behavior change needing a ruling.
- C (E1/E2): fencing does NOT fix stale tag text or reuse. That needs a product/spec call (Vera FIT): either rename rewrites include tags, or include resolution follows the alias map, or freed URNs stay reserved. Without it, E1/E2 remain a blocker-class gap even with every writer fenced.

## 5. Bounded red-first acceptance (proposal)

1. E2 settle: after `updateMemory` rename, can a different memory be created at the old URN? If yes, a stored tag now resolves to it (red). If reserved, the case is closed and E2 is struck.
2. E1: rename a memory; splice of a stored old-URN tag returns BROKEN (characterization, green today).
3. E3: hold F as a compile; run each of the three renames; each must wait (red today: all complete).
4. Row 2: hold F; run `updateMyProfile` handle change onto a namespace holding a tombstoned memory with nodes; the cascade must wait (red today).
5. Atomicity: a rename that fails after the alias insert rolls back alias, urns and the user handle together (green characterization, guards against regression when moved into the fenced root).
6. Authority-after-wait for each root (demoted/changed owner while queued on F).

## 6. Limits and what I have not done

Static reading only; no run. Cascade set of `memories` hard delete not enumerated. `mergeOwnerNamespacedUrns` and `linkMemoryToUser` classification open. `propagateOrgUrnRename` trigger-target omission noted, not investigated. Vera FIT is needed for C and for the scoped row boundaries before any CHECK.
