# 049 — The Agent manifest: scopes, the active organization, Channels, and the chat register

Status: **planned** (2026-09-15, Dara, for the coordinator's dispatch
[hadron-server#1153](https://github.com/hadron-memory/hadron-server/issues/1153);
revised the same day after design-side review on PR #1154 — see §14).
**This is the plan, not the implementation.** The slices are cut from it; nothing
here has been built, and no spec citation is minted by it.

Design of record (hadron-concept, committed at `c70c908`):

- `design-discussions/hadron-platform/2026-09-13-memory-manifest-and-search-lenses/summary.md`
  — **D-2026-09-13-001 … 005**, Q-2026-09-13-001
- `design-discussions/hadron-platform/2026-09-13-agent-chat-register/summary.md`
  — **D-2026-09-13-006 … 010**, Q-2026-09-13-002 … 003
- `design-discussions/_registry/decisions.md` — the rule text, the supersessions, and
  the **rejected alternatives**. Every "rejected" below is quoted from there so a slice
  cannot re-adopt one by accident.
- **Three corrections to the design, made on PR #1154 by its author (Bo) and confirmed
  by Holger** (§14): the *attendee* replaces "per Agent" as the subject of a register
  row and the key of read-state; Agent-owned register rows are dropped; the human↔worker
  DM host memory was already decided by D-2026-08-18-001. The registry is amended by
  Bo, not by this plan.

Implementation issues that already exist and stay: **#1150** (the lens half — Scope
table, ladder, disclosure, active org on MCP), **#1047** (closed by Phase 4's protected
loc), **#1048** (absorbs Phase 8's Channel-addressed chat operations and item J).

Holger's governing constraint, stated in both sessions: **the CLI must surface 100% of
the platform.** Every server surface in this plan must be reachable from GraphQL, since
that is what the CLI consumes; nothing may land reachable only from the portal.

## 1. Grounding — this plan implements decided design, it does not re-decide it

The ten decisions, as corrected in §14, are treated as fixed. Where a decision determines
an implementation choice, the plan states the choice and cites the decision. Where a
decision leaves a choice open, the plan says **"open"** and offers at most a
recommendation. Where the design is **silent on something load-bearing**, the plan does
not fill the gap: §12 lists those as reports to the coordinator, and the affected slice is
marked as blocked on the answer.

Premises measured against current `main` (`f6188bc`) rather than recalled:

- **Protected branches (D-2026-08-25-004, `Memory.protectedLocs`) are not built.**
  `prisma/schema.prisma` has no such column and no issue tracks it. The Channel
  decision (D-2026-09-13-006) says creating a row "reserves and **protects** the loc",
  and its rejection of the chat-root-as-channel alternative rests on "nothing to
  protect before the first post". **Resolved (§14): shape B** — the gate is built here
  with the Channel table as its only predicate source; an issue for D-004's general
  column is owed regardless.
- **`getAppMemoryAccess` is primary-Agent-only** (`src/mcp/access-control.ts`,
  `appAgents … take: 1`). It is an access *gate* and stays that way; the `app` scope
  (§4.2 step 3) needs its own multi-Agent computation and must not widen the gate.
- **`globalSearch` does NOT delegate its node slice to `findNodes`.** Registry decision
  D-2026-06-30-002 says it should; the code (`src/lib/global-search/index.ts`,
  `ADAPTERS`; `entities.ts` `searchNodes`) runs its own predicates. The ladder therefore
  lands in **two** places (§4.2), and the registry note is stale — reported in §12.
- **`AppRun.agentId` is nullable**, so a run may have no attendee (§4.4).
- **Only app-class memories can host a chat today** (`cor:acl:030:01`, `shared ⇔ app`);
  a DM in a personal memory (D-2026-08-18-001) needs the chat-host typology first (§12).

## 2. Why one plan — the shared pieces, named once

The two sessions decided one epic. Four shapes recur, and each is a **first-class
deliverable built once**, then consumed by the later phases. S1, S2, S3 and S5 are
Phase 0; **S4 is built in Phase 4**, its first consumer, because its shape was decided
in review (shape B) and it has no earlier consumer. A slice that re-implements one of
these instead of consuming it is the specific failure this plan exists to prevent.

| # | Shared piece | Consumed by |
|---|---|---|
| **S1** | **The exactly-one-owner column set.** Nullable owner FKs + a CHECK `num_nonnulls(...) = 1`, never an `ownerKind` string (D-001, D-007). Precedent already in the repo: `chk_ai_service_config_owner` in `prisma/post-push.sql` (spec 036), with **partial unique indexes per owner** (`ai_service_configs_*_name_uniq … WHERE <owner> IS NOT NULL`) because Prisma cannot express them and a plain `@@unique` would let a soft-deleted row block the name forever. Delivered as: the CHECK + partial-index idiom (migration + `post-push.sql` + `src/test/globalSetup.ts` — `hrn:node:hadronmemory.com:hadron-server:review:non-prisma-ddl-sync`), one `resolveOwnerInput(ownerRef, allowedOwners)` helper that turns a caller's `{organizationRef \| agentRef \| appRef}` into the columns and applies the owner's write gate (§8), and one **collision resolver** `pickByOwnerPrecedence(rows, {app, agent?, org})` implementing App › Agent › organization with **namespacing, never union** (D-001: "merges two builders' intentions nobody reviewed"). **Parameterised by the allowed owner set:** Scope allows all three; the register allows organization and App only (§14 correction 2). | Scope (Phase 2), register (Phase 5) |
| **S2** | **Intersect-and-disclose.** `narrowToAccessible(requested: memoryId[], accessible: Set<memoryId>) → { kept, droppedIds }`, order-preserving. **`accessible` is a fully materialised set, never a "no filter" sentinel:** the existing gates return `null` only for shapes where they themselves mean "unrestricted", and platform admins get an explicit list precisely so the owner-only carve-out flows through (`getAccessibleMemoryIds`, `resolvers.helpers.ts`). The helper therefore refuses `null` and the caller materialises through the canonical gate first. Never widens (D-004: "a lens never grants"; D-008: "the register never grants"). The dropped half is *reported* as ids, never an error (D-004 rejected erroring: "turns a legitimate App-wide scope into a failure for every member lacking one memory"); rendering a dropped id as a URN happens only in S3, after the §8.2 visibility check. | scope resolution (Phase 3), `scope explain` (Phase 2), register can-act (Phase 6) |
| **S3** | **The disclosure envelope.** One renderer for "what this result was produced under": (a) a `scope` block on `FindNodesResult` **and on `GlobalSearchResult`** (which today carries only `hits`, `total`, `degraded`) and on the MCP text envelope (`scope:` line), (b) the degrade code `scope_narrowed` appended to the existing comma-separated `degraded` set (`FindNodesResult.degraded`, `typeDefs.ts` ~l.238 — "parse the set, never compare the whole string"), (c) the optional outside-scope count, applying to the **node slice** of a global search. Dropped memories render as a **count** always and as URNs only through the **existing memory discoverability predicate** (§8.2). Precedent: `hadron_list_memories` already prints a `Scope:` line (`src/mcp/server.ts` ~l.1618) — that wording is superseded by this piece, not duplicated. | findNodes / list_nodes / globalSearch (Phase 3), register reads (Phase 6) |
| **S4** | **The protected-loc write gate.** A predicate `isProtectedLoc(memoryId, loc)` — **Phase 4: the Channel table is its only source** (shape B) — and one refusal point in the generic node write path (create / update / delete / move, GraphQL and MCP) that consults it. **Overlap, not just the named loc:** a recursive delete whose subtree contains a protected address, a move whose *source* subtree contains one, and a move whose *destination* enters one are all refused. The owning surface writes through its own gate. `deleteMemory` on a host memory holding a live Channel is a separate write surface and is covered in §8.5. | Channel (Phase 4); later D-2026-08-25-004 as a second source |
| **S5** | **The register disclosure vocabulary.** A closed set of reason codes an entry carries when the attendee cannot act on it (D-008/D11: "disclosed with the reason and the Agent's URN, never dropped"): `HOST_MEMORY_NOT_READABLE`, `HOST_MEMORY_NOT_WRITABLE`, `CHANNEL_DELETED`, `DRIVER_NOT_PARTICIPANT`, `UNKNOWN_ACTOR` (no actor supplied — applies to `canPost` only), `IMPERSONATION` (support view — applies to `canPost` only). Rendered identically by every consumer of `resolveRegister`. | briefing, `hadron_whoami`, run snapshot, relay read (Phase 6) |

The manifest itself is not a table. It is the **three lists** an Agent's consumers read
(D7 local, register session): memories = the existing `AgentMemoryItem`
(`cor:dmo:050:09`), scopes = Phase 2, channels = Phase 5. Nothing new stores "the
manifest"; `resolveRegister` and the scope resolver are its read surfaces.

**Composite-PK models:** `ScopeMemory` and `ChannelReadState` have no `id` column and
must be added to `MODELS_WITHOUT_ID` in `src/integrations/db/client.ts` in the phase that
creates them, or the client extension injects an `id` and every create fails. Explicit
task on Phases 2 and 7.

## 3. Data model (Prisma sketch)

New tables are listed here; **migrations are §7**, called out separately because several
of them rewrite existing data. Sketches show shape, not compilable Prisma — relations and
back-references are named where they carry semantics.

### 3.1 `Scope` + `ScopeMemory` (D-001)

```prisma
model Scope {
  id             String   @id @default(cuid())
  name           String                       // unique per OWNER among live rows (partial indexes, S1)
  description    String?
  organizationId String?  @map("organization_id")   // S1 — exactly one set
  agentId        String?  @map("agent_id")
  appId          String?  @map("app_id")
  // audit + soft-delete as every tenanted row
  memories       ScopeMemory[]
}

/// The ORDERED memory list. A join row rather than an id array so that
/// "which scopes include this memory" is a query (D-001 rejected ids-in-JSON
/// for exactly that: `scope explain` and memory deletion need the reverse
/// lookup) and so memory deletion cascades.
model ScopeMemory {
  scopeId  String
  memoryId String
  position Int
  scope    Scope  @relation(fields: [scopeId],  references: [id], onDelete: Cascade)
  memory   Memory @relation(fields: [memoryId], references: [id], onDelete: Cascade)
  @@id([scopeId, memoryId]); @@unique([scopeId, position])
}
```

- `name` is unique **per owner among live rows** (partial indexes, S1), which is what
  makes App › Agent › org collisions possible and resolvable by namespacing (`marketing`
  vs `juno/marketing` per #1150 — the namespacing spelling is **open**, tunable, and must
  be one shared function, S1).
- **`global` AND `app` are reserved** (D-002 names both as ladder tokens) and refused at
  create; a scope named `app` would be ambiguous with the active-App view.
- A scope may list memories the App has not attached (D-001); selecting it never
  attaches anything. **No saved filter** (D-001 rejected "memories plus a saved
  filter": "a filter riding silently under a name is how a wrong-country answer becomes
  invisible") and **no retrieval parameters** (D-004: "a scope never carries depth,
  padding, or weights").
- `Memory` gains the back-relation `scopeMemberships ScopeMemory[]`; `deleteMemory`
  cascades the join rows, which is the reverse lookup D-001 asks for.

### 3.2 The active organization and the active scope on the client session (D-002, D-003)

"The session's active scope" in the ladder is the **client** session — the sibling of
`hadron_set_active_app` / `hadron_set_active_memory`, which persist per
`(userId, clientKey)` in `McpSessionState` since #1013. It is **not** the Hadron
`Session` row (that row carries `appId` and the write-memory `memoryId`, and is bound to
a Worker; a stint's search lens is not provenance). So:

```prisma
model McpSessionState {  // existing — two columns added
  organizationId String? @map("organization_id")   // hadron_set_active_org  (D-003)
  scopeId        String? @map("scope_id")          // hadron_set_active_scope (D-002)
}
```

The CLI's equivalents are config keys (hadron-cli#578). GraphQL needs no session state:
the caller passes `orgId` (already on `findNodes` / `globalSearch`, `cor:api:100:01`)
and the new `scope` argument per call — **with an `appRef` when the scope is a bare
name**, because GraphQL has no active App for a user principal (`Context.appId` is set
only for App-key authentication) and a bare name is unique only per owner. A scope
**id or URN** needs no `appRef`.

### 3.3 Headless runs carry snapshots (D-004, D-007)

```prisma
model AppRun {  // existing — two columns added
  /// D-2026-09-13-004: the trigger MAY name a scope; it is SNAPSHOTTED at mint as the
  /// ordered memory-id list (same reason `policy` is snapshotted — a run must not change
  /// meaning because someone edited a scope mid-flight). Null ⇒ `app`. SCOPE DATA ONLY:
  /// every hop re-intersects it with the principal's CURRENT access (S2) — a snapshot
  /// is never an access grant that outlives a revoked membership.
  scopeSnapshot    Json? @map("scope_snapshot")
  /// D-2026-09-13-007: the resolved register at mint, for the attention section (§4.4).
  /// Same re-intersection rule; the Channel watermarks are read live, the ROWS are not.
  registerSnapshot Json? @map("register_snapshot")
}
```

Where a run's scope comes from — the trigger rows, each gaining an optional scope FK
(`AgentSchedule.scopeId`; `AgentWebhook.scopeId`; `hadron_spawn`'s input, defaulting to
the parent run's snapshot). No "default named scope
for headless runs" (D-004). §7.5 lists the columns.

### 3.4 `Channel` (D-006, D12)

```prisma
enum ChannelKind { CHAT }   // `BLOCKERS` / `TASKS` when built (D7 local) — not now

model Channel {
  id             String      @id @default(cuid())
  memoryId       String      @map("memory_id")      // host memory — the audience (cor:acl:030:01)
  loc            String                             // reserved address of the chat root
  name           String
  kind           ChannelKind
  description    String?
  chatRootNodeId String      @map("chat_root_node_id")   // eager, one-to-one (D-006)
  lastSeq        Int         @default(0) @map("last_seq")           // D-009 watermark
  lastMessageAt  DateTime?   @map("last_message_at")
  // audit + soft-delete
  @@unique([memoryId, loc])          // one Channel per address
  @@unique([chatRootNodeId])         // one Channel per root
}
```

- **Eager one-to-one creation is load-bearing** (D-006 adversarial round): the row, the
  chat-root node and its `:messages` child are created **in one transaction, under the
  ancestor-path lock the existing bootstrap already takes** (`lockAncestorsForCreateMany`
  in `bootstrapTeamChat`, `resolvers.teamChat.ts`), with create-OR-restore on the
  `@@unique([loc, memoryId])` tombstone. The lock is what makes the reservation real: a
  generic write racing the create cannot claim the loc between the row and the root. A
  Channel row whose root is missing is a bug, not a state.
- `lastSeq` is the **allocator's output**, written inside `appendChatMessage`'s
  ancestor lock (`src/lib/chatRoot.ts`) in the same transaction as the seq — it is the
  watermark D-009 needs and nothing else. The chat root's `data.messageCount` stays
  what it is: a routing operand
  (`findings:chat-seq-counter-is-a-routing-operand`). Two numbers, two jobs; the plan
  does not merge them. **`lastSeq − lastSeenSeq` is a watermark delta, not a message
  count** (§7.1 preserves gaps and the known duplicate); the attention section says
  "new since seq N" and never claims a number unless it counted rows.
- **"The App's default Channel"** (D-007, D2) needs a marker. **Proposed:**
  `App.defaultChannelId String? @unique` — a nullable FK on the App, set by Phase 4's
  migration and by eager creation at `createApp`. Rejected here: a boolean on the
  Channel (two defaults per App would be a data state the CHECK cannot refuse).
- `kind` is an enum by the repo's precedent (D-2026-05-22-002: prefer enums where
  future values are foreseeable). Adding `BLOCKERS` later is an enum-add, which with a
  CHECK referencing it is **two migration files** (the Postgres transaction rule the
  repo has already hit — `hrn:node:hadronmemory.com:dev:ops:incidents:20260517-p3009-memoryclass-ownership`).
- **No `bindings` relation here.** Spec 043's `ChatBinding` does not exist in the schema
  and this plan does not create it; the Phase 0 amendment to `specs/043-slack-integration/plan.md`
  gives it a **distinct** FK to the Hadron Channel (`hadronChannelId`) — its existing
  `channelId` means the *provider's* channel id and is used with `connectionId` /
  `threadId` for routing, sends and gap recovery, so it cannot be reused.

### 3.5 `RegisterEntry` (D-007, corrected per §14)

```prisma
model RegisterEntry {
  id               String       @id @default(cuid())
  organizationId   String?      // S1 — the OWNER, exactly one of TWO (Agent-owned rows dropped, §14)
  appId            String?
  channelId        String       @map("channel_id")
  /// The ATTENDEE (§14 correction 1) — who this row is for. A Worker when cast,
  /// otherwise an Agent in an App; BOTH NULL = every attendee in the owner's context
  /// (org-wide for an org row, App-wide for an App row — §14 correction 2, which is
  /// what keeps "every Agent attends the announcements channel" ONE row).
  attendeeWorkerId String?      @map("attendee_worker_id")
  attendeeAgentId  String?      @map("attendee_agent_id")   // with the row's App as context
  role             RegisterRole            // WATCH | POST | BOTH — INTENT, never permission (D-008)
  mentionOnly      Boolean      @default(false) @map("mention_only")
  description      String?                 // free text — the human's intent (D1)
  // audit
  // CHECK: num_nonnulls(organization_id, app_id) = 1
  // CHECK: num_nonnulls(attendee_worker_id, attendee_agent_id) <= 1
  // partial unique on (app_id, channel_id, attendee_worker_id) / (app_id, channel_id, attendee_agent_id)
  //   WHERE deleted_at IS NULL — the install default's natural key
}
enum RegisterRole { WATCH POST BOTH }
```

- **Not a trigger list** (D-007): a row here never starts a run. Triggers stay in
  `agent_schedules` / webhook routes / `SPAWN` (`AppRunTriggerKind`). Q-2026-09-13-002
  (a `CHANNEL` trigger kind) is out of scope.
- **Defaults are materialised** (D2): install writes a real App-owned row for the App's
  default Channel with `attendeeAgentId` = the installed Agent; a migration writes them
  for existing installs (§7.3). A second install into the same App is not a duplicate
  because the attendee differs. Rejected: derived-and-unstored ("cannot be switched
  off"), builder-declared ("a forgotten line makes a hermit").
- **Agent-owned rows are dropped** (§14 correction 2): an Agent's FK to one App's
  Channel cannot "travel with the install", and D2 already materialises the install row.
  What an Agent may still declare is the **defaults its install row is created with**
  (e.g. `mentionOnly`) — **storage of that declaration is open**; recommendation: a
  small `registerDefaults` JSON beside `memoryProvisioning` on `Agent`, since it is a
  scalar default and not a reference that can rot.
- **Each owner removes its own rows; an App may not remove an org row; an App may remove
  the install-created default** (D4).
- **Not exportable** (D-2026-08-25-006, standing): platform instrumentation, not memory
  content. Excluded from memory export and git mirror.

### 3.6 `ChannelReadState` (D-009, corrected per §14)

```prisma
/// Per ATTENDEE per Channel: where this attendee is up to. OUTSIDE the register (D-009
/// rejected a cursor on the register row: "mixes what-I-attend with where-I-am and
/// the relay would keep a second copy"). Keyed on the attendee, not the bare Agent —
/// two Workers cast from one Agent in one App (Iris and Henry) must not share a cursor
/// (§14 correction 1); the relay's watermark is per worker for the same reason.
model ChannelReadState {
  id          String   @id @default(cuid())   // surrogate: the natural key is partial
  workerId    String?  @map("worker_id")
  agentId     String?  @map("agent_id")
  appId       String?  @map("app_id")          // required with agentId (Agent-in-App)
  channelId   String   @map("channel_id")
  lastSeenSeq Int      @default(0) @map("last_seen_seq")
  updatedAt   DateTime
  // CHECK: num_nonnulls(worker_id, agent_id) = 1; app_id IS NOT NULL when agent_id IS NOT NULL
  // partial unique on (worker_id, channel_id) and (agent_id, app_id, channel_id)
}
```

- **Advances are monotonic:** every write is `lastSeenSeq = GREATEST(lastSeenSeq, :seq)`
  as a conditional update, because two concurrent runs of one attendee may checkpoint
  different seqs and an older transaction must never overwrite a newer cursor.
  Concurrent runs may therefore both *see* a window as new (duplicate attention, never
  skipped attention) — stated, accepted.
- The relay's per-(app, worker) state-file watermark "moves in" here (D-009) — the relay
  reads and advances this row (§5 Phase 7's mutation, gated in §8.7).
- **Mute is session state, never register or read-state** (D16 local). No column.

## 4. Resolution logic

### 4.1 The active-organization ladder (D-003, with the §14 step-5 correction)

One function, `resolveActiveOrg(principal, {namedOrgRef?, activeAppId?, storedOrgId?})`,
used by the MCP tools and by the CLI through GraphQL:

1. named in the call (`orgId` / `orgRef`) → membership-gated as `cor:api:100:01` already
   is (no admin bypass);
2. the active App's organization **only when the App is org-owned AND the caller is a
   member of that organization** — an AppMember of an org-owned App need not be an
   OrgMember, and the existing org narrowing in `findNodes` / `globalSearch` requires
   membership (`resolvers.query.node.ts` ~l.917, `resolvers.query.org.ts` ~l.281); a
   non-member falls through to step 3 rather than being widened to the whole org. A
   personal App (spec 047) has no organization at all — Holger's correction;
3. the explicitly set org (`McpSessionState.organizationId`, `hadron_set_active_org`);
4. the caller's single membership (`getMemberOrgIds` returns exactly one);
5. **zero memberships resolve to the user-owned view** (`cor:api:100`'s own
   personal/private memories) with the envelope saying so — spec 048 made org-less users
   ordinary and refusing them blocks search entirely. **Two or more memberships with no
   selection is the refusal**, typed `ORG_REQUIRED`, carrying the member list so the next
   call can name one. This is a partial reversal of D-2026-09-13-003's step 5, confirmed
   on PR #1154 (§14).

Selecting an org activates the `cor:api:100` org view; there is **no "org default
scope"** (D-003).

### 4.2 The scope ladder (D-002), for search and node listing ONLY

`resolveSearchScope(principal, {named?, appRef?, storedScopeId?, activeAppId?, activeOrgId})`
returns `{ memoryIds: string[] (ordered), label: string, droppedIds: string[] }`:

1. a scope **named in the call** (`scope` argument as id / URN, or a bare name with the
   App context — `appRef` on GraphQL, the active App on MCP; the reserved `global` = the
   active org's `cor:api:100` view, `app` = the active App's attached memories);
2. the session's active scope (`McpSessionState.scopeId`);
3. the active App ⇒ `app` — **a new computation `appScopeMemoryIds(appId)`**: the
   `AgentMemoryItem` rows of **every** installed Agent (`AppAgent`, with the same
   cross-org `AgentOrgGrant` admissibility `getAppMemoryAccess` applies to its primary
   Agent) plus the App's provisioned app-class memories. `getAppMemoryAccess` itself is
   primary-Agent-only by design and is **not** widened — it is a gate, this is a lens,
   and the lens is still intersected with the gate's output in S2;
4. the active organization (§4.1) ⇒ `global`;
5. refusal with the member list (falls out of §4.1 step 5).

Then **S2**: `memoryIds ∩ accessible`, dropped memories reported through **S3** as
`scope_narrowed`. Name resolution across owners is **S1**'s precedence, namespaced.

**Where it lands — two places, not one:** `findNodes` (`resolvers.query.node.ts`, the
"accessible ∩ requested" block ~l.934 is the one intersection D-004 names) with its MCP
mirrors `hadron_find_nodes` / `hadron_list_nodes`; **and** `globalSearch`'s node adapter
(`src/lib/global-search/entities.ts` `searchNodes`, which builds its own predicates and
does not call `findNodes` despite D-2026-06-30-002) with its MCP mirror `hadron_search`.
The resolved memory set is computed once by `resolveSearchScope` and handed to both; the
adapter change is a Phase 3 deliverable in its own right. **Entity listings (`memories`,
`apps`, `agents`, `hadron_list_memories`) do NOT narrow** — `cor:acl:020:03` rules 2–5
keep governing them; the amendment goes through the rule's own exit ("a surface specified
to be App-scoped by definition is not a broad listing") and reaches search and node
listing only.

**`scope` together with an explicit `memoryUrns`:** `memoryUrns` **narrows within** the
scope (it is a per-call filter, which D-001 says stay per call), and the envelope names
both. Confirmed as the design's intent on PR #1154.

**Scopes never dedupe** (D-005: "general search has no winners"). Same-address nodes from
different memories are all returned with full URNs; scope **order** is consumed only by
the stubbed task-customization operation, never by search.

### 4.3 `resolveRegister` (D5 local, D-007) — one resolver, every consumer

`resolveRegister({ attendee: {workerId} | {agentId, appId}, organizationId, actor? }) → RegisterView`,
where a view row is `{ entry, channel: {id, name, kind, hostMemory (disclosed per §8.2),
lastSeq, lastMessageAt}, readState?: {lastSeenSeq}, canRead, canPost, disclosure?: S5 code,
attendeeUrn }`.

- Collects the rows that apply to the attendee: rows naming the Worker; rows naming the
  Worker's Agent in this App (a Worker inherits its Agent-in-App rows); rows with no
  attendee owned by this App or by the org. App › org precedence applies **per Channel**
  (one view row per Channel; the winning owner's `role` / `mentionOnly` stand, the losers
  are not unioned). Agent-owned rows do not exist (§14).
- Joins the Channel watermark (Holger, turn 012) and the attendee's read-state.
- `canRead` / `canPost` are the **existing** host-memory gates evaluated for the actor
  (`requireTeamChatAccess`'s user branch / `canWriteToMemory`) — the register grants
  nothing (D-008). An entry the actor cannot act on is **returned with S5's reason and the
  attendee's URN**, watch-only, never dropped (D11).
- `actor` is optional because the run snapshot at mint has an on-behalf-of user and the
  relay has an App key; when absent, `canPost` is reported as `UNKNOWN_ACTOR`, not
  guessed.

Consumers, all in Phase 6: the boot briefing, `hadron_whoami` (`src/mcp/server.ts`
~l.5983), the headless-run snapshot at mint (`AppRun.registerSnapshot`), and a GraphQL
`attendeeRegister(workerRef | agentRef+appRef)` query the relay reads **instead of its
configured `appRef`**.

**The briefing block goes through ONE composition point.** The register block is
*derived data*, never an authored prompt part (the note owed to the shared-prompt-blocks
discussion). That discussion (hadron-concept `2026-09-14-shared-prompt-blocks`, in
Converge) is deciding **D11: one composer for every surface** — chat, Worker briefing,
runs — with derived blocks (register, attention) as a section of it. There are already
three string-concatenation paths (`src/lib/template.ts`, `src/lib/runNodeRender.ts`,
`src/lib/personaDescription.ts`). Phase 6 therefore adds the block through a single
function `renderDerivedBlocks(attendee, context)` that both the Worker resolver and the
run kernel call, so that when D11 lands it absorbs one function rather than a fourth
path. If D11 has landed first, Phase 6 implements its section instead.

### 4.4 The attention section (D-009)

Per hop in `executeAppRunInner` (`src/jobs/appRuns.ts`), after `deps.assemble(...)`
returns the instructions and before the LLM call, the kernel appends a CPU-computed
section:

```
## Channels (attention)
- <channel name> (<host memory>:<loc>): new since seq 41 (channel is at 44)   ← watermark delta, not a count
- <dm channel>: nothing new
```

- **The attendee of a headless run is Agent-in-App** (`AppRun.agentId` + `appId`); a run
  with **no `agentId`** has no attendee and gets no register and no attention section —
  stated so Phase 6/7 has a defined answer for that supported run shape. Binding an Agent
  at mint is not required by this plan.
- **Computed from the run's register snapshot ∩ live `Channel.lastSeq` ∩ the attendee's
  `ChannelReadState`** — one comparison per Channel, no model call. **The watermark read
  for each Channel is captured with the section** and those captured values — not a
  re-read of `Channel.lastSeq` — are what the checkpoint writes, so a message arriving
  between rendering and checkpoint is never skipped.
- **The cursor advances in the same checkpoint write as the hop** (D-009 rejected
  "catch-up at start only": "a long run goes deaf after its first hop"). Today the
  checkpoint is a guarded `appRun.updateMany({status:'RUNNING'})` (~l.910) and the last
  hop uses a separate guarded `COMPLETED` update; **both** become a transaction of that
  update plus the monotonic `ChannelReadState` upserts (§3.6), still guarded so a
  concurrent cancel is never overwritten. A resumed run therefore re-reads nothing it saw,
  and the final hop's window is not left unread.
- `mentionOnly` entries list only new messages whose stored `data.mentions` names the
  attendee — for a Worker attendee its own token; for an Agent-in-App attendee (a headless
  run) the tokens of **every Worker cast from that Agent in that App**, since mentions
  name Workers, never Agents (**proposed**, flagged §12). That is a small indexed query
  over the `(lastSeenSeq, lastSeq]` window — accepted on PR #1154; the registry's "no
  message fetch" is being corrected by Bo.
- Content of the new messages is **not** injected. The section says *that* something is
  new; the Agent reads with the Channel-addressed read tool (Phase 8) if it chooses.

### 4.5 Item J — the worker-App pin becomes the host-memory write check (Phase 8)

Added to #1153 by the coordinator on 2026-09-15. Today `createTeamChatMessage`
(`resolveSessionAuthor`, `resolvers.teamChat.ts`) pins twice at post time:
`SESSION_NOT_IN_APP` (the session must be a session *of this App*) and the worker-App pin
(`worker.appId !== appId` → `SESSION_WORKER_NOT_IN_APP`). A personal Agent's Worker
therefore cannot post into the org team chat **whatever its driver may read or write** —
memory access is never consulted. D-2026-09-13-008 and #1048's rule say the host memory
decides; the assistant-agents session decided the personal-App ↔ org-coordination-App
case by name.

**This is a widening, and it is verified as one.** Phase 8's `createChannelMessage`:

- keeps the **session** conditions of `cor:agt:020:04` unchanged — the caller may write
  the session, it is live, it is bound to a non-retired Worker;
- **replaces `SESSION_NOT_IN_APP` and the worker-App pin with one check:** the Worker's
  App is the Channel's App, **or** the session's on-behalf-of user (`Session.userId`) may
  write the Channel's host memory (`canWriteToMemory` / `requireMemoryWriteAccess`). The
  session-level pin does not survive as a separate rule — its purpose (a session of App A
  must not author in App B) is subsumed, since a session bound to a Worker of App A whose
  driver may write B's host memory is exactly the admitted case;
- a session with **no** on-behalf-of user (a pure App-key session) has nothing to derive
  the right from and is admitted only on the same-App branch — never widened;
- the message records the Worker's App beside the Channel's, so a cross-App post is
  visible as one in the transcript.

**Tests in both directions, before the pin is removed:** (a) a Worker of App A whose
driver cannot write App B's host memory is still refused (`CHANNEL_HOST_NOT_WRITABLE`, the
successor code), and the refusal is pinned by mutation — deleting the memory check must
turn it green; (b) a personal-App Worker whose driver can write the coordination App's
host memory is now admitted, and the message carries both Apps. The `teamChatMessages` /
`createTeamChatMessage` convenience over `App.defaultChannel` inherits the new gate — one
gate, two entry points, never two gates.

## 5. Surfaces per phase

All GraphQL; MCP mirrors named where the desktop track needs them. Every new
`<entity>(ref)` / `<entity>s(filter, orgId?, limit, offset)` pair follows
`conventions:uniform-read-surface` (`cor:api:120`) and `<entityRef>` naming
(`cor:api:140`); mutations are `create/update/delete<Entity>`. **Every read surface below
has a gate in §8** — a listed query with no gate is not a surface, it is a leak.

| Phase | GraphQL | MCP |
|---|---|---|
| 1 Active org | (none — `orgId` exists on the queries) | `hadron_set_active_org(orgRef)`, clearable; `ORG_REQUIRED` refusal carrying memberships; `hadron_server_info` capability token |
| 2 Scopes | `scope(ref)`, `scopes(filter{owner}, orgId)` — gated §8.3, memory list projected per §8.2; `createScope(input{ownerRef, name, description, memoryRefs[]})`, `updateScope`, `deleteScope`; `scopeExplain(scopeRef \| name+appRef) → {memories[], droppedCount, dropped[] (visible only), winnerFor(loc)?}` | `hadron_scope_explain`, **and CRUD: `hadron_list_scopes` / `hadron_create_scope` / `hadron_update_scope` / `hadron_delete_scope`** — #1150 requires CRUD on both surfaces; the CLI consumes GraphQL, the desktop track needs MCP |
| 3 Ladder | `findNodes(scope: String, appRef: String)`, `globalSearch(scope, appRef)`, `FindNodesResult.scope` **and `GlobalSearchResult.scope`** `{name, ownerUrn, memoryUrns[] (visible), droppedCount, degraded}`, `outsideScopeCount: Int` (node slice; when cheap, tunable); `scopeRef` on `createAgentSchedule` / the webhook route / `hadron_spawn` | `hadron_set_active_scope(scopeRef)`, clearable; `scope` arg on `hadron_find_nodes` / `hadron_list_nodes` / `hadron_search`; `scope:` envelope line |
| 4 Channel | `channel(ref)`, `channels(filter{appRef \| memoryRef}, orgId)` — gated §8.6; `createChannel(input{memoryRef, loc, name, kind, description})` (App admin / org CONTRIBUTOR+, D6), `updateChannel`, `deleteChannel` (soft, root and row together, protection while either exists — §8.5); `App.defaultChannel` | `hadron_list_channels(app)`, `hadron_create_channel` |
| 5 Register | `registerEntry(ref)`, `registerEntries(filter{ownerRef \| channelRef \| attendeeRef})` — gated §8.6; `createRegisterEntry(input{ownerRef, channelRef, attendeeRef?, role, mentionOnly, description})`, `updateRegisterEntry`, `deleteRegisterEntry` (owner-removes-own; App may not remove org) | `hadron_register_add` / `hadron_register_remove` (MCP names **open**; the CLI verb set is hadron-cli's) |
| 6 resolveRegister | `attendeeRegister(workerRef \| agentRef+appRef) → [RegisterViewRow]`; briefing block on `startSession` / `Worker.prompt` via `renderDerivedBlocks`; `AppRun.registerSnapshot` | `hadron_whoami` prints the register per bound row; `hadron_get_worker` too |
| 7 Read-state | `channelReadState(attendeeRef, channelRef)`, `advanceChannelReadState(attendeeRef, channelRef, seq)` (the relay's write — gated §8.7, monotonic §3.6) | (kernel-internal; nothing new) |
| 8 Channel-addressed chat + DMs | `channelMessages(channelRef, sinceSeq, mentionsRef, limit)`, `createChannelMessage(channelRef, body, sessionRef, replyToSeq)` with the §4.5 gate — the existing `teamChatMessages` / `createTeamChatMessage` become the `appRef → App.defaultChannel` convenience over these; `openDirectChannel(participantRefs[2])` **(DM half blocked — §12 item 4)**; system announcements | `hadron_team_chat_read/post` gain `channel`; `hadron_channel_read/post` |

## 6. Phases, order, dependencies

Two tracks after Phase 0. The lens track (1–3) and the Channel track (4–8) are
independent of each other until Phase 6 (the briefing renders both lists) and Phase 8
(a DM channel search is just search).

```
Phase 0 ── shared pieces S1, S2, S3, S5 · measurement (§9) · spec-043 plan amendment (I)
   │
   ├── Phase 1  active org (B)          ──┐
   │      Phase 2  Scope table + CRUD (GraphQL + MCP) + explain (A₁)   │ lens track → #1150
   │      Phase 3  ladder in findNodes AND globalSearch + disclosure + trigger scopeRefs + run snapshot (A₂, D-004) ──┘
   │
   └── Phase 4  Channel + eager creation + S4 protected loc (shape B) + migration (C) → closes #1047
          Phase 5  register table (attendee subject) + install default + migration (D)
          Phase 6  resolveRegister + consumers via renderDerivedBlocks (E)
          Phase 7  read-state (attendee-keyed, monotonic) + watermark + attention section + checkpoint (F)
          Phase 8  Channel-addressed chat ops + item J gate + announcements (H, J) → into #1048
                   DM pairs (G) — blocked on the chat-host typology (§12 item 4)
```

**Cut guidance for the coordinator** — each phase is one issue and, by this team's bias,
one PR; Phase 0 may be split into "S1+S2+S3+S5 helpers", "measurement", and "043
amendment", since the last two are not code. Phase 4 is the largest and should not be
split further: the row, the root, the lock, the protection and the migration are one
transaction's worth of invariants, and landing the table without the protection is the
state #1047 describes. Phase 8's DM half is a separate issue from its Channel-addressed
half, because it has a different blocker.

**Ordering rationale:**

- **Phase 1 first** because the scope ladder's step 4 is the org and the org ladder is
  four small pieces on an existing column pattern. It also ships the CLI/MCP parity the
  portal has had since spec 014 — the smallest user-visible win in the plan.
- **Phase 3 after 2**, obviously; **Phase 3 carries the `cor:acl:020:03` amendment
  obligation**, so the measurement (§9) must be done — not merely started — before Phase
  3 opens, since the registry says the amendment "should be accompanied by one".
- **Phase 4 before 5**: a register row is an FK to a Channel. Phase 4 also closes #1047
  on its own.
- **Phase 7 after 6**: the attention section reads the run's register snapshot.
- **Phase 8 last**: item J is a gate replacement that wants Channels in place, and the DM
  half has an external blocker.

## 7. Migrations — separate from the new tables

Migration directories follow the repo's hand-typed `YYYYMMDDHHMMSS_<name>` convention;
**every schema change below is a hand-authored migration file plus `post-push.sql` and
`globalSetup.ts` sync** — `pnpm db:dev-setup` is how a developer applies it locally,
not how it reaches production (`ops:alpha:prisma-deploy-flow`: the container runs
`prisma migrate deploy` on every restart). Every CHECK lives in **three** places
(`hrn:node:hadronmemory.com:hadron-server:review:non-prisma-ddl-sync`); never add a CHECK
with `IF NOT EXISTS`.

### 7.1 Phase 4 — existing team chats → Channel rows (an application backfill, not SQL)

- **Which roots:** a migration-specific query, not `locateTeamChatRoot`'s (which filters
  `loc = 'chats:team'`, live, in a live `class='app'` memory of the App — it deliberately
  excludes tombstones). The backfill takes every `Node` with `loc = 'chats:team'` in any
  `class='app'` memory, **including soft-deleted roots and roots in soft-deleted
  memories** (the row is what protects the address; a tombstoned root still occupies the
  loc), and creates one `Channel {memoryId, loc, name:'team', kind:CHAT, chatRootNodeId,
  lastSeq, lastMessageAt}` per root, soft-deleted in step with its root.
- **Which root is the default:** an App may have **several** `chats:team` roots (one
  app-class memory per installed Agent; `locateTeamChatRoot` tolerates it and picks the
  oldest live root by `createdAt`). `App.defaultChannelId` is set **once per App, to the
  Channel of the oldest live root — the same ordering the resolver uses today** — so the
  convenience surface keeps pointing at the transcript existing posts land in. Other
  roots get Channel rows and are not the default.
- **`lastSeq` seeding is key-aware or it is wrong.** The allocator's high-water mark is
  `GREATEST(data.messageCount, MAX(seq) over message nodeTypes)`, and `data` is ciphertext
  on an encrypted memory — a SQL migration cannot read it. So this is an **application
  backfill** (`pnpm tsx`, like `db:test-prune-legacy`): where the memory is plaintext or a
  session key is cached, use the allocator's own function; otherwise seed from
  `MAX(Node.seq)` over message-typed rows **including soft-deleted ones** (`seq` is a
  plaintext column; deleted messages keep their seq, which is exactly why the counter
  never decrements) and record the root as `seeded-from-seq` in the run's report. The
  allocator self-heals on the next post in either case (#992), so an under-seeded
  `lastSeq` costs one stale attention delta, never a reused seq.
- **Known prod collision:** the finding records `micromentor.org:mm-eng-team`'s team chat
  carrying two messages at seq 3. The backfill must **not** repair it (that renumbers a
  cited seq — a human decision), and `Channel.lastSeq` tolerates it because it is a
  high-water mark, not a uniqueness claim.
- **Open** whether a Channel row should exist for a retired App's chat — recommendation:
  yes, read-only history, since the register never references it.
- Idempotent (`@@unique([memoryId, loc])` makes a re-run a no-op), resumable, and it
  **reports** what it could not decide rather than guessing — the `sharedMemoryAdoption`
  sweep is the precedent shape.
- **Apps with no team root yet:** eager creation for **new** Apps hooks into `createApp`
  beside `provisionAppSharedMemory` (#951). That provisioning is deliberately best-effort
  today (the App row is committed first; a failure is logged, and the lazy first-post
  bootstrap covered it). Under D-006 the lazy path is retired, so the one creation
  function — `ensureDefaultChannel(appId)`, idempotent, create-or-restore under the
  ancestor lock — is called **eagerly at `createApp` and again by the Channel operations
  as reconciliation**; it is the existing bootstrap re-homed, not a second path. For
  **existing** Apps that never posted, the backfill calls the same function using the
  bootstrap's own Team-Agent locator (`roles:` marker, single-installed-Agent fallback);
  an App where that locator is ambiguous (several installed Agents, no marker) is
  **skipped and reported**, and reconciled on its first Channel operation. "Created lazily
  on the first post; a read never provisions" in `cor:agt:020:04` becomes "created with
  the App; a read never provisions" — an amendment, Vera's, listed in §10.

### 7.2 Phase 4 — the protected loc

Shape B: the Channel row **is** the protection source; no column is added. The gate
(S4) reads `Channel` by `(memoryId, loc)` prefix, live or tombstoned. When
D-2026-08-25-004 lands its column, it becomes a second source behind the same predicate.

### 7.3 Phase 5 — install-created default rows

For every live `AppAgent` row whose App has a `defaultChannelId`: one App-owned
`RegisterEntry {channelId: defaultChannel, attendeeAgentId: agent, role: BOTH,
mentionOnly: <the Agent's declared default, else false>, description: 'Default channel
(installed)'}`. Idempotent on the partial unique `(appId, channelId, attendeeAgentId)`.

### 7.4 Phase 7 — relay watermark move-in

Not a server migration: the relay's state file holds the per-(app, worker) watermark. The
first `advanceChannelReadState` from a relay seeds the row from the file (monotonic, so a
lower file value never regresses a row). Named here so the relay's owner knows the server
side expects it.

### 7.5 Additive columns — each still a migration file

`McpSessionState.organizationId` (Phase 1), `McpSessionState.scopeId` +
`AppRun.scopeSnapshot` + `AgentSchedule.scopeId` + `AgentWebhook.scopeId` (Phase 3), `App.defaultChannelId` (Phase 4), `AppRun.registerSnapshot` (Phase 6),
`Agent.registerDefaults` if §3.5's recommendation is taken (Phase 5). All nullable, no
backfill, one hand-authored migration each (or one per phase), synced to `post-push.sql`
only where a CHECK or partial index rides along.

## 8. Authorization — first-class review criteria

Access-control bugs here are cross-tenant leaks. The CLAUDE.md invariants and
`hrn:node:hadronmemory.com:hadron-server:review` apply to every phase; the ones specific
to this epic:

1. **Neither list grants.** A scope resolves to `requested ∩ accessible` (S2) and a
   register entry's `canRead` / `canPost` are the host memory's gates. Any code path that
   turns a Scope or RegisterEntry row into a memory id **without** the intersection is a
   leak. The intersection is a **required parameter** of the resolver, not an optional
   post-filter (`findings:a-gate-a-caller-can-omit-is-a-gate-some-caller-omits`). A run's
   `scopeSnapshot` / `registerSnapshot` is data, re-intersected on every use — never a
   grant that outlives a revoked membership.
2. **Disclosure must not become an existence oracle.** `scope explain`, `scope_narrowed`
   and register disclosure report memories the caller cannot read. Report them by
   **count** to everyone, and by **URN** only through the **existing memory
   discoverability predicate** — the same one `Query.memory` / `memories` use to decide
   whether a row exists for this caller. **"Same organization" is not that predicate:**
   app-scoped `knowledge` / `group` memories are App-internal and deliberately outside
   every org-wide grant (`getOrgReadableMemoryIds`, `requireMemoryWriteAccess`), and
   user-owned / strict-owner rows are invisible to org peers and to platform admins. A
   scope authored anywhere must not enumerate memory names to a caller the predicate would
   not show them to. Raw `Memory` rows never cross the S2 → S3 boundary; ids do, and S3
   renders them after the check.
3. **Owner gates on the S1 columns:** org-owned rows need org CONTRIBUTOR+
   (`requireOrgRole`, `findFirst` + `deletedAt: null` on `OrgMember`); App-owned rows need
   App admin (or the user-owned App's owner); Agent-owned scopes need the Agent's owner.
   **Read gates:** an org scope is readable by that org's members, an App scope by the
   App's participants (`isAppParticipant`), an Agent scope by whoever may read the Agent;
   the memory list inside any of them is projected through §8.2. Reuse `resolveRefArg` +
   the existing predicates; a bespoke check drifts.
4. **The org ladder is membership-gated with no admin bypass**, as `cor:api:100:01`
   already states; a platform admin selecting an org they are not a member of is refused,
   and an App's org is adopted only for a member of it (§4.1 step 2).
5. **The protected-loc gate (S4) is write-only**, refuses on subtree **overlap** in both
   directions (S4), and sits **above** the platform-admin early-return exactly as
   `chatLocFilter`'s team-chat refusal does (#1030) — admins skip entitlement narrowing
   and would otherwise be the one principal still able to write under a Channel. **Reads
   stay memory-wide** (D-2026-08-25-004). **`deleteMemory` of a host memory holding a
   live Channel is refused** (`MEMORY_HOSTS_CHANNEL`) until the Channel is deleted through
   its own operation, which soft-deletes row and root together and keeps the protection
   while either exists; uninstall / App deletion cascade through that same operation, never
   around it.
6. **Channel and register reads follow the host memory.** `channel(ref)` / `channels` and
   `registerEntry` / `registerEntries` return a row only to a caller who may read the
   Channel's host memory **or** is the row's owner (org member for an org row, App
   participant for an App row); a filter naming a foreign Channel or attendee returns the
   same empty page as a nonexistent one — no cross-tenant existence oracle, the same
   posture as the mention filter in `cor:agt:020:04`. **Channel posts follow the
   on-behalf-of user** (§4.5, `cor:acl:030:01`, #1048's rule, D8 local): a Worker posting
   into a Channel hosted in another App is admitted iff its on-behalf-of user may write
   the host memory — never because a register row names the Channel.
7. **`advanceChannelReadState` has a writer gate:** the caller must be the attendee's
   driver — a user whose live session is bound to that Worker, or the App-key principal of
   the attendee's App (the relay's shape) — and the row is monotonic (§3.6). Anyone else is
   refused; otherwise one caller could advance another attendee's cursor and silence its
   attention.
8. **Session-state recovery re-authorizes** (`findings:mcp-active-app-selection-evaporates-on-reconnect`):
   a stored `organizationId` / `scopeId` is a cache of a choice, re-checked against
   current membership / scope readability on every load; a stale one is dropped and
   disclosed, never honoured.
9. **Impersonation** is read-only and single-org; `hadron_set_active_org` and the scope
   setter refuse under it; `resolveRegister` under impersonation shows the target's
   register but every `canPost` is `false` with reason `IMPERSONATION` (S5).
10. **App-key principals:** an App key's org is its credential (`cor:api:100`); the org
    ladder short-circuits to it; a pure App-key session bound to an agent stays
    hard-isolated to `sessionScopedMemoryIds` (#1003) — a scope named by such a caller is
    intersected with **that** set, not the App's.

## 9. The measurement owed — Q-2026-08-07-002, a deliverable with a method

The whole lens feature rests on "ingest a lot into Hadron and you are drowning in noise",
and the registry says the premise "has never been measured". D-002's amendment to
`cor:acl:020:03` should ship **with** a number. Phase 0 delivers it as a finding node
(`hrn:mem:hadronmemory.com:hadron-server`, `findings:` branch) before Phase 3 opens.

**Method** (read-only, prod, via the `ops:alpha:db-access` runbook — host `psql`, no
container `psql`):

1. **Corpus composition.** `SELECT m.class, n.node_type, count(*) FROM nodes n JOIN
   memories m … WHERE n.deleted_at IS NULL GROUP BY 1,2` — the distribution Q-2026-08-07-002
   literally asks for, per memory class.
2. **Per-memory chat share.** For every memory with ≥ 100 live nodes: the fraction that
   is `chat-message` / `record`. Report the median and the top ten. This answers whether
   noise is a property of *some* memories (a scope problem) or of *the corpus* (an
   exclusion problem).
3. **Query-level noise.** Take a fixed query set the team can defend — the 30 most
   frequent distinct terms in node **names** across `hadronmemory.com` memories — and for
   each run `findNodes` (keyword) as an org member with `orgId` set, top 20: count hits
   whose memory is not the one a human would have scoped to, and hits that are
   `chat-message`. Run once with today's default exclusion and once without.
4. **Cross-App narrowing.** Re-run the seq 534 probe shape (two Apps, one user) against
   the same query set with and without an active App, recording the result-count delta.
   That is the number the amendment should cite for "narrowing produces fewer answers,
   disclosed and recoverable".

**What the number decides:** if chat share is small and step 3 shows little cross-App
contamination, the amendment's rationale must be rewritten around *ordering and
intent* rather than noise; the ladder still ships (Holger decided it), but the spec text
must not assert what the measurement contradicts. If it is large, the rationale cites
the figures. Either way the finding node carries the SQL, the date, and the counts —
**no unmeasured quantity in prose**.

## 10. What each phase obliges elsewhere — named, not done

Nothing below is this repo's to change; the coordinator files them.

| Phase | hadron-cli (#578 + new) | hadron-portal | hadron-docs (#289 + new) | hadron-relay | specs (Vera — amendments, no citations minted here) |
|---|---|---|---|---|---|
| 1 | `hadron org use`, config key, the resolution ladder incl. the org-less case, `ORG_REQUIRED` rendering | — (portal has it) | "which organization am I in" | — | `cor:api:100` (active org on CLI/MCP; org-less callers) |
| 2 | `hadron scope ls\|get\|create\|update\|rm\|explain` | scope CRUD views | scope concept | — | new `cor:dmo` entry for Scope; `cor:dmo:050:09` (AgentMemoryItem = the manifest's memory list) |
| 3 | `--scope`, config scope, **every search prints its scope**, outside-scope count; `--scope` on schedule/spawn | scope line on search results | "what does a search cover" (#289) | — | `cor:acl:020:03` (search App-scoped by definition + disclosure clause — **with §9's measurement**), `cor:api:090` (`scope` arg, envelope `scope:` line, outside-scope count), `cor:api:050` (global search envelope) |
| 4 | `hadron team channel list\|create\|members` | App page: Channels + participants | Channel concept | envelope carries Channel **PK** | new `cor:dmo` entry for Channel; `cor:agt:020:04` (team chat = the App's default Channel row; "lazily on first post" → "with the App"); `cor:acl:030:01` restated for Channels |
| 5 | `hadron agent channels`, register add/rm with `--attendee` | Agent page: register view | "which chats does this Agent take part in" (with #287) | — | new `cor:dmo` entry for the register (+ the attendee, + the "not exportable" rule from D-2026-08-25-006) |
| 6 | `--mine`, disclosure in `whoami` output | Agent page: resolved register + read-state | — | **read the register instead of `appRef`**; drop `appRef` from config | `cor:agt:010` (or `:01`): the register block is derived data in a briefing — and the shared-prompt-blocks D11 composer if landed |
| 7 | — | read-state on the Agent page | — | advance read-state via GraphQL; retire the state-file watermark | `cor:agt:010`: attention section + read-state in a headless run (registry note on D-009 corrected by Bo) |
| 8 | `hadron team chat` gains `--channel`; DM verbs (when unblocked) | DM UI (when unblocked) | — | carry Channel PK per message | `cor:agt:020:04` (Channel-addressed operations; the §4.5 gate replaces the worker-App pin; DM pairs when unblocked); spec 043 `plan.md` (Phase 0 amendment) |

The spec-043 amendment (in-scope item **I**) is a `plan.md` edit in **this** repo,
delivered in Phase 0 as a doc-only change: `ChatBinding` gains **`hadronChannelId`**, a
distinct FK to the Hadron Channel, replacing `(memoryId, messagesLoc)` as the Hadron side
of the binding; its existing `channelId` keeps meaning the provider's channel id; Agents
never post via the Slack tool; provider-only operations deferred to Q-2026-09-13-003.
Phase 3 of 043 is not built here.

## 11. Out of scope — named so nobody fills them in passing

- CLI, portal, docs, relay implementation (§10 names what they owe).
- Spec citations: none minted. §10 says which server change obliges which amendment
  and stops.
- **Q-2026-09-13-002** — a Channel message starting a run (the run-triggers-run hazard).
  No `CHANNEL` trigger kind.
- **Q-2026-09-13-003** — provider-only operations on a bound Channel.
- **Task customization** (`STUBBED-agent-task-customization`) — the only consumer of
  scope *order*; `scopeExplain`'s `winnerFor(loc)` is built for it but the operation is not.
- Spec 043 Phase 3 itself; `ChatBinding` is not created by this plan.
- **The chat-host typology** (chats in personal-class memories) — the blocker for the DM
  half of Phase 8; its own work.
- Chat search scopes A/B/C (Q-2026-08-08-004); a saved filter in a scope; retrieval
  parameters in a scope (never — retrieval-config's job).
- Team-scoped Channel visibility (waits on the team entity, Q-2026-08-25-002).
- Push delivery to sessions (#1048 keeps it out; the register makes polling cheap).
- **The prior-art claims** (Slack / Discord / Matrix / Teams admit a bot from the room's
  side) are **recalled, not verified** — they informed D-008 and appear nowhere in this
  plan as fact. Verify before any spec or doc cites them.
- Repairing the prod seq-3 collision (§7.1) — a human decision about renumbering a
  cited seq.

## 12. Reports to the coordinator — silences, blockers, and stale premises

Items 1, 2, 3, 5, 6 and 7 of the first revision were answered on PR #1154 and are folded
into the text above (§14). What remains, plus what the review surfaced:

1. **Phase 8's DM half is blocked on the chat-host typology.** D-2026-08-18-001 decided
   the human↔worker DM lives in the user's personal memory for the App (`pers-*` pattern),
   and the memory is the privacy boundary (D-2026-08-11-003) — so it is *not* readable by
   every App member. But `cor:acl:030:01` says only app-class memories can host a chat
   today (`shared ⇔ app`; spec 028's typology is Draft). Building the typology is not a
   small phase and is not in this plan. Needs an owner and an issue.
2. **The registry note for D-2026-06-30-002 is stale:** `globalSearch` does not call
   `findNodes` as executor; it runs its own node adapter. The ladder lands in both (§4.2).
   Recorded so nobody plans against the decision rather than the code.
3. **`mentionOnly` for an Agent-in-App attendee** (a headless run) is interpreted here as
   "any Worker cast from that Agent in that App is mentioned" (§4.4). Mentions name
   Workers, never Agents, so *some* interpretation is needed; this one is proposed, not
   decided.
4. **Where an Agent declares its install-row defaults** (`mentionOnly` etc., §3.5) after
   Agent-owned register rows were dropped — recommendation given, storage open.
5. **An issue for D-2026-08-25-004** (`Memory.protectedLocs` as the second protection
   source) is owed regardless of shape B; also the specs-corpus case #1152 was retitled to.
6. **A Channel row for a retired App's chat** — recommendation yes; open.

## 13. Testing

- **Differential tests for every "one computation" claim**: GraphQL `findNodes` scope
  resolution vs `hadron_find_nodes` vs `globalSearch`'s adapter; `resolveRegister` as
  consumed by briefing / whoami / run snapshot — one fixture, every consumer, same rows
  (the pattern `resolvers.worker.test.ts` uses for liveness, `cor:agt:020:11`).
- **Mutation tests on the gates**, not only positive tests: empty the intersection (S2)
  and every "never grants" assertion must go red; remove the actor from `resolveRegister`
  and `canPost` must read `UNKNOWN_ACTOR`, not `true`; delete the memory-write check in
  §4.5 and the cross-App refusal must go green. A gate whose test stays green when the
  gate is deleted measured nothing (the #1142 lesson).
- **Existence-oracle tests** for §8.2 and §8.6: a caller outside the tenant sees the
  same count-only / empty-page shape for a real and a nonexistent memory or Channel.
- **Two audiences per refusal**: the caller's typed error *and* the operator-visible
  state — a scope that narrows to nothing must leave a `scope_narrowed` envelope, not an
  empty page that looks like "no results".
- **Migration tests** run twice (idempotency) and against a fixture carrying the seq-3
  collision shape, a soft-deleted root, an encrypted memory with no cached key, an App
  with two `chats:team` roots, and an App that never posted.
- **Checkpoint atomicity**: kill the run between the hop's side effects and the
  checkpoint; on redelivery the attention section must show the same window as before —
  proves the cursor moved in the checkpoint, not before it. Same for the final hop. Two
  concurrent runs of one attendee: the higher seq wins, never the later write.
- **The loader, not just the renderer**: for every consumer of `resolveRegister`, assert
  the *input* rows are identical, not only the rendered block
  (`findings:a-gate-a-caller-can-omit-is-a-gate-some-caller-omits`, corollary 1).
- Full suite locally with `HADRON_TEST_CONNECTION_LIMIT=3`; SDL/resolver argument parity
  is invisible to the suite (`findings:sdl-resolver-arg-drift-invisible-to-tests`) — the
  `graphql-sdl-parse` and `check:sdl-enums` gates plus a CLI codegen dry-run are the check.

## 14. Revision record — PR #1154 review, 2026-09-15

Design-side review by Bo (author of the register session), posted on Holger's instruction
and confirmed by Holger's merge instruction; plus Codex and Copilot findings, each checked
against `main` before being adopted.

**Design corrections (Bo, confirmed):**

1. **The attendee.** "Per Agent" read-state (D-2026-09-13-009) breaks under multi-casting
   — two Workers from one Agent in one App would share a cursor. The subject of a register
   row and the key of read-state is the *attendee*: a Worker when cast, otherwise an
   Agent in an App. → §3.5, §3.6, §4.3, §7.3.
2. **Nullable subject; Agent-owned register rows dropped.** "Every row names one Agent"
   would make org-wide reach N rows (the two-owners alternative D4 rejected). A null
   attendee means every attendee in the owner's context. Agent-owned rows can only be
   symbolic and D2 already materialises the install row. → §3.5, S1 parameterised.
3. **The human↔worker DM host memory was decided in August** (D-2026-08-18-001) and the
   register session failed to cite it; the consequence is larger than the first revision
   said — the chat-host typology is a prerequisite. → §12 item 1.
4. Shape B for protected locs; the org-less caller as a partial reversal of D-003;
   `mentionOnly` needs a fetch (registry note to be corrected by Bo); items 6 and 7
   matched the design's intent. → §1, §4.1, §4.4, §3.4.
5. Phase 6's briefing block through one composition point, ahead of D11. → §4.3.

**Codex (all adopted):** composite-PK models into `MODELS_WITHOUT_ID` (§2); the
existence-oracle test is the discoverability predicate, not same-org (§8.2);
`ChatBinding.channelId` is the provider's id — distinct `hadronChannelId` (§3.4, §10);
the default Channel is the oldest live root, once per App (§7.1); watermark delta, never
a count (§3.4, §4.4).

**Copilot (adopted where the claim held on `main` — every one did):** S2 refuses a `null`
sentinel; `bindings` relation removed from the sketch; loc reservation under the existing
ancestor lock; `dropped` crosses the boundary as ids; monotonic read-state under
concurrent runs; read gates for register / Channel / scope queries and a writer gate for
`advanceChannelReadState`; S4 subtree overlap and `deleteMemory`; `UNKNOWN_ACTOR` /
`IMPERSONATION` in S5; `ScopeMemory` relations + cascade; trigger `scopeRef` storage;
`app` scope needs a multi-Agent computation (`getAppMemoryAccess` is `take: 1`);
`globalSearch` is a second landing site; runs without an Agent have no attendee;
`registerSnapshot` column; final-hop checkpoint; `GlobalSearchResult.scope`; §2/§6
consistency on S4; key-aware `lastSeq` backfill; partial uniques for soft-deleted scopes;
`app` reserved; migration predicate incl. tombstones; §7.5 as real migrations; `appRef`
for bare scope names on GraphQL; `createApp` best-effort vs eager (`ensureDefaultChannel`);
org-ladder step 2 membership; ambiguous Team-Agent Apps skipped and reported; scope read
contract; MCP scope CRUD; snapshots re-intersected.

**Coordinator (Ada, added to #1153):** item J — the worker-App pin becomes the host-memory
write check, verified as a widening in both directions. → §4.5, Phase 8.
