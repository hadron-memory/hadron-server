# Input-triggered governance coordination (#1213 S2)

Scope: the bounded memory handshake for signal writers and owning copy/move operations. This implements Ada's input-triggered ruling (issue comment 6430918174), Dara's predicate (6430874506), the controlling re-gate (6431257002), and Vera's conformance confirmation (6431052577; `cor:acl:130:02`). The older unconditional same-memory-writer proposal is superseded. S3's search/replace governed-skip-before-OCC work remains separate; this change leaves #1213 open.

## Entry protocol

1. Preserve existing install/Agent authority acquisition as the prefix.
2. Resolve and acquire the **complete** governance plus inline-edge memory set using `lockMemoriesForChannelChange` (the existing `channel-host:` physical key).
3. Only then acquire loc/ancestor keys, memory-row fences and node locks, and perform authoritative checks and writes.

This refines the older “before any row” wording: authority rows in the mandatory install/Agent prefix precede the memory keys. Peter confirmed that order in team chat #127043; the order is pinned. A caller-owned transaction must declare the set at entry; `writeNodeCore` cannot repair ordering after the caller already took a loc/node lock.

S1 resolves hashes, deduplicates physical keys and acquires them in signed resolved-key order. S2 reuses that implementation rather than introducing a key namespace or another ordering algorithm. Hash collisions serialize extra work but cannot reverse the order. The bound concerns additional governance keys, not existing loc, row, rulebook or authority locks.

`mayChangeGovernance(mode, input, ownsKind)` evaluates **only declared input**, after canonical role normalization and kind-generated signals:

```ts
mode !== 'update' || ownsKind !== undefined ||
input.role !== undefined || input.isRunnable !== undefined
```

Null, false and whitespace clearing participate. No unlocked existing-row read influences participation. An ordinary content-only update without inline edges adds zero governance keys; its existing authoritative current/merged-state governed checks remain under its loc/node locks. An AST/Proxy completeness pin fails if `GovernedState` gains a field the predicate does not read.

## Writer inventory

| Writer / owning transaction | Complete set and ordering | Existing policy preserved |
| --- | --- | --- |
| GraphQL and MCP ordinary/kind doors through `writeNodeCore` | Input-triggered own memory unioned with existing inline-edge endpoint memories, before loc locks | Existing before/after governed gate, authoring, access, revision, encryption and OCC |
| Task-export property merge | Resolve complete own/inline set before transaction; authority, memory set, per-node advisory, fresh property merge, core reentry | Atomic bag merge and kind ownership |
| Question/log create and update (`resolvers.questions.ts`), including MCP Question tool delegates | Existing `lockLog`, `lockLogShared`, `lockQuestion` and create-log own-memory acquisition before log/question rows; core reentry | Existing question/log lifecycle and refusals |
| Spec reserve/allocate | Existing own-memory endpoint key before loc/row work; core reentry | Placeholder and spec authoring rules |
| Spec renumber | Shared GraphQL node-move entry declares source/destination set | Existing reservation/relocation rules |
| Git sync / mirror-derived signals | Existing complete endpoint memory set at sync transaction entry, before loc/node reconciliation | Existing mirror validation and role/runnable derivation |
| Boot-prompt compile | Existing output/source complete memory set before path/row locks | Existing compile ownership and immutable output policy |
| Revision restore | Authority prefix, node/source memory set, loc/reconcile/restore | Existing restore governed and authoring refusals |
| GraphQL mergeNodes | Authority prefix, all authorized source/target memories, loc set and rows | Generic governed-result refusal; no laundering stored signals |
| GraphQL node move | Authority prefix, source/destination memory set, complete loc set and subtree rows | Owning move carries signals and keeps existing refusals |
| MCP node move, including overwrite | Agent authority prefix, source/destination memory set, archive/loc set and subtree rows | Existing overwrite/archive and move policy |
| Single-node clone | One transaction holds authority prefix and source/destination set through fresh source reconciliation and destination core create | Generic clone still refuses governed results; source read access rechecked; effects after commit |
| Memory merge relocate/fold pages | Complete source/destination set before initial page snapshots and loc/row work; existing authoritative gate remains | Governed rows refuse; only the current page rolls back; earlier committed pages are outside rollback claims |
| Extract subtree copy/move | Source key at transaction entry before selecting stored signals; fresh destination is created inside this transaction and is invisible until commit | Existing governed carry, protected/question/comment refusals; moved source stays deleted |
| Standalone memory clone | Source key before selecting and copying graph; fresh destination is private until commit | Existing owning copy carries full stored signals |
| Agent clone | Existing source key after authority anchors and before base-graph/node rows; memory-clone reentry | Existing source stamp reconciliation and copy policy |
| `withInstallMemory`/import caller-owned core transactions | Authority prefix/materialization first; core is the first loc/node writer and acquires its set | Existing install and task-run rights |

The legacy filesystem controller `createNode` writes a fixed ordinary-field shape (no role/runnable payload, no revival); it cannot mint or clear governance on an existing node. Bag-only `updateNodePropertiesWith` likewise has no signal/inline-edge shape and does not acquire a new governance key. Raw administrative repairs, fixture/seed writes and erasure are not signal-authoring APIs and are outside this protocol's claims.

For caller-owned task-export and clone transactions, `coordinationMemories` records the predeclared set. If an inline endpoint moves to a memory outside that set before core preflight, core refuses `NODE_WRITE_CONFLICT` rather than appending a late key after outer locks. Existing endpoint revalidation still handles a move after core preflight. No access is widened by the set calculation.

## Evidence and limits

New tests exercise real PostgreSQL with explicit transaction latches, exact backend PID/database/key attribution (`classid`, `objid`, `objsubid=1`) and `pg_blocking_pids`. Polling only observes that lock wait; elapsed time is never the success condition. Every holder and contender is released and drained in `finally`.

Coverage includes both merge orders; extract promotion/demotion first and copy/move first; later moved-source refusal; same-memory ordinary-content and different-memory controls; explicit signal clearing, creates/revivals, kind content-only writes; caller-owned task export; clone/restore/merge/move entries; complete inline-edge union and late-set refusal. Additional direct order pins distinguish the initial stored-signal snapshot from a later fresh carry read.

The first red commit is `caf28546c`, based on main `08dd60a5f`. Its SQL observer was subsequently corrected to recognize S1's single-key string fast path as well as resolved numeric hashes; the corrected pins are rechecked against prior production before publication. Pure predicate/completeness tests and further barrier/order pins supplement that first commit.

No schema, SDL, migration, caps, pagination, permanent lock tuning or production load test is included. Same-memory participating transactions can queue for the whole bulk page/operation; ordinary content-only updates retain their existing concurrency. Clone now holds source reconciliation through destination creation in one transaction, so clone failures roll back that reconciliation as well as the destination. Existing local test timeouts are not a claim of production latency or throughput. The standalone copy destinations need no independently discoverable key before their creation because no other transaction can see them yet.
