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

## Current implementation and scope

The tables above describe baseline boundaries and the integration obligations,
not a claim that their entire matrix is complete. Delivery is draft PR #2273,
branch `anne/2063-qualification`; tests/evidence remain in progress.

The delivery puts F at explicit outer transactions for approval, signing
requests, passkey qualification, encryption, restore/delete/clear history,
generic node writes/batches, spec/decision writes, controller copy/move/merge,
and Git/MCP writes. Snapshot, approval, signing-state and subtree helpers
refuse a raw, manually SQL-locked, pooled or escaped client. The authorized
wrapper opts in; existing SERIALIZABLE consumers keep their own adapter.

Team-role writes formerly held a role lock on one pooled transaction while
opening their node write on another. They now carry the prepared client and
post-commit effects through the actual outer commit. Their order is F, existing
Agent-definition authority anchors/rows, App SHARE, role advisory key, live
context, current App/Team Agent and memory write gates, then the core's existing
address/row order. App uninstall during the F wait refuses before any node or
history mutation (two red-before-fix controls). Restore refreshes presented
credentials and source/destination read/write gates before reconciliation; published-agent
restore also holds current Agent/Memory authority and refuses changed snapshot data
before destructive work. Spec citation reservation refreshes authorization before tombstone archival; reservation and renumber prereconciliation acquire the existing complete Agent-definition authority set before key/address/history work. Spec replacement apply uses the prepared context for its
write/readable-include gates and preserves its deleted-corpus stale-plan refusal;
each encryption flip/conversion/completion root takes complete owner/actor authority anchors before Memory rows and refreshes credentials before conversion. A red-first SQL-order control covers every root; real revocation after the flag flip refuses conversion without adding a snapshot. Generic node gates and
principal-bearing MCP writes also refresh the presented actor/key/root.

Expired anonymous-memory cleanup, explicit tombstone memory/App reclamation,
memory deletion and subscription revocation's empty-memory cleanup are named
history-removal boundaries. The subscription cleanup now shares its F-first
authorized revocation transaction, locks one candidate Memory FOR UPDATE and
rechecks `nodes: none`. Marco #30990 keeps explicit tombstone memory/App
reclamation in this pruning cut, without extending it further.

**NOT covered, per Marco #30980:** owner-handle, org and ordinary memory
source/address renames. `renameOwnerNamespacedUrns` bypasses snapshot APIs and
can raw-delete tombstoned Memories/Agents before rewriting the namespace.
`propagateOrgUrnRename` rewrites addresses/aliases without history deletion.
The briefly integrated owner-handle change was removed when the scope ruling
arrived; historical owner-inclusive evidence is superseded. Marco filed #2274 on Xylon's ruling. Do not treat this PR as a complete global
source-writer fence or as authority to activate compile.

Basil #30977 confirms #2263 owns setAgentBase, retireWorker, grant create/revoke,
subscription revocation (not its old pooled cleanup), deleteAgent's agent/system
memory tombstone, boot-pointer setters, install/uninstall, createApp and dep
installs, updateAgent publish, first-contact session, deleteWorker, account
operations and node-read reconciliation. It owns neither App deletion/reclaim
nor source/address writers. The subscription-revoker overlap is resolved in
evidence by retaining the cleanup inside the same F-first authorized transaction.

Memory clone/extract and each bounded merge batch refresh authorization on the
same prepared client before reconciliation or graph work. The explicit reuse
option rejects raw or escaped clients and cannot open a nested transaction.
An owner-scope change refuses the whole prepared attempt: it cannot retry while
holding the old authority anchors. Channel keys precede Memory row locks; final
merge cleanup takes source UPDATE and target NO KEY UPDATE on first acquisition.
A real key revocation between committed merge batches stops the next batch and
preserves the partial receipt (250 relocated, one remaining, source retained).

Encrypted anonymous promotion now locks and reads current live Node values
inside its deciding transaction. A red-first queued-writer regression showed
that the earlier pre-fence scan overwrote a committed content/abstract/data
edit; the fixed conversion preserves that edit and the existing exact-App
completion policy. The competing-promotion-key refusal remains covered.

Direct legacy-controller and Git sync boundary tests cover both waiting before
source rows and exclusivity through actual commit. Direct MCP closures cover
parent update, node update, tombstone resurrection and move. Combined tests
also check actual affected-source compile text/provenance in both orders,
including typed refusal for retired or moved-away includes. Git's standalone
syncStatus metadata update can queue on the compiler's output Memory row
before Git reaches its F-first deciding source/history transaction; that
prelude is classified separately in the control.

Explicit memory/App reclamation now rechecks the exact presented credential
and current creation/export policy before destroying retained history. Seven
red-first controls showed that a later fresh gate could refuse only after an
earlier cleanup had committed. The dependency-App control revokes between
parent creation and dependency cleanup and preserves all retained data on
refusal. These gates cover the deciding cleanup transaction itself, including Agent system-memory creation, App-scoped memory creation, and privileged system-memory repair. Repair refuses a changed owner, pointer or URN read set before removing a tombstone.

## Evidence and remaining gates

- Current delivery controls: qualification94, role40 (including two red-first
  App-wait refusals), restore/provenance38, encryption105 pass locally. Test
  counts overlap; they are never summed as unique controls.
- Scoped combined predecessor `badc7f00` composes exact held heads #2263
  `417253fd043c7910db73dc138facccde5cd2c73a`, #2258
  `c65e694a1a192d41078f73215082a1966bab6d79`, and deliveryad2e8f8c. Its
  qualification/actual-compile/account/role matrix285 passes. The current controller
  authorization additions must be merged into a refreshed tree.
- The full diagnostic run at immutable predecessor48d3aa15 completed with
  848 passing files and 44 failures across12 files. It found legacy helper transactions, missing live ADMIN actors, old lock-wait
  assumptions and a nested real-writer test hook. Focused repairs preserve the
  assertions and adapt fixtures to the actual prepared boundary; all12 affected
  suites now pass together (188 tests). They do not weaken production gates.
  No local full or final-head pass is claimed.
- Full per-boundary controls remain required for every enumerated integration,
  including encryption subtransactions, retention/prune affected-source
  semantics, and source/destination authority after waits.
- Final-head checks, refreshed combined QA, T3 + scoped §10/L independent seats
  and the named Sonnet stack campaign remain pending with Marco. #2263/#2258
  stay held. Their epoch old-binary/default-off availability issue remains in
  its owning lane. No migration, merge, deployment or activation is granted.

## Combined readiness: excluded raw writers are not waived

| Combined-gate blocker | Open effect | Ownership / decision |
| --- | --- | --- |
| [#2274](https://github.com/hadron-memory/hadron-server/issues/2274) | Excluded address rewrites and raw target-namespace tombstone deletions with source/history cascades | Distinct rename/address follow-up; stable IDs do not waive source/provenance assessment. |
| [#2277](https://github.com/hadron-memory/hadron-server/issues/2277) | Admitted unfenced comment writers and source-memory restoreNode; other candidates have scoped FIT dispositions below | Vera #31196 requires fencing these writers; production ownership remains for Xylon/Marco. Anne analysis only; no admission narrowing authorized. |

Xylon #31001 confirms the separate follow-up and keeps a blocker on every
qualified-identity or served-text/provenance guarantee that depends on fencing
these writers. Packaging does not establish their safety. The follow-up is [#2274](https://github.com/hadron-memory/hadron-server/issues/2274),
filed by Marco in #31015. The combined-gate blocker must cite it. The census is:

| Excluded entry / raw writer | Fields or retained evidence affected | Required combined assessment |
| --- | --- | --- |
| updateMyProfile / renameOwnerNamespacedUrns | raw DELETE of tombstoned Agents and Memories in the target namespace, cascaded source nodes/history; Memory/Agent/App URNs, aliases and persisted trigger entry-node URNs | Can a raw reclaim invalidate an occurrence's nodeId/revNo or a source selected during compile? Prove refusal/serialization/atomicity against actual read and write holders before clearing the blocker. |
| updateOrganization / propagateOrgUrnRename | Memory/Agent/App URNs and old-name aliases via raw bulk statements | Test source/include resolution and namespace reuse across the deciding read set; a stable id alone is not proof of one coherent selection. |
| updateMemory URN path | Memory.urn and rename aliases inside its existing memory-row transaction | Assess fully qualified includes, alias collision/reuse and before/after source selection on the actual combined tree. |

Compiled occurrences store nodeId, revNo, hash, selection flags, position and
parent/order (not a copied memory URN). Therefore the question is whether
selection of those ids/revisions and the resulting compiled content hash remain
coherent, not whether an unrecorded URN string changes. The immutable provenance
row, compiled-from edge and published pointer must still commit together or all
roll back. These are unresolved assessment obligations, not a demonstrated
runtime failure or permission to change the excluded writers here.

MCP managed-definition writers also acquire their existing definition-authority
set before credential/root rows. A real-writer SQL-order observer passes; removing
that pre-acquisition makes the observer fail, and the source is restored. This
keeps F first and first acquisitions of authority keys ahead of presented-key
locks; later same-key re-acquisitions are reentrant.


The generic-caller matrix now separately exercises edit, property merge, move,
clone, merge/delete-source, hard delete and bulk replacement in both fence
orders. Clone's source reconciliation refreshes the read gate; merge and bulk
replacement refresh actor/credential and their source/target or planned-memory
gates before reconciliation. New key-revoked-during-F controls leave clone,
merge and bulk source/history/target unchanged. The pairwise compile/account
matrix must include these actual entry classes in its next evidence hash.

## Additional raw source classes and scoped FIT dispositions

These are census findings, not authorization to expand this delivery. They
must receive ownership or a source-admission/atomicity disposition before the
combined map can be called complete. #2274's rename scope does not implicitly
own them.

| Class / entry | Actual source admission | Write/delete/liveness effect | Existing outer lock / epoch participation | Proposed owner / disposition |
| --- | --- | --- | --- | --- |
| Comment create/edit/delete/thread lifecycle (`resolvers.comments.ts`) | **Confirmed actual:** licensed foreign Agent-system comment compiles; its author edits while target compile holds F | Body/quote edits and stubs overwrite content; revSeq advances; deletes change liveness; no NodeRevision by contract | Existing authorized Memory/App/org/user anchors and comment-thread rows. No F/epoch opt-in on comment roots. Same-org/user anchors can mask the gap. | Vera #31196 confirms admission and requires writer fencing; Basil owns the separate main-based #2277 cut per Xylon #31226, not edits to held #2263; F-first/epoch and lock-order attach checked before implementation. Anne retains census/combined evidence. No shortcut nodeType exclusion authorized. [Finding](https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:hadron-server:findings:comment-source-writer-outside-compile-fence). |
| Channel creation/reuse/rename/deletion and message producers (`channels.ts`, `resolvers.channel.ts`, `resolvers.mutation.chat.ts`) | **Confirmed admission diagnostic:** actual createChannel root in Agent system memory compiles by explicit Node URN; occurrence retained in provenance even with empty body. Actual `:messages` parent and produced chat-message admission also confirmed (diagnostic below) | Clears/restores root content and abstract; changes loc/liveness; structural and content-bearing message Node creation | Core consumes caller tx. Direct Channel API uses a raw transaction with Channel-memory/path locks; chat writers use existing authorized roots without F. Some callers such as #2263 createApp already supply F; that is not class-wide coverage. | Vera #31252 corrects FIT: actual Channel roots in source memories ARE source writers and require fencing. Xylon #31257 retains this as an open combined #2277 blocker. Remaining source-family attaches belong to Basil analysis/red-first after #2283 author freeze; each needs Xylon CHECKED before implementation. Outside Basil comment/restore cut. Actual message admission confirmed; no append exemption. |
| Recovery `restoreNode` (`resolvers.recovery.ts`) | **Static candidate only:** restores ordinary source availability; not yet paired with actual compile | Clears deletedAt; restores TARGET-deleted comment threads without a revision snapshot | Explicit READ COMMITTED tx: install authority, shared authority anchors, Channel/path/removal rows and rulebook checks. No F/epoch at this entry. | Vera #31196 requires fencing when restoring in a source memory; R193 exempts only the include check. Basil owns the separate main-based #2277 analysis/red-first cut per Xylon #31226; Xylon #31255 CHECKED the class-system scope with locked drift refusal and uniform resolve/reopen. Depends on #2273 shared primitive; actual compile both orders and integrated #2263 epoch evidence required. Anne retains census/combined evidence. Revision-restore controls do not cover this distinct door. |
| Published-agent snapshot `createRevision` (`resolvers.mutation.session.ts`) | **Confirmed admission diagnostic:** actual createRevision creates revisions:rev-1 in Agent system memory; explicit Node URN compiles and records its occurrence, despite empty body and snapshot payload living in data | Creates name/loc/identity and availability; publication flag is data-only | Raw ancestor-path transaction after preflight; no F/epoch. Destructive restore is separately qualified in #2273. | Vera #31196: revisions:* reads need no fence. Actual snapshot creation is a writer: base-client revisions parent upsert, then raw ancestor-path transaction inserts a new Node with name/description/data and liveness. No F/epoch on either root. Admission diagnostic passes; Vera #31252 confirms creation in a source memory requires fencing, and Xylon #31257 retains it as an open combined #2277 blocker. Production owner unassigned; outside Basil comment/restore cut. |
| Agent URN-tombstone preamble (`createAgentCore`) | **Static identity/authority candidate:** this is an Agent deletion, not an included Node admission witness | Deletes old Agent and can cascade entitlement/identity rows; does not itself cascade system Memory | Standalone ctx.db.agent.delete before the prepared provisioning root. Not fenced or matrix-covered by #2263 (Basil #31171). The new provisioning root qualifies explicit Memory-history removal only. | Vera #31196: no fence needed if the Agent is not includable before commit. Fresh allocation read/URN invisibility and include-wait pin passes. Xylon #31257 closes only that fresh-provisioning premise, not old entitlement deletion or supplied-Memory promotion. Vera #31252 classifies old grant deletion as a grant writer: fence it or re-verify grants at deciding read. Open combined #2277 blocker, production owner unassigned. Basil volunteered only if assigned; no ownership inferred. Separate from #2274. |
| Account owner-namespace merge/delete | Basil-owned account operation; no additional source-admission claim here | Surgical namespace tombstone reclaim, address/owner rewrites and account cascades | #2263 withAccountFenceTransaction in mergeUsers/deleteUser. Basil #31171 reports generic account-op stale-wait controls, **not per-door merge/delete rows**. | Basil-owned. Any extra per-door matrix is his lane; do not describe generic coverage as actual per-door evidence. |

Xylon #31172 required a separate #2046-linked source-writer/source-admission
issue for these rows. Marco filed [#2277](https://github.com/hadron-memory/hadron-server/issues/2277)
in #31181, distinguishing the actual comment witness from static candidates. Admitted unfenced writers remain explicit combined
#2258/#2263/#2273 blockers until they join the accepted protocol or an approved
contract excludes them. Anne owns census/disposition analysis only. Marco #31181 has not assigned
the Agent-tombstone preamble row pending FIT and disposition. Vera's
scoped FIT arrived in #31196: Agent system memories plus the install memory are sources (040:08), and any node in those memories counts. Comments must be fenced rather than excluded (writer access 110:03; never approved 110:15). Source-memory restoreNode must be fenced; R193 exempts only its include check. The original narrower Channel exclusion and read-only snapshot premise were corrected by Vera #31252 after actual admission diagnostics. Channel roots and revisions creation require fencing; snapshot reads need none. Old grant deletion requires fencing or deciding-read grant revalidation. Xylon #31226 assigns the separate comment/source-restore fencing cut to Basil and retains Anne on census/combined evidence. He requires reconciliation of any-class Channel admission and actual revisions:* CREATION (not a read-only substitute), and the Agent precommit pin plus actual tombstone cascade. Xylon #31257 accepts the fresh-allocation pin only and retains Channel-root creation, revisions creation, and old entitlement deletion as open combined blockers. No blanket closure follows from FIT. #2274 stays a distinct rename/address
follow-up. The coherent ordered comment sample proves a missing participant,
not mixed-receipt corruption.

Background embedding/usage fields and automation-version approval hashes are
not Node text/revision qualification writes merely because their names contain
`hash` or `approval`. Account owner-namespace merge runs inside its owning
account boundary; its surgical tombstone cleanup and address rewrites remain
part of that combined account/source census, not an extra unowned root inferred
from the shared reclaim helper alone.

### Source-admission reconciliation after Xylon #31226

Two evidence-only diagnostics pass using actual production creation closures:
createChannel in an Agent system memory and createRevision for that Agent.
Both generated Nodes are admitted by explicit Node URN; their empty live body
adds no text, but the compiler records the Node occurrence in provenance.
This is admission evidence only, not a counterparty-order qualification or a
mixed-receipt witness. Channel/chat cannot be dismissed by a non-source-class
assumption; the actual Channel root is a source. Chat message admission is not
yet separately demonstrated. Snapshot creation is a writer despite the FIT's
correct observation that snapshot reads need no fence.

Static Agent-tombstone cascade inspection: systemMemoryId is a scalar pointer
on Agent, not a reverse Memory cascade. Memory userMemoryOfAgent,
sharedMemoryOfAgent and installOfAgent relations use SET NULL; direct Agent
relations cascade AgentMemoryItem, AgentOrgGrant, AgentSubscription, AppAgent,
parent AgentImport, AI config, scopes, register/read-state rows, while Worker,
imported AgentImport and extending Agent relations can RESTRICT. This is schema
and migration inspection, not yet a live cascade diagnostic. New-Agent
precommit non-includability still requires Vera's cross-transaction read,
include and URN-resolution pin; it does not by itself qualify deletion of the
old Agent's entitlement graph before the provisioning transaction.

Evidence-only Agent diagnostics now pin the fresh allocation case: while the
actual createAgent provisioning transaction is held before commit, another
client's Memory query and Agent/Memory/Node resolveUrn return null; an actual
compile including a fixture Node in that new memory waits on the advisory fence
and only returns its text after commit. The fixture payload is inserted inside
the same provisioning transaction, not claimed as production-created content.
This does not cover promotion of an already-existing supplied Memory.

A separate diagnostic runs the actual createAgent raw tombstone Agent delete
and deliberately stops immediately afterward, before provisioning. The old
Agent and AgentOrgGrant are gone; its system Memory, source Node and retained
NodeRevision survive. Thus the old entitlement mutation commits independently
of subsequent provisioning. This is not a claim that new-Agent invisibility
qualifies old entitlement deletion. Five diagnostics (including the earlier
comment witness and two source-admission cases) pass together; these are
non-acceptance evidence, not five new qualified writer surfaces.

### Accepted disposition after diagnostic evidence (#31252 / #31257)

Vera corrected the narrower FIT: Channel roots and revisions:* CREATION in
source memories are writers requiring fencing. Old Agent tombstone grant
deletion is a grant writer requiring a fence or revalidation at the deciding
read. Xylon retains all three as open #2277 combined blockers. Fresh Agent
invisibility closes only fresh provisioning; supplied-memory promotion and
old entitlement deletion remain distinct. Anne owns analysis/combined evidence,
not production expansion. Basil's checked task covers comments/source restore
only and uses the #2273 primitive as a dependency. No competing helper or epoch
implementation; actual compile both orders and integrated #2263 epoch evidence
remain required. #2274 remains separately open.

### Dependent comment/source-restore integration evidence

Basil's checked cut `576f24c2` is composed only on the evidence branch, stacked
on #2273; it is not part of the #2273 delivery. It uses the shared prepared
primitive, class-system scope with locked drift refusal/retry, and uniform
resolve/reopen. The earlier unfenced comment diagnostic remains historical
red evidence; on this composition it is replaced by actual foreign-comment
edit versus compile read/write holders and inverse order. These assert exact
Before/After output, source revision and selected-text hash in stored provenance,
with no comment NodeRevision history. Two integrated #2263 controls additionally
show comment edit and source restore advance the epoch: a SERIALIZABLE account
attempt queued behind either writer fails stale before account work executes.
This does not qualify every comment door against actual compile or complete
Basil's whole QA. Channel-root creation, snapshot creation and old-Agent grant
deletion remain separate open #2277 blockers; #2274 remains open.

Basil's reported definition-restore failure on #2273 reproduced locally. The
fixture claimed ADMIN only in Context while the persisted user remained READER;
the fresh in-transaction authority gate correctly refused. Delivery `2976f653`
persists ADMIN in that one existing test. The full user-owned Agent file passes
25/25, without production authorization changes. A focused `-t` invocation also
hit the file's unrelated never-started Apollo teardown; the full file avoids
that partial-run artifact. No final full-suite or readiness claim follows.

### Current-main integration: new cloneAgent caller

Main `3c17ddaa` brings #2272's caller-owned `cloneMemoryGraphInTx` extraction.
The delivery wrapper retains F-first plus its fresh authorization callback and
passes the refreshed readable-memory set into that helper. Main's embedding
obligation stamps/tokens are preserved alongside the prepared writer roots.

A newly exposed actual integration failure remains: cloneAgent's existing
withAuthorizedTx root does not opt into F, but writeClone calls
reconcileStampedSourceNodes, which reaches the prepared-client guard in
ensureCurrentNodeRevisionInTransaction. The existing cloneAgentRaces test for
raw-edited stamped sources fails with the prepared-client refusal. Seven other
focused files pass; total339 pass/1 fail across8files. Xylon #31322 assigns this new caller under #2277/#2046 to Dan as a separate dependent F-first/prepared-client cut on #2273. Exact attach must be CHECKED before implementation, preserving authority/Channel/base-graph/row order, full retries and same-transaction reconcile/copy/audit rollback, and #2263 epoch once per holder. Anne retains integration/census and the named failing regression; the guard stays intact. Dependency/landing shape must produce an actually green delivery, not merely a separate PR.
The merge is not a frozen or ready head; full validation is diagnostic until
this caller joins an accepted boundary. No activation claim.

At delivery4ec46816 GitHub CI completed: typecheck and all structural checks
pass; shards2/3/4 pass. Shard1 fails ONLY the named cloneAgentRaces stamped
source regression (218files/3799tests pass,1test fails,7skipped in that shard).
[CI failure](https://github.com/hadron-memory/hadron-server/actions/runs/39890365186/job/120208378931).
This confirms the local blocker, not a full green or freeze. Basil's dependent
#2283 head71f9074f now contains this base and fixture fix; his reported full
suite also has this single failure. His report is distinguished from Anne's
own CI inspection and focused runs.

### Checked cloneAgent fold-in (#31345)

Xylon CHECKED the attach at T3/scoped §10/L6356294522 and selected direct fold-in
so #2273's prerequisite does not land red. Dan's authored commit
`20e6c0bfbcc9f9a6f651987094c2af4cc18faac9` is cherry-picked with source trailer
as `2aad4b5e`, preserving author/Worker/coauthor trailers. The production hunk
adds only `fence: true` to cloneAgent's existing outer authorized transaction.
Existing beneath-F ordering, fresh full retries, reconcile/copy/audit rollback
and timeout remain in place. The held-F pin is carried with the fix.

The caller inventory/tripwire also follows the extracted delegated calls:
cloneMemory's copy helper and cloneAgent's copy/reconcile helpers (three sites).
It was red before adding the inventory rows, green afterward. Expanded delivery
qualification/Agent clone/lock-order/inventory checks pass: nine files158 tests.
Evidence-only actual cloneAgent versus compile read/write/inverse controls pass;
its integrated account-epoch control changes from red (no F waiter) to green
(stale queued SERIALIZABLE account refuses before work). The focused combined
selection passes6 tests, including the two existing comment/restore epoch rows.
These close the named local cloneAgent regression and add scoped integration
evidence; full expanded #2273 CI/review and other #2274/#2277 dispositions are
still required. No frozen-green, merge or activation claim follows.

### Full-composition diagnostic and test-only repairs

The full evidence run on65dbe133 finished with879/882 files passing and16047
passing tests,3 failing tests,1 expected failure and7 skips. It found missing
cloneAgent create/delete rows in the held entitlement inventory, two empty
vector-result assertions, and a dbWorkers teardown hook timeout. Census-only
evidence commitd35a00ab adds the checked fenced cloneAgent sites and corrects
the stale old-Agent tombstone exclusion to counterparty-pending; the fresh
allocation pin remains distinct from unclosed supplied-Memory promotion.

The vector failures reproduce on unchanged main3c17ddaa with1500 deleted
vectors left in the HNSW graph and a forced approximate plan. Exactly the same
two assertions fail; the identical fixture with an exact plan passes10/10.
The test file now uses the established exact query handle for exact scope/rank
assertions, leaving production search and expected outputs unchanged. A new
adversarial pin checks HNSW versus exact plans with EXPLAIN, and asserts the
content and comment scopes after the dead-graph warmup. Removing the exact
handle kills that pin. See findings:vector-test-exact-assertion-hnsw-plan-flip.

The dbWorkers failure was the live-PG afterAll default10-second hook cap while
serially dropping its private probe databases. Cleanup now has the same bounded
60-second budget already used by that suite's setup and live-PG tests. No
cleanup operations or production behavior change. The two repaired files pass
60/60 together; these targeted results are not a replacement for a new full
combined run. The first full run remains recorded as red, not retroactively green.

Delivery1c6ddf0e's CI then exposed an independent1903 test assumption: its
answer-parity case required the old bare-max query to choose the bad created_at
walk after a populated roster was added. PG16 selected the healthy session
activity index instead. The same file's dedicated skew/non-vacuity pin passed,
as did its shipped-plan guards. The parity case now keeps all answer checks
and the shipped no-WALK assertion without requiring the old query to be slow
on every fixture. The separate bad-plan control is retained. Six file tests
pass locally; production liveness SQL is unchanged. Historical CI remains red
until the new head completes CI; the running full evidence snapshot is kept
unchanged until its result is recorded.

Fresh-stack QA found one additional operational caller: scripts/e2e/seed.ts
reconciled its approved/minted fixture Nodes through a plain transaction. That
is a repository prerequisite defect, not an environment waiver. It now uses
the shared withIncludeHistoryClientTransaction root without changing seed
safety checks or fixture content. The caller inventory scans scripts as well
as src and records this call (red before its row, green afterward). Inventory
and prepared-fence controls pass21/21. Fresh-stack seed/startup QA must be rerun
on the corrected head; those focused controls do not claim a seeded stack pass.

### Actual Channel producer field diagnostic (Anne, #31548/#31557)

The qualification test invokes createChannel and createChannelMessage in an Agent system memory, then compiles explicit references to the actual root, `:messages` parent and produced message. All three occurrences survive in provenance; their selected text is respectively empty, empty and the message body. A second actual message is independently admitted by explicit reference.

Trusted updateChatRootData and another append change root Node.data (conversationName, stageName, messageCount), while root content/revSeq and the first compilation's entire provenance remain unchanged. This pins latest-selection fields only; it does not exclude Node.data writes from the source-writer protocol, cover approved/pinned selection, or establish a fencing order. Vera #31542 confirms both appendChatMessage and updateChatRootData write source Nodes and require fencing. The remaining three source-family attaches remain NOT CHECKED pending Xylon on each bounded proposal.

Validation: targeted diagnostic 1 PASS; whole qualificationFence2063.test.ts 298/298 PASS; TypeScript noEmit PASS. Evidence-only change; no production or source-host refusal changes.
