# S9-3 qualification integration census (#2063)

Working census, not a freeze, activation, retention or complete-coverage claim.
Task `01a162c0c99d712e86ee947880f7d99f` covers every approval door (including
#2235), signing qualification and pruning. The full participant gate remains
T3 + §10/L (6258713506, 6328649240, 6329058749). Existing #2263 and #2258
remain held; composing them for development does not approve either.

## Integrated source baseline

- Current main `00c20188` includes #2235 approval placement and #2129 unchanged
  skill/selected-skill fast paths (including rooted-credential pins).
- S9-3 authority/account foundation `417253fd` (#2263) merged locally onto main:
  `76a736fa`. The only textual conflict combined the current tier import with
  account/history fence imports in `resolvers.worker.ts`; neither side dropped.
- S9-4 compile `c65e694a` (#2258) is composed locally for actual counterparty
  tests. No new route or production exposure is authorized by this evidence tree.
- Per Marco #30936, delivery is a separate main-based PR. The combined tree
  `8adcb137` is retained as evidence-only, never a merge target. No edits to
  #2263 or #2258; neither draft is a delivery branch dependency.

The epoch/old-binary compatibility and default-off availability proposal in
#2263 is not solved by qualification integration. It remains explicitly open.

## Outer boundaries and existing inner order

`F` below is the exclusive prepared history fence, first statement, with the
foundation epoch advance immediately afterward in the combined #2263 tree
(main's current foundation has no epoch row yet). Every migration must place F
before existing authority/row/address locks, refresh authority after waits,
retain one transaction client, and preserve rollback. A shared generic wrapper
must not silently change SERIALIZABLE consumers to RC or nest a pooled tx.

| Boundary | Current deciding transaction / inner order | Qualification/prune effect | Disposition |
| --- | --- | --- | --- |
| GraphQL approveNode; MCP approval delegates | withAuthorizedMemoryTx: ordered authority anchors/owner rows, fresh gate, Node/reconcile | live approval, possible cap prune during reconciliation; #2235 locked boot-family gate | needs F before anchors; keep placement/manager/refusal behavior |
| GraphQL approveMemoryNodes; MCP bulk delegates | same authority wrapper, Node ids sorted, per-row reconciliation/approval | bulk approvals, possible prune; #2235 skip/report | needs F before anchors; preserve 120s budget and bulk skips |
| linkMemoryToUser encrypted promotion | explicit tx, Memory FOR UPDATE, Node transforms, encryption flip, approval hash end | changes plaintext availability and ends live/historical approvals | needs F before Memory lock; recheck scope under lock |
| encryptMemory initial flip | explicit tx, Memory FOR UPDATE, current strict-owner/class gate, flip, approval hash end | approval/signature applicability changes | needs F before Memory lock |
| encryptMemory live-row conversion | per-row tx, Memory SHARE, Node UPDATE/reconcile, snapshot conversion | may reconcile/cap-prune; plaintext becomes ciphertext | needs F before Memory/Node locks; no whole-corpus lock |
| encryptMemory snapshot conversion | per-row tx, Memory SHARE, Node UPDATE, Revision UPDATE | changes historical bytes/qualification inputs | needs F before those locks |
| encryptMemory final completion | tx, Memory lock/current gate, endApprovalsOnEncryptedEntry | ends copied hashes from interrupted old conversion | needs F before Memory lock |
| requestNodeSignature; MCP request delegates | authorized-memory tx, Node/reconcile, Memory SHARE, signing request INSERT | may prune; pins potential signature payload | needs F before anchors and same-tx signer policy (not pool fallback) |
| withdrawSigningRequest; MCP withdraw delegates | authorized-memory tx, Node UPDATE, request UPDATE | request state only; no existing signature removed | participate consistently; preserve requester-account gate |
| completeSigningRequestInTransaction | caller-owned tx; Node UPDATE, request UPDATE, Memory SHARE, credential UPDATE, signature INSERT | creates signature/retention qualification | no production caller in this baseline; prepared-only helper boundary/tests, no invented HTTP/MCP signing route |
| declineSigningRequestInTransaction | caller-owned tx; Node UPDATE, request UPDATE | ends request only | no production caller; classify explicitly with same helper contract |
| cancelFirstPasskey (cancel-link POST) | tx, exclusive user anchor, credential UPDATE, token spend, sign-in cascade | pending signatures become CANCELLED; reader credentials can end | needs F before user anchor; token eligibility after wait |
| finishRevoke (ceremony finish POST) | tx, exclusive user anchor, prover SHARE, target UPDATE, ceremony consume, sign-in cascade | signature window cancellation/credential state | needs F before user anchor; no changes to proof/browser policy |
| endWindowEarly (ceremony POST) | tx, exclusive user anchor, credential UPDATE, fresh-sign-in consume | PENDING signatures become current/earlier | needs F before user anchor; DB-clock eligibility after wait |
| passkey proof/register/label/counter writes | credential/ceremony/user locks, no existing signature created | registration creates a new id; counter/label do not change verification qualification | explicit exclusion only after field/caller check; do not blanket-fence all passkey code |
| deleteUser / mergeUsers / deleteWorker | account-fence SERIALIZABLE adapter + epoch freshness/retry, then existing locks | erasure/cascade/identity semantics and compile authority | #2263 owns adapter; preserve existing isolation and whole-attempt retry; combined matrix required |
| restoreNodeRevision (+truncate) | explicit tx; path locks, Node/reconcile, selected Revision UPDATE, write/truncate | snapshots/cap prune; deliberate later-history deletion | needs F before path/Node locks; preserve current-memory/foreign-snapshot gates |
| deleteNodeRevision | pooled precheck + pooled delete | deliberate relied-history deletion allowed | needs one F tx, current gate + expected-memory/Node check after wait; preserve deliberate-break behavior |
| clearNodeHistory | pooled precheck + pooled deleteMany | same, all snapshots; allowed on tombstones | needs one F tx and fresh gate; do not substitute automatic retention exemptions |
| updateNodeRevision revLabel | pooled gated label update | changes label only, not content/approval/revNo/signature | nonqualification exclusion; keep read disclosure/current-memory gates |
| Node/Memory hard deletion and subtree purge | assorted outer transactions, cascade Revision/Signature/edge deletion | removes source/retention evidence even without explicit revision delete | caller census required; included in combined boundary map, not assumed covered by deleteMany scan |

Clock-only cooling-off expiry is derived state, not a writer. Tests must name
the evaluation time. Signature verification cache/label/counter changes are not
silently treated as new signatures. AutomationVersion.approvalHash is a different
entity, not a Node approval carrier; decision-family history is exempt from cap
pruning and decision approval remains unavailable in this baseline.

## All prune-capable snapshot/reconciliation callers

`createNodeRevision` has one automatic deleteMany seam, joining signed and
approval-carrier exemptions. Every caller below can reach it indirectly via
reconciliation even if it never explicitly calls deleteMany. Existing
`includeHistoryCallerInventory2063.json` counts these API sites; the census is
supporting evidence, never proof of outer locks or full raw-writer coverage.

| Caller family | Actual outer entry / current inner order | Integration obligation |
| --- | --- | --- |
| canonical GraphQL node/batch/parent, MCP shared read | read-only RR unchanged; prepared F + RC drift | already migrated; preserve unchanged progress and re-use prepared proof |
| skillPlan / selectedSkillFilePlan | same two-phase policy, 60s/15s, selected size+projection coherent | already migrated by #2129; preserve all rooted-credential and row-wait controls |
| spec renumber prereconcile | prepared F, fresh write gate, reconcile | already migrated; earlier move and later CAS rewrite remain separately classified |
| writeNodeCoreRaw / writeNodeCore | own tx or caller-supplied tx; authority/edge/address/Node ordering | owns generic GraphQL/spec/comment/definition descendants; outer caller graph, no nested fence/late upgrade |
| searchReplaceInNodes | one batch tx, existing node/path locks | F first; fresh batch authority; preserve sorted Node order |
| cloneNode | own tx, source reconcile + destination locks | F before complete existing set; both memory gates |
| mergeNodes | own tx, source/target reconciliation + deletion | F first; source deletion is a separate qualification effect |
| moveNodeSubtree | consumes caller tx; source/destination memories, address/row set, snapshots | enumerate GraphQL/MCP/spec callers; migrate their outer tx, never acquire F inside move helper |
| restoreRevision (agent published revision) | explicit tx, prior Node reconciliation/snapshot | F before existing publish/address/Node locks |
| searchReplaceInSpecNodes | RR preview (no writes); apply tx with channel/path, sorted Nodes then Memory | preserve read-only preview; F before apply locks and fresh tx-bound gate |
| controller createNodeAsSystem | filesystem save BEFORE tx; path locks then Node | keep filesystem outside F; prepared transaction around deciding DB work |
| cloneMemoryGraph / extractParentNodeGraph | outer tx, source reconciliation + graph copy/move | F before locks; no base-client fallback |
| mergeMemories runMerge | per-batch transactions, source/target snapshots and graph rewrites | F per actual atomic batch; preserve bounded batching and final cleanup classification |
| Git sync updateNodeFromGitSync + cleanup | shared outer sync transaction, address/subtree/Node locks, snapshots and deletes | F at sync tx entry; no external git work under F; retries re-enter outer boundary |
| MCP create_parent_node / create_node / update_node / move_node | direct tx snapshot/reconcile bridges | migrate actual callback outer tx; preserve scoped write and move gates |
| decision lockLog / lockDecision | authorized-memory tx, log before decision, reconciliation | potential reconcile prune seam despite decision no-prune branch; classify before any prepared guard, preserve log/decision order |
| signing request helper / approval helper / encrypt conversion | see qualification table | cannot be skipped because calls are indirect |

Node field/address/edge/raw-SQL writers that alter include selection without
snapshot calls, plus every cascading delete, must be named in the full combined
writer map. Existing entitlementWriterInventory2046 covers grants, subscriptions,
base, installs, retirement and pointers; it does not cover these Node/prune
classes and cannot stand in for their proof.

## Required evidence before freeze

- Red-first first-statement/actual-wait controls for each participating outer
  boundary, in both orders; no late or nested fence and no lock upgrade.
- Actual approval direct/bulk/placed (#2235) gates and skips; post-wait current
  authority, expected memory, address/liveness; refusal leaves no reconciliation.
- Signature creation/window/revocation selection and prune retention races;
  deliberate history deletes still succeed and break selection, not substitute.
- Full actual compile tree (#2258) read/write holders versus each qualification
  boundary; account epoch stale-snapshot and reverse-order matrix included.
- Existing RR fast-path progress, selected JSON bounds, credential-root content,
  schema/migration/post-push parity, signing and approval tests retained.
- T3 independent seats + fresh disposable two-connection QA, final security,
  named Sonnet-class stack campaign and teardown coordinated by Marco. No
  production fixture/key use, migration, deployment or activation is granted.

## Local implementation checkpoint (not frozen)

The main-based delivery now places F at the explicit outer transactions listed
above for approval, signing requests, passkey qualification, encryption,
revision restore/deletion, generic node writes and batches, spec/decision
writes, controller copy/move/merge and Git/MCP writes. Client-shaped snapshot,
approval, signing-state and subtree helpers reject raw/manual-lock/escaped
clients instead of obtaining a late fence. The authority wrapper opts in;
existing SERIALIZABLE consumers do not change isolation implicitly.

Team-role writes formerly held a role lock on one pooled transaction while
opening the node write on another. They now take F, then the role lock, and
carry the same prepared client through the core; post-commit effects run after
the real outer commit. Generic node gates and principal-bearing MCP write
boundaries refresh actor/credential state after F. Full authority coverage is
still under audit, particularly encryption and account/entitlement composition.

The cascade census additionally names expired anonymous-memory cleanup,
createMemory/clone/extract/App-memory tombstone reclamation, Agent creation's
reclamation, system-memory repair reclamation, deleteMemory's tombstone and
owner-namespace reclamation during account merge. The former boundaries are
locally migrated; account merge remains the #2263 adapter's combined-tree
obligation. Subscription revocation now qualifies and deletes one empty personal/private
memory in the same fenced authorized transaction, under Memory FOR UPDATE.
App reclamation is fenced at both outer cascade transactions. Parent-entity
cascades and raw owner-handle namespace reclamation still need explicit
classification/integration. No
snapshot-only inventory can exclude them on the basis of zero observed nodes.

Local evidence so far: 203 affected qualification/approval/Git tests pass;
105 qualification/minted-corpus/App-memory regression tests pass, including
memory-delete in both fence orders. These are overlapping runs, not a sum of
unique controls. An unfrozen full regression run is in progress; it cannot be
reported as evidence for the eventual final hash. No complete matrix, peer
seat, combined compile QA or readiness claim follows from this checkpoint.

Raw-address/cascade follow-up: `renameOwnerNamespacedUrns` (updateMyProfile)
executes raw DELETE of tombstoned Agents/Memories before owner namespace
rewrites; `mergeOwnerNamespacedUrns` belongs to account merge's adapter.
`propagateOrgUrnRename` rewrites source addresses/aliases but performs no
history deletion. Ordinary memory URN updates and graph/edge selection writers
must be assigned in the overall S9 writer map even if outside this qualification
slice. Ownership clarification requested from Marco/Basil; none are silently
excluded as label-only writes.
